#!/usr/bin/env bun
/**
 * verify.js — fucking-opencode 自检。
 *
 * 回答新用户唯一的问题："这东西到底能不能用？"
 *
 *   bun verify.js          全量检查：每个发现的模型、真实提示
 *   bun verify.js --quick  每个模型一次探测，更快
 *
 * 至少一个模型应答则退出码 0，否则 1 —— 可以接进 CI 或装后步骤。
 *
 * 上游对单个模型限流（HTTP 429，"Endpoint is unavailable"），所以单次失败
 * 不是致命的 —— 汇总把"被限流"与"坏了"分开，退出码只取决于是否有任何东西
 * 成功。
 */

const http = require("http");

const PORT = parseInt(process.env.PORT || "20134", 10);
const RAW_HOST = process.env.HOST || "127.0.0.1";
const HOST = RAW_HOST === "0.0.0.0" || RAW_HOST === "::" ? "127.0.0.1" : RAW_HOST;
const BASE = `http://${HOST}:${PORT}`;
const QUICK = process.argv.includes("--quick");

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};
const ok = (s) => `${C.green}${s}${C.reset}`;
const warn = (s) => `${C.yellow}${s}${C.reset}`;
const bad = (s) => `${C.red}${s}${C.reset}`;

/**
 * 把桥发出的 SSE 流折叠成一个 Chat Completions 对象。
 *
 * 只重建结论逻辑要读的字段：`choices[0].message`（content 与
 * reasoning_content）和 `usage`。就绪探测不需要工具调用增量，所以忽略而不
 * 重建。
 */
function assembleSse(raw) {
  let content = "";
  let reasoning = "";
  let finish = null;
  let usage = null;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const chunk = line.slice(5).trim();
    if (!chunk || chunk === "[DONE]") continue;
    let ev = null;
    try { ev = JSON.parse(chunk); } catch { continue; }
    // 桥把流内失败作为 SSE error 事件转发。
    if (ev?.error) return { error: ev.error };
    const choice = ev?.choices?.[0];
    if (choice?.delta?.content) content += choice.delta.content;
    if (choice?.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (ev?.usage) usage = ev.usage;
  }
  return {
    choices: [{ message: { role: "assistant", content, reasoning_content: reasoning }, finish_reason: finish }],
    usage,
  };
}

function request(method, path, body, timeoutMs = QUICK ? 25000 : 120000) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* 非 JSON 响应体 */ }
          // 桥对上游总是流式，所以 `stream: true` 的探测回来是 SSE。把它折成
          // 非流式调用同形的结构，下面的结论逻辑只读一种形态。
          if (!parsed && /^\s*data:/.test(data)) parsed = assembleSse(data);
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
        });
      }
    );
    req.on("error", (err) => resolve({ status: 0, error: err.code || err.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    if (payload) req.write(payload);
    req.end();
  });
}

// 推理模型回答前需要思考空间。与 token-budget.js 强制的下限一致，让检查走
// 真实路径。
const PROBE_MAX_TOKENS = QUICK ? 50 : 2000;

async function 检查健康() {
  const res = await request("GET", "/health", null, 10000);
  if (res.status !== 200 || !res.body) {
    return { ok: false, detail: res.error || `HTTP ${res.status}` };
  }
  return {
    ok: true,
    version: res.body.version,
    runtime: res.body.runtime || null,
    models: res.body.discoveredModels,
    egress: res.body.egress || null,
  };
}

async function 列模型() {
  const res = await request("GET", "/v1/models", null, 15000);
  if (res.status !== 200 || !res.body?.data) return [];
  return res.body.data.map((m) => m.id);
}

