#!/usr/bin/env bun
const dns = require("dns");
dns.setDefaultResultOrder(process.env.DNS_RESULT_ORDER || "ipv4first");
const http = require("http");
const crypto = require("crypto");
let VERSION = "1.5.0";
try {
  VERSION = require("./package.json").version || VERSION;
} catch {}
const { effectiveMaxTokens } = require("./token-budget");

/**
 * 加载同级模块；文件尚未落盘时回退。
 *
 * 存在的原因是一条真实的升级路径：2.1.0 的自更新器的文件清单里
 * 没有 `proxy.js`/`panel.js`，于是把该安装更新到 2.2.0 时
 * 写出了一个 require 更新器从未抓取模块的 `server.js`。硬重启后必崩，
 * `require` 把它变成崩溃循环（`Cannot find module './proxy'`），
 * 除了重装无路可回。缺失的可选模块
 * 必须退化为直连出口，绝不能阻止进程启动。
 *
 * 只容忍缺失*自家*模块。若 `proxy.js` 存在但 require
 * 了不存在的东西，那是损坏的安装，错误必须浮出。
 */
function 加载本地模块(name, fallback) {
  try {
    return require(`./${name}`);
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND" || !String(err.message).includes(`'./${name}'`)) throw err;
    return fallback;
  }
}

const PROXY_FALLBACK = {
  getProxyUrl: () => "",
  withProxy: (init) => init,
  netFetch: (url, init) => fetch(url, init),
  describe: () => ({
    mode: "direct",
    proxy: null,
    hasCredentials: false,
    source: "none",
    locked: false,
    configPath: null,
    error: "proxy.js belum terpasang; egress langsung. Jalankan ulang install.sh.",
  }),
  setProxyUrl: () => ({
    ok: false,
    error: "proxy.js belum terpasang. Jalankan ulang install.sh atau tunggu perbaikan otomatis.",
  }),
  testProxy: async () => ({ ok: false, error: "proxy.js belum terpasang." }),
};

const PANEL_FALLBACK = {
  renderPanel: () =>
    "<!doctype html><meta charset=\"utf-8\"><title>fucking-opencode</title>" +
    "<body style=\"font:16px/1.5 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem\">" +
    "<h1>安装不完整</h1>" +
    "<p>本目录里找不到 <code>proxy.js</code> 与 <code>panel.js</code>。" +
    "桥以直连出口继续运行。重新执行 " +
    "<code>install.sh</code> 以装上面板。</p></body>",
};

const PANEL_SETTINGS_FALLBACK = {
  getApiKey: () => String(process.env.FUCKING_OPENCODE_API_KEYS || "").split(",")[0].trim(),
  getPanelPassword: () => String(process.env.PANEL_PASSWORD || "").trim(),
  getApiKeySource: () => (String(process.env.FUCKING_OPENCODE_API_KEYS || "").trim() ? "env" : "none"),
  getPanelPasswordSource: () => (String(process.env.PANEL_PASSWORD || "").trim() ? "env" : "none"),
  setApiKey: () => ({ ok: false, error: "panel-settings.js 未安装。" }),
  setPanelPassword: () => ({ ok: false, error: "panel-settings.js 未安装。" }),
  clearApiKey: () => ({ ok: false, error: "panel-settings.js 未安装。" }),
  clearPanelPassword: () => ({ ok: false, error: "panel-settings.js 未安装。" }),
  describe: () => ({ apiKey: { configured: false, source: "none", preview: "" }, panelPassword: { configured: false, source: "none" }, file: "", limits: { min: 4, max: 200 } }),
};

// 出口代理与配置它的面板。在任何代码触网之前加载，
// 让第一个请求就遵守已保存的代理。
let proxy = 加载本地模块("proxy", PROXY_FALLBACK);
let panel = 加载本地模块("panel", PANEL_FALLBACK);
// 面板可编辑凭据（下游 key 与登录密码）。
let panelSettings = 加载本地模块("panel-settings", PANEL_SETTINGS_FALLBACK);
// 协议兼容层与用量统计。两者都可能缺席（半安装的树）：
// 缺席时 /v1/messages 与 /v1/responses 报 501，统计静默关闭。
let compat = null;
try { compat = require("./compat"); } catch { compat = null; }
let 用量统计 = null;
try { 用量统计 = require("./stats"); } catch { 用量统计 = null; }
const runtimeConfig = require("./config");
const 模型组 = require("./model-groups");
// Cloudflare WARP 管理器：可选能力，缺失时接口如实返回不可用。
const WARP_FALLBACK = {
  状态: () => ({ enabled: false, available: false, error: "warp.js 未安装" }),
  连接: () => ({ ok: false, error: "warp.js 未安装" }),
  断开: () => ({ ok: false, error: "warp.js 未安装" }),
  启用: () => false,
};
let warp = 加载本地模块("warp", WARP_FALLBACK);
// WARP farm sidecar（Go）：N 个 WARP 出口 → N 个本地 SOCKS5 监听，无需 Docker，
// 也无需 TUN。本模块只管理子进程与代理池；lane 对网关来说就是普通 SOCKS5 代理。
const WARP_FARM_FALLBACK = {
  状态: () => ({ running: false, lanes: [], settings: {}, binaryAvailable: false, error: "warp-farm.js 未安装" }),
  启动: async () => ({ ok: false, error: "warp-farm.js 未安装" }),
  停止: async () => ({ ok: false, error: "warp-farm.js 未安装" }),
  重启动: async () => ({ ok: false, error: "warp-farm.js 未安装" }),
  轮换: async () => ({ ok: false, error: "warp-farm.js 未安装" }),
  刷新: async () => ({ running: false, lanes: [] }),
  应用到池: () => ({ ok: false, error: "warp-farm.js 未安装" }),
  自动启动: async () => ({ ok: false, skipped: true }),
  设置: () => ({}),
  保存设置: () => ({ ok: false, error: "warp-farm.js 未安装" }),
  日志: () => [],
};
const warpFarm = 加载本地模块("warp-farm", WARP_FARM_FALLBACK);
const WARP轮换间隔 = new Map();

/**
 * 本服务按相对路径 require 的本地模块。自更新器用它拒绝会装出
 * require 缺失文件的 `server.js` 的更新；启动用它修复半安装的树。
 */
