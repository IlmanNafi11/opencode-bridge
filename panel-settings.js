"use strict";

/**
 * 面板可编辑的凭据：下游 API key 与面板登录密码。
 *
 * 保存在 `<state dir>/settings.json`（mode 0600），与 proxy.json 同目录。
 * 文件里的值优先；没有文件时回落到环境变量（FUCKING_OPENCODE_API_KEYS 取第一个 key，
 * PANEL_PASSWORD 原样使用）。这样已经在用的 env 部署不改变行为，面板里保存
 * 过的值又能立即生效、无需重启。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FILE_NAME = "settings.json";
const MIN_SECRET_LENGTH = 4;
const MAX_SECRET_LENGTH = 200;

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

function 读取() {
  const file = 配置文件路径();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = { key: "", data: {} };
    return cache.data;
  }
  const key = `${file}:${stat.mtimeMs}:${stat.size}`;
  if (key === cache.key) return cache.data;
  let data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") {
      data = {
        apiKey: 字符串(parsed.apiKey),
        panelPassword: 字符串(parsed.panelPassword),
      };
    }
  } catch {
    data = {};
  }
  cache = { key, data };
  return data;
}

function 写入(patch) {
  const next = { ...读取() };
  for (const [field, value] of Object.entries(patch)) {
    if (value === null || value === "") delete next[field];
    else next[field] = 字符串(value);
  }
  const dir = 状态目录();
  fs.mkdirSync(dir, { recursive: true });
  const file = 配置文件路径();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  cache = { key: "", data: {} };
  return 读取();
}

function getApiKey() {
  const stored = 字符串(读取().apiKey);
  if (stored) return stored;
  return 字符串(String(process.env.FUCKING_OPENCODE_API_KEYS || "").split(",")[0]);
}

function getApiKeySource() {
  const stored = 字符串(读取().apiKey);
  if (stored) return "file";
  if (String(process.env.FUCKING_OPENCODE_API_KEYS || "").trim()) return "env";
  return "none";
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

function 校验(name, value) {
  const text = 字符串(value);
  if (text.length < MIN_SECRET_LENGTH) return `${name}至少需要 ${MIN_SECRET_LENGTH} 个字符。`;
  if (text.length > MAX_SECRET_LENGTH) return `${name}不能超过 ${MAX_SECRET_LENGTH} 个字符。`;
  return null;
}

function setApiKey(value) {
  const error = 校验("API key", value);
  if (error) return { ok: false, error };
  return { ok: true, data: 写入({ apiKey: value }) };
}

function setPanelPassword(value) {
  const error = 校验("密码", value);
  if (error) return { ok: false, error };
  return { ok: true, data: 写入({ panelPassword: value }) };
}

function clearApiKey() {
  return { ok: true, data: 写入({ apiKey: null }) };
}

function clearPanelPassword() {
  return { ok: true, data: 写入({ panelPassword: null }) };
}

/** 只暴露存在性与前缀预览，绝不回传完整密钥。 */
function describe() {
  const apiKey = getApiKey();
  return {
    apiKey: {
      configured: Boolean(apiKey),
      source: getApiKeySource(),
      preview: apiKey ? apiKey.slice(0, 4) + "…" + apiKey.slice(-2) : "",
    },
    panelPassword: {
      configured: Boolean(getPanelPassword()),
      source: getPanelPasswordSource(),
    },
    file: 配置文件路径(),
    limits: { min: MIN_SECRET_LENGTH, max: MAX_SECRET_LENGTH },
  };
}

module.exports = {
  getApiKey,
  getPanelPassword,
  getApiKeySource,
  getPanelPasswordSource,
  setApiKey,
  setPanelPassword,
  clearApiKey,
  clearPanelPassword,
  describe,
  配置文件路径,
};
