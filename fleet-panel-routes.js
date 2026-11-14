#!/usr/bin/env bun
/**
 * fleet-panel-routes.js：observabilitas fleet (Armada Cerdas / C2 Fase 5).
 *
 * `fleetStatus()` / `fleetEvents()` menyusun respons untuk endpoint
 * `/api/fleet/status` dan `/api/fleet/events` di server.js. Murni baca:
 * tidak menulis DB, tidak menyentuh proxy.json.
 *
 * Ringkasan kondisi:
 *   - `CRITICAL` : tidak ada node siap sama sekali.
 *   - `DEGRADED` : ada node siap, tapi ada node terdaftar yang tidak siap /
 *     sedang cooling.
 *   - `OK`       : semua node terdaftar siap (atau registry kosong, demi
 *     konsistensi; pool belum pernah diisi = netral, bukan bencana).
 */
const fleet = require("./fleet");
const orchestrator = require("./fleet-orchestrator");
// proxy 延迟 require：server.js 缺 proxy.js 时应由 加载本地模块 兜底，
// 顶层 require 会破坏 repairMissingModules 的启动契约（同 fleet-orchestrator.js）。

/** 接法 yang belum bisa ikut pool; konsisten dengan orchestrator 排除接法. */
const 排除接法 = new Set(["pending", "unknown", "relay-http", "warp"]);

/** cooling_until 是否仍在未来（未到期 = 暂缓入池）。 */
function 在冷却中(health) {
  if (!health || !health.cooling_until) return false;
  const until = Date.parse(health.cooling_until);
  return Number.isFinite(until) && until > Date.now();
}

function 节点是否就绪(node, health) {
  if (node.reachable !== true) return false;
  if (排除接法.has(String(node.connect_kind || "pending"))) return false;
  if (在冷却中(health)) return false;
  const spec = node.egress_spec && typeof node.egress_spec === "object" ? node.egress_spec : {};
  return String(spec.proxyUrl || "").trim() !== "";
}

/** quota_signals → { "<sig_type>": count, total } 只有 tipe yang benar-benar ada. */
function 计数配额(rows) {
  const bins = { total: 0 };
  for (const row of rows) {
    const type = String(row.sig_type || "unknown");
    bins[type] = (bins[type] || 0) + 1;
    bins.total += 1;
  }
  return bins;
}

function 摘要健康(rows) {
  return {
    ok: rows.filter((h) => h.ok).length,
    failed: rows.filter((h) => !h.ok).length,
    cooling: rows.filter((h) => 在冷却中(h)).length,
  };
}

/** Baca `proxy.js` (sumber kebenaran pool) untuk strategi + daftar exit aktif. */
function 池配置() {
  let proxy = null;
  try {
    proxy = require("./proxy");
  } catch {
    // proxy.js hilang (半安装)：source 未知，entry 不可知；不改 registry 的本职。
  }
  const described = proxy ? proxy.describe() : { mode: "direct", source: "none", locked: false, pool: {} };
  let entryCount = described.locked ? null : (described.pool && described.pool.size);
  if (entryCount === null || entryCount === undefined) {
    entryCount = typeof (described.pool && described.pool.size) === "number" ? described.pool.size : null;
  }
  return {
    mode: described.mode || "direct",
    strategy: orchestrator.默认策略(),
    entryCount,
    locked: Boolean(described.locked),
    source: described.source || null,
  };
}

/** Ringkasan kondisi pool: OK / DEGRADED / CRITICAL. */
function 条件环(nodeRows, healthMap) {
  const total = nodeRows.length;
  if (total === 0) return "OK";
  const ready = nodeRows.filter((n) => 节点是否就绪(n, healthMap.get(n.id))).length;
  if (ready === 0) return "CRITICAL";
  if (ready < total) return "DEGRADED";
  return "OK";
}

/** GET /api/fleet/status */
function fleetStatus() {
  const nodes = fleet.getNodes();
  const health = fleet.readHealthSummaries();
  const healthMap = new Map(health.map((h) => [h.node_id, h]));
  const signals = fleet.readQuotaSignals({ limit: 500 });

  return {
    ok: true,
    nodes,
    health,
    nodesReady: nodes.filter((n) => 节点是否就绪(n, healthMap.get(n.id))).length,
    nodesTotal: nodes.length,
    quotaSignalCounts: 计数配额(signals),
    poolConfig: 池配置(),
    lastAppliedAt: orchestrator.getLastAppliedAt(),
    summary: {
      condition: 条件环(nodes, healthMap),
      health: 摘要健康(health),
    },
  };
}

/** GET /api/fleet/events?nodeId=&action=&since=&limit= */
function fleetEvents({ nodeId = null, action = null, since = null, limit = 100 } = {}) {
  const events = fleet.readEvents({
    nodeId: nodeId || null,
    action: action || null,
    since: since || null,
    limit: Number.isFinite(Number(limit)) ? Number(limit) : 100,
  });
  return { ok: true, events, count: events.length };
}

module.exports = { fleetStatus, fleetEvents };