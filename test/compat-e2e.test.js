#!/usr/bin/env bun
/**
 * compat-e2e.test.js — 兼容路由端到端：起完整桥（真实端口 + 子进程内
 * mock 上游 fetch），验证 /v1/messages、/v1/responses、count_tokens、
 * /api/stats、/api/history 与 API key 门禁的完整链路。
 *
 * 端到端必须在真实 listen 的服务上跑：兼容路由的 桥内自调用 打
 * 127.0.0.1:PORT，mock 的 fetch 拦住出站上游调用。全部离线。
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-compat-e2e-"));
process.env.FUCKING_OPENCODE_STATE_DIR = tmpDir;
// module-level PORT stays different from the real listener so self-calls must use
// req.socket.localPort (not the configured PORT fallback) to reach this server.
process.env.PORT = "20313";
process.env.HOST = "127.0.0.1";
delete process.env.FUCKING_OPENCODE_API_KEYS;
delete process.env.FUCKING_OPENCODE_DEFAULT_MODEL;
// 离线：身份与目录绝不触网。
process.env.OPENCODE_OFFLINE = "1";

const srv = require("../server");
const identity = require("../identity");

const MODULE_PORT = Number(process.env.PORT);
let LISTEN_PORT = 0;
function request(method, urlPath, body, headers = {}, port = LISTEN_PORT) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          ...(payload !== null ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("兼容路由端到端", () => {
  let originalFetch;
  let server;
  before(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    originalFetch = global.fetch;
    // mock 上游：接受任何 chat/completions 调用，回固定 SSE 流。
    global.fetch = async (_url, init) => {
      const body = JSON.parse(init?.body || "{}");
      const text = body?.messages?.[0]?.content === "SAY_TOOL" ? "tool回复" : "你好，回复";
      const lines = [
        `data: {"choices":[{"index":0,"delta":{"reasoning":"想一想","content":"${text}"},"finish_reason":null}],"usage":null}\n\n`,
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n',
        "data: [DONE]\n\n",
      ];
      const encoder = new TextEncoder();
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream({
          start(c) {
            for (const l of lines) c.enqueue(encoder.encode(l));
            c.close();
          },
        }),
      };
    };
    identity.__reset();
    identity.__setLastCheckTime(Date.now());
    // 静态目录裁决：让测试模型是免费的。
    identity.applyRecipe({
      modelFacts: { "test-free": { reasoning: true, maxOutput: 8192 } },
      models: { "test-free": { cost: { input: 0, output: 0 } } },
    });
    srv.__resetProtocolLanes();
    await new Promise((resolve, reject) => {
      // 监听端口与模块 PORT 不同：兼容路由的桥内自调用必须使用请求实际端口。
      const handler = srv.__getHandler ? srv.__getHandler() : null;
      if (!handler) return reject(new Error("server handler unavailable"));
      server = require("node:http").createServer(handler);
      server.on("error", reject);
      server.listen(LISTEN_PORT, "127.0.0.1", () => {
        const addr = server.address();
        LISTEN_PORT = addr && typeof addr === "object" ? addr.port : LISTEN_PORT;
        resolve();
      });
    });
  });

  after(async () => {
    global.fetch = originalFetch;
    if (server) await new Promise((resolve) => server.close(resolve));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("POST /v1/messages 非流式：OpenAI 折成 Anthropic message + usage 记录", async () => {
    const r = await request("POST", "/v1/messages", {
      model: "test-free",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.type, "message");
    assert.equal(r.body.role, "assistant");
    assert.ok(r.body.content.some((b) => b.type === "text" && b.text.includes("你好")));
    assert.equal(r.body.stop_reason, "end_turn");
    assert.equal(r.body.usage.output_tokens, 7);
    // 统计已落盘。
    const s = JSON.parse((await request("GET", "/api/stats")).raw);
    assert.ok(s.total >= 1);
    const rec = (await request("GET", "/api/history?limit=5")).body.requests.find((x) => x.protocol === "anthropic");
    assert.ok(rec, "anthropic 记录应在历史里");
    assert.equal(rec.model, "test-free");
    assert.equal(rec.status, 200);
    assert.equal(rec.output_tokens, 7);
  });

  it("POST /v1/messages 流式：回 Anthropic 事件流", async () => {
    const r = await request("POST", "/v1/messages", {
      model: "test-free",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(r.status, 200);
    assert.ok(r.raw.includes("event: message_start"));
    assert.ok(r.raw.includes("event: content_block_delta"));
    assert.ok(r.raw.includes("text_delta"));
    assert.ok(r.raw.includes("event: message_stop"));
    assert.ok(r.raw.includes('"stop_reason":"end_turn"'));
  });

  it("POST /v1/responses 非流式：折成 response 对象", async () => {
    const r = await request("POST", "/v1/responses", {
      model: "test-free",
      instructions: "简短",
      input: "hello",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.object, "response");
    assert.equal(r.body.status, "completed");
    const msg = r.body.output.find((o) => o.type === "message");
    assert.ok(msg);
    assert.ok(msg.content[0].text.includes("你好"));
    assert.equal(r.body.usage.total_tokens, 18);
    const rec = (await request("GET", "/api/history?limit=5")).body.requests.find((x) => x.protocol === "responses");
    assert.ok(rec, "responses 记录应在历史里");
  });

  it("POST /v1/messages/count_tokens：纯本地估计，不触上游", async () => {
    const r = await request("POST", "/v1/messages/count_tokens", {
      model: "test-free",
      max_tokens: 10,
      messages: [{ role: "user", content: "abcd".repeat(25) }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.input_tokens, 25);
  });

  it("FUCKING_OPENCODE_API_KEYS 未设时不需要 key（本地工具默认开放）", async () => {
    const r = await request("POST", "/v1/messages", {
      model: "test-free",
      max_tokens: 10,
      messages: [{ role: "user", content: "x" }],
    });
    assert.notEqual(r.status, 401);
  });

  it("count_tokens 缺 model 也行（估算不依赖模型）", async () => {
    const r = await request("POST", "/v1/messages/count_tokens", {
      max_tokens: 5,
      messages: [{ role: "user", content: "1234" }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.input_tokens, 1);
  });

  it("上游 4xx 经兼容路由按 Anthropic 形状透传", async () => {
    const prevFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 404, headers: new Headers(), body: null, text: "Not Found" });
    try {
      const r = await request("POST", "/v1/messages", {
        model: "test-free",
        max_tokens: 10,
        messages: [{ role: "user", content: "x" }],
      });
      // 上游失败会在桥内重试后仍失败：兼容层把它折成 Anthropic error。
      assert.equal(r.body.type, "error");
      assert.ok(r.body.error);
    } finally {
      global.fetch = prevFetch;
    }
  });

  it("监听端口与 PORT 不同时，messages/responses/completions 仍可桥内自调用", async () => {
    assert.notEqual(LISTEN_PORT, MODULE_PORT);
    const m = await request("POST", "/v1/messages", {
      model: "test-free",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(m.status, 200);
    assert.equal(m.body.type, "message");
    const r = await request("POST", "/v1/responses", {
      model: "test-free",
      input: "hello",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.object, "response");
    const c = await request("POST", "/v1/completions", {
      model: "test-free",
      prompt: "hello",
      max_tokens: 10,
    });
    assert.equal(c.status, 200);
    assert.equal(c.body.object, "text_completion");
    assert.ok(Array.isArray(c.body.choices));
    assert.match(String(c.body.choices[0]?.text || ""), /你好/);
  });
});
