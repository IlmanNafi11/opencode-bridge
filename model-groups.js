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

/** 组别名 → 权重表；缺省为空对象。 */
function 组权重(别名) {
  const 全部 = require("./config").取("modelGroupWeights") || {};
  const 映射 = 全部[别名];
  return 映射 && typeof 映射 === "object" && !Array.isArray(映射) ? 映射 : {};
}

function 候选(请求模型) {
  const 组 = 组成员(请求模型);
  if (!组) return [请求模型];
  const 权重 = 组权重(请求模型);
  const 排序 = 组
    .map((模型, index) => ({ 模型, index, 权重: Number(权重[模型]) || 0 }))
    .sort((a, b) => (b.权重 - a.权重) || (a.index - b.index))
    .map((项) => 项.模型);
  const 状态 = 读取();
  const now = Date.now();
  const 可用 = 排序.filter((模型) => !状态[模型] || 状态[模型].until <= now);
  return 可用.length ? 可用 : 排序;
}

/** 面板模拟：给出该请求会选哪个模型、有序候选与冷却原因。 */
function 模拟(请求模型) {
  const 组 = 组成员(请求模型);
  const 状态 = 读取();
  const now = Date.now();
  const 权重 = 组 ? 组权重(请求模型) : {};
  const 排序 = (组 || [请求模型]).map((模型, index) => ({ 模型, index, 权重: Number(权重[模型]) || 0 }))
    .sort((a, b) => (b.权重 - a.权重) || (a.index - b.index));
  const 明细 = 排序.map((项) => {
    const 记录 = 状态[项.模型];
    const 冷却到 = 记录 && 记录.until > now ? 记录.until : 0;
    return { 模型: 项.模型, 权重: 项.权重, 可用: !冷却到, 冷却到, 原因: 冷却到 ? 记录.reason : "" };
  });
  const 选中 = 明细.find((项) => 项.可用) || 明细[0] || null;
  return {
    alias: 组 ? 请求模型 : null,
    候选: 组 ? 排序.map((项) => 项.模型) : [],
    明细,
    选中: 选中 ? 选中.模型 : 请求模型,
    回落: Boolean(选中 && 选中.模型 !== 请求模型),
  };
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

/** 清空全部模型冷却（面板按钮）；返回被清除的条目数由 诊断 前后对比得出。 */
function 重置() {
  const 之前 = 诊断().length;
  写入({});
  缓存 = null;
  return { ok: true, cleared: 之前 };
}

module.exports = { 候选, 组成员, 组权重, 模拟, 记录失败, 记录成功, 诊断, 重置, 健康文件, __reload };