function 本地require(source) {
  const names = new Set();
  // 先剥注释：上面的文档注释把 `require("./x")` 当例子，
  // 扫描它会得出虚假的 `x.js` 依赖。
  const text = String(source || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  // `require("./x")` 与宽容的 `加载本地模块("x", …)` 加载器都指向
  // 本服务工作所必需的文件。
  for (const re of [/\brequire\(\s*["']\.\/([A-Za-z0-9._-]+)["']\s*\)/g, /\bloadLocalModule\(\s*["']([A-Za-z0-9._-]+)["']/g]) {
    let match;
    while ((match = re.exec(text))) {
      if (match[1].endsWith(".json")) continue;
      const name = match[1].endsWith(".js") ? match[1] : `${match[1]}.js`;
      names.add(name);
    }
  }
  return [...names];
}

/**
 * 抓取 `server.js` require 了但磁盘上还没有的文件。
 *
 * 2.1.0 附带的自更新器，其文件清单早于 `proxy.js`/`panel.js`，
 * 曾更新到 2.2.0 后写出一个启动不了的 server。这种安装现在
 * 以上面的兜底启动；下一次启动时由这里修复，而不是让面板
 * 永久不可用。尽力而为：失败保留兜底，绝不阻塞启动。
 */
async function repairMissingModules(dir = __dirname) {
  const fs = require("fs");
  const path = require("path");
  const required = new Set(本地require(fs.readFileSync(path.join(dir, "server.js"), "utf8")));
  for (const name of ["proxy.js", "panel.js", "config.js", "model-groups.js", "socks-bridge.js", "warp.js", "compat.js"]) required.add(name);
  const missing = [...required].filter((f) => !fs.existsSync(path.join(dir, f)));
  const repaired = [];
  const failed = [];
  for (const file of missing) {
    try {
      const res = await fetch(`${UPDATE_BASE_URL}/${file}?cb=${Date.now()}`, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text || text.length < 20) throw new Error("empty response");
      new Function(text.replace(/^#!.*\n/, ""));
      const tmp = path.join(dir, `.${file}.repair.${process.pid}`);
      fs.writeFileSync(tmp, text, "utf8");
      fs.renameSync(tmp, path.join(dir, file));
      repaired.push(file);
    } catch (err) {
      failed.push(`${file}: ${err.message}`);
    }
  }
  if (repaired.length && path.resolve(dir) === path.resolve(__dirname)) {
    proxy = 加载本地模块("proxy", PROXY_FALLBACK);
    panel = 加载本地模块("panel", PANEL_FALLBACK);
    console.log(`[fucking-opencode] 已修复缺失模块：${repaired.join(", ")}`);
  } else if (repaired.length) {
    console.log(`[fucking-opencode] 已修复缺失模块：${repaired.join(", ")}`);
  }
  if (failed.length) {
    console.warn(
      `[fucking-opencode] 无法修复 ${failed.join(", ")}；` +
        "以直连出口运行。重新执行 install.sh 修复本安装。"
    );
  }
  return { repaired, failed };
}

const PORT = parseInt(process.env.PORT || "20134", 10);
const HOST = process.env.HOST || "127.0.0.1";
// 管理端口：非 0 且不同于 PORT 时，面板与 /api/* 只在这个端口提供，
// 主端口只剩 /v1/* 与 /health。0 表示沿用旧行为（同端口）。
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || "0", 10);
const ADMIN_BIND = process.env.ADMIN_BIND || HOST;
const 分离管理端口 = ADMIN_PORT > 0 && ADMIN_PORT !== PORT;
// 可热加载的运行时配置（env > config.json > 默认值），见 config.js。
function 上游超时毫秒() {
  return runtimeConfig.取("upstreamTimeoutMs");
}

// 上游已回 200 头但迟迟不发首个 SSE 事件时，客户端会一直挂着。
// 默认 15 秒后放弃并让出口进入冷却；0 = 关闭。
function 首事件超时毫秒() {
  const raw = process.env.FIRST_EVENT_TIMEOUT_MS;
  if (raw === undefined || String(raw).trim() === "") return 15000;
  const 数 = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(数) || 数 < 0) return 15000;
  return Math.min(数, 120000);
}

async function 读首个数据块(reader, 毫秒) {
  let timer;
  const 超时 = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Upstream sent no first SSE event within ${毫秒}ms`);
      err.code = "first_event_timeout";
      reject(err);
    }, 毫秒);
  });
  try {
    return await Promise.race([reader.read(), 超时]);
  } finally {
    clearTimeout(timer);
  }
}
function 请求体上限() {
  return runtimeConfig.取("maxBodyBytes");
}
// 面板登录（可选）。设置 PANEL_PASSWORD 后，面板 HTML、/api/proxy* 与
// /api/stats|history 都要求有效会话；/v1/*、/health 与 /api/login 不受影响。
// 留空 = 保持旧行为（本地面板无需登录）。
function panelPassword() {
  return panelSettings.getPanelPassword();
}
const PANEL_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PANEL_SESSION_COOKIE = "ofb_panel";
const panelLoginFailures = new Map();

// ---- 事件环：捕获本进程日志行，喂给面板的「事件流」标签页。 ----
// 包一层 console.log/warn/error：原有输出照旧落终端，同时进入环形缓冲。
// 上限 500 条，超过即丢最旧；每行带自增序号，面板按序号增量拉取。
const 事件环 = [];
let 事件序号 = 0;
const 事件环上限 = 500;
const 原生日志 = { log: console.log, warn: console.warn, error: console.error };
function 记录事件(行, 级别 = "info") {
  事件序号 += 1;
  事件环.push({
    序号: 事件序号,
    at: Date.now(),
    level: 级别,
    line: String(行).replace(/\s+/g, " ").trim().slice(0, 400),
  });
  if (事件环.length > 事件环上限) 事件环.shift();
}
console.log = (...参数) => {
  记录事件(参数.map(String).join(" "), "info");
  原生日志.log(...参数);
};
console.warn = (...参数) => {
  记录事件(参数.map(String).join(" "), "warn");
  原生日志.warn(...参数);
};
console.error = (...参数) => {
  记录事件(参数.map(String).join(" "), "error");
  原生日志.error(...参数);
};
const GATE_RETRY_COOLDOWN_MS = parseInt(
  process.env.GATE_RETRY_COOLDOWN_MS || "30000",
  10
);
// 单次客户端请求最多换几条出口。免费额度按 IP 记，所以 429/IP 封锁/5xx
// 在换到新出口时还有成功机会；0 关闭。上限 10 防止配置失误打爆池。
const 最大出口重试 = (() => {
  const n = parseInt(process.env.UPSTREAM_EGRESS_RETRIES || "3", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 10) : 3;
})();
const CORS_ORIGIN = process.env.CORS_ORIGIN !== undefined ? process.env.CORS_ORIGIN : "";
// 可选 API key 门禁。默认关闭（本桥是本地工具，历史行为不变）。
// 密钥来源：面板保存的文件优先，其次是 FUCKING_OPENCODE_API_KEYS 的第一个值。
// 时序安全比较，避免逐字符计时侧信道。
// 客户端未给 model 时的默认模型。空 = 保持旧行为（400 model_required）。
// 只在 /v1/chat/completions 生效；兼容路由本来就要求显式 model。
function 默认模型值() {
  return runtimeConfig.取("defaultModel");
}

// 客户端没给 reasoning_effort 时，用网关级默认或按模型覆盖；
// 显式请求永远优先。
function 推理强度(targetModel) {
  const 映射 = runtimeConfig.取("reasoningEffortByModel") || {};
  const 指定 = 映射[targetModel] || runtimeConfig.取("reasoningEffort") || "";
  return 指定 || undefined;
}
/** 接口密钥检查：返回 null（通过）或 401 响应体。 */
function 检查API密钥(req) {
  // 协议兼容路由的内部自调用已在入口校验过；不再重复计费或计限额。
  if (是内部调用(req)) return null;
  if (!panelSettings.hasApiKeys()) {
    req.__apiKeyModels = null;
    return null;
  }
  // 面板会话已用密码登录，测试台同源调用直接放行，避免在浏览器里暴露 API key。
  if (panelPassword() && panelAuthorized(req)) {
    req.__apiKeyLabel = "panel";
    req.__apiKeyModels = null;
    return null;
  }
  const raw = req.headers?.authorization || "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
  if (!token) return { error: { message: "缺少 API key：Authorization: Bearer <key>（服务端已启用密钥）", type: "authentication_error", code: "invalid_api_key" } };
  const matched = panelSettings.matchApiKey(token);
  if (!matched) return { error: { message: "API key 无效", type: "authentication_error", code: "invalid_api_key" } };
  req.__apiKeyLabel = matched.label;
  req.__apiKeyModels = Array.isArray(matched.models) ? matched.models : null;
  const 超限 = 检查密钥额度(matched);
  if (超限) return { error: 超限.error, __status: 超限.status, __retryAfter: 超限.retryAfter };
  return null;
}
/** 入站客户端地址：去掉 IPv6-mapped 前缀；只用于本机分面统计。 */
function 客户端地址(req) {
  const raw = String(req.socket?.remoteAddress || req.connection?.remoteAddress || "");
  return raw.replace(/^::ffff:/, "").slice(0, 64);
}

/** 用量记录的机器字段：供应商固定为 opencode，密钥标签只存机器值，面板再本地化。 */
function 用量标签(req) {
  const label = req && req.__apiKeyLabel
    ? req.__apiKeyLabel
    : panelSettings.hasApiKeys()
      ? "unknown"
      : "none";
  return {
    provider: "opencode",
    client_ip: 客户端地址(req),
    key_label: label,
  };
}

/** 环境整数：非法或越界时回落到默认值。 */
function 环境整数(name, 默认值, 最小, 最大) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return 默认值;
  return Math.min(Math.max(Math.floor(raw), 最小), 最大);
}

// --- 内部自调用令牌 ---
// 协议兼容路由（Anthropic / Responses）会把请求回打本机的
// /v1/chat/completions。那个内部跳转必须跳过下游 key 校验、额度计数与
// 并发闸门，否则一次客户端请求会被记两次、或在排队时死锁。
const 内部令牌 = crypto.randomBytes(16).toString("hex");

function 是内部调用(req) {
  const hop = String(req.headers?.["x-internal-hop"] || "");
  if (hop.length !== 内部令牌.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(hop), Buffer.from(内部令牌))) return false;
  const ip = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1";
}

// --- 推理并发闸门 ---
// 上游对突发很敏感：限制同时在途的推理请求，超出后排队，等待超时回 429。
// MAX_INFLIGHT=0 关闭（默认 64），MAX_INFLIGHT_WAIT_MS 控制排队上限（默认 30s）。
let 在途推理 = 0;
const 并发等待队列 = [];

/** 申请一个推理槽；返回释放函数，超时返回 null。 */
function 申请并发槽() {
  const 上限 = 环境整数("MAX_INFLIGHT", 64, 0, 4096);
  if (上限 === 0) return Promise.resolve(() => {});
  if (在途推理 < 上限) {
    在途推理 += 1;
    return Promise.resolve(释放并发槽);
  }
  const 等待毫秒 = 环境整数("MAX_INFLIGHT_WAIT_MS", 30000, 0, 300000);
  return new Promise((resolve) => {
    let done = false;
    const 唤醒 = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      在途推理 += 1;
      resolve(释放并发槽);
    };
    const timer = 等待毫秒 > 0
      ? setTimeout(() => {
          if (done) return;
          done = true;
          const index = 并发等待队列.indexOf(唤醒);
          if (index >= 0) 并发等待队列.splice(index, 1);
          resolve(null);
        }, 等待毫秒)
      : null;
    并发等待队列.push(唤醒);
  });
}

function 释放并发槽() {
  在途推理 = Math.max(0, 在途推理 - 1);
  const 下一个 = 并发等待队列.shift();
  if (下一个) 下一个();
}

/** 响应结束时释放槽位，finish 与 close 只生效一次。 */
function 挂接并发释放(res, release) {
  if (!release) return;
  let released = false;
  const once = () => {
    if (released) return;
    released = true;
    release();
  };
  res.once("finish", once);
  res.once("close", once);
}

// --- 下游 key 额度与模型白名单 ---
// 条目字段：rpm（每分钟请求数，0 = 不限）、daily（24 小时请求数，0 = 不限）、
// models（允许的模型 id 列表，空 = 全放行）。计数只存在内存里，重启归零。
const 密钥计数 = new Map();
const 分钟窗口毫秒 = 60 * 1000;
const 日窗口毫秒 = 24 * 60 * 60 * 1000;

function 取密钥计数(label) {
  const now = Date.now();
  let entry = 密钥计数.get(label);
  if (!entry) {
    entry = { 分钟起点: now, 分钟次数: 0, 日起点: now, 日次数: 0 };
    密钥计数.set(label, entry);
  }
  if (now - entry.分钟起点 >= 分钟窗口毫秒) {
    entry.分钟起点 = now;
    entry.分钟次数 = 0;
  }
  if (now - entry.日起点 >= 日窗口毫秒) {
    entry.日起点 = now;
    entry.日次数 = 0;
  }
  return entry;
}

/** 记一次请求并检查限额；超限返回 { status, error, retryAfter }。 */
function 检查密钥额度(matched) {
  const rpm = Number(matched?.rpm) || 0;
  const daily = Number(matched?.daily) || 0;
  if (!rpm && !daily) return null;
  const entry = 取密钥计数(matched.label);
  entry.分钟次数 += 1;
  entry.日次数 += 1;
  const now = Date.now();
  if (rpm && entry.分钟次数 > rpm) {
    return {
      status: 429,
      retryAfter: Math.max(1, Math.ceil((entry.分钟起点 + 分钟窗口毫秒 - now) / 1000)),
      error: {
        message: `API key「${matched.label}」超出每分钟 ${rpm} 次限制。`,
        type: "rate_limit_error",
        code: "key_rate_limited",
      },
    };
  }
  if (daily && entry.日次数 > daily) {
    return {
      status: 429,
      retryAfter: Math.max(1, Math.ceil((entry.日起点 + 日窗口毫秒 - now) / 1000)),
      error: {
        message: `API key「${matched.label}」超出 24 小时 ${daily} 次限制。`,
        type: "rate_limit_error",
        code: "key_quota_exceeded",
      },
    };
  }
  return null;
}

/** 模型白名单；条目未配置 models 时放行。 */
function 检查模型许可(req, model) {
  const list = req?.__apiKeyModels;
  if (!Array.isArray(list) || list.length === 0) return null;
  const name = String(model || "");
  if (list.includes(name)) return null;
  return {
    message: `API key 不允许模型「${name}」。`,
    type: "invalid_request_error",
    code: "model_not_allowed",
  };
}

// --- Prometheus 指标 ---
function 渲染指标() {
  const now = Date.now();
  const since = now - 日窗口毫秒;
  let rows = [];
  try {
    rows = 用量统计 && 用量统计.读历史 ? 用量统计.读历史().filter((r) => r.at >= since) : [];
  } catch {}
  const 桶 = { ok: 0, client: 0, server: 0 };
  let input = 0;
  let cached = 0;
  let output = 0;
  let ms = 0;
  let ttft = 0;
  let ttftCount = 0;
  for (const row of rows) {
    const status = Number(row.status) || 0;
    if (status >= 200 && status < 300) 桶.ok += 1;
    else if (status >= 400 && status < 500) 桶.client += 1;
    else if (status >= 500) 桶.server += 1;
    input += Number(row.input_tokens) || 0;
    cached += Number(row.cached_tokens) || 0;
    output += Number(row.output_tokens) || 0;
    ms += Number(row.ms) || 0;
    if (Number.isFinite(row.ttft_ms)) {
      ttft += row.ttft_ms;
      ttftCount += 1;
    }
  }
  let pool = { mode: "direct", ready: 0, enabled: 0, cooling: 0 };
  try { pool = proxy.describe(); } catch {}
  let farm = { running: false, lanes: [] };
  try { farm = warpFarm.状态() || farm; } catch {}
  const lanes = Array.isArray(farm.lanes) ? farm.lanes : [];
  const laneReady = lanes.filter((l) => l && (l.state === "ready" || l.ok === true)).length;
  const lines = [
    "# HELP fucking_opencode_requests_24h Requests recorded in the last 24 hours by outcome.",
    "# TYPE fucking_opencode_requests_24h counter",
    `fucking_opencode_requests_24h{outcome="ok"} ${桶.ok}`,
    `fucking_opencode_requests_24h{outcome="client_error"} ${桶.client}`,
    `fucking_opencode_requests_24h{outcome="server_error"} ${桶.server}`,
    "# HELP fucking_opencode_tokens_24h Tokens recorded in the last 24 hours.",
    "# TYPE fucking_opencode_tokens_24h counter",
    `fucking_opencode_tokens_24h{kind="input"} ${input}`,
    `fucking_opencode_tokens_24h{kind="cached"} ${cached}`,
    `fucking_opencode_tokens_24h{kind="output"} ${output}`,
    "# HELP fucking_opencode_request_duration_ms_24h Sum of request durations in the last 24 hours.",
    "# TYPE fucking_opencode_request_duration_ms_24h counter",
    `fucking_opencode_request_duration_ms_24h ${ms}`,
    "# HELP fucking_opencode_ttft_ms_24h Sum of time-to-first-token samples in the last 24 hours.",
    "# TYPE fucking_opencode_ttft_ms_24h counter",
    `fucking_opencode_ttft_ms_24h ${ttft}`,
    `fucking_opencode_ttft_samples_24h ${ttftCount}`,
    "# HELP fucking_opencode_inflight Inference requests currently in flight.",
    "# TYPE fucking_opencode_inflight gauge",
    `fucking_opencode_inflight ${在途推理}`,
    "# HELP fucking_opencode_gateway_uptime_seconds Process uptime.",
    "# TYPE fucking_opencode_gateway_uptime_seconds gauge",
    `fucking_opencode_gateway_uptime_seconds ${Math.floor(process.uptime())}`,
    "# HELP fucking_opencode_egress_mode Current egress mode (1 = active).",
    "# TYPE fucking_opencode_egress_mode gauge",
    `fucking_opencode_egress_mode{mode="direct"} ${pool.mode === "direct" ? 1 : 0}`,
    `fucking_opencode_egress_mode{mode="proxy"} ${pool.mode === "proxy" ? 1 : 0}`,
    `fucking_opencode_egress_mode{mode="pool"} ${pool.mode === "pool" ? 1 : 0}`,
    "# HELP fucking_opencode_pool_entries Proxy pool entries by state.",
    "# TYPE fucking_opencode_pool_entries gauge",
    `fucking_opencode_pool_entries{state="enabled"} ${pool.enabled || 0}`,
    `fucking_opencode_pool_entries{state="ready"} ${pool.ready || 0}`,
    `fucking_opencode_pool_entries{state="cooling"} ${pool.cooling || 0}`,
    "# HELP fucking_opencode_farm_lanes WARP farm lanes.",
    "# TYPE fucking_opencode_farm_lanes gauge",
    `fucking_opencode_farm_lanes{state="ready"} ${laneReady}`,
    `fucking_opencode_farm_lanes{state="total"} ${lanes.length}`,
    "",
  ];
  return lines.join("\n");
}

/** 状态目录：与 settings/proxy 一致，可用 FUCKING_OPENCODE_STATE_DIR 覆盖。 */
function 备份状态目录() {
  const raw = process.env.FUCKING_OPENCODE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return require("path").join(process.env.USERPROFILE || process.env.HOME || ".", ".fucking-opencode");
}

// 匿名单通道熔断：上游免费层按出口 IP 计额度。连续 N 次最终 429 / IP 封锁
// 后，继续打只会延长惩罚。暂停期内直接快速拒绝，指数退避，成功后退避清零。
// ANON_BACKOFF_THRESHOLD 默认 0（关闭，与 opencode2api 默认一致）。
let 匿名退避缓存 = null;

function 匿名退避配置() {
  const 数 = (值, 默认) => {
    const 解 = parseFloat(值);
    return Number.isFinite(解) ? 解 : 默认;
  };
  return {
    threshold: Math.max(0, Math.floor(数(process.env.ANON_BACKOFF_THRESHOLD, 0))),
    base: Math.min(Math.max(数(process.env.ANON_BACKOFF_BASE_HOURS, 1), 0.1), 24),
    max: Math.min(Math.max(数(process.env.ANON_BACKOFF_MAX_HOURS, 24), 0.1), 168),
  };
}

function 匿名退避文件() {
  return require("path").join(备份状态目录(), "anon-backoff.json");
}

function 读匿名退避() {
  if (匿名退避缓存) return 匿名退避缓存;
  let 状态 = { failures: 0, trips: 0, until: 0 };
  try {
    const 数据 = JSON.parse(require("fs").readFileSync(匿名退避文件(), "utf8"));
    if (数据 && typeof 数据 === "object") {
      状态.failures = Math.max(0, Number(数据.failures) || 0);
      状态.trips = Math.max(0, Number(数据.trips) || 0);
      状态.until = Math.max(0, Number(数据.until) || 0);
    }
  } catch {}
  if (状态.until && 状态.until <= Date.now()) 状态 = { failures: 0, trips: 状态.trips, until: 0 };
  匿名退避缓存 = 状态;
  return 匿名退避缓存;
}

function 写匿名退避(状态) {
  匿名退避缓存 = 状态;
  const 文件 = 匿名退避文件();
  const 临时 = `${文件}.tmp.${process.pid}`;
  try {
    require("fs").mkdirSync(require("path").dirname(文件), { recursive: true });
    require("fs").writeFileSync(临时, JSON.stringify(状态), { mode: 0o600 });
    require("fs").renameSync(临时, 文件);
  } catch {
    try {
      require("fs").unlinkSync(临时);
    } catch {}
  }
}

function 匿名暂停剩余毫秒() {
  const 状态 = 读匿名退避();
  return 状态.until > Date.now() ? 状态.until - Date.now() : 0;
}

function 记录匿名失败(原因) {
  const { threshold, base, max } = 匿名退避配置();
  if (!threshold) return;
  const 状态 = 读匿名退避();
  if (状态.until > Date.now()) return;
  状态.failures += 1;
  if (状态.failures < threshold) {
    写匿名退避(状态);
    return;
  }
  状态.trips += 1;
  状态.failures = 0;
  const 小时 = Math.min(max, base * Math.pow(2, 状态.trips - 1));
  状态.until = Date.now() + Math.round(小时 * 3600 * 1000);
  写匿名退避(状态);
  console.warn(
    `[fucking-opencode] 匿名通道连续失败达到 ${threshold} 次（${原因}）；暂停 ${小时} 小时后重试。`
  );
}

function 记录匿名成功() {
  const 状态 = 读匿名退避();
  if (!状态.failures && !状态.trips && !状态.until) return;
  写匿名退避({ failures: 0, trips: 0, until: 0 });
}

const OPENAPI_JSON = JSON.stringify({
  openapi: "3.1.0",
  info: {
    title: "Fucking Opencode",
    version: VERSION,
    description: "OpenCode 免费层网关：OpenAI Chat Completions、Anthropic Messages、OpenAI Responses。",
  },
  servers: [{ url: `http://127.0.0.1:${PORT}` }],
  paths: {
    "/health": {
      get: {
        summary: "健康状态与身份/网关诊断",
        responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/metrics": {
      get: {
        summary: "Prometheus 指标（设置 METRICS_TOKEN 后需 Bearer）",
        responses: { 200: { description: "text/plain", content: { "text/plain": { schema: { type: "string" } } } } },
      },
    },
    "/v1/models": {
      get: {
        summary: "当前可用的免费模型",
        responses: { 200: { description: "模型列表", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/models/{model}": {
      get: {
        summary: "单个模型",
        parameters: [{ name: "model", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "模型条目", content: { "application/json": { schema: { type: "object" } } } },
          404: { description: "模型不存在" },
        },
      },
    },
    "/v1/chat/completions": {
      post: {
        summary: "OpenAI Chat Completions（支持 stream）",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: {
          200: { description: "完成体或 SSE 流" },
          401: { description: "缺少或无效的 API key" },
          429: { description: "上游额度或网关并发上限" },
        },
      },
    },
    "/v1/completions": {
      post: {
        summary: "OpenAI 旧版 Completions（翻译成 Chat 后回译）",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { 200: { description: "text_completion 或 SSE 流" } },
      },
    },
    "/v1/embeddings": {
      post: {
        summary: "不提供：上游免费层无 embeddings",
        responses: { 501: { description: "embeddings_not_supported" } },
      },
    },
    "/v1/messages": {
      post: {
        summary: "Anthropic Messages（支持 stream）",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { 200: { description: "Anthropic 完成体或事件流" } },
      },
    },
    "/v1/messages/count_tokens": {
      post: {
        summary: "Anthropic 词元近似计数（不触上游）",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { 200: { description: "{ input_tokens }" } },
      },
    },
    "/v1/responses": {
      post: {
        summary: "OpenAI Responses（支持 stream）",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { 200: { description: "Responses 结果" } },
      },
    },
  },
});



function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // 长度不等也要消耗比较时间：与假 key 再比一次。
    crypto.timingSafeEqual(bb, bb);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}
// 可选出站中继。设置后，每个上游推理请求都发往这个中继
// URL 而不是直接发 opencode.ai，真实 origin 与路径经
// x-relay-target / x-relay-path 携带（与 9Router 的
// Cloudflare/Vercel/Deno/Netlify 中继所说的一致）。中继执行
// 最终 fetch，上游看到中继的出口 IP。空 = 直连。
const UPSTREAM_RELAY_URL = (process.env.UPSTREAM_RELAY_URL || "").trim();

/**
 * `/health` 用的仅 origin 标签。配置的中继 URL 可能在查询串里
 * 带凭据或令牌；绝不能交给能触达本地健康端点的任何
 * 客户端。
 */
function 中继标签(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "configured";
  }
}

// 线上端点。这些是*默认值*；实时值来自 identity.js，它
// 在刷新时从上游供应商目录（models.opencode.ai/api.json 的
// `opencode.api`）解析。逐请求读取意味着 /zen/v1 →
// /inference/v1 这类迁移无须重启即生效。
const OPENCODE_RESPONSES_URL =
  process.env.OPENCODE_RESPONSES_URL || "https://opencode.ai/inference/v1/responses";
const OPENCODE_CHAT_URL =
  process.env.OPENCODE_CHAT_URL || "https://opencode.ai/inference/v1/chat/completions";
const OPENCODE_MODELS_URL =
  process.env.OPENCODE_MODELS_URL || "https://opencode.ai/inference/v1/models";
const OPENCODE_RELEASES_ATOM_URL =
  process.env.OPENCODE_RELEASES_ATOM_URL || "https://github.com/anomalyco/opencode/releases.atom";
const UPDATE_HINT =
  "Update fucking-opencode: curl -fsSL https://raw.githubusercontent.com/ShinRyu04/Fucking-Opencode/main/install.sh | bash";
// 自更新（类似 CLI 的 `update: auto`）：轮询本仓库的 package.json，
// 存在更新版就替换已安装文件。默认启用；AUTO_UPDATE=0
// 关闭。文件换入前先做语法检查，且逐文件 rename，
// 半截下载永远不会留下损坏的安装。
const UPDATE_BASE_URL =
  process.env.OPENCODE_GATEWAY_UPDATE_BASE ||
  "https://raw.githubusercontent.com/ShinRyu04/Fucking-Opencode/main";
const UPDATE_FILES = [
  "package.json",
  "identity.js",
  "token-budget.js",
  "verify.js",
  "gate-drill.js",
  "transport-fingerprint.js",
  "transport-baseline.json",
  "tunnel-doctor.sh",
  "proxy.js",
  "panel.js",
  "panel-settings.js",
  "config.js",
  "compat.js",
  "model-groups.js",
  "socks-bridge.js",
  "warp.js",
  "stats.js",
  "egress-proxy.js",
  "server.js",
  "panel-avatar.png",
  "THIRD_PARTY_NOTICES.md",
];
let updateInFlight = null;
let 上次更新检查 = 0;
const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 比较两个 `x.y.z` 版本。`remote` 更新时返回 true。
 */
function 是更新版本(current, remote) {
  const a = String(current).split(".").map(Number);
  const b = String(remote).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const av = Number.isFinite(a[i]) ? a[i] : 0;
    const bv = Number.isFinite(b[i]) ? b[i] : 0;
    if (bv !== av) return bv > av;
  }
  return false;
}

/**
 * CLI `update: auto` 的微缩版：检查本仓库发布的 package.json，
 * 更新则把每个随发行版文件下载到临时文件，对 JS 做语法检查，
 * 再 rename 到位并退出，让服务管理器重启我们。任何失败
 * 都保持运行中的安装原样。
 *
 * 刻意*不在*请求路径上：与模型发现并行，至多每
 * UPDATE_CHECK_TTL_MS 一次。
 */
async function 检查并应用更新() {
  if (!runtimeConfig.取("autoUpdate")) return { updated: false, reason: "disabled" };
  if (updateInFlight) return updateInFlight;
  if (Date.now() - 上次更新检查 < UPDATE_CHECK_TTL_MS) {
    return { updated: false, reason: "fresh" };
  }
  const fs = require("fs");
  const path = require("path");
  if (
    process.env.AUTO_UPDATE !== "1" &&
    process.env.AUTO_UPDATE !== "force" &&
    !process.env.OPENCODE_GATEWAY_UPDATE_BASE &&
    fs.existsSync(path.join(__dirname, ".git"))
  ) {
    return { updated: false, reason: "git-checkout" };
  }
  updateInFlight = (async () => {
    上次更新检查 = Date.now();
    const tmpFiles = [];
    const cb = Date.now();
    try {
      const pkgRes = await proxy.netFetch(`${UPDATE_BASE_URL}/package.json?cb=${cb}`, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(8000),
      });
      if (!pkgRes.ok) throw new Error(`HTTP ${pkgRes.status} fetching package.json`);
      const remotePkg = await pkgRes.json();
      const remoteVersion = String(remotePkg?.version || "").trim();
      if (!/^\d+\.\d+\.\d+$/.test(remoteVersion)) throw new Error("远端版本无效");
      if (!是更新版本(VERSION, remoteVersion)) {
        return { updated: false, reason: "up-to-date" };
      }

      for (const file of UPDATE_FILES) {
        const res = await proxy.netFetch(`${UPDATE_BASE_URL}/${file}?cb=${cb}`, {
          headers: { "Cache-Control": "no-cache" },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${file}`);
        const text = await res.text();
        if (!text || text.length < 20) throw new Error(`empty response for ${file}`);
        if (file.endsWith(".js")) {
          try {
            new Function(text.replace(/^#!.*\n/, ""));
          } catch (err) {
            throw new Error(`syntax check failed for ${file}: ${err.message}`);
          }
        } else if (file.endsWith(".json")) {
          try {
            JSON.parse(text);
          } catch (err) {
            throw new Error(`invalid JSON in ${file}: ${err.message}`);
          }
        } else if (file.endsWith(".sh")) {
          // `new Function` 无法解析 bash。在这里检查 shebang，
          // 落盘后由下面的 `bash -n` 解析。
          if (!/^#!.*\b(ba)?sh\b/.test(text)) throw new Error(`${file} is not a shell script`);
        }
        const tmpPath = path.join(__dirname, `.${file}.tmp.${process.pid}`);
        fs.writeFileSync(tmpPath, text, "utf8");
        if (file.endsWith(".sh")) {
          let parsed = true;
          try {
            require("child_process").execFileSync("bash", ["-n", tmpPath], {
              stdio: "ignore",
              timeout: 5000,
            });
          } catch (err) {
            // 本机没有 bash 不算语法失败；上面的 shebang 检查
            // 是那里能做的全部。其余都是真拒绝。
            if (!err || err.code !== "ENOENT") {
              try {
                fs.unlinkSync(tmpPath);
              } catch {}
              parsed = false;
              throw new Error(`syntax check failed for ${file}: ${err.message}`);
            }
          }
          if (parsed) fs.chmodSync(tmpPath, 0o755);
        }
        tmpFiles.push({ tmpPath, targetPath: path.join(__dirname, file) });
      }

      // 发行版可能新增一个旧 `UPDATE_FILES` 清单没有点名
      // 的模块。2.1.0 -> 2.2.0 正是如此：新 server.js require 了
      // ./proxy 与 ./panel，旧更新器从未抓取它们，于是
      // 重启后崩溃循环。读取*incoming* 的 server.js，暂存它 import
      // 的每一个本地模块，运行中进程里的文件清单就
      // 永远不会成为合法发行版起不来的原因。
      const incoming = tmpFiles.find((f) => path.basename(f.targetPath) === "server.js");
      if (incoming) {
        const declared = new Set(tmpFiles.map((f) => path.basename(f.targetPath)));
        for (const file of 本地require(fs.readFileSync(incoming.tmpPath, "utf8"))) {
          if (declared.has(file) || fs.existsSync(path.join(__dirname, file))) continue;
          const res = await proxy.netFetch(`${UPDATE_BASE_URL}/${file}?cb=${cb}`, {
            headers: { "Cache-Control": "no-cache" },
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status} fetching required module ${file}`);
          const text = await res.text();
          if (!text || text.length < 20) throw new Error(`empty response for required module ${file}`);
          try {
            new Function(text.replace(/^#!.*\n/, ""));
          } catch (err) {
            throw new Error(`syntax check failed for required module ${file}: ${err.message}`);
          }
          const tmpPath = path.join(__dirname, `.${file}.tmp.${process.pid}`);
          fs.writeFileSync(tmpPath, text, "utf8");
          tmpFiles.push({ tmpPath, targetPath: path.join(__dirname, file) });
          declared.add(file);
          console.log(`[fucking-opencode] 已暂存新要求的模块 ${file}`);
        }
      }

      for (const { tmpPath, targetPath } of tmpFiles) fs.renameSync(tmpPath, targetPath);
      console.log(
        `[fucking-opencode] 已自更新 ${VERSION} → ${remoteVersion}；退出以让服务重启。`
      );
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
      return { updated: true, version: remoteVersion };
    } catch (err) {
      for (const { tmpPath } of tmpFiles) {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {}
      }
      console.warn(`[fucking-opencode] 跳过自更新：${err.message}`);
      return { updated: false, error: err.message };
    } finally {
      updateInFlight = null;
    }
  })();
  return updateInFlight;
}

function 是免费档CLI网关错误(status, errType, errMsg) {
  if (errType === "FreeTierError" || errType === "UpgradeRequired") return true;
  // 426 是版本下限握手：上游点明它会接受的最低客户端
  // 版本。视为网关信号，让身份层采纳该下限并重试。
  if (status === 426) return true;
  if (status !== 403 && status !== 401) return false;
  const m = String(errMsg || "").toLowerCase();
  return (
    m.includes("freetiererror") ||
    m.includes("free tier") ||
    m.includes("free models") ||
    m.includes("opencode cli") ||
    m.includes("only available in opencode") ||
    m.includes("upgrade required") ||
    m.includes("or newer is required")
  );
}
const identity = require("./identity");

/**
 * 本请求的线上端点。环境变量可钉住；否则用从上游供应商
 * 目录推导的值，首次成功刷新前回退到随发行版默认。
 * 逐请求解析，目录变更在下一个请求生效。
 */
function 解析端点(modelId = null) {
  const derived = identity.getEndpoints(modelId);
  return {
    responsesUrl: process.env.OPENCODE_RESPONSES_URL || derived.responsesUrl || OPENCODE_RESPONSES_URL,
    chatUrl: process.env.OPENCODE_CHAT_URL || derived.chatUrl || OPENCODE_CHAT_URL,
    modelsUrl: process.env.OPENCODE_MODELS_URL || derived.modelsUrl || OPENCODE_MODELS_URL,
  };
}

// 身份（user-agent、会话 id 格式、头集合）归 identity.js 所有，
// 它从 opencode 公开源码推导并惰性刷新 —— 按请求，绝不按定时器；
// `当前UA` 在同步时镜像它，供请求头直接使用。
let 当前UA = process.env.OPENCODE_USER_AGENT || identity.getUserAgent();

function 同步UA() {
  if (!process.env.OPENCODE_USER_AGENT) 当前UA = identity.getUserAgent();
  return 当前UA;
}

/**
 * 向 `url` 发推理请求，可选经配置的出口中继。中继契约
 * 与 9Router 的可部署中继一致：POST <relay>，
 * 带 `x-relay-target: <origin>` 与 `x-relay-path: <path>`，中继在该
 * origin 重放方法/头/体。origin 与路径不进 URL，
 * 所以部署在裸 workers.dev 主机名的中继无须改动即可
 * 工作。
 *
 * 请求体由调用方序列化一次、以字符串传入，每条重试路径
 * 都能重放它。
 *
 * 配置的出口代理作用于最终 fetch 的 URL，所以中继部署
 * 本身也能经代理拨出。
 *
 * `egressUrl` 钉住本次调用的出口。chat 处理器逐请求
 * 挑选一个出口并在各重试间复用，必须留在应答过的 IP
 * 上的重试就不会在会话中途悄悄换出口。没有它时，
 * 池逐调用挑选。
 */
function 上游抓取(url, init, egressUrl = null) {
  if (!UPSTREAM_RELAY_URL) return proxy.netFetch(url, init, egressUrl);
  const parsed = new URL(url);
  const headers = { ...(init.headers || {}) };
  headers["x-relay-target"] = parsed.origin;
  headers["x-relay-path"] = parsed.pathname + parsed.search;
  return proxy.netFetch(UPSTREAM_RELAY_URL, { ...init, headers }, egressUrl);
}

/**
 * 经选定的出口发请求；出口本身不可达时换池内下一条。
 *
 * 死代理不是上游拒绝：什么都没到达上游，换一条重试只花一次
 * 连接，而给客户端回 500 会整个浪费这次请求。
 * 池的存在正是为了吸收这种失败。
 *
 * 只有一个代理（或没有）时无处可转移，传输错误原样抛出
 * 交给调用方既有处理。
 */
async function 出口抓取(url, init, state) {
  try {
    const res = await 上游抓取(url, init, state.egressUrl);
    state.transportFailures = 0;
    return res;
  } catch (err) {
    const pool = proxy.describe().pool;
    const canFailover = pool && pool.active && pool.enabled > 1;
    if (!canFailover || !state.egressUrl) throw err;

    proxy.markFailure(state.egressUrl, { reason: `transport: ${err.message}`.slice(0, 200) });
    const next = proxy.pick({ exclude: state.egressUrl });
    if (!next.url || next.url === state.egressUrl) throw err;

    console.warn(
      `[fucking-opencode] 出口 ${
        proxy.displayHost(state.egressUrl) || "direct"
      } 不可达（${err.message}）；改经 ${proxy.displayHost(next.url) || "direct"} 重试`
    );
    state.egress = next;
    state.egressUrl = next.url;
    state.transportFailures = (state.transportFailures || 0) + 1;
    // 只跳一跳。所有条目都挂的池必须把错误浮出，而不是在
    // 一次客户端请求里走完整张清单。
    return 上游抓取(url, init, state.egressUrl);
  }
}

/**
 * 把拒绝记到产生它的出口头上。
 *
 * 空 URL 是 `direct` 池条目，它是真实出口，所以不能用真值
 * 判断：只有缺状态才表示"没东西可记"。
 */
function 记录出口失败(state, { reason, cooldownMs = null } = {}) {
  const url = state && state.egressUrl;
  if (url === null || url === undefined) return;
  const pool = proxy.describe().pool;
  if (!pool || !pool.active) return;
  proxy.markFailure(url, { reason, cooldownMs });
  可能轮换WARP出口(url, reason);
}

/**
 * 把当前出口记为失败并切到下一条健康出口，供同一次客户端请求重试。
 * 返回 false 表示没有可用的替代（无池、只剩一条、池全部冷却到同一条）。
 * 预算按请求计，避免一次请求把整池全部烧掉。
 */
function 换一条出口(state, { reason, cooldownMs = null } = {}) {
  if (!state) return false;
  const pool = proxy.describe().pool;
  if (!pool || !pool.active || pool.enabled <= 1) return false;
  const used = Number(state.egressSwaps) || 0;
  if (used >= 最大出口重试) return false;
  记录出口失败(state, { reason, cooldownMs });
  const next = proxy.pick({ exclude: state.egressUrl });
  if (!next || next.url === state.egressUrl) return false;
  state.egress = next;
  state.egressUrl = next.url;
  state.egressSwaps = used + 1;
  return true;
}

/**
 * Lane WARP yang kuotanya habis tidak akan pulih sendiri: alamat egress-nya
 * tetap sama. Jadi saat lane itu menolak (429/kuota/gate) atau tidak bisa
 * dial, minta farm mendaftarkan exit baru dan menukarnya di port yang sama.
 * Debounce 60 detik per lane supaya satu burst request tidak memicu enam
 * pendaftaran Cloudflare.
 */
function 可能轮换WARP出口(url, reason) {
  if (!url || !/^socks5:\/\//i.test(String(url))) return;
  const lanes = (warpFarm.状态() || {}).lanes || [];
  const lane = lanes.find((entry) => entry && entry.url === url);
  if (!lane) return;
  const 额度耗尽 = /429|quota|kuota|free.?tier|capacity|gate/i.test(String(reason || ""));
  const 传输失败 = /^transport:/i.test(String(reason || ""));
  if (!额度耗尽 && !传输失败) return;
  const now = Date.now();
  if (now - (WARP轮换间隔.get(lane.port) || 0) < 60000) return;
  WARP轮换间隔.set(lane.port, now);
  warpFarm
    .轮换(lane.port)
    .then((result) => {
      if (result && result.ok) {
        console.log(`[fucking-opencode] WARP farm lane ${lane.index} 轮换出口（${reason || "transport"}）`);
        记录事件(`WARP farm lane ${lane.index} 轮换出口：${reason || "transport"}`, "info");
      } else if (result && result.error) {
        console.warn(`[fucking-opencode] WARP farm lane ${lane.index} 轮换失败：${result.error}`);
      }
    })
    .catch(() => {});
}

function isValidV2UserAgent(ua) {
  const match = String(ua || "")
    .trim()
    .match(/^opencode\/[a-z0-9-]+\/(\d+)\.\d+\.\d+\/[a-z0-9-]+$/i);
  return Boolean(match) && parseInt(match[1], 10) >= 2;
}

/**
 * 免费档网关接受的 User-Agent，或身份层自己的。
 *
 * 实测（干净出口、带 `read` 工具）：不带 `User-Agent`、只带
 * 裸 `opencode`，或带 `Mozilla/5.0 …` / `curl/8.18.0`
 * 的请求被 403 FreeTierError 拒绝，与被封 IP 相同。只查形状，
 * `opencode/<channel>/<semver>/<name>` 形状即通过，且不查
 * 新鲜度（`opencode/9.9.9` 也被接受）。
 *
 * `OPENCODE_USER_AGENT` 是运维者覆盖，所以予以尊重 —— 但会
 * 上报网关会拒绝的覆盖，而不是悄悄产出一个看起来像
 * 额度问题的 403。
 */
function 网关安全UA() {
  const override = process.env.OPENCODE_USER_AGENT;
  if (override && /^opencode\/[A-Za-z0-9-]+\/\d+\.\d+\.\d+\/[A-Za-z0-9-]+$/i.test(String(override).trim())) {
    return String(override).trim();
  }
  if (override) {
    console.warn(
      "[fucking-opencode] OPENCODE_USER_AGENT 不符合免费档网关接受的形状 " +
        "（opencode/<channel>/<semver>/<name>）；改用推导出的身份"
    );
  }
  const derived = 同步UA();
  if (/^opencode\//i.test(derived)) return derived;
  // 最后手段：推导出的身份本身畸形。让请求保持 opencode
  // 客户端的形状，而不是发网关必拒的东西。
  return "opencode/latest/0.0.0/cli";
}

// --- ID 生成器（匹配 OpenCode v2 CLI 格式） ---
// 形状（charset、总长、倍率、前缀）来自 identity.js，它从
// opencode 自己的 `packages/schema/src/identifier.ts` 推导。
// 这里留个薄封装，既有调用点与测试继续工作。
function createId(descending, timestamp = Date.now()) {
  return identity.createId(descending, timestamp);
}

// 在线模型清单，启动时从上游发现，每小时刷新。
// 没有写死的兜底：空清单如实表示"上游还没应答"，
// 网关/harness 会应用自己的兜底，而不是被喂一份
// 过期的谎言。
let 在线模型表 = [];
let 缓存模型负载 = '{"object":"list","data":[]}';
let 上次发现时间 = 0;
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // Auto-refresh every 1 hour
// 单飞：TTL 过期后并发的 /v1/models 命中共享一次上游抓取，而不是蜂拥
// （50 个并行 GET = 1 次上游调用，不是 50 次）。
let 发现进行中 = null;
// CLI 版本 feed 慢（5s 超时）且少变：缓存 6 小时，与模型发现并行
// 刷新，模型发现绝不等它。
let 上次CLI版本检查时间 = 0;
const CLI_VERSION_TTL_MS = 6 * 60 * 60 * 1000;

function 重建发现负载() {
  缓存模型负载 = JSON.stringify({ object: "list", data: 在线模型表 });
}
重建发现负载();

function 是本机来源(origin) {
  if (typeof origin !== "string" || !origin) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin.trim());
}

const LOOPBACK_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;

/** 从 `Host` 头取出主机名，去掉端口；IPv6 字面量不保留方括号。 */
function 主机名之(hostHeader) {
  const raw = String(hostHeader || "").trim();
  if (!raw) return "";
  const v6 = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (v6) return v6[1];
  return raw.replace(/:\d+$/, "");
}

/**
 * 管理面门禁：面板与 `/api/proxy` 能改变每个出站请求的去向，
 * 所以绝不能让外域页面或 rebinding DNS 名触达它们。
 *
 * 本桥是本地工具，无认证。这里相关的浏览器攻击有两种：
 *
 *   - CSRF: 运维者访问的任何页面都能 POST 到 127.0.0.1，把出口指到攻击者的
 *     代理。表单 POST 设不了 `Content-Type: application/json`，
 *     所以要求它就排除了简单请求；其余由下面的 Origin/Sec-Fetch-Site 检查覆盖。
 *   - DNS rebinding: 解析到 127.0.0.1 的攻击者域名会让浏览器发
 *     `Host: evil.example`，仅回环的监听器本来会接受它。
 *
 * 非通配绑定地址自动允许，`HOST=192.168.1.5` 保持自己的面板可用。
 */
function 允许的管理主机() {
  const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
  for (const extra of String(process.env.PANEL_ALLOWED_HOSTS || "").split(",")) {
    const trimmed = extra.trim().toLowerCase();
    if (trimmed) hosts.add(trimmed);
  }
  const bound = String(HOST || "").toLowerCase();
  const wildcard = !bound || bound === "0.0.0.0" || bound === "::" || bound === "[::]";
  if (!wildcard) hosts.add(bound);
  if (wildcard) {
    // 通配绑定通常经本机自己的地址到达（LAN IP、VPS 公网 IP）。这些
    // 可以安全接受，让 `HOST=0.0.0.0` 免配置可用；rebound 攻击者域名
    // 仍不在此集合。域名进 PANEL_ALLOWED_HOSTS。
    const os = require("os");
    for (const list of Object.values(os.networkInterfaces())) {
      for (const addr of list || []) {
        if (addr && addr.address) hosts.add(String(addr.address).toLowerCase());
      }
    }
  }
  return hosts;
}

function adminRequestError(req) {
  const host = 主机名之(req.headers?.host).toLowerCase();
  if (!host) return "Header Host wajib ada.";
  if (!允许的管理主机().has(host)) {
    return `Host ${host} tidak diizinkan. Panel hanya menerima host lokal; tambahkan ke PANEL_ALLOWED_HOSTS bila ini memang disengaja.`;
  }

  const site = String(req.headers?.["sec-fetch-site"] || "").toLowerCase();
  if (site === "cross-site") {
    return "Permintaan lintas-situs ditolak. Buka panel langsung dari host ini.";
  }

  // Origin 必须匹配本请求发往的 Host（覆盖面板本身，以及保持浏览器
  // origin 不变的 SSH/隧道转发），或在 CORS_ORIGIN 里显式白名单。
  // 127.0.0.1 之外的回环 origin（如 ::1）不自动信任。
  // *不同* 端口是另一个本地服务，不是本面板，所以不信任。
  const origin = String(req.headers?.origin || "").trim();
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return `Origin ${origin} tidak valid.`;
    }
    const configured = String(CORS_ORIGIN || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (originHost !== host && !configured.includes(origin)) {
      return `Origin ${origin} tidak diizinkan.`;
    }
  }
  return null;
}


// ---- 面板会话（无状态签名 cookie） ----
// 令牌 = "<过期毫秒>.<jti>.<HMAC-SHA256>"，密钥由持久 secret 文件与当前密码派生；
// 因此重启后旧 cookie 依然有效，但改密码会立即使全部旧会话失效。
let 面板会话密钥缓存 = null;

function 面板会话密钥文件() {
  return require("path").join(备份状态目录(), "panel-session-secret");
}

function 面板会话密钥() {
  const file = 面板会话密钥文件();
  const fs = require("fs");
  if (!面板会话密钥缓存) {
    let secret = "";
    try {
      secret = fs.readFileSync(file, "utf8").trim();
    } catch {}
    if (!/^[0-9a-f]{64}$/.test(secret)) {
      secret = crypto.randomBytes(32).toString("hex");
      try {
        fs.mkdirSync(require("path").dirname(file), { recursive: true });
        fs.writeFileSync(file, secret + "\n", { mode: 0o600 });
        try {
          fs.chmodSync(file, 0o600);
        } catch {}
      } catch {}
    }
    面板会话密钥缓存 = secret;
  }
  return crypto.createHash("sha256").update(`${面板会话密钥缓存}|${panelPassword() || ""}`).digest();
}

function 面板会话签名(expires, jti = "") {
  return crypto.createHmac("sha256", 面板会话密钥()).update(`${expires}.${jti}`).digest("hex");
}

// 注销需要服务端吊销：无状态令牌本身不可撤销，因此把已注销的 jti 记到
// <状态目录>/panel-revocations.json，重启后仍然生效，过期条目自动清理。
let 面板撤销集 = null;

function 面板撤销文件() {
  return require("path").join(备份状态目录(), "panel-revocations.json");
}

function 面板撤销数据() {
  if (面板撤销集) return 面板撤销集;
  const map = new Map();
  try {
    const data = JSON.parse(require("fs").readFileSync(面板撤销文件(), "utf8"));
    for (const [jti, exp] of Object.entries(data || {})) {
      const n = Number(exp);
      if (Number.isFinite(n) && n > Date.now()) map.set(jti, n);
    }
  } catch {}
  面板撤销集 = map;
  return map;
}

function 保存面板撤销() {
  const map = 面板撤销数据();
  const now = Date.now();
  for (const [jti, exp] of map) if (!(exp > now)) map.delete(jti);
  try {
    const fs = require("fs");
    const file = 面板撤销文件();
    fs.mkdirSync(require("path").dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
  } catch {}
}

/** 解析并验证令牌；有效时返回 { expires, jti }，否则 null。 */
function 解析面板令牌(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [expiresRaw, jti, sig] = parts;
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires <= Date.now()) return null;
  if (!/^[0-9a-f]{32}$/.test(jti)) return null;
  if (!timingSafeEqualStr(面板会话签名(expires, jti), sig)) return null;
  if (面板撤销数据().has(jti)) return null;
  return { expires, jti };
}

/** 删除持久 secret：轮换后所有已签发 cookie 立即失效。 */
function 重置面板会话密钥() {
  面板会话密钥缓存 = null;
  try {
    require("fs").rmSync(面板会话密钥文件(), { force: true });
  } catch {}
}

function panelCookie(req) {
  const raw = String(req.headers?.cookie || "");
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === PANEL_SESSION_COOKIE) return part.slice(idx + 1).trim();
  }
  return "";
}
function panelAuthorized(req) {
  if (!panelPassword()) return true;
  return 解析面板令牌(panelCookie(req)) !== null;
}
function panelSetCookie(res) {
  const expires = Date.now() + PANEL_SESSION_TTL_MS;
  const jti = crypto.randomBytes(16).toString("hex");
  const token = `${expires}.${jti}.${面板会话签名(expires, jti)}`;
  res.setHeader(
    "Set-Cookie",
    `${PANEL_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(PANEL_SESSION_TTL_MS / 1000)}`
  );
}
function panelClearCookie(req, res) {
  // 吊销当前令牌（其他设备/浏览器不受影响）；改密码会轮换 secret 吊销全部。
  const parsed = 解析面板令牌(panelCookie(req));
  if (parsed) {
    面板撤销数据().set(parsed.jti, parsed.expires);
    保存面板撤销();
  }
  res.setHeader("Set-Cookie", `${PANEL_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}
function panelUnauthorized(res) {
  res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: "Panel login required." }));
}
function panelLoginThrottled(ip) {
  const rec = panelLoginFailures.get(ip);
  if (!rec) return false;
  if (rec.until < Date.now()) {
    panelLoginFailures.delete(ip);
    return false;
  }
  return rec.count >= 10;
}
function panelNoteFailure(ip) {
  const now = Date.now();
  const rec = panelLoginFailures.get(ip);
  if (!rec || rec.until < now) {
    panelLoginFailures.set(ip, { count: 1, until: now + 10 * 60 * 1000 });
    return;
  }
  rec.count += 1;
  rec.until = now + 10 * 60 * 1000;
}

/**
 * 为期待旧名的调用点与测试保留。查询握手，并从 opencode 源码推导配方其余部分。
 *
 * 这是一次*轮询*：绕过身份新鲜度门，让发行版检查按自己的节奏走；
 * 但采纳仍遵循 UPDATE_MODE。反应模式下，网关未动的发行版只记录
 * （由 /health 的 `identity.available` 报告）而不采纳 —— 在这里强采纳
 * 会把 `reactive` 每 6 小时悄悄变成 `always`。
 *
 * `上次CLI版本检查时间` 门保证握手至多每 CLI_VERSION_TTL_MS 读一次，
 * 即使被反复调用。
 */
async function 刷新CLI版本() {
  const now = Date.now();
  if (now - 上次CLI版本检查时间 < CLI_VERSION_TTL_MS) {
    return { updated: false, reason: "fresh" };
  }
  const result = await identity.refresh({ recheck: true });
  同步UA();
  上次CLI版本检查时间 = now;
  return result;
}

// 从 OpenCode 上游网关自动发现。
// 单飞：并发调用者共享一次进行中的抓取。
// CLI 版本 feed 并行刷新（发射后不管），feed 慢不拖模型发现。
// 5 秒的 feed 绝不会拖慢模型清单。
async function discoverModels() {
  if (发现进行中) return 发现进行中;
  发现进行中 = (async () => {
    刷新CLI版本().catch(() => {});
    检查并应用更新().catch(() => {});
    try {
    const res = await proxy.netFetch(解析端点().modelsUrl, {
      headers: {
        "Authorization": "Bearer public",
        "User-Agent": 当前UA,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const items = json.data || [];

    // 供应商目录决定什么免费 —— CLI 启动读的就是这份文件，其
    // `cost`/`status` 字段是套餐事实。网关 /models 清单只补充目录没
    // 描述的模型（几个评测条目），因为名字不是价格：目录标记
    // deprecated 的 `-free` 模型必须退出，目录标记 free 的模型
    // 在 /models 缺席也必须保留。
    const ownedBy = new Map(items.map((i) => [String(i.id || "").toLowerCase(), i]));
    const kept = [];
    const seen = new Set();
    const keep = (id) => {
      const lower = String(id).toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);
      kept.push(id);
    };

    for (const id of identity.getFreeModels()) keep(id);
    // 目录加载后这个循环今天一个都不加：/models 给的每个 id 要么被目录
    // 描述过（已裁定）要么是评测条目。它为首次读目录前的窗口而存在，
    // 那时名字是唯一信号 —— 诚实说"还没数据"的桥，好过猜了
    // 再在下一次刷新里自我纠正的桥；启动头几秒用空清单
    // 应答 /v1/models 更糟。
    for (const item of items) {
      const id = String(item.id || "");
      const lower = id.toLowerCase();
      if (lower.startsWith("jev-")) continue; // systemone 评测模型
      const verdict = identity.getCatalogVerdict(lower);
      if (verdict) continue; // 目录已裁定该 id
      if (!lower.endsWith("-free") && !lower.includes("-contributor") && lower !== "big-pickle") continue;
      keep(id);
    }

    const freeItems = kept.map((id) => ({
      id,
      object: "model",
      owned_by: ownedBy.get(String(id).toLowerCase())?.owned_by || "opencode",
    }));

    if (freeItems.length > 0) {
      在线模型表 = freeItems;
      重建发现负载();
      上次发现时间 = Date.now();
      console.log(`[fucking-opencode] 从上游网关自动发现 ${在线模型表.length} 个免费模型。`);
      return;
    }
    } catch (err) {
      console.warn(`[fucking-opencode] 自动发现警告：${err.message}。上游应答前模型清单保持为空。`);
    }
  })();
  try {
    return await 发现进行中;
  } finally {
    发现进行中 = null;
  }
}

function normalizeModel(rawModel) {
  if (typeof rawModel !== "string") return "";
  const stripped = rawModel.trim().replace(/^(opencode\/|oc\/|zen\/|9router\/|openai\/)/i, "").trim();
  if (!stripped) return "";
  // 已是真实模型 id 的名字原样放行；只解析简写。先查目录家族，退役修订
  // 仍解析到活的兄弟模型而无须发新版桥；下面的静态表只服务目录
  // 不分组的名字（以及目录还没读到的情形）。
  const lower = stripped.toLowerCase();
  const verdict = identity.getCatalogVerdict(lower);
  // 本桥仅免费档：发 `Authorization: Bearer public`，无法认证付费请求。
  // 付费 id 只会在上游挣来 401/402，所以不放行 —— 指向付费的别名
  // 允许落到免费兄弟模型上。
  if (verdict === "free") return stripped;
  const derived = identity.resolveModelAlias(lower);
  if (derived) return derived;
  // 背后没有静态表。简写要么从目录自己的 `family` 字段推导，
  // 要么作为字面模型 id 放行。别的都是本桥发明的名字，而发明的名字
  // 可能比它指向的模型活得久。
  return stripped;
}

// 协议路由：哪些模型要走 /responses 而不是 /chat/completions。
//
// 随发行版默认刻意为空。曾播种两个 `muse-spark` id，如今目录都标记
// deprecated，还有一个 `includes("muse")` 兜底 —— 针对已不存在
// 的模型家族的名字规则。每个在线免费模型都走 chat 通道（目录：
// `@ai-sdk/openai-compatible`），需要另一通道的模型从上游自己的
// `ModelProtocolUnsupported` 应答，这是事实而非猜测。
// 上游只发 Responses 时，`RESPONSES_MODELS` 仍会播种该集合。
const responsesModelSet = new Set(
  (process.env.RESPONSES_MODELS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const 对话模型集合 = new Set();

function isResponsesModel(modelId) {
  const lower = String(modelId || "").trim().toLowerCase();
  if (!lower) return false;
  if (对话模型集合.has(lower)) return false;
  if (responsesModelSet.has(lower)) return true;
  return false;
}

/** 测试钩子：忘记已学习的通道分配（它们本来会持久保存）。 */
function __resetProtocolLanes() {
  对话模型集合.clear();
  responsesModelSet.clear();
  for (const m of (process.env.RESPONSES_MODELS || "").split(",")) {
    const id = m.trim().toLowerCase();
    if (id) responsesModelSet.add(id);
  }
}

function markProtocolSupport(modelId, useResponses) {
  const lower = String(modelId || "").trim().toLowerCase();
  if (!lower) return;
  if (useResponses) {
    responsesModelSet.add(lower);
    对话模型集合.delete(lower);
  } else {
    对话模型集合.add(lower);
    responsesModelSet.delete(lower);
  }
}

// --- 工具指纹（动态） ---------------------------------------------------
//
// 上游 /inference/v1 校验请求体里的 `tools` 数组，这一层是变动最
// 频繁的：起初数组必须存在，后来必须含特定工具名，再后来
// （9router#4837）精确到 schema。把这些定义写死意味着每次上游改动
// 都要改代码。
//
// 定义现在来自 identity.js，它在更新握手点名的发行版 commit SHA 处推导：
//   1. source        — 该不可变 commit 上的 `read.ts` / `shell.ts`
//   2. DEFAULT_TOOLS — 随发行版兜底，直到源码读取成功前使用
//
// 下面的名字保留给早于该改动的调用点与测试；它们从实时 profile
// 读取，不在加载时冻结。
function 取指纹名(scope = null, modelId = null) {
  // 只留真正发往上游的名字。抓包带约 10 个工具，但发额外指纹会让
  // `TOOL_PROFILE_SCOPE=core` 只发子集；把未发送的工具当作
  // 无关的客户端工具被改名（`glob` → `glob_client`），毫无理由。
  // 模型也有影响：发行版对 GPT 系用 `patch` 换 `edit`+`write`。
  // `patch` 用于 GPT 模型，所以指纹集合遵循同一规则。
  return identity.getToolList(false, scope, modelId).map((t) => t.function.name);
}

function 取指纹定义() {
  return identity.getTools();
}

function 取规范工具(flat, scope = null, modelId = null) {
  return identity.getToolList(flat, scope, modelId);
}

/**
 * 供 schema 比较的稳定 JSON。键序不得影响相等性：只差属性顺序的
 * 两个定义是同一个 schema。
 */
function 稳定序列化(val) {
  if (!val || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return "[" + val.map(稳定序列化).join(",") + "]";
  const keys = Object.keys(val).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + 稳定序列化(val[k])).join(",") + "}";
}

const EMPTY_MAP = Object.freeze(new Map());
const paramSigCache = new WeakMap();
function 取参数签名(params) {
  if (!params || typeof params !== "object") return 稳定序列化(params);
  let sig = paramSigCache.get(params);
  if (sig === undefined) {
    sig = 稳定序列化(params);
    paramSigCache.set(params, sig);
  }
  return sig;
}

function 构建限流头(freeTierMsg, diagnostic = null) {
  if (!freeTierMsg) return { "Content-Type": "application/json" };
  const retryAfterSec = Math.max(1, Math.ceil((GATE_RETRY_COOLDOWN_MS || 30000) / 1000));
  const headers = {
    "Content-Type": "application/json",
    "Retry-After": String(retryAfterSec),
    // `shape-ok` 表示请求携带了网关检查的每一个锚点，所以
    // 拒绝是关于这个出口的。`shape-rejected` 表示本桥产出了网关拒绝
    // 的请求 —— 是桥的 bug，上游错误逐字节相同。对它告警的调用方
    // 能区分两者。
    "X-OpenCode-Gate": diagnostic && diagnostic.shapeOk === false ? "shape-rejected" : "ip-throttled",
  };
  if (diagnostic && diagnostic.logId) headers["X-OpenCode-Log-Id"] = diagnostic.logId;
  return headers;
}

function 解析限流状态(upstreamStatus, freeTierMsg) {
  if (freeTierMsg && process.env.IP_LIMIT_STATUS === "429") return 429;
  return upstreamStatus;
}

/**
 * 这个客户端提供的工具是否已与我们要注入的指纹逐字节相同？
 * 相同则原样放行。
 */
function 是精确指纹定义(tool, key) {
  const want = identity.getTools()[key];
  if (!want || !tool || typeof tool !== "object") return false;
  const def = tool.function && typeof tool.function === "object" ? tool.function : tool;
  return (
    def.description === want.description &&
    取参数签名(def.parameters) === 取参数签名(want.parameters)
  );
}

function 构建占位说明(appendedNames) {
  if (!Array.isArray(appendedNames) || appendedNames.length === 0) return "";
  const list = appendedNames.map((n) => `\`${n}\``).join(" or ");
  return appendedNames.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
}

function 取工具名(tool) {
  if (!tool || typeof tool !== "object") return "";
  if (typeof tool.name === "string") return tool.name.trim();
  if (tool.function && typeof tool.function.name === "string") return tool.function.name.trim();
  return "";
}

// 仅仅是名字就会让上游回 429 FreeUsageLimitError 的客户端工具。
// 2026-11-03 对线上网关实测，其余全过的请求里：叫 `run_code` 的
// 工具被拒，同一 schema 换个名字就过。拒绝消息带的是配额措辞，
// `run-code`、`runcode`、`run_program` 或 `code_exec` 都答 200，
// `run_code_client` 也被拒，所以匹配的是子串。
// 看起来像额度耗尽；它其实是名字过滤器。`prepareToolsWithFingerprint`
// 出站改名、回程恢复客户端的名字。
const BLOCKED_TOOL_NAME_PATTERNS = [/run_code/i];
const BLOCKED_TOOL_ALIAS = "run_program";

function 是屏蔽工具名(name) {
  return BLOCKED_TOOL_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * 把客户端工具与网关要求的指纹工具合并。
 *
 * 每个必需工具有三种情形：
 *   - 客户端已原样发送 → 保留客户端的那一份
 *   - 客户端用同名但不同 schema 发送 → 把客户端的副本改名为
 *     `read_client`，让两者共存，并在响应里映射回去
 *   - 客户端完全没发送 → 追加指纹定义
 *
 * 定义逐调用从 identity.js 解析，配置更新在下一个请求生效，无须重启。
 */
function prepareToolsWithFingerprint(clientTools = [], flat = false, scope = null, modelId = null) {
  const fingerprintNames = 取指纹名(scope, modelId);
  const canonical = 取规范工具(flat, scope, modelId);
  const canonicalByName = new Map(
    canonical.map((t) => [flat ? t.name : t.function.name, t])
  );

  if (!Array.isArray(clientTools) || clientTools.length === 0) {
    return {
      tools: canonical,
      appended: fingerprintNames,
      placeholderNote: 构建占位说明(fingerprintNames),
      aliasToOriginal: EMPTY_MAP,
      originalToAlias: EMPTY_MAP,
    };
  }

  const aliasToOriginal = new Map();
  const originalToAlias = new Map();
  const normalized = [];
  const takenNames = new Set(clientTools.map(取工具名).filter(Boolean));
  const presentExactFingerprints = new Set();

  for (const t of clientTools) {
    const name = 取工具名(t);
    if (!name) continue;
    const def = t.function && typeof t.function === "object" ? t.function : t;
    const description = def.description || "";
    const parameters = def.parameters || { type: "object", properties: {} };

    if (是屏蔽工具名(name)) {
      let alias = BLOCKED_TOOL_ALIAS;
      for (let i = 2; takenNames.has(alias); i++) {
        alias = `${BLOCKED_TOOL_ALIAS}${i}`;
      }
      takenNames.add(alias);
      aliasToOriginal.set(alias, name);
      originalToAlias.set(name, alias);
      normalized.push(
        flat
          ? { type: "function", name: alias, description, parameters }
          : { type: "function", function: { name: alias, description, parameters } }
      );
      continue;
    }

    if (fingerprintNames.includes(name)) {
      if (presentExactFingerprints.has(name)) continue;
      if (是精确指纹定义(t, name)) {
        presentExactFingerprints.add(name);
        normalized.push(
          flat
            ? { type: "function", name, description, parameters, strict: false }
            : { type: "function", function: { name, description, parameters } }
        );
        continue;
      }
      // 客户端在网关指纹的名字下定义了自己的工具：做别名，
      // 精确指纹仍能并列注入。
      if (originalToAlias.has(name)) continue;
      let alias = `${name}_client`;
      for (let i = 2; takenNames.has(alias); i++) {
        alias = `${name}_client${i}`;
      }
      takenNames.add(alias);
      aliasToOriginal.set(alias, name);
      originalToAlias.set(name, alias);
      normalized.push(
        flat
          ? { type: "function", name: alias, description, parameters }
          : { type: "function", function: { name: alias, description, parameters } }
      );
      continue;
    }

    normalized.push(
      flat
        ? { type: "function", name, description, parameters }
        : { type: "function", function: { name, description, parameters } }
    );
  }

  const appended = [];
  for (const name of fingerprintNames) {
    if (presentExactFingerprints.has(name)) continue;
    const def = canonicalByName.get(name);
    if (!def) continue;
    normalized.push(def);
    appended.push(name);
  }

  return {
    tools: normalized,
    appended,
    placeholderNote:
      appended.length === fingerprintNames.length
        ? 构建占位说明(fingerprintNames)
        : 构建占位说明(appended),
    aliasToOriginal,
    originalToAlias,
  };
}

function 准备Responses工具(clientTools = [], modelId = null) {
  return prepareToolsWithFingerprint(clientTools, true, null, modelId).tools;
}

function 准备对话工具(clientTools = [], modelId = null) {
  return prepareToolsWithFingerprint(clientTools, false, null, modelId).tools;
}

function restoreClientToolName(name, aliasToOriginal) {
  if (!name || !aliasToOriginal || aliasToOriginal.size === 0) return name;
  return aliasToOriginal.get(name) || name;
}

function 提取内容(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p?.type === "text" && typeof p.text === "string") return p.text;
        if (p?.text) return String(p.text);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content ? JSON.stringify(content) : "";
}

// 取前 N 字符而不序列化整个值：字符串直接切片，数组只拼到上限为止
// 的文本部分，对象退化为有界 stringify。用于无头会话签名，
// 数 MB 的系统提示绝不为了一个哈希就被 JSON.stringify。
function 短文本(content, limit = 1000) {
  if (typeof content === "string") return content.slice(0, limit);
  if (Array.isArray(content)) {
    let out = "";
    for (const p of content) {
      if (out.length >= limit) break;
      if (typeof p === "string") out += p;
      else if (p?.type === "text" && typeof p.text === "string") out += p.text;
      else if (p?.text) out += String(p.text);
    }
    return out.slice(0, limit);
  }
  if (!content) return "";
  try {
    return JSON.stringify(content).slice(0, limit);
  } catch {
    return String(content).slice(0, limit);
  }
}

function 消息签名样本(content, limit = 1000) {
  if (typeof content === "string") {
    const len = content.length;
    if (len <= limit) return `${len}:${content}`;
    const half = Math.floor(limit / 2);
    return `${len}:${content.slice(0, half)}..${content.slice(len - half)}`;
  }
  if (Array.isArray(content)) {
    const head = 短文本(content, Math.floor(limit / 2));
    const last = content[content.length - 1];
    const tail = 短文本(last ? [last] : [], Math.floor(limit / 2));
    return `${content.length}:${head}..${tail}`;
  }
  return 短文本(content, limit);
}

function 变换Responses内容(content, role = "user") {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const hasNonText = content.some(
      (p) =>
        p &&
        typeof p === "object" &&
        (p.type === "image_url" || p.type === "input_image" || p.type === "input_file")
    );
    if (!hasNonText) return 提取内容(content);
    const textType = role === "assistant" ? "output_text" : "input_text";
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") {
        parts.push({ type: textType, text: p });
      } else if (p && typeof p === "object") {
        if (p.type === "text" || p.type === "input_text" || p.type === "output_text") {
          parts.push({ type: textType, text: String(p.text ?? "") });
        } else if (p.type === "image_url") {
          const imageUrl = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
          if (imageUrl) parts.push({ type: "input_image", image_url: imageUrl });
        } else if (p.type === "input_image" || p.type === "input_file") {
          parts.push(p);
        } else if (p.text) {
          parts.push({ type: textType, text: String(p.text) });
        }
      }
    }
    return parts;
  }
  return 提取内容(content);
}

