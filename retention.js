const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 本地数据保留策略：按天数/大小裁剪 usage.jsonl，并联动清理审计与备份。
// 只做上限内的行级过滤；写入使用临时文件加原子重命名，裁剪中途失败保留原文件。
const 默认 = { enabled: false, usageDays: 30, maxUsageMb: 64, auditDays: 90, backupKeep: 14 };
let 设置 = { ...默认 };
let 已载入 = false;

function 状态目录() {
  const raw = process.env.FUCKING_OPENCODE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return path.join(os.homedir(), ".fucking-opencode");
}

function 设置文件() {
  return path.join(状态目录(), "retention.json");
}

function 收窄(raw = {}) {
  const out = { ...默认 };
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  for (const [key, min, max] of [["usageDays", 1, 3650], ["maxUsageMb", 1, 2048], ["auditDays", 1, 3650], ["backupKeep", 1, 100]]) {
    const n = Number(raw[key]);
    if (Number.isFinite(n)) out[key] = Math.min(Math.max(Math.floor(n), min), max);
  }
  return out;
}

function 读取() {
  if (已载入) return 设置;
  已载入 = true;
  try {
    const data = JSON.parse(fs.readFileSync(设置文件(), "utf8"));
    设置 = 收窄(data);
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

function 保存(patch = {}) {
  读取();
  设置 = 收窄({ ...设置, ...patch });
  写入();
  return { ok: true, retention: 状态() };
}

function 用量文件() {
  try {
    return require("./stats").用量文件路径();
  } catch {
    return path.join(状态目录(), "usage.jsonl");
  }
}

function 文件大小(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function 状态() {
  读取();
  const usage = 用量文件();
  const size = 文件大小(usage);
  return { ...设置, usageFile: usage, usageBytes: size, usageMb: Math.round((size / 1048576) * 100) / 100, settingsFile: 设置文件() };
}

/** 读取 JSONL，丢掉超龄或不可解析的行；超过 maxUsageMb 时保留最新的尾部。 */
function 裁剪用量() {
  const file = 用量文件();
  const days = 读取().usageDays;
  const maxBytes = 读取().maxUsageMb * 1048576;
  const cutoff = Date.now() - days * 86400000;
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return { ok: true, removed: 0, kept: 0 }; }
  const kept = [];
  let removed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row = null;
    try { row = JSON.parse(line); } catch { removed += 1; continue; }
    const at = Number(row && (row.at || row.ts)) || 0;
    if (at && at < cutoff) removed += 1;
    else kept.push(line);
  }
  let body = kept.join("\n") + (kept.length ? "\n" : "");
  while (Buffer.byteLength(body) > maxBytes && kept.length) {
    kept.shift();
    removed += 1;
    body = kept.join("\n") + (kept.length ? "\n" : "");
  }
  if (removed) {
    const 临时 = `${file}.tmp.${process.pid}`;
    try {
      fs.writeFileSync(临时, body, { mode: 0o600 });
      fs.renameSync(临时, file);
    } catch (err) {
      try { fs.unlinkSync(临时); } catch {}
      return { ok: false, error: err.message, removed: 0, kept: kept.length };
    }
  }
  return { ok: true, removed, kept: kept.length, bytes: Buffer.byteLength(body) };
}

function 执行() {
  const cfg = 读取();
  if (!cfg.enabled) return { ok: true, skipped: "disabled" };
  const usage = 裁剪用量();
  let audit = { removed: 0 };
  try { audit = require("./audit").清理(cfg.auditDays); } catch {}
  let backups = { removed: 0 };
  try { backups = require("./backup").裁剪(cfg.backupKeep); } catch {}
  return { ok: true, usage, audit, backups, at: new Date().toISOString() };
}

function 节拍() {
  const cfg = 读取();
  if (!cfg.enabled) return { ok: true, skipped: "disabled" };
  return 执行();
}

function __reset() {
  设置 = { ...默认 };
  已载入 = false;
}

module.exports = { 状态, 保存, 执行, 节拍, 裁剪用量, 保存文件: 设置文件, __reset };
