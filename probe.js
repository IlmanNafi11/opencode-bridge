#!/usr/bin/env bun
/**
 * probe.js：探测一个 egress 节点的可达性（Armada Cerdas / C2 基础层）。
 *
 * probeNode(node) 按 node.connect_kind 决定探测方式：
 *   - pending / unknown → 未就绪，不探、不写健康。
 *   - warp              → farm 侧车自管状态，这里跳过。
 *   - relay-http        → 直接 HTTP GET relay 的探测路径（serverless 不能 CONNECT）。
 *   - 其余（direct-proxy / ssh-reverse-tunnel / wireguard / tunnel-cf）
 *                       → 借 `proxy.testProxy` 走同一套出站机制。
 *
 * 结果经 `fleet.writeHealth` 落到 node_health；调用方（端点、健康循环）当它
 * 是纯函数，不自己拼 SQL。
 */
const fleet = require("./fleet");

/** connect_kind 属于"还没准备好/不该由探测把关"而非"探测失败"。 */
const 跳过类型 = new Set(["pending", "unknown", "warp"]);

/** 走 HTTP CONNECT 隧道邻居的接法：这些最终都喂同一个 proxyUrl。 */
const 代理接法 = new Set(["direct-proxy", "ssh-reverse-tunnel", "wireguard", "tunnel-cf"]);

const 默认超时 = 15000;

function parseSpec(node = {}) {
  const spec = node.egress_spec && typeof node.egress_spec === "object" ? node.egress_spec : {};
  return {
    proxyUrl: String(spec.proxyUrl || "").trim(),
    probePath: String(spec.probePath || "/").trim() || "/",
    timeoutMs: Number.isFinite(Number(spec.timeoutMs)) ? Number(spec.timeoutMs) : null,
  };
}

async function probeNode(node = {}, options = {}) {
  if (!node || !node.id) {
    return { ok: false, error: "node.id wajib diisi" };
  }
  const kind = String(node.connect_kind || "pending").trim();
  const spec = parseSpec(node);
  const timeoutMs = Number(options.timeoutMs) || spec.timeoutMs || 默认超时;

  if (kind === "pending" || kind === "unknown") {
    return { ok: false, error: `node masih ${kind} — belum bisa di-probe` };
  }
  if (kind === "warp") {
    return { ok: false, skipped: true, error: "warp 由 farm 侧车自管，跳过探测" };
  }

  if (kind === "relay-http") {
    return 探测Relay(node, spec, timeoutMs);
  }
  if (代理接法.has(kind)) {
    return 探测代理(node, spec, timeoutMs);
  }

  // 未识别的接法与空代理一样处理：不算可达，也不乱写健康。
  return { ok: false, error: `connect_kind 不识别: ${kind || "(kosong)"}` };
}

/** 代理型节点：复用 proxy.testProxy，让 SOCKS5 与 HTTPS 隧道走同一套出口。 */
async function 探测代理(node, spec, timeoutMs) {
  if (!spec.proxyUrl) {
    return { ok: false, error: "egress_spec.proxyUrl wajib diisi" };
  }
  let proxy;
  try {
    proxy = require("./proxy");
  } catch {
    return { ok: false, error: "proxy.js tidak tersedia — tidak bisa probe" };
  }
  const verdict = await proxy.testProxy(spec.proxyUrl, { timeoutMs });
  const result = {
    ok: verdict.ok === true,
    exitIp: verdict.exitIp || null,
    latencyMs: verdict.latencyMs == null ? null : Number(verdict.latencyMs),
    httpStatus: verdict.apiStatus != null ? Number(verdict.apiStatus) : null,
    error: verdict.error || null,
  };
  记录探测(node, result);
  return result;
}

/** relay-http 型节点：serverless 不能 CONNECT，只能 GET 探测路径。 */
async function 探测Relay(node, spec, timeoutMs) {
  if (!spec.proxyUrl) {
    return { ok: false, error: "egress_spec.proxyUrl wajib diisi (URL relay)" };
  }
  const relayUrl = spec.proxyUrl.replace(/\/+$/, "");
  const probePath = spec.probePath.startsWith("/") ? spec.probePath : `/${spec.probePath}`;
  const url = probePath ? `${relayUrl}${probePath}` : relayUrl;
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const result = { ok: false, exitIp: null, latencyMs: Date.now() - started, httpStatus: null, error: `relay tidak reachable: ${err.message}` };
    记录探测(node, result);
    return result;
  }
  const latencyMs = Date.now() - started;
  const result = {
    ok: res.ok,
    exitIp: null,
    latencyMs,
    httpStatus: res.status,
    error: res.ok ? null : `relay 返回 ${res.status}`,
  };
  记录探测(node, result);
  return result;
}

/**
 * 一次探测的完整落库：node_health 记健康，nodes 记可达性 —— 后者是池编排
 * 的唯一依据，probe 是唯一知道结论的地方。探测成功同时盖 last_heartbeat_at
 * （节点从不 push，心跳就是"最近一次被探到"）；失败把 reachable 降为 false，
 * 让 apply-pool 立刻跳过死节点，不必等冷却或人工改 registry。
 */
function 记录探测(node, result) {
  fleet.writeHealth({ nodeId: node.id, ...result });
  const patch = result.ok ? { reachable: true, last_heartbeat_at: new Date().toISOString() } : { reachable: false };
  fleet.updateNode(node.id, patch);
}

module.exports = { probeNode };
