const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 运行时可热加载的配置。优先级：环境变量 > config.json > 内置默认值。
// 文件按 mtime/size 缓存，每秒最多 stat 一次，改文件即生效，无需重启。
// 解析失败时保留上一份有效值，并暴露 error 供 /api/config 与 /health 读取。

const 默认值 = {
  defaultModel: "",
  upstreamTimeoutMs: 120000,
  maxBodyBytes: 10 * 1024 * 1024,
  autoUpdate: true,
  modelGroups: {},
};

const 环境变量名 = {
  defaultModel: "FUCKING_OPENCODE_DEFAULT_MODEL",
  upstreamTimeoutMs: "UPSTREAM_TIMEOUT_MS",
  maxBodyBytes: "MAX_BODY_BYTES",
  autoUpdate: "AUTO_UPDATE",
  modelGroups: "FUCKING_OPENCODE_MODEL_GROUPS",
};

const 数值范围 = {
  upstreamTimeoutMs: [1000, 600000],
  maxBodyBytes: [1024, 100 * 1024 * 1024],
};

let 缓存 = { 键: "", 值: { ...默认值 }, error: "", 修改时间: 0 };
let 统计时间 = 0;
const 缓存毫秒 = 1000;

function 状态目录() {
  const raw = process.env.FUCKING_OPENCODE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return path.join(os.homedir(), ".fucking-opencode");
}

function 配置文件路径() {
  const raw = process.env.FUCKING_OPENCODE_CONFIG;
  if (raw !== undefined && String(raw).trim()) {
    const value = String(raw).trim();
    return path.isAbsolute(value) ? value : path.join(状态目录(), value);
  }
  return path.join(状态目录(), "config.json");
}

function 校验(原始) {
  const 值 = { ...默认值 };
  const 问题 = [];
  if (!原始 || typeof 原始 !== "object" || Array.isArray(原始)) {
    return { 值, 问题: ["config.json 必须是 JSON 对象。"] };
  }
  for (const [键, 输入] of Object.entries(原始)) {
    if (!(键 in 默认值)) {
      问题.push(`未知配置项：${键}`);
      continue;
    }
    if (键 === "defaultModel") {
      if (typeof 输入 !== "string") 问题.push("defaultModel 必须是字符串。");
      else 值.defaultModel = 输入.trim();
      continue;
    }
    if (键 === "autoUpdate") {
      if (typeof 输入 !== "boolean") 问题.push("autoUpdate 必须是布尔值。");
      else 值.autoUpdate = 输入;
      continue;
    }
    if (键 === "modelGroups") {
      if (!输入 || typeof 输入 !== "object" || Array.isArray(输入)) {
        问题.push("modelGroups 必须是对象：别名 → 模型数组。");
        continue;
      }
      const 组 = {};
      for (const [别名, 列表] of Object.entries(输入)) {
        if (!别名.trim() || 别名.length > 60) {
          问题.push(`modelGroups 别名无效：${别名}`);
          continue;
        }
        if (!Array.isArray(列表) || 列表.length === 0 || 列表.length > 20) {
          问题.push(`modelGroups['${别名}'] 必须是 1..20 个模型的数组。`);
          continue;
        }
        const 模型 = 列表
          .filter((项) => typeof 项 === "string" && 项.trim())
          .map((项) => 项.trim());
        if (模型.length !== 列表.length) {
          问题.push(`modelGroups['${别名}'] 只能包含非空字符串。`);
          continue;
        }
        if (模型.some((项) => 项.length > 200)) {
          问题.push(`modelGroups['${别名}'] 含过长的模型 ID。`);
          continue;
        }
        组[别名] = 模型;
      }
      值.modelGroups = 组;
      continue;
    }
    const 范围 = 数值范围[键];
    if (!Number.isInteger(输入) || 输入 < 范围[0] || 输入 > 范围[1]) {
      问题.push(`${键} 必须是 ${范围[0]}..${范围[1]} 的整数。`);
      continue;
    }
    值[键] = 输入;
  }
  return { 值, 问题 };
}

