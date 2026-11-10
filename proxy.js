#!/usr/bin/env bun
/**
 * proxy.js：运行时可配置的出口，单代理或代理池。
 *
 * 本桥发出的每个出站请求（推理、模型发现、身份同步、自更新）都可以经过
 * HTTP/HTTPS 代理，让上游看到代理的 IP 而不是本机 IP。支持两种形态：
 *
 *  - 单代理（`url`）：原始行为，在 `/` 面板里编辑；
 *  - 代理池：每个条目有独立的健康状态，单个桥就能把请求分散到多个出口 IP，
 *    上游限流某个 IP 时自动避开。
 *
 * 池的意义：免费额度按出口 IP 计，不按账号计。多开桥只会成倍增加进程、
 * 服务单元和隧道，池在单个进程内完成 IP 轮转，身份与模型目录保持一处。
 *
 * 协议：仅 HTTP/HTTPS。Bun 的 `fetch` 对这两种协议接受 `proxy:`，TLS 经
 * CONNECT 隧道，ClientHello 仍由 Bun 发出，传输指纹基线不变。Bun 对 SOCKS5
 * 抛 `UnsupportedProxyProtocol`，所以在这里直接拒绝并说明，而不是让请求
 * 半路失败。
 *
 * 凭据保存在 `<state dir>/proxy.json`，绝不离开进程：HTTP 面板与 `/health`
 * 只能看到 描述状态() 的视图，其中只有 host:port。
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const 配置文件名 = "proxy.json";
const 健康文件名 = "pool-health.json";
const 健康版本号 = 1;
const 环境单代理变量 = "UPSTREAM_PROXY_URL";
const 环境代理池变量 = "UPSTREAM_PROXY_POOL";
const 环境策略变量 = "UPSTREAM_PROXY_STRATEGY";

const 支持的策略 = new Set(["round-robin", "failover", "random"]);
const 默认策略 = "round-robin";
const 默认冷却毫秒 = 120000;
const 默认最大冷却毫秒 = 1800000;

function 状态目录() {
  const raw = process.env.FUCKING_OPENCODE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return path.join(os.homedir(), ".fucking-opencode");
}

function 配置文件路径() {
  return path.join(状态目录(), 配置文件名);
}

/**
 * 健康文件与配置相邻但各存各的：配置是运维意图，健康是运行时观测。谁也
 * 不能重写谁，健康文件损坏的代价绝不能波及池本身。
 */
function 健康文件路径() {
  return path.join(状态目录(), 健康文件名);
}

/** 代理 URL 的规范形，或拒绝原因。
 *
 * 空串合法且表示"直连"：面板用空值清除设置，而不是另一个动词，所以两条路
 * 共用一个校验器。
 */
function 解析代理地址(raw) {
  const value = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!value) return { ok: true, url: "" };

  let u;
  try {
    u = new URL(value);
  } catch {
    return { ok: false, error: "代理 URL 无效。示例：http://user:pass@host:8080" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return {
      ok: false,
      error:
        `不支持 ${u.protocol} 协议。Bun fetch 只支持 http:// 和 https:// 代理` +
        "（CONNECT 隧道）。运行时会拒绝 SOCKS5，所以这里无法使用。",
    };
  }
  if (!u.hostname) return { ok: false, error: "代理主机为空。" };
  if (u.pathname !== "/" || u.search || u.hash) {
    return { ok: false, error: "代理 URL 只能包含协议、凭据、主机与端口。" };
  }
  // `u.username`/`u.password` 保持用户输入时的百分号编码，这正是 Bun 期望的。
  // 重新拼 URL 是为了避免 `URL` 规范化补上的尾部斜杠，落盘的值与面板回显一致。
  const auth = u.username || u.password
    ? `${u.username}${u.password ? `:${u.password}` : ""}@`
    : "";
  const port = u.port ? `:${u.port}` : "";
  return { ok: true, url: `${u.protocol}//${auth}${u.hostname}${port}` };
}

/** 展示用 `host:port`。凭据绝不进入这个字符串。 */
function 展示主机(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "configured";
  }
}

/** 为没有 id 的 URL 生成一个：跨重启稳定，绝不泄露凭据。 */
function 兜底编号(url) {
  const host = 展示主机(url) || "proxy";
  return host.replace(/[^A-Za-z0-9.:-]/g, "");
}

