#!/usr/bin/env bun
/**
 * identity.js — 自适应的 OpenCode CLI 身份与安全层同步。
 *
 * 让桥与官方 OpenCode CLI 保持一致：当上游调整免费档网关（User-Agent 版本
 * 下限、会话 ID 格式、请求头、核心工具指纹定义）时自动跟上。
 *
 * 工作方式：
 *  1. 握手（HANDSHAKE）—— 查询 OpenCode CLI 使用的同一个更新端点：
 *       GET https://opencode.ai/update/api/<channel>/cli/npm?current=<version>
 *       -> { version, minimum, metadata: { github: { sha } } }
 *     更新 API 不可达时回退到 GitHub 的 releases.atom feed。
 *
 *  2. 更新模式（`UPDATE_MODE`）：
 *     - `reactive`（默认）：沿用当前身份，直到上游拒绝请求
 *       （403 FreeTierError / 426 UpgradeRequired）或标记 `minimum: true`，
 *       然后立即刷新并重试该请求一次。
 *     - `always`：惰性 TTL 到期后，主动采纳每个新的 OpenCode 发行版。
 *
 *  3. 源码同步（SOURCE SYNC）—— 迁移到新发行版时（或因网关错误强制刷新时），
 *     按发行版确切的 commit SHA 抓取轻量源码文件，以更新会话 ID 配方、
 *     User-Agent 模板与 `read`/`shell` 工具指纹模式。解析不完整时安全回退到
 *     上一份已知可用值。
 */

const crypto = require("crypto");
// 身份同步也是出站流量：更新握手、GitHub 源码读取、供应商目录，全部走面板
// 配置的同一个代理。
// `proxy.netFetch` 只是 `fetch` 的薄封装，所以替换 `global.fetch` 的测试
// 仍能拦截每一次调用。
//
// 容错加载：2.1.0 安装被它自己的（更老的）更新器升级后可能缺 `proxy.js`，
// 身份同步必须退化为直连，而不是让本可自愈的进程崩掉。
let proxy;
try {
  proxy = require("./proxy");
} catch (err) {
  if (err.code !== "MODULE_NOT_FOUND" || !String(err.message).includes("'./proxy'")) throw err;
  proxy = { netFetch: (url, init) => fetch(url, init) };
}

const UPDATE_API_BASE =
  process.env.OPENCODE_UPDATE_API_BASE || "https://opencode.ai/update/api";
const ATOM_URL =
  process.env.OPENCODE_RELEASES_ATOM_URL ||
  "https://github.com/anomalyco/opencode/releases.atom";
const SOURCE_BASE =
  process.env.OPENCODE_SOURCE_BASE ||
  "https://raw.githubusercontent.com/anomalyco/opencode";

const CHANNEL = process.env.OPENCODE_CHANNEL || "latest";
const ARTIFACT = "cli";
const DISTRIBUTION = process.env.OPENCODE_DISTRIBUTION || "npm";

const IDENTITY_TTL_MS = parseInt(
  process.env.IDENTITY_TTL_MS || String(15 * 60 * 1000),
  10
);
const HANDSHAKE_TIMEOUT_MS = parseInt(
  process.env.HANDSHAKE_TIMEOUT_MS || process.env.IDENTITY_FETCH_TIMEOUT_MS || "6000",
  10
);
const SOURCE_TIMEOUT_MS = parseInt(
  process.env.IDENTITY_SOURCE_TIMEOUT_MS || "8000",
  10
);
const GATE_REFRESH_COOLDOWN_MS = parseInt(
  process.env.GATE_REFRESH_COOLDOWN_MS || "30000",
  10
);

function 取更新模式() {
  const mode = (process.env.UPDATE_MODE || "reactive").toLowerCase().trim();
  return mode === "always" ? "always" : "reactive";
}

// 非工具源码。这些是各自有稳定角色的单文件，所以命名。*工具*源码不在此列：
// 见下面的 PLUGIN_DIR。
const SOURCE_FILES = Object.freeze({
  identifier: "packages/schema/src/identifier.ts",
  sessionId: "packages/schema/src/session-id.ts",
  app: "packages/core/src/app.ts",
  modelRequest: "packages/core/src/session/model-request.ts",
});

// CLI 自带的每个工具都是该目录下的一个文件。清单从发行版树里发现，而不是
// 在这里枚举：上游当年新增 `patch.ts`、`mcp-resource.ts`、`opencode.ts` 时，
// 写死的清单只会继续读它已知的十一个名字，悄悄漏掉新的 —— 这正是本桥要
// 避免的失败。
const PLUGIN_DIR = "packages/core/src/tool/plugin";
// 唯一不是插件文件的线上工具：code mode 的分发器。code mode 启用时它总在，
// 其他（codemode: true）工具都经由它触达。
const CODEMODE_TOOL_FILE = "packages/core/src/codemode/tool.ts";
const GITHUB_API = process.env.OPENCODE_GITHUB_API || "https://api.github.com";
const REPO = process.env.OPENCODE_REPO || "anomalyco/opencode";

// 真 CLI 启动时消费的供应商/模型目录。`opencode` provider 条目带着推理端点
// （`api` 字段）：目前是 `https://opencode.ai/inference/openai/v1`，早先是
// `/zen/v1`。线上 URL 从这里推导，使 /zen → /inference 迁移可被检测 —— URL
// 不再是写死的常量。
const 目录URL = process.env.OPENCODE_CATALOG_URL || "https://models.opencode.ai/api.json";
// 模型别名与免费清单可由目录推导。每次启动都拉一次目录会让冷启动出现空窗：
// 客户端的简写（"mimo"、"deepseek"）会解析不到任何东西。缓存用本进程见过的
// 最后一份真实目录补上这个空窗 —— 而不是手写的名字表（它所替代的东西）。
function 取目录缓存路径() {
  const raw = process.env.OPENCODE_CACHE_DIR;
  if (raw !== undefined) {
    const trimmed = String(raw).trim();
    if (!trimmed || /^(off|0|false|none)$/i.test(trimmed)) return null;
    return trimmed;
  }
  return require("path").join(require("os").homedir(), ".fucking-opencode", "cache");
}
function 取目录缓存文件() {
  const dir = 取目录缓存路径();
  return dir ? require("path").join(dir, "catalog.json") : null;
}
function 取源码缓存文件() {
  const dir = 取目录缓存路径();
  return dir ? require("path").join(dir, "source-当前配方.json") : null;
}
const 启动拉取 = global.fetch;
const 目录缓存目录 = 取目录缓存路径();
const 目录缓存文件 = 取目录缓存文件();

const DEFAULT_RECIPE = Object.freeze({
  channel: "latest",
  version: "2.0.32",
  client: "cli",
  sessionPrefix: "ses_",
  sessionCharset: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  sessionLength: 26,
  sessionMultiplier: 0x1000,
  userAgentTemplate: "opencode/${app.channel}/${app.version}/${app.name}",
  // 线上端点，从上游模型目录解析（`opencode` provider 的 `api` 字段）。这里的
  // 兜底与当前网关一致；刷新时读到的目录会替换它们，所以上游改路径不需要发
  // 新版桥。
  // 新版桥。
  chatUrl: "https://opencode.ai/inference/v1/chat/completions",
  responsesUrl: "https://opencode.ai/inference/v1/responses",
  modelsUrl: "https://opencode.ai/inference/v1/models",
  catalogBase: "https://opencode.ai",
  // 上游自己的请求构造器设置的头名，按它的顺序。这是源码读取失败时的兜底，
  // 所以必须是完整集合 —— 少一个头就会悄悄漏发网关检查的头。
  // 少一个头就会悄悄漏发网关检查的头。
  headers: Object.freeze([
    "x-opencode-session-id",
    "x-session-affinity",
    "X-Session-Id",
    "User-Agent",
    "x-opencode-project",
    "x-opencode-session",
    "x-opencode-client",
  ]),
});