// 把 OpenAI 消息转成 OpenCode 输入格式（供 Responses API）
function 变换为Responses输入(messages = [], originalToAlias = null) {
  const input = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    if (m.role === "system" || m.role === "developer") {
      continue;
    }
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id || "call_unknown",
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      });
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      if (m.content) {
        input.push({
          role: "assistant",
          content: 变换Responses内容(m.content, "assistant"),
        });
      }
      for (const tc of m.tool_calls) {
        const fn = tc.function || {};
        const rawName = fn.name || "unknown";
        const mappedName =
          originalToAlias && originalToAlias.has(rawName) ? originalToAlias.get(rawName) : rawName;
        input.push({
          type: "function_call",
          call_id: tc.id || `call_${crypto.randomBytes(8).toString("hex")}`,
          name: mappedName,
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
        });
      }
      continue;
    }
    const role = m.role || "user";
    input.push({ role, content: 变换Responses内容(m.content, role) });
  }
  return input;
}

/**
 * 真 CLI 附在每个系统提示后的 harness 环境块。
 *
 * 2026-10-25 对线上网关实测：系统提示不含该块的请求得到
 * `429 FreeUsageLimitError`，与额度耗尽的消息逐字节相同。
 * 触发条件是带 `Working directory:` 行的 `<env>` 块，不是提示长度
 * 也不是模型：12 KB 通用提示被拒，65 字节的块让 big-pickle 与
 * `<env>Working directory: /tmp</env>` 通过，同样的分界也适用于
 * mimo。形态问题曾被当成配额问题 —— 同一分钟里
 * CLI 能答而桥不能。
 *
 * CLI 用它自己的会话上下文构造此块，这里给的是桥的如实等价物：
 * 它的工作目录以及该目录是否为 git 仓库。复现这个块正是让桥的
 * 请求在该网关上与 CLI 无法区分的关键。
 *
 * 按工作目录缓存：进程运行期间这些值不会变，实测 2.5 ms，
 * （网关从不 chdir），而探测它们要花一个 `git` 子进程 ——
 * 对每个请求都是真金白银。
 */
