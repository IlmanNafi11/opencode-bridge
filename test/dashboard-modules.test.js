const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-dash-"));
const prevStateDir = process.env.FUCKING_OPENCODE_STATE_DIR;
const prevConfigPath = process.env.FUCKING_OPENCODE_CONFIG;
process.env.FUCKING_OPENCODE_STATE_DIR = dir;
process.env.FUCKING_OPENCODE_CONFIG = path.join(dir, "config.json");

const { after: afterAll } = require("node:test");

const obs = require("../observability");
const notify = require("../notify");
const diagnostics = require("../diagnostics");
const selftest = require("../selftest");
const ops = require("../ops");
const config = require("../config");
const dashboardApi = require("../dashboard-api");

afterEach(() => {
  if (typeof obs.__reset === "function") obs.__reset();
  if (typeof notify.__reset === "function") notify.__reset();
  if (typeof ops.__reset === "function") ops.__reset();
});

afterAll(() => {
  if (prevStateDir === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
  else process.env.FUCKING_OPENCODE_STATE_DIR = prevStateDir;
  if (prevConfigPath === undefined) delete process.env.FUCKING_OPENCODE_CONFIG;
  else process.env.FUCKING_OPENCODE_CONFIG = prevConfigPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body ? String(body) : "";
    },
  };
}

describe("observability", () => {
  it("tracks a request end to end with attempts, exit swaps and first event", () => {
    const rec = obs.开始请求("req-1", { model: "m", protocol: "openai", stream: true });
    assert.ok(rec);
    obs.尝试("req-1", "model-a");
    obs.出口事件("req-1", { exit: "warp-f1", action: "attempt" });
    obs.首事件("req-1", 120, "warp-f1");
    obs.出口事件("req-1", { exit: "warp-f1", action: "fail", reason: "429 quota" });
    obs.出口事件("req-1", { exit: "warp-f1", action: "swap", reason: "429 quota" });
    obs.出口事件("req-1", { exit: "warp-f2", action: "success" });
    obs.结束("req-1", { status: 200, ms: 900 });
    const snap = obs.快照({});
    const row = snap.requests.find((r) => r.id === "req-1");
    assert.equal(row.status, 200);
    assert.equal(row.firstEventMs, 120);
    assert.equal(row.attempts.length, 1);
    assert.equal(row.exitSwaps, 1);
    const exit = snap.exits.find((e) => e.exit === "warp-f1");
    assert.equal(exit.status429, 1);
    assert.equal(exit.swaps, 1);
    assert.equal(exit.p50FirstEvent, 120);
  });

  it("scores health from lane readiness and gate state", () => {
    const healthy = obs.评分({ farm: { lanes: [{ ready: true }, { ready: true }] }, gate: { status: "open" } });
    assert.equal(healthy.score, 100);
    const broken = obs.评分({ farm: { lanes: [{ ready: false }] }, gate: { status: "ip-blocked" } });
    assert.ok(broken.score < 50);
    assert.ok(broken.reasons.some((r) => r.includes("ip-abuse")));
  });

  it("exposes a prometheus payload", () => {
    obs.开始请求("req-2", { model: "m" });
    obs.结束("req-2", { status: 200, ms: 50 });
    const text = obs.指标();
    assert.match(text, /fucking_opencode_observatory_requests_total/);
    assert.match(text, /fucking_opencode_observatory_first_event/);
  });
});

describe("notify", () => {
  it("sends through the injected fetch and dedupes repeated alerts", async () => {
    const sent = [];
    notify.设置网络请求(async (url, init) => {
      sent.push({ url, body: init && init.body });
      return { ok: true, status: 204 };
    });
    process.env.NOTIFY_WEBHOOK_URL = "https://example.test/hook";
    notify.__reset();
    const first = await notify.发送("test-1", "boom");
    const second = await notify.发送("test-1", "boom");
    assert.equal(first.ok, true);
    assert.equal(second.skipped, true);
    assert.equal(sent.length, 1);
    delete process.env.NOTIFY_WEBHOOK_URL;
  });

  it("reports disabled when no webhook is configured", async () => {
    delete process.env.NOTIFY_WEBHOOK_URL;
    const res = await notify.发送("test-2", "x");
    assert.equal(res.ok, false);
    assert.equal(res.skipped, true);
    assert.match(res.error, /NOTIFY_WEBHOOK_URL/);
  });
});