function 读文件() {
  const file = 配置文件路径();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { 值: { ...默认值 }, error: "" };
  }
  const 键 = `${stat.mtimeMs}:${stat.size}`;
  if (键 === 缓存.键) return { 值: 缓存.值, error: 缓存.error };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    缓存 = { 键, 值: 缓存.值, error: `读取 config.json 失败：${err.message}`, 修改时间: stat.mtimeMs };
    return { 值: 缓存.值, error: 缓存.error };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    缓存 = { 键, 值: 缓存.值, error: `config.json JSON 无效：${err.message}`, 修改时间: stat.mtimeMs };
    return { 值: 缓存.值, error: 缓存.error };
  }
  const { 值, 问题 } = 校验(parsed);
  缓存 = { 键, 值, error: 问题.join(" "), 修改时间: stat.mtimeMs };
  return { 值: 缓存.值, error: 缓存.error };
}

function 当前文件配置() {
  const now = Date.now();
  if (now - 统计时间 < 缓存毫秒) return { 值: 缓存.值, error: 缓存.error };
  统计时间 = now;
  return 读文件();
}

function 解析环境(键) {
  const 名 = 环境变量名[键];
  const raw = process.env[名];
  if (raw === undefined || String(raw).trim() === "") return undefined;
  const 文本 = String(raw).trim();
  if (键 === "defaultModel") return { 值: 文本, 来源: "env" };
  if (键 === "autoUpdate") {
    if (文本 === "0" || 文本.toLowerCase() === "false") return { 值: false, 来源: "env" };
    if (文本 === "1" || 文本 === "force" || 文本.toLowerCase() === "true") return { 值: true, 来源: "env" };
    return undefined;
  }
  if (键 === "modelGroups") {
    try {
      const parsed = JSON.parse(文本);
      const { 值 } = 校验({ modelGroups: parsed });
      return { 值: 值.modelGroups, 来源: "env" };
    } catch {
      return undefined;
    }
  }
  const 数 = parseInt(文本, 10);
  const 范围 = 数值范围[键];
  if (!Number.isFinite(数) || 数 < 范围[0] || 数 > 范围[1]) return undefined;
  return { 值: 数, 来源: "env" };
}

function 取(键) {
  const env = 解析环境(键);
  if (env) return env.值;
  const { 值 } = 当前文件配置();
  if (键 === "modelGroups") return 值.modelGroups || {};
  if (值[键] !== undefined && 值[键] !== 默认值[键]) return 值[键];
  return 默认值[键];
}

function 快照() {
  const file = 配置文件路径();
  const { 值, error } = 当前文件配置();
  const values = {};
  const sources = {};
  for (const 键 of Object.keys(默认值)) {
    const env = 解析环境(键);
    values[键] = env ? env.值 : 值[键];
    const 文件有值 =
      键 === "modelGroups"
        ? Object.keys(值.modelGroups || {}).length > 0
        : 值[键] !== 默认值[键];
    sources[键] = env ? "env" : 文件有值 ? "file" : "default";
  }
  return { file, values, sources, error };
}

function __reload() {
  统计时间 = 0;
  缓存 = { 键: "", 值: { ...默认值 }, error: "", 修改时间: 0 };
  return 快照();
}

/** 合并写入 config.json（原子重命名，0600）；未知键忽略，非法值整体拒绝。 */
function 写入(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, error: "配置必须是 JSON 对象。" };
  }
  let 原始 = {};
  try {
    原始 = JSON.parse(fs.readFileSync(配置文件路径(), "utf8"));
    if (!原始 || typeof 原始 !== "object" || Array.isArray(原始)) 原始 = {};
  } catch {}
  for (const [键, 值] of Object.entries(patch)) {
    if (键 in 默认值) 原始[键] = 值;
  }
  const { 问题 } = 校验(原始);
  if (问题.length) return { ok: false, error: 问题.join(" ") };
  const 文件 = 配置文件路径();
  const 临时 = `${文件}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(文件), { recursive: true });
    fs.writeFileSync(临时, JSON.stringify(原始, null, 2), { mode: 0o600 });
    fs.renameSync(临时, 文件);
  } catch (err) {
    try {
      fs.unlinkSync(临时);
    } catch {}
    return { ok: false, error: `写入 config.json 失败：${err.message}` };
  }
  __reload();
  return { ok: true, snapshot: 快照() };
}

module.exports = {
  配置文件路径,
  取,
  快照,
  写入,
  __reload,
  默认值,
};
