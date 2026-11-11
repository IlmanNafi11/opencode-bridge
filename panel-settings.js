"use strict";

/**
 * 面板可编辑的凭据：下游 API key 列表与面板登录密码。
 *
 * 保存在 `<state dir>/settings.json`（mode 0600），与 proxy.json 同目录。
 * 文件里的值优先；没有文件时回落到环境变量（FUCKING_OPENCODE_API_KEYS
 * 按逗号拆成多个 key，PANEL_PASSWORD 原样使用）。这样已经在用的 env 部署
 * 不改变行为，面板里保存过的值又能立即生效、无需重启。
 *
 * 旧的单 key 字段 `apiKey` 会在读取时迁移成 `apiKeys[0]`，旧部署无感。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE_NAME = "settings.json";
const MIN_SECRET_LENGTH = 4;
const MAX_SECRET_LENGTH = 200;
const MAX_LABEL_LENGTH = 40;
const MAX_KEYS = 50;

let cache = { key: "", data: {} };

function 状态目录() {
  const raw = process.env.FUCKING_OPENCODE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return path.join(os.homedir(), ".fucking-opencode");
}

function 配置文件路径() {
  return path.join(状态目录(), FILE_NAME);
}

function 字符串(value) {
  return typeof value === "string" ? value.trim() : "";
}

function 新ID() {
  return crypto.randomBytes(6).toString("hex");
}

function 收窄限额(raw) {
  const rpmRaw = Number(raw && raw.rpm);
  const dailyRaw = Number(raw && raw.daily);
  const rpm = Number.isFinite(rpmRaw) ? Math.min(Math.max(Math.floor(rpmRaw), 0), 600) : 0;
  const daily = Number.isFinite(dailyRaw) ? Math.min(Math.max(Math.floor(dailyRaw), 0), 1000000) : 0;
  const models = Array.isArray(raw && raw.models)
    ? raw.models.map((entry) => 字符串(entry).slice(0, 120)).filter(Boolean).slice(0, 50)
    : [];
  return { rpm, daily, models };
}

/** 把任意存储值收窄成合法 key 条目；非法条目直接丢弃。 */
function 收窄条目(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const key = 字符串(raw.key);
  if (!key || key.length < MIN_SECRET_LENGTH || key.length > MAX_SECRET_LENGTH) return null;
  const label = 字符串(raw.label).slice(0, MAX_LABEL_LENGTH) || `key-${index + 1}`;
  const createdAt = Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now();
  const id = 字符串(raw.id).slice(0, 32) || 新ID();
  return { id, label, key, enabled: raw.enabled !== false, createdAt, ...收窄限额(raw) };
}

function 读取() {
  const file = 配置文件路径();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = { key: "", data: { panelPassword: "", apiKeys: [] } };
    return cache.data;
  }
  const key = `${file}:${stat.mtimeMs}:${stat.size}`;
  if (key === cache.key) return cache.data;
  let data = { panelPassword: "", apiKeys: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") {
      data = {
        panelPassword: 字符串(parsed.panelPassword),
        apiKeys: [],
      };
      if (Array.isArray(parsed.apiKeys)) {
        data.apiKeys = parsed.apiKeys.map(收窄条目).filter(Boolean).slice(0, MAX_KEYS);
      }
      // 旧格式迁移：单 key 字段变成第一个条目，并保留启用状态。
      const legacy = 字符串(parsed.apiKey);
      if (legacy && legacy.length >= MIN_SECRET_LENGTH && legacy.length <= MAX_SECRET_LENGTH) {
        const exists = data.apiKeys.some((entry) => entry.key === legacy);
        if (!exists) {
          data.apiKeys.unshift({
            id: "default",
            label: "default",
            key: legacy,
            enabled: true,
            createdAt: Number.isFinite(Number(parsed.apiKeyCreatedAt)) ? Number(parsed.apiKeyCreatedAt) : Date.now(),
          });
        }
      }
    }
  } catch {
    data = { panelPassword: "", apiKeys: [] };
  }
  cache = { key, data };
  return data;
}

