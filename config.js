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
  modelGroupWeights: {},
  reasoningEffort: "",
  reasoningEffortByModel: {},
};

const 环境变量名 = {
  defaultModel: "FUCKING_OPENCODE_DEFAULT_MODEL",
  upstreamTimeoutMs: "UPSTREAM_TIMEOUT_MS",
  maxBodyBytes: "MAX_BODY_BYTES",
  autoUpdate: "AUTO_UPDATE",
  modelGroups: "FUCKING_OPENCODE_MODEL_GROUPS",
  modelGroupWeights: "FUCKING_OPENCODE_MODEL_GROUP_WEIGHTS",
  reasoningEffort: "REASONING_EFFORT",
  reasoningEffortByModel: "REASONING_EFFORT_BY_MODEL",
};

const 数值范围 = {
  upstreamTimeoutMs: [1000, 600000],
  maxBodyBytes: [1024, 100 * 1024 * 1024],
};

let 缓存 = { 键: "", 值: { ...默认值 }, error: "", 修改时间: 0 };
let 统计时间 = 0;
let 节流路径 = "";
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
    if (键 === "reasoningEffort") {
      const 级别 = ["", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
      if (typeof 输入 !== "string" || !级别.includes(输入.trim().toLowerCase())) {
        问题.push(`reasoningEffort 必须是 ${级别.filter(Boolean).join("|")} 之一。`);
      } else {
        值.reasoningEffort = 输入.trim().toLowerCase();
      }
      continue;
    }
    if (键 === "reasoningEffortByModel") {
      if (!输入 || typeof 输入 !== "object" || Array.isArray(输入)) {
        问题.push("reasoningEffortByModel 必须是对象：模型 ID → 级别。");
        continue;
      }
      const 级别 = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
      const 映射 = {};
      for (const [模型, 级别值] of Object.entries(输入)) {
        if (!模型.trim() || 模型.length > 200) {
          问题.push(`reasoningEffortByModel 模型 ID 无效：${模型}`);
          continue;
        }
        const 文本 = typeof 级别值 === "string" ? 级别值.trim().toLowerCase() : "";
        if (!级别.includes(文本)) {
          问题.push(`reasoningEffortByModel['${模型}'] 级别无效。`);
          continue;
        }
        映射[模型.trim()] = 文本;
      }
      值.reasoningEffortByModel = 映射;
      continue;
    }
    if (键 === "modelGroupWeights") {
      if (!输入 || typeof 输入 !== "object" || Array.isArray(输入)) {
        问题.push("modelGroupWeights 必须是对象：别名 → (模型 → 权重)。");
        continue;
      }
      const 权重 = {};
      for (const [别名, 映射] of Object.entries(输入)) {
        if (!别名.trim() || 别名.length > 60) {
          问题.push(`modelGroupWeights 别名无效：${别名}`);
          continue;
        }
        if (!映射 || typeof 映射 !== "object" || Array.isArray(映射)) {
          问题.push(`modelGroupWeights['${别名}'] 必须是对象。`);
          continue;
        }
        const 单组 = {};
        for (const [模型, 数字] of Object.entries(映射)) {
          const 值数 = Number(数字);
          if (!模型.trim() || 模型.length > 200 || !Number.isFinite(值数) || 值数 < 1 || 值数 > 100) {
            问题.push(`modelGroupWeights['${别名}']['${模型}'] 必须是 1..100 的数字。`);
            continue;
          }
          单组[模型.trim()] = Math.round(值数);
        }
        权重[别名] = 单组;
      }
      值.modelGroupWeights = 权重;
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
    // 文件不存在 = 空配置。缓存也要清掉，否则节流窗口里会继续返回
    // 上一个配置文件（可能是别的目录）的值。
    缓存 = { 键: `${file}:missing`, 值: { ...默认值 }, error: "", 修改时间: 0 };
    return { 值: 缓存.值, error: 缓存.error };
  }
  // 缓存键含文件路径：路径变了就是另一个配置文件，绝不能沿用上一个的值。
  const 键 = `${file}:${stat.mtimeMs}:${stat.size}`;
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
  const file = 配置文件路径();
  const now = Date.now();
  // 节流窗口同样按路径计：换了配置文件就立刻读新文件，不等窗口过期。
  if (file === 节流路径 && now - 统计时间 < 缓存毫秒) return { 值: 缓存.值, error: 缓存.error };
  统计时间 = now;
  节流路径 = file;
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
  if (键 === "reasoningEffort") {
    const { 问题 } = 校验({ reasoningEffort: 文本 });
    return 问题.length ? undefined : { 值: 文本.toLowerCase(), 来源: "env" };
  }
  if (键 === "reasoningEffortByModel") {
    try {
      const parsed = JSON.parse(文本);
      const { 问题, 值 } = 校验({ reasoningEffortByModel: parsed });
      return 问题.length ? undefined : { 值: 值.reasoningEffortByModel, 来源: "env" };
    } catch {
      return undefined;
    }
  }
  if (键 === "modelGroupWeights") {
    try {
      const parsed = JSON.parse(文本);
      const { 值 } = 校验({ modelGroupWeights: parsed });
      return { 值: 值.modelGroupWeights, 来源: "env" };
    } catch {
      return undefined;
    }
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
  if (键 === "modelGroupWeights") return 值.modelGroupWeights || {};
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
        : 键 === "modelGroupWeights"
          ? Object.keys(值.modelGroupWeights || {}).length > 0
          : 值[键] !== 默认值[键];
    sources[键] = env ? "env" : 文件有值 ? "file" : "default";
  }
  return { file, values, sources, error };
}