/** 解析一个池条目，或给出拒绝原因。字符串条目是 `{ url }` 的简写，池因此可
 * 以直接写成 URL 列表。
 *
 * `{ direct: true }` 表示本机自己的地址：让宿主机 IP 参与轮转，而不是只在
 * 所有代理都挂掉时才兜底。它值得一个一等条目，因为跑桥的机器通常自己就有
 * 可用的出口 IP。
 */
function 解析池条目(raw, index) {
  const source = typeof raw === "string" ? { url: raw } : raw;
  if (!source || typeof source !== "object") {
    return { ok: false, error: `第 ${index + 1} 条不是对象或 URL。` };
  }

  const label = String(source.label == null ? "" : source.label).trim().slice(0, 64);

  if (source.direct === true) {
    const id = String(source.id == null ? "" : source.id).trim().slice(0, 64) || label || "direct";
    const weight = Number(source.weight);
    return {
      ok: true,
      entry: {
        id,
        label: label || id,
        url: "",
        direct: true,
        enabled: source.enabled === undefined ? true : Boolean(source.enabled),
        weight: Number.isFinite(weight) && weight > 0 ? Math.min(weight, 100) : 1,
      },
    };
  }

  const parsed = 解析代理地址(source.url);
  if (!parsed.ok) return { ok: false, error: `第 ${index + 1} 条：${parsed.error}` };
  if (!parsed.url) return { ok: false, error: `第 ${index + 1} 条：URL 为空。` };

  const id = String(source.id == null ? "" : source.id).trim().slice(0, 64) || label || 兜底编号(parsed.url);
  // 权重保持可选：不设置的运维得到均分流量，权重只需在池内有相对意义。
  const weight = Number(source.weight);
  return {
    ok: true,
    entry: {
      id,
      label: label || id,
      url: parsed.url,
      direct: false,
      enabled: source.enabled === undefined ? true : Boolean(source.enabled),
      weight: Number.isFinite(weight) && weight > 0 ? Math.min(weight, 100) : 1,
    },
  };
}

/** 解析 `UPSTREAM_PROXY_POOL`：URL 用逗号或换行分隔，每条可带 `label=` 前缀。
 * 空条目直接忽略，末尾多一个分隔符不算错。
 */
function 解析池声明(raw) {
  const out = [];
  const errors = [];
  String(raw || "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((piece, index) => {
      const eq = piece.indexOf("=");
      const hasLabel = eq > 0 && !piece.slice(0, eq).includes("/");
      const parsed = 解析池条目(
        hasLabel ? { label: piece.slice(0, eq).trim(), url: piece.slice(eq + 1).trim() } : piece,
        index
      );
      if (parsed.ok) out.push(parsed.entry);
      else errors.push(parsed.error);
    });
  return { entries: out, errors };
}

// ---------------------------------------------------------------- 状态 ---

/** 单代理状态（旧形态）。下面的 pool 只有在有条目时才生效。 */
let 当前单代理 = { url: "", source: "none", error: null };
let 代理池 = { entries: [], errors: [], strategy: 默认策略, source: "none", error: null };
let 冷却配置 = { baseMs: 默认冷却毫秒, maxMs: 默认最大冷却毫秒 };

/**
 * 健康表按出口身份为键，不按代理 URL："direct" 条目没有 URL，两个条目也
 * 绝不共享一条健康记录。
 */
function 出口键(url) {
  return url ? url : "@direct";
}

/** 键 -> { failures, cooldownUntil, lastError, lastOkAt, lastUsedAt } */
const 健康表 = new Map();
let 轮转游标 = 0;

function 取健康(url) {
  const key = 出口键(url);
  let h = 健康表.get(key);
  if (!h) {
    h = { failures: 0, cooldownUntil: 0, lastError: null, lastOkAt: 0, lastUsedAt: 0, lastStatus: null };
    健康表.set(key, h);
  }
  return h;
}

/** 删除已不在池中的出口的健康记录，移除的条目不留幽灵。纯内存操作：落盘
 * 由调用方负责，重载不会把半恢复的映射盖到还没读过的文件上。
 */