let 环境块缓存 = { cwd: null, block: "" };
function 构建环境块() {
  const cwd = process.cwd();
  if (环境块缓存.cwd === cwd && 环境块缓存.block) {
    return 环境块缓存.block;
  }
  let isRepo = "no";
  try {
    const { execFileSync } = require("child_process");
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    isRepo = "yes";
  } catch {}
  const block = [
    // 下一行是 harness 锚点（网关检查其存在），逐字节保留英文
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${cwd}`,
    `  Workspace root folder: ${cwd}`,
    `  Is directory a git repo: ${isRepo}`,
    "  Platform: " + process.platform,
    "</env>",
  ].join("\n");
  环境块缓存 = { cwd, block };
  return block;
}
/**
 * 把 harness 环境块附到系统提示，除非客户端已带。
 * 转发 CLI 自身提示的客户端（或任何带该块的提示）保留原样；
 * `<env>` 块）逐字节保留 —— 只补上缺失的锚点。
 */
function 带环境块(systemText) {
  const text = typeof systemText === "string" ? systemText : "";
  if (/<env>[\s\S]*?Working directory:/.test(text)) return text;
  const block = 构建环境块();
  return text.trim() ? `${text.replace(/\s+$/, "")}\n\n${block}` : block;
}
function 提取系统指令(messages = [], explicitInstructions = "", placeholderNote = "") {
  const parts = [];
  if (typeof explicitInstructions === "string" && explicitInstructions.trim()) {
    parts.push(explicitInstructions.trim());
  }
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || (m.role !== "system" && m.role !== "developer")) continue;
    const text = 提取内容(m.content).trim();
    if (text) parts.push(text);
  }
  if (placeholderNote) {
    parts.push(placeholderNote);
  }
  return 带环境块(parts.join("\n\n"));
}

function 变换对话消息(messages = [], originalToAlias = null, placeholderNote = "") {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    if (
      originalToAlias &&
      originalToAlias.size > 0 &&
      m.role === "assistant" &&
      Array.isArray(m.tool_calls)
    ) {
      out.push({
        ...m,
        tool_calls: m.tool_calls.map((tc) => {
          const fnName = tc?.function?.name;
          if (fnName && originalToAlias.has(fnName)) {
            return { ...tc, function: { ...tc.function, name: originalToAlias.get(fnName) } };
          }
          return tc;
        }),
      });
    } else {
      out.push(m);
    }
  }

  if (placeholderNote) {
    const first = out[0];
    if (first?.role === "system" || first?.role === "developer") {
      if (typeof first.content === "string") {
        out[0] = { ...first, content: `${first.content}\n\n${placeholderNote}` };
      } else if (Array.isArray(first.content)) {
        out[0] = { ...first, content: [...first.content, { type: "text", text: `\n\n${placeholderNote}` }] };
      } else {
        out.unshift({ role: "system", content: placeholderNote });
      }
    } else {
      out.unshift({ role: "system", content: placeholderNote });
    }
  }

  // 网关对系统提示缺 harness `<env>` 块的请求，回与额度耗尽相同
  // 的 `429 FreeUsageLimitError`。见 构建环境块。已转发 CLI 提示的
  // 客户端保留自己的块；只补缺失的锚点。
  const sysIndex = out.findIndex((m) => m?.role === "system" || m?.role === "developer");
  if (sysIndex === -1) {
    out.unshift({ role: "system", content: 构建环境块() });
  } else {
    const sys = out[sysIndex];
    if (typeof sys.content === "string") {
      out[sysIndex] = { ...sys, content: 带环境块(sys.content) };
    } else if (Array.isArray(sys.content)) {
      const text = 提取内容(sys.content);
      if (!/<env>[\s\S]*?Working directory:/.test(text)) {
        out[sysIndex] = {
          ...sys,
          content: [...sys.content, { type: "text", text: `\n\n${构建环境块()}` }],
        };
      }
    } else {
      out[sysIndex] = { ...sys, content: 构建环境块() };
    }
  }
  return out;
}

function buildUpstreamPayload(body, targetModel, useResponses, scope = null) {
  const requestedTokens =
    body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
  const maxTokens = effectiveMaxTokens(requestedTokens, targetModel, body);
  const { tools, placeholderNote, aliasToOriginal, originalToAlias } = prepareToolsWithFingerprint(
    body.tools,
    useResponses,
    scope,
    targetModel
  );
  if (useResponses) {
    const upstreamBody = {
      model: targetModel,
      input: 变换为Responses输入(body.messages, originalToAlias),
      stream: true,
      max_output_tokens: maxTokens,
      tools,
      tool_choice: "auto",
    };
    const instructions = 提取系统指令(
      body.messages,
      body.instructions,
      placeholderNote
    );
    if (instructions) {
      upstreamBody.instructions = instructions;
    }
    if (typeof body.temperature === "number") upstreamBody.temperature = body.temperature;
    if (typeof body.top_p === "number") upstreamBody.top_p = body.top_p;
    return { upstreamBody, aliasToOriginal };
  }

  // 字段名与顺序对齐 CLI 自己的请求：`max_completion_tokens`
  // （不是旧的 `max_tokens`）、`store: false`，且 `tools` 在 `stream` 之前。
  // 上游今天两种拼写都收，但发 CLI 的精确形状消除一个
  // 零成本可消除的差异。
  const upstreamBody = {
    model: targetModel,
    messages: 变换对话消息(body.messages, originalToAlias, placeholderNote),
    tools,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: maxTokens,
    store: false,
  };
  if (typeof body.temperature === "number") upstreamBody.temperature = body.temperature;
  if (typeof body.top_p === "number") upstreamBody.top_p = body.top_p;
  if (body.stop !== undefined) upstreamBody.stop = body.stop;
  if (body.response_format !== undefined) upstreamBody.response_format = body.response_format;
  if (body.reasoning_effort !== undefined) upstreamBody.reasoning_effort = body.reasoning_effort;
  else {
    const 强度 = 推理强度(targetModel);
    if (强度) upstreamBody.reasoning_effort = 强度;
  }

  // 上游 v2 对 tool_choice: "none" 回 403 FreeTierError。
  if (body.tool_choice && body.tool_choice !== "none") {
    if (
      typeof body.tool_choice === "object" &&
      body.tool_choice.function?.name &&
      originalToAlias.has(body.tool_choice.function.name)
    ) {
      upstreamBody.tool_choice = {
        ...body.tool_choice,
        function: {
          ...body.tool_choice.function,
          name: originalToAlias.get(body.tool_choice.function.name),
        },
      };
    } else {
      upstreamBody.tool_choice = body.tool_choice;
    }
  }

  return { upstreamBody, aliasToOriginal };
}

/**
 * 身份变更后铸造新会话 id。
 *
 * id 从配方推导，刷新*前*铸的 id 编码的正是网关刚拒绝的形状。
 * 自愈路径因此必须替换它 —— 重放过期 id 会发出同样的被拒请求、
 * 同样失败。缓存条目同理丢弃：否则该客户端的下一个请求
 * 会拿回过期 id。
 */
function 重造会话标识(req, body, staleId) {
  for (const [key, entry] of sessionCache) {
    if (entry.sessionId === staleId) sessionCache.delete(key);
  }
  return getPersistentSessionId(req, body);
}

/**
 * CLI 在此 checkout 里会发送的项目 id。
 *
 * 对真 CLI 抓包实测：该头等于 git remote 的主机名/路径，
 * `sha1("git-remote:github.com/<owner>/<repo>")` —— remote URL 去掉
 * 协议、去掉 `.git`。无 remote 时 CLI 哈希目录路径；显式头覆盖两者。
 * （`sha1("directory:<abs path>")`），而目录里的 `opencode` 文件
 * 推导一次并缓存：checkout 不会移动。
 */
let 缓存项目标识 = null;
function 取项目标识() {
  if (缓存项目标识) return 缓存项目标识;
  try {
    const fs = require("fs");
    const path = require("path");
    const crypto = require("crypto");
    const cwd = process.cwd();

    // `opencode` 文件优先，与 CLI 中完全一致。
    const marker = path.join(cwd, "opencode");
    if (fs.existsSync(marker)) {
      const value = fs.readFileSync(marker, "utf8").trim();
      if (value) return (缓存项目标识 = value);
    }

    // git remote，按 CLI 的 `url()` helper 的方式规范化。
    let remote = "";
    try {
      const { execFileSync } = require("child_process");
      remote = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      }).trim();
    } catch {}
    if (remote) {
      const normalized = remote
        .replace(/^[a-z]+:\/\//i, "")   // 去掉 scheme
        .replace(/^git@([^:]+):/i, "$1/") // scp 风格
        .replace(/\.git$/i, "")
        .replace(/\/+$/, "");
      if (normalized) {
        return (缓存项目标识 = crypto
          .createHash("sha1")
          .update(`git-remote:${normalized}`)
          .digest("hex"));
      }
    }

    return (缓存项目标识 = crypto
      .createHash("sha1")
      .update(`directory:${cwd}`)
      .digest("hex"));
  } catch {
    return (缓存项目标识 = "global");
  }
}

// 项目 id 的额度重置模式。`random`（默认）逐请求铸造一个新的 sha1 形状
// id，让免费档按项目 id 记账的额度桶永不累积；`derived` 保留 CLI 忠实
// 推导（调试/gate 诊断用）。客户端自带 x-opencode-project 时永远优先。
const 项目重置模式 = String(process.env.OPENCODE_PROJECT_MODE || "random")
  .trim()
  .toLowerCase() === "derived"
  ? "derived"
  : "random";

function 新项目标识() {
  return 项目重置模式 === "derived" ? 取项目标识() : identity.createProjectId();
}

function buildUpstreamHeaders(req, sessionId, projectOverride = null) {
  const downstreamUa = req?.headers?.["user-agent"] || "";
  const ua = isValidV2UserAgent(downstreamUa) ? downstreamUa : 网关安全UA();
  const client = req?.headers?.["x-opencode-client"];
  // `x-opencode-project` 不是常量：CLI 对仓库推导为
  // `sha1("git-remote:" + host + path)`，对目录推导为 `sha1("directory:" + path)`，
  // 否则取目录里 `opencode` 文件的内容。本桥默认逐请求换新 id
  // （OPENCODE_PROJECT_MODE=random）以重置按项目记账的免费额度；
  // `derived` 恢复 CLI 忠实形状。客户端自带该头始终优先。
  const project =
    req?.headers?.["x-opencode-project"] || projectOverride || 新项目标识();
  // 网关头集合由 identity.js 从上游自己的请求构造器推导，上游新增
  // 的头在刷新后的下一个请求开始发送。本桥推导不出值的头上报
  // 而不发空值：必填头发空值比缺席更糟。
  const { headers: gateHeaders } = identity.buildGateHeaders({
    userAgent: ua,
    client: client === "desktop" || client === "cli" ? client : "cli",
    project: String(project),
    sessionId,
  });
  return {
    "Authorization": "Bearer public",
    "Content-Type": "application/json",
    // CLI 在这里发 `*/*`（它总是经体流式，不用 Accept 头）。匹配它
    // 零成本，消除一个网关将来可能开始检查的差异。
    "Accept": "*/*",
    // W3C trace 上下文，CLI 每个请求都发。值逐请求随机 —— 实测与
    // 会话 id 无关 —— 所以按同样方式生成而不是推导。两个头描述
    // 同一条 128 位 trace 带 64 位 span；`b3` 追加父 span id。
    ...构建追踪头(),
    ...gateHeaders,
  };
}

/** 生成一份新的 W3C 追踪上下文，形态与 CLI 一致。 */
function 构建追踪头() {
  const traceId = crypto.randomBytes(16).toString("hex");
  const spanId = crypto.randomBytes(8).toString("hex");
  const parentSpanId = crypto.randomBytes(8).toString("hex");
  return {
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

/**
 * 上游可以先回 HTTP 200，然后在流*内*报告失败。不处理的话，
 * （`data: {"error":{...}}`，例如 "Streaming response failed: [503] ..."）。
 * 非流式客户端会拿到 200 + `content: null` + `finish_reason:
 * "stop"` —— 假成功。事件为 error 时返回错误文本，否则 null。
 */
function 提取流错误(ev) {
  const err = ev?.error;
  if (!err) return null;
  if (typeof err === "string") return err;
  return err.message || err.type || JSON.stringify(err);
}

function 提取Responses结束原因(ev, hasToolCalls) {
  const status = ev?.response?.status;
  const reason = ev?.response?.incomplete_details?.reason;
  if (ev?.type === "response.incomplete" || status === "incomplete") {
    if (reason === "content_filter") return "content_filter";
    return "length";
  }
  if (hasToolCalls) return "tool_calls";
  return "stop";
}

// 持久会话缓存 —— 跨轮保留上游提示/KV 缓存（LRU）
const sessionCache = new Map();
const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 3 * 3600 * 1000;
let 上次失败网关重试时间 = 0;
let 上次失败网关重试纪元 = -1;
// 上游最近一次按 IP 的滥用封锁（若有）。与重试冷却分开记录，
// 因为两者成因不同、对策不同：冷却是按 IP 的额度窗口，
// 封锁是网关直接拒绝本网络。
let 上次IP滥用时间 = 0;
// 最近一次网关拒绝的关联 id 与当时为真的形态审计。
// 发生时间。`x-opencode-log-id` 是上游给被拒请求的唯一凭据，所以
// 记录而不丢弃 —— 支持请求或 bug 报告要有用就靠它。
let 上次网关诊断 = null;
let 上次上游错误 = null;

/**
 * *实际*发出的请求带了哪些网关锚点。
 *
 * 网关要求一个名为 `read` 的工具，以及带会话头的 `opencode/*`
 * User-Agent（见 identity.js 的 GATE_ANCHOR_TOOL_NAMES /
 * GATE_ANCHOR_HEADER_NAMES）。403 回来时，靠它们区分"本桥发出的
 * 形态不可接受"与"上游拒绝这个出口"。
 * 报告这一区分正是意义所在：两者产生逐字节相同的 FreeTierError 体。
 */
function 审计网关形态(upstreamBody, headers) {
  const tools = Array.isArray(upstreamBody?.tools) ? upstreamBody.tools : [];
  const toolNames = tools.map((t) => t?.function?.name || t?.name).filter(Boolean);
  // 头名大小写不敏感比较：审计绝不能因为同一个头换了大小写到达就报
  // 缺锚点。
  const headerKey = (name) =>
    Object.keys(headers || {}).find((k) => k.toLowerCase() === name);
  const hasHeader = (name) => headerKey(name) !== undefined;
  const ua = String(headers?.[headerKey("user-agent")] || "");
  const sessionHeaders = ["x-opencode-session", "x-session-affinity", "x-session-id"].filter(
    hasHeader
  );
  return {
    hasReadTool: toolNames.includes("read"),
    toolCount: toolNames.length,
    userAgentOk: /^opencode\/[A-Za-z0-9-]+\/\d+\.\d+\.\d+\/[A-Za-z0-9-]+$/i.test(ua),
    userAgent: ua,
    sessionHeaders,
  };
}

function 上游日志ID之(upstreamRes) {
  return typeof upstreamRes?.headers?.get === "function"
    ? upstreamRes.headers.get("x-opencode-log-id")
    : null;
}

/**
 * 回应上游按 IP 的滥用封锁。
 *
 * 构造上即终态：封锁按出口网络记账，所以身份层不被征询、会话 id
 * 不重铸、请求不重放 —— 实测（上游自己的 issue 跟踪亦证实）这是
 * 任何客户端形态都解不开的网络级标记。拒绝原样到达客户端；
 * `X-OpenCode-Gate: ip-abuse` 让调用方与 `verify.js` 无须解析消息就
 * 能把它与形态网关区分开。
 */
function 回应IP滥用(res, status, errType, errMsg, logId, model) {
  上次IP滥用时间 = Date.now();
  上次网关诊断 = {
    at: 上次IP滥用时间,
    kind: "ip-abuse",
    status,
    logId: logId || null,
    message: errMsg,
    model,
  };
  console.warn(
    `[fucking-opencode] 上游 IP 滥用封锁（${status}）：${errMsg} —— 不刷新不重试；网关按本网络 IP 记账，身份变更无法解除` +
      (logId ? ` [x-opencode-log-id: ${logId}]` : "")
  );
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-OpenCode-Gate": "ip-abuse",
    ...(logId ? { "X-OpenCode-Log-Id": logId } : {}),
  });
  return res.end(
    JSON.stringify({
      error: {
        message: errMsg,
        type: errType || "FreeTierError",
        code: status,
      },
    })
  );
}

const origSessionCacheClear = sessionCache.clear.bind(sessionCache);
sessionCache.clear = () => {
  上次失败网关重试时间 = 0;
  上次失败网关重试纪元 = -1;
  上次IP滥用时间 = 0;
  上次上游错误 = null;
  return origSessionCacheClear();
};

