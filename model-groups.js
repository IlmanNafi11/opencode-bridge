const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 模型组：把别名映射为有序候选模型，并记录每个具体模型的冷却状态。
// 组定义来自 config.json 的 modelGroups；冷却持久化在
// <状态目录>/model-health.json（0600、原子重命名），重启后仍生效。

const 冷却毫秒 = {
  404: 5 * 60 * 1000,
  410: 5 * 60 * 1000,
  429: 60 * 1000,
  500: 30 * 1000,
  502: 30 * 1000,
  503: 30 * 1000,
  504: 30 * 1000,
};
const 最大条目 = 200;

let 缓存 = null;

function 状态目录() {
  const raw = process.env.FUCKING_OPENCODE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return path.join(os.homedir(), ".fucking-opencode");
}

function 健康文件() {
  return path.join(状态目录(), "model-health.json");
}

function 读取() {
  if (缓存) return 缓存;
  const out = {};
  try {
    const data = JSON.parse(fs.readFileSync(健康文件(), "utf8"));
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const now = Date.now();
      for (const [模型, 记录] of Object.entries(data)) {
        if (!记录 || typeof 记录 !== "object") continue;
        const until = Number(记录.until) || 0;
        if (until > now) out[模型] = { until, reason: String(记录.reason || "") };
      }
    }
  } catch {}
  缓存 = out;
  return 缓存;
}

function 写入(状态) {
  const 文件 = 健康文件();
  const 临时 = `${文件}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(文件), { recursive: true });
    fs.writeFileSync(临时, JSON.stringify(状态), { mode: 0o600 });
    fs.renameSync(临时, 文件);
  } catch {
    try {
      fs.unlinkSync(临时);
    } catch {}
  }
}

/** 组别名 → 原始候选；不是组则返回 null。保持配置顺序。 */
function 组成员(别名) {
  const 组 = require("./config").取("modelGroups") || {};
  const 列表 = 组[别名];
  if (!Array.isArray(列表) || 列表.length === 0) return null;
  return [...new Set(列表)];
}

function 候选(请求模型) {
  const 组 = 组成员(请求模型);
  if (!组) return [请求模型];
  const 状态 = 读取();
  const now = Date.now();
  const 可用 = 组.filter((模型) => !状态[模型] || 状态[模型].until <= now);
  return 可用.length ? 可用 : 组;
}

function 记录失败(模型, status) {
  const 毫秒 = 冷却毫秒[status];
  if (!毫秒) return;
  const 状态 = 读取();
  状态[模型] = { until: Date.now() + 毫秒, reason: `HTTP ${status}` };
  const 键 = Object.keys(状态);
  if (键.length > 最大条目) {
    键.sort((a, b) => 状态[a].until - 状态[b].until);
    for (const 旧 of 键.slice(0, 键.length - 最大条目)) delete 状态[旧];
  }
  写入(状态);
}

function 记录成功(模型) {
  const 状态 = 读取();
  if (!(模型 in 状态)) return;
  delete 状态[模型];
  写入(状态);
}

function 诊断() {
  const now = Date.now();
  const 状态 = 读取();
  return Object.entries(状态)
    .filter(([, 记录]) => 记录.until > now)
    .map(([模型, 记录]) => ({
      model: 模型,
      reason: 记录.reason,
      until: new Date(记录.until).toISOString(),
      remainingMs: 记录.until - now,
    }))
    .sort((a, b) => a.remainingMs - b.remainingMs);
}

function __reload() {
  缓存 = null;
}

module.exports = { 候选, 组成员, 记录失败, 记录成功, 诊断, 健康文件, __reload };
