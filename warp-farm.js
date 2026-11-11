#!/usr/bin/env bun
/**
 * warp-farm.js — Go sidecar `warp-farm` 的桥接层（userspace WARP，无 Docker、无 TUN）。
 *
 * Go 进程注册 N 个 Cloudflare WARP 设备，并为每个 exit 开一个 SOCKS5 监听
 * （默认 127.0.0.1:40001..）。本模块只负责：
 *   1. 找到并启动二进制，
 *   2. 等待它的 control HTTP 就绪，
 *   3. 把 lane 注册进现有代理池。
 *
 * 不同语言无法直接 `require`；可 require 的是这个进程契约。网关按普通
 * SOCKS5 URL 使用 lane，所以 proxy.js、health、冷却和面板既不知道、
 * 也不需要知道背后是 WireGuard。
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const 默认端口基数 = Number(process.env.WARP_FARM_BASE_PORT || 40001);
const 默认大小 = Number(process.env.WARP_FARM_SIZE || 8);
const 默认栈 = process.env.WARP_FARM_STACK || "ipv6";
const 日志上限 = 200;

let 子进程 = null;
let 状态缓存 = {
  running: false,
  pid: null,
  basePort: 默认端口基数,
  controlPort: 默认端口基数 - 1,
  stack: 默认栈,
  lanes: [],
  error: null,
  startedAt: null,
};
let 日志环 = [];
let 停止中 = false;

function 记录行(chunk, stream) {
  const text = String(chunk || "");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    日志环.push({ at: Date.now(), stream, line: trimmed });
  }
  if (日志环.length > 日志上限) 日志环 = 日志环.slice(-日志上限);
}

function 候选二进制() {
  const list = [];
  if (process.env.WARP_FARM_BIN) list.push(process.env.WARP_FARM_BIN);
  const exe = process.platform === "win32" ? "warp-farm.exe" : "warp-farm";
  list.push(path.join(__dirname, "warp-farm", exe));
  list.push(path.join(__dirname, "dist", exe));
  list.push(path.join(__dirname, exe));
  return list;
}

function 找二进制() {
  for (const candidate of 候选二进制()) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function 控制地址(port) {
  return `http://127.0.0.1:${port}`;
}

function 状态目录() {
  const raw = process.env.FUCKING_OPENCODE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return path.join(require("os").homedir(), ".fucking-opencode");
}

function 设置文件() {
  return path.join(状态目录(), "warp-farm.json");
}

/** 面板保存的参数；文件缺失时回落到环境变量/内置默认值。 */
function 读设置() {
  const 值 = { size: 默认大小, basePort: 默认端口基数, stack: 默认栈, sourceIpv6: "", watchdog: true };
  try {
    const data = JSON.parse(fs.readFileSync(设置文件(), "utf8"));
    if (data && typeof data === "object") {
      if (Number.isInteger(data.size) && data.size >= 1 && data.size <= 32) 值.size = data.size;
      if (Number.isInteger(data.basePort) && data.basePort >= 1024 && data.basePort <= 65000) 值.basePort = data.basePort;
      if (["ipv6", "ipv4", "dual"].includes(data.stack)) 值.stack = data.stack;
      if (typeof data.sourceIpv6 === "string") 值.sourceIpv6 = data.sourceIpv6.trim();
      if (typeof data.watchdog === "boolean") 值.watchdog = data.watchdog;
    }
  } catch {}
  return 值;
}