function 写入(patch) {
  const current = 读取();
  const next = {
    apiKeys: Array.isArray(current.apiKeys) ? current.apiKeys : [],
    panelPassword: 字符串(current.panelPassword),
  };
  if (patch.apiKeys !== undefined) {
    next.apiKeys = patch.apiKeys.map(收窄条目).filter(Boolean).slice(0, MAX_KEYS);
  }
  if (patch.panelPassword !== undefined) {
    next.panelPassword = 字符串(patch.panelPassword);
  }
  // 旧单 key 字段不再落盘：读取时迁移，写入时统一成列表。
  const json = {
    apiKeys: next.apiKeys.map(({ id, label, key, enabled, createdAt, rpm, daily, models }) => ({
      id,
      label,
      key,
      enabled,
      createdAt,
      ...(rpm ? { rpm } : {}),
      ...(daily ? { daily } : {}),
      ...(models && models.length ? { models } : {}),
    })),
  };
  if (next.panelPassword) json.panelPassword = next.panelPassword;
  const dir = 状态目录();
  fs.mkdirSync(dir, { recursive: true });
  const file = 配置文件路径();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  cache = { key: "", data: {} };
  return 读取();
}

/** 环境变量里的 key 列表；每次调用都读，运维改了 env 重启即生效。 */
function 环境密钥() {
  return String(process.env.FUCKING_OPENCODE_API_KEYS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= MIN_SECRET_LENGTH && entry.length <= MAX_SECRET_LENGTH)
    .map((key, index) => ({
      id: `env-${index + 1}`,
      label: `env-${index + 1}`,
      key,
      enabled: true,
      createdAt: 0,
      source: "env",
    }));
}

/** 文件密钥在前、环境密钥在后；保持稳定顺序，便于面板展示。 */
function 全部密钥() {
  const fileKeys = (读取().apiKeys || []).map((entry) => ({ ...entry, source: "file" }));
  return [...fileKeys, ...环境密钥()];
}

function 启用密钥() {
  return 全部密钥().filter((entry) => entry.enabled);
}