describe("diagnostics", () => {
  it("builds a zip and redacts tokens and prompts", () => {
    const bundle = diagnostics.构建({
      收集: () => ({
        health: { version: "0.1.6" },
        config: { values: { defaultModel: "m" } },
        auth: { token: "secret-token-value", apiKey: "sk-abcdef123456" },
        request: { messages: [{ role: "user", content: "rahasia prompt" }] },
      }),
    });
    assert.ok(bundle.filename.endsWith(".zip"));
    assert.equal(bundle.bytes[0], 0x50);
    assert.equal(bundle.bytes[1], 0x4b);
    assert.ok(bundle.files.length >= 2);
    const json = bundle.files.map((f) => String(f.text || "")).join("\n");
    assert.equal(json.includes("secret-token-value"), false);
    assert.equal(json.includes("rahasia prompt"), false);
  });

  it("redacts nested secrets in text", () => {
    const text = diagnostics.去敏文本('Authorization: Bearer abcdef123456\napi_key=sk-1234567890');
    assert.equal(text.includes("abcdef123456"), false);
    assert.equal(text.includes("sk-1234567890"), false);
  });
});

describe("selftest", () => {
  it("lists the offline/runtime checks", () => {
    const list = selftest.列表();
    assert.ok(list.length >= 2);
    assert.ok(list.every((row) => row.id && row.title));
  });
});

describe("ops", () => {
  it("enables and disables safe mode with an auto-off deadline", () => {
    const on = ops.开启({ minutes: 5, singleLane: true, noRotation: true });
    assert.equal(on.enabled, true);
    assert.ok(on.until > Date.now());
    const effective = ops.生效();
    assert.equal(effective.noRotation, true);
    const off = ops.关闭();
    assert.equal(off.enabled, false);
    assert.equal(ops.生效().noRotation, false);
  });

  it("persists maintenance settings and reports readiness", () => {
    const saved = ops.保存维护({ enabled: true, intervalHours: 2, quietFrom: "01:00", quietTo: "03:00", rotateOnAbuse: false });
    assert.equal(saved.ok, true);
    assert.equal(ops.维护状态().enabled, true);
    assert.equal(ops.维护状态().intervalHours, 2);
    assert.equal(ops.维护状态().quietFrom, "01:00");
    assert.equal(ops.维护状态().rotateOnAbuse, false);
  });
});

describe("config snapshots", () => {
  it("creates a history entry on write and restores it", () => {
    config.写入({ defaultModel: "model-a" });
    config.写入({ defaultModel: "model-b" });
    const history = config.快照历史();
    assert.ok(history.length >= 1);
    const target = history.find((snap) => (snap.values || {}).defaultModel === "model-a") || history[history.length - 1];
    const restored = config.恢复快照(target.id);
    assert.equal(restored.ok, true);
    assert.equal(config.取("defaultModel"), "model-a");
  });
});

describe("dashboard-api", () => {
  beforeEach(() => {
    dashboardApi.初始化({
      adminRequestError: () => "csrf",
      panelAuthorized: () => true,
      panelUnauthorized: (res) => {
        res.writeHead(401, {});
        res.end("denied");
      },
      readRequestBody: async () => "{}",
      config,
      modelGroups: { 诊断: () => [], 组成员: () => [], 候选: () => [] },
      settings: { listApiKeys: () => [] },
      proxy: { describe: () => ({}) },
      farm: { 状态: () => ({ lanes: [] }) },
      obs,
      notify,
      diagnostics,
      selftest,
      ops,
      模型列表: () => [],
      模型判定: () => "free",
      健康上下文: () => ({}),
      采样样本: () => ({}),
      密钥用量: () => ({ keys: [], totals24h: [] }),
      会话快照: () => [],
      收集诊断: () => ({}),
      备份预览: () => ({ files: [] }),
      告警: () => [],
      记录事件: () => {},
    });
  });

  it("returns false for an unhandled path", async () => {
    const res = fakeRes();
    const handled = await dashboardApi.处理({ method: "GET", url: "/nope", headers: { host: "127.0.0.1" } }, res, "/nope");
    assert.equal(handled, false);
  });

  it("serves the observability snapshot", async () => {
    const res = fakeRes();
    const handled = await dashboardApi.处理({ method: "GET", url: "/api/observability", headers: { host: "127.0.0.1" } }, res, "/api/observability");
    assert.equal(handled, true);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.counters);
    assert.ok(body.health);
  });

  it("rejects a write without JSON content type", async () => {
    const res = fakeRes();
    await dashboardApi.处理(
      { method: "POST", url: "/api/observability/clear", headers: { host: "127.0.0.1", "content-type": "text/plain" } },
      res,
      "/api/observability/clear"
    );
    assert.equal(res.status, 403);
  });
});