function 修剪健康(entries) {
  const live = new Set(entries.map((e) => 出口键(e.url)));
  if (当前单代理.url) live.add(当前单代理.url);
  let removed = 0;
  for (const key of [...健康表.keys()]) {
    if (!live.has(key)) {
      健康表.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/** 每个出口的稳定非机密 id。健康文件与已含代理凭据的配置放在一起；再把令
 * 牌复制一份只是多一个泄漏点，记录只需可匹配，不需可读。
 */
function 健康哈希(key) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function 健康标签(key) {
  if (key === "@direct") return "direct";
  const entry = 代理池.entries.find((e) => 出口键(e.url) === key);
  return entry ? entry.label : null;
}

function 健康快照(now = Date.now()) {
  return {
    version: 健康版本号,
    savedAt: new Date(now).toISOString(),
    entries: [...健康表.entries()].map(([key, h]) => ({
      id: 健康哈希(key),
      label: 健康标签(key),
      failures: h.failures,
      cooldownUntil: h.cooldownUntil,
      lastError: h.lastError,
      lastStatus: h.lastStatus,
      lastOkAt: h.lastOkAt || null,
      lastUsedAt: h.lastUsedAt || null,
    })),
  };
}

let 健康写入定时器 = null;

/** 删除健康文件：没有任何出口还有值得记住的状态。 */
function 删除健康文件() {
  try {
    fs.unlinkSync(健康文件路径());
  } catch (err) {
    if (err.code !== "ENOENT") return;
  }
}

/**
 * 写出观测到的健康状态。通过 rename 原子落盘，写一半崩溃也不会破坏旧文
 * 件 —— 文件被截断会让池悄悄忘掉学到的所有冷却。
 *
 * 写失败从不外抛：健康只是内存优化的持久化，请求不能因为缓存文件写不了
 * 而失败。
 */
function 立即写健康(now = Date.now()) {
  if (健康写入定时器) {
    clearTimeout(健康写入定时器);
    健康写入定时器 = null;
  }
  if (健康表.size === 0) {
    删除健康文件();
    return;
  }
  try {
    fs.mkdirSync(path.dirname(健康文件路径()), { recursive: true });
    const tmp = `${健康文件路径()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(健康快照(now), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, 健康文件路径());
    fs.chmodSync(健康文件路径(), 0o600);
  } catch {
    // 尽力而为：桥继续用内存里的健康状态跑。
  }
}

/** 合并高频写入。每个请求都会带来一次成功记录，逐请求重写文件会把廉价的
 * 内存更新变成磁盘抖动。
 */
function 计划写健康(delayMs = 1000) {
  if (健康写入定时器) return;
  健康写入定时器 = setTimeout(() => {
    健康写入定时器 = null;
    立即写健康();
  }, delayMs);
  // 缓存写入绝不拖住进程退出。
  if (typeof 健康写入定时器.unref === "function") 健康写入定时器.unref();
}

/** 恢复上一个进程保存的健康状态。否则服务重启或挂起后就会忘掉哪些 IP 已
 * 被耗尽，把它们重新烧一遍。
 *
 * 内存里已有的记录优先：只有重启才会让映射为空，所以活着的记录按定义至少
 * 和文件一样新。
 */
function 恢复健康(entries, now = Date.now()) {
  let raw;
  try {
    raw = fs.readFileSync(健康文件路径(), "utf8");
  } catch {
    return 0;
  }

  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // 健康文件损坏的代价只是丢冷却，别的什么都不损失。
    删除健康文件();
    return 0;
  }
  if (!json || json.version !== 健康版本号 || !Array.isArray(json.entries)) return 0;

  const saved = new Map();
  for (const record of json.entries) {
    if (record && typeof record.id === "string") saved.set(record.id, record);
  }

  const keys = entries.map((e) => 出口键(e.url));
  if (当前单代理.url) keys.push(当前单代理.url);

  let restored = 0;
  for (const key of keys) {
    if (健康表.has(key)) continue;
    const record = saved.get(健康哈希(key));
    if (!record) continue;
    const cooldownUntil = Number(record.cooldownUntil);
    const failures = Number(record.failures);
    健康表.set(key, {
      failures: Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0,
      cooldownUntil: Number.isFinite(cooldownUntil) && cooldownUntil > now ? cooldownUntil : 0,
      lastError: typeof record.lastError === "string" ? record.lastError : null,
      lastOkAt: Number.isFinite(Number(record.lastOkAt)) ? Number(record.lastOkAt) : 0,
      lastUsedAt: Number.isFinite(Number(record.lastUsedAt)) ? Number(record.lastUsedAt) : 0,
      lastStatus: typeof record.lastStatus === "string" ? record.lastStatus : null,
    });
    restored += 1;
  }
  return restored;
}

function 规范化策略(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return 支持的策略.has(value) ? value : 默认策略;
}

function 规范化冷却(raw) {
  const base = Number(raw?.cooldownMs);
  const max = Number(raw?.maxCooldownMs);
  return {
    baseMs: Number.isFinite(base) && base >= 1000 ? Math.min(base, 3600000) : 默认冷却毫秒,
    maxMs: Number.isFinite(max) && max >= 1000 ? Math.min(max, 7200000) : 默认最大冷却毫秒,
  };
}

function 从磁盘加载() {
  const envPool = (process.env[环境代理池变量] || "").trim();
  const envSingle = (process.env[环境单代理变量] || "").trim();

  if (envPool) {
    const spec = 解析池声明(envPool);
    代理池 = {
      entries: spec.entries,
      errors: spec.errors,
      strategy: 规范化策略(process.env[环境策略变量]),
      source: "env",
      error: spec.errors.length > 0 ? spec.errors.join(" ") : null,
    };
    当前单代理 = { url: "", source: "env", error: null };
    修剪健康(代理池.entries);
    恢复健康(代理池.entries);
    return 代理池;
  }

  if (envSingle) {
    const parsed = 解析代理地址(envSingle);
    if (parsed.ok) {
      当前单代理 = { url: parsed.url, source: "env", error: null };
    } else {
      当前单代理 = { url: "", source: "env", error: `${环境单代理变量}: ${parsed.error}` };
    }
    代理池 = { entries: [], errors: [], strategy: 默认策略, source: "env", error: null };
    修剪健康([]);
    恢复健康([]);
    return 代理池;
  }

  let raw = null;
  try {
    raw = fs.readFileSync(配置文件路径(), "utf8");
  } catch {
    当前单代理 = { url: "", source: "none", error: null };
    代理池 = { entries: [], errors: [], strategy: 默认策略, source: "none", error: null };
    修剪健康([]);
    恢复健康([]);
    return 代理池;
  }

  let json = null;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    // 配置损坏绝不能阻止桥启动。直连是安全的兜底，`error` 字段把原因显示在
    // 面板上。
    当前单代理 = { url: "", source: "none", error: `proxy.json 无法读取：${err.message}` };
    代理池 = { entries: [], errors: [], strategy: 默认策略, source: "none", error: 当前单代理.error };
    修剪健康([]);
    恢复健康([]);
    return 代理池;
  }

  const entries = [];
  const errors = [];
  if (Array.isArray(json?.pool)) {
    json.pool.forEach((item, index) => {
      const parsed = 解析池条目(item, index);
      if (parsed.ok) entries.push(parsed.entry);
      else errors.push(parsed.error);
    });
  }

  const single = 解析代理地址(json?.url);
  当前单代理 = single.ok
    ? { url: single.url, source: single.url ? "file" : "none", error: null }
    : { url: "", source: "none", error: single.error };

  代理池 = {
    entries,
    errors,
    strategy: 规范化策略(json?.strategy),
    source: entries.length > 0 ? "file" : "none",
    error: errors.length > 0 ? errors.join(" ") : null,
  };
  冷却配置 = 规范化冷却(json);
  修剪健康(entries);
  恢复健康(entries);
  return 代理池;
}

function 取代理地址() {
  return 当前单代理.url;
}

/** 按配置顺序取启用的条目；池的实际工作集。 */
function 启用条目() {
  return 代理池.entries.filter((e) => e.enabled);
}

function 冷却中(url, now = Date.now()) {
  const h = 健康表.get(出口键(url));
  return Boolean(h && h.cooldownUntil > now);
}

/**
 * 为单个请求挑出口。
 *
 * 池里还有启用条目时绝不返回空：所有条目都在冷却时，就选冷却最先结束的那
 * 个。拒绝发送会把被限流的池变成死桥，而上游对被限流 IP 的应答本来就是调
 * 用方已经能处理的普通拒绝。
 *
 * `exclude` 让重试避开刚失败的出口。
 */
function 挑选出口({ exclude = null, now = Date.now() } = {}) {
  const entries = 启用条目();

  if (entries.length === 0) {
    return { url: 当前单代理.url, id: null, label: null, source: 当前单代理.url ? "single" : "direct", cooling: false };
  }

  // `null` means "no preference", which must not be confused with the direct
  // entry's empty URL — both would map to the same 健康表 key.
  const excluded = exclude === null || exclude === undefined ? null : 出口键(exclude);
  let candidates = excluded === null ? entries.slice() : entries.filter((e) => 出口键(e.url) !== excluded);
  if (candidates.length === 0) candidates = entries.slice();

  const healthy = candidates.filter((e) => !冷却中(e.url, now));
  let chosen;
  let cooling = false;

  if (healthy.length > 0) {
    if (代理池.strategy === "random") {
      // 加权挑选：权重只需在池内有相对意义。
      const total = healthy.reduce((sum, e) => sum + e.weight, 0);
      let roll = Math.random() * total;
      chosen = healthy[healthy.length - 1];
      for (const e of healthy) {
        roll -= e.weight;
        if (roll <= 0) {
          chosen = e;
          break;
        }
      }
    } else if (代理池.strategy === "failover") {
      // 粘滞：一直用第一个健康条目，在该 IP 被限流前保住上游的提示词缓存。
      chosen = healthy[0];
    } else {
      // 在健康候选间轮转，跳过冷却中的。`candidates` 已剔除 `exclude`，必须
      // 离开失败出口的重试不会在这里又转回它。
      chosen = healthy[轮转游标 % healthy.length];
      轮转游标 = (轮转游标 + 1) % Number.MAX_SAFE_INTEGER;
    }
  } else {
    // 全部被限流：用最早恢复的那个。
    cooling = true;
    chosen = candidates
      .slice()
      .sort((a, b) => (健康表.get(出口键(a.url))?.cooldownUntil || 0) - (健康表.get(出口键(b.url))?.cooldownUntil || 0))[0];
  }

  if (!chosen) {
    return { url: 当前单代理.url, id: null, label: null, source: 当前单代理.url ? "single" : "direct", cooling };
  }

  const h = 取健康(chosen.url);
  h.lastUsedAt = now;
  return {
    url: chosen.url,
    id: chosen.id,
    label: chosen.label,
    // `direct` 表示"本进程自己的地址"，无论它来自池条目还是没有池。
    source: chosen.direct ? "direct" : "pool",
    cooling,
    cooldownUntil: h.cooldownUntil || 0,
  };
}

/** 记录某出口被上游拒绝。连续失败时冷却翻倍，被耗尽的 IP 重试间隔越来越
 * 长，上限 `maxMs`；一次成功即全部清零。
 *
 * 这里只记上游限流。传输错误（代理不可达）同样是换出口的理由，但不能伪装
 * 成额度耗尽，所以调用方传入原因，面板里分开显示。
 */
function 记录失败(egressUrl, { reason = "throttled", now = Date.now(), cooldownMs = null } = {}) {
  // 空字符串是 `direct` 条目，它是真实出口；只有缺参（null/undefined）才表
  // 示"没东西可记"。
  if (egressUrl === null || egressUrl === undefined) return null;
  const h = 取健康(egressUrl);
  h.failures += 1;
  h.lastError = String(reason).slice(0, 200);
  const base = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 冷却配置.baseMs;
  const backoff = Math.min(base * Math.pow(2, h.failures - 1), Math.max(冷却配置.maxMs, base));
  h.cooldownUntil = now + backoff;
  h.lastStatus = reason;
  // 拒绝是最值得记住的事实：先落盘再让调用方行动，下一秒的重启也不会忘掉
  // 这个 IP。
  立即写健康(now);
  return { failures: h.failures, cooldownUntil: h.cooldownUntil, backoffMs: backoff };
}

/** 清空某出口的失败历史；请求成功后调用。 */
function 记录成功(egressUrl, { now = Date.now() } = {}) {
  if (egressUrl === null || egressUrl === undefined) return null;
  const h = 取健康(egressUrl);
  h.failures = 0;
  h.cooldownUntil = 0;
  h.lastError = null;
  h.lastOkAt = now;
  h.lastStatus = "ok";
  // 每个请求都会走到这里，所以这次写入走合并。
  计划写健康();
  return h;
}

/** 清空健康（全部条目）。 */
function 清空健康() {
  健康表.clear();
  轮转游标 = 0;
  立即写健康();
}

/** 清空单个条目的健康记录（failures 与冷却归零）。id 或 label 定位；
 * 仅供管理面使用，池内 URL 不出网关。 */
function 清空条目健康(idOrLabel, now = Date.now()) {
  const entry = 代理池.entries.find((e) => e.id === idOrLabel || e.label === idOrLabel);
  if (!entry) return { ok: false, error: "没有这个池条目。" };
  const key = 出口键(entry.url);
  const h = 健康表.get(key);
  if (h) {
    h.failures = 0;
    h.cooldownUntil = 0;
    h.lastError = null;
    h.lastStatus = "ok";
    h.lastOkAt = h.lastOkAt || now;
  }
  立即写健康();
  return { ok: true };
}

/** 单条目的公开视图：host:port、健康状态，绝无 URL 凭据。 */
function 描述条目(entry, now = Date.now()) {
  const h = 健康表.get(出口键(entry.url));
  const cooling = Boolean(h && h.cooldownUntil > now);
  return {
    id: entry.id,
    label: entry.label,
    host: entry.direct ? "direct" : 展示主机(entry.url),
    enabled: entry.enabled,
    weight: entry.weight,
    state: !entry.enabled ? "disabled" : cooling ? "cooling" : "ready",
    cooldownMsLeft: cooling ? Math.max(0, h.cooldownUntil - now) : 0,
    cooldownUntil: cooling ? h.cooldownUntil : 0,
    failures: h ? h.failures : 0,
    lastError: h ? h.lastError : null,
    lastOkAt: h ? h.lastOkAt || null : null,
    lastUsedAt: h ? h.lastUsedAt || null : null,
  };
}

function 描述状态(now = Date.now()) {
  const entries = 代理池.entries;
  const active = entries.filter((e) => e.enabled);
  const ready = active.filter((e) => !冷却中(e.url, now));
  const poolActive = active.length > 0;
  const singleActive = !poolActive && Boolean(当前单代理.url);

  const poolView = {
    active: poolActive,
    size: entries.length,
    enabled: active.length,
    ready: ready.length,
    cooling: active.length - ready.length,
    strategy: 代理池.strategy,
    source: 代理池.source,
    cooldownMs: 冷却配置.baseMs,
    maxCooldownMs: 冷却配置.maxMs,
    error: 代理池.error,
    entries: entries.map((e) => 描述条目(e, now)),
  };

  return {
    mode: poolActive ? "pool" : singleActive ? "proxy" : "direct",
    proxy: poolActive ? `${active.length} proxy` : 展示主机(当前单代理.url),
    hasCredentials: poolActive
      ? entries.some((e) => /\/\/[^/@]+@/.test(e.url))
      : 当前单代理.url
        ? /\/\/[^/@]+@/.test(当前单代理.url)
        : false,
    source: poolActive ? 代理池.source : 当前单代理.source,
    locked: (poolActive ? 代理池.source : 当前单代理.source) === "env",
    configPath: 配置文件路径(),
    error: 当前单代理.error || 代理池.error || null,
    pool: poolView,
  };
}

/** 整体写配置（尽力原子）：单文件，仅属主可读。 */
function 写配置(next) {
  try {
    fs.mkdirSync(path.dirname(配置文件路径()), { recursive: true });
    fs.writeFileSync(配置文件路径(), `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    // 旧版本创建的文件保留旧权限；chmod 保证旧版遗留的凭据不会对本机所有用
    // 户可读。
    fs.chmodSync(配置文件路径(), 0o600);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `写入 ${配置文件路径()} 失败：${err.message}` };
  }
}

/** 读当前落盘形态，保证两个设置器互不丢字段。 */
function 读配置对象() {
  try {
    const json = JSON.parse(fs.readFileSync(配置文件路径(), "utf8"));
    return json && typeof json === "object" ? json : {};
  } catch {
    return {};
  }
}

function 锁定时拒绝() {
  if (代理池.source === "env" || 当前单代理.source === "env") {
    return {
      ok: false,
      error: `${环境代理池变量}/${环境单代理变量} 已在环境变量中设置。请修改该变量后重启服务。`,
    };
  }
  return null;
}

/** 保存新的单代理设置。`raw` 为空即回到直连。
 *
 * `UPSTREAM_PROXY_URL` 是运维覆盖项，所以运行时修改会被拒绝，而不是悄悄在
 * 下次重启时输给环境变量。
 */
function 设置单代理(raw) {
  const locked = 锁定时拒绝();
  if (locked) return locked;
  const parsed = 解析代理地址(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const config = 读配置对象();

  if (!parsed.url) {
    delete config.url;
    if (Array.isArray(config.pool) && config.pool.length > 0) {
      if (!写配置(config).ok) return { ok: false, error: `写入 ${配置文件路径()} 失败` };
    } else {
      try {
        fs.unlinkSync(配置文件路径());
      } catch (err) {
        if (err.code !== "ENOENT") {
          return { ok: false, error: `删除 ${配置文件路径()} 失败：${err.message}` };
        }
      }
    }
    当前单代理 = { url: "", source: "none", error: null };
    从磁盘加载();
    return { ok: true, ...描述状态() };
  }

  config.url = parsed.url;
  const written = 写配置(config);
  if (!written.ok) return written;
  当前单代理 = { url: parsed.url, source: "file", error: null };
  return { ok: true, ...描述状态() };
}

/** 替换代理池。`raw` 接受：
 *  - 条目数组（`{id,label,url,enabled,weight}` 或纯 URL 字符串）
 *  - `{ entries: [...], strategy, cooldownMs, maxCooldownMs }`
 *  - `[]` / `{ entries: [] }` 清空池，回退直连或单代理
 */
function 设置代理池(raw) {
  const locked = 锁定时拒绝();
  if (locked) return locked;

  const spec = Array.isArray(raw) ? { entries: raw } : raw && typeof raw === "object" ? raw : null;
  if (!spec) return { ok: false, error: "代理池格式无效。" };

  const source = Array.isArray(spec.entries) ? spec.entries : [];
  const entries = [];
  const errors = [];
  source.forEach((item, index) => {
    const parsed = 解析池条目(item, index);
    if (parsed.ok) entries.push(parsed.entry);
    else errors.push(parsed.error);
  });
  if (errors.length > 0) return { ok: false, error: errors.join(" ") };

  const seen = new Set();
  for (const entry of entries) {
    const key = 出口键(entry.url);
    if (seen.has(key)) {
      return { ok: false, error: `代理池里存在重复出口（ganda）：${entry.direct ? "direct" : 展示主机(entry.url)}` };
    }
    seen.add(key);
  }

  const config = 读配置对象();
  if (entries.length === 0) {
    delete config.pool;
  } else {
    config.pool = entries;
  }
  if (spec.strategy !== undefined) config.strategy = 规范化策略(spec.strategy);
  if (spec.cooldownMs !== undefined) config.cooldownMs = 规范化冷却({ cooldownMs: spec.cooldownMs }).baseMs;
  if (spec.maxCooldownMs !== undefined) {
    config.maxCooldownMs = 规范化冷却({ maxCooldownMs: spec.maxCooldownMs }).maxMs;
  }

  if (!config.url && !config.pool) {
    try {
      fs.unlinkSync(配置文件路径());
    } catch (err) {
      if (err.code !== "ENOENT") return { ok: false, error: `删除 ${配置文件路径()} 失败：${err.message}` };
    }
  } else {
    const written = 写配置(config);
    if (!written.ok) return written;
  }

  // 故意不调 `resetHealth()`：运维保存池（哪怕只改策略）绝不能忘掉哪些 IP
  // 已耗尽。重载时内存健康优先于文件，未变的条目保留冷却，移除的刚被修剪。
  从磁盘加载();
  轮转游标 = 0;
  for (const entry of entries) 取健康(entry.url);
  立即写健康();
  return { ok: true, ...描述状态() };
}

/** 给 fetch init 附上 `proxy:`。调用方自己的 init 原样保留，自带代理的请求
 * 不受影响。
 *
 * 池模式下每次调用挑一个出口。若调用方需要多次 fetch 固定同一出口（比如重
 * 试必须留在应答过的 IP 上），应只调一次 `pick()` 并显式传结果。
 *
 * 空目标是有意义的：它选中池里的 `direct` 条目（本进程自己的地址），请求不
 * 带代理直接出去。
 */
function 附带代理(init, egressUrl = null) {
  if (init && init.proxy) return init;
  // 固定出口的调用方传 URL，空串是 direct 条目 —— 与不传（让池自己挑）不同。
  const target = egressUrl === null || egressUrl === undefined ? 挑选出口().url : egressUrl;
  if (!target) return init;
  return { ...(init || {}), proxy: target };
}

/** 经解析出的出口执行 fetch()。唯一的出站入口。 */
function 网络请求(url, init, egressUrl = null) {
  return fetch(url, 附带代理(init, egressUrl));
}

/** 在一个代理成为现役出口前先证明它能用。
 *
 * 两次探测：桥真正调用的 API，以及回显出口 IP 的 trace 端点（面板由此展示
 * 出口确实换了）。`ok` 由 API 探测决定；IP 探测尽力而为。
 */
async function 测试代理(url, { timeoutMs = 15000, probeUrl = null } = {}) {
  if (typeof Bun === "undefined") {
    return { ok: false, error: "出口代理只能在 Bun 上运行；Node 运行时不支持 proxy 选项。" };
  }
  const parsed = 解析代理地址(url);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (!parsed.url) return { ok: false, error: "代理 URL 为空。" };

  const started = Date.now();
  const exit = await 探测出口地址(parsed.url, timeoutMs);
  let res;
  try {
    // 默认值与随包的线上端点一致。调用方传当前端点，目录迁移不会把能用的代
    // 理误判成失败。
    res = await fetch(probeUrl || "https://opencode.ai/inference/v1/models", {
      proxy: parsed.url,
      headers: { Authorization: "Bearer public" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      ok: false,
      exitIp: exit.ip,
      latencyMs: Date.now() - started,
      error: `无法通过代理连接上游：${err.message}`,
    };
  }
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    return {
      ok: false,
      apiStatus: res.status,
      exitIp: exit.ip,
      latencyMs,
      error:
        res.status === 403
          ? "代理已连上，但上游拒绝该出口（403）。换一个代理试试。"
          : `代理已连上，上游返回 ${res.status}。`,
    };
  }
  return { ok: true, apiStatus: res.status, exitIp: exit.ip, latencyMs, exitError: exit.error || null };
}

/**
 * 并发探测池内所有条目，把结论写进健康表 —— 面板显示的结果就是下一个请
 * 求将使用的结果。被限流的条目进入冷却；正常的清零。
 */
async function 测试代理池({ probeUrl = null, timeoutMs = 15000 } = {}) {
  const entries = 代理池.entries.slice();
  if (entries.length === 0) return { ok: true, entries: [] };
  const results = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.enabled) return { id: entry.id, label: entry.label, host: 展示主机(entry.url), skipped: true };
      const verdict = await 测试代理(entry.url, { probeUrl, timeoutMs });
      if (verdict.ok) 记录成功(entry.url);
      else if (verdict.apiStatus === 403) 记录失败(entry.url, { reason: "upstream 403" });
      const h = 健康表.get(entry.url);
      return {
        id: entry.id,
        label: entry.label,
        host: 展示主机(entry.url),
        ok: verdict.ok,
        apiStatus: verdict.apiStatus || null,
        exitIp: verdict.exitIp || null,
        latencyMs: verdict.latencyMs || null,
        error: verdict.error || null,
        state: h && h.cooldownUntil > Date.now() ? "cooling" : verdict.ok ? "ready" : "error",
      };
    })
  );
  return { ok: results.some((r) => r.ok), entries: results };
}