async function 探测(model) {
  const started = Date.now();
  // `stream: true` 不是装饰。同一 IP、同一进程、同一组请求头实测：不带
  // `stream` 的上游请求被 403 FreeTierError 拒绝，而带 `stream: true` 的同一
  // 请求成功（交错执行 6/6 对 0/6）。上游把非流式调用当作"不是真客户端"。
  // 省略它的探测什么也测不出来，还会把 IP 报成被封。桥对上游总是流式，并
  // 为非流式客户端把 SSE 归一回 JSON，所以这里与桥的真实发送一致。
  const res = await request("POST", "/v1/chat/completions", {
    model,
    messages: [{ role: "user", content: QUICK ? "Say OK" : "Write a Python function `add(a,b)` that returns their sum. Output only code." }],
    max_tokens: PROBE_MAX_TOKENS,
    stream: true,
  });
  const ms = Date.now() - started;

  if (res.status === 429) return { state: "ratelimited", ms };
  if (res.status === 403) {
    const msg = String(res.body?.error?.message || res.error || "");
    // 桥给拒绝打了标签，结论不依赖上游随时会改的说法：
    //   ip-throttled   该 IP 的免费额度用完
    //   ip-abuse       网关标记了这个网络（滥用流量）
    //   shape-rejected 桥构造了网关拒绝的请求形状（真故障）
    // 两种 IP 状态都是上游拒绝，不是安装坏了，所以共用 GATE 状态与退出码 2。
    const gate = String(res.headers?.["x-opencode-gate"] || "");
    if (gate === "shape-rejected") {
      return { state: "failed", ms, detail: `gate rejected the gateway's request shape: ${msg.slice(0, 70)}` };
    }
    if (
      gate === "ip-throttled" ||
      gate === "ip-abuse" ||
      /free tier can only be used|free models aren[’']t available|abusive traffic|abuse traffic|abuse of traffic|FreeTierError/i.test(msg)
    ) {
      return { state: "gate-closed", ms, detail: String(msg).slice(0, 90) };
    }
  }
  if (res.status === 426) {
    const msg = res.body?.error?.message || res.error || "HTTP 426";
    return { state: "upgrade-required", ms, detail: String(msg).slice(0, 90) };
  }
  if (res.status !== 200) {
    const msg = res.body?.error?.message || res.error || `HTTP ${res.status}`;
    return { state: "failed", ms, detail: String(msg).slice(0, 70) };
  }

  const message = res.body?.choices?.[0]?.message;
  const content = (message?.content || "").trim();
  const reasoning = (message?.reasoning_content || "").trim();

  if (!content && reasoning) {
    return { state: "thinking-only", ms, detail: `${reasoning.length} 字符的推理，无答案` };
  }
  if (!content) return { state: "empty", ms };
  return { state: "ok", ms, chars: content.length, outTokens: res.body?.usage?.completion_tokens };
}

(async () => {
  console.log(`\n${C.bold}fucking-opencode — 自检${C.reset}`);
  console.log(`${C.dim}${BASE}${C.reset}\n`);

  const health = await 检查健康();
  if (!health.ok) {
    console.log(`  ${bad("FAIL")} 桥不可达：${health.detail}`);
    console.log(`\n  先启动它：    ${C.cyan}bun server.js${C.reset}`);
    console.log(`  或安装它：    ${C.cyan}bash install.sh${C.reset}\n`);
    process.exit(1);
  }
  console.log(`  ${ok("OK")}  桥 v${health.version}，发现 ${health.models} 个免费模型\n`);
  // 上游将看到的 IP。额度被拒往往是代理问题，所以在怪上游之前先说流量从哪
  // 里出去。
  const egress = health.egress;
  if (egress) {
    const label =
      egress.mode === "proxy"
        ? `代理 ${egress.proxy?.proxy || "(已配置)"}`
        : egress.mode === "relay"
          ? `中继 ${egress.relay || "(已配置)"}`
          : "直连（本机 IP）";
    console.log(`  ${C.dim}出口：${label}${C.reset}\n`);
  }

  const models = await 列模型();
  if (models.length === 0) {
    console.log(`  ${warn("WARN")} /v1/models 没有列出模型 —— 上游可能不可达`);
    console.log(`  ${C.dim}等发现完成后再试${C.reset}\n`);
    process.exit(1);
  }

  // --quick 只回答一个问题：这座桥现在能用吗？第一个应答的模型就定了。上游
  // 限流时把九个模型全探一遍每个最多等 120s，曾让 `install.sh` 像挂了几分
  // 钟。
  const toProbe = QUICK ? models.slice(0, 3) : models;
  console.log(
    `  正在探测 ${toProbe.length}${QUICK && models.length > toProbe.length ? " / 共 " + models.length : ""} 个模型${
      QUICK ? "（quick —— 首个成功即停）" : ""
    }...\n`
  );
  const results = [];
  for (const model of toProbe) {
    const r = await 探测(model);
    results.push({ model, ...r });
    const time = `${(r.ms / 1000).toFixed(1)}s`.padStart(6);
    if (r.state === "ok") {
      console.log(`  ${ok("OK")}   ${model.padEnd(36)} ${time}  ${C.dim}${r.chars} 字符，${r.outTokens} 令牌${C.reset}`);
    } else if (r.state === "ratelimited") {
      console.log(`  ${warn("BUSY")} ${model.padEnd(36)} ${time}  ${C.dim}上游限流，稍后重试${C.reset}`);
    } else if (r.state === "gate-closed") {
      console.log(`  ${warn("GATE")} ${model.padEnd(36)} ${time}  ${C.dim}上游拒绝此 IP（额度耗尽或滥用封锁）${C.reset}`);
    } else if (r.state === "upgrade-required") {
      console.log(`  ${bad("UPGR")} ${model.padEnd(36)} ${time}  ${C.dim}${r.detail}${C.reset}`);
    } else if (r.state === "thinking-only") {
      console.log(`  ${bad("THINK")} ${model.padEnd(36)} ${time}  ${C.dim}${r.detail}${C.reset}`);
    } else if (r.state === "empty") {
      console.log(`  ${bad("EMPTY")} ${model.padEnd(36)} ${time}`);
    } else {
      console.log(`  ${bad("FAIL")} ${model.padEnd(36)} ${time}  ${C.dim}${r.detail}${C.reset}`);
    }
    if (QUICK && r.state === "ok") break;
    // 429 额度按 IP 计：对着被限流的节点继续打剩下的模型只会延长惩罚窗口
    // —— 与 gate-closed 同一权衡。
    if (r.state === "gate-closed") break;
    if (r.state === "ratelimited") break;
  }

  const counts = results.reduce((acc, r) => ((acc[r.state] = (acc[r.state] || 0) + 1), acc), {});
  const usable = counts.ok || 0;
  const blocked = (counts["gate-closed"] || 0) + (counts.ratelimited || 0);
  const broken = (counts["thinking-only"] || 0) + (counts.empty || 0) + (counts.failed || 0) + (counts["upgrade-required"] || 0);

  console.log(`\n${C.bold}汇总${C.reset}`);
  console.log(`  ${ok(String(usable))} 可用，${blocked} 被上游挡住（gate-closed ${counts["gate-closed"] || 0}，限流 ${counts.ratelimited || 0}），${broken} 坏`);

  if (usable > 0) {
    console.log(`\n  ${ok("桥工作正常。")}把任何 OpenAI 兼容客户端指向 ${C.cyan}${BASE}/v1${C.reset}\n`);
    process.exit(0);
  }

  if (blocked > 0 && broken === 0) {
    if (counts["gate-closed"] > 0) {
      if (typeof health.runtime === "string" && health.runtime.startsWith("node/")) {
        console.log(`\n  ${bad("Server is running on Node.js, not Bun.")}`);
        console.log(`  ${C.dim}桥上报的运行时是 ${health.runtime}。上游用 403 FreeTierError 拒绝 Node 的 TLS ClientHello。${C.reset}`);
        console.log(`  ${C.dim}用 Bun 重启桥：${C.reset}${C.cyan}bun server.js${C.reset}\n`);
        process.exit(1);
      }
      if (process.versions.bun) {
        let tlsDrift = null;
        try {
          const fs = require("fs");
          const path = require("path");
          const basePath = path.join(__dirname, "transport-baseline.json");
          if (fs.existsSync(basePath)) {
            const { capture, describe } = require("./transport-fingerprint");
            const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
            const now = describe(await capture());
            const sameCiphers = JSON.stringify(base.ciphers) === JSON.stringify(now.ciphers);
            const sameExts = JSON.stringify(base.extensions) === JSON.stringify(now.extensions);
            if (!sameCiphers || !sameExts) tlsDrift = { now, base };
          }
        } catch {}
        if (tlsDrift) {
          console.log(`\n  ${bad("TLS fingerprint drift detected.")}`);
          console.log(`  ${C.dim}当前 Bun 运行时（${tlsDrift.now.runtime}）与记录的 OpenCode CLI 基线（${tlsDrift.base.runtime}）不一致。${C.reset}`);
          console.log(`  ${C.dim}检查：${C.reset}${C.cyan}bun transport-fingerprint.js --check${C.reset}\n`);
          process.exit(1);
        }
      }
    }
    // 退出码 2 刻意区别于 1：安装是对的，只是这个 IP 现在没被放行。安装器
    // 与 CI 靠它区分两者。
    console.log(`\n  ${warn("桥健康，但上游拒绝了这个 IP。")}`);
    console.log(`  ${C.dim}网关对每次探测都以它自己的免费档拒绝作答，不是桥的错误。${C.reset}`);
    console.log(`  ${C.dim}官方 OpenCode CLI 此刻从同一网络会得到同样答案。${C.reset}`);
    console.log(`  ${C.dim}如果消息提到 abusive traffic，说明该网络被标记：发邮件 help@anoma.ly；只有上游能解除。${C.reset}`);
    console.log(`  ${C.dim}否则等额度窗口重置，或换一台主机跑桥。${C.reset}`);
    console.log(`  ${C.dim}稍后复查：${C.reset}${C.cyan}bun verify.js --quick${C.reset}\n`);
    process.exit(2);
  }

  console.log(`\n  ${bad("没有任何模型应答。")}`);
  console.log(`  ${C.dim}查桥的日志看上游错误，然后重试。${C.reset}\n`);
  process.exit(1);
})();
