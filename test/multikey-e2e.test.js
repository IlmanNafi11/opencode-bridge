const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-multikey-test-"));
const PORT = 20378;
let child;

function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: data }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await request("GET", "/health")).status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("gateway did not become ready");
}

function countTokens(key) {
  return request(
    "POST",
    "/v1/messages/count_tokens",
    { model: "test-free", max_tokens: 5, messages: [{ role: "user", content: "abcd" }] },
    key ? { authorization: `Bearer ${key}` } : {},
  );
}

describe("多个环境变量 API key", () => {
  before(async () => {
    child = Bun.spawn([process.execPath, "server.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        FUCKING_OPENCODE_STATE_DIR: tmpDir,
        FUCKING_OPENCODE_API_KEYS: "first-key-alpha,second-key-beta",
        OPENCODE_OFFLINE: "1",
        AUTO_UPDATE: "0",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitForHealth();
  });

  after(async () => {
    if (child) {
      child.kill();
      await child.exited;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("接受任意一个已登记的 key", async () => {
    assert.equal((await countTokens("first-key-alpha")).status, 200);
    assert.equal((await countTokens("second-key-beta")).status, 200);
  });

  it("拒绝缺失或错误的 key", async () => {
    assert.equal((await countTokens()).status, 401);
    assert.equal((await countTokens("unknown-key")).status, 401);
  });
});
