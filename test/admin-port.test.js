const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { 启动子进程 } = require("./spawn-helper");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-admin-port-"));
const PORT = 20380;
const ADMIN_PORT = 20381;
let child;
function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await request(PORT, "GET", "/health")).status === 200) {
        if ((await request(ADMIN_PORT, "GET", "/health")).status === 200) return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("gateway did not become ready");
}

describe("管理端口与 API 端口分离", () => {
  before(async () => {
    child = 启动子进程([process.execPath, "server.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        PORT: String(PORT),
        ADMIN_PORT: String(ADMIN_PORT),
        HOST: "127.0.0.1",
        FUCKING_OPENCODE_STATE_DIR: tmpDir,
        PANEL_PASSWORD: "admin-port-secret",
        OPENCODE_OFFLINE: "1",
        AUTO_UPDATE: "0",
        ALLOW_NODE: "1",
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

  it("把面板根路径重定向到管理端口", async () => {
    const res = await request(PORT, "GET", "/");
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `http://127.0.0.1:${ADMIN_PORT}/`);
  });

  it("主端口拒绝面板 API", async () => {
    const res = await request(PORT, "GET", "/api/proxy");
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.raw).error.code, "admin_port_only");
  });

  it("管理端口拒绝推理路由但保留模型清单", async () => {
    const chat = await request(ADMIN_PORT, "POST", "/v1/chat/completions", {
      model: "test-free",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(chat.status, 404);
    assert.equal(JSON.parse(chat.raw).error.code, "api_port_only");
    assert.equal((await request(ADMIN_PORT, "GET", "/v1/models")).status, 200);
  });

  it("两个端口都能读健康检查", async () => {
    assert.equal((await request(PORT, "GET", "/health")).status, 200);
    assert.equal((await request(ADMIN_PORT, "GET", "/health")).status, 200);
  });

  it("在管理端口完成面板登录并读取设置", async () => {
    const login = await request(ADMIN_PORT, "POST", "/api/login", { password: "admin-port-secret" });
    assert.equal(login.status, 200);
    const cookie = String(login.headers["set-cookie"] || "").split(";")[0];
    assert.match(cookie, /^ofb_panel=/);
    const settings = await request(ADMIN_PORT, "GET", "/api/settings", undefined, { Cookie: cookie });
    assert.equal(settings.status, 200);
    assert.ok(Array.isArray(JSON.parse(settings.raw).apiKeys));
  });
});
