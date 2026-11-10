const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

// 独立子进程：server.js 在模块加载时读取 PORT/状态目录等环境变量，共享进程
// 里改 env 会串到别的测试文件（例如 compat-e2e 的模型目录），所以这里隔离运行。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-auth-test-"));
const PORT = 20377;

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
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await request("GET", "/health");
      if (res.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("gateway did not become ready");
}

describe("panel login", () => {
  before(async () => {
    child = Bun.spawn([process.execPath, "server.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        PANEL_PASSWORD: "test-secret",
        FUCKING_OPENCODE_STATE_DIR: tmpDir,
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

  it("serves the login page instead of the panel without a session", async () => {
    const page = await request("GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.raw, /id="login-form"/);
    assert.doesNotMatch(page.raw, /id="proxy-url"/);
  });

  it("keeps health open but gates panel data APIs", async () => {
    assert.equal((await request("GET", "/health")).status, 200);
    assert.equal((await request("GET", "/api/proxy")).status, 401);
    assert.equal((await request("GET", "/api/stats")).status, 401);
  });

  it("rejects a wrong password and accepts the configured one", async () => {
    const wrong = await request("POST", "/api/login", { password: "nope" });
    assert.equal(wrong.status, 401);

    const ok = await request("POST", "/api/login", { password: "test-secret" });
    assert.equal(ok.status, 200);
    assert.match(String(ok.headers["set-cookie"]), /^ofb_panel=[a-f0-9]{64};/);
    assert.match(String(ok.headers["set-cookie"]), /HttpOnly/);
  });

  it("allows the panel and data APIs with a valid session, then revokes on logout", async () => {
    const login = await request("POST", "/api/login", { password: "test-secret" });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];

    const page = await request("GET", "/", undefined, { cookie });
    assert.equal(page.status, 200);
    assert.match(page.raw, /id="proxy-url"/);

    assert.equal((await request("GET", "/api/proxy", undefined, { cookie })).status, 200);

    assert.equal((await request("POST", "/api/logout", undefined, { cookie })).status, 200);
    assert.equal((await request("GET", "/api/proxy", undefined, { cookie })).status, 401);
  });

  it("refuses non-JSON login requests", async () => {
    assert.equal((await request("POST", "/api/login", undefined, { "Content-Type": "text/plain" })).status, 415);
  });
});
