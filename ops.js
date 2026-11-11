const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Safe mode: temporarily pin the gateway to one egress lane and/or stop exit
// rotation. Auto-clears so a forgotten toggle cannot hide a real outage.
const 默认安全 = { enabled: false, singleLane: false, noRotation: true, until: null, reason: "", setAt: null };
let 安全 = { ...默认安全 };

function 状态() {
  if (安全.enabled && 安全.until && Date.now() >= 安全.until) {
    安全 = { ...默认安全 };
  }
  return {
    ...安全,
    remainingMs: 安全.enabled && 安全.until ? Math.max(0, 安全.until - Date.now()) : 0,
  };
}

function 开启({ minutes = 15, singleLane = false, noRotation = true, reason = "" } = {}) {
  const 分钟 = Math.min(240, Math.max(1, Number(minutes) || 15));
  安全 = {
    enabled: true,
    singleLane: Boolean(singleLane),
    noRotation: Boolean(noRotation),
    until: Date.now() + 分钟 * 60 * 1000,
    reason: String(reason || "").slice(0, 200),
    setAt: Date.now(),
  };
  return 状态();
}

function 关闭() {
  安全 = { ...默认安全 };
  return 状态();
}

function 生效() {
  const state = 状态();
  return {
    active: state.enabled,
    singleLane: state.enabled && state.singleLane,
    noRotation: state.enabled && state.noRotation,
  };
}

// ---- Maintenance scheduler ----
const 维护默认 = {
  enabled: false,
  intervalHours: 6,
  quietFrom: "",
  quietTo: "",
  rotateOnAbuse: true,
  restartOnAbuse: false,
};
let 维护 = { ...维护默认 };
let 维护载入 = false;
let 上次轮换 = 0;
let 上次动作 = "";
let 上次动作At = null;

function 状态目录() {
  const raw = process.env.FUCKING_OPENCODE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return path.join(os.homedir(), ".fucking-opencode");
}

function 维护文件() {
  return path.join(状态目录(), "maintenance.json");
}

function 读维护() {
  if (维护载入) return;
  维护载入 = true;
  try {
    const data = JSON.parse(fs.readFileSync(维护文件(), "utf8"));
    if (data && typeof data === "object" && !Array.isArray(data)) {
      维护 = {
        enabled: Boolean(data.enabled),
        intervalHours: Math.min(168, Math.max(1, Number(data.intervalHours) || 6)),
        quietFrom: /^\d{1,2}:\d{2}$/.test(String(data.quietFrom || "")) ? String(data.quietFrom) : "",
        quietTo: /^\d{1,2}:\d{2}$/.test(String(data.quietTo || "")) ? String(data.quietTo) : "",
        rotateOnAbuse: data.rotateOnAbuse !== false,
        restartOnAbuse: data.restartOnAbuse === true,
      };
      上次轮换 = Number(data.lastRotateAt) || 0;
      上次动作 = String(data.lastAction || "");
      上次动作At = Number(data.lastActionAt) || null;
    }
  } catch {}
}

function 写维护(extra = {}) {
  const 文件 = 维护文件();
  const 临时 = `${文件}.tmp.${process.pid}`;
  const body = { ...维护, lastRotateAt: 上次轮换, lastAction: 上次动作, lastActionAt: 上次动作At, ...extra };
  try {
    fs.mkdirSync(path.dirname(文件), { recursive: true });
    fs.writeFileSync(临时, JSON.stringify(body, null, 2), { mode: 0o600 });
    fs.renameSync(临时, 文件);
  } catch {
    try { fs.unlinkSync(临时); } catch {}
  }
}

function 维护状态() {
  读维护();
  return {
    ...维护,
    lastRotateAt: 上次轮换 || null,
    lastAction: 上次动作,
    lastActionAt: 上次动作At,
    nextRotateAt: 维护.enabled ? (上次轮换 || Date.now()) + 维护.intervalHours * 3600 * 1000 : null,
    quietNow: 安静时段(new Date()),
  };
}

