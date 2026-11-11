const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-config-test-"));
const configFile = path.join(tmpDir, "config.json");
const PORT = 20382;
let config;
let child;

function 写配置(值) {
  fs.writeFileSync(configFile, JSON.stringify(值));
  const now = new Date();
  fs.utimesSync(configFile, now, now);
}

function request(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: urlPath, method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, raw: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("运行时配置", () => {
  before(() => {
    process.env.FUCKING_OPENCODE_STATE_DIR = tmpDir;
    process.env.FUCKING_OPENCODE_CONFIG = configFile;
    delete process.env.FUCKING_OPENCODE_DEFAULT_MODEL;
    delete process.env.UPSTREAM_TIMEOUT_MS;
    delete process.env.MAX_BODY_BYTES;
    delete process.env.AUTO_UPDATE;
    config = require("../config");
  });

  beforeEach(() => {
    delete process.env.FUCKING_OPENCODE_DEFAULT_MODEL;
    delete process.env.UPSTREAM_TIMEOUT_MS;
    delete process.env.MAX_BODY_BYTES;
    delete process.env.AUTO_UPDATE;
    config.__reload();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.FUCKING_OPENCODE_STATE_DIR;
    delete process.env.FUCKING_OPENCODE_CONFIG;
  });

  it("没有文件时使用默认值", () => {
    assert.equal(config.取("defaultModel"), "");
    assert.equal(config.取("upstreamTimeoutMs"), 120000);
    assert.equal(config.取("maxBodyBytes"), 10 * 1024 * 1024);
    assert.equal(config.取("autoUpdate"), true);
  });

  it("读取文件值并标注来源", () => {
    写配置({ defaultModel: "file-model", upstreamTimeoutMs: 30000, autoUpdate: false });
    const snap = config.__reload();
    assert.equal(config.取("defaultModel"), "file-model");
    assert.equal(snap.sources.defaultModel, "file");
    assert.equal(snap.sources.autoUpdate, "file");
  });

  it("环境变量覆盖文件", () => {
    写配置({ defaultModel: "file-model", upstreamTimeoutMs: 30000 });
    process.env.FUCKING_OPENCODE_DEFAULT_MODEL = "env-model";
    process.env.UPSTREAM_TIMEOUT_MS = "45000";
    const snap = config.快照();
    assert.equal(config.取("defaultModel"), "env-model");
    assert.equal(config.取("upstreamTimeoutMs"), 45000);
    assert.equal(snap.sources.defaultModel, "env");
  });

  it("拒绝越界数值但接受其余字段", () => {
    写配置({ defaultModel: "kept", upstreamTimeoutMs: 5 });
    const snap = config.__reload();
    assert.equal(config.取("defaultModel"), "kept");
    assert.equal(config.取("upstreamTimeoutMs"), 120000);
    assert.match(snap.error, /upstreamTimeoutMs/);
  });

  it("文件改动后不重启即生效", async () => {
    写配置({ defaultModel: "first-model" });
    assert.equal(config.__reload().values.defaultModel, "first-model");
    写配置({ defaultModel: "second-model" });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(config.取("defaultModel"), "second-model");
  });

  it("损坏的 JSON 保留上一份有效值", async () => {
    写配置({ defaultModel: "stable-model" });
    config.__reload();
    fs.writeFileSync(configFile, "{not json");
    const now = new Date();
    fs.utimesSync(configFile, now, now);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const snap = config.快照();
    assert.equal(config.取("defaultModel"), "stable-model");
    assert.match(snap.error, /JSON/);
  });

  it("通过 /api/config 暴露生效值与来源", async () => {
    写配置({ defaultModel: "route-model" });
    child = Bun.spawn([process.execPath, "server.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        FUCKING_OPENCODE_STATE_DIR: tmpDir,
        FUCKING_OPENCODE_CONFIG: configFile,
        OPENCODE_OFFLINE: "1",
        AUTO_UPDATE: "0",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        if ((await request("/health")).status === 200) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.ok(ready, "gateway did not become ready");
    const res = await request("/api/config");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.raw);
    assert.equal(body.values.defaultModel, "route-model");
    assert.equal(body.sources.autoUpdate, "env");
    child.kill();
    await child.exited;
    child = null;
  });

  it("写入合并文件并拒绝非法值", () => {
    写配置({ defaultModel: "old-model", upstreamTimeoutMs: 20000 });
    const ok = config.写入({ defaultModel: "new-model", autoUpdate: false });
    assert.equal(ok.ok, true);
    const onDisk = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(onDisk.defaultModel, "new-model");
    assert.equal(onDisk.upstreamTimeoutMs, 20000);
    assert.equal(onDisk.autoUpdate, false);
    assert.equal(config.取("defaultModel"), "new-model");

    const bad = config.写入({ upstreamTimeoutMs: 10 });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /upstreamTimeoutMs/);
    assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).defaultModel, "new-model");
  });
});
