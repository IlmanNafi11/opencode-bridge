#!/usr/bin/env bun
/**
 * fleet-orchestrator.js：egress 池编排（Armada Cerdas / C2 基础层）。
 *
 * applyToPool() 是舰队到 `proxy.js` 的唯一写入口：baca `nodes` + `node_health`
 * 的 registry，筛出能入池的 node（reachable、不在冷却、接法不是
 * pending/unknown/relay-http/warp），再合并 WARP farm 的 ready lane，最后
 * 通过 `proxy.setPool()` 落盘 `proxy.json`。绝不直接写 proxy.json。
 *
 * `proxy.js` 仍是 cooldown/失败的唯一真相源；这里只尊重 fleet 自己的
 * `node_health.cooling_until`（来自 kuota sinyal），不重实现代理冷却。
 */
const fleet = require("./fleet");
const proxy = require("./proxy");
const warpFarm = require("./warp-farm");

/** 这些接法绝不进 `proxy.json`：未就绪、本质 relay、或 farm 已自管。 */
const 排除接法 = new Set(["pending", "unknown", "relay-http", "warp"]);

/** pool 只接受这三种策略；照抄 proxy.js 的取值域，避免传给 setPool 非法值。 */
const 策略域 = new Set(["round-robin", "failover", "random"]);

function 默认策略() {
  const raw = String(process.env.FLEET_POOL_STRATEGY || "round-robin").trim().toLowerCase();
  return 策略域.has(raw) ? raw : "round-robin";
}

/** 环境变量锁了 pool 时，apply-pool 必须拒绝，绝不能悄悄覆盖运维意图。 */
function 环境锁() {
  const poolRaw = String(process.env.UPSTREAM_PROXY_POOL || "").trim();
  const singleRaw = String(process.env.UPSTREAM_PROXY_URL || "").trim();
  if (poolRaw || singleRaw) {
    return {
      ok: false,
      error: {
        message: "pool terkunci env (UPSTREAM_PROXY_POOL/UPSTREAM_PROXY_URL terisi)",
        type: "locked",
        code: "pool_env_locked",
      },
    };
  }
  return null;
}

/** node_health 按 node_id 建索引，供冷却判定一次查清。 */
function 健康索引() {
  return new Map(fleet.readHealthSummaries().map((h) => [h.node_id, h]));
}

/** cooling_until 是否仍在未来（未到期 = 暂缓入池）。 */
function 在冷却中(health) {
  if (!health || !health.cooling_until) return false;
  const until = Date.parse(health.cooling_until);
  return Number.isFinite(until) && until > Date.now();
}

/** ready 的 WARP lane → `warp-f<n>` 条目；与 warp-farm.js 的命名一致。 */
function farm条目(status) {
  const lanes = (status && Array.isArray(status.lanes) ? status.lanes : []).filter((lane) => lane && lane.ready);
  return lanes.map((lane) => ({
    id: `warp-f${lane.index}`,
    label: `warp-f${lane.index}`,
    url: lane.url,
    direct: false,
    enabled: true,
    weight: 1,
  }));
}

/**
 * 从 registry 重建 egress 池。
 *
 * @param {object} opts
 *   opts.farmStatus — 覆盖 `warpFarm.状态()`（测试注入）；缺省读真实 farm。
 * @returns {ok, entryCount, farmCount, strategy, nodeIds, farmIds, skipped}
 */
function applyToPool(opts = {}) {
  const locked = 环境锁();
  if (locked) return locked;

  const ready = fleet.initDB();
  if (!ready.ok) return ready;

  const nodes = fleet.getNodes();
  const healths = 健康索引();
  const 策略 = 默认策略();
  const skipped = [];

  const nodeEntries = [];
  const nodeIds = [];
  for (const node of nodes) {
    const kind = String(node.connect_kind || "pending");
    if (排除接法.has(kind)) {
      skipped.push({ nodeId: node.id, label: node.label, reason: kind });
      continue;
    }
    if (node.reachable !== true) {
      skipped.push({ nodeId: node.id, label: node.label, reason: "unreachable" });
      continue;
    }
    if (在冷却中(healths.get(node.id))) {
      skipped.push({ nodeId: node.id, label: node.label, reason: "cooling" });
      continue;
    }
    const spec = node.egress_spec && typeof node.egress_spec === "object" ? node.egress_spec : {};
    const url = String(spec.proxyUrl || "").trim();
    if (!url) {
      skipped.push({ nodeId: node.id, label: node.label, reason: "no_proxy_url" });
      continue;
    }
    nodeEntries.push({
      id: node.id,
      label: node.label,
      url,
      direct: false,
      enabled: true,
      weight: Number.isFinite(Number(node.weight)) && Number(node.weight) > 0 ? Number(node.weight) : 1,
    });
    nodeIds.push(node.id);
  }

  const farmStatus = opts.farmStatus !== undefined ? opts.farmStatus : warpFarm.状态();
  const farmEntries = farm条目(farmStatus);
  const farmIds = farmEntries.map((e) => e.id);

  const result = proxy.setPool({
    entries: [...nodeEntries, ...farmEntries],
    strategy: 策略,
  });
  if (!result.ok) return result;

  const summary = {
    ok: true,
    entryCount: nodeEntries.length + farmEntries.length,
    farmCount: farmEntries.length,
    nodeCount: nodeEntries.length,
    strategy: 策略,
    nodeIds,
    farmIds,
    skipped,
    lastAppliedAt: new Date().toISOString(),
  };
  console.log(
    `[fucking-opencode] fleet：pool diterapkan — ${summary.nodeCount} node + ${summary.farmCount} farm, strategi ${策略}`
  );
  return summary;
}

module.exports = { applyToPool, farm条目, 默认策略 };