/** 统计用的出口标签：池节点名或 direct/proxy。 */
function egressLabelForStats(picked) {
  try {
    if (!picked) return "direct";
    if (picked.source === "direct" || !picked.url) return "direct";
    return picked.label || picked.id || String(picked.url).replace(/^https?:\/\//, "").slice(0, 40);
  } catch {
    return "unknown";
  }
}

function getPersistentSessionId(req, body) {
  const headers = req?.headers || {};
  const rawHeaderKey =
    headers["x-opencode-session"] ||
    headers["x-opencode-session-id"] ||
    headers["x-session-id"] ||
    headers["session-id"] ||
    headers["x-conversation-id"] ||
    headers["x-9r-session-id"];
  const headerKey = Array.isArray(rawHeaderKey)
    ? String(rawHeaderKey[0] || "").slice(0, 256)
    : rawHeaderKey
      ? String(rawHeaderKey).slice(0, 256)
      : "";
  // 快路径（常见情形）：会话头在场，完全不需要消息哈希。下面的
  // conv 签名哈希只对无头客户端跑，且在 stringify*之前*切片，
  // 巨大系统提示绝不为取前 1000 字符就被序列化。
  let lookupKey = headerKey ? "hdr:" + headerKey : null;
  if (!lookupKey) {
    const msgs = body && Array.isArray(body.messages) ? body.messages : [];
    if (msgs.length > 0) {
      const sig =
        消息签名样本(msgs[0]?.content, 1000) +
        "::" +
        消息签名样本(msgs[1]?.content, 1000);
      if (sig !== "::") {
        lookupKey =
          "conv:" + crypto.createHash("sha256").update(sig).digest("hex").slice(0, 20);
      }
    }
  }
  const now = Date.now();
  if (lookupKey && sessionCache.has(lookupKey)) {
    const entry = sessionCache.get(lookupKey);
    if (now - entry.lastSeen < SESSION_TTL_MS) {
      // 重新插入以更新 Map 插入序，LRU 逐出 O(1)
      sessionCache.delete(lookupKey);
      entry.lastSeen = now;
      sessionCache.set(lookupKey, entry);
      return entry.sessionId;
    }
    sessionCache.delete(lookupKey);
  }
  const newSessionId = identity.createSessionId(true);
  if (lookupKey) {
    if (sessionCache.size >= MAX_SESSIONS) {
      for (const [k, v] of sessionCache) {
        if (now - v.lastSeen >= SESSION_TTL_MS) sessionCache.delete(k);
      }
      if (sessionCache.size >= MAX_SESSIONS) {
        const lruKey = sessionCache.keys().next().value;
        if (lruKey !== undefined) sessionCache.delete(lruKey);
      }
    }
    sessionCache.set(lookupKey, { sessionId: newSessionId, lastSeen: now });
  }
  return newSessionId;
}

/**
 * `/api/proxy` —— 读取并更改出口代理；`/api/proxy/test` —— 证明
 * 候选能拨到上游，之后才被信任。
 *
 * 面板是唯一调用方，所以契约保持很小：JSON 进、JSON 出、一个错误
 * 字段。凭据写入时接受、读取时绝不回显。
 */
async function 处理代理API(req, res, pathname) {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  if (pathname === "/api/proxy" && (req.method === "GET" || req.method === "HEAD")) {
    return send(200, proxy.describe());
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return send(405, { error: "Gunakan GET untuk status atau POST untuk mengubah." });
  }

  let payload = {};
  try {
    const text = await readRequestBody(req, 128 * 1024);
    payload = text ? JSON.parse(text) : {};
  } catch (err) {
    return send(err.statusCode === 413 ? 413 : 400, { error: `请求体无效：${err.message}` });
  }
  if (!payload || typeof payload !== "object") {
    return send(400, { error: "请求体必须是 JSON 对象。" });
  }

  // 池管理。`entries` 整池替换；`pool: []` 清空。与单代理的 `url`
  // 字段分开，一个请求就不会有两种意思，运维也能在试用池的同时
  // 保留单代理做兜底。
  const hasPool = Object.prototype.hasOwnProperty.call(payload, "entries") ||
    Object.prototype.hasOwnProperty.call(payload, "pool");
  if (hasPool && pathname === "/api/proxy") {
    const spec = Object.prototype.hasOwnProperty.call(payload, "entries")
      ? { entries: payload.entries, strategy: payload.strategy, cooldownMs: payload.cooldownMs, maxCooldownMs: payload.maxCooldownMs }
      : payload.pool;
    const result = proxy.setPool(spec);
    if (!result.ok) return send(400, { error: result.error });
    console.log(
      `[fucking-opencode] 出口池：${result.pool.enabled}/${result.pool.size} 条启用，策略 ${result.pool.strategy}`
    );
    return send(200, result);
  }

  // 单条目操作：切换启用、按 id 探测、清空冷却。池内 URL 绝不出网关
  //（面板只能看到 host:port），所以这两件事必须在服务端完成。
  if (payload.toggle != null && pathname === "/api/proxy") {
    const entries = proxy.getPool();
    const target = entries.find((e) => e.id === payload.toggle || e.label === payload.toggle);
    if (!target) return send(404, { error: "没有这个池条目。" });
    const spec = {
      entries: entries.map((e) =>
        e.id === target.id
          ? { id: e.id, label: e.label, url: e.url, enabled: !e.enabled, weight: e.weight }
          : { id: e.id, label: e.label, url: e.url, enabled: e.enabled, weight: e.weight },
      ),
      strategy: proxy.describe().pool ? proxy.describe().pool.strategy : undefined,
    };
    const result = proxy.setPool(spec);
    if (!result.ok) return send(400, { error: result.error });
    console.log(`[fucking-opencode] 出口池：${target.label || target.id} ${target.enabled ? "停用" : "启用"}`);
    return send(200, result);
  }

  if (payload.coolClear != null && pathname === "/api/proxy") {
    // 清空冷却：字符串 = 单个条目（failures 与冷却一起归零）；true 或 "*" = 全池。
    const isAll = payload.coolClear === true || payload.coolClear === "*";
    const result = isAll ? (proxy.resetHealth(), { ok: true }) : proxy.resetEntryHealth(String(payload.coolClear));
    if (!result.ok) return send(404, { error: result.error });
    return send(200, { ok: true, ...proxy.describe() });
  }

  if (pathname === "/api/proxy/test" && Array.isArray(payload.entries)) {
    const { entries } = payload;
    if (entries.length === 0) return send(400, { error: "entries 列表为空。" });
    // 只探测不安装：调用方在评估候选。
    const results = [];
    for (const [index, entry] of entries.entries()) {
      const parsed = proxy.parsePoolEntry(entry, index);
      if (!parsed.ok) {
        results.push({ id: `#${index + 1}`, host: null, ok: false, error: parsed.error });
        continue;
      }
      const verdict = await proxy.testProxy(parsed.entry.url, { probeUrl: 解析端点().modelsUrl });
      results.push({
        id: parsed.entry.id,
        label: parsed.entry.label,
        host: proxy.displayHost(parsed.entry.url),
        ok: verdict.ok,
        apiStatus: verdict.apiStatus || null,
        exitIp: verdict.exitIp || null,
        latencyMs: verdict.latencyMs || null,
        error: verdict.error || null,
      });
    }
    const anyOk = results.some((r) => r.ok);
    return send(anyOk ? 200 : 502, { ok: anyOk, entries: results });
  }

  if (pathname === "/api/proxy/test" && payload.testId != null) {
    // 按条目 id 探测：用网关内部的完整 URL（可能含凭据），结果只回延迟与出口 IP。
    const target = proxy.getPool().find((e) => e.id === payload.testId || e.label === payload.testId);
    if (!target) return send(404, { error: "没有这个池条目。" });
    const verdict = await proxy.testProxy(target.url, { probeUrl: 解析端点().modelsUrl });
    return send(verdict.ok ? 200 : 502, {
      ok: verdict.ok,
      id: target.id,
      label: target.label,
      host: proxy.displayHost(target.url),
      apiStatus: verdict.apiStatus || null,
      exitIp: verdict.exitIp || null,
      latencyMs: verdict.latencyMs || null,
      error: verdict.error || null,
    });
  }
  if (pathname === "/api/proxy/test" && typeof payload.url === "string") {
    const result = await proxy.testProxy(payload.url, { probeUrl: 解析端点().modelsUrl });
    return send(result.ok ? 200 : 502, result);
  }

  if (typeof payload.url === "string") {
    const result = proxy.setProxyUrl(payload.url);
    if (!result.ok) return send(400, { error: result.error });
    console.log(
      `[fucking-opencode] 出口：${result.mode === "proxy" ? `经代理 ${result.proxy}` : "direct"}`
    );
    return send(200, result);
  }

  return send(400, { error: "请求体须含 'url'（单代理）或 'entries'（代理池）。" });
}

/**
 * `/api/warp` —— 可选的 Cloudflare WARP 管理。默认关闭：连接/断开会改变
 * 整机路由，所以只有 `WARP_MANAGE=1` 时才允许动作，且只驱动主机上已
 * 安装的 `warp-cli`，不下载、不安装、不写凭据。
 */
async function 处理WARPAPI(req, res) {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" || req.method === "HEAD") return send(200, warp.状态());
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return send(405, { error: "Gunakan GET untuk status atau POST untuk connect/disconnect." });
  }
  if (!warp.启用()) {
    return send(409, { error: "WARP_MANAGE 未启用。重启服务前设置 WARP_MANAGE=1。", enabled: false });
  }

  let payload = {};
  try {
    const text = await readRequestBody(req, 4096);
    payload = text ? JSON.parse(text) : {};
  } catch (err) {
    return send(err.statusCode === 413 ? 413 : 400, { error: `请求体无效：${err.message}` });
  }
  const action = payload && payload.action;
  if (action !== "connect" && action !== "disconnect") {
    return send(400, { error: "action 只能是 connect 或 disconnect。" });
  }

  const result = action === "connect" ? warp.连接() : warp.断开();
  const 新状态 = warp.状态();
  记录事件(`WARP ${action}：${result.ok ? "成功" : result.error || "失败"}`, result.ok ? "info" : "warn");
  return send(result.ok ? 200 : 502, {
    ok: result.ok,
    action,
    output: result.output || "",
    error: result.error || null,
    status: 新状态,
  });
}

/**
 * `/api/warp-farm` —— 控制 Go sidecar `warp-farm`: start, stop, rotate, atau
 * terapkan lane-nya ke pool proxy. GET = status (proses, lane, log akhir).
 *
 * Tidak ada kredensial di status: hanya URL SOCKS5 loopback dan egress publik
 * dari trace Cloudflare. Semua aksi lewat gerbang admin yang sama dengan
 * `/api/proxy` (sesi panel, Host, dan Content-Type JSON).
 */
async function 处理WARPFarmAPI(req, res) {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" || req.method === "HEAD") {
    await warpFarm.刷新().catch(() => null);
    return send(200, warpFarm.状态());
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return send(405, { error: "Gunakan GET untuk status atau POST untuk aksi." });
  }

  let payload = {};
  try {
    const text = await readRequestBody(req, 4096);
    payload = text ? JSON.parse(text) : {};
  } catch (err) {
    return send(err.statusCode === 413 ? 413 : 400, { error: `请求体无效：${err.message}` });
  }

  switch (payload.action) {
    case "start": {
      const result = await warpFarm.启动({
        size: payload.size,
        basePort: payload.basePort,
        stack: payload.stack,
        sourceIpv6: payload.sourceIpv6,
        timeoutMs: payload.timeoutMs,
        applyToPool: payload.applyToPool !== false,
      });
      记录事件(
        `WARP farm start：${result.ok ? `${result.ready || 0} lane siap` : result.error || "gagal"}`,
        result.ok ? "info" : "warn"
      );
      return send(result.ok ? 200 : 502, result);
    }
    case "stop": {
      const result = await warpFarm.停止();
      记录事件("WARP farm stop", "info");
      return send(200, { ...result, status: warpFarm.状态() });
    }
    case "rotate": {
      const result = await warpFarm.轮换(payload.port || null);
      if (result.ok && payload.applyToPool !== false) {
        warpFarm.应用到池(result);
      }
      return send(result.ok ? 200 : 502, result);
    }
    case "restart": {
      const result = await warpFarm.重启动({
        size: payload.size,
        basePort: payload.basePort,
        stack: payload.stack,
        sourceIpv6: payload.sourceIpv6,
        timeoutMs: payload.timeoutMs,
        applyToPool: payload.applyToPool !== false,
      });
      记录事件(
        `WARP farm restart：${result.ok ? `${result.ready || 0} lane siap` : result.error || "gagal"}`,
        result.ok ? "info" : "warn"
      );
      return send(result.ok ? 200 : 502, { ...result, status: warpFarm.状态() });
    }
    case "settings": {
      const saved = warpFarm.保存设置({
        size: payload.size,
        basePort: payload.basePort,
        stack: payload.stack,
        sourceIpv6: payload.sourceIpv6,
        watchdog: payload.watchdog,
      });
      if (!saved.ok) return send(400, saved);
      return send(200, { ...saved, status: warpFarm.状态() });
    }
    case "applyPool": {
      const status = await warpFarm.刷新();
      const result = warpFarm.应用到池(status);
      return send(result.ok ? 200 : 409, { ...result, status });
    }
    default:
      return send(400, { error: "action 只能是 start, stop, rotate 或 applyPool。" });
  }
}

function readRequestBody(req, maxBytes = 请求体上限()) {
  // 提前拒绝：客户端声明巨大 body 时，一个字节都不读就拒绝，
  // 而不是先缓冲到上限。
  const declared = parseInt(req?.headers?.["content-length"] || "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    const err = new Error(`Request body exceeds limit of ${maxBytes} bytes`);
    err.statusCode = 413;
    err.code = "payload_too_large";
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let done = false;
    const cleanup = () => {
      if (typeof req.off === "function") {
        req.off("error", onError);
        req.off("data", onData);
        req.off("end", onEnd);
      } else if (typeof req.removeListener === "function") {
        req.removeListener("error", onError);
        req.removeListener("data", onData);
        req.removeListener("end", onEnd);
      }
    };

    const onError = (err) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        done = true;
        chunks.length = 0;
        cleanup();
        if (typeof req.pause === "function") req.pause();
        const err = new Error(`Request body exceeds limit of ${maxBytes} bytes`);
        err.statusCode = 413;
        err.code = "payload_too_large";
        reject(err);
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    req.on("error", onError);
    req.on("data", onData);
    req.on("end", onEnd);
  });
}

// --- HTTP 服务器 ---
function 处理请求(req, res) {
  处理请求主体(req, res).catch((err) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: `Kesalahan internal: ${err.message}` }));
  });
}

