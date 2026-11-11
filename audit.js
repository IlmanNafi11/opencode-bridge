const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 管理面审计：只记录动作、来源、结果与时间，不保存请求体或凭据。
// JSONL 追加写入，单文件超过 2 MiB 时轮转为 .1，面板只读最近条目。
const 文件上限 = 2 * 1024 * 1024;
const 返回上限 = 500;
const 敏感键 = /key|token|secret|password|authorization|cookie/i;

function 状态目录() {
  const raw = process.env.FUCKING_OPENCODE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return path.join(os.homedir(), ".fucking-opencode");
}

function 审计文件() {
  return path.join(状态目录(), "audit.jsonl");
}

function 去敏(value, depth = 0) {
  if (depth > 3 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => 去敏(item, depth + 1));
  if (typeof value !== "object") return typeof value === "string" ? value.slice(0, 300) : value;
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    out[key] = 敏感键.test(key) ? "[redacted]" : 去敏(item, depth + 1);
  }
  return out;
}

function 轮转() {
  const file = 审计文件();
  try {
    if (fs.statSync(file).size < 文件上限) return;
    fs.renameSync(file, `${file}.1`);
  } catch {}
}

function 记录(entry = {}) {
  const row = {
    at: new Date().toISOString(),
    action: String(entry.action || "unknown").slice(0, 120),
    actor: String(entry.actor || "panel").slice(0, 80),
    ip: String(entry.ip || "").slice(0, 64),
    status: Number(entry.status) || null,
    ok: entry.ok !== false,
    detail: entry.detail === undefined ? null : 去敏(entry.detail),
  };
  const file = 审计文件();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    轮转();
    fs.appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
  } catch {}
  return row;
}

function 读取(limit = 200) {
  const n = Math.max(1, Math.min(返回上限, Number(limit) || 200));
  const file = 审计文件();
  const rows = [];
  for (const target of [`${file}.1`, file]) {
    let text = "";
    try {
      text = fs.readFileSync(target, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === "object") rows.push(row);
      } catch {}
    }
  }
  return rows.slice(-n).reverse();
}

function 清理(days = 30) {
  const cutoff = Date.now() - Math.max(1, Math.min(3650, Number(days) || 30)) * 86400000;
  const kept = [];
  let removed = 0;
  for (const row of 读取(返回上限).reverse()) {
    const at = Date.parse(row.at || "");
    if (Number.isFinite(at) && at < cutoff) removed += 1;
    else kept.push(row);
  }
  if (!removed) return { ok: true, removed: 0 };
  const file = 审计文件();
  const 临时 = `${file}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(临时, kept.map((row) => JSON.stringify(row)).join("\n") + (kept.length ? "\n" : ""), { mode: 0o600 });
    fs.renameSync(临时, file);
    try { fs.rmSync(`${file}.1`, { force: true }); } catch {}
  } catch (err) {
    try { fs.unlinkSync(临时); } catch {}
    return { ok: false, error: err.message, removed: 0 };
  }
  return { ok: true, removed };
}

function 统计() {
  const file = 审计文件();
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  const rows = 读取(返回上限);
  return { file, size, count: rows.length, newest: rows[0] || null, oldest: rows[rows.length - 1] || null };
}

module.exports = { 记录, 读取, 清理, 统计, 审计文件 };