function __reload() {
  统计时间 = 0;
  节流路径 = "";
  缓存 = { 键: "", 值: { ...默认值 }, error: "", 修改时间: 0 };
  return 快照();
}

const 快照上限 = 10;

function 历史文件() {
  return path.join(path.dirname(配置文件路径()), "config-history.json");
}

function 读历史() {
  try {
    const data = JSON.parse(fs.readFileSync(历史文件(), "utf8"));
    if (Array.isArray(data)) return data.filter((row) => row && typeof row === "object").slice(-快照上限);
  } catch {}
  return [];
}

function 保存快照(配置) {
  const 历史 = 读历史();
  const body = JSON.stringify(配置 || {});
  const last = 历史[历史.length - 1];
  if (last && JSON.stringify(last.config) === body) return;
  历史.push({ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), config: 配置 || {} });
  const 文件 = 历史文件();
  const 临时 = `${文件}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(文件), { recursive: true });
    fs.writeFileSync(临时, JSON.stringify(历史.slice(-快照上限)), { mode: 0o600 });
    fs.renameSync(临时, 文件);
  } catch {
    try { fs.unlinkSync(临时); } catch {}
  }
}

function 快照历史() {
  return 读历史().map((row) => ({
    id: row.id,
    at: row.at,
    keys: Object.keys(row.config || {}),
    config: row.config || {},
  })).reverse();
}

function 恢复快照(id) {
  const row = 读历史().find((entry) => entry && entry.id === id);
  if (!row) return { ok: false, error: "snapshot tidak ditemukan" };
  const { 值, 问题 } = 校验(row.config || {});
  if (问题.length) return { ok: false, error: 问题.join(" ") };
  let 现有 = {};
  try { 现有 = JSON.parse(fs.readFileSync(配置文件路径(), "utf8")); } catch {}
  保存快照(现有);
  const 文件 = 配置文件路径();
  const 临时 = `${文件}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(文件), { recursive: true });
    fs.writeFileSync(临时, JSON.stringify(值, null, 2), { mode: 0o600 });
    fs.renameSync(临时, 文件);
  } catch (err) {
    try { fs.unlinkSync(临时); } catch {}
    return { ok: false, error: `写入 config.json 失败：${err.message}` };
  }
  __reload();
  return { ok: true, restored: id, snapshot: 快照() };
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
  保存快照(原始);
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
  快照历史,
  恢复快照,
  __reload,
  默认值,
};