async function 处理请求主体(req, res) {
  req.on("error", (err) => {
    console.warn("[fucking-opencode] 请求流出错：", err.message);
  });
  res.on("error", (err) => {
    console.warn("[fucking-opencode] 响应流出错：", err.message);
  });

  const reqOrigin = req.headers?.origin || "";
  const configuredOrigin = process.env.CORS_ORIGIN !== undefined ? process.env.CORS_ORIGIN : CORS_ORIGIN;
  if (configuredOrigin === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (configuredOrigin) {
    const allowed = configuredOrigin.split(",").map((s) => s.trim()).filter(Boolean);
    if (allowed.includes(reqOrigin)) {
      res.setHeader("Access-Control-Allow-Origin", reqOrigin);
      res.setHeader("Vary", "Origin");
    }
  } else if (是本机来源(reqOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", reqOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, X-Session-Id, Session-Id, X-Conversation-Id, X-9r-Session-Id, X-OpenCode-Session, X-OpenCode-Session-Id, X-Session-Affinity, X-OpenCode-Client, X-OpenCode-Project"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const rawUrl = req.url || "/";
  const qIdx = rawUrl.indexOf("?");
  const rawPath = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  const pathname = rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.replace(/\/+$/, "") : rawPath;

  // 端口隔离：开启 ADMIN_PORT 后，面板与 /api/* 只接受来自管理端口的请求，
  // 管理端口则拒绝推理路由，避免两个面混在同一个入口。
  const 面板路径 =
    pathname === "" ||
    pathname === "/" ||
    pathname === "/panel-avatar.png" ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/api/");
  const 管理请求 = req.__adminPort === true;
  if (分离管理端口 && !管理请求 && 面板路径) {
    if ((req.method === "GET" || req.method === "HEAD") && pathname === "/") {
      const 主机 = ADMIN_BIND === "0.0.0.0" || ADMIN_BIND === "::"
        ? String(req.headers?.host || "").split(":")[0] || "127.0.0.1"
        : ADMIN_BIND;
      res.writeHead(302, { Location: `http://${主机}:${ADMIN_PORT}/`, "Cache-Control": "no-store" });
      return res.end();
    }
    res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ error: { message: "面板只监听管理端口 ADMIN_PORT。", type: "not_found", code: "admin_port_only" } }));
  }
  if (分离管理端口 && 管理请求) {
    const 推理路由 = pathname.startsWith("/v1/") && pathname !== "/v1/models";
    if (推理路由) {
      res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: { message: "管理端口不提供推理接口，请改用主端口。", type: "not_found", code: "api_port_only" } }));
    }
  }

  if ((req.method === "GET" || req.method === "HEAD") && (pathname === "/panel-avatar.png" || pathname === "/favicon.ico")) {
    try {
      const bytes = require("fs").readFileSync(require("path").join(__dirname, "panel-avatar.png"));
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600",
        "Content-Length": bytes.length,
      });
      return res.end(req.method === "HEAD" ? undefined : bytes);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
  }

  if (pathname === "/api/login" && req.method === "POST") {
    const denied = adminRequestError(req);
    if (denied) {
      res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: denied }));
    }
    const type = String(req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") {
      res.writeHead(415, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: "Content-Type harus application/json." }));
    }
    const ip = req.socket?.remoteAddress || "";
    if (panelLoginThrottled(ip)) {
      res.writeHead(429, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: "Too many attempts." }));
    }
    let password = "";
    try {
      const text = await readRequestBody(req, 4096);
      const payload = text ? JSON.parse(text) : {};
      password = typeof payload.password === "string" ? payload.password : "";
    } catch {
      res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: "Invalid JSON body." }));
    }
    const expected = panelPassword();
    if (!expected || timingSafeEqualStr(expected, password)) {
      panelSetCookie(res);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ ok: true }));
    }
    panelNoteFailure(ip);
    res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ error: "Wrong password." }));
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    panelClearCookie(req, res);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === "/api/config" && req.method === "GET") {
    const denied = adminRequestError(req);
    if (denied) {
      res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: denied }));
    }
    if (!panelAuthorized(req)) return panelUnauthorized(res);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(runtimeConfig.快照()));
  }

  if (pathname === "/api/config" && req.method === "POST") {
    const denied = adminRequestError(req);
    if (denied) {
      res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: denied }));
    }
    if (!panelAuthorized(req)) return panelUnauthorized(res);
    const type = String(req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") {
      res.writeHead(415, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: "Content-Type harus application/json." }));
    }
    let payload = {};
    try {
      const text = await readRequestBody(req, 256 * 1024);
      payload = text ? JSON.parse(text) : {};
    } catch (err) {
      res.writeHead(err.statusCode === 413 ? 413 : 400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: `请求体无效：${err.message}` }));
    }
    const result = runtimeConfig.写入(payload);
    if (!result.ok) {
      res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(result));
    }
    记录事件("运行时配置已更新（/api/config）", "info");
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(result));
  }

  if (pathname === "/api/settings") {
    const denied = adminRequestError(req);
    if (denied) {
      res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: denied }));
    }
    if (!panelAuthorized(req)) return panelUnauthorized(res);
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ ...panelSettings.describe(), defaultModel: 默认模型值() || "", projectMode: 项目重置模式 }));
    }
    if (req.method === "POST") {
      const type = String(req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") {
        res.writeHead(415, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ error: "Content-Type harus application/json." }));
      }
      let payload = {};
      try {
        const text = await readRequestBody(req, 8192);
        payload = text ? JSON.parse(text) : {};
      } catch {
        res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ error: "Invalid JSON body." }));
      }
      let error = null;
      let passwordChanged = false;
      if (payload.addApiKey && typeof payload.addApiKey === "object") {
        const result = panelSettings.addApiKey(payload.addApiKey);
        if (!result.ok) error = result.error;
      } else if (payload.updateApiKey && typeof payload.updateApiKey === "object") {
        const { id, label, enabled, rpm, daily, models } = payload.updateApiKey;
        const result = panelSettings.updateApiKey(String(id || ""), { label, enabled, rpm, daily, models });
        if (!result.ok) error = result.error;
      } else if (typeof payload.deleteApiKey === "string") {
        const result = panelSettings.deleteApiKey(payload.deleteApiKey);
        if (!result.ok) error = result.error;
      } else if (payload.clearApiKey === true) {
        const result = panelSettings.clearApiKey();
        if (!result.ok) error = result.error;
      } else if (typeof payload.apiKey === "string") {
        const result = panelSettings.setApiKey(payload.apiKey);
        if (!result.ok) error = result.error;
      }
      if (payload.clearPanelPassword === true) {
        const result = panelSettings.clearPanelPassword();
        if (!result.ok) error = result.error;
        else passwordChanged = true;
      } else if (typeof payload.panelPassword === "string") {
        const result = panelSettings.setPanelPassword(payload.panelPassword);
        if (!result.ok) error = result.error;
        else passwordChanged = true;
      }
      if (error) {
        res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ error }));
      }
      if (passwordChanged) {
        // 旧密码派生的会话立即失效；轮换 secret 后给当前操作者签发新 cookie。
        重置面板会话密钥();
        panelSetCookie(res);
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ ok: true, ...panelSettings.describe(), defaultModel: 默认模型值() || "", projectMode: 项目重置模式 }));
    }
    res.writeHead(405, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ error: "Method not allowed." }));
  }

  // 状态备份：导出/恢复网关的 JSON 状态文件（不含 usage.jsonl）。
  // 需要面板会话：内容包含代理凭据与下游 key，等同管理员权限。
  if (pathname === "/api/backup") {
    const denied = adminRequestError(req);
    if (denied) {
      res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: denied }));
    }
    if (!panelAuthorized(req)) return panelUnauthorized(res);
    const fs = require("fs");
    const path = require("path");
    const dir = 备份状态目录();
    const 允许文件 = ["config.json", "settings.json", "proxy.json", "warp-farm.json", "model-health.json"];
    const type = String(req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (req.method === "GET") {
      const files = {};
      for (const name of 允许文件) {
        try {
          files[name] = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        } catch {}
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ version: VERSION, exportedAt: Date.now(), files }));
    }
    if (req.method === "POST") {
      if (type !== "application/json") {
        res.writeHead(415, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ error: "Content-Type harus application/json." }));
      }
      let payload = {};
      try {
        payload = JSON.parse(await readRequestBody(req, 1024 * 1024));
      } catch (err) {
        res.writeHead(err.statusCode === 413 ? 413 : 400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ error: `请求体无效：${err.message}` }));
      }
      const files = payload && typeof payload.files === "object" && payload.files ? payload.files : {};
      const 已写 = [];
      const 拒绝 = [];
      for (const name of Object.keys(files)) {
        if (!允许文件.includes(name)) {
          拒绝.push(name);
          continue;
        }
        const value = files[name];
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          拒绝.push(name);
          continue;
        }
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name);
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
        fs.renameSync(tmp, file);
        try {
          fs.chmodSync(file, 0o600);
        } catch {}
        已写.push(name);
      }
      记录事件(`状态已恢复（${已写.join(", ") || "无"}）`, "warn");
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ ok: true, restored: 已写, rejected: 拒绝 }));
    }
    res.writeHead(405, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ error: "Method not allowed." }));
  }

  // 面板：给人看的页面。JSON 消费者继续用 /health，这也是 "/"
  // 不再是健康文档别名的原因。
  if ((req.method === "GET" || req.method === "HEAD") && (pathname === "" || pathname === "/")) {
    const denied = adminRequestError(req);
    if (denied) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(req.method === "HEAD" ? undefined : denied);
    }
    const html = panelAuthorized(req)
      ? panel.renderPanel(proxy.describe(), { version: VERSION, port: PORT, authRequired: Boolean(panelPassword()), apiKey: panelSettings.getApiKey() || "" })
      : panel.renderLogin({ version: VERSION, port: PORT });
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(html),
      "X-Frame-Options": "DENY",
    });
    return res.end(req.method === "HEAD" ? undefined : html);
  }

  if (pathname === "/api/proxy" || pathname === "/api/proxy/test") {
    const denied = adminRequestError(req);
    if (denied) {
      res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: denied }));
    }
    if (!panelAuthorized(req)) return panelUnauthorized(res);
    // 只有 JSON 能改设置。`text/plain` 是 CORS "简单请求"，接受它
    // 等于让任何页面不经预检就能 POST 到这里；拒绝它是 CSRF 防御
    // 的结构性一半。
    if (req.method === "POST") {
      const type = String(req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") {
        res.writeHead(415, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ error: "Content-Type harus application/json." }));
      }
    }
    // `处理代理API` 是异步的；意外抛出必须变成 500，而不是
    // 未处理 rejection —— 它会让 socket 挂着。
    处理代理API(req, res, pathname).catch((err) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: `Kesalahan internal: ${err.message}` }));
    });
    return;
  }

  if (pathname === "/api/warp") {
    const denied = adminRequestError(req);
    if (denied) {
      res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: denied }));
    }
    if (!panelAuthorized(req)) return panelUnauthorized(res);
    if (req.method === "POST") {
      const type = String(req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") {
        res.writeHead(415, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ error: "Content-Type harus application/json." }));
      }
    }
    处理WARPAPI(req, res).catch((err) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: `Kesalahan internal: ${err.message}` }));
    });
    return;
  }

  if (pathname === "/api/warp-farm") {
    const denied = adminRequestError(req);
    if (denied) {
      res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: denied }));
    }
    if (!panelAuthorized(req)) return panelUnauthorized(res);
    if (req.method === "POST") {
      const type = String(req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") {
        res.writeHead(415, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ error: "Content-Type harus application/json." }));
      }
    }
    处理WARPFarmAPI(req, res).catch((err) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: `Kesalahan internal: ${err.message}` }));
    });
    return;
  }

  // 健康检查
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const idState = identity.getState();
    const proxyState = proxy.describe();
    const gateThrottled =
      上次失败网关重试时间 > 0 &&
      Date.now() - 上次失败网关重试时间 < GATE_RETRY_COOLDOWN_MS &&
      上次失败网关重试纪元 === (idState.epoch || 0);
    return res.end(
      JSON.stringify({
        status: "ok",
        provider: "fucking-opencode",
        version: VERSION,
        runtime: typeof Bun !== "undefined" ? `bun/${Bun.version}` : `node/${process.versions.node}`,
        discoveredModels: 在线模型表.length,
        // 实际生效的出口。`mode` 是真正承载请求的那条：配置了池走池，
        // 否则单代理，否则中继，否则直连。`proxy.mode` 只报告配置的形态，
        // 所以只有中继的部署在这里仍读作 `relay`。
        // 绝不包含凭据；`proxy` 里每个主机都是 host:port。
        egress: {
          mode:
            proxyState.mode === "pool"
              ? "pool"
              : proxyState.mode === "proxy"
                ? "proxy"
                : UPSTREAM_RELAY_URL
                  ? "relay"
                  : "direct",
          ...(UPSTREAM_RELAY_URL ? { relay: 中继标签(UPSTREAM_RELAY_URL) } : {}),
          proxy: proxyState,
        },
        identity: {
          userAgent: idState.userAgent,
          updateMode: idState.updateMode,
          sourceTag: idState.lastSourceTag,
          versionFloor: idState.versionFloor,
          lastCheckAgeMs: idState.lastCheckTime ? Date.now() - idState.lastCheckTime : null,
          ttlMs: idState.ttlMs,
          lastError: idState.lastRefreshError,
          release: idState.release,
          // 反应模式下，存在尚未采纳的发行版（因网关未动）时设置。
          // 采纳后为 null。
          available: idState.available,
          // 当前生效的头名，以及配方要求而本桥填不了的 —— 非空
          // `unsentHeaders` 表示下一次网关变动跟上前需要手工映射。
          headers: idState.headers,
          unsentHeaders: idState.unsentHeaders,
          // 从上游源码推导的值：线上端点（来自供应商目录）与工具白名单
          // （来自发行版工具插件源码）。可见是因为这些层无须发新版桥
          // 就会变。
          endpoints: idState.endpoints,
          toolNames: idState.toolNames,
          tools: idState.tools,
          gate: {
            status: 上次IP滥用时间 > 0 ? "ip-blocked" : gateThrottled ? "throttled" : "open",
            // 网关把滥用封锁按出口网络记账，没有已知到期时间可宣传。
            // `ipBlockedSince` 是上游最近一次返回该拒绝的时间。
            ipBlockedSince: 上次IP滥用时间 || null,
            throttledUntil: gateThrottled
              ? 上次失败网关重试时间 + GATE_RETRY_COOLDOWN_MS
              : null,
            cooldownMs: GATE_RETRY_COOLDOWN_MS,
            // 网关检查的形态锚点。上报以便部署方确认自己在发，而不必
            // 等一个 403。
            anchors: {
              tools: identity.GATE_ANCHOR_TOOL_NAMES.slice(),
              headers: identity.GATE_ANCHOR_HEADER_NAMES.slice(),
            },
            // 最近一次网关拒绝：发了什么、缺了什么，以及上游自己的
            // 关联 id。`shapeOk: false` 表示桥产出了网关拒绝的请求
            // —— 不是 IP 问题。
            lastRejection: 上次网关诊断,
            lastUpstreamError: 上次上游错误,
          },
        },
      })
    );
  }

  // Prometheus 指标：默认无鉴权（面板应只绑定回环）；设置 METRICS_TOKEN
  // 后要求 `Authorization: Bearer <token>`，方便反向代理后暴露。
  if (req.method === "GET" && pathname === "/metrics") {
    const token = String(process.env.METRICS_TOKEN || "").trim();
    if (token) {
      const raw = String(req.headers?.authorization || "");
      const given = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
      if (!timingSafeEqualStr(token, given)) {
        res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", "WWW-Authenticate": "Bearer" });
        return res.end("Unauthorized\n");
      }
    }
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(渲染指标());
  }

  // OpenAPI 3.1：客户端生成器与调试器用的最小描述。
  if (req.method === "GET" && pathname === "/openapi.json") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(OPENAPI_JSON);
  }

  // 单个模型详情：/v1/models/{id}。
  if (req.method === "GET" && /^\/(v1\/)?models\/[^/]+$/.test(pathname)) {
    const id = decodeURIComponent(pathname.replace(/^\/(v1\/)?models\//, ""));
    if (在线模型表.length === 0) await discoverModels().catch(() => {});
    let 清单 = { data: [] };
    try {
      清单 = JSON.parse(缓存模型负载);
    } catch {}
    const 条目 = (清单.data || []).find((m) => m && m.id === id);
    if (!条目) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `模型 '${id}' 不存在。`, type: "invalid_request_error", code: "model_not_found" } }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ...条目, object: "model" }));
  }

  // 模型清单（小时级 TTL 过期时触发异步重发现）
  if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
    if (在线模型表.length === 0) {
      discoverModels()
        .catch(() => {})
        .finally(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(缓存模型负载);
        });
      return;
    }
    if (Date.now() - 上次发现时间 > DISCOVERY_TTL_MS) {
      discoverModels().catch(() => {});
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(缓存模型负载);
  }

  // 对话补全接口
  if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
    const 密钥拒绝 = 检查API密钥(req);
    if (密钥拒绝) {
      const headers = { "Content-Type": "application/json" };
      if (密钥拒绝.__retryAfter) headers["Retry-After"] = String(密钥拒绝.__retryAfter);
      res.writeHead(密钥拒绝.__status || 401, headers);
      return res.end(JSON.stringify({ error: 密钥拒绝.error }));
    }
    const 并发槽 = await 申请并发槽();
    if (!并发槽) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
      return res.end(JSON.stringify({ error: { message: "网关繁忙：在途请求已满，请稍后重试。", type: "rate_limit_error", code: "gateway_busy" } }));
    }
    挂接并发释放(res, 并发槽);
    (async () => {
      let bodyText;
      try {
        bodyText = await readRequestBody(req);
      } catch (err) {
        if (err.statusCode === 413) {
          res.writeHead(413, { "Content-Type": "application/json", "Connection": "close" });
          res.end(
            JSON.stringify({
              error: {
                message: err.message,
                type: "invalid_request_error",
                code: "payload_too_large",
              },
            })
          );
          res.once("finish", () => {
            if (typeof req.destroy === "function") req.destroy();
          });
          return;
        }
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "读取请求体失败", type: "invalid_request_error" },
            })
          );
        }
        return;
      }

      let body;
      try {
        body = JSON.parse(bodyText);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("请求体必须是 JSON 对象");
        }
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: {
              message: `无效的 JSON 请求体：${err.message}`,
              type: "invalid_request_error",
              code: "invalid_json",
            },
          })
        );
      }

      // 默认模型：客户端没给 model 时用运行配置的 defaultModel。
      if (!body.model && 默认模型值()) body.model = 默认模型值();
      let targetModel = normalizeModel(body.model);
      if (!targetModel) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: {
              message: "缺少必填参数或其为空：'model'",
              type: "invalid_request_error",
              param: "model",
              code: "model_required",
            },
          })
        );
      }

      // 下游 key 的模型白名单（条目未配置时放行）。
      const 模型许可 = 检查模型许可(req, targetModel);
      if (模型许可) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { ...模型许可, param: "model" } }));
      }

      // 模型组：别名 → 有序候选。跳过目录明确判为非免费/退役的候选；
      // 上游运行期失败再按 model-health 冷却继续往后切。
      const 组候选 = 模型组.候选(targetModel);
      let 候选列表 = 组候选.filter((模型) => {
        const 判定 = identity.getCatalogVerdict(模型);
        return !判定 || 判定 === "free";
      });
      if (候选列表.length === 0) 候选列表 = [...组候选];
      if (候选列表.length > 1) {
        console.log(`[fucking-opencode] 模型组 ${targetModel}：${候选列表.join(" → ")}`);
      }
      targetModel = 候选列表[0] || targetModel;
      body.model = targetModel;

      // 仅免费档：本桥发 `Authorization: Bearer public`，无法认证任何其他
      // 东西，目录定价高于零的模型只会在上游失败。在这里说明 ——
      // 上游 401（"no session"）会让用户去找不存在的登录。
      const modelVerdict = identity.getCatalogVerdict(targetModel);
      if (modelVerdict && modelVerdict !== "free") {
        const isRetired = modelVerdict === "deprecated";
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: {
              message: isRetired
                ? `模型 '${targetModel}' 已在上游退役。免费模型清单见 /v1/models。`
                : `模型 '${targetModel}' 不在免费档上——本桥 no account 可运行它。免费模型清单见 /v1/models。`,
              type: "invalid_request_error",
              param: "model",
              code: isRetired ? "model_deprecated" : "model_not_free",
            },
          })
        );
      }

      if (!Array.isArray(body.messages)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: {
              message: "缺少或无效的必填参数：'messages' 必须是数组",
              type: "invalid_request_error",
              param: "messages",
              code: "messages_required",
            },
          })
        );
      }

      const clientStream = Boolean(body.stream);

      // 用量统计：本请求的记录对象。成功/失败路径都会补字段后落盘。
      const 统计 = 用量统计 && 用量统计.记录请求 ? {
        t0: Date.now(),
        model: targetModel,
        protocol: "openai",
        stream: clientStream,
        request_id: 用量统计.新请求标识(),
        ...用量标签(req),
      } : null;
      if (统计) res.setHeader("X-Request-Id", 统计.request_id);
      const 落盘统计 = (status, extra = {}) => {
        if (!统计) return;
        const egressLabel = typeof egressStateRef === "function" ? egressLabelForStats(egressStateRef()) : "direct";
        // 兼容路由自call 时从这里读出口标签（X-Gateway-Egress）。
        try { res.setHeader("X-Gateway-Egress", egressLabel); } catch {}
        用量统计.记录请求({
          ...统计,
          status,
          ms: Date.now() - 统计.t0,
          egress: egressLabel,
          ...extra,
        });
      };
      // egressState 在更深处（try 块内）才创建；用引用槽避免 TDZ。
      let egressStateRef = null;

      // 惰性身份检查：后台没有定时器。TTL 过期后的第一个请求在后台
      // 触发刷新，并以当前身份继续；下一个请求用刷新后的。
      identity.ensureFresh();
      同步UA();

      let useResponses = isResponsesModel(targetModel);
      const sessionId = getPersistentSessionId(req, body);
      let retryHeaders = null;
      const upstreamHeaders = buildUpstreamHeaders(req, sessionId);

      const abortController = new AbortController();
      let timedOut = false;
      let clientDisconnected = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        abortController.abort(new Error("上游请求超时"));
      }, 上游超时毫秒());

      const onClose = () => {
        if (!res.writableEnded) {
          clientDisconnected = true;
          abortController.abort(new Error("Client disconnected"));
        }
      };
      res.on("close", onClose);

      let reader = null;

      // 每个客户端请求一个出口。模型回退共用同一出口 —— 上游把重试
      // 绑在见过首次尝试的地址上；只有代理不可达或网关点名出口时才换。
      const egressState = { egress: proxy.pick(), egressUrl: null, transportFailures: 0, egressSwaps: 0 };
      egressState.egressUrl = egressState.egress.url;
      egressStateRef = () => egressState.egress;
      // 兼容路由自call 时从这里读出口标签。必须在任何 writeHead 之前 set。
      if (统计) {
        try { res.setHeader("X-Gateway-Egress", egressLabelForStats(egressState.egress)); } catch {}
      }
      const egressUrl = () => egressState.egressUrl;

      const 暂停毫秒 = 匿名暂停剩余毫秒();
      if (暂停毫秒 > 0) {
        const 秒 = Math.max(1, Math.ceil(暂停毫秒 / 1000));
        落盘统计(429, { error: "anonymous_lane_paused" });
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": String(秒),
        });
        return res.end(
          JSON.stringify({
            error: {
              message: `Anonymous lane is paused for another ${秒}s after repeated upstream quota/abuse rejections.`,
              type: "anonymous_lane_paused",
              code: 429,
              retry_after: 秒,
            },
          })
        );
      }

      let 当前候选 = 0;
      模型尝试: for (; 当前候选 < 候选列表.length; 当前候选++) {
        targetModel = 候选列表[当前候选];
        useResponses = isResponsesModel(targetModel);
        body.model = targetModel;
        if (统计) 统计.model = targetModel;
        let { upstreamBody, aliasToOriginal } = buildUpstreamPayload(body, targetModel, useResponses);
        let liveEndpoints = 解析端点(targetModel);
        let upstreamUrl = useResponses ? liveEndpoints.responsesUrl : liveEndpoints.chatUrl;
        // 可回退判定：还没到最后一个候选，且失败与模型/容量/上游有关。
        const 可切换模型 = (状态) =>
          当前候选 + 1 < 候选列表.length &&
          [404, 410, 429, 500, 502, 503, 504].includes(状态);

        try {
          let upstreamRes = await 出口抓取(upstreamUrl, {
          method: "POST",
          headers: upstreamHeaders,
          body: JSON.stringify(upstreamBody),
          signal: abortController.signal,
        }, egressState);

        // 新发行模型需要相反协议通道时，学会它，并在匹配通道上透明重试一次。
        if (!upstreamRes.ok && upstreamRes.status === 400) {
          const errText = await upstreamRes.text();
          let errJson;
          try {
            errJson = JSON.parse(errText);
          } catch {
            errJson = { message: errText };
          }
          const errType = errJson.error?.type || "";
          const errMsg = errJson.error?.message || errJson.message || "";
          if (
            errType === "ModelProtocolUnsupported" ||
            errMsg.includes("ModelProtocolUnsupported") ||
            errMsg.includes("does not support this protocol")
          ) {
            useResponses = !useResponses;
            markProtocolSupport(targetModel, useResponses);
            ({ upstreamBody, aliasToOriginal } = buildUpstreamPayload(body, targetModel, useResponses));
            upstreamUrl = useResponses ? liveEndpoints.responsesUrl : liveEndpoints.chatUrl;
            upstreamRes = await 上游抓取(upstreamUrl, {
              method: "POST",
              headers: upstreamHeaders,
              body: JSON.stringify(upstreamBody),
              signal: abortController.signal,
            }, egressUrl());
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(
              JSON.stringify({
                error: {
                  message: errMsg || "Upstream error 400",
                  type: errType || "upstream_error",
                  code: 400,
                },
              })
            );
          }
        }

        // 端点迁移。供应商目录是线上基址的权威，上游路径迁移（/zen/v1 →
        // /inference/v1 那次）在旧路径表现为 404/410 —— 不是网关拒绝。404
        // 平时与"该路由不存在"无法区分，所以从目录重新推导并重试一次，
        // 但仅当推导出的 URL 确实不同。404 上重放同 URL 会死循环。
        // 体只能读一次。前面的分支已消费时，下面的通用错误路径必须复用
        // 文本，而不是读空流报 "Upstream error <status>"。
        let consumedErrorText = null;
        if (!upstreamRes.ok && (upstreamRes.status === 404 || upstreamRes.status === 410)) {
          const staleUrl = upstreamUrl;
          let moveText = "";
          try {
            moveText = await upstreamRes.text();
          } catch {}
          consumedErrorText = moveText;
          // 410 也可能是关于*模型*而非路由：换 URL 只会重复同样的模型级
          // （`{"error":{"type":"ModelDeprecated"}}`）回答，
          // 所以端点自愈只在错误未点名模型时适用。
          let moveErrType = "";
          try {
            const j = JSON.parse(moveText);
            moveErrType = j?.error?.type || j?.type || "";
          } catch {}
          const modelLevelError = /model(deprecated|unavailable|protocolunsupported)/i.test(
            moveErrType
          );
          if (!modelLevelError) {
            await identity.refresh({ force: true }).catch(() => null);
            liveEndpoints = 解析端点(targetModel);
            const derivedUrl = useResponses ? liveEndpoints.responsesUrl : liveEndpoints.chatUrl;
            if (derivedUrl && derivedUrl !== staleUrl) {
              console.warn(
                `[fucking-opencode] 上游端点已迁移（${upstreamRes.status}）：${staleUrl} → ${derivedUrl}；重试一次`
              );
              upstreamUrl = derivedUrl;
              upstreamRes = await 上游抓取(upstreamUrl, {
                method: "POST",
                headers: upstreamHeaders,
                body: JSON.stringify(upstreamBody),
                signal: abortController.signal,
              }, egressUrl());
              // 上面的文本属于刚被替换的响应。为新响应再读它会逐字报出旧错误。
              consumedErrorText = null;
            }
          }
        }

        // 池出口上额度耗尽。429 意味着传输与请求形状都被接受，只有这个
        // IP 的配额没了，唯一有用的动作是把重试花在另一个 IP 上，而不是
        // 向上游刚拒绝的地址重放同一请求。预算内换多条，直到成功或用尽。
        if (!upstreamRes.ok && upstreamRes.status === 429) {
          const poolState = proxy.describe().pool;
          const cooldownMs = poolState ? poolState.cooldownMs * 4 : null;
          while (
            upstreamRes.status === 429 &&
            换一条出口(egressState, { reason: "allowance 429", cooldownMs })
          ) {
            console.warn(
              `[fucking-opencode] 出口额度用尽（429）；改经 ${
                proxy.displayHost(egressState.egressUrl) || "direct"
              } 重试（已换 ${egressState.egressSwaps}/${最大出口重试}）`
            );
            upstreamRes = await 出口抓取(upstreamUrl, {
              method: "POST",
              headers: upstreamHeaders,
              body: JSON.stringify(upstreamBody),
              signal: abortController.signal,
            }, egressState);
            consumedErrorText = null;
          }
          if (upstreamRes.status === 429) {
            记录出口失败(egressState, { reason: "allowance 429", cooldownMs });
            记录匿名失败("allowance 429");
          }
        }

        // 瞬时 5xx 自愈：免费推理降级期间，上游 Workers 间歇性丢弃空体的
        // HTTP 500/502/503/504（如 cf-placement: remote-IAD）。用新的
        // trace/会话头重试一次。
        if (!upstreamRes.ok && upstreamRes.status >= 500 && upstreamRes.status < 600) {
          const first5xx = upstreamRes.status;
          const firstLogId =
            typeof upstreamRes.headers?.get === "function"
              ? upstreamRes.headers.get("x-opencode-log-id")
              : null;
          try {
            await upstreamRes.text();
          } catch {}
          const retry5xxSid = 重造会话标识(req, body, sessionId);
          const retry5xxHeaders = buildUpstreamHeaders(req, retry5xxSid, identity.createProjectId());
          console.warn(
            `[fucking-opencode] 上游返回 ${first5xx}` +
              (firstLogId ? ` [x-opencode-log-id: ${firstLogId}]` : "") +
              `；换新会话重试一次`
          );
          if (换一条出口(egressState, { reason: `upstream ${first5xx}` })) {
            console.warn(
              `[fucking-opencode] 5xx 出口改经 ${
                proxy.displayHost(egressState.egressUrl) || "direct"
              } 重试（已换 ${egressState.egressSwaps}/${最大出口重试}）`
            );
          }
          upstreamRes = await 上游抓取(upstreamUrl, {
            method: "POST",
            headers: retry5xxHeaders,
            body: JSON.stringify(upstreamBody),
            signal: abortController.signal,
          }, egressUrl());
          consumedErrorText = null;
        }

        // 自愈身份。网关拒绝靠错误*体*识别，不在状态行：403 只有在其
        // type 或消息这么说时才是网关，而 426 本身就是版本下限握手。
        // 所以必须先读体再决策 —— 在这里传空字符串曾让 403 的分支不可达。
        错误处理: for (;;) {
          if (upstreamRes.ok) break 错误处理;
          let errText = consumedErrorText ?? "";
          if (consumedErrorText === null) {
            try {
              errText = await upstreamRes.text();
            } catch {
              errText = "";
            }
          }
          let errJson = null;
          try {
            errJson = JSON.parse(errText);
          } catch {
            errJson = null;
          }
          const errType = errJson?.error?.type || errJson?.type || "";
          const rawMsg =
            errJson?.error?.message ||
            errJson?.message ||
            errText ||
            `Upstream error ${upstreamRes.status}`;

          // 终态分支。上游在消息里点名按 IP 的滥用封锁，那是与形态网关
          // 不同的失败：网关已标记本网络，刷新配方、铸造新会话 id、重放
          // 请求都改变不了答案。对网关自己的报告实测：官方 CLI 从同一
          // IP 得到同样拒绝。原样返回，身份层不动。
          // IP 封锁按出口 IP 记账，不是按账号或形态：池里还有别的出口时，
          // 换一条重试可能直接成功；全部换完仍封锁才原样上报。
          if (identity.isIpAbuseRejection(upstreamRes.status, rawMsg)) {
            let lastStatus = upstreamRes.status;
            let lastType = errType;
            let lastMsg = rawMsg;
            let lastLogId = 上游日志ID之(upstreamRes);
            while (!upstreamRes.ok && 换一条出口(egressState, { reason: "ip-abuse block" })) {
              console.warn(
                `[fucking-opencode] 出口被按 IP 封锁（${lastStatus}）；改经 ${
                  proxy.displayHost(egressState.egressUrl) || "direct"
                } 重试（已换 ${egressState.egressSwaps}/${最大出口重试}）`
              );
              upstreamRes = await 出口抓取(upstreamUrl, {
                method: "POST",
                headers: upstreamHeaders,
                body: JSON.stringify(upstreamBody),
                signal: abortController.signal,
              }, egressState);
              consumedErrorText = null;
              if (upstreamRes.ok) break;
              let abuseText = "";
              try {
                abuseText = await upstreamRes.text();
              } catch {}
              consumedErrorText = abuseText;
              let abuseJson = null;
              try {
                abuseJson = JSON.parse(abuseText);
              } catch {}
              lastStatus = upstreamRes.status;
              lastType = abuseJson?.error?.type || abuseJson?.type || "";
              lastMsg =
                abuseJson?.error?.message ||
                abuseJson?.message ||
                abuseText ||
                `Upstream error ${upstreamRes.status}`;
              lastLogId = 上游日志ID之(upstreamRes);
              if (!identity.isIpAbuseRejection(lastStatus, lastMsg)) break;
            }
            if (upstreamRes.ok) break 错误处理;
            if (identity.isIpAbuseRejection(lastStatus, lastMsg)) {
              记录匿名失败("ip-abuse");
              return 回应IP滥用(res, lastStatus, lastType, lastMsg, lastLogId, targetModel);
            }
            continue 错误处理;
          }

          if (!是免费档CLI网关错误(upstreamRes.status, errType, rawMsg)) {
            const upstreamLogId =
              typeof upstreamRes.headers?.get === "function"
                ? upstreamRes.headers.get("x-opencode-log-id")
                : null;
            const cfRay =
              typeof upstreamRes.headers?.get === "function"
                ? upstreamRes.headers.get("cf-ray")
                : null;
            const cfPlacement =
              typeof upstreamRes.headers?.get === "function"
                ? upstreamRes.headers.get("cf-placement")
                : null;
            if (upstreamRes.status >= 500) {
              上次上游错误 = {
                at: Date.now(),
                status: upstreamRes.status,
                logId: upstreamLogId,
                cfRay,
                cfPlacement,
                message: rawMsg,
                model: targetModel,
              };
              console.warn(
                `[fucking-opencode] 上游服务错误（${upstreamRes.status}）模型 ${targetModel}：${rawMsg}` +
                  (upstreamLogId ? ` [x-opencode-log-id: ${upstreamLogId}]` : "") +
                  (cfRay ? ` [cf-ray: ${cfRay}]` : "") +
                  (cfPlacement ? ` [cf-placement: ${cfPlacement}]` : "")
              );
            }
            if (可切换模型(upstreamRes.status)) {
              模型组.记录失败(targetModel, upstreamRes.status);
              console.warn(
                `[fucking-opencode] 模型 ${targetModel} 返回 ${upstreamRes.status}；改试 ${候选列表[当前候选 + 1]}`
              );
              continue 模型尝试;
            }
            const errHeaders = { "Content-Type": "application/json" };
            if (upstreamLogId) errHeaders["X-OpenCode-Log-Id"] = upstreamLogId;
            if (upstreamRes.status >= 500) errHeaders["X-OpenCode-Gate"] = "upstream-error";
            res.writeHead(upstreamRes.status, errHeaders);
            return res.end(
              JSON.stringify({
                error: {
                  message: rawMsg,
                  type: errType || "upstream_error",
                  code: upstreamRes.status,
                  ...(upstreamLogId ? { log_id: upstreamLogId } : {}),
                },
              })
            );
          }

          const gateStatus = upstreamRes.status;
          const verdict = await identity
            .onGateRejection(gateStatus, errType, rawMsg, false)
            .catch(() => ({ retry: false, reason: "refresh-error" }));

          // 网关拒绝总重试一次，即使刷新没学到新东西。交给网关的两个输入
          同步UA();
          const retrySessionId = 重造会话标识(req, body, sessionId);
          const currentEpoch = identity.getState().epoch || 0;
          const skipCooldownRetry =
            !verdict.retry &&
            上次失败网关重试时间 > 0 &&
            Date.now() - 上次失败网关重试时间 < GATE_RETRY_COOLDOWN_MS &&
            上次失败网关重试纪元 === currentEpoch;

          if (!skipCooldownRetry) {
            // 重试时换出口；只有一个代理（或没有）时，`pick()` 返回同一出口，这里是空操作。
            const pooled = proxy.describe().pool;
            const canFailover = pooled && pooled.active && pooled.enabled > 1;
            if (canFailover && egressState.egressUrl) {
              proxy.markFailure(egressState.egressUrl, {
                reason: `gate ${gateStatus}`,
                cooldownMs: gateStatus === 429 ? pooled.cooldownMs * 4 : null,
              });
              const next = proxy.pick({ exclude: egressState.egressUrl });
              if (next.url && next.url !== egressState.egressUrl) {
                console.warn(
                  `[fucking-opencode] 网关拒绝出口 ${
                    proxy.displayHost(egressState.egressUrl) || "direct"
                  }（${gateStatus}）；重试改走 ${proxy.displayHost(next.url) || "direct"}`
                );
                egressState.egress = next;
                egressState.egressUrl = next.url;
              }
            }
            console.warn(
              `[fucking-opencode] 上游 CLI 网关拒绝请求（${gateStatus}，${verdict.reason || "unknown"}）；刷新身份并以完整工具集重试一次`
            );
            ({ upstreamBody, aliasToOriginal } = buildUpstreamPayload(
              body,
              targetModel,
              useResponses,
              "full"
            ));
            liveEndpoints = 解析端点(targetModel);
            upstreamUrl = useResponses ? liveEndpoints.responsesUrl : liveEndpoints.chatUrl;
            retryHeaders = buildUpstreamHeaders(req, retrySessionId, identity.createProjectId());
            upstreamRes = await 上游抓取(upstreamUrl, {
              method: "POST",
              headers: retryHeaders,
              body: JSON.stringify(upstreamBody),
              signal: abortController.signal,
            }, egressUrl());
          } else {
            console.warn(
              `[fucking-opencode] 上游 CLI 网关拒绝请求（${gateStatus}）；跳过重试——完整形态重试已在 <${Math.round(GATE_RETRY_COOLDOWN_MS / 1000)} 秒前于当前身份上失败（IP 冷却生效中）`
            );
          }

          if (!upstreamRes.ok) {
            // 形态问题本桥能自己学着解决。实测两种 403 无法区分：
            // 403 FreeTierError 成因不止一个，光看消息分不开：
            //
            //   1. 传输指纹 —— 实测：同一 IP 同一分钟，Node 与 curl 100% 被拒，
            //      Bun 100% 成功。CLI 以 Bun 二进制发行，所以只有 Bun 匹配。
            //   2. 按 IP 额度 —— 同样以 403 返回。实测：探测几十次后，真 CLI
            //      v2.0.32 从一小时前还答 200 的同一 IP 得到相同的 403，桥也一样。
            //      传输并未改变。
            //
            // 429 FreeUsageLimitError 无歧义：传输已过、配额已花。在 403
            // 出现的同时于新 IP 上观察到，这正是把两者区分开的办法。
            //
            // 本地只能查运行时，所以如实上报并点名两种可能，而不是断言
            // 错的那种。
            // 记日志前先读重试自己的体。首次尝试的消息描述的是本桥已
            // 替换掉的形状，在这里报它等于描述一个没人发出的请求。
            let retryText = errText;
            let retryJson = errJson;
            if (!skipCooldownRetry) {
              retryText = "";
              try {
                retryText = await upstreamRes.text();
              } catch {}
              retryJson = null;
              try {
                retryJson = JSON.parse(retryText);
              } catch {}
            }
            const retryType = retryJson?.error?.type || retryJson?.type || errType || "upstream_error";
            const retryMsg =
              retryJson?.error?.message || retryJson?.message || retryText || rawMsg;
            // 报*重试*的状态，不是首次的：上游对刷新后形状的应答不同时
            // 两者就不同（426 下限握手后跟 429 容量应答很常见），
            // 记旧状态会把最终裁定归因错。
            const retryStatus = upstreamRes.status;
            // 首次仍带形态消息时，重试也可能揭示封锁（标志生效期间上游
            // 会混发两种）。这仍是终态：原样回答，
            // 不跑形态审计、不加更新提示。
            if (identity.isIpAbuseRejection(retryStatus, retryMsg)) {
              if (!skipCooldownRetry) {
                上次失败网关重试时间 = Date.now();
                上次失败网关重试纪元 = identity.getState().epoch || 0;
              }
              记录出口失败(egressState, { reason: "ip-abuse block" });
              return 回应IP滥用(
                res,
                retryStatus,
                retryType,
                retryMsg,
                上游日志ID之(upstreamRes),
                targetModel
              );
            }
            const retryFreeTierMsg = /freetiererror|free tier|free models|only available in opencode/i.test(retryMsg);
            const onNode = typeof Bun === "undefined";
            // 429 意味着传输与形状都过了，只剩容量耗尽。把它叫成网关拒绝
            // 会让用户去复查上游已接受的头。
            const capacity = retryStatus === 429;
            if (capacity) {
              上次失败网关重试时间 = 0;
            } else if (!skipCooldownRetry && 是免费档CLI网关错误(retryStatus, retryType, retryMsg)) {
              上次失败网关重试时间 = Date.now();
              上次失败网关重试纪元 = identity.getState().epoch || 0;
            }
            // 产生*这次*拒绝的出口已烧完：记下来，下一个请求换一条，
            // 而不是重新学同一限流。429 是无歧义的额度应答，冷却比 403
            // 更长 —— 403 的成因本桥无法完全与形态问题分开。
            记录出口失败(egressState, {
              reason: capacity ? "allowance 429" : `gate ${retryStatus}`,
              cooldownMs: capacity ? proxy.describe().pool.cooldownMs * 4 : null,
            });

            // 网关对被封出口与被拒形态回同一个 `403 FreeTierError`，状态行
            // 与消息分不开两者。能分开的：实际发出的请求是否携带网关检查
            // 的锚点。在这里审计而不是断言成因。实测锚点：名为 `read` 的
            // 工具，以及带会话头的 `opencode/*` User-Agent。
            const shape = 审计网关形态(upstreamBody, retryHeaders || upstreamHeaders);
            const shapeOk = shape.hasReadTool && shape.userAgentOk && shape.sessionHeaders.length > 0;
            const missing = [];
            if (!shape.hasReadTool) missing.push("tool `read`");
            if (!shape.userAgentOk) missing.push("an `opencode/*` User-Agent");
            if (shape.sessionHeaders.length === 0) missing.push("a session header");
            // 这次拒绝的关联 id。上游每个应答都带（接受或拒绝）；这是支持
            // 请求或 bug 报告唯一能引用的凭据。
            const upstreamLogId = 上游日志ID之(upstreamRes);
            上次网关诊断 = {
              at: Date.now(),
              kind: "free-tier-gate",
              status: retryStatus,
              logId: upstreamLogId,
              shape,
              shapeOk,
              missing,
              model: targetModel,
            };

            const verdictText = capacity
              ? "上游已接受传输与请求形状，回的是容量压力：免费额度或该模型的容量耗尽。稍后重试或换模型"
              : retryFreeTierMsg
                ? onNode
                  ? "本进程在 Node 上，TLS ClientHello 与 CLI 不同（实测：同一 IP Node 0/6，Bun 6/6）。先怀疑额度之前，请用 Bun 跑桥 —— `bun server.js`"
                  : shapeOk
                    ? "请求携带了网关检查的每一个锚点，所以问题在出口：按 IP 的免费额度已耗尽，或上游拒绝该网络。真 CLI 从同一 IP 也会得到同样的 403"
                    : `本桥产出了网关拒绝的形态 —— 缺 ${missing.join(", ")}。这是桥的 bug，不是 IP 额度：两种情况返回同一个 403，所以在这里审计`
                : `没有可再应用的身份变更；${UPDATE_HINT}`;
            console.warn(
              `[fucking-opencode] 上游 CLI 网关拒绝 ${
                skipCooldownRetry
                  ? "请求（不重试：冷却生效中）"
                  : "刷新身份后的重试"
              }（${retryStatus}${
                retryStatus !== gateStatus ? `，首次 ${gateStatus}` : ""
              }）：${retryMsg} —— ${verdictText}` +
                (upstreamLogId ? ` [x-opencode-log-id: ${upstreamLogId}]` : "")
            );
            if (capacity && 可切换模型(retryStatus)) {
              模型组.记录失败(targetModel, retryStatus);
              console.warn(
                `[fucking-opencode] 模型 ${targetModel} 容量耗尽（${retryStatus}）；改试 ${候选列表[当前候选 + 1]}`
              );
              continue 模型尝试;
            }
            const outStatus = 解析限流状态(upstreamRes.status, retryFreeTierMsg && !capacity);
            res.writeHead(
              outStatus,
              构建限流头(retryFreeTierMsg && !capacity, {
                shapeOk,
                logId: upstreamLogId,
              })
            );
            return res.end(
              JSON.stringify({
                error: {
                  // 只在形状确实可能过期时才指向更新。额度拒绝已带最新身份，
                  // "更新桥"提示会把用户引向错处。
                  message: retryFreeTierMsg ? retryMsg : `${retryMsg} (${UPDATE_HINT})`,
                  type: retryType,
                  code: outStatus,
                },
              })
            );
          }
          break;
        }

        上次失败网关重试时间 = 0;
        上次IP滥用时间 = 0;
        // 这个出口承载了上游接受的请求，失败史已过期：清掉，
        // 下一次挑选把它当健康。
        proxy.markSuccess(egressState.egressUrl);
        记录匿名成功();
        模型组.记录成功(targetModel);
        const completionId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
        const created = Math.floor(Date.now() / 1000);
        reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // ==========================================
        // 路径 A：客户端要求流式（SSE）
        // ==========================================
        if (clientStream) {
          let sseHeadersSent = false;
          const writeSse = (payload) => {
            if (!sseHeadersSent) {
              sseHeadersSent = true;
              res.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              });
            }
            res.write(payload);
          };
          const emitStreamError = (errMessage, errType) => {
            console.warn(`[fucking-opencode] 上游在流内失败：${errMessage}`);
            reader.cancel().catch(() => {});
            if (!sseHeadersSent) {
              sseHeadersSent = true;
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: {
                    message: errMessage,
                    type: errType || "upstream_error",
                    code: 502,
                  },
                })
              );
              return;
            }
            writeSse(
              `data: ${JSON.stringify({
                error: {
                  message: errMessage,
                  type: errType || "upstream_error",
                  code: 502,
                },
              })}\n\n`
            );
            writeSse("data: [DONE]\n\n");
          };

          if (useResponses) {
            const toolIndexMap = new Map();
            let nextToolIndex = 0;
            let hasToolCalls = false;
            let upstreamFinishReason = null;
            let streamUsage = null;
            let streamAbortedByError = false;

            const handleResponsesStreamLine = (line) => {
              if (streamAbortedByError) return;
              if (!line.startsWith("data: ")) return;
              const rawJson = line.slice(6).trim();
              if (!rawJson || rawJson === "[DONE]") return;
              try {
                const ev = JSON.parse(rawJson);
                const inStreamError = 提取流错误(ev);
                if (inStreamError) {
                  streamAbortedByError = true;
                  emitStreamError(inStreamError, ev?.error?.type);
                  return;
                }
                if (ev.type === "response.output_text.delta" && ev.delta) {
                  writeSse(
                    `data: ${JSON.stringify({
                      id: completionId,
                      object: "chat.completion.chunk",
                      created,
                      model: targetModel,
                      choices: [{ index: 0, delta: { content: ev.delta }, finish_reason: null }],
                    })}\n\n`
                  );
                } else if (
                  (ev.type === "response.reasoning_summary_text.delta" ||
                    ev.type === "response.reasoning_text.delta" ||
                    ev.type === "response.reasoning.delta") &&
                  ev.delta
                ) {
                  writeSse(
                    `data: ${JSON.stringify({
                      id: completionId,
                      object: "chat.completion.chunk",
                      created,
                      model: targetModel,
                      choices: [{ index: 0, delta: { reasoning_content: ev.delta }, finish_reason: null }],
                    })}\n\n`
                  );
                } else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
                  hasToolCalls = true;
                  const key =
                    ev.output_index !== undefined
                      ? String(ev.output_index)
                      : ev.item.call_id || ev.item.id || String(nextToolIndex);
                  let toolIdx = toolIndexMap.get(key);
                  if (toolIdx === undefined) {
                    toolIdx = nextToolIndex++;
                    toolIndexMap.set(key, toolIdx);
                    if (ev.item.call_id) toolIndexMap.set(ev.item.call_id, toolIdx);
                    if (ev.item.id) toolIndexMap.set(ev.item.id, toolIdx);
                    if (ev.output_index !== undefined) toolIndexMap.set(String(ev.output_index), toolIdx);
                  }
                  const restoredName = restoreClientToolName(ev.item.name, aliasToOriginal);
                  writeSse(
                    `data: ${JSON.stringify({
                      id: completionId,
                      object: "chat.completion.chunk",
                      created,
                      model: targetModel,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [
                              {
                                index: toolIdx,
                                id: ev.item.call_id || ev.item.id || `call_${toolIdx}`,
                                type: "function",
                                function: { name: restoredName, arguments: "" },
                              },
                            ],
                          },
                          finish_reason: null,
                        },
                      ],
                    })}\n\n`
                  );
                } else if (ev.type === "response.function_call_arguments.delta" && ev.delta) {
                  const key = ev.output_index !== undefined ? String(ev.output_index) : ev.item_id || ev.call_id;
                  const toolIdx = key !== undefined && toolIndexMap.has(key) ? toolIndexMap.get(key) : 0;
                  writeSse(
                    `data: ${JSON.stringify({
                      id: completionId,
                      object: "chat.completion.chunk",
                      created,
                      model: targetModel,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [{ index: toolIdx, function: { arguments: ev.delta } }],
                          },
                          finish_reason: null,
                        },
                      ],
                    })}\n\n`
                  );
                } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
                  upstreamFinishReason = 提取Responses结束原因(ev, hasToolCalls);
                  if (ev.response?.usage) {
                    streamUsage = {
                      prompt_tokens: ev.response.usage.input_tokens || 0,
                      completion_tokens: ev.response.usage.output_tokens || 0,
                      total_tokens: ev.response.usage.total_tokens || 0,
                    };
                  }
                }
              } catch {}
            };

            await 消费SSE行(reader, decoder, handleResponsesStreamLine, 首事件超时毫秒());
            if (streamAbortedByError) {
              落盘统计(502, { error: "上游在流内失败" });
              if (!res.writableEnded) res.end();
              return;
            }

            const finalFinishReason = upstreamFinishReason || (hasToolCalls ? "tool_calls" : "stop");
            writeSse(
              `data: ${JSON.stringify({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: targetModel,
                choices: [{ index: 0, delta: {}, finish_reason: finalFinishReason }],
              })}\n\n`
            );
            if (body.stream_options?.include_usage && streamUsage) {
              writeSse(
                `data: ${JSON.stringify({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: targetModel,
                  choices: [],
                  usage: streamUsage,
                })}\n\n`
              );
            }
            writeSse("data: [DONE]\n\n");
            落盘统计(200, { input_tokens: streamUsage?.prompt_tokens ?? null, cached_tokens: streamUsage?.prompt_tokens_details?.cached_tokens ?? null, output_tokens: streamUsage?.completion_tokens ?? null });
            return res.end();
          } else {
            // 对话补全接口的 SSE 流
            const hasAliases = aliasToOriginal.size > 0;
            let streamAbortedByError = false;
            let streamUsageStats = null;
            const handleChatStreamLine = (line) => {
              if (streamAbortedByError) return;
              if (!line.startsWith("data: ")) return;
              const raw = line.slice(6).trim();
              if (!raw) return;
              // 首字时间：第一个真实数据块到达此刻。非流式路径写 null。
              if (统计 && 统计.ttft_ms == null) 统计.ttft_ms = Date.now() - 统计.t0;
              if (raw === "[DONE]") {
                writeSse("data: [DONE]\n\n");
                return;
              }
              // 流内失败不是完成。还没发出块时，回 HTTP 502 JSON 让任何
              // 路由或 harness 能故障转移；已发块则发 SSE error 事件。
              if (raw.includes('"error"')) try {
                const maybe = JSON.parse(raw);
                const streamErr = 提取流错误(maybe);
                if (streamErr) {
                  streamAbortedByError = true;
                  emitStreamError(streamErr, maybe?.error?.type);
                  return;
                }
              } catch {}
              // 零解析快路径：无客户端工具被改名、块也不带要归一化的
              // `"reasoning":` 字段时，直接转发原始 SSE 字节。
              if (!hasAliases && !raw.includes('"reasoning"')) {
                writeSse(`data: ${raw}\n\n`);
                return;
              }
              try {
                const chunk = JSON.parse(raw);
                const delta = chunk.choices?.[0]?.delta;
                if (delta && delta.reasoning && !delta.reasoning_content) {
                  delta.reasoning_content = delta.reasoning;
                }
                if (hasAliases && Array.isArray(delta?.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    if (tc.function?.name) {
                      tc.function.name = restoreClientToolName(tc.function.name, aliasToOriginal);
                    }
                  }
                }
                writeSse(`data: ${JSON.stringify(chunk)}\n\n`);
              } catch {
                writeSse(`data: ${raw}\n\n`);
              }
            };

            await 消费SSE行(reader, decoder, handleChatStreamLine, 首事件超时毫秒());
            if (!res.writableEnded) {
              if (!sseHeadersSent) writeSse("data: [DONE]\n\n");
              res.end();
            }
            落盘统计(200, { input_tokens: streamUsageStats?.prompt_tokens ?? null, cached_tokens: streamUsageStats?.prompt_tokens_details?.cached_tokens ?? null, output_tokens: streamUsageStats?.completion_tokens ?? null });
            return;
          }
        }

        // ==========================================
        // 路径 B：客户端要求非流式（JSON）
        // ==========================================
        let assistantText = "";
        let reasoningText = "";
        const toolCalls = [];
        const nonStreamToolMap = new Map();
        let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        let upstreamFinishReason = null;
        let streamError = null;
        let streamUsageStats = null;

        const handleNonStreamLine = (line) => {
          if (!line.startsWith("data: ")) return;
          const rawJson = line.slice(6).trim();
          if (!rawJson || rawJson === "[DONE]") return;

          try {
            const ev = JSON.parse(rawJson);

            // 200 后跟流内错误是失败，不是空完成。没有这段的话，
            // 客户端会拿到 content: null 与 finish_reason "stop"。
            const inStreamError = 提取流错误(ev);
            if (inStreamError) {
              streamError = inStreamError;
              return;
            }

            if (useResponses) {
              if (ev.type === "response.output_text.delta" && ev.delta) {
                assistantText += ev.delta;
              } else if (
                (ev.type === "response.reasoning_summary_text.delta" ||
                  ev.type === "response.reasoning_text.delta" ||
                  ev.type === "response.reasoning.delta") &&
                ev.delta
              ) {
                reasoningText += ev.delta;
              } else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
                const key =
                  ev.output_index !== undefined
                    ? String(ev.output_index)
                    : ev.item.call_id || ev.item.id || String(toolCalls.length);
                const tc = {
                  id: ev.item.call_id || ev.item.id || `call_${toolCalls.length}`,
                  type: "function",
                  function: {
                    name: restoreClientToolName(ev.item.name, aliasToOriginal),
                    arguments: "",
                  },
                };
                toolCalls.push(tc);
                nonStreamToolMap.set(key, tc);
                if (ev.item.call_id) nonStreamToolMap.set(ev.item.call_id, tc);
                if (ev.item.id) nonStreamToolMap.set(ev.item.id, tc);
                if (ev.output_index !== undefined) nonStreamToolMap.set(String(ev.output_index), tc);
              } else if (ev.type === "response.function_call_arguments.delta" && ev.delta) {
                const key =
                  ev.output_index !== undefined ? String(ev.output_index) : ev.item_id || ev.call_id;
                const targetTc =
                  key !== undefined && nonStreamToolMap.has(key)
                    ? nonStreamToolMap.get(key)
                    : toolCalls[toolCalls.length - 1];
                if (targetTc) targetTc.function.arguments += ev.delta;
              } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
                upstreamFinishReason = 提取Responses结束原因(ev, toolCalls.length > 0);
                if (ev.response?.usage) {
                  usage = {
                    prompt_tokens: ev.response.usage.input_tokens || 0,
                    completion_tokens: ev.response.usage.output_tokens || 0,
                    total_tokens: ev.response.usage.total_tokens || 0,
                  };
                }
              }
            } else {
              // 对话补全格式解析
              const choice = ev.choices?.[0];
              if (choice?.finish_reason) {
                upstreamFinishReason = choice.finish_reason;
              }
              const delta = choice?.delta;
              if (delta?.content) assistantText += delta.content;
              if (delta?.reasoning) reasoningText += delta.reasoning;
              else if (delta?.reasoning_content) reasoningText += delta.reasoning_content;
              if (Array.isArray(delta?.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? toolCalls.length;
                  if (!toolCalls[idx]) {
                    toolCalls[idx] = {
                      id: tc.id || `call_${idx}`,
                      type: "function",
                      function: {
                        name: restoreClientToolName(tc.function?.name || "", aliasToOriginal),
                        arguments: "",
                      },
                    };
                  } else {
                    if (tc.id && toolCalls[idx].id.startsWith("call_")) {
                      toolCalls[idx].id = tc.id;
                    }
                    if (tc.function?.name && !toolCalls[idx].function.name) {
                      toolCalls[idx].function.name = restoreClientToolName(
                        tc.function.name,
                        aliasToOriginal
                      );
                    }
                  }
                  if (tc.function?.arguments) {
                    toolCalls[idx].function.arguments += tc.function.arguments;
                  }
                }
              }
              if (ev.usage && typeof ev.usage === "object") {
                usage = {
                  prompt_tokens: ev.usage.prompt_tokens || 0,
                  completion_tokens: ev.usage.completion_tokens || 0,
                  total_tokens: ev.usage.total_tokens || 0,
                };
              }
              // 统计：非流式路径这里直接记 usage（handleNonStreamLine 的 ev）。
              if (ev.usage && typeof ev.usage === "object") streamUsageStats = ev.usage;
            }
          } catch {}
        };

        await 消费SSE行(reader, decoder, handleNonStreamLine, 首事件超时毫秒());

        if (streamError) {
          console.warn(`[fucking-opencode] 上游在流内失败：${streamError}`);
          落盘统计(502, { error: streamError });
          res.writeHead(502, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: { message: streamError, type: "upstream_error", code: 502 },
            })
          );
        }

        const validToolCalls = toolCalls.filter(Boolean);
        const messageObj = { role: "assistant", content: assistantText || null };
        if (reasoningText) messageObj.reasoning_content = reasoningText;
        if (validToolCalls.length > 0) messageObj.tool_calls = validToolCalls;

        let finishReason = upstreamFinishReason || "stop";
        if (
          validToolCalls.length > 0 &&
          finishReason !== "length" &&
          finishReason !== "content_filter"
        ) {
          finishReason = "tool_calls";
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        落盘统计(200, { input_tokens: usage.prompt_tokens, cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? null, output_tokens: usage.completion_tokens });
        return res.end(
          JSON.stringify({
            id: completionId,
            object: "chat.completion",
            created,
            model: targetModel,
            choices: [
              {
                index: 0,
                message: messageObj,
                finish_reason: finishReason,
              },
            ],
            usage,
          })
        );
      } catch (err) {
        if (reader) {
          reader.cancel().catch(() => {});
        }
        if (clientDisconnected || res.writableEnded) {
          return;
        }
        if (err && err.code === "first_event_timeout") {
          记录出口失败(egressState, { reason: "first_event_timeout" });
          console.warn(
            `[fucking-opencode] 上游 ${proxy.displayHost(egressState.egressUrl) || "direct"} 首个事件超时（${首事件超时毫秒()}ms），出口已进入冷却。`
          );
          const 错误体 = {
            message: `Upstream sent no first event within ${首事件超时毫秒()}ms; the egress was cooled and the request may be retried.`,
            type: "first_event_timeout",
            code: 504,
          };
          落盘统计(504, { error: "上游首个事件超时" });
          if (!res.headersSent) {
            res.writeHead(504, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: 错误体 }));
          }
          try {
            res.write(`data: ${JSON.stringify({ error: 错误体 })}\n\ndata: [DONE]\n\n`);
          } catch {}
          return res.end();
        }
        if (timedOut) {
          落盘统计(504, { error: "上游请求超时" });
          if (!res.headersSent) {
            res.writeHead(504, { "Content-Type": "application/json" });
            return res.end(
              JSON.stringify({
                error: {
                  message: `Upstream request timed out after ${上游超时毫秒()}ms`,
                  type: "timeout_error",
                  code: 504,
                },
              })
            );
          }
          return res.end();
        }
        console.error("[fucking-opencode] 异常：", err);
        落盘统计(500, { error: err.message || "服务器内部错误" });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: { message: err.message || "服务器内部错误", type: "server_error" },
            })
          );
        }
        return res.end();
      }
      }
      res.off("close", onClose);
      clearTimeout(timeoutId);
      if (!res.headersSent && !res.writableEnded) {
        落盘统计(502, { error: "所有候选模型均失败" });
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: { message: "所有候选模型均失败", type: "upstream_error", code: 502 },
          })
        );
      }
    })();
    return;
  }

  // ------------------------------------------------------------------
  // 协议兼容路由：/v1/messages（Anthropic）与 /v1/responses（Responses）。
  // 都在桥内自call /v1/chat/completions 处理器 —— 网关自愈、出口池、
  // 形态审计全部复用，绝不向上游发第二套协议形状。
  // ------------------------------------------------------------------
  if (req.method === "POST" && (pathname === "/v1/messages" || pathname === "/messages")) {
    const 密钥拒绝 = 检查API密钥(req);
    if (密钥拒绝) {
      const headers = { "Content-Type": "application/json" };
      if (密钥拒绝.__retryAfter) headers["Retry-After"] = String(密钥拒绝.__retryAfter);
      res.writeHead(密钥拒绝.__status || 401, headers);
      return res.end(JSON.stringify({ type: "error", error: 密钥拒绝.error }));
    }
    const 并发槽 = await 申请并发槽();
    if (!并发槽) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
      return res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "网关繁忙：在途请求已满，请稍后重试。" } }));
    }
    挂接并发释放(res, 并发槽);
    return 处理Anthropic消息(req, res);
  }
  if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
    const 密钥拒绝 = 检查API密钥(req);
    if (密钥拒绝) {
      const headers = { "Content-Type": "application/json" };
      if (密钥拒绝.__retryAfter) headers["Retry-After"] = String(密钥拒绝.__retryAfter);
      res.writeHead(密钥拒绝.__status || 401, headers);
      return res.end(JSON.stringify({ type: "error", error: 密钥拒绝.error }));
    }
    return 处理Anthropic计数(req, res);
  }
  if (req.method === "POST" && (pathname === "/v1/completions" || pathname === "/completions")) {
    const 密钥拒绝 = 检查API密钥(req);
    if (密钥拒绝) {
      const headers = { "Content-Type": "application/json" };
      if (密钥拒绝.__retryAfter) headers["Retry-After"] = String(密钥拒绝.__retryAfter);
      res.writeHead(密钥拒绝.__status || 401, headers);
      return res.end(JSON.stringify({ error: 密钥拒绝.error }));
    }
    const 并发槽 = await 申请并发槽();
    if (!并发槽) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
      return res.end(JSON.stringify({ error: { message: "网关繁忙：在途请求已满，请稍后重试。", type: "rate_limit_error", code: "gateway_busy" } }));
    }
    挂接并发释放(res, 并发槽);
    return 处理旧式完成(req, res);
  }
  if (req.method === "POST" && (pathname === "/v1/embeddings" || pathname === "/embeddings")) {
    res.writeHead(501, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "上游免费层不提供 embeddings；请改用 /v1/chat/completions 或 /v1/completions。", type: "invalid_request_error", code: "embeddings_not_supported" } }));
  }
  if (req.method === "POST" && (pathname === "/v1/responses" || pathname === "/responses")) {
    const 密钥拒绝 = 检查API密钥(req);
    if (密钥拒绝) {
      const headers = { "Content-Type": "application/json" };
      if (密钥拒绝.__retryAfter) headers["Retry-After"] = String(密钥拒绝.__retryAfter);
      res.writeHead(密钥拒绝.__status || 401, headers);
      return res.end(JSON.stringify({ error: 密钥拒绝.error }));
    }
    const 并发槽 = await 申请并发槽();
    if (!并发槽) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
      return res.end(JSON.stringify({ error: { message: "网关繁忙：在途请求已满，请稍后重试。", type: "rate_limit_error", code: "gateway_busy" } }));
    }
    挂接并发释放(res, 并发槽);
    return 处理Responses请求(req, res);
  }

  // 诊断：按出口/模型的 429、5xx、连续成功，加上模型冷却与最近网关拒绝。
  if (pathname === "/api/diagnostics" && req.method === "GET") {
    if (!panelAuthorized(req)) return panelUnauthorized(res);
    const 地址 = new URL(req.url, `http://${req.headers?.host || "127.0.0.1"}`);
    const hours = Math.min(168, Math.max(1, Number(地址.searchParams.get("hours")) || 24));
    const out = 用量统计 && 用量统计.诊断汇总
      ? 用量统计.诊断汇总({ hours })
      : { hours, total: 0, egress: [], models: [] };
    out.cooldowns = 模型组.诊断();
    out.gateway = 上次网关诊断 || null;
    out.upstream_error = 上次上游错误 || null;
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(out));
  }

  // 面板日志：事件环 + WARP farm sidecar 的 stdout/stderr 尾部。
  if (pathname === "/api/logs" && req.method === "GET") {
    if (!panelAuthorized(req)) return panelUnauthorized(res);
    const 地址 = new URL(req.url, `http://${req.headers?.host || "127.0.0.1"}`);
    const lines = Math.min(500, Math.max(10, Number(地址.searchParams.get("lines")) || 200));
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(
      JSON.stringify({
        events: 事件环.slice(-lines),
        farm: warpFarm.日志(lines),
        last: 事件序号,
      })
    );
  }

  // 清空模型冷却（面板「模型冷却」表的重置按钮）。
  if (pathname === "/api/model-health/reset" && req.method === "POST") {
    const denied = adminRequestError(req);
    if (denied) {
      res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: denied }));
    }
    if (!panelAuthorized(req)) return panelUnauthorized(res);
    const type = String(req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") {
      res.writeHead(415, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: "Content-Type harus application/json." }));
    }
    const result = 模型组.重置();
    记录事件(`模型冷却已清空（${result.cleared} 条）`, "info");
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ ...result, cooldowns: 模型组.诊断() }));
  }

  // 额度摘要：近 24 小时的 429/失败计数、模型冷却与 farm lane 就绪数。
  if (pathname === "/api/quota" && req.method === "GET") {
    if (!panelAuthorized(req)) return panelUnauthorized(res);
    const diag =
      用量统计 && 用量统计.诊断汇总 ? 用量统计.诊断汇总({ hours: 24 }) : { total: 0, models: [], egress: [] };
    const farm = warpFarm.状态();
    const rate429 = (diag.models || []).reduce((n, m) => n + (m.rate429 || 0), 0);
    const fail = (diag.models || []).reduce((n, m) => n + (m.fail || 0), 0);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(
      JSON.stringify({
        hours: 24,
        total: diag.total || 0,
        rate429,
        fail,
        cooldowns: 模型组.诊断().length,
        farm: {
          running: Boolean(farm.running),
          ready: (farm.lanes || []).filter((lane) => lane.ready).length,
          lanes: (farm.lanes || []).length,
        },
        gate: 上次网关诊断 || null,
      })
    );
  }

  // 用量统计与请求历史（面板标签页的数据源）。
  if (pathname === "/api/stats" || pathname === "/api/history" || pathname === "/api/history/clear") {
    if (!panelAuthorized(req)) return panelUnauthorized(res);
    return 处理统计API(req, res, pathname);
  }

  // 事件流：面板的实时日志环。与统计同一个管理面（面板会话鉴权把守）。
  if (pathname === "/api/events" && req.method === "GET") {
    if (!panelAuthorized(req)) return panelUnauthorized(res);
    const 地址 = new URL(req.url, `http://${req.headers?.host || "127.0.0.1"}`);
    const 起点 = Number(地址.searchParams.get("after")) || 0;
    const 事件 = 事件环.filter((e) => e.序号 > 起点);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ events: 事件, last: 事件序号 }));
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }));
}

