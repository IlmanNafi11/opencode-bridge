const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-failover-"));
process.env.FUCKING_OPENCODE_STATE_DIR = tmpDir;
process.env.FUCKING_OPENCODE_MODEL_GROUPS = JSON.stringify({
  sota: ["retired-free", "live-free"],
});

const { server, identity } = require("../server");

let originalFetch;
let port;

function sse(lines) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

function request(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data || "{}") }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("模型组上游故障回退", () => {
  before(async () => {
    originalFetch = global.fetch;
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.FUCKING_OPENCODE_STATE_DIR;
    delete process.env.FUCKING_OPENCODE_MODEL_GROUPS;
  });

  it("首个模型 404 时换用下一个并记录冷却", async () => {
    const 见到 = [];
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body || "{}");
      见到.push(body.model);
      if (body.model === "retired-free") {
        return {
          ok: false,
          status: 404,
          headers: new Headers(),
          text: async () =>
            JSON.stringify({ error: { type: "ModelDeprecated", message: "model retired" } }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: sse([
          'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":null}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };
    identity.__reset();
    identity.__setLastCheckTime(Date.now());

    const res = await request({
      model: "sota",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.model, "live-free");
    assert.deepEqual(见到, ["retired-free", "live-free"]);
    const health = JSON.parse(fs.readFileSync(path.join(tmpDir, "model-health.json"), "utf8"));
    assert.ok(health["retired-free"]);

    const diag = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/api/diagnostics?hours=24" }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      }).on("error", reject);
    });
    assert.equal(diag.status, 200);
    assert.ok(diag.body.egress.length >= 1);
    assert.ok(diag.body.models.some((m) => m.key === "live-free" && m.ok === 1));
    assert.equal(diag.body.cooldowns[0].model, "retired-free");
  });
});
