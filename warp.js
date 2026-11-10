const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// 可选的 Cloudflare WARP 管理器：只驱动系统里已安装的 `warp-cli`，不下载、
// 不安装、不写配置。默认关闭（WARP_MANAGE=0），因为连/断会影响整机路由。
// 容器里通常没有该二进制，能力探测会如实返回 available=false。

const 候选路径 = [
  "warp-cli",
  "/usr/bin/warp-cli",
  "/usr/local/bin/warp-cli",
  "/opt/homebrew/bin/warp-cli",
];

let 已解析 = false;
let 解析结果 = { available: false, command: null, version: null, error: null };

function 探测() {
  if (已解析) return 解析结果;
  已解析 = true;
  for (const 候选 of 候选路径) {
    if (候选.includes(path.sep) && !fs.existsSync(候选)) continue;
    const 结果 = 调用(候选, ["--version"], 5000);
    if (结果.ok) {
      解析结果 = {
        available: true,
        command: 候选,
        version: 结果.stdout.trim().split("\n")[0] || "unknown",
        error: null,
      };
      return 解析结果;
    }
  }
  解析结果 = { available: false, command: null, version: null, error: "找不到 warp-cli" };
  return 解析结果;
}

function 调用(命令, args, timeoutMs = 15000) {
  try {
    const 结果 = spawnSync(命令, args, {
      timeout: timeoutMs,
      encoding: "utf8",
      windowsHide: true,
    });
    return {
      ok: 结果.status === 0,
      status: 结果.status,
      stdout: (结果.stdout || "").trim(),
      stderr: (结果.stderr || "").trim(),
      error: 结果.error ? 结果.error.message : null,
    };
  } catch (err) {
    return { ok: false, status: null, stdout: "", stderr: "", error: err.message };
  }
}

function 解析状态(文本) {
  const 值 = String(文本 || "").toLowerCase();
  const 已连接 = /status\s*update:\s*connected/.test(值) || /^\s*connected\s*$/m.test(值);
  const 连接中 = /connecting/.test(值);
  const 已断开 = /disconnected/.test(值);
  return { connected: 已连接 && !连接中, connecting: 连接中, disconnected: 已断开 };
}

function 状态() {
  const 探测结果 = 探测();
  if (!探测结果.available) {
    return { enabled: 启用(), available: false, error: 探测结果.error, command: null, version: null };
  }
  const 结果 = 调用(探测结果.command, ["status"], 8000);
  const 解析 = 解析状态(`${结果.stdout}\n${结果.stderr}`);
  return {
    enabled: 启用(),
    available: true,
    command: 探测结果.command,
    version: 探测结果.version,
    connected: 解析.connected,
    connecting: 解析.connecting,
    disconnected: 解析.disconnected,
    raw: (结果.stdout || 结果.stderr || "").slice(0, 500),
    error: 结果.ok ? null : 结果.error || 结果.stderr || `warp-cli status 退出码 ${结果.status}`,
  };
}

function 启用() {
  const raw = String(process.env.WARP_MANAGE || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function 连接() {
  if (!启用()) return { ok: false, error: "WARP_MANAGE 未启用。" };
  const 探测结果 = 探测();
  if (!探测结果.available) return { ok: false, error: 探测结果.error };
  const 结果 = 调用(探测结果.command, ["connect"], 30000);
  return { ok: 结果.ok, output: 结果.stdout || 结果.stderr || "", error: 结果.ok ? null : 结果.error };
}

function 断开() {
  if (!启用()) return { ok: false, error: "WARP_MANAGE 未启用。" };
  const 探测结果 = 探测();
  if (!探测结果.available) return { ok: false, error: 探测结果.error };
  const 结果 = 调用(探测结果.command, ["disconnect"], 30000);
  return { ok: 结果.ok, output: 结果.stdout || 结果.stderr || "", error: 结果.ok ? null : 结果.error };
}

function __reset() {
  已解析 = false;
  解析结果 = { available: false, command: null, version: null, error: null };
}

module.exports = { 状态, 连接, 断开, 启用, __reset };