/** 自call 桥自己的 /v1/chat/completions：把已翻译的 OpenAI 体发回本桥，
 *  收集响应（JSON 或 SSE 文本），返回 { status, contentType, text, headers }。
 *  用 http.request 走真实端口，这样网关重试、身份、会话亲和全部一致。 */
function 桥内自调用(oaiBody, reqId) {
  const http = require("http");
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(oaiBody);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        method: "POST",
        path: "/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          // 会话亲和：同一逻辑对话沿用同一会话头。
          "X-OpenCode-Session": reqId,
          // 内部跳转凭据：跳过鉴权、额度计数与并发闸门。
          "X-Internal-Hop": 内部令牌,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            contentType: res.headers["content-type"] || "",
            requestId: res.headers["x-request-id"] || reqId,
            egress: res.headers["x-gateway-egress"] || "",
            text: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    req.setTimeout(上游超时毫秒() + 5000, () => req.destroy(new Error("上游请求超时")));
    req.end(payload);
  });
}

/** POST /v1/completions —— OpenAI 旧版 Completions：翻译成 Chat 后回译。 */
async function 处理旧式完成(req, res) {
  let body;
  try {
    body = JSON.parse(await readRequestBody(req));
    if (!body || typeof body !== "object") throw new Error("invalid");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "无效的 JSON 请求体", type: "invalid_request_error" } }));
  }
  if (!body.model) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "缺少必填参数：model", type: "invalid_request_error" } }));
  }
  const 原始 = Array.isArray(body.prompt) ? body.prompt : [body.prompt == null ? "" : body.prompt];
  if (原始.length === 0 || 原始.length > 8 || !原始.every((p) => typeof p === "string")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "prompt 必须是字符串或 1–8 个字符串的数组", type: "invalid_request_error" } }));
  }
  const 统计 = 用量统计 ? { t0: Date.now(), protocol: "completions", stream: Boolean(body.stream), request_id: 用量统计.新请求标识(), ...用量标签(req) } : null;
  if (统计) res.setHeader("X-Request-Id", 统计.request_id);
  const 落盘 = (status, extra = {}) => {
    if (!统计) return;
    用量统计.记录请求({ ...统计, model: body.model, status, ms: Date.now() - 统计.t0, ...extra });
  };

  const 模型许可 = 检查模型许可(req, body.model);
  if (模型许可) {
    落盘(403);
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { ...模型许可, param: "model" } }));
  }

  const 参数 = {};
  for (const key of ["max_tokens", "temperature", "top_p", "stop", "presence_penalty", "frequency_penalty", "seed"]) {
    if (body[key] !== undefined) 参数[key] = body[key];
  }

  try {
    const 结果 = await Promise.all(
      原始.map((prompt, index) =>
        桥内自调用(
          { model: body.model, messages: [{ role: "user", content: prompt }], ...参数, stream: false },
          统计 ? `${统计.request_id}-${index}` : `completions-${index}`
        )
      )
    );
    const 失败 = 结果.find((r) => r.status !== 200);
    if (失败) {
      let errMsg = "上游错误";
      try {
        errMsg = JSON.parse(失败.text)?.error?.message || 失败.text.slice(0, 200);
      } catch {}
      落盘(失败.status, { error: errMsg, egress: 失败.egress || undefined });
      res.writeHead(失败.status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: errMsg, type: "api_error" } }));
    }

    let 用量 = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const choices = 结果.map((r, index) => {
      let 完成 = null;
      try {
        完成 = JSON.parse(r.text);
      } catch {}
      const choice = 完成?.choices?.[0];
      if (完成?.usage && index === 0) 用量 = 完成.usage;
      const text = choice?.message?.content;
      return {
        text: typeof text === "string" ? text : "",
        index,
        logprobs: null,
        finish_reason: choice?.finish_reason || "stop",
      };
    });
    const id = `cmpl-${统计?.request_id || Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const 结果体 = { id, object: "text_completion", created, model: body.model, choices, usage: 用量 };

    if (body.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      for (const choice of choices) {
        res.write(`data: ${JSON.stringify({ id, object: "text_completion", created, model: body.model, choices: [choice] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      落盘(200, { input_tokens: 用量.prompt_tokens, output_tokens: 用量.completion_tokens });
      return res.end();
    }
    落盘(200, { input_tokens: 用量.prompt_tokens, output_tokens: 用量.completion_tokens });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(结果体));
  } catch (err) {
    落盘(502, { error: err.message });
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: err.message, type: "api_error" } }));
  }
}

