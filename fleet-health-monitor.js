#!/usr/bin/env bun
/**
 * fleet-health-monitor.js：armada 健康循环（Armada Cerdas / C2）。
 *
 * start/stop 管一个 `setInterval(...).unref()` 的定时器；runOnce 是单轮节拍
 * （也供 /api/fleet/health-monitor 手动触发）。跟 proxy.js 冷却不同，这里的
 * 冷却按 node 记录，触发来自 probe 观察到的 429/403/kata kuota —— probe 只
 * "看到"，真正的失败记录优先来自 request nyata（Task 6 的 hook）。
 */
const fleet = require("./fleet");
const 探针 = require("./probe");

const 默认间隔毫秒 = Number(process.env.FLEET_PROBE_INTERVAL_MS || 300000);
const 冷却基数毫秒 = Number(process.env.FLEET_COOLDOWN_BASE_MS || 120000);

const 间隔类型 = new Set(["pending", "unknown", "warp"]);
let 定时器 = null;
let 上次运行 = null;

/**
 * 映射 HTTP status + error text 到 quota_signal 语义，只取最明显的那个。
 * 优先 ip-abuse > free-tier > capacity > quota，再退回数字状态码本身。
 */
function 判断信号(status, errorText) {
  if (status == null && !errorText) return null;
  const text = String(errorText || "");
  if (status === 403 && /ip[- ]?abuse/i.test(text)) return "ip-abuse";
  if (/free.?tier|only available in/i.test(text)) return "free-tier";
  if (/capacity/i.test(text)) return "capacity";
  if (/quota|kuota|exceed/i.test(text)) return "quota";
  if (status === 429) return "429";
  if (status === 403) return "403";
  return null;
}

/** 一轮探测所有 reachable & 非 skip 的 node；探到 sinyal kuota时 set cooldown。 */
async function runOnce() {
  try {
    const ready = fleet.initDB();
    if (!ready.ok) return ready;
  } catch (err) {
    return { ok: false, error: { message: `initDB gagal: ${err.message}`, type: "sqlite", code: "init_failed" } };
  }

  const nodes = fleet
    .getNodes()
    .filter((n) => n.reachable !== false && !间隔类型.has(String(n.connect_kind || "")));
  const results = [];
  for (const node of nodes) {
    const verdict = await 探针.probeNode(node);
    const row = { nodeId: node.id, ...verdict };
    const sig = 判断信号(verdict.httpStatus, verdict.error);
    if (sig) {
      fleet.writeQuotaSignal({ nodeId: node.id, label: node.label, sigType: sig });
      // Cooldown 是"这个 node 暂缓入池"的下一个节拍信号；probe 观测到的信号
      // 只加强 request nyata 的结论。writeHealth 的 COALESCE 保留已存在的
      // 冷却，probe 不覆盖更早的有效冷却。
      const 冷却至 = new Date(Date.now() + 冷却基数毫秒).toISOString();
      fleet.writeHealth({
        nodeId: node.id,
        coolingUntil: 冷却至,
        quotaSignal: sig,
        blockBasedOnQuota: true,
      });
      row.quotaSignal = sig;
    }
    results.push(row);
  }
  上次运行 = new Date().toISOString();
  return { ok: true, scanned: nodes.length, results, lastRunAt: 上次运行 };
}

function start(intervalMs) {
  if (定时器) stop();
  const ms = intervalMs === undefined ? 默认间隔毫秒 : intervalMs;
  if (ms <= 0) {
    // pengujian/panggil manual: jangan buat timer yang segera loop.
    return { ok: true, intervalMs: ms };
  }
  const timer = setInterval(() => {
    runOnce().catch((err) => {
      console.warn(`[fucking-opencode] fleet health monitor gagal: ${err.message}`);
    });
  }, ms);
  if (typeof timer.unref === "function") timer.unref();
  定时器 = timer;
  return { ok: true, intervalMs: ms };
}

function stop() {
  if (定时器) {
    clearInterval(定时器);
    定时器 = null;
  }
  return { ok: true };
}

module.exports = { start, stop, runOnce, 判断信号, lastRunAt: () => 上次运行 };