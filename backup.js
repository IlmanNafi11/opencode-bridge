const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 定时状态快照与恢复。快照是单个 JSON 文件，包含白名单内的状态文件原文；
// 不包含 usage.jsonl、audit.jsonl、日志或任何凭据明文之外的内容。
// 恢复只接受本目录下由 list() 报告的文件名，并逐文件原子写入。
const 默认 = { enabled: false, intervalHours: 24, keep: 14, dir: "" };
const 白名单 = ["config.json", "settings.json", "proxy.json", "warp-farm.json", "model-health.json", "maintenance.json", "autoheal.json", "notify.json", "retention.json"];
const 单文件上限 = 2 * 1024 * 1024;
let 设置 = { ...默认 };
let 已载入 = false;

function 状态目录() {
  const raw = process.env.FUCKING_OPENCODE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return path.join(os.homedir(), ".fucking-opencode");
}

function 设置文件() {
  return path.join(状态目录(), "backup.json");
}

function 备份目录() {
  读取();
  return 设置.dir || path.join(状态目录(), "backups");
}

function 收窄(raw = {}) {
  const out = { ...默认 };
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  const hours = Number(raw.intervalHours);
  if (Number.isFinite(hours)) out.intervalHours = Math.min(Math.max(Math.floor(hours), 1), 168);
  const keep = Number(raw.keep);
  if (Number.isFinite(keep)) out.keep = Math.min(Math.max(Math.floor(keep), 1), 100);
  if (typeof raw.dir === "string") out.dir = raw.dir.trim().slice(0, 300);
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

function 保存(patch = {}) {
  读取();
  设置 = 收窄({ ...设置, ...patch });
  if (设置.dir && !path.isAbsolute(设置.dir)) 设置.dir = path.join(状态目录(), 设置.dir);
  写入();
  return { ok: true, backup: 状态() };
}

function 文件名(at = new Date()) {
  return "backup-" + at.toISOString().replace(/[:.]/g, "-") + ".json";
}

/**
 * 取一个目录内未被占用的快照名。ISO 时间戳只有毫秒精度，同一毫秒内连续
 * 创建会撞名（rename 覆盖前一个快照 → 快照数量少于预期）。撞名时追加
 * `-<n>` 序号，仍满足 list() 的 `backup-*.json` 匹配。
 */
function 唯一文件名(dir, at = new Date()) {
  const base = 文件名(at);
  let name = base;
  for (let n = 1; fs.existsSync(path.join(dir, name)); n += 1) {
    name = base.replace(/\.json$/, `-${n}.json`);
    if (n > 9999) break;
  }
  return name;
}

function 读取文件(name) {
  if (!白名单.includes(name)) return null;
  const file = path.join(状态目录(), name);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 单文件上限) return null;
    return { text: fs.readFileSync(file, "utf8"), size: stat.size, mtime: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

function 创建() {
  const files = {};
  for (const name of 白名单) {
    const entry = 读取文件(name);
    if (!entry) continue;
    try {
      files[name] = { json: JSON.parse(entry.text), size: entry.size, mtime: entry.mtime };
    } catch {
      continue;
    }
  }
  const snapshot = { version: 1, at: new Date().toISOString(), files };
  const dir = 备份目录();
  const name = 唯一文件名(dir);
  const file = path.join(dir, name);
  const 临时 = `${file}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(临时, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    fs.renameSync(临时, file);
  } catch (err) {
    try { fs.unlinkSync(临时); } catch {}
    return { ok: false, error: err.message };
  }
  const pruned = 裁剪(设置.keep);
  return { ok: true, file, name, files: Object.keys(files), size: fs.statSync(file).size, pruned: pruned.removed };
}

function 列表() {
  const dir = 备份目录();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /^backup-[\w:.-]+\.json$/.test(name));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (!stat.isFile()) continue;
      let at = stat.mtime.toISOString();
      let files = null;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        if (data && typeof data.at === "string") at = data.at;
        if (data && data.files) files = Object.keys(data.files);
      } catch {}
      out.push({ name, at, size: stat.size, files });
    } catch {}
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function 裁剪(keep = 14) {
  const rows = 列表();
  const n = Math.max(1, Math.min(100, Number(keep) || 14));
  let removed = 0;
  for (const row of rows.slice(n)) {
    try {
      fs.unlinkSync(path.join(备份目录(), row.name));
      removed += 1;
    } catch {}
  }
  return { ok: true, removed };
}

function 恢复(name, { reload } = {}) {
  if (!列表().some((row) => row.name === name)) return { ok: false, error: "快照不存在。" };
  let snapshot = null;
  try {
    snapshot = JSON.parse(fs.readFileSync(path.join(备份目录(), name), "utf8"));
  } catch (err) {
    return { ok: false, error: `快照无法解析：${err.message}` };
  }
  if (!snapshot || snapshot.version !== 1 || !snapshot.files || typeof snapshot.files !== "object") {
    return { ok: false, error: "快照格式无效。" };
  }
  const names = Object.keys(snapshot.files);
  if (!names.length || names.some((file) => !白名单.includes(file))) return { ok: false, error: "快照包含未知文件。" };
  for (const file of names) {
    const value = snapshot.files[file];
    if (!value || typeof value.json !== "object" || value.json === null) return { ok: false, error: `${file} 内容无效。` };
    const body = JSON.stringify(value.json, null, 2);
    if (Buffer.byteLength(body) > 单文件上限) return { ok: false, error: `${file} 超出大小上限。` };
    const target = path.join(状态目录(), file);
    const 临时 = `${target}.tmp.${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(临时, body, { mode: 0o600 });
      fs.renameSync(临时, target);
    } catch (err) {
      try { fs.unlinkSync(临时); } catch {}
      return { ok: false, error: `${file} 写入失败：${err.message}` };
    }
  }
  if (typeof reload === "function") {
    try { reload(names); } catch {}
  }
  return { ok: true, restored: names, at: snapshot.at };
}

function 状态() {
  读取();
  const dir = 备份目录();
  const rows = 列表();
  return { ...设置, dir, count: rows.length, newest: rows[0] || null, oldest: rows[rows.length - 1] || null };
}

function 节拍() {
  const cfg = 读取();
  if (!cfg.enabled) return { ok: true, skipped: "disabled" };
  const rows = 列表();
  const last = rows[0] ? Date.parse(rows[0].at) : 0;
  if (last && Date.now() - last < cfg.intervalHours * 3600000) return { ok: true, skipped: "not-due" };
  return 创建();
}

function __reset() {
  设置 = { ...默认 };
  已载入 = false;
}

module.exports = { 创建, 列表, 恢复, 裁剪, 状态, 保存, 节拍, 备份目录, 白名单, __reset };