function 保存设置(patch = {}) {
  const 当前 = 读设置();
  if (patch.size != null) {
    const n = Number(patch.size);
    if (!Number.isInteger(n) || n < 1 || n > 32) return { ok: false, error: "size 必须是 1..32 的整数。" };
    当前.size = n;
  }
  if (patch.basePort != null) {
    const n = Number(patch.basePort);
    if (!Number.isInteger(n) || n < 1024 || n > 65000) return { ok: false, error: "basePort 必须是 1024..65000 的整数。" };
    当前.basePort = n;
  }
  if (patch.stack != null) {
    if (!["ipv6", "ipv4", "dual"].includes(patch.stack)) return { ok: false, error: "stack 只能是 ipv6、ipv4 或 dual。" };
    当前.stack = patch.stack;
  }
  if (patch.sourceIpv6 != null) 当前.sourceIpv6 = String(patch.sourceIpv6).trim();
  if (patch.watchdog != null) 当前.watchdog = patch.watchdog !== false;
  const 文件 = 设置文件();
  const 临时 = `${文件}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(文件), { recursive: true });
    fs.writeFileSync(临时, JSON.stringify(当前, null, 2), { mode: 0o600 });
    fs.renameSync(临时, 文件);
  } catch (err) {
    try {
      fs.unlinkSync(临时);
    } catch {}
    return { ok: false, error: `写入 warp-farm.json 失败：${err.message}` };
  }
  return { ok: true, settings: 当前 };
}

async function 取状态(port = 状态缓存.controlPort, timeoutMs = 1500) {
  const res = await fetch(`${控制地址(port)}/status`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`control HTTP ${res.status}`);
  return res.json();
}

function 合成池条目(status) {
  return (status.lanes || []).map((lane) => ({
    id: `warp-f${lane.index}`,
    label: `warp-f${lane.index}`,
    url: lane.url,
    direct: false,
    enabled: true,
    weight: 1,
  }));
}

/** 把 lane 注册进代理池，不丢弃非 farm 的条目。 */
function 应用到池(status = 状态缓存) {
  const proxy = require("./proxy");
  const entries = (status.lanes || []).map((lane) => ({
    id: `warp-f${lane.index}`,
    label: `warp-f${lane.index}`,
    url: lane.url,
    enabled: true,
    weight: 1,
  }));
  if (entries.length === 0) return { ok: false, reason: "tidak ada lane" };
  const existing = proxy
    .getPool()
    .filter((entry) => !String(entry.id || "").startsWith("warp-f"));
  proxy.setPool({ entries: [...existing, ...entries], strategy: "round-robin" });
  return { ok: true, entries: entries.length + existing.length };
}

/** 从代理池移除 farm lane，保留其它条目；全部移除时池会退回直连/单代理。 */
function 从池移除() {
  try {
    const proxy = require("./proxy");
    const all = proxy.getPool();
    const keep = all.filter((entry) => !String(entry.id || "").startsWith("warp-f"));
    if (keep.length === all.length) return { ok: true, removed: 0 };
    proxy.setPool({ entries: keep });
    return { ok: true, removed: all.length - keep.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

let 看门狗 = null;
let 看门狗忙 = false;
let 上次重启 = 0;
let 用户停止 = false;

/** 看门狗：sidecar 消失或控制端口无响应时清空死 lane，并按设置自动重启。 */
async function 看门狗节拍() {
  if (看门狗忙) return;
  看门狗忙 = true;
  try {
    const proxy = require("./proxy");
    const farmInPool = () =>
      proxy.getPool().some((entry) => String(entry.id || "").startsWith("warp-f"));
    const settings = 读设置();
    if (!子进程) {
      if ((状态缓存.lanes || []).length > 0) {
        状态缓存 = { ...状态缓存, lanes: [] };
        从池移除();
      } else if (farmInPool()) {
        从池移除();
      }
      if (settings.watchdog === false || 用户停止 || 停止中) return;
      if (Date.now() - 上次重启 < 15000) return;
      if (!找二进制()) return;
      上次重启 = Date.now();
      记录行("[watchdog] warp-farm berhenti; memulai ulang\n", "stderr");
      await 启动({ applyToPool: true }).catch(() => {});
      return;
    }
    let status = null;
    try {
      status = await 取状态(状态缓存.controlPort, 1500);
    } catch (err) {
      记录行(`[watchdog] control port tidak merespons: ${err.message}\n`, "stderr");
      try {
        子进程.kill();
      } catch {}
      return;
    }
    状态缓存 = {
      ...状态缓存,
      running: true,
      lanes: status.lanes || [],
      stack: status.stack || 状态缓存.stack,
      error: null,
    };
    const ready = (状态缓存.lanes || []).filter((lane) => lane.ready);
    if (ready.length > 0 && !farmInPool()) 应用到池(状态缓存);
    else if (ready.length === 0 && farmInPool()) 从池移除();
  } finally {
    看门狗忙 = false;
  }
}

function 启动看门狗() {
  if (看门狗) return;
  看门狗 = setInterval(() => {
    看门狗节拍().catch(() => {});
  }, 5000);
  看门狗.unref?.();
}

function 停止看门狗() {
  if (!看门狗) return;
  clearInterval(看门狗);
  看门狗 = null;
}

async function 启动(options = {}) {
  用户停止 = false;
  if (子进程 && !子进程.killed) {
    return { ok: true, already: true, ...状态缓存 };
  }
  const binary = options.binary || 找二进制();
  if (!binary) {
    return {
      ok: false,
      error:
        "binary warp-farm tidak ditemukan; build dengan `cd warp-farm && go build -o warp-farm.exe .` atau set WARP_FARM_BIN",
    };
  }
  const 保存值 = 读设置();
  const size = Math.max(1, Math.min(32, Number(options.size || 保存值.size)));
  const basePort = Math.max(1024, Number(options.basePort || 保存值.basePort));
  const controlPort = Math.max(
    1024,
    Number(options.controlPort || (options.controlPort === 0 ? 0 : basePort - 1))
  );
  const stack = String(options.stack || 保存值.stack);
  const host = "127.0.0.1";
  const args = [
    "-host", host,
    "-size", String(size),
    "-base-port", String(basePort),
    "-control-port", String(controlPort),
    "-stack", stack,
  ];
  if (options.sourceIpv6) args.push("-source-ipv6", String(options.sourceIpv6));
  else if (保存值.sourceIpv6) args.push("-source-ipv6", 保存值.sourceIpv6);

  日志环 = [];
  状态缓存 = {
    running: false,
    pid: null,
    basePort,
    controlPort,
    stack,
    lanes: [],
    error: null,
    startedAt: null,
    binary,
  };

  const child = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  子进程 = child;
  启动看门狗();
  child.stdout.on("data", (chunk) => 记录行(chunk, "stdout"));
  child.stderr.on("data", (chunk) => 记录行(chunk, "stderr"));
  child.on("exit", (code, signal) => {
    if (!停止中) {
      const tail = 日志环.slice(-5).map((row) => row.line).join(" | ");
      状态缓存 = {
        ...状态缓存,
        running: false,
        pid: null,
        lanes: [],
        error: `warp-farm keluar (code=${code} signal=${signal})${tail ? `: ${tail}` : ""}`,
      };
      // 死掉的 lane 不能留在池里：挑选出口从不回退，会把所有请求送进死端口。
      从池移除();
    }
    子进程 = null;
  });
  child.on("error", (err) => {
    状态缓存 = { ...状态缓存, running: false, error: err.message };
  });

  const deadline = Date.now() + Math.max(10000, Number(options.timeoutMs || 90000));
  let lastError = null;
  while (Date.now() < deadline) {
    if (!子进程) {
      return { ok: false, error: 状态缓存.error || "warp-farm gagal start", log: 日志环.slice(-20) };
    }
    try {
      const status = await 取状态(controlPort);
      状态缓存 = {
        ...状态缓存,
        running: true,
        pid: child.pid || null,
        basePort: status.basePort,
        controlPort: status.controlPort,
        stack: status.stack,
        lanes: status.lanes,
        error: null,
        startedAt: 状态缓存.startedAt || Date.now(),
      };
      const ready = (status.lanes || []).filter((lane) => lane.ready);
      if (ready.length > 0) {
        let applied = null;
        if (options.applyToPool !== false) {
          try {
            applied = 应用到池(状态缓存);
          } catch (err) {
            applied = { ok: false, error: err.message };
          }
        }
        return {
          ok: true,
          ready: ready.length,
          pending: (status.lanes || []).length - ready.length,
          applied,
          ...状态缓存,
        };
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return {
    ok: false,
    error: `warp-farm belum siap dalam batas waktu (${lastError ? lastError.message : "tidak ada lane siap"})`,
    running: Boolean(子进程),
    ...状态缓存,
    log: 日志环.slice(-20),
  };
}

async function 刷新() {
  if (!子进程) {
    状态缓存 = { ...状态缓存, running: false };
    return 状态缓存;
  }
  try {
    const status = await 取状态();
    状态缓存 = {
      ...状态缓存,
      running: true,
      lanes: status.lanes,
      stack: status.stack,
      basePort: status.basePort,
      controlPort: status.controlPort,
      error: null,
    };
  } catch (err) {
    状态缓存 = { ...状态缓存, error: err.message };
  }
  return 状态缓存;
}

async function 轮换(port = null) {
  if (!子进程) return { ok: false, error: "warp-farm tidak berjalan" };
  const url = port
    ? `${控制地址(状态缓存.controlPort)}/rotate?port=${encodeURIComponent(port)}`
    : `${控制地址(状态缓存.controlPort)}/rotate`;
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(180000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
    状态缓存 = { ...状态缓存, lanes: body.lanes || 状态缓存.lanes };
    return { ok: true, ...body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function 停止() {
  用户停止 = true;
  if (!子进程) {
    状态缓存 = { ...状态缓存, running: false, pid: null, lanes: [] };
    从池移除();
    return { ok: true, already: true };
  }
  停止中 = true;
  const child = 子进程;
  try {
    await fetch(`${控制地址(状态缓存.controlPort)}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve();
    }, 6000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  停止中 = false;
  子进程 = null;
  状态缓存 = { ...状态缓存, running: false, pid: null, lanes: [] };
  从池移除();
  return { ok: true };
}