/** POST /v1/messages —— Anthropic Messages 协议。 */
async function 处理Anthropic消息(req, res) {
  if (!compat) {
    res.writeHead(501, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "compat.js 未安装，Anthropic 协议不可用。", type: "unavailable" } }));
  }
  let anthropicBody;
  try {
    anthropicBody = JSON.parse(await readRequestBody(req));
    if (!anthropicBody || typeof anthropicBody !== "object") throw new Error("invalid");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      error: { type: "invalid_request_error", message: "无效的 JSON 请求体" },
    }));
  }
  const 统计 = 用量统计 ? { t0: Date.now(), protocol: "anthropic", stream: Boolean(anthropicBody.stream), request_id: 用量统计.新请求标识(), ...用量标签(req) } : null;
  if (统计) res.setHeader("X-Request-Id", 统计.request_id);
  const 落盘 = (status, extra = {}) => {
    if (!统计) return;
    用量统计.记录请求({ ...统计, model: anthropicBody.model || "", status, ms: Date.now() - 统计.t0, ...extra });
  };

  const { oai } = compat.Anthropic请求转OpenAI(anthropicBody);
  if (!oai.model) {
    落盘(400);
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "缺少必填参数：model" } }));
  }
  const 模型许可 = 检查模型许可(req, oai.model);
  if (模型许可) {
    落盘(403);
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: 模型许可.message } }));
  }
  if (!Array.isArray(oai.messages) || oai.messages.length === 0) {
    落盘(400);
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "messages 不能为空" } }));
  }

  try {
    const resp = await 桥内自调用(oai, 统计?.request_id || "anthropic");
    // 上游错误按 Anthropic 形状透传。
    if (resp.status !== 200) {
      let errMsg = "上游错误";
      try {
        const j = JSON.parse(resp.text);
        errMsg = j?.error?.message || resp.text.slice(0, 200);
      } catch {}
      落盘(resp.status, { error: errMsg, egress: resp.egress || undefined });
      res.writeHead(resp.status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: errMsg } }));
    }

    if (anthropicBody.stream && /text\/event-stream/.test(resp.contentType)) {
      // 流式：OpenAI chunk 流 → Anthropic 事件流。
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      const 变换 = compat.创建Anthropic流变换(anthropicBody.model);
      const write = (s) => res.write(s);
      for (const line of resp.text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          变换.chunk(JSON.parse(raw), write);
        } catch {}
      }
      变换.finish(write);
      res.end();
      落盘(200, { input_tokens: 变换.usage.input_tokens, cached_tokens: 变换.usage.cached_tokens ?? null, output_tokens: 变换.usage.output_tokens, egress: resp.egress || undefined });
      return;
    }

    // 非流式：折成 Anthropic Messages 完成体。
    let oaiJson;
    try {
      oaiJson = JSON.parse(resp.text);
    } catch {
      落盘(502, { error: "上游返回非 JSON" });
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "上游返回非 JSON" } }));
    }
    const out = compat.OpenAI完成到Anthropic(oaiJson, anthropicBody.model);
    落盘(200, { input_tokens: out.usage.input_tokens, cached_tokens: out.usage.cached_tokens ?? null, output_tokens: out.usage.output_tokens, egress: resp.egress || undefined });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(out));
  } catch (err) {
    落盘(502, { error: err.message });
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } }));
  }
}

/** POST /v1/messages/count_tokens —— 近似计数（4 字符/词元），不触上游。 */
async function 处理Anthropic计数(req, res) {
  if (!compat) {
    res.writeHead(501, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "compat.js 未安装。", type: "unavailable" } }));
  }
  let body;
  try {
    body = JSON.parse(await readRequestBody(req));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "无效的 JSON 请求体" } }));
  }
  const { oai, systemText } = compat.Anthropic请求转OpenAI(body) || {};
  const tokens = compat.估算词元(oai?.messages, systemText, oai?.tools);
  res.writeHead(200, { "Content-Type": "application/json" });
  return res.end(JSON.stringify({ input_tokens: tokens }));
}

/** POST /v1/responses —— Responses 接口协议。 */
async function 处理Responses请求(req, res) {
  if (!compat) {
    res.writeHead(501, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "compat.js 未安装，Responses 协议不可用。", type: "unavailable" } }));
  }
  let responsesBody;
  try {
    responsesBody = JSON.parse(await readRequestBody(req));
    if (!responsesBody || typeof responsesBody !== "object") throw new Error("invalid");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "无效的 JSON 请求体", type: "invalid_request_error" } }));
  }
  const 统计 = 用量统计 ? { t0: Date.now(), protocol: "responses", stream: Boolean(responsesBody.stream), request_id: 用量统计.新请求标识(), ...用量标签(req) } : null;
  if (统计) res.setHeader("X-Request-Id", 统计.request_id);
  const 落盘 = (status, extra = {}) => {
    if (!统计) return;
    用量统计.记录请求({ ...统计, model: responsesBody.model || "", status, ms: Date.now() - 统计.t0, ...extra });
  };

  const oai = compat.Responses请求转OpenAI(responsesBody);
  if (!oai.model) {
    落盘(400);
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "缺少必填参数：model", type: "invalid_request_error" } }));
  }
  const 模型许可 = 检查模型许可(req, oai.model);
  if (模型许可) {
    落盘(403);
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { type: "invalid_request_error", message: 模型许可.message } }));
  }

  try {
    const resp = await 桥内自调用(oai, 统计?.request_id || "responses");
    if (resp.status !== 200) {
      let errMsg = "上游错误";
      try {
        errMsg = JSON.parse(resp.text)?.error?.message || resp.text.slice(0, 200);
      } catch {}
      落盘(resp.status, { error: errMsg, egress: resp.egress || undefined });
      res.writeHead(resp.status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: errMsg, type: "api_error" } }));
    }

    if (responsesBody.stream && /text\/event-stream/.test(resp.contentType)) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      const 变换 = compat.创建Responses流变换(responsesBody.model);
      const write = (s) => res.write(s);
      for (const line of resp.text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          变换.chunk(JSON.parse(raw), write);
        } catch {}
      }
      变换.finish(write);
      res.end();
      落盘(200);
      return;
    }

    let oaiJson;
    try {
      oaiJson = JSON.parse(resp.text);
    } catch {
      落盘(502, { error: "上游返回非 JSON" });
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "上游返回非 JSON", type: "api_error" } }));
    }
    const out = compat.OpenAI完成到Responses(oaiJson);
    落盘(200, { input_tokens: out.usage.input_tokens, cached_tokens: out.usage.cached_tokens ?? null, output_tokens: out.usage.output_tokens, egress: resp.egress || undefined });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(out));
  } catch (err) {
    落盘(502, { error: err.message });
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: err.message, type: "api_error" } }));
  }
}

/** GET /api/stats（汇总）与 /api/history（最近请求，?limit=）。 */
function 处理统计API(req, res, pathname) {
  if (!用量统计) {
    res.writeHead(501, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "stats.js 未安装。" }));
  }
  const url = new URL(req.url, `http://${req.headers?.host || "127.0.0.1"}`);
  const days = Number(url.searchParams.get("days")) || 0;
  const from = days > 0 ? Date.now() - days * 24 * 3600 * 1000 : null;
  if (pathname === "/api/stats") {
    const out = 用量统计.汇总(from != null ? { from } : {});
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(out));
  }
  // 清空历史（面板按钮）。与 /api/proxy 同一个管理面：JSON Content-Type
  // 与 Host 检查由上游的管理面门禁统一把守。
  if (pathname === "/api/history/clear" && req.method === "POST") {
    const out = 用量统计.清空历史({});
    res.writeHead(out.ok ? 200 : 500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(out));
  }
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
  let rows = 用量统计.读历史();
  if (from != null) rows = rows.filter((r) => r.at >= from);
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  return res.end(JSON.stringify({ requests: rows.slice(-limit).reverse(), file: 用量统计.用量文件路径() }));
}

async function 消费SSE行(reader, decoder, onLine, 首事件毫秒 = 0) {
  let buffer = "";
  let 首个块 = true;
  while (true) {
    const { done, value } =
      首个块 && 首事件毫秒 > 0 ? await 读首个数据块(reader, 首事件毫秒) : await reader.read();
    首个块 = false;
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        let start = 0;
        for (let i = 0; i < buffer.length; i++) {
          if (buffer.charCodeAt(i) === 10) {
            const line =
              i > start && buffer.charCodeAt(i - 1) === 13
                ? buffer.slice(start, i - 1)
                : buffer.slice(start, i);
            onLine(line);
            start = i + 1;
          }
        }
        if (start < buffer.length) {
          const tail = buffer.endsWith("\r") ? buffer.slice(start, -1) : buffer.slice(start);
          onLine(tail);
        }
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer.charCodeAt(i) === 10) {
        const line =
          i > start && buffer.charCodeAt(i - 1) === 13
            ? buffer.slice(start, i - 1)
            : buffer.slice(start, i);
        onLine(line);
        start = i + 1;
      }
    }
    buffer = start === 0 ? buffer : buffer.slice(start);
  }
}

function 主端口处理器(req, res) {
  处理请求(req, res);
}

function 管理端口处理器(req, res) {
  req.__adminPort = true;
  处理请求(req, res);
}

/** 可选 TLS：同时设置 PANEL_TLS_CERT 与 PANEL_TLS_KEY 时改用 https。 */
function 创建HTTP服务器(处理器) {
  const certFile = String(process.env.PANEL_TLS_CERT || "").trim();
  const keyFile = String(process.env.PANEL_TLS_KEY || "").trim();
  if (!certFile || !keyFile) return http.createServer(处理器);
  const fs = require("fs");
  const https = require("https");
  return https.createServer(
    { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) },
    处理器
  );
}

const server = 创建HTTP服务器(主端口处理器);
let adminServer = null;

// 只在直接执行（`node server.js`）时自动启动，单元测试可以
// require("./server") 而不绑默认端口、不起定时器。
// 传输指纹是 HTTP 运行时的属性，不是这段代码的属性。
// 同一 IP 同一分钟、相同的头与体实测：真 CLI 与本桥在 Bun 上都答 200，
// 而本桥在 Node 上与 curl 都答 403。CLI 以 Bun 二进制发行，网关检查
// 它的 ClientHello。Node 因此不能承载真实流量，启动即拒绝，
// 而不是放着跑然后每个请求都失败。
const ON_BUN = typeof Bun !== "undefined";
const ALLOW_NODE = process.env.ALLOW_NODE === "1";

function 拒绝Node运行时() {
  const lines = [
    "",
      "  fucking-opencode requires Bun.",
    "",
    "  本进程是 Node，其 TLS 传输会被免费档网关拒绝：",
    "  同一 IP、同一分钟、逐字节相同的头与体，Node 0/6 应答，Bun 6/6。",
    "",
    "  CLI 以 Bun 二进制发行，只有 Bun 能复现其传输。",
    "",
    "  安装 Bun：     curl -fsSL https://bun.sh/install | bash",
    "  然后运行：     bun server.js",
    "",
    "  离线工作（测试、演练、查看 /v1/models）设 ALLOW_NODE=1。",
    "  真实聊天请求仍会被上游以 403 拒绝。",
    "",
  ];
  console.error(lines.join("\n"));
}

if (require.main === module) {
  if (!ON_BUN && !ALLOW_NODE) {
    拒绝Node运行时();
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    console.log(`[fucking-opencode] v${VERSION} 已监听 http://${HOST}:${PORT}`);
    if (!ON_BUN) {
      console.log(
        "[fucking-opencode] 警告：ALLOW_NODE=1 —— 正在用 Node 运行。真实聊天请求会被免费档网关以 403 拒绝。" +
          "此模式仅用于对着 mock 上游做离线工作，不能承载真实流量。"
      );
    }
  });
  if (分离管理端口) {
    adminServer = 创建HTTP服务器(管理端口处理器);
    adminServer.on("error", (err) => {
      console.error(`[fucking-opencode] 管理端口 ${ADMIN_PORT} 启动失败：${err.message}`);
      process.exit(1);
    });
    adminServer.listen(ADMIN_PORT, ADMIN_BIND, () => {
      console.log(`[fucking-opencode] 管理面板已监听 http://${ADMIN_BIND}:${ADMIN_PORT}`);
    });
  }
  // socket 打开后修复半安装的树（不知道 proxy.js/panel.js 的旧自更新器），
  // 网络慢或缺席绝不拖慢启动。面板逐请求读当前绑定，
  // 修复一落地就能用。
  repairMissingModules().catch(() => {});
  // 发现跑后台：上游一应答 /v1/models 即上线。启动绝不在网络上阻塞。
  discoverModels().catch(() => {});
  // WARP farm 仅在 WARP_FARM=1 时自启。启动本身是异步的（注册 WARP 可能
  // 被 Cloudflare 限流），所以绝不在监听端口前等待。
  warpFarm
    .自动启动()
    .then((result) => {
      if (!result || result.skipped) return;
      if (result.ok) {
        const applied = warpFarm.应用到池(warpFarm.状态());
        if (!applied || !applied.ok) {
          console.warn(`[fucking-opencode] WARP farm 已启动，但写入代理池失败：${(applied && applied.error) || "unknown"}`);
        }
        console.log(
          `[fucking-opencode] WARP farm: ${result.ready || 0}/${(result.lanes || []).length} lane siap ` +
            `(control ${warpFarm.controlUrl ? warpFarm.controlUrl() : "-"}, pool ${applied && applied.ok ? "ok" : "gagal"})`
        );
      } else {
        console.warn(`[fucking-opencode] WARP farm 未启动：${result.error || "unknown"}`);
      }
    })
    .catch(() => {});
  setInterval(() => {
    const state = warpFarm.状态();
    if (state && state.running) warpFarm.刷新().catch(() => {});
  }, 30000).unref();
  // 模型清单按上游的节奏轮换，所以留定时器。IDENTITY 不留：它按请求路径
  // 惰性刷新（见 identity.ensureFresh），空闲的桥一个网络调用都不发。
  setInterval(discoverModels, DISCOVERY_TTL_MS).unref();
}

module.exports = {
  VERSION,
  __panelSession: { sign: 面板会话签名, reset: 重置面板会话密钥, verify: panelAuthorized, clear: panelClearCookie },
  // e2e 测试起真实端口用：与内部 server 同一个处理器。
  __getHandler: () => 处理请求,
  // 为照着旧冻结常量写的调用点与测试保留。这些是解析后 profile 的
  // 实时视图，不是快照。
  get FINGERPRINT_TOOL_NAMES() {
    return 取指纹名();
  },
  get FINGERPRINT_TOOL_DEFINITIONS() {
    return 取指纹定义();
  },
  get CANONICAL_TOOLS_CHAT() {
    return 取规范工具(false);
  },
  get CANONICAL_TOOLS_RESPONSES() {
    return 取规范工具(true);
  },
  MAX_SESSIONS,
  SESSION_TTL_MS,
  sessionCache,
  createId,
  isValidV2UserAgent,
  normalizeModel,
  isResponsesModel,
  markProtocolSupport,
  __resetProtocolLanes,
  __resetAnonymousBackoff() {
    匿名退避缓存 = null;
  },
  extractContent: 提取内容,
  transformToResponsesInput: 变换为Responses输入,
  transformChatMessages: 变换对话消息,
  prepareToolsWithFingerprint,
  prepareResponsesTools: 准备Responses工具,
  prepareChatTools: 准备对话工具,
  restoreClientToolName,
  buildUpstreamPayload,
  isNewerVersion: 是更新版本,
  checkAndApplyUpdate: 检查并应用更新,
  resolveEndpoints: 解析端点,
  buildUpstreamHeaders,
  getProjectId: 取项目标识,
  newProjectId: 新项目标识,
  extractResponsesFinishReason: 提取Responses结束原因,
  extractStreamError: 提取流错误,
  getPersistentSessionId,
  discoverModels,
  handleRequest: 处理请求,
  server,
  shortText: 短文本,
  messageSignatureSample: 消息签名样本,
  transformResponsesContent: 变换Responses内容,
  extractSystemInstructions: 提取系统指令,
  isLocalOrigin: 是本机来源,
  isFreeTierCliGateError: 是免费档CLI网关错误,
  consumeSseLines: 消费SSE行,
  readRequestBody,
  refreshCliVersion: 刷新CLI版本,
  identity,
  __getUserAgent: () => 当前UA,
  __syncUserAgent: 同步UA,
  __getGateDiagnostic: () => 上次网关诊断,
  __getLastUpstreamError: () => 上次上游错误,
  __auditGateShape: 审计网关形态,
  gateSafeUserAgent: 网关安全UA,
  DISCOVERY_TTL_MS,
  CLI_VERSION_TTL_MS,
  __setLastDiscoveryTime: (v) => { 上次发现时间 = v; },
  __setActiveModels: (m) => {
    在线模型表 = Array.isArray(m) ? m : [];
    重建发现负载();
  },
  __getDiscoveryState: () => ({ inFlight: !!发现进行中, lastDiscoveryTime: 上次发现时间, activeModels: 在线模型表 }),
  __setLastCliVersionCheckTime: (v) => { 上次CLI版本检查时间 = v; },
  __getCliVersionState: () => ({ lastCliVersionCheckTime: 上次CLI版本检查时间 }),
  __setLastUpdateCheck: (v) => { 上次更新检查 = v; },
  __localRequires: 本地require,
  __repairMissingModules: repairMissingModules,
  __adminRequestError: adminRequestError,
};
