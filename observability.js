const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// In-process request observability: request traces, in-flight state, per-exit
// scoreboards, first-event latency, and incident history. Never stores prompt
// or completion text, API keys, or proxy credentials.
const 请求上限 = 300;
const 事件上限 = 40;
const 事故上限 = 100;
const 形状上限 = 30;
const 首事件样本上限 = 200;
const 首事件桶 = [0, 100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, Infinity];

let 请求 = [];
let 请求表 = new Map();
let 在途 = new Map();
let 出口表 = new Map();
let 事故 = [];
let 活动事故 = new Map();
let 形状 = [];
let 事故载入 = false;
const 计数 = {
  total: 0,
  attempts: 0,
  modelSwitches: 0,
  exitSwaps: 0,
  firstEvents: 0,
  byStatus: new Map(),
  byModel: new Map(),
  byOutcome: new Map(),
};
let 首事件样本 = [];

function 状态目录() {
  const raw = process.env.FUCKING_OPENCODE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return path.join(os.homedir(), ".fucking-opencode");
}

function 事故文件() {
  return path.join(状态目录(), "incidents.json");
}

function 读事故() {
  if (事故载入) return;
  事故载入 = true;
  try {
    const data = JSON.parse(fs.readFileSync(事故文件(), "utf8"));
    if (Array.isArray(data)) {
      事故 = data.filter((row) => row && typeof row === "object").slice(-事故上限);
    }
  } catch {}
}