/** 面板用的状态：进程、lane、参数与最近日志；不含凭据。 */
function 状态() {
  return {
    ...状态缓存,
    settings: 读设置(),
    binaryAvailable: Boolean(状态缓存.binary || 找二进制()),
    log: 日志环.slice(-20),
  };
}

/** 重启：先停止，再用保存的参数（或本次传入的修改）重新启动。 */
async function 重启动(options = {}) {
  const 保存 = {};
  if (options.size != null || options.basePort != null || options.stack != null || options.sourceIpv6 != null) {
    const saved = 保存设置(options);
    if (!saved.ok) return saved;
    Object.assign(保存, saved.settings);
  }
  await 停止();
  return 启动({ ...保存, ...options });
}

/** 供 /api/logs 使用的 sidecar 原始日志（stdout/stderr）。 */
function 日志(lines = 200) {
  const n = Math.max(1, Math.min(日志上限, Number(lines) || 200));
  return 日志环.slice(-n);
}

/** WARP_FARM=1 时自动启动；server.js 在启动时调用。 */
async function 自动启动() {
  if (String(process.env.WARP_FARM || "") !== "1") return { ok: false, skipped: true };
  const options = {
    timeoutMs: Number(process.env.WARP_FARM_START_TIMEOUT_MS || 90000),
  };
  if (process.env.WARP_FARM_SIZE) options.size = Number(process.env.WARP_FARM_SIZE);
  if (process.env.WARP_FARM_BASE_PORT) options.basePort = Number(process.env.WARP_FARM_BASE_PORT);
  if (process.env.WARP_FARM_STACK) options.stack = process.env.WARP_FARM_STACK;
  if (process.env.WARP_FARM_SOURCE_IPV6) options.sourceIpv6 = process.env.WARP_FARM_SOURCE_IPV6;
  return 启动(options);
}

module.exports = {
  start: 启动,
  stop: 停止,
  restart: 重启动,
  rotate: 轮换,
  status: 状态,
  refresh: 刷新,
  applyPool: 应用到池,
  autoStart: 自动启动,
  settings: 读设置,
  saveSettings: 保存设置,
  log: 日志,
  binaryPath: 找二进制,
  poolEntries: 合成池条目,
  启动看门狗,
  停止看门狗,
  从池移除,
  controlUrl: () => 控制地址(状态缓存.controlPort),
  // 供 server.js 使用其内部命名的别名。
  启动,
  停止,
  重启动,
  轮换,
  状态,
  刷新,
  应用到池,
  自动启动,
  设置: 读设置,
  保存设置,
  日志,
};