const DEFAULT_TOOLS = Object.freeze({
  read: {
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: {
          type: "integer",
          minimum: 0,
          description: "The line or directory entry to start reading from (1-based)",
        },
        limit: {
          type: "integer",
          minimum: 0,
          description:
            "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  shell: {
    description:
      "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: {
          type: "string",
          description:
            "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
        },
        timeout: {
          type: "integer",
          minimum: 0,
          description:
            "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
        },
        background: {
          type: "boolean",
          description:
            "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
});

const 核心工具名 = ["read", "shell", "bash"];

/**
 * 免费档网关*按名字*要求的工具名，与推导出的配置恰好包含什么无关。
 *
 * 2026-10-18 用逐字节相同的请求对上游实测：从被封出口与干净出口各发一次，
 * 每次只改一个字段：
 *
 *   - 12 个真实工具                     -> 200
 *   - 同样的 12 个去掉 `read`           -> 403 FreeTierError
 *   - 同样的 12 个去掉其他任意工具      -> 200
 *   - 只有 `read`                       -> 200
 *   - `read` + 11 个伪造工具            -> 200
 *   - 一个*名为* `read` 的伪造工具      -> 200
 *   - 真实 `read` 改名为 `read_file`    -> 403
 *
 * 所以检查的是名字，不是描述或模式：编一个*名为* `read` 的假工具照样 200，
 * 而 `read` 配空模式也能过，改名的真实工具却会失败。这一点很重要：配置从
 * 上游自己的插件源码推导 —— 如果上游改名 `read.ts`（或删掉它），推导出的
 * 线上形态就丢了那个名字，网关自然会拒。锚点在，网关回的*正是*它给耗尽 IP
 * 的那个 403。没有这个锚点，桥会把形态问题误报成按 IP 额度问题，而真正原因
 * 是本桥自己产出的形态。
 *
 * 随发行版内置的定义用作兜底，锚点因此能挺过不再携带该名字的配置。
 */
const GATE_ANCHOR_TOOL_NAMES = ["read"];

/**
 * 网关要求的头名，与当前配方列了什么无关。
 *
 * 同法实测（干净出口、带 `read` 工具）：
 *
 *   - 没有 User-Agent                     -> 403
 *   - `opencode`（无版本）                -> 403
 *   - `Mozilla/5.0 …`、`curl/8.18.0`      -> 403
 *   - `opencode/9.9.9`、`OpenCode/2.0.32` -> 200
 *   - 只有 `x-opencode-session`           -> 200
 *   - 只有 `x-session-affinity`           -> 200
 *   - 只有 `x-opencode-session-id`        -> 403
 *   - 没有 `x-opencode-client`/`-project` -> 200
 *
 * 当前配方由上游请求构造器推导，通常已列出这些。仍然钉住：某次配方变更
 * 若丢掉一个，产生的 403 与封 IP 无法区分。
 */
const GATE_ANCHOR_HEADER_NAMES = ["user-agent", "x-opencode-session", "x-session-affinity"];

let 当前配方 = { ...DEFAULT_RECIPE };
let 工具配置 = null;
let 工具配置来源 = "default";
let 工具配置版本 = DEFAULT_RECIPE.version;
// 网关白名单：上游接受的工具名。在发行版 SHA 处从工具插件源码推导；线上发
// 这些名字（模式不参与指纹）。空 = 回退到工具配置自身的键序。
let 工具名集合 = [];
// 供应商目录的按模型路由覆盖（模型 id -> base URL）。
let 模型端点表 = {};
// 从供应商目录推导的免费档模型 id（零成本、未退役）。首次成功读目录前为空。
let 免费模型表 = [];
// id → "free" | "paid" | "deprecated"，直接来自供应商目录。
let 目录裁定表 = {};
// 目录家族 → 该家族的一个免费模型 id（如 "nemotron-free"）。
let 模型家族表 = {};
// id → { reasoning: boolean, maxOutput: number|null }，来自目录。
let 模型事实表 = {};
// 从发行版读取的按模型工具互换（见 extractToolOverrides）。
let 工具覆盖表 = null;
// CLI 在请求时扩展的工具描述（见 提取动态描述）。
let 动态描述表 = null;
// 发行版树里最后见到的工具插件基名。用当前集合播种，目录列举失败时首次刷
// 新也能工作。
let 已知插件 = [
  "edit",
  "glob",
  "grep",
  "mcp-resource",
  "opencode",
  "patch",
  "question",
  "read",
  "shell",
  "skill",
  "subagent",
  "webfetch",
  "websearch",
  "write",
];
let 上次发行版 = null;
let 上次可用 = null;
let 上次检查时间 = 0;
let 刷新进行中 = null;
let 刷新进行中强制 = false;
let versionFloor = null;
let 上次刷新错误 = null;
let 上次源码标签 = null;
let 可选头 = [];
let 上次强制刷新时间 = 0;
let 状态纪元 = 0;
let 刷新代数 = 0;
let 上次同步源码 = null;

function 稳定序列化(val) {
  if (!val || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return "[" + val.map(稳定序列化).join(",") + "]";
  const keys = Object.keys(val).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + 稳定序列化(val[k])).join(",") + "}";
}

function 夹紧字符串(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

// --- 版本与握手辅助 -----------------------------------------------------------

function sortVersions(list) {
  const seen = new Set();
  return list
    .filter((v) => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v))
    .filter((v) => (seen.has(v) ? false : (seen.add(v), true)))
    .sort((a, b) => {
      const [a1, a2, a3] = a.split(".").map(Number);
      const [b1, b2, b3] = b.split(".").map(Number);
      return b1 - a1 || b2 - a2 || b3 - a3;
    });
}

function parseVersions(text) {
  const found = [];
  const re = /<title>v?(\d+\.\d+\.\d+)<\/title>/gi;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) found.push(m[1]);
  return sortVersions(found);
}

function selectVersion(versions) {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  const pinned = process.env.OPENCODE_MAJOR;
  if (pinned && /^\d+$/.test(pinned)) {
    return versions.find((v) => v.split(".")[0] === pinned) || null;
  }
  return versions[0];
}

function compareVersions(a, b) {
  const [a1, a2, a3] = String(a).split(".").map(Number);
  const [b1, b2, b3] = String(b).split(".").map(Number);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

function parseVersionFloor(message) {
  const m = String(message || "").match(/(\d+\.\d+\.\d+)\s+or newer/i);
  return m ? m[1] : null;
}

function sourceRef(release) {
  if (release && release.sha) return release.sha;
  if (release && release.version) return `v${release.version}`;
  return process.env.OPENCODE_SOURCE_REF || "dev";
}

async function 拉取JSON(url, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
  const res = await proxy.netFetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function 拉取文本(url, timeoutMs = SOURCE_TIMEOUT_MS) {
  const res = await proxy.netFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * 列出一个发行版目录里的 `.ts` 文件。
 *
 * 工具插件是发现的，不是枚举的：写死的清单在上游加工具后照样"正常工作"，
 * 也就悄悄停止覆盖发行版。`raw.githubusercontent.com` 列不了目录，
 * 所以每次刷新用一次 contents API；失败返回空清单，
 * 调用方回退到先前已知的集合。
 * 调用方回退到先前已知的集合。
 */
async function 列源码目录(dir, ref, timeoutMs = SOURCE_TIMEOUT_MS) {
  try {
    const res = await proxy.netFetch(
      `${GITHUB_API}/repos/${REPO}/contents/${dir}?ref=${encodeURIComponent(ref)}`,
      { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/vnd.github+json" } }
    );
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json
      .filter((e) => e && e.type === "file" && /^[a-z0-9-]+\.ts$/i.test(e.name))
      .map((e) => e.name.replace(/\.ts$/, ""));
  } catch {
    return [];
  }
}

/**
 * 经 OpenCode 的更新握手解析当前权威 CLI 发行版，
 * 更新 API 不可达时回退到 GitHub Atom feed。
 */
async function resolveRelease(currentVersion = 当前配方.version) {
  const channel = process.env.OPENCODE_CHANNEL || CHANNEL;
  const url =
    `${UPDATE_API_BASE}/${encodeURIComponent(channel)}/${encodeURIComponent(ARTIFACT)}` +
    `/${encodeURIComponent(DISTRIBUTION)}?current=${encodeURIComponent(currentVersion || "0.0.0")}`;
  try {
    const data = await 拉取JSON(url, HANDSHAKE_TIMEOUT_MS);
    const version = typeof data?.version === "string" ? data.version : null;
    if (!version) throw new Error("update service returned no version");
    const github = data?.metadata?.github || {};
    const sha =
      typeof github.sha === "string" && /^[0-9a-f]{7,40}$/i.test(github.sha)
        ? github.sha
        : null;
    上次发行版 = {
      version,
      sha,
      minimum: data.minimum === true,
      active: data.active !== false,
      channel: data.channel || channel,
      source: "update-api",
      resolvedAt: Date.now(),
      stale: false,
    };
    return 上次发行版;
  } catch (primaryErr) {
    try {
      const text = await 拉取文本(ATOM_URL, HANDSHAKE_TIMEOUT_MS);
      const version = selectVersion(parseVersions(text));
      if (!version) throw new Error("no version found in release feed");
      上次发行版 = {
        version,
        sha: null,
        minimum: false,
        active: true,
        channel,
        source: "atom-feed",
        resolvedAt: Date.now(),
        stale: false,
        degraded: `update-api: ${primaryErr.message}`,
      };
      return 上次发行版;
    } catch (feedErr) {
      const error = `update-api: ${primaryErr.message}; atom-feed: ${feedErr.message}`;
      if (上次发行版) return { ...上次发行版, stale: true, error };
      return {
        version: null,
        sha: null,
        minimum: false,
        active: true,
        channel,
        source: "none",
        resolvedAt: null,
        stale: true,
        error,
      };
    }
  }
}

// --- 源码提取（配方 + 工具定义） ---------------------------------------------

function 插值模板(str, vars) {
  return str.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const key = expr.trim();
    if (vars[key] !== undefined) return String(vars[key]);
    // `FileSystem.DEFAULT_SEARCH_LIMIT` 之类：取最后一段并从源码收集的数字
    // 常量里查值。仍无法解析的表达式保持原样，而不是变成换行 —— 描述与 CLI
    // 差一个多余换行就是线上不匹配。
    const tail = key.split(".").pop();
    if (vars[tail] !== undefined) return String(vars[tail]);
    // 日期表达式求值而不是照抄：CLI 发的是当前年份，
    // 字面量 `${new Date().getFullYear()}` 会与它不一致。
    if (/new Date\(\)\.getFullYear\(\)/.test(key)) return String(new Date().getFullYear());
    return `\${${key}}`;
  });
}

/**
 * 从 `open` 处读一个配平的 `{...}` / `(...)` / `[...]` 区段。
 * 带懒惰量词的正则会在第一个 `\n})` 停下，多行 `.annotate({...})` 结构体
 * 之后的字段就是这么丢的。
 */
function 读平衡块(source, openIndex) {
  const open = source[openIndex];
  const close = open === "{" ? "}" : open === "(" ? ")" : "]";
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return null;
}

// 当前发行版抓取的所有源码文件拼接。插件 import 同级模块的结构体/类时，
// 跨文件模式引用据此解析。
let 模式语料 = null;
// 从语料收集的数字/常量绑定，用于插值描述里的 `${...}`。
let 模式变量 = null;
// 基名 → 源码文本，用于解析 `Namespace.Struct` 引用。
let 模式模块 = null;

/** `Schema.Struct({...})` → 完整调用文本，按花括号配平。 */
function 读结构体于(source, indexOfStruct) {
  const paren = source.indexOf("(", indexOfStruct);
  if (paren < 0) return null;
  const args = 读平衡块(source, paren);
  if (!args) return null;
  return `Schema.Struct${args}`;
}

/**
 * 定位工具的输入模式表达式。
 *
 * 上游用三种形态：
 *   1. `export const Input = Schema.Struct({ ... })`
 *   2. `editor.add({...})` 里的 `input: LocationInput`，且定义在上文
 *   3. 作为 `input:` 直接传入的内联 `Schema.Struct({...})`
 */
function 找输入模式(source) {
  const inlineAt = source.search(/input:\s*Schema\.Struct\s*\(/);
  if (inlineAt >= 0) {
    const structAt = source.indexOf("Schema.Struct", inlineAt);
    const full = 读结构体于(source, structAt);
    if (full) return full;
  }

  const named = source.match(/input:\s*([A-Z][A-Za-z0-9_]*)\b/);
  if (named) {
    // 追随别名：`export const Input = LocationInput` 这类。
    // `LocationInput` 持有 Struct（read.ts 就是这么写的）。
    let varName = named[1];
    for (let hop = 0; hop < 3; hop++) {
      const decl = source.match(
        new RegExp(`(?:const|export\\s+const)\\s+${varName}\\s*=\\s*(Schema\\.Struct\\s*\\()`)
      );
      if (decl) {
        const structAt = source.indexOf("Schema.Struct", decl.index);
        const full = 读结构体于(source, structAt);
        if (full) return full;
      }
      const alias = source.match(
        new RegExp(`(?:const|export\\s+const)\\s+${varName}\\s*=\\s*([A-Z][A-Za-z0-9_]*)\\b`)
      );
      if (!alias) break;
      varName = alias[1];
    }
  }

  const exportedAt = source.search(/export\s+const\s+Input\s*=\s*Schema\.Struct\s*\(/);
  if (exportedAt >= 0) {
    const structAt = source.indexOf("Schema.Struct", exportedAt);
    return 读结构体于(source, structAt);
  }
  return null;
}

/** 按顶层逗号切分 `{ a: x, b: y }` 体（忽略嵌套花括号、
 *  方括号、圆括号、字符串与模板字面量）。 */
function 切顶层(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (start < body.length) parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** 反转义描述字符串里有意义的转义。 */
function 反转义字面量(text) {
  if (typeof text !== "string") return text;
  // 单次从左到右扫描，每个转义恰好消费一次。
  // 顺序替换会把 `\\n`（转义的反斜杠后跟 n，即字符 `\n`）
  // 弄成反斜杠 + 换行。
  return text.replace(/\\(r\\n|n|t|"|'|`|\\)/g, (_, seq) => {
    switch (seq) {
      case "r\n":
      case "n":
        return "\n";
      case "t":
        return "\t";
      case '"':
        return '"';
      case "'":
        return "'";
      case "`":
        return "`";
      case "\\":
        return "\\";
      default:
        return seq;
    }
  });
}

/** 读 JS 字符串/模板字面量体并反转义。 */
function 读字符串字面量(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/s);
  if (!m) return null;
  const text = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
  return 反转义字面量(text);
}

/**
 * 把一个字段的模式表达式求值成 JSON Schema 片段及其必填性。只认识上游用
 * 的构造器；认不出的退化为 `{ type: "string" }`。
 */
function parseFieldSchema(expr, source) {
  let required = true;
  let schema = {};

  // 先剥修饰符，最外层优先。
  let working = expr.trim();
  const optional =
    /Schema\.optionalKey\(/.test(working) ||
    /Schema\.optional\(/.test(working) ||
    // 解码默认值让字段在线上可省略，即便模式本身没包 optionalKey
    // （webfetch 的 `format`）。
    /withDecodingDefault(Key)?\(/.test(working) ||
    // `.pipe(optional)` / `.pipe(Schema.optional)` —— 共享的 `optional`
    // 辅助函数见 packages/schema/src/schema.ts。
    /\.pipe\(\s*(?:Schema\.)?optional\b/.test(working);
  if (optional) required = false;

  // 先收集描述与约束，再按 CLI 的输出顺序应用（`type`、边界、`description`）
  // —— 上游对比线上体，键序是精确匹配的一部分。
  // —— 上游对比线上体，键序是精确匹配的一部分。
  let description = null;
  const annotate = working.match(/\.annotate\(\{\s*description:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/s);
  if (annotate) {
    description = 读字符串字面量(annotate[1]);
    if (description && 模式变量) description = 插值模板(description, 模式变量);
    // 注解相对 `.pipe(...)` 的位置决定它是否到达线上：`Schema.X.annotate({...}).pipe(...)`
    // 会保留（webfetch 的 `format`），而 `Schema.X.pipe(...).annotate({...})`
    // 不会（question 的 `multiple`）。比较位置，而不是只看有没有 pipe。
    const pipeAt = working.indexOf(".pipe(");
    const annotateAt = working.indexOf(".annotate(");
    if (pipeAt >= 0 && annotateAt > pipeAt) description = null;
  }

  // 基类型，取最内层构造器。局部别名
  // （`const Timeout = Schema.Finite.check(...)`）先展开，这样类型与约束
  // 都从它实际是什么读出。
  let core = working
    .replace(/Schema\.optionalKey\(/g, "(")
    .replace(/Schema\.optional\(/g, "(");
  let expanded = core;
  const aliasMatch = core.match(/^\s*\(?\s*([A-Z][A-Za-z0-9_]*)\b/);
  // 只展开*局部*别名：`Schema` 本身不行，结构体/类引用
  // （`Question.Prompt`、`FileSystem.GlobInput`）也不行。
  const isLocalAlias =
    aliasMatch &&
    aliasMatch[1] !== "Schema" &&
    !/\./.test(core.slice(aliasMatch.index + aliasMatch[0].length).trim().slice(0, 1)) &&
    模式语料 &&
    new RegExp(`const\\s+${aliasMatch[1]}\\s*=\\s*Schema\\.`).test(模式语料);
  if (isLocalAlias) {
    const decl = 模式语料.match(new RegExp(`const\\s+${aliasMatch[1]}\\s*=\\s*([^\\n]+)`));
    if (decl) {
      expanded = `${decl[1]} ${core}`;
      core = expanded;
    }
  }

  const constraints = {};
  const minLength = working.match(/\.check\(\s*Schema\.isMinLength\(\s*(\d+)/);
  if (minLength) constraints.minLength = Number(minLength[1]);
  const maxLength = working.match(/\.check\(\s*Schema\.isMaxLength\(\s*(\d+)/);
  if (maxLength) constraints.maxLength = Number(maxLength[1]);
  if (/\.check\(\s*Schema\.isNonEmpty\(\)/.test(expanded)) constraints.minItems = 1;
  if (/\.check\([^)]*Schema\.isGreaterThan\(\s*0\s*\)/.test(expanded)) constraints.exclusiveMinimum = 0;
  const maxValue = expanded.match(/\.check\(\s*Schema\.isLessThanOrEqualTo\(\s*(\d+)/);
  if (maxValue) constraints.maximum = Number(maxValue[1]);
  // `Timeout` 的上限存放在具名常量里。
  if (/^\s*(?:Schema\.optionalKey\()?\s*Timeout\b/.test(working) && 模式变量 && Number.isFinite(模式变量.MAX_TIMEOUT_SECONDS)) {
    constraints.maximum = 模式变量.MAX_TIMEOUT_SECONDS;
  }

  if (/Schema\.Literals\(\s*\[([^\]]*)\]/.test(core)) {
    const list = core.match(/Schema\.Literals\(\s*\[([^\]]*)\]/)[1];
    const values = [...list.matchAll(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)].map((m) =>
      读字符串字面量(m[1])
    );
    schema = { ...schema, type: "string", enum: values };
  } else if (/Schema\.Array\(/.test(core)) {
    const inner = core.match(/Schema\.Array\(([\s\S]*)\)/);
    const itemExpr = inner ? inner[1] : "";
    // 嵌套 Struct 变成带自己字段的对象模式。
    const struct = itemExpr.match(/Schema\.Struct\(\{([\s\S]*)\n\s*\}\)/);
    if (struct) {
      const nested = 解析结构体体(struct[1], source);
      schema = { ...schema, type: "array", items: { type: "object", ...nested } };
    } else if (/\.fields\.[a-zA-Z]/.test(itemExpr)) {
      // `SomeClass.fields.x` —— 单个字段，不是结构体。
      const ref = itemExpr.match(/^\s*([A-Za-z][A-Za-z0-9_.]*)/);
      const resolved = ref ? 解析结构体引用(ref[1], source) : null;
      schema = { ...schema, type: "array", items: resolved || { type: "string" } };
    } else {
      // `Schema.Array(Question.Prompt)` —— 具名结构体/类。
      const ref = itemExpr.match(/^\s*([A-Za-z][A-Za-z0-9_.]*)/);
      const resolved = ref ? 解析结构体引用(ref[1], source) : null;
      schema = { ...schema, type: "array", items: resolved || { type: "string" } };
    }
  } else if (/\bBoolean\b/.test(core)) {
    schema = { ...schema, type: "boolean" };
  } else if (/\bPositiveInt\b/.test(core)) {
    schema = { ...schema, type: "integer", exclusiveMinimum: 0 };
  } else if (/\bNonNegativeInt\b/.test(core)) {
    schema = { ...schema, type: "integer", minimum: 0 };
  } else if (/Schema\.(?:Int|Number|Finite)\b/.test(core)) {
    schema = { ...schema, type: "number" };
  } else if (/\bSession[A-Za-z]*\.ID\b/.test(core) || /\bSessionID\b/.test(core)) {
    schema = { ...schema, type: "string", pattern: "^ses" };
  } else if (/\.fields\.[A-Za-z0-9_]+/.test(core)) {
    // 从共享结构体借来的字段：`PageInput.fields.offset`。
    // `ReadToolFileSystem.PageInput.fields.limit`、`GlobInput.fields.hidden`。
    // 字段的类型与可选性都住在源结构体上，所以去那里解析，
    // 而不是按名字猜。`ReadToolFileSystem` 是 namespace import，
    // 所以结构体是 `.fields` 前紧邻的那段。
    const ref = core.match(/([A-Z][A-Za-z0-9_]*)\.fields\.([A-Za-z0-9_]+)/);
    const resolved = ref ? 解析结构体字段(ref[1], ref[2], source) : null;
    if (resolved) {
      schema = { ...resolved.schema, ...schema };
      if (resolved.optional) required = false;
    } else {
      // 无法解析（该引用无语料）。页字段是常见情形：read 上的 offset/limit。
      // 猜真实形态比发 `string` + 必填好 —— 后者是更差的线上匹配，
      // 还会把它们标成必填。
      // 还会把它们标成必填。
      const field = ref ? ref[2] : "";
      if (/^(offset|limit)$/.test(field)) {
        schema = { ...schema, type: "integer", minimum: 0 };
        required = false;
      } else if (/^(hidden|literal|caseSensitive|background)$/.test(field)) {
        schema = { ...schema, type: "boolean" };
      } else {
        schema = { ...schema, type: "string" };
      }
    }
  } else {
    schema = { ...schema, type: "string" };
  }

  // `Timeout` 是带最大值约束的 brand 数字，webfetch 在用。只有
  // 表达式正是这个 brand 时才匹配 —— `NonNegativeInt` 也出现在
  // shell 的 timeout 字段里，匹配任意出现会改掉它的类型。
  if (/^\s*(?:Schema\.optionalKey\()?\s*Timeout\b/.test(core)) {
    schema = { ...schema, type: "number", exclusiveMinimum: 0 };
  }

  // 按线上顺序组装：type → 约束 → description。先发 `description`
  // 会得到与 CLI 自己的 JSON Schema 不同的键序。
  const merged = { ...schema, ...constraints };
  const ordered = {};
  for (const k of ["type", "minLength", "maxLength", "minimum", "exclusiveMinimum", "maximum", "pattern", "enum", "items", "minItems"]) {
    if (merged[k] !== undefined) ordered[k] = merged[k];
  }
  if (description) ordered.description = description;

  return { required, schema: ordered };
}

/** `Schema.Struct({...})` 体 → { properties, required, additionalProperties }。 */
function 解析结构体体(body, source) {
  const properties = {};
  const required = [];
  for (const part of 切顶层(body)) {
    const m = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/);
    if (!m) continue;
    const [, key, expr] = m;
    const { required: isRequired, schema } = parseFieldSchema(expr, source);
    properties[key] = schema;
    if (isRequired) required.push(key);
  }
  return { properties, required, additionalProperties: false };
}

function parseSchemaExpr(expr, source) {
  const text = String(expr);
  const structAt = text.indexOf("Schema.Struct");
  if (structAt < 0) return null;
  const paren = text.indexOf("(", structAt);
  const args = 读平衡块(text, paren);
  if (!args) return null;

  // `Schema.Struct({ ... })` —— 字面量字段。
  const brace = args.indexOf("{");
  if (brace >= 0) {
    const body = 读平衡块(args, brace);
    if (body) return 解析结构体体(body.slice(1, -1), source);
  }

  // `Schema.Struct(base)` —— 字段住在具名对象字面量里，声明在
  // 上文（`const base = { ... }`），Question.Prompt 就是这么写的。
  const ref = args.slice(1, -1).trim().match(/^([A-Za-z_$][\w$]*)$/);
  if (ref) {
    const at = source.search(new RegExp(`const\\s+${ref[1]}\\s*=\\s*\\{`));
    if (at >= 0) {
      const objBrace = source.indexOf("{", at);
      const body = 读平衡块(source, objBrace);
      if (body) return 解析结构体体(body.slice(1, -1), source);
    }
  }
  return null;
}

/** 把 `Question.Prompt` 解析到同一文件里声明的 `Prompt` 结构体。 */
function 解析结构体引用(name, source) {
  const parts = String(name).split(".");
  const short = parts.pop();
  // 对 `Question.Prompt`，优先定义 `Question` 模块的文件：
  // 拼接语料里有大量无关的 `Prompt` 声明，取第一个匹配会解析到完全不同
  // 的结构体。
  if (parts.length > 0 && 模式模块) {
    const namespace = parts[parts.length - 1];
    const mod = 模式模块.get(namespace);
    if (mod) {
      // 只在该模块内解析这个结构体。带 `short` 递归会无命名空间地重入本函数，
      // 回退到拼接语料 —— 产出错误结构体的正是那条路。
      // 回退到拼接语料 —— 产出错误结构体的正是那条路。
      const at = mod.search(
        new RegExp(`(?:const|export\\s+const)\\s+${short}\\s*=\\s*Schema\\.Struct\\s*\\(`)
      );
      if (at >= 0) {
        const structAt = mod.indexOf("Schema.Struct", at);
        const parsed = parseSchemaExpr(mod.slice(structAt, structAt + 6000), mod);
        if (parsed) return { type: "object", ...parsed };
      }
    }
  }
  const at = source.search(new RegExp(`(?:const|export\\s+const)\\s+${short}\\s*=\\s*Schema\\.Struct\\s*\\(`));
  if (at < 0 && typeof 模式语料 === "string" && 模式语料 !== source) {
    return 解析结构体引用(short, 模式语料);
  }
  if (at < 0) return null;
  const structAt = source.indexOf("Schema.Struct", at);
  const parsed = parseSchemaExpr(source.slice(structAt, structAt + 4000), source);
  if (!parsed) return null;
  return { type: "object", ...parsed };
}

/**
 * 从声明它的结构体解析 `SomeStruct.fields.name`。
 *
 * 结构体可能是 `const X = Schema.Struct({...})` 或
 * `class X extends Schema.Class<X>(...)({...})`，而且它可能住在插件 import
 * 的模块里而非插件本身 —— `read.ts` 引用 `ReadToolFileSystem.PageInput`，
 * 它声明在 `read-filesystem.ts`。
 */
function 解析结构体字段(structName, field, source) {
  for (const corpus of [source, typeof 模式语料 === "string" ? 模式语料 : null]) {
    if (!corpus) continue;
    for (const part of 结构体字段表(structName, corpus)) {
      const m = part.match(new RegExp(`^${field}\\s*:\\s*([\\s\\S]+)$`));
      if (!m) continue;
      const parsed = parseFieldSchema(m[1], corpus);
      return { schema: parsed.schema, optional: !parsed.required };
    }
  }
  return null;
}

/** 结构体/类声明的字段清单，无论出现在哪里。 */
function 结构体字段表(structName, corpus) {
  const out = [];
  // const X = Schema.Struct({ ... })
  const constAt = corpus.search(
    new RegExp(`(?:const|export\\s+const)\\s+${structName}\\s*=\\s*Schema\\.Struct\\s*\\(`)
  );
  if (constAt >= 0) {
    const structAt = corpus.indexOf("Schema.Struct", constAt);
    const args = 读平衡块(corpus, corpus.indexOf("(", structAt));
    const brace = args ? args.indexOf("{") : -1;
    const body = brace >= 0 ? 读平衡块(args, brace) : null;
    if (body) out.push(...切顶层(body.slice(1, -1)));
  }
  // class X extends Schema.Class<X>("...")({ ... })
  const classAt = corpus.search(new RegExp(`class\\s+${structName}\\b`));
  if (classAt >= 0) {
    const paren = corpus.indexOf("(", classAt);
    const first = paren >= 0 ? 读平衡块(corpus, paren) : null;
    if (first) {
      const after = corpus.indexOf("(", paren + first.length);
      const second = after >= 0 ? 读平衡块(corpus, after) : null;
      const brace = second ? second.indexOf("{") : -1;
      const body = brace >= 0 ? 读平衡块(second, brace) : null;
      if (body) out.push(...切顶层(body.slice(1, -1)));
    }
  }
  return out;
}

/**
 * 从单个工具的 TypeScript 插件源码（`read.ts` 或 `shell.ts`）直接提取它的
 * 线上定义（`description` + JSON Schema `parameters`）。
 */
function extractToolFromSource(source, fallbackName) {
  if (typeof source !== "string" || !source.trim()) return null;

  const nameMatch = source.match(/export\s+const\s+name\s*=\s*"([a-z][a-z0-9_-]*)"/i);
  const name = nameMatch ? nameMatch[1] : fallbackName;
  if (!name) return null;

  const vars = { OS: "Linux", shell: "bash" };
  // 语料里声明的常量（含导入模块），模板插值才能解析
  // `FileSystem.DEFAULT_SEARCH_LIMIT` 这类引用。
  const corpusForVars = typeof 模式语料 === "string" ? `${source}\n${模式语料}` : source;
  for (const m of corpusForVars.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*([0-9][0-9_*\s+]*)/g)) {
    const clean = m[2].replace(/_/g, "").trim();
    if (/^[0-9*\s+]+$/.test(clean)) {
      const val = clean
        .split("+")
        .map((part) => part.split("*").reduce((acc, n) => acc * Number(n.trim()), 1))
        .reduce((a, b) => a + b, 0);
      if (Number.isFinite(val)) vars[m[1]] = val;
    }
  }

  // 描述可以住在同级 `.txt` 文件（`patch.ts` 就这样：
  // `import DESCRIPTION from "../patch.txt"`）。提取器读不了文件，
  // 所以它上报引用，刷新时再去抓。
  const txtImport = source.match(/import\s+([A-Za-z_$][\w$]*)\s+from\s+"(\.\.?\/[^"]+\.txt)"/);

  // 1. 工具描述。上游有三种形态：
  //    (a) 数组字面量（可选包在箭头函数里），用 " " 或 "\n" 拼接
  //    (b) 导出的模板/字符串字面量
  //    (c) `editor.add({ ... })` 里的 `description` 键
  let description = null;
  const builderMatch = source.match(
    /const\s+description\s*=\s*(?:\([^)]*\)\s*=>\s*)?\[([\s\S]*?)\]\.join\(\s*(?:"([^"]*)"|'([^']*)')\s*\)/m
  );
  const litRe = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  if (builderMatch) {
    // 组是拼接器的*内容*（`" "` 得到空格，`"\n"` 得到换行）。
    const rawJoiner = builderMatch[2] !== undefined ? builderMatch[2] : builderMatch[3];
    const joiner = String(rawJoiner === undefined ? " " : rawJoiner).replace(/\\n/g, "\n");
    const parts = [];
    let lm;
    while ((lm = litRe.exec(builderMatch[1])) !== null) {
      const raw =
        lm[1] !== undefined
          ? 反转义字面量(lm[1])
          : 插值模板(反转义字面量(lm[2] !== undefined ? lm[2] : lm[3] || ""), vars);
      // 空字面量是拼接描述里刻意留的空行
      // （`skill` 就是这样分隔段落）；丢掉它会让文本与 CLI 差一个换行。
      parts.push(raw);
    }
    if (parts.length > 0) description = parts.join(joiner);
  } else {
    // 多行模板字面量。收尾反引号必须是*未转义*的：描述里若引用代码
    // （`` \`multiple: true\` ``）会含转义反引号，懒惰匹配会停在第一个。
    const tpl = source.match(/export\s+const\s+description\s*=\s*`((?:[^`\\]|\\.)*)`/s);
    if (tpl) description = 插值模板(反转义字面量(tpl[1]), vars);
    else {
      const dq = source.match(/export\s+const\s+description\s*=\s*"((?:[^"\\]|\\.)*)"/m);
      const sq = source.match(/export\s+const\s+description\s*=\s*'((?:[^'\\]|\\.)*)'/m);
      if (dq) description = 反转义字面量(dq[1]);
      else if (sq) description = 插值模板(反转义字面量(sq[1]), vars);
    }
  }
  if (!description || description.length < 20) {
    const addBlock0 = source.match(/editor\.add\(\{([\s\S]*?)\binput\s*:/);
    if (addBlock0) {
      const descMatch0 = addBlock0[1].match(
        /description\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/
      );
      if (descMatch0) {
        description =
          descMatch0[1] !== undefined
            ? 反转义字面量(descMatch0[1])
            : 插值模板(
                反转义字面量(descMatch0[2] !== undefined ? descMatch0[2] : descMatch0[3] || ""),
                vars
              );
      }
    }
  }
  if ((!description || description.length < 20) && txtImport) {
    return {
      name,
      description: null,
      descriptionFile: txtImport[2],
      descriptionVar: txtImport[1],
      parameters: null,
    };
  }
  if (!description || description.length < 20) {
    // 从同级 `.txt` 替换来的字面量是纯字符串，不是
    // `export const description = ...`，所以从 add 块里读。
    const fromAdd = source.match(/description\s*:\s*"((?:[^"\\]|\\.){20,})"/);
    if (fromAdd) description = fromAdd[1].replace(/\\n/g, "\n");
  }
  if (!description || description.length < 20) return null;

  // 2. 输入模式。上游把这些写成 Effect Schema 表达式，
  //    最终到达线上的形态是由它们推导出的 JSON Schema。与其逐个匹配每种
  //    写法，这里解析字段清单，并对上游实际用到的那组小而封闭的构造器求值：
  //    Schema.String / Number / Int / Boolean / Array / Literals / Struct、
  //    optionalKey、annotate（description）、check（minLength），以及共享
  //    类字段（`FileSystem.GlobInput.fields.hidden`）。认不出的构造退化为
  //    普通字符串 —— 这是旧行为 —— 但认得出的现在会带上真实类型、枚举、
  //    边界与必填性。
  const inputExpr = 找输入模式(source);
  if (!inputExpr) return null;
  const parsed = parseSchemaExpr(inputExpr, source);
  if (!parsed || Object.keys(parsed.properties).length === 0) return null;
  const { properties, required } = parsed;

  return {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

/**
 * 从上游供应商目录解析线上端点。
 *
 * 目录与真 CLI 启动时读的是同一份文件
 * （`models.opencode.ai/api.json`）。它的 `opencode` provider 条目带着
 * 当前线上推理基址 —— /zen/v1 → /inference/v1 这类迁移本可由此浮出而不必发
 * 新版桥。每个解析出的 URL 采用前先做合理性检查；畸形目录不改变任何东西。
 */
function 读缓存目录() {
  try {
    const file = 取目录缓存文件();
    if (!file) return null;
    const fs = require("fs");
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    // 缓存目录只有在结构上是目录时才有用。
    if (parsed && typeof parsed === "object" && parsed.opencode) return parsed;
  } catch {}
  return null;
}

function 写缓存目录(json) {
  try {
    const dir = 取目录缓存路径();
    const file = 取目录缓存文件();
    if (!dir || !file) return;
    const fs = require("fs");
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(json));
    fs.renameSync(tmp, file);
  } catch {
    // 只读 HOME 不能弄崩桥；抓取照样成功，只是本进程下次没有热启动。
    // 只是本进程下次没有热启动。
  }
}

function readCachedSource(expectedRef = null) {
  try {
    const file = 取源码缓存文件();
    if (!file) return null;
    const fs = require("fs");
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.ref === "string" &&
      parsed.extracted &&
      typeof parsed.extracted === "object"
    ) {
      if (expectedRef && parsed.ref !== expectedRef) return null;
      return parsed;
    }
  } catch {}
  return null;
}

function writeCachedSource(ref, extracted) {
  if (!ref || !extracted || typeof extracted !== "object") return;
  try {
    const dir = 取目录缓存路径();
    const file = 取源码缓存文件();
    if (!dir || !file) return;
    const fs = require("fs");
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ref, extracted, savedAt: Date.now() }));
    fs.renameSync(tmp, file);
  } catch {}
}

function 是可信目录源(url) {
  return typeof url === "string" && /^https:\/\/([a-z0-9-]+\.)*opencode\.ai(\/|$)/i.test(url);
}

function parseCatalogData(json) {
  const out = {};
  const oc = json?.opencode;
  if (!oc || typeof oc !== "object") return out;
  const api = typeof oc.api === "string" ? oc.api.replace(/\/+$/, "") : null;
  if (api && 是可信目录源(api)) {
    out.catalogBase = api;
    out.chatUrl = `${api}/chat/completions`;
    // Responses 通道是同一基址加 /responses —— 真 CLI 的 @ai-sdk/openai 路由
    // 就这么建。推导出的 URL 与 chat URL 相同（畸形目录）时保留现值。
    // 就这么建。推导出的 URL 与 chat URL 相同（畸形目录）时保留现值。
    if (api.endsWith("/v1")) out.responsesUrl = `${api}/responses`;
  }
  // 按模型路由覆盖。目录允许单个模型钉不同基址（如 /inference/anthropic/v1
  // 下的 anthropic 协议模型）。本桥只讲 OpenAI 协议，所以只有当模型 SDK 兼容
  // OpenAI 时才采纳覆盖；anthropic 专属路由保持原样，不悄悄错路由。
  // OpenAI 时才采纳覆盖；anthropic 专属路由保持原样，不悄悄错路由。
  // 专属路由保持原样，不悄悄错路由。
  const overrides = {};
  for (const [id, m] of Object.entries(oc.models || {})) {
    const mp = m?.provider?.api;
    if (typeof mp !== "string" || !是可信目录源(mp)) continue;
    const npm = String(m?.provider?.npm || oc.npm || "");
    if (!npm.startsWith("@ai-sdk/openai")) continue;
    const base = mp.replace(/\/+$/, "");
    if (base !== api) overrides[id.toLowerCase()] = base;
  }
  if (Object.keys(overrides).length > 0) out.modelEndpoints = overrides;
  // 免费清单是目录事实，不是命名约定。从 `cost` + `status` 推导正是 CLI 自身
  // 的做法（models-dev.ts 映射 `status ?? "active"` 并保留零成本模型），所以
  // 模型变付费或退役时自动退出，无需发新版桥 —— 而免费但缺席网关 /models 的
  // 也不会丢。
  //
  // `目录裁定表` 记录目录描述的每个模型，所以调用方能区分"目录说这个是付费/
  // 退役"与"目录没读过"（网关列了几个目录漏掉的评测模型）。
  const 免费模型表 = [];
  const verdicts = {};
  const 模型事实表 = {};
  for (const [id, m] of Object.entries(oc?.models || {})) {
    const zeroCost = Number(m?.cost?.input) === 0 && Number(m?.cost?.output) === 0;
    const deprecated = m?.status === "deprecated";
    const usable = m?.tool_call !== false;
    const key = id.toLowerCase();
    verdicts[key] = deprecated ? "deprecated" : zeroCost && usable ? "free" : "paid";
    if (verdicts[key] === "free") 免费模型表.push(id);
    // 线上依赖的模型事实。`reasoning` 决定客户端令牌预算是否需要思考余量
    // （token-budget.js 曾按名字子串猜），`limit.output` 封顶一个请求。
    if (typeof m?.reasoning === "boolean") {
      模型事实表[key] = {
        reasoning: m.reasoning,
        maxOutput: Number(m?.limit?.output) > 0 ? Number(m.limit.output) : null,
      };
    }
  }
  if (免费模型表.length > 0) out.freeModels = 免费模型表;
  if (Object.keys(verdicts).length > 0) out.catalogVerdicts = verdicts;
  if (Object.keys(模型事实表).length > 0) out.modelFacts = 模型事实表;

  // 简写别名，从目录自己的 `family` 字段推导，而不是手写表。`family` 把一个
  // 模型的各修订分组（`nemotron-free`、`deepseek-flash`），所以最新的未退役
  // 免费成员回答家族名 —— 修订退役时别名自动跟随。
  const families = {};
  for (const [id, m] of Object.entries(oc.models || {})) {
    if (verdicts[id.toLowerCase()] !== "free") continue;
    const family = typeof m?.family === "string" ? m.family.trim().toLowerCase() : "";
    if (!family) continue;
    if (!families[family]) families[family] = id;
  }
  if (Object.keys(families).length > 0) out.modelFamilies = families;

  return out;
}

async function extractCatalog() {
  let json;
  let fromCache = false;
  try {
    json = await 拉取JSON(目录URL, SOURCE_TIMEOUT_MS);
    写缓存目录(json);
  } catch {
    // 网络不可用：回退到本机最后见过的目录，别名与免费清单离线照常工作，
    // 而不是清空。
    json = 读缓存目录();
    if (!json) return {};
    fromCache = true;
  }
  const out = parseCatalogData(json);
  if (fromCache) out.fromCache = true;
  return out;
}

/**
 * 从抓取的所有工具源码文件提取工具*名清单*（网关白名单）。模式细节是次要
 * 的 —— 上游网关按清单校验工具名（模式内容不参与指纹），
 * 所以线上要的是正确名字，不是逐字节相同的模式。
 */
/**
 * 哪些工具出现在模型的工具清单里。
 *
 * 上游用注册块里的 `options: { codemode: false }` 逐工具决定：这些直接上线，
 * 其余经 `execute` 工具触达。对真 CLI 请求实测：线上恰好带 `codemode: false`
 * 那一组（外加 `execute`）。从该标志推导意味着移入 code mode 的工具自动退出，
 * 新的直连工具自动出现，这里无须点名任何一个。
 */
function extractToolNames(files = {}) {
  const names = [];
  const seen = new Set();
  for (const key of Object.keys(files)) {
    if (!key.startsWith("tool:")) continue;
    const source = files[key];
    if (typeof source !== "string" || !source.trim()) continue;

    const exported = (source.match(/export\s+const\s+name\s*=\s*"([a-z][a-z0-9_-]*)"/i) || [])[1];
    const fallback = key.replace(/^tool:/, "").replace(/[^a-z0-9_-]/gi, "");

    for (const block of 注册封锁(source)) {
      if (!/codemode:\s*false/.test(block.body)) continue;
      const literal = (block.body.match(/name:\s*"([a-z][a-z0-9_-]*)"/i) || [])[1];
      // `name,`（导出常量的简写）或没有字面量的 `name:`。
      const shorthand = /^\s*name\s*,/m.test(block.body) || /name:\s*name\b/.test(block.body);
      const name = literal || (shorthand ? exported || fallback : null);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * 源码文件里每个 `editor.add({ ... })` / `draft.add({ ... })` 注册及其参数文本。
 * 花括号按计数配平，嵌套对象也能整段取出。
 * `execute:` 闭包不会像正则那样把块截断。
 */
function 注册封锁(source) {
  const blocks = [];
  const re = /(?:editor|draft)\.add\(/g;
  let m;
  while ((m = re.exec(source))) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth === 0) blocks.push({ body: source.slice(start, i), index: m.index });
  }
  return blocks;
}

/**
 * 按模型区分的工具集覆盖，从源码提取。
 *
 * `patch.ts` 安装一个会话钩子，按模型互换编辑工具：
 * GPT 系（除 `oss` 与 `gpt-4`）拿 `patch`、丢 `edit`/`write`；
 * 其余保留 `edit`/`write`、丢 `patch`。真 CLI 对非 GPT 模型的请求因此带十一个
 * 工具且无 `patch`，GPT 模型则带 `patch` 而无 `edit`+`write`。固定列表表达
 * 不了这个，所以规则从发行版读取、逐请求应用。
 */
/**
 * 上游在请求时扩展的描述。
 *
 * `subagent.ts` 在每次请求时重写描述，追加调用方可用的 agent 动态尾部。
 * 清单本身是会话状态，发行版源码给不了，但*形态*给得了：空行、标题、若干
 * 条目 —— 固定前缀与 CLI 完全一致，动态尾部被每个 agent 的
 * `- <id>: <description>` 行显式标记，不会悄悄缺失。
 */
function 提取动态描述(files = {}) {
  const out = {};
  for (const key of Object.keys(files)) {
    if (!key.startsWith("tool:")) continue;
    const source = files[key];
    if (typeof source !== "string") continue;
    if (!/tool\.description\s*=\s*\[/.test(source)) continue;
    const exported = source.match(/export\s+const\s+name\s*=\s*"([a-z][a-z0-9_-]*)"/i);
    const block = source.match(/tool\.description\s*=\s*\[([\s\S]*?)\]\.join\(\s*"([^"]*)"\s*\)/);
    if (!exported || !block) continue;
    const literals = [...block[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => 反转义字面量(m[1]));
    out[exported[1]] = {
      appendPrefix: literals,
      joiner: block[2] === "\n" ? "\n" : block[2],
      itemTemplate: (block[1].match(/`([^`]*\$\{[^}]*\}[^`]*)`/) || [])[1] || null,
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

function extractToolOverrides(files = {}) {
  for (const key of Object.keys(files)) {
    if (!key.startsWith("tool:")) continue;
    const source = files[key];
    if (typeof source !== "string") continue;
    const usesPatch = source.match(
      /const\s+usePatch\s*=\s*([^\n]+)\n([\s\S]{0,400}?)(?=\n\s*\}\s*\n)/
    );
    if (!usesPatch) continue;
    const condition = usesPatch[1].trim();
    const body = usesPatch[2];
    const removedForPatch = [...body.matchAll(/delete\s+event\.tools\.([a-z_]+)/g)].map((m) => m[1]);
    // `else` 分支删的是另一侧；看第二个 delete 块。
    const allRemoved = [...source.matchAll(/delete\s+event\.tools\.([a-z_]+)/g)].map((m) => m[1]);
    const addedForPatch = allRemoved.filter((n) => !removedForPatch.includes(n));
    if (removedForPatch.length === 0) continue;
    return {
      // 条件原样保留，由桥对模型 id 求值 —— 上游改规则时随发行版一起走。
      condition,
      whenTrueRemove: removedForPatch,
      whenTrueAdd: addedForPatch,
      whenFalseRemove: addedForPatch,
      whenFalseAdd: removedForPatch,
    };
  }
  return null;
}

/**
 * 从上游源码文件提取会话 ID、User-Agent 模板、请求头与工具模式。
 */
function extractRecipe(files = {}) {
  const out = {};

  const identifier = files.identifier;
  if (typeof identifier === "string") {
    const charset = identifier.match(/const\s+chars\s*=\s*"([^"]+)"/);
    if (charset && charset[1].length >= 2) out.sessionCharset = charset[1];

    const length = identifier.match(/const\s+length\s*=\s*(\d+)/);
    if (length) {
      const n = parseInt(length[1], 10);
      if (n >= 16 && n <= 64) out.sessionLength = n;
    }

    const multiplier = identifier.match(
      /BigInt\(timestamp\)\s*\*\s*0x([0-9a-fA-F]+)n/
    );
    if (multiplier) {
      const n = parseInt(multiplier[1], 16);
      if (Number.isSafeInteger(n) && n > 0) out.sessionMultiplier = n;
    }
  }

  const sessionId = files.sessionId;
  if (typeof sessionId === "string") {
    const prefix = sessionId.match(/make\(\s*"([a-z]+_)"\s*\+\s*descending/);
    if (prefix) out.sessionPrefix = prefix[1];
  }

  const app = files.app;
  if (typeof app === "string") {
    const tpl = app.match(/return\s+`(opencode\/[^`]+)`/);
    if (tpl) out.userAgentTemplate = tpl[1];
  }

  const modelRequest = files.modelRequest;
  if (typeof modelRequest === "string") {
    const block = modelRequest.match(/headers:\s*\{([\s\S]{0,2000}?)\n\s{8}\}/);
    if (block) {
      // 按行切分，条件展开的 spread 与恒发的头得以区分。上游把父会话头写成
      // `...(session.parentID ? { "x-parent": ... } : {})`，这是本桥没有对应值
      // 的条件头 —— 报成缺失会是误报。
      const required = [];
      const optional = [];
      const seen = new Set();
      for (const line of block[1].split("\n")) {
        const nameMatch = line.match(/"([A-Za-z][A-Za-z0-9-]*)":/);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        const key = name.toLowerCase();
        if (key.length === 0 || key.length >= 64 || seen.has(key)) continue;
        seen.add(key);
        // 三元守卫的 spread 是条件的。
        if (line.trim().startsWith("...") && line.includes("?")) optional.push(name);
        else required.push(name);
      }
      if (required.length > 0) out.headers = required;
      if (optional.length > 0) out.optionalHeaders = optional;
    }
  }

  const extractedTools = {};
  // 每次提取构建一次跨文件语料，`PageInput` 式引用无论声明在哪个文件都能
  // 解析。
  const corpusParts = Object.entries(files)
    .filter(([k]) => k.startsWith("tool:") || k.startsWith("ref:"))
    .map(([, v]) => (typeof v === "string" ? v : ""))
    .filter(Boolean);
  模式语料 = corpusParts.length > 0 ? corpusParts.join("\n\n") : null;
  模式变量 = null;
  模式模块 = new Map();
  for (const [k, v] of Object.entries(files)) {
    if ((k.startsWith("ref:") || k.startsWith("tool:")) && typeof v === "string") {
      const stripped = k.replace(/^(ref:|tool:)/, "");
      const base = stripped.split("-").pop();
      // 命名空间查找用大写模块名（`Question`），文件基名是小写（`question`）。
      // 文件基名是小写（`question`）。
      模式模块.set(base, v);
      模式模块.set(base.charAt(0).toUpperCase() + base.slice(1), v);
      模式模块.set(stripped, v);
    }
  }

  // 语料整体收集一次常量，插值了导入常量的字段描述才能解析。
  // 插值了导入常量的字段描述才能解析。
  {
    const parts = Object.entries(files)
      .filter(([k]) => k.startsWith("tool:") || k.startsWith("ref:"))
      .map(([, v]) => (typeof v === "string" ? v : ""));
    const all = parts.join("\n");
    const vars = { OS: "Linux", shell: "bash" };
    for (const m of all.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*([0-9][0-9_*\s+]*)/g)) {
      const clean = m[2].replace(/_/g, "").trim();
      if (/^[0-9*\s+]+$/.test(clean)) {
        const val = clean
          .split("+")
          .map((part) => part.split("*").reduce((acc, n) => acc * Number(n.trim()), 1))
          .reduce((a, b) => a + b, 0);
        if (Number.isFinite(val)) vars[m[1]] = val;
      }
    }
    模式变量 = vars;
  }

  const toolKeys = Object.keys(files).filter((k) => k.startsWith("tool:"));
  // 所以在这里读。
  // 所以在这里读。
  if (typeof files.codemode === "string") {
    const cm = files.codemode.match(/name:\s*"(execute)"[\s\S]{0,200}?input:\s*([A-Za-z0-9_.]+)/);
    if (cm) {
      const cmDesc = files.codemode.match(/const\s+description\s*=\s*\[([\s\S]*?)\]\.join\(\s*"([^"]*)"\s*\)/);
      let description = "Call tools through `tools` using exact paths and signatures from the catalog.";
      if (cmDesc) {
        const parts = [];
        for (const m of cmDesc[1].matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
          parts.push(反转义字面量(m[1] !== undefined ? m[1] : m[2]));
        }
        // `cmDesc[2]` 是 join 参数的内容，已经不含周围引号（`[^"']*`），
        // 原样反转义。
        const joiner = 反转义字面量(cmDesc[2]);
        if (parts.length > 0) description = parts.join(joiner);
      }
      // `{ code: string }` 没有字段描述：说明住在
      // 工具描述，CLI 不给该字段加注解。
      extractedTools.execute = {
        description,
        parameters: {
          type: "object",
          properties: { code: { type: "string" } },
          required: ["code"],
          additionalProperties: false,
        },
      };
    }
  }
  for (const key of toolKeys) {
    // 没有文件名兜底：用字面量注册工具（或根本不暴露）的文件绝不能记到它
    // 自己的文件名下。`mcp-resource` 当年就是这样混进配置当工具名的。
    const def = extractToolFromSource(files[key], null);
    if (def) {
      extractedTools[def.name] = {
        description: def.description,
        parameters: def.parameters,
      };
    }
  }
  if (Object.keys(extractedTools).length > 0) {
    out.tools = extractedTools;
  }
  const 工具名集合 = extractToolNames(files);
  // `execute` 是 code mode 分发器本身：code mode 启用时总在线上，
  // 尽管它不带 `codemode: false` 标志。
  if (Object.keys(extractedTools).includes("execute") && !工具名集合.includes("execute")) {
    工具名集合.push("execute");
  }
  if (工具名集合.length > 0) {
    out.toolNames = 工具名集合;
  }
  const overrides = extractToolOverrides(files);
  if (overrides) {
    out.toolOverrides = overrides;
  }
  const 动态描述表 = 提取动态描述(files);
  if (动态描述表) {
    out.动态描述表 = 动态描述表;
  }

  return out;
}

function buildUserAgent(next = 当前配方) {
  const tpl = next.userAgentTemplate;
  if (typeof tpl === "string") {
    return tpl
      .replace("${app.channel}", next.channel)
      .replace("${app.version}", next.version)
      .replace("${app.name}", next.client);
  }
  return `opencode/${next.channel}/${next.version}/${next.client}`;
}

function getUserAgent() {
  return buildUserAgent(当前配方);
}

function applyRecipe(update = {}, tag = null) {
  const next = { ...当前配方 };
  const changed = [];

  const version = 夹紧字符串(update.version, 32);
  if (version && /^\d+\.\d+\.\d+$/.test(version) && version !== next.version) {
    next.version = version;
    changed.push("version");
  }

  const charset = 夹紧字符串(update.sessionCharset, 128);
  if (charset && charset.length >= 2 && charset !== next.sessionCharset) {
    next.sessionCharset = charset;
    changed.push("sessionCharset");
  }

  if (
    Number.isInteger(update.sessionLength) &&
    update.sessionLength >= 16 &&
    update.sessionLength <= 64 &&
    update.sessionLength !== next.sessionLength
  ) {
    next.sessionLength = update.sessionLength;
    changed.push("sessionLength");
  }

  if (
    Number.isInteger(update.sessionMultiplier) &&
    update.sessionMultiplier > 0 &&
    update.sessionMultiplier !== next.sessionMultiplier
  ) {
    next.sessionMultiplier = update.sessionMultiplier;
    changed.push("sessionMultiplier");
  }

  const prefix = 夹紧字符串(update.sessionPrefix, 16);
  if (prefix && prefix !== next.sessionPrefix) {
    next.sessionPrefix = prefix;
    changed.push("sessionPrefix");
  }

  for (const k of ["chatUrl", "responsesUrl", "modelsUrl", "catalogBase"]) {
    const v = 夹紧字符串(update[k], 256);
    if (v && /^https?:\/\/[a-z0-9.:-]+/i.test(v) && v !== next[k]) {
      next[k] = v;
      changed.push(k);
    }
  }

  if (typeof update.userAgentTemplate === "string") {
    const probe = buildUserAgent({ ...next, userAgentTemplate: update.userAgentTemplate });
    if (/^opencode\/[A-Za-z0-9-]+\/\d+\.\d+\.\d+\/[A-Za-z0-9-]+$/.test(probe)) {
      if (probe !== buildUserAgent(当前配方)) changed.push("userAgentTemplate");
      next.userAgentTemplate = update.userAgentTemplate;
    }
  }

  if (Array.isArray(update.headers) && update.headers.length > 0) {
    const incoming = update.headers.map(String);
    const same =
      incoming.length === next.headers.length &&
      incoming.every((h, i) => h.toLowerCase() === next.headers[i].toLowerCase());
    if (!same) {
      next.headers = incoming;
      changed.push("headers");
    }
  }

  if (Array.isArray(update.optionalHeaders)) {
    可选头 = update.optionalHeaders.map(String);
  }

  if (Array.isArray(update.freeModels) && update.freeModels.length > 0) {
    const incoming = update.freeModels.map(String).filter((n) => /^[A-Za-z0-9._:-]+$/.test(n));
    if (incoming.length > 0 && 稳定序列化(incoming) !== 稳定序列化(免费模型表)) {
      免费模型表 = incoming;
      changed.push("freeModels");
    }
  }

  if (update.dynamicDescriptions && typeof update.dynamicDescriptions === "object") {
    if (稳定序列化(update.dynamicDescriptions) !== 稳定序列化(动态描述表)) {
      动态描述表 = update.dynamicDescriptions;
      changed.push("dynamicDescriptions");
    }
  }

  if (update.toolOverrides && typeof update.toolOverrides === "object") {
    if (稳定序列化(update.toolOverrides) !== 稳定序列化(工具覆盖表)) {
      工具覆盖表 = update.toolOverrides;
      changed.push("toolOverrides");
    }
  }

  if (update.modelFacts && typeof update.modelFacts === "object") {
    const next = {};
    for (const [id, f] of Object.entries(update.modelFacts)) {
      if (typeof f?.reasoning !== "boolean") continue;
      next[String(id).toLowerCase()] = {
        reasoning: f.reasoning,
        maxOutput: Number(f.maxOutput) > 0 ? Number(f.maxOutput) : null,
      };
    }
    if (Object.keys(next).length > 0 && 稳定序列化(next) !== 稳定序列化(模型事实表)) {
      模型事实表 = next;
      changed.push("modelFacts");
    }
  }

  if (update.modelFamilies && typeof update.modelFamilies === "object") {
    const next = {};
    for (const [family, id] of Object.entries(update.modelFamilies)) {
      if (typeof id === "string" && /^[A-Za-z0-9._:-]+$/.test(id)) {
        next[String(family).toLowerCase()] = id;
      }
    }
    if (Object.keys(next).length > 0 && 稳定序列化(next) !== 稳定序列化(模型家族表)) {
      模型家族表 = next;
      changed.push("modelFamilies");
    }
  }

  if (update.catalogVerdicts && typeof update.catalogVerdicts === "object") {
    const next = {};
    for (const [id, v] of Object.entries(update.catalogVerdicts)) {
      if (v === "free" || v === "paid" || v === "deprecated") next[String(id).toLowerCase()] = v;
    }
    if (Object.keys(next).length > 0 && 稳定序列化(next) !== 稳定序列化(目录裁定表)) {
      目录裁定表 = next;
      changed.push("catalogVerdicts");
    }
  }

  if (update.modelEndpoints && typeof update.modelEndpoints === "object") {
    const nextMap = {};
    for (const [id, base] of Object.entries(update.modelEndpoints)) {
      if (typeof base === "string" && /^https:\/\/[a-z0-9.-]+/i.test(base)) {
        nextMap[String(id).toLowerCase()] = base;
      }
    }
    if (Object.keys(nextMap).length > 0) {
      if (稳定序列化(nextMap) !== 稳定序列化(模型端点表)) {
        模型端点表 = nextMap;
        changed.push("modelEndpoints");
      }
    }
  }

  if (Array.isArray(update.toolNames) && update.toolNames.length > 0) {
    const incoming = update.toolNames.map(String).filter((n) => /^[a-z][a-z0-9_-]*$/i.test(n));
    if (incoming.length > 0) {
      const same =
        incoming.length === 工具名集合.length &&
        incoming.every((n, i) => n === 工具名集合[i]);
      if (!same) {
        工具名集合 = incoming;
        changed.push("工具名集合");
      }
    }
  }

  if (update.tools && typeof update.tools === "object") {
    // 提取出的集合*替换*旧集合，不是合并。合并会让上游改名或删掉的工具永远
    // 留着，线上形态永远收敛不到发行版实际带的 —— 与自适应背道而驰。
    const nextTools = { ...update.tools };
    if (Object.keys(nextTools).length > 0) {
      if (稳定序列化(nextTools) !== 稳定序列化(getTools())) {
        changed.push("tools");
      }
      工具配置 = nextTools;
      工具配置来源 = "source";
      工具配置版本 = next.version;
    }
  }

  if (changed.length > 0) {
    当前配方 = next;
    状态纪元++;
    上次强制刷新时间 = 0;
  }
  if (tag) 上次源码标签 = tag;
  return changed;
}

// --- 刷新与反应式自愈 ---------------------------------------------------------

/**
 * @param {object}  [opts]
 * @param {boolean} [opts.force]    采纳握手报告的任何结果，即使在 reactive
 *                                  模式下、即使版本没动（网关可以无版本号
 *                                  变更而迁移）。供网关拒绝后的自愈使用。
 * @param {boolean} [opts.recheck]  跳过新鲜度守卫，立即查询握手，但决定是否
 *                                  采纳时仍遵守 UPDATE_MODE。供周期性 CLI
 *                                  版本轮询使用。
 */
async function refresh({ force = false, recheck = false } = {}) {
  if (process.env.OPENCODE_USER_AGENT) {
    return { updated: false, reason: "pinned" };
  }
  if (!force && !recheck && Date.now() - 上次检查时间 < IDENTITY_TTL_MS) {
    return { updated: false, reason: "fresh" };
  }
  if (刷新进行中) {
    if (!force) return 刷新进行中;
    刷新进行中强制 = true;
    const pending = await 刷新进行中;
    if (pending && (pending.updated || pending.sourceRead)) return pending;
  }

  刷新进行中强制 = Boolean(force);
  const myGen = ++刷新代数;
  刷新进行中 = (async () => {
    try {
      const release = await resolveRelease(当前配方.version);
      const latest = release.version;
      if (!latest) throw new Error(release.error || "handshake resolved no version");

      if (myGen !== 刷新代数) return { updated: false, reason: "reset" };
      上次检查时间 = Date.now();
      上次刷新错误 = release.stale ? release.error || "handshake stale" : null;

      const cmp = compareVersions(latest, 当前配方.version);
      if (cmp < 0) {
        return {
          updated: false,
          version: 当前配方.version,
          reason: `newer-local:${当前配方.version}`,
        };
      }

      const updateMode = 取更新模式();
      const forcedByUpstream = release.minimum === true;
      const isForced = force || 刷新进行中强制;
      const shouldAdopt = cmp > 0 && (isForced || updateMode === "always" || forcedByUpstream);

      if (cmp === 0 && !isForced) {
        // CLI 版本没动也保持目录新鲜。从磁盘缓存热启动填充 `免费模型表`，
        // 该表曾为此调用设门 —— 缓存清单成了永久快照，已退役模型一直被
        // 宣传（实测：退役的 minimax-m3.1-flash-free 留在 /v1/models）。客户端
        // 探测退役 id 白白烧每 IP 突发配额。refresh() 由 ensureFresh 按 TTL 设
        // 门，重读目录最多每个刷新间隔一次请求。
        // 探测退役 id 白白烧每 IP 突发配额。refresh() 由 ensureFresh 按 TTL 设
        // 门，重读目录最多每个刷新间隔一次请求。
        // 门，重读目录最多每个刷新间隔一次请求。
        const catalog = await extractCatalog();
        applyRecipe(catalog);
        return {
          updated: false,
          version: 当前配方.version,
          reason: "up-to-date",
        };
      }
      if (cmp > 0 && !shouldAdopt) {
        // 反应模式：记住存在新发行版但不采纳。下一次网关拒绝会强制刷新，
        // 那时翻转 shouldAdopt。这里也刷新目录 —— 未采纳分支是默认路径，
        // 曾冻结同一份过期清单。
        // 曾冻结同一份过期清单。
        {
          const catalog = await extractCatalog();
          applyRecipe(catalog);
        }
        上次可用 = latest;
        return {
          updated: false,
          version: 当前配方.version,
          available: latest,
          reason: `available-not-adopted:${updateMode}`,
        };
      }
      上次可用 = null;

      const ref = sourceRef(release);
      const update = { version: latest };
      let sourceRead = false;

      const diskCachedSource =
        (global.fetch === 启动拉取 || process.env.OPENCODE_CACHE_DIR)
          ? readCachedSource(ref)
          : null;
      if (
        上次同步源码 &&
        上次同步源码.ref === ref &&
        上次同步源码.fetchRef === global.fetch
      ) {
        Object.assign(update, 上次同步源码.extracted);
        sourceRead = true;
      } else if (diskCachedSource && diskCachedSource.extracted) {
        Object.assign(update, diskCachedSource.extracted);
        上次同步源码 = { ref, extracted: diskCachedSource.extracted, fetchRef: global.fetch };
        sourceRead = true;
      } else {
        // 发现该发行版的工具插件；目录列举不可用（API 故障/限流）时回退到
        // 已知集合。已知集合存于 `已知插件`，瞬时故障只让一次刷新覆盖收窄，
        // 而不是清空。
        // 而不是清空。
        const discovered = await 列源码目录(PLUGIN_DIR, ref);
        if (discovered.length > 0) 已知插件 = discovered;
        const pluginFiles = { codemode: CODEMODE_TOOL_FILE };
        for (const name of 已知插件) {
          pluginFiles[`tool:${name}`] = `${PLUGIN_DIR}/${name}.ts`;
        }

        const settled = await Promise.allSettled(
          Object.entries({ ...SOURCE_FILES, ...pluginFiles }).map(async ([key, filePath]) => [
            key,
            await 拉取文本(`${SOURCE_BASE}/${ref}/${filePath}`, SOURCE_TIMEOUT_MS),
          ])
        );
        const fetchedFiles = {};
        for (const item of settled) {
          if (item.status === "fulfilled") {
            fetchedFiles[item.value[0]] = item.value[1];
            sourceRead = true;
          }
        }
        // 跨文件模式引用。`read.ts` 写
        // `ReadToolFileSystem.PageInput.fields.offset`，而 `PageInput` 住在
        // `../read-filesystem.ts`。抓取每个插件 import 的本地模块，这样
        // 字段的真实可选性/类型可以解析而不是猜。
        const refFiles = new Map();
        for (const [key, source] of Object.entries(fetchedFiles)) {
          if (!key.startsWith("tool:") || typeof source !== "string") continue;
          // 相对 import：`../read-filesystem.js` → packages/core/src/read-filesystem.ts
          for (const m of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"(\.\.?\/[^"]+)\.js"/g)) {
            const rel = m[2].replace(/^\.\.?\//, "");
            const resolved = new URL(m[2] + ".ts", `https://x/${PLUGIN_DIR}/`).pathname.replace(/^\//, "");
            refFiles.set(`ref:${rel.replace(/\//g, "-")}`, resolved);
          }
          // 工作区导入：`@opencode/schema/question` → packages/schema/src/question.ts。
          // 插件这样引用自己不声明的结构体（`Question.Prompt`）。
          for (const m of source.matchAll(/from\s+"@opencode\/([a-z-]+)\/([a-z0-9-]+)"/g)) {
            const pkg = m[1];
            const mod = m[2];
            refFiles.set(`ref:${pkg}-${mod}`, `packages/${pkg}/src/${mod}.ts`);
          }
        }
        if (refFiles.size > 0) {
          const refSettled = await Promise.allSettled(
            [...refFiles.entries()].map(async ([key, filePath]) => [
              key,
              await 拉取文本(`${SOURCE_BASE}/${ref}/${filePath}`, SOURCE_TIMEOUT_MS),
            ])
          );
          for (const item of refSettled) {
            if (item.status === "fulfilled") fetchedFiles[item.value[0]] = item.value[1];
          }
        }

        // 有些工具的描述放在同级 `.txt`（patch.ts）。一并抓取：描述是线上模式
        // 的一部分，模式建不出的工具会从配置里掉出去。
        const txtRefs = [];
        for (const [key, source] of Object.entries(fetchedFiles)) {
          if (!key.startsWith("tool:")) continue;
          const probe = extractToolFromSource(source, key.replace(/^tool:/, ""));
          if (probe && probe.descriptionFile) {
            txtRefs.push({ key, file: probe.descriptionFile, varName: probe.descriptionVar });
          }
        }
        if (txtRefs.length > 0) {
          const txtSettled = await Promise.allSettled(
            txtRefs.map(async (t) => {
              const dir = PLUGIN_DIR;
              // `../patch.txt` 相对于插件目录。
              const resolved = new URL(t.file, `https://x/${dir}/`).pathname.replace(/^\//, "");
              return [t, await 拉取文本(`${SOURCE_BASE}/${ref}/${resolved}`, SOURCE_TIMEOUT_MS)];
            })
          );
          for (const item of txtSettled) {
            if (item.status !== "fulfilled") continue;
            const [t, text] = item.value;
            const src = fetchedFiles[t.key];
            if (typeof src !== "string") continue;
            // 把标识符换成字符串字面量，现有描述解析器就能读。
            fetchedFiles[t.key] = src.replace(
              new RegExp(`\\b${t.varName}\\b(?!\\s+from)`),
              JSON.stringify(text.trim())
            );
          }
        }

        if (sourceRead) {
          const extracted = extractRecipe(fetchedFiles);
          Object.assign(update, extracted);
          const allCoreFetched = Object.keys(SOURCE_FILES).every(
            (k) => typeof fetchedFiles[k] === "string" && fetchedFiles[k].length > 0
          );
          const allSettledOk = settled.every((item) => item.status === "fulfilled");
          if (allCoreFetched && allSettledOk) {
            上次同步源码 = { ref, extracted, fetchRef: global.fetch };
            if (extracted.tools && Object.keys(extracted.tools).length > 0) {
              writeCachedSource(ref, extracted);
            }
          }
        } else {
          const fallbackSource = readCachedSource(ref) || readCachedSource();
          if (fallbackSource && fallbackSource.extracted) {
            Object.assign(update, fallbackSource.extracted);
          }
        }
      }

      // 端点在供应商目录里，不在 git 源码树。缺目录或缺 `opencode` 条目时
      // 端点保持现值 —— 目录故障不能把线上 URL 清空。
      // 端点保持现值 —— 目录故障不能把线上 URL 清空。
      const catalog = await extractCatalog();
      Object.assign(update, catalog);

      if (myGen !== 刷新代数) return { updated: false, reason: "reset" };
      const changed = applyRecipe(update, ref);
      if (isForced && sourceRead && !release.stale) {
        上次强制刷新时间 = Date.now();
      }
      return {
        updated: changed.length > 0,
        changed,
        version: 当前配方.version,
        tag: ref,
        sourceRead,
        release: {
          version: release.version,
          sha: release.sha,
          source: release.source,
          minimum: release.minimum,
        },
      };
    } catch (err) {
      if (myGen === 刷新代数) {
        上次刷新错误 = err.message || String(err);
      }
      return { updated: false, error: err.message || String(err) };
    } finally {
      if (myGen === 刷新代数) {
        刷新进行中 = null;
        刷新进行中强制 = false;
      }
    }
  })();

  return 刷新进行中;
}

/**
 * 请求路径上的非阻塞新鲜度检查。
 * - `always` 模式：TTL 到期后启动后台握手检查。
 * - `reactive` 模式：初次检查后保持静默，直到出现网关错误。
 */
function ensureFresh() {
  if (Date.now() - 上次检查时间 < IDENTITY_TTL_MS) {
    return { updated: false, reason: "fresh" };
  }
  if (取更新模式() === "reactive" && 上次检查时间 > 0) {
    return { updated: false, reason: "reactive-idle" };
  }
  refresh().catch(() => {});
  return { updated: false, reason: "refreshing-in-background" };
}

/**
 * 上游的按 IP 滥用封锁。
 *
 * 已知变体（都是 HTTP 403，`error.type: FreeTierError`）：
 *
 *   - 原文："OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address. ..."
 *   - 原文："Forbidden, OpenCode Free Model Gateway Detect Abuse Traffic"
 *   - 原文："Abuse of traffic"（短形式）
 *
 * 与形态网关（原文 "OpenCode's free tier can only be used from within OpenCode"）
 * 不同，身份变更救不了它：网关按出口网络记账，官方 CLI 从同一 IP
 * 得到同样答案。
 * 重试只会延长惩罚，调用方不得刷新或重放。
 */
function isIpAbuseRejection(status, errMsg) {
  if (status !== 403) return false;
  const m = String(errMsg || "").toLowerCase();
  return (
    m.includes("abusive traffic") ||
    m.includes("abuse traffic") ||
    m.includes("abuse of traffic")
  );
}

/**
 * 上游用 CLI 网关错误拒绝我们的请求时的反应式自愈
 * （403 FreeTierError 或 426 UpgradeRequired）。
 */
async function onGateRejection(status, errType, errMsg, attempted = false) {
  if (attempted) return { retry: false, reason: "already-retried" };
  // 网络级封锁是终态：刷新当前配方改变不了请求从哪个 IP 出去，
  // 所以跳过 GitHub/目录抓取。
  if (isIpAbuseRejection(status, errMsg)) {
    return { retry: false, reason: "ip-abuse", terminal: true };
  }

  const versionBefore = 当前配方.version;
  const toolsBefore = 稳定序列化(getTools());

  const floor = parseVersionFloor(errMsg);
  if (floor) {
    versionFloor = floor;
    if (compareVersions(当前配方.version, floor) < 0) {
      applyRecipe({ version: floor }, 上次源码标签);
    }
  }

  // 避免在按 IP 403 冷却突发期间对 GitHub API（未认证 60 次/时）与目录逐请
  // 求轰炸：若强制刷新已在 GATE_REFRESH_COOLDOWN_MS 内成功且未报版本下限，
  // 复用当前状态。
  // 求轰炸：若强制刷新已在 GATE_REFRESH_COOLDOWN_MS 内成功且未报版本下限，复用当前状态。
  if (
    !floor &&
    上次强制刷新时间 > 0 &&
    Date.now() - 上次强制刷新时间 < GATE_REFRESH_COOLDOWN_MS
  ) {
    return {
      retry: false,
      reason: "no-change",
      cooldown: true,
      status,
      errType,
    };
  }

  const result = await refresh({ force: true });
  const toolsAfter = 稳定序列化(getTools());

  const learned =
    当前配方.version !== versionBefore ||
    toolsAfter !== toolsBefore ||
    (result && Array.isArray(result.changed) && result.changed.length > 0);

  return {
    retry: learned,
    reason: floor
      ? `version-floor:${floor}`
      : learned
        ? `updated:${result?.version || 当前配方.version}`
        : "no-change",
    status,
    errType,
  };
}

// --- 快速会话 ID 生成器（池化 CSPRNG） ---------------------------------------

let 上次时间戳 = 0;
let 计数器 = 0;
const 每毫秒计数上限 = 16;
const 随机池大小 = 14 * 256;
const 随机池 = Buffer.allocUnsafe(随机池大小);
let 随机池游标 = 随机池大小;

function 下批随机字符(chars, count) {
  if (随机池游标 + count > 随机池大小) {
    crypto.randomFillSync(随机池);
    随机池游标 = 0;
  }
  const len = chars.length;
  let out = "";
  for (let i = 0; i < count; i++) {
    out += chars[随机池[随机池游标 + i] % len];
  }
  随机池游标 += count;
  return out;
}

function createId(descending = true, timestamp = Date.now()) {
  const {
    sessionCharset: chars,
    sessionLength: length,
    sessionMultiplier: mult,
  } = 当前配方;

  if (timestamp !== 上次时间戳) {
    上次时间戳 = timestamp;
    计数器 = 0;
  }
  计数器++;
  const extraMs = Math.floor((计数器 - 1) / 每毫秒计数上限);
  const effectiveCounter = ((计数器 - 1) % 每毫秒计数上限) + 1;

  const current = BigInt(timestamp + extraMs) * BigInt(mult) + BigInt(effectiveCounter);
  const value = descending ? ~current : current;
  const mask = (1n << 48n) - 1n;

  const hexChars = 12;
  const hex = (value & mask).toString(16).padStart(hexChars, "0");
  const randomChars = Math.max(0, length - hexChars);
  return hex + 下批随机字符(chars, randomChars);
}

// --- 访问器与工具格式化 ------------------------------------------------------

/**
 * 网关的工具名白名单，按上游自己的顺序。源码读取尚未产出清单时回退到工具配
 * 置的键序。
 */
function getToolNames() {
  if (工具名集合.length > 0) return 工具名集合.slice();
  return Object.keys(getTools());
}

/**
 * 当前线上端点。`chatUrl` / `responsesUrl` 在刷新时从上游供应商目录解析；
 * `server.js` 逐请求读取，端点迁移无需重启即生效。
 */
/**
 * 从供应商目录推导的免费档模型 id。空表示目录尚未读过 —— 调用方此时保留自
 * 己的清单，而不是把"未知"当成"没有免费的"。
 */
function getFreeModels() {
  return 免费模型表.slice();
}

/** 目录推导的简写：家族名（或免费模型 id 的前缀）
 *  映射到一个可用的免费模型。没有匹配时返回 undefined。 */
function resolveModelAlias(name) {
  const key = String(name || "").toLowerCase().trim();
  if (!key) return undefined;
  if (模型家族表[key]) return 模型家族表[key];
  // 前缀形态：家族 "nemotron-free" 用 "nemotron"，模型 id
  // `nemotron-3-ultra-free` 用 "nemotron-3"。最长匹配优先，短前缀不遮蔽更
  // 具体的。
  let best;
  for (const [family, id] of Object.entries(模型家族表)) {
    const matches =
      key === family ||
      key === family.replace(/-free$/, "") ||
      family.startsWith(`${key}-`) ||
      id.toLowerCase().startsWith(`${key}-`) ||
      id.toLowerCase().startsWith(key);
    if (!matches) continue;
    if (!best || family.length > best.family.length) best = { family, id };
  }
  if (best) return best.id;
  // 修订前缀形态（`nemotron-3.5-lightning-free` 对 "nemotron-3.5"）：家族表
  // 只留一个代表，所以回退到免费清单，取最具体（最长）的前缀匹配，并列时按
  // 字典序，保证跨次运行选择稳定。
  const candidates = 免费模型表
    .filter((id) => id.toLowerCase().startsWith(`${key}-`) || id.toLowerCase().startsWith(key))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return candidates[0];
}

/**
 * 把发行版的按模型工具规则应用到名字清单上。
 *
 * 规则以"上游条件 + 每个分支增删的名字"保存。条件在此对模型 id 求值
 * （只支持上游用的 `event.model.id.includes(...)` 形式；认不出的条件不动
 * 清单，不猜）。
 */
function applyToolOverrides(names, modelId) {
  const rule = 工具覆盖表;
  if (!rule || !Array.isArray(names)) return names.slice();
  const id = String(modelId || "");
  const cond = String(rule.condition || "");
  const tests = [...cond.matchAll(/(!?)\s*event\.model\.id\.includes\(\s*"([^"]+)"\s*\)/g)];
  if (tests.length === 0) return names.slice();
  let matches = true;
  for (const [, negated, needle] of tests) {
    const hit = id.includes(needle);
    if (negated && hit) matches = false;
    if (!negated && !hit) matches = false;
  }
  const remove = matches ? rule.whenTrueRemove || [] : rule.whenFalseRemove || [];
  const add = matches ? rule.whenTrueAdd || [] : rule.whenFalseAdd || [];
  const out = names.filter((n) => !remove.includes(n));
  for (const n of add) if (!out.includes(n)) out.push(n);
  return out;
}

/** 单个模型 id 的目录事实：`{ reasoning, maxOutput }`，目录未描述时返回
 *  undefined。 */
function getModelFacts(modelId) {
  return 模型事实表[String(modelId || "").toLowerCase()];
}

/** 目录对单个模型 id 的裁定："free"、"paid"、"deprecated"，目录未描述时
 *  返回 undefined。 */
function getCatalogVerdict(modelId) {
  return 目录裁定表[String(modelId || "").toLowerCase()];
}

function getEndpoints(modelId = null) {
  const base = {
    chatUrl: 当前配方.chatUrl,
    responsesUrl: 当前配方.responsesUrl,
    modelsUrl: 当前配方.modelsUrl,
    catalogBase: 当前配方.catalogBase,
  };
  // 模型可以在目录里钉自己的基址（anthropic 协议模型）。
  // 线上路径同法推导：<base>/chat/completions。
  if (modelId) {
    const override = 模型端点表[String(modelId).toLowerCase()];
    if (override) {
      base.catalogBase = override;
      base.chatUrl = `${override}/chat/completions`;
      base.responsesUrl = `${override}/responses`;
    }
  }
  return base;
}

function getRecipe() {
  return { ...当前配方 };
}

function getTools() {
  // 空配置不是配置。没有这个守卫，`工具配置 || ...` 会让 `{}` 赢（对象为
  // 真值），桥发 `tools: []`，上游 403 —— 正是指纹要避免的失败。空或畸形配
  // 置回退到随发行版集合。
  if (工具配置 && Object.keys(工具配置).length > 0) return 工具配置;
  return DEFAULT_TOOLS;
}

/**
 * 当前生效的上游头名，按上游自己的顺序。
 * `server.js` 用它构建请求头对象，所以上游新增的头从刷新后的下一个请求开始
 * 发送。
 */
function getHeaderNames() {
  return Array.isArray(当前配方.headers) ? 当前配方.headers.slice() : DEFAULT_RECIPE.headers.slice();
}

/**
 * 追加上游在请求时构建的工具描述部分。
 *
 * 静态前缀与标题来自发行版源码；其下条目是调用方的可用 agent，本桥没有。
 * 发"只有标题没有条目"是"没有可用"的如实表达，静态文本与 CLI 逐字节一致。
 */
function 带动态描述(name, description) {
  const spec = 动态描述表 && 动态描述表[name];
  if (!spec || !Array.isArray(spec.appendPrefix) || spec.appendPrefix.length === 0) return description;
  const joiner = spec.joiner || "\n";
  // 提取的字面量是 [分隔符, 标题, fallbackText]。只有标题属于静态描述：
  // `fallbackText` 是上游对无描述 agent 的输出，不是标题。
  const heading = spec.appendPrefix.filter((p) => p !== "").slice(0, 1);
  if (heading.length === 0) return description;
  return [description, "", ...heading].join(joiner);
}

function getToolList(flat = false, scope = null, modelId = null) {
  const profile = getTools();
  const available = Object.keys(profile);
  const mode = scope || process.env.TOOL_PROFILE_SCOPE || "core";

  // `core` 发送经过验证的最小集合。`full` 发送从发行版工具插件源码推导出的
  // 每个名字 —— 真 CLI 的形态。反应式自愈用 `full` 重试，上游改名/新增的
  // 工具无须发新版桥即可跟上。
  let ordered;
  if (mode === "full") {
    ordered = applyToolOverrides(getToolNames(), modelId).filter((n) => profile[n]);
    if (ordered.length === 0) ordered = available;
  } else {
    const coreNames = 核心工具名.filter((n) => profile[n]);
    ordered = coreNames.length > 0 ? coreNames : available;
  }

  // 网关锚点最后钉，推导出的顺序其余部分不动。
  // 上游改名或删除工具时 `profile[name]` 可能缺失：随发行版定义就是保住线上
  // 形态可接受的唯一手段。实测见 GATE_ANCHOR_TOOL_NAMES。
  for (const name of GATE_ANCHOR_TOOL_NAMES) {
    if (!ordered.includes(name)) ordered = [...ordered, name];
  }

  return ordered.map((name) => {
    const def = profile[name] || DEFAULT_TOOLS[name];
    const description = 带动态描述(name, def.description);
    return flat
      ? {
          type: "function",
          name,
          description,
          parameters: def.parameters,
          strict: false,
        }
      : {
          type: "function",
          function: {
            name,
            description,
            parameters: def.parameters,
            // CLI 对发出的每个工具都带 `strict: false`。今天是无操作，但它是
            // 线上形态的一部分。
            strict: false,
          },
        };
  });
}

/**
 * 把上游客户端发送的头名解析成具体值。
 *
 * 返回 `{ headers, unsent }`。`unsent` 列出我们知道上游会发、
 * 但本桥推导不出其值的 —— 在 `/health` 里报告而不是发空值：必填头发空值比
 * 缺失更糟。
 */
const 网关头值 = [
  "user-agent",
  "x-opencode-client",
  "x-opencode-project",
  "x-opencode-session",
  "x-opencode-session-id",
  "x-session-affinity",
  "x-session-id",
];

function buildGateHeaders(ctx = {}) {
  const values = {
    "user-agent": ctx.userAgent,
    "x-opencode-client": ctx.client,
    "x-opencode-project": ctx.project,
    "x-opencode-session": ctx.sessionId,
    "x-opencode-session-id": ctx.sessionId,
    "x-session-affinity": ctx.sessionId,
    "x-session-id": ctx.sessionId,
  };
  const headers = {};
  const unsent = [];
  const names = getHeaderNames().slice();
  // 即使当前配方不再列出这些锚点也要钉住：网关对缺它们的请求回与封 IP 相同
  // 的 403，当前配方回归就会与额度耗尽无法区分。
  for (const anchor of GATE_ANCHOR_HEADER_NAMES) {
    if (!names.some((n) => String(n).toLowerCase() === anchor)) names.push(anchor);
  }
  for (const name of names) {
    const lower = String(name).toLowerCase();
    const value = values[lower];
    // 头名大小写不敏感。每个名字只发一种规范拼写，上游改大小写就不会产生
    // 重复键：`User-Agent` 保持惯例形式，`x-opencode-*` 全部小写。
    if (value === undefined) unsent.push(name);
    else headers[lower === "user-agent" ? "User-Agent" : lower] = value;
  }
  return { headers, unsent };
}

/**
 * 当前配方要求、而本桥没有值可发的头名。非空即上游新增了发行版源码推导不
 * 出值的头 —— 这是需要手工映射的警报，因为请求将在没有它的情况下发出。
 */
function getUnsentHeaders() {
  const known = new Set(网关头值);
  const conditional = new Set(可选头.map((n) => String(n).toLowerCase()));
  return getHeaderNames().filter((n) => {
    const key = String(n).toLowerCase();
    // 条件头（父会话谱系）只有会话有父时 CLI 才发。本桥从不创建嵌套会话，
    // 缺它们是预期，不是要上报的缺口。
    return !known.has(key) && !conditional.has(key);
  });
}

function getSessionPrefix() {
  return 当前配方.sessionPrefix || DEFAULT_RECIPE.sessionPrefix;
}

/** 带上游前缀的会话 id，如 `ses_<12 hex><14 base62>`。 */
function createSessionId(descending = true, timestamp = Date.now()) {
  return getSessionPrefix() + createId(descending, timestamp);
}

/**
 * 新项目 id：40 个十六进制字符，与 CLI 的 `sha1("git-remote:…")` 同形。
 *
 * 免费档按 (项目 id, 出口网段) 记账。固定一个项目 id 就等于把所有请求塞
 * 进同一份额度桶，桶烧穿后整个出口一起 429。逐请求/逐重试换一个新 id，
 * 形状仍是 CLI 会发出的 sha1 十六进制，额度记账却是新的。
 */
function createProjectId() {
  return crypto.randomBytes(20).toString("hex");
}

function getState() {
  return {
    recipe: getRecipe(),
    userAgent: getUserAgent(),
    updateMode: 取更新模式(),
    lastCheckTime: 上次检查时间,
    lastForcedRefreshTime: 上次强制刷新时间,
    epoch: 状态纪元,
    ttlMs: IDENTITY_TTL_MS,
    versionFloor,
    lastRefreshError: 上次刷新错误,
    lastSourceTag: 上次源码标签,
    release: 上次发行版,
    available: 上次可用,
    headers: getHeaderNames(),
    optionalHeaders: 可选头.slice(),
    unsentHeaders: getUnsentHeaders(),
    toolNames: getToolNames(),
    freeModels: 免费模型表.slice(),
    catalogVerdicts: { ...目录裁定表 },
    modelFamilies: { ...模型家族表 },
    modelFacts: { ...模型事实表 },
    toolOverrides: 工具覆盖表 ? { ...工具覆盖表 } : null,
    dynamicDescriptions: 动态描述表 ? { ...动态描述表 } : null,
    endpoints: getEndpoints(),
    inFlight: Boolean(刷新进行中),
    tools: {
      source: 工具配置来源,
      version: 工具配置版本,
      names: Object.keys(getTools()),
    },
  };
}

function __reset() {
  当前配方 = { ...DEFAULT_RECIPE };
  工具配置 = null;
  工具配置来源 = "default";
  工具配置版本 = DEFAULT_RECIPE.version;
  工具名集合 = [];
  模型端点表 = {};
  免费模型表 = [];
  目录裁定表 = {};
  模型家族表 = {};
  模型事实表 = {};
  工具覆盖表 = null;
  动态描述表 = null;
  上次发行版 = null;
  上次可用 = null;
  上次检查时间 = 0;
  上次强制刷新时间 = 0;
  状态纪元++;
  刷新进行中 = null;
  刷新进行中强制 = false;
  刷新代数++;
  上次同步源码 = null;
  versionFloor = null;
  上次刷新错误 = null;
  上次源码标签 = null;
  可选头 = [];
  上次时间戳 = 0;
  计数器 = 0;
}

function __setLastCheckTime(v) {
  上次检查时间 = v;
  上次强制刷新时间 = 0;
  状态纪元++;
}

/** 测试钩子：绕过当前配方校验直接暂存会话前缀。 */
function __setSessionPrefix(prefix) {
  当前配方 = { ...当前配方, sessionPrefix: String(prefix) };
  上次强制刷新时间 = 0;
  状态纪元++;
}

function __setToolProfile(tools, source = "test") {
  工具配置 = tools;
  工具配置来源 = source;
  工具配置版本 = 当前配方.version;
  上次强制刷新时间 = 0;
  状态纪元++;
}

// 模块加载时从磁盘目录缓存热启动，别名、模型裁定、令牌预算事实在第一个请
// 求就可用。
{
  const bootCatalog = 读缓存目录();
  if (bootCatalog) applyRecipe(parseCatalogData(bootCatalog));
  const bootSource = readCachedSource();
  if (bootSource && bootSource.extracted) {
    applyRecipe(bootSource.extracted, bootSource.ref);
    上次同步源码 = {
      ref: bootSource.ref,
      extracted: bootSource.extracted,
      fetchRef: global.fetch,
    };
  }
}
module.exports = {
  IDENTITY_TTL_MS,
  GATE_REFRESH_COOLDOWN_MS,
   get UPDATE_MODE() {
    return 取更新模式();
  },
  DEFAULT_RECIPE,
  DEFAULT_TOOLS,
  SOURCE_FILES,
  parseVersions,
  sortVersions,
  selectVersion,
  compareVersions,
  parseVersionFloor,
  sourceRef,
  resolveRelease,
  parseCatalogData,
  extractCatalog,
  readCachedSource,
  writeCachedSource,
  extractToolFromSource,
  extractToolNames,
  extractToolOverrides,
  parseSchemaExpr,
  parseFieldSchema,
  extractRecipe,
  buildUserAgent,
  applyRecipe,
  refresh,
  ensureFresh,
  onGateRejection,
  isIpAbuseRejection,
  createId,
  getUserAgent,
  getRecipe,
  getTools,
  getHeaderNames,
  getUnsentHeaders,
  getToolNames,
  getFreeModels,
  getCatalogVerdict,
  getModelFacts,
  applyToolOverrides,
  resolveModelAlias,
  getEndpoints,
  buildGateHeaders,
  GATE_ANCHOR_TOOL_NAMES,
  GATE_ANCHOR_HEADER_NAMES,
  getSessionPrefix,
  createSessionId,
  createProjectId,
  getToolList,
  getState,
  __reset,
  __setLastCheckTime,
  __setSessionPrefix,
  __setToolProfile,
};
