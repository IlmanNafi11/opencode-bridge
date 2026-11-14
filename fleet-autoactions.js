#!/usr/bin/env bun
/**
 * fleet-autoactions.js：舰队自动动作（Armada Cerdas / C2 可选层）。
 *
 * 每拍（节拍）只做三件事，全部受 env 开关：
 *   1. 冷却边沿通知 —— 一个节点刚进入 `node_health.cooling_until`（false→true）
 *      时推一次 webhook，之后冷却未解除不再重复推送。
 *   2. 池空通知 —— 没有节点可入池时推 critical。
 *   3. 扩容 —— `FLEET_AUTO_SCALE=1` 时，池空则激活一个备用节点
 *      （reachable=false 但接法就绪、有 proxyUrl）并重新 apply pool。
 *
 * 总闸 `FLEET_AUTO_ACTIONS=1` 才跑；与 autoheal.js 同款 ctx 注入（notify、
 * applyPool），失败只记录不抛错。绝不重新实现 proxy.js 的冷却/选择。
 */
const fleet = require("./fleet");

/** 这些接法绝不进 `proxy.json`：未就绪、本质 relay、或 farm 已自管。 */
const 排除接法 = new Set(["pending", "unknown", "relay-http", "warp"]);

/** 冷却边沿状态：按 DBPath 记上一拍正在冷却的 node，只在 false→true 边沿通报。 */
const 此前冷却表 = new Map();

function 启用() {
  return String(process.env.FLEET_AUTO_ACTIONS || "").trim() === "1";
}

function 扩容启用() {
  return String(process.env.FLEET_AUTO_SCALE || "").trim() === "1";
}

function 在冷却中(health) {
  if (!health || !health.cooling_until) return false;
  const until = Date.parse(health.cooling_until);
  return Number.isFinite(until) && until > Date.now();
}

/** 与 orchestrator 同口径：能拼成一条 proxy entry 的 node 才算"可用"。 */
function 可用节点(node, health) {
  const kind = String(node.connect_kind || "pending");
  if (排除接法.has(kind)) return false;
  if (node.reachable !== true) return false;
  if (在冷却中(health)) return false;
  const spec = node.egress_spec && typeof node.egress_spec === "object" ? node.egress_spec : {};
  return Boolean(String(spec.proxyUrl || "").trim());
}

async function 通报(ctx, key, text, level = "warn") {
  try {
    if (ctx && ctx.notify && typeof ctx.notify.发送 === "function") {
      await ctx.notify.发送(key, text, { level });
    } else if (ctx && typeof ctx.notify === "function") {
      await ctx.notify(text);
    }
  } catch {}
}

async function 应用池(ctx) {
  if (ctx && typeof ctx.applyPool === "function") {
    try {
      return await ctx.applyPool();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { ok: true };
}

/** 一轮自动动作；返回本轮动作，绝不抛错。ctx = { notify, applyPool }。 */
async function 节拍(ctx = {}) {
  if (!启用()) return { ok: true, enabled: false };

  const ready = fleet.initDB();
  if (!ready.ok) return ready;

  const key = fleet.DBPath();
  const nodes = fleet.getNodes();
  const healths = new Map(fleet.readHealthSummaries().map((h) => [h.node_id, h]));
  const 此前 = 此前冷却表.get(key) || new Set();
  const 现在 = new Set();
  const notified = [];

  // 1) 冷却边沿通报（false→true）。
  for (const node of nodes) {
    const health = healths.get(node.id);
    if (在冷却中(health)) {
      现在.add(node.id);
      if (!此前.has(node.id)) {
        const sig = String(health.quota_signal || "");
        await 通报(ctx, `fleet:cooldown:${node.id}`, `节点 ${node.label} 进入冷却${sig ? `（${sig}）` : ""}`, "warn");
        fleet.writeEvent({ nodeId: node.id, action: "cooldown", detail: "notified" });
        notified.push(`cooldown:${node.id}`);
      }
    }
  }
  此前冷却表.set(key, 现在);

  // 2) 池空判定 + 扩容/通报。
  const eligible = nodes.filter((n) => 可用节点(n, healths.get(n.id)));
  let scaled = false;
  if (eligible.length === 0) {
    if (扩容启用()) {
      // 备用：reachable=false 但接法就绪、有 proxyUrl 的节点。
      const standby = nodes.find((n) => {
        if (n.reachable !== false) return false;
        const spec = n.egress_spec && typeof n.egress_spec === "object" ? n.egress_spec : {};
        return !排除接法.has(String(n.connect_kind || "pending")) && Boolean(String(spec.proxyUrl || "").trim());
      });
      if (standby) {
        fleet.updateNode(standby.id, { reachable: true });
        fleet.writeEvent({ nodeId: standby.id, action: "enable", detail: "standby activated" });
        const applied = await 应用池(ctx);
        await 通报(ctx, `fleet:scale:${standby.id}`, `节点 ${standby.label} 已启用并应用进池`, "warn");
        notified.push(`scale:${standby.id}`);
        scaled = true;
        if (!applied.ok) {
          fleet.writeEvent({ nodeId: standby.id, action: "scale", detail: `pool apply gagal: ${applied.error || "unknown"}` });
        }
      }
    }
    if (!scaled) {
      await 通报(ctx, "fleet:pool-empty", "池 egress kosong：tidak ada node siap masuk pool", "critical");
      notified.push("pool-empty");
    }
  }

  return {
    ok: true,
    enabled: true,
    poolEmpty: eligible.length === 0 && !scaled,
    scaled,
    eligibleCount: eligible.length,
    notified,
  };
}

function __reset() {
  此前冷却表.clear();
}

module.exports = { 节拍, __reset };