function 时效比较(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // 长度不等也要消耗比较时间，避免长度差分侧信道。
    crypto.timingSafeEqual(Buffer.from("x".repeat(ab.length)), Buffer.from("y".repeat(ab.length)));
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * 是否配置了任何 key（含已停用条目）。false 表示门禁关闭，任意非空 Bearer
 * 都接受；只要列表里还有条目，即使全部停用也保持门禁，避免误开放。
 */
function hasApiKeys() {
  return 全部密钥().length > 0;
}

/** 校验下游 token，返回命中的条目（不含 key 本体）或 null。 */
function matchApiKey(token) {
  const text = 字符串(token);
  if (!text) return null;
  let matched = null;
  for (const entry of 启用密钥()) {
    if (时效比较(text, entry.key) && matched === null) {
      matched = {
        id: entry.id,
        label: entry.label,
        source: entry.source,
        rpm: entry.rpm || 0,
        daily: entry.daily || 0,
        models: Array.isArray(entry.models) ? entry.models : [],
      };
    }
  }
  return matched;
}

/** 第一个启用的 key；保留给仍需要单一 key 的调用点。 */
function getApiKey() {
  const entry = 启用密钥()[0];
  return entry ? entry.key : "";
}

function getApiKeySource() {
  const entry = 启用密钥()[0];
  return entry ? entry.source : "none";
}

function getPanelPassword() {
  const stored = 字符串(读取().panelPassword);
  if (stored) return stored;
  return 字符串(process.env.PANEL_PASSWORD);
}

function getPanelPasswordSource() {
  const stored = 字符串(读取().panelPassword);
  if (stored) return "file";
  if (字符串(process.env.PANEL_PASSWORD)) return "env";
  return "none";
}

function 校验密钥(name, value) {
  const text = 字符串(value);
  if (text.length < MIN_SECRET_LENGTH) return `${name}至少需要 ${MIN_SECRET_LENGTH} 个字符。`;
  if (text.length > MAX_SECRET_LENGTH) return `${name}不能超过 ${MAX_SECRET_LENGTH} 个字符。`;
  return null;
}

function 校验标签(value) {
  const text = 字符串(value);
  if (text.length > MAX_LABEL_LENGTH) return `标签不能超过 ${MAX_LABEL_LENGTH} 个字符。`;
  return null;
}

function 预览(key) {
  return key.slice(0, 4) + "…" + key.slice(-2);
}

/** 面板展示用：绝不回传完整密钥。 */
function listApiKeys() {
  return 全部密钥().map(({ id, label, key, enabled, createdAt, source, rpm, daily, models }) => ({
    id,
    label,
    enabled,
    source,
    createdAt,
    preview: 预览(key),
    rpm: rpm || 0,
    daily: daily || 0,
    models: Array.isArray(models) ? models : [],
  }));
}

function addApiKey({ label = "", key = "", rpm = 0, daily = 0, models = [] } = {}) {
  const labelError = 校验标签(label);
  if (labelError) return { ok: false, error: labelError };
  const keyError = 校验密钥("API key", key);
  if (keyError) return { ok: false, error: keyError };
  const text = 字符串(key);
  const data = 读取();
  if (data.apiKeys.length >= MAX_KEYS) return { ok: false, error: `最多只能保存 ${MAX_KEYS} 个 key。` };
  if (全部密钥().some((entry) => 时效比较(entry.key, text))) {
    return { ok: false, error: "这个 key 已经存在。" };
  }
  const entry = {
    id: 新ID(),
    label: 字符串(label) || `key-${data.apiKeys.length + 1}`,
    key: text,
    enabled: true,
    createdAt: Date.now(),
    ...收窄限额({ rpm, daily, models }),
  };
  return { ok: true, data: 写入({ apiKeys: [...data.apiKeys, entry] }) };
}

function updateApiKey(id, { label, enabled, rpm, daily, models } = {}) {
  const data = 读取();
  const index = data.apiKeys.findIndex((entry) => entry.id === id);
  if (index === -1) {
    if (String(id).startsWith("env-")) return { ok: false, error: "环境变量里的 key 只能在部署配置中修改。" };
    return { ok: false, error: "没有这个 key。" };
  }
  if (label !== undefined) {
    const labelError = 校验标签(label);
    if (labelError) return { ok: false, error: labelError };
  }
  const next = data.apiKeys.slice();
  const entry = { ...next[index] };
  if (label !== undefined) entry.label = 字符串(label) || entry.label;
  if (enabled !== undefined) entry.enabled = enabled !== false;
  if (rpm !== undefined || daily !== undefined || models !== undefined) {
    Object.assign(entry, 收窄限额({
      rpm: rpm !== undefined ? rpm : entry.rpm,
      daily: daily !== undefined ? daily : entry.daily,
      models: models !== undefined ? models : entry.models,
    }));
  }
  next[index] = entry;
  return { ok: true, data: 写入({ apiKeys: next }) };
}

function deleteApiKey(id) {
  const data = 读取();
  const next = data.apiKeys.filter((entry) => entry.id !== id);
  if (next.length === data.apiKeys.length) {
    if (String(id).startsWith("env-")) return { ok: false, error: "环境变量里的 key 只能在部署配置中修改。" };
    return { ok: false, error: "没有这个 key。" };
  }
  return { ok: true, data: 写入({ apiKeys: next }) };
}

/** 旧接口：替换第一个 key（没有则新建），保持既有调用点可用。 */
function setApiKey(value) {
  const error = 校验密钥("API key", value);
  if (error) return { ok: false, error };
  const text = 字符串(value);
  const data = 读取();
  if (data.apiKeys.some((entry) => 时效比较(entry.key, text))) {
    return { ok: true, data: 读取() };
  }
  const next = data.apiKeys.slice();
  if (next.length) {
    next[0] = { ...next[0], key: text, enabled: true };
  } else {
    next.push({ id: 新ID(), label: "default", key: text, enabled: true, createdAt: Date.now() });
  }
  return { ok: true, data: 写入({ apiKeys: next }) };
}

function setPanelPassword(value) {
  const error = 校验密钥("密码", value);
  if (error) return { ok: false, error };
  return { ok: true, data: 写入({ panelPassword: value }) };
}

/** 旧接口：清空文件里的全部 key（环境变量 key 不受影响）。 */
function clearApiKey() {
  return { ok: true, data: 写入({ apiKeys: [] }) };
}

function clearPanelPassword() {
  return { ok: true, data: 写入({ panelPassword: "" }) };
}

/** 只暴露存在性与前缀预览，绝不回传完整密钥。 */
function describe() {
  const keys = listApiKeys();
  const first = keys[0];
  return {
    apiKey: {
      configured: keys.length > 0,
      source: first ? first.source : "none",
      preview: first ? first.preview : "",
    },
    apiKeys: keys,
    keyLimit: MAX_KEYS,
    panelPassword: {
      configured: Boolean(getPanelPassword()),
      source: getPanelPasswordSource(),
    },
    file: 配置文件路径(),
    limits: { min: MIN_SECRET_LENGTH, max: MAX_SECRET_LENGTH, maxLabel: MAX_LABEL_LENGTH },
  };
}

module.exports = {
  getApiKey,
  getPanelPassword,
  getApiKeySource,
  getPanelPasswordSource,
  hasApiKeys,
  matchApiKey,
  listApiKeys,
  addApiKey,
  updateApiKey,
  deleteApiKey,
  setApiKey,
  setPanelPassword,
  clearApiKey,
  clearPanelPassword,
  describe,
  配置文件路径,
};