async function 探测出口地址(proxyUrl, timeoutMs) {
  try {
    const res = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
      proxy: proxyUrl,
      signal: AbortSignal.timeout(Math.min(timeoutMs, 8000)),
    });
    if (!res.ok) return { ip: null, error: `trace HTTP ${res.status}` };
    const text = await res.text();
    const ip = (text.match(/^ip=(.+)$/m) || [])[1] || null;
    return { ip, error: ip ? null : "trace 响应缺少 ip 字段" };
  } catch (err) {
    return { ip: null, error: err.message };
  }
}

从磁盘加载();

module.exports = {
  ENV_OVERRIDE: 环境单代理变量,
  POOL_ENV: 环境代理池变量,
  STRATEGY_ENV: 环境策略变量,
  configFile: 配置文件路径,
  healthFile: 健康文件路径,
  parseProxyUrl: 解析代理地址,
  parsePoolEntry: 解析池条目,
  parsePoolSpec: 解析池声明,
  displayHost: 展示主机,
  getProxyUrl: 取代理地址,
  getPool: () => 代理池.entries.slice(),
  describe: 描述状态,
  setProxyUrl: 设置单代理,
  setPool: 设置代理池,
  pick: 挑选出口,
  markFailure: 记录失败,
  markSuccess: 记录成功,
  resetHealth: 清空健康,
  resetEntryHealth: 清空条目健康,
  withProxy: 附带代理,
  netFetch: 网络请求,
  testProxy: 测试代理,
  testPool: 测试代理池,
  __setForTest(state) {
    当前单代理 = state;
  },
  __reload: 从磁盘加载,
  /** 模拟一次进程启动：内存状态清空，全部从磁盘重读。 */
  __restart() {
    健康表.clear();
    轮转游标 = 0;
    从磁盘加载();
  },
  /** 强制写出合并的健康状态，供测试断言落盘内容。 */
  __flushHealth: () => 立即写健康(),
};
