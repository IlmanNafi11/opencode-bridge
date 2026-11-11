const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Farm 自愈：探测 lane 就绪度，按端口退避轮换失效 lane，整池死亡时重启；
// 可选在持续拥塞时扩容 lane 数。所有动作有冷却，失败只记录不抛错。
const 默认 = {
  enabled: false,
  intervalSec: 30,
  readyFloorPct: 50,
  quarantineMs: 5 * 60 * 1000,
  reconnectBackoffMs: 10 * 60 * 1000,
  autoScale: false,
  minLanes: 1,
  maxLanes: 8,
  scaleUpInflight: 8,
  scaleUpAfter: 3,
};
let 设置 = { ...默认 };
let 已载入 = false;
const 状态 = {
  lastRunAt: null,
  lastAction: "",
  lastActionAt: null,
  lastRestartAt: null,
  lastScaleAt: null,
  lane: {},
  actions: [],
  ready: 0,
  total: 0,
  busyStreak: 0,
};
let 运行中 = false;

function 状态目录() {
  const raw = process.env.FUCKING_OPENCODE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return path.join(os.homedir(), ".fucking-opencode");
}

function 设置文件() {
  return path.join(状态目录(), "autoheal.json");
}

function 收窄(raw = {}) {
  const out = { ...默认 };
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.autoScale === "boolean") out.autoScale = raw.autoScale;
  for (const [key, min, max] of [
    ["intervalSec", 10, 600],
    ["readyFloorPct", 10, 100],
    ["quarantineMs", 60000, 86400000],
    ["reconnectBackoffMs", 60000, 86400000],
    ["minLanes", 1, 32],
    ["maxLanes", 1, 32],
    ["scaleUpInflight", 1, 512],
    ["scaleUpAfter", 1, 60],
  ]) {
    const n = Number(raw[key]);
    if (Number.isFinite(n)) out[key] = Math.min(Math.max(Math.floor(n), min), max);
  }
  if (out.maxLanes < out.minLanes) out.maxLanes = out.minLanes;
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
  写入();
  return { ok: true, autoheal: { ...状态, settings: { ...设置 } } };
}

function 就绪(lane) {
  if (!lane) return false;
  return lane.ready === true || lane.ok === true || lane.state === "ready" || lane.state === "ok";
}

function 记动作(action, detail = null) {
  状态.lastAction = action;
  状态.lastActionAt = Date.now();
  状态.actions.unshift({ at: new Date().toISOString(), action, detail });
  while (状态.actions.length > 50) 状态.actions.pop();
}

async function 通报(ctx, key, text) {
  try {
    if (ctx.notify && typeof ctx.notify.发送 === "function") await ctx.notify.发送(key, text, { level: "warn" });
    else if (typeof ctx.notify === "function") await ctx.notify(text);
  } catch {}
}

function 快照() {
  return { ...状态, lane: { ...状态.lane }, settings: 读取() };
}

/** 一轮自愈；返回本轮动作，绝不抛错。ctx = { farm, inflight, notify, rotate, restart, scale }。 */
async function 节拍(ctx = {}) {
  if (运行中) return { ok: true, skipped: "running" };
  const cfg = 读取();
  状态.lastRunAt = Date.now();
  if (!cfg.enabled) return { ok: true, skipped: "disabled" };
  运行中 = true;
  const actions = [];
  try {
    let farm = {};
    try { farm = ctx.farm ? (ctx.farm.状态 ? ctx.farm.状态() : ctx.farm) : {}; } catch {}
    const lanes = Array.isArray(farm.lanes) ? farm.lanes : [];
    const now = Date.now();
    状态.total = lanes.length;
    const readyLanes = lanes.filter(就绪);
    状态.ready = readyLanes.length;
    if (!farm.running) {
      记动作("farm-down");
      return { ok: true, actions, ready: 0, total: lanes.length, farmDown: true };
    }

    // 逐 lane 轮换失效出口；每轮最多处理一个，避免同时重建全部隧道。
    if (typeof ctx.rotate === "function") {
      for (const lane of lanes) {
        const port = lane && lane.port;
        if (!port || 就绪(lane)) continue;
        const last = Number(状态.lane[port] || 0);
        if (now - last < cfg.reconnectBackoffMs) continue;
        状态.lane[port] = now;
        const result = await ctx.rotate(port).catch((err) => ({ ok: false, error: err.message }));
        const line = `lane ${lane.index ?? port} 轮换：${result && result.ok ? "ok" : (result && result.error) || "gagal"}`;
        记动作("rotate-lane", line);
        actions.push({ type: "rotate", port, ok: Boolean(result && result.ok), error: result && result.error });
        if (!(result && result.ok)) await 通报(ctx, `autoheal:rotate:${port}`, line);
        break;
      }
    }

    const floor = Math.max(1, Math.ceil((lanes.length || 1) * cfg.readyFloorPct / 100));
    if (readyLanes.length < floor) {
      状态.busyStreak += 1;
      const canRestart = farm.running && typeof ctx.restart === "function" && now - (状态.lastRestartAt || 0) > 15 * 60 * 1000;
      if (应重启农场(readyLanes.length, floor) && canRestart) {
        状态.lastRestartAt = now;
        const result = await ctx.restart().catch((err) => ({ ok: false, error: err.message }));
        const line = `restart farm：${result && result.ok ? "ok" : (result && result.error) || "gagal"}`;
        记动作("restart-farm", line);
        actions.push({ type: "restart", ok: Boolean(result && result.ok), error: result && result.error });
        await 通报(ctx, "autoheal:restart", line);
      } else if (cfg.enabled) {
        await 通报(ctx, "autoheal:floor", `lane siap ${readyLanes.length}/${lanes.length} di bawah floor ${floor}.`);
      }
      // 持续拥塞时扩容：只在无在途流量或拥塞持续多轮时执行，且不自动缩容。
      if (cfg.autoScale && typeof ctx.scale === "function") {
        const inflight = Number(ctx.inflight) || 0;
        const size = Number(farm.settings && farm.settings.size) || lanes.length;
        const congested = inflight >= cfg.scaleUpInflight || readyLanes.length === 0;
        if (congested && 状态.busyStreak >= cfg.scaleUpAfter && size < cfg.maxLanes && now - (状态.lastScaleAt || 0) > 30 * 60 * 1000) {
          状态.lastScaleAt = now;
          const result = await ctx.scale(size + 1).catch((err) => ({ ok: false, error: err.message }));
          const line = `scale ${size} -> ${size + 1}：${result && result.ok ? "ok" : (result && result.error) || "gagal"}`;
          记动作("scale-up", line);
          actions.push({ type: "scale", from: size, to: size + 1, ok: Boolean(result && result.ok), error: result && result.error });
          await 通报(ctx, "autoheal:scale", line);
          状态.busyStreak = 0;
        }
      }
    } else {
      状态.busyStreak = 0;
    }
    return { ok: true, actions, ready: readyLanes.length, total: lanes.length, floor };
  } catch (err) {
    记动作("error", err.message);
    return { ok: false, error: err.message, actions };
  } finally {
    运行中 = false;
  }
}

function 应重启农场(ready, floor) {
  return ready === 0 && floor > 0;
}

function __reset() {
  设置 = { ...默认 };
  已载入 = false;
  Object.assign(状态, {
    lastRunAt: null, lastAction: "", lastActionAt: null, lastRestartAt: null, lastScaleAt: null,
    lane: {}, actions: [], ready: 0, total: 0, busyStreak: 0,
  });
  运行中 = false;
}

module.exports = { 状态, 快照, 保存, 节拍, 设置文件, __reset };