function 保存维护(patch = {}) {
  读维护();
  const next = { ...维护 };
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.intervalHours !== undefined) {
    const n = Number(patch.intervalHours);
    if (!Number.isFinite(n) || n < 1 || n > 168) return { ok: false, error: "intervalHours harus 1..168" };
    next.intervalHours = Math.floor(n);
  }
  for (const key of ["quietFrom", "quietTo"]) {
    if (patch[key] === undefined) continue;
    const value = String(patch[key] || "").trim();
    if (value && !/^\d{1,2}:\d{2}$/.test(value)) return { ok: false, error: `${key} harus HH:MM atau kosong` };
    next[key] = value;
  }
  if (patch.rotateOnAbuse !== undefined) next.rotateOnAbuse = Boolean(patch.rotateOnAbuse);
  if (patch.restartOnAbuse !== undefined) next.restartOnAbuse = Boolean(patch.restartOnAbuse);
  维护 = next;
  写维护();
  return { ok: true, maintenance: 维护状态() };
}

function 分钟数(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function 安静时段(now = new Date()) {
  读维护();
  const from = 分钟数(维护.quietFrom);
  const to = 分钟数(维护.quietTo);
  if (from === null || to === null || from === to) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return from < to ? current >= from && current < to : current >= from || current < to;
}

function 记动作(action) {
  上次动作 = action;
  上次动作At = Date.now();
  写维护();
}

/**
 * Called by the server every minute. ctx = { farm, incidents, restart }.
 * Rotation only happens when the request rate is zero (idle); restarting the
 * sidecar is opt-in because registration is slow.
 */
async function 节拍(ctx = {}) {
  读维护();
  if (!维护.enabled) return { ok: true, skipped: "disabled" };
  if (安静时段(new Date())) return { ok: true, skipped: "quiet" };
  const now = Date.now();
  const farm = ctx.farm || {};
  const running = Boolean(farm.running);
  if (!running) return { ok: true, skipped: "farm-down" };
  const incidents = Array.isArray(ctx.incidents) ? ctx.incidents : [];
  const abuse = incidents.find((row) => row && row.key === "gate_abuse" && row.startedAt > now - 15 * 60 * 1000);
  const idle = ctx.idle !== false;
  if (abuse && 维护.rotateOnAbuse && idle && now - 上次轮换 > 5 * 60 * 1000) {
    const result = typeof ctx.rotateAll === "function" ? await ctx.rotateAll() : { ok: false, error: "rotateAll tidak tersedia" };
    上次轮换 = Date.now();
    记动作(`reaksi ip-abuse: rotate (${result && result.ok ? "ok" : "gagal"})`);
    return { ok: true, action: "rotate-abuse", result };
  }
  if (abuse && 维护.restartOnAbuse && idle && typeof ctx.restart === "function" && now - 上次轮换 > 15 * 60 * 1000) {
    const result = await ctx.restart();
    上次轮换 = Date.now();
    记动作(`reaksi ip-abuse: restart farm (${result && result.ok ? "ok" : "gagal"})`);
    return { ok: true, action: "restart-abuse", result };
  }
  if (维护.intervalHours > 0 && now - (上次轮换 || 0) >= 维护.intervalHours * 3600 * 1000 && idle) {
    const result = typeof ctx.rotateAll === "function" ? await ctx.rotateAll() : { ok: false, error: "rotateAll tidak tersedia" };
    上次轮换 = Date.now();
    记动作(`rotasi terjadwal (${result && result.ok ? "ok" : "gagal"})`);
    return { ok: true, action: "rotate-scheduled", result };
  }
  return { ok: true, skipped: idle ? "not-due" : "busy" };
}

function __reset() {
  安全 = { ...默认安全 };
  维护 = { ...维护默认 };
  维护载入 = false;
  上次轮换 = 0;
  上次动作 = "";
  上次动作At = null;
}

module.exports = {
  状态: 状态,
  开启,
  关闭,
  生效,
  维护状态,
  保存维护,
  节拍,
  安静时段,
  __reset,
};
