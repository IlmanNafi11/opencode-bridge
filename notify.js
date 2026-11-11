const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 出站告警路由：多目标 webhook、级别过滤、安静时段、重试与去重。
// 目标保存在 <状态目录>/notify.json（0600）；URL 只以 host 形式回显。
const 级别 = { info: 0, warn: 1, critical: 2 };
const 级别名 = ["info", "warn", "critical"];
const 去重窗口毫秒 = 5 * 60 * 1000;
const 默认 = { targets: [], quietFrom: "", quietTo: "", perMinute: 10, retryMax: 1 };
let 设置 = { ...默认 };
let 已载入 = false;
let 最近 = new Map();
let 发送窗口 = [];
let 发送中 = Promise.resolve();
const 历史 = [];
let 网络请求 = (url, init) => fetch(url, init);

function 状态目录() {
  const raw = process.env.FUCKING_OPENCODE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return path.join(os.homedir(), ".fucking-opencode");
}

function 设置文件() {
  return path.join(状态目录(), "notify.json");
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function 类型(url) {
  return /discord(app)?\.com\/api\/webhooks/i.test(url) ? "discord" : /api\.telegram\.org/i.test(url) ? "telegram" : "generic";
}

function 收窄目标(raw = {}) {
  const url = String(raw.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const minLevel = 级别名.includes(raw.minLevel) ? raw.minLevel : "warn";
  return {
    id: String(raw.id || `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`).slice(0, 64),
    name: String(raw.name || safeHost(url) || "webhook").slice(0, 60),
    url,
    minLevel,
    enabled: raw.enabled !== false,
  };
}

function 收窄(raw = {}) {
  const out = { ...默认 };
  if (Array.isArray(raw.targets)) out.targets = raw.targets.map(收窄目标).filter(Boolean).slice(0, 10);
  for (const key of ["quietFrom", "quietTo"]) {
    if (typeof raw[key] !== "string") continue;
    const value = raw[key].trim();
    out[key] = /^\d{1,2}:\d{2}$/.test(value) ? value : "";
  }
  const perMinute = Number(raw.perMinute);
  if (Number.isFinite(perMinute)) out.perMinute = Math.min(Math.max(Math.floor(perMinute), 1), 120);
  const retryMax = Number(raw.retryMax);
  if (Number.isFinite(retryMax)) out.retryMax = Math.min(Math.max(Math.floor(retryMax), 0), 3);
  return out;
}

function 读取() {
  if (已载入) return 设置;
  已载入 = true;
  try {
    设置 = 收窄(JSON.parse(fs.readFileSync(设置文件(), "utf8")));
  } catch {
    设置 = { ...默认 };
  }
  return 设置;
}

function 写入() {
  const file = 设置文件();
  const 临时 = `${file}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(临时, JSON.stringify(设置, null, 2), { mode: 0o600 });
    fs.renameSync(临时, file);
  } catch {
    try { fs.unlinkSync(临时); } catch {}
  }
}

/** 合并面板提交：空 URL 且同名 id 存在时保留旧 URL，避免回显后覆盖凭据。 */
function 保存(patch = {}) {
  读取();
  const next = { ...设置 };
  if (Array.isArray(patch.targets)) {
    const old = new Map(设置.targets.map((t) => [t.id, t]));
    next.targets = [];
    for (const raw of patch.targets.slice(0, 10)) {
      const url = String(raw && raw.url || "").trim();
      const existing = raw && old.get(String(raw.id || ""));
      const merged = { ...raw, url: url || (existing && existing.url) || "" };
      const target = 收窄目标(merged);
      if (target) next.targets.push(target);
    }
  }
  for (const key of ["quietFrom", "quietTo", "perMinute", "retryMax"]) if (patch[key] !== undefined) next[key] = patch[key];
  设置 = 收窄(next);
  写入();
  return { ok: true, notify: 配置() };
}

function 激活目标(level = "warn") {
  const rank = 级别[level] ?? 1;
  const cfg = 读取();
  const targets = cfg.targets.filter((t) => t.enabled && (级别[t.minLevel] ?? 1) <= rank);
  const envUrl = String(process.env.NOTIFY_WEBHOOK_URL || "").trim();
  if (envUrl && 级别.warn <= rank && !targets.some((t) => t.url === envUrl)) {
    targets.push({ id: "env", name: "env", url: envUrl, minLevel: "warn", enabled: true });
  }
  return { targets, cfg };
}

function 分钟数(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h > 23 || m > 59 ? null : h * 60 + m;
}

function 安静(cfg, level, now = new Date()) {
  if (level === "critical") return false;
  const from = 分钟数(cfg.quietFrom);
  const to = 分钟数(cfg.quietTo);
  if (from === null || to === null || from === to) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return from < to ? current >= from && current < to : current >= from || current < to;
}

function 配置() {
  读取();
  return {
    configured: 设置.targets.some((t) => t.enabled) || Boolean(process.env.NOTIFY_WEBHOOK_URL),
    kind: 设置.targets.length ? 设置.targets[0] && 类型(设置.targets[0].url) : process.env.NOTIFY_WEBHOOK_URL ? 类型(String(process.env.NOTIFY_WEBHOOK_URL)) : "none",
    targets: 设置.targets.map((t) => ({ id: t.id, name: t.name, kind: 类型(t.url), host: safeHost(t.url), minLevel: t.minLevel, enabled: t.enabled })),
    quietFrom: 设置.quietFrom,
    quietTo: 设置.quietTo,
    perMinute: 设置.perMinute,
    retryMax: 设置.retryMax,
    telegramChatConfigured: Boolean(String(process.env.NOTIFY_TELEGRAM_CHAT_ID || "").trim()),
    dedupSeconds: 去重窗口毫秒 / 1000,
    recent: 历史.slice(-30).reverse(),
  };
}

function 负载(text, kind) {
  if (kind === "discord") return { content: String(text).slice(0, 1900) };
  if (kind === "telegram") return { chat_id: String(process.env.NOTIFY_TELEGRAM_CHAT_ID || "").trim(), text: String(text).slice(0, 3500), disable_web_page_preview: true };
  return { text: String(text).slice(0, 3500) };
}

function 记录(entry) {
  历史.push({ at: Date.now(), ...entry });
  while (历史.length > 100) 历史.shift();
}

async function 单发(target, key, text, level) {
  const kind = 类型(target.url);
  if (kind === "telegram" && !String(process.env.NOTIFY_TELEGRAM_CHAT_ID || "").trim()) {
    return { target: target.id, ok: false, skipped: true, error: "NOTIFY_TELEGRAM_CHAT_ID belum diatur" };
  }
  const dedupe = `${target.id}:${key}`;
  const now = Date.now();
  const last = 最近.get(dedupe);
  if (last && now - last < 去重窗口毫秒) return { target: target.id, ok: false, skipped: true, error: "duplikat dalam 5 menit" };
  发送窗口 = 发送窗口.filter((at) => now - at < 60000);
  if (发送窗口.length >= 读取().perMinute) return { target: target.id, ok: false, skipped: true, error: "batas kiriman per menit" };
  最近.set(dedupe, now);
  发送窗口.push(now);
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      const res = await 网络请求(target.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "fucking-opencode" },
        body: JSON.stringify(负载(`[fucking-opencode][${level}] ${text}`, kind)),
        signal: AbortSignal.timeout(8000),
      });
      const ok = res.ok;
      记录({ key, target: target.id, level, ok, status: res.status, text: String(text).slice(0, 160) });
      if (ok) return { target: target.id, ok: true, status: res.status, attempt };
      if (attempt > 读取().retryMax || (res.status !== 429 && res.status < 500)) {
        最近.delete(dedupe);
        return { target: target.id, ok: false, status: res.status, attempt };
      }
    } catch (err) {
      if (attempt > 读取().retryMax) {
        最近.delete(dedupe);
        记录({ key, target: target.id, level, ok: false, error: err.message, text: String(text).slice(0, 160) });
        return { target: target.id, ok: false, error: err.message, attempt };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
  }
}

async function 发送(key, text, options = {}) {
  const level = 级别名.includes(options.level) ? options.level : "warn";
  const { targets, cfg } = 激活目标(level);
  if (!targets.length) return { ok: false, skipped: true, error: "tidak ada target webhook aktif; set NOTIFY_WEBHOOK_URL atau isi target di panel" };
  if (安静(cfg, level)) return { ok: false, skipped: true, error: "quiet hours" };
  const run = 发送中.then(async () => {
    const results = [];
    for (const target of targets) results.push(await 单发(target, key, text, level));
    const ok = results.some((row) => row.ok);
    return { ok, results, skipped: !ok && results.every((row) => row.skipped) };
  });
  发送中 = run.catch(() => {});
  return run;
}

function 通知事故(active, 事故) {
  if (!active || !事故) return Promise.resolve({ ok: false, skipped: true });
  const level = 事故.severity === "critical" || /abuse|empty|down/i.test(String(事故.key || "")) ? "critical" : "warn";
  return 发送(`incident:${事故.key}`, `${事故.title} - ${事故.detail || ""}`.trim(), { level });
}

function 测试(targetId = "") {
  if (targetId) {
    const target = 激活目标("info").targets.find((row) => row.id === targetId);
    if (!target) return Promise.resolve({ ok: false, error: "target tidak ditemukan" });
    return 单发({ ...target, enabled: true }, `manual:${Date.now()}`, "Tes webhook dari panel: koneksi berhasil.", "info");
  }
  return 发送(`manual:${Date.now()}`, "Tes webhook dari panel: koneksi berhasil.", { level: "info" });
}

function 设置网络请求(fn) {
  if (typeof fn === "function") 网络请求 = fn;
}

function __reset() {
  设置 = { ...默认 };
  已载入 = false;
  最近 = new Map();
  发送窗口 = [];
  历史.length = 0;
  发送中 = Promise.resolve();
}

module.exports = { 配置, 保存, 发送, 通知事故, 测试, 设置网络请求, 设置文件, __reset };