function 写事故() {
  const 文件 = 事故文件();
  const 临时 = `${文件}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(文件), { recursive: true });
    fs.writeFileSync(临时, JSON.stringify(事故.slice(-事故上限)), { mode: 0o600 });
    fs.renameSync(临时, 文件);
  } catch {
    try {
      fs.unlinkSync(临时);
    } catch {}
  }
}

function 错误分类(status, reason) {
  const 文本 = String(reason || "");
  if (/abuse/i.test(文本)) return "abuse";
  if (/tls|clienthello|fingerprint|shape|anchor/i.test(文本)) return "shape";
  if (status === 429 || /429|allowance|quota|kuota|capacity/i.test(文本)) return "quota";
  if (status === 401 || status === 403) return "auth";
  if (status === 400 || status === 413 || status === 422) return "shape";
  if (status >= 500 || /5\d\d|tunnel|unreachable|transport/i.test(文本)) return "server";
  return "other";
}

function 出口(名) {
  const key = String(名 || "direct").slice(0, 80);
  let row = 出口表.get(key);
  if (!row) {
    row = {
      exit: key,
      attempts: 0,
      success: 0,
      errors: 0,
      status429: 0,
      statusAbuse: 0,
      status5xx: 0,
      timeouts: 0,
      swaps: 0,
      categories: {},
      firstEventSamples: [],
      lastUsedAt: null,
      lastError: null,
    };
    出口表.set(key, row);
  }
  return row;
}

function 记数(map, key, n = 1) {
  map.set(key, (map.get(key) || 0) + n);
}

function 开始请求(id, meta = {}) {
  if (!id) return null;
  const rec = {
    id: String(id),
    at: Date.now(),
    endedAt: null,
    model: meta.model || "",
    protocol: meta.protocol || "openai",
    stream: Boolean(meta.stream),
    keyLabel: meta.keyLabel || "",
    clientIp: meta.clientIp || "",
    attempts: [],
    events: [],
    firstEventMs: null,
    status: null,
    ms: null,
    egress: null,
    exitSwaps: 0,
    modelSwitches: 0,
    inputTokens: null,
    outputTokens: null,
    error: null,
  };
  if (请求表.has(rec.id)) 移除请求(rec.id);
  请求.push(rec);
  请求表.set(rec.id, rec);
  while (请求.length > 请求上限) {
    const old = 请求.shift();
    请求表.delete(old.id);
  }
  在途.set(rec.id, { id: rec.id, at: rec.at, model: rec.model, protocol: rec.protocol, stream: rec.stream, lastEventAt: rec.at, egress: null, modelSwitch: 0 });
  计数.total += 1;
  return rec;
}

function 移除请求(id) {
  const index = 请求.findIndex((row) => row.id === id);
  if (index >= 0) 请求.splice(index, 1);
  请求表.delete(id);
  在途.delete(id);
}

function 事件(rec, entry) {
  if (!rec) return;
  rec.events.push({ at: Date.now(), ...entry });
  if (rec.events.length > 事件上限) rec.events.shift();
  const live = 在途.get(rec.id);
  if (live) live.lastEventAt = Date.now();
}

function 尝试(id, model) {
  const rec = 请求表.get(id);
  if (!rec) return;
  计数.attempts += 1;
  if (rec.attempts.length > 0 && rec.model && rec.model !== model) {
    rec.modelSwitches += 1;
    计数.modelSwitches += 1;
  }
  rec.model = model || rec.model;
  rec.attempts.push({ at: Date.now(), model: rec.model });
  事件(rec, { kind: "attempt", model: rec.model });
  const live = 在途.get(id);
  if (live) {
    live.model = rec.model;
    live.modelSwitch = rec.modelSwitches;
    live.lastEventAt = Date.now();
  }
}

function 出口事件(id, { exit, action, reason = "", status = null, ms = null } = {}) {
  const rec = id ? 请求表.get(id) : null;
  const row = 出口(exit);
  row.lastUsedAt = Date.now();
  const kind = String(action || "");
  if (kind === "attempt") {
    row.attempts += 1;
    if (rec) rec.egress = row.exit;
  } else if (kind === "success") {
    row.success += 1;
    row.lastError = null;
  } else if (kind === "fail" || kind === "swap") {
    if (kind === "fail") row.errors += 1;
    if (kind === "swap") {
      row.swaps += 1;
      if (rec) {
        rec.exitSwaps += 1;
        计数.exitSwaps += 1;
      }
    }
    row.lastError = String(reason || `status ${status}`).slice(0, 160);
    if (kind === "fail") {
      const 文本 = String(reason || "");
      const 分类 = 错误分类(status, 文本);
      row.categories[分类] = (row.categories[分类] || 0) + 1;
      if (status === 429 || /429|allowance|quota|kuota/i.test(文本)) row.status429 += 1;
      if (/abuse/i.test(文本)) row.statusAbuse += 1;
      else if (status >= 500 || /5\d\d|tunnel|unreachable|transport/i.test(文本)) row.status5xx += 1;
      if (/timeout|first_event/i.test(文本)) row.timeouts += 1;
    }
  }
  if (rec) {
    事件(rec, { kind: kind || "exit", exit: row.exit, reason: String(reason || "").slice(0, 120), status, ms });
    const live = 在途.get(id);
    if (live) {
      live.egress = row.exit;
      live.lastEventAt = Date.now();
    }
  }
}

function 首事件(id, ms, exitName) {
  const rec = 请求表.get(id);
  const 毫秒 = Number(ms);
  if (!Number.isFinite(毫秒) || 毫秒 < 0) return;
  计数.firstEvents += 1;
  首事件样本.push(毫秒);
  if (首事件样本.length > 400) 首事件样本.shift();
  const row = 出口(exitName || (rec && rec.egress) || "unknown");
  row.firstEventSamples.push(Math.round(毫秒));
  if (row.firstEventSamples.length > 首事件样本上限) row.firstEventSamples.shift();
  if (rec) {
    if (rec.firstEventMs === null) rec.firstEventMs = Math.round(毫秒);
    rec.egress = row.exit;
    事件(rec, { kind: "first_event", exit: row.exit, ms: Math.round(毫秒) });
  }
}

function 结束(id, patch = {}) {
  const rec = 请求表.get(id);
  if (!rec) return null;
  const status = patch.status === undefined ? rec.status : Number(patch.status);
  if (rec.endedAt) {
    if (status) rec.status = status;
    return rec;
  }
  rec.endedAt = patch.endedAt || Date.now();
  if (status) rec.status = status;
  rec.ms = Number.isFinite(Number(patch.ms)) ? Number(patch.ms) : rec.endedAt - rec.at;
  if (patch.egress) rec.egress = String(patch.egress).slice(0, 80);
  if (patch.error) rec.error = String(patch.error).slice(0, 160);
  if (Number.isFinite(Number(patch.input_tokens))) rec.inputTokens = Number(patch.input_tokens);
  if (Number.isFinite(Number(patch.output_tokens))) rec.outputTokens = Number(patch.output_tokens);
  if (patch.ttftMs !== undefined && rec.firstEventMs === null && Number.isFinite(Number(patch.ttftMs))) {
    rec.firstEventMs = Math.round(Number(patch.ttftMs));
  }
  const outcome = rec.status >= 200 && rec.status < 300 ? "ok" : rec.status >= 400 && rec.status < 500 ? "client_error" : rec.status >= 500 ? "server_error" : "other";
  记数(计数.byOutcome, outcome);
  记数(计数.byStatus, String(rec.status || "unknown"));
  记数(计数.byModel, rec.model || "unknown");
  事件(rec, { kind: "result", status: rec.status, ms: rec.ms, egress: rec.egress || null });
  在途.delete(rec.id);
  return rec;
}

function 记录形状(shape) {
  if (!shape || typeof shape !== "object") return;
  形状.push({ at: Date.now(), ...shape });
  while (形状.length > 形状上限) 形状.shift();
}

function 分位(samples, q) {
  if (!samples || samples.length === 0) return null;
  const sorted = samples.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

function 事故状态(key, active, info = {}) {
  读事故();
  const now = Date.now();
  if (active && !活动事故.has(key)) {
    const rec = {
      id: `${key}-${now.toString(36)}`,
      key,
      title: info.title || key,
      detail: info.detail || "",
      severity: info.severity || "warn",
      startedAt: now,
      endedAt: null,
      durationMs: null,
    };
    活动事故.set(key, rec);
    事故.push(rec);
    if (事故.length > 事故上限) 事故 = 事故.slice(-事故上限);
    写事故();
  } else if (!active && 活动事故.has(key)) {
    const rec = 活动事故.get(key);
    活动事故.delete(key);
    rec.endedAt = now;
    rec.durationMs = now - rec.startedAt;
    写事故();
  }
}

function 采样(样本 = {}) {
  const 新事故 = [];
  const 之前 = new Set(活动事故.keys());
  const pool = 样本.pool || {};
  const farm = 样本.farm || {};
  const lanes = Array.isArray(farm.lanes) ? farm.lanes : [];
  const ready = lanes.filter((lane) => lane && lane.ready).length;
  const farmExpected = Boolean(样本.farmExpected);
  事故状态("pool_empty", pool.mode === "pool" && Number(pool.enabled) > 0 && Number(pool.ready) === 0 && !样本.safeMode, {
    title: "Pool kosong",
    detail: `${pool.enabled || 0} entri aktif, 0 siap`,
    severity: "error",
  });
  事故状态("lanes_low", farmExpected && lanes.length > 0 && ready / lanes.length < 0.5, {
    title: "Lane WARP < 50% siap",
    detail: `${ready}/${lanes.length} ready`,
    severity: "warn",
  });
  事故状态("farm_down", farmExpected && farm.running === false, {
    title: "WARP farm berhenti",
    detail: "sidecar tidak berjalan",
    severity: "error",
  });
  const anonMs = Number(样本.anonymousPauseMs) || 0;
  事故状态("anonymous_paused", anonMs > 0, {
    title: "Anonymous lane dijeda",
    detail: `sisa ${Math.ceil(anonMs / 1000)} dtk`,
    severity: "warn",
  });
  const gate = 样本.gate || {};
  const abuseRecent = gate.status === "ip-blocked" && Number(gate.ipBlockedSince) > 0 && Date.now() - Number(gate.ipBlockedSince) < 30 * 60 * 1000;
  事故状态("gate_abuse", abuseRecent, {
    title: "Gate melaporkan ip-abuse",
    detail: gate.ipBlockedSince ? new Date(Number(gate.ipBlockedSince)).toISOString() : "",
    severity: "error",
  });
  for (const [key, rec] of 活动事故) {
    if (!之前.has(key)) 新事故.push(rec);
  }
  return 新事故;
}

function 最近比例(statusClass, 毫秒) {
  const since = Date.now() - 毫秒;
  let total = 0;
  let hit = 0;
  for (const rec of 请求) {
    if (rec.at < since || rec.endedAt === null) continue;
    total += 1;
    if (statusClass === "429" && rec.status === 429) hit += 1;
    else if (statusClass === "error" && rec.status >= 400) hit += 1;
  }
  return { hit, total, ratio: total ? hit / total : 0 };
}

function 评分(样本 = {}) {
  const farm = 样本.farm || {};
  const pool = 样本.pool || {};
  const lanes = Array.isArray(farm.lanes) ? farm.lanes : [];
  const ready = lanes.filter((lane) => lane && lane.ready).length;
  const total = lanes.length;
  const cooldowns = Number(样本.modelCooldowns) || 0;
  const coolingBlocks = Number(样本.coolingBlocks) || 0;
  const anonMs = Number(样本.anonymousPauseMs) || 0;
  const gate = 样本.gate || {};
  const 四二九 = 最近比例("429", 15 * 60 * 1000);
  let score = 100;
  const reasons = [];
  if (total > 0) {
    if (ready === 0) {
      score -= 45;
      reasons.push("0 lane siap");
    } else if (ready / total < 0.5) {
      score -= 20;
      reasons.push(`${ready}/${total} lane siap`);
    }
  }
  if (pool.mode === "pool" && Number(pool.enabled) > 0 && Number(pool.ready) === 0) {
    score -= 20;
    reasons.push("pool kosong");
  }
  if (coolingBlocks > 0) {
    score -= Math.min(15, coolingBlocks * 3);
    reasons.push(`${coolingBlocks} blok /64 cooling`);
  }
  if (anonMs > 0) {
    score -= 25;
    reasons.push("anonymous paused");
  }
  if (gate.status === "ip-blocked") {
    score -= 30;
    reasons.push("gate ip-abuse");
  } else if (gate.status === "throttled") {
    score -= 10;
    reasons.push("gate throttled");
  }
  if (cooldowns > 0) {
    score -= Math.min(10, cooldowns * 2);
    reasons.push(`${cooldowns} model cooldown`);
  }
  if (四二九.total >= 5 && 四二九.ratio > 0.2) {
    score -= 15;
    reasons.push(`429 ${Math.round(四二九.ratio * 100)}% (15m)`);
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    level: score >= 80 ? "green" : score >= 50 ? "yellow" : "red",
    reasons,
    rate429: 四二九,
  };
}

function 快照(样本 = {}) {
  读事故();
  const now = Date.now();
  const inflight = [...在途.values()]
    .map((row) => ({
      ...row,
      ageMs: now - row.at,
      idleMs: now - row.lastEventAt,
      waitingFirstEvent: !row.egress,
    }))
    .sort((a, b) => a.at - b.at);
  const exits = [...出口表.values()]
    .map((row) => ({
      exit: row.exit,
      attempts: row.attempts,
      success: row.success,
      errors: row.errors,
      status429: row.status429,
      statusAbuse: row.statusAbuse,
      status5xx: row.status5xx,
      timeouts: row.timeouts,
      swaps: row.swaps,
      categories: { ...row.categories },
      lastUsedAt: row.lastUsedAt,
      lastError: row.lastError,
      p50FirstEvent: 分位(row.firstEventSamples, 0.5),
      p95FirstEvent: 分位(row.firstEventSamples, 0.95),
      firstEventCount: row.firstEventSamples.length,
    }))
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  const buckets = 首事件桶.map((上界, i) => {
    const 下界 = i === 0 ? -1 : 首事件桶[i - 1];
    const count = 首事件样本.filter((ms) => ms > 下界 && ms <= 上界).length;
    return { le: 上界 === Infinity ? "+Inf" : 上界, count };
  });
  return {
    requests: 请求.slice(-200).slice().reverse(),
    inflight,
    exits,
    errorCategories: (() => {
      const out = {};
      for (const row of 出口表.values()) {
        for (const [分类, n] of Object.entries(row.categories)) out[分类] = (out[分类] || 0) + n;
      }
      return out;
    })(),
    counters: {
      total: 计数.total,
      attempts: 计数.attempts,
      modelSwitches: 计数.modelSwitches,
      exitSwaps: 计数.exitSwaps,
      firstEvents: 计数.firstEvents,
      byStatus: Object.fromEntries(计数.byStatus),
      byModel: Object.fromEntries([...计数.byModel].sort((a, b) => b[1] - a[1]).slice(0, 20)),
      byOutcome: Object.fromEntries(计数.byOutcome),
    },
    firstEvent: {
      buckets,
      samples: 首事件样本.length,
      avg: 首事件样本.length ? Math.round(首事件样本.reduce((a, b) => a + b, 0) / 首事件样本.length) : null,
      p50: 分位(首事件样本, 0.5),
      p95: 分位(首事件样本, 0.95),
    },
    incidents: 事故.slice(-100).slice().reverse(),
    activeIncidents: [...活动事故.values()],
    health: 评分(样本),
    shapes: 形状.slice().reverse(),
  };
}

function 指标() {
  const lines = [
    "# HELP fucking_opencode_observatory_requests_total Requests started since process start.",
    "# TYPE fucking_opencode_observatory_requests_total counter",
    `fucking_opencode_observatory_requests_total ${计数.total}`,
    "# HELP fucking_opencode_observatory_attempts_total Upstream model attempts.",
    "# TYPE fucking_opencode_observatory_attempts_total counter",
    `fucking_opencode_observatory_attempts_total ${计数.attempts}`,
    "# HELP fucking_opencode_observatory_model_switches_total Model-group candidate switches.",
    "# TYPE fucking_opencode_observatory_model_switches_total counter",
    `fucking_opencode_observatory_model_switches_total ${计数.modelSwitches}`,
    "# HELP fucking_opencode_observatory_exit_swaps_total Egress swaps inside one request.",
    "# TYPE fucking_opencode_observatory_exit_swaps_total counter",
    `fucking_opencode_observatory_exit_swaps_total ${计数.exitSwaps}`,
    "# HELP fucking_opencode_observatory_inflight_requests Requests currently in flight.",
    "# TYPE fucking_opencode_observatory_inflight_requests gauge",
    `fucking_opencode_observatory_inflight_requests ${在途.size}`,
    "# HELP fucking_opencode_observatory_first_event_ms First-event latency buckets.",
    "# TYPE fucking_opencode_observatory_first_event_ms histogram",
  ];
  const bounds = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000];
  let cumulative = 0;
  for (const bound of bounds) {
    cumulative = 首事件样本.filter((ms) => ms <= bound).length;
    lines.push(`fucking_opencode_observatory_first_event_ms_bucket{le="${bound}"} ${cumulative}`);
  }
  lines.push(`fucking_opencode_observatory_first_event_ms_bucket{le="+Inf"} ${首事件样本.length}`);
  lines.push(`fucking_opencode_observatory_first_event_ms_sum ${首事件样本.reduce((a, b) => a + b, 0)}`);
  lines.push(`fucking_opencode_observatory_first_event_ms_count ${首事件样本.length}`);
  for (const [status, count] of 计数.byStatus) {
    lines.push(`fucking_opencode_observatory_responses_total{status="${status}"} ${count}`);
  }
  for (const row of 出口表.values()) {
    if (!row.attempts) continue;
    const label = String(row.exit).replace(/"/g, "");
    lines.push(`fucking_opencode_observatory_exit_attempts_total{exit="${label}"} ${row.attempts}`);
    lines.push(`fucking_opencode_observatory_exit_errors_total{exit="${label}",kind="429"} ${row.status429}`);
    lines.push(`fucking_opencode_observatory_exit_errors_total{exit="${label}",kind="abuse"} ${row.statusAbuse}`);
    lines.push(`fucking_opencode_observatory_exit_errors_total{exit="${label}",kind="5xx"} ${row.status5xx}`);
    lines.push(`fucking_opencode_observatory_exit_errors_total{exit="${label}",kind="timeout"} ${row.timeouts}`);
  }
  return lines.join("\n") + "\n";
}

function 清空() {
  const inflight = 在途.size;
  请求 = [];
  请求表 = new Map();
  出口表 = new Map();
  首事件样本 = [];
  事故 = [];
  活动事故 = new Map();
  形状 = [];
  for (const key of Object.keys(计数)) {
    if (计数[key] instanceof Map) 计数[key] = new Map();
    else 计数[key] = 0;
  }
  try {
    fs.unlinkSync(事故文件());
  } catch {}
  return { ok: true, inflightKept: inflight };
}

function __reset() {
  清空();
  事故载入 = false;
}

module.exports = {
  开始请求,
  尝试,
  出口事件,
  首事件,
  事件,
  结束,
  记录形状,
  采样,
  快照,
  评分,
  指标,
  清空,
  事故状态,
  最近比例,
  __reset,
};
