const { describe, it, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-adv-"));
const prevState = process.env.FUCKING_OPENCODE_STATE_DIR;
const prevConfig = process.env.FUCKING_OPENCODE_CONFIG;
const prevWebhook = process.env.NOTIFY_WEBHOOK_URL;
process.env.FUCKING_OPENCODE_STATE_DIR = dir;
process.env.FUCKING_OPENCODE_CONFIG = path.join(dir, "config.json");
delete process.env.NOTIFY_WEBHOOK_URL;

const audit = require("../audit");
const retention = require("../retention");
const backup = require("../backup");
const autoheal = require("../autoheal");
const notify = require("../notify");
const settings = require("../panel-settings");

afterEach(() => {
  audit.清理(0);
  retention.__reset();
  backup.__reset();
  autoheal.__reset();
  notify.__reset();
  if (typeof settings.__reset === "function") settings.__reset();
  fs.rmSync(path.join(dir, "usage.jsonl"), { force: true });
  fs.rmSync(path.join(dir, "audit.jsonl"), { force: true });
  fs.rmSync(path.join(dir, "audit.jsonl.1"), { force: true });
  fs.rmSync(path.join(dir, "backups"), { recursive: true, force: true });
  for (const name of ["retention.json", "backup.json", "autoheal.json", "notify.json", "settings.json", "proxy.json"]) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
});

after(() => {
  if (prevState === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
  else process.env.FUCKING_OPENCODE_STATE_DIR = prevState;
  if (prevConfig === undefined) delete process.env.FUCKING_OPENCODE_CONFIG;
  else process.env.FUCKING_OPENCODE_CONFIG = prevConfig;
  if (prevWebhook !== undefined) process.env.NOTIFY_WEBHOOK_URL = prevWebhook;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("audit", () => {
  it("redacts sensitive keys and returns newest first", () => {
    audit.记录({ action: "settings.save", ip: "127.0.0.1", detail: { apiKey: "sk-secret", nested: { password: "x", note: "ok" } } });
    audit.记录({ action: "backup.create", ok: false });
    const rows = audit.读取(10);
    assert.equal(rows[0].action, "backup.create");
    assert.equal(rows[0].ok, false);
    assert.equal(rows[1].detail.apiKey, "[redacted]");
    assert.equal(rows[1].detail.nested.password, "[redacted]");
    assert.equal(rows[1].detail.nested.note, "ok");
    assert.ok(!JSON.stringify(rows).includes("sk-secret"));
  });
});

describe("retention", () => {
  it("prunes stale usage rows only when enabled", () => {
    const now = Date.now();
    fs.writeFileSync(
      path.join(dir, "usage.jsonl"),
      JSON.stringify({ at: now - 40 * 86400000, model: "old" }) + "\n" +
        JSON.stringify({ at: now, model: "new" }) + "\n",
    );
    assert.equal(retention.执行().skipped, "disabled");
    assert.equal(fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8").includes("old"), true);
    retention.保存({ enabled: true, usageDays: 7 });
    const result = retention.执行();
    assert.equal(result.usage.removed, 1);
    assert.equal(fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8").includes("old"), false);
  });

  it("drops malformed lines", () => {
    fs.writeFileSync(path.join(dir, "usage.jsonl"), "not-json\n" + JSON.stringify({ at: Date.now() }) + "\n");
    retention.保存({ enabled: true, usageDays: 7 });
    retention.执行();
    assert.equal(fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8").trim().startsWith("{"), true);
  });
});

describe("backup", () => {
  it("creates, lists and restores whitelisted state files", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ defaultModel: "a" }));
    fs.writeFileSync(path.join(dir, "secret.txt"), "nope");
    const created = backup.创建();
    assert.equal(created.ok, true);
    assert.deepEqual(created.files, ["config.json"]);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ defaultModel: "b" }));
    const restored = backup.恢复(created.name);
    assert.equal(restored.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).defaultModel, "a");
    assert.equal(backup.恢复("../x").ok, false);
    assert.equal(backup.恢复("backup-missing.json").ok, false);
  });

  it("keeps only the configured number of snapshots", () => {
    fs.writeFileSync(path.join(dir, "config.json"), "{}");
    backup.保存({ keep: 2 });
    for (let i = 0; i < 4; i += 1) backup.创建();
    assert.equal(backup.列表().length, 2);
  });
});

describe("autoheal", () => {
  it("rotates at most one dead lane per tick and respects backoff", async () => {
    autoheal.保存({ enabled: true, reconnectBackoffMs: 60000 });
    const rotated = [];
    const farm = {
      running: true,
      lanes: [
        { index: 0, port: 5001, ready: true },
        { index: 1, port: 5002, ready: false },
        { index: 2, port: 5003, ready: false },
      ],
      settings: { size: 3 },
    };
    const ctx = {
      farm,
      inflight: 0,
      rotate: async (port) => { rotated.push(port); return { ok: true }; },
      restart: async () => ({ ok: true }),
      scale: async () => ({ ok: true }),
    };
    const first = await autoheal.节拍(ctx);
    assert.equal(first.ok, true);
    assert.deepEqual(rotated, [5002]);
    await autoheal.节拍(ctx);
    assert.deepEqual(rotated, [5002, 5003]);
    await autoheal.节拍(ctx);
    assert.deepEqual(rotated, [5002, 5003]);
  });

  it("does nothing when disabled", async () => {
    const result = await autoheal.节拍({ farm: { running: true, lanes: [{ ready: false }] } });
    assert.equal(result.skipped, "disabled");
  });
});

describe("notify routing", () => {
  it("routes by level, bypasses quiet hours for critical, retries 5xx", async () => {
    const calls = [];
    notify.设置网络请求(async (url) => {
      calls.push(url);
      if (calls.length === 1) return { ok: false, status: 503 };
      return { ok: true, status: 200 };
    });
    notify.保存({
      targets: [
        { id: "warn", name: "warn", url: "https://warn.example/hook", minLevel: "warn", enabled: true },
        { id: "crit", name: "crit", url: "https://crit.example/hook", minLevel: "critical", enabled: true },
      ],
      quietFrom: "00:00",
      quietTo: "23:59",
      perMinute: 10,
      retryMax: 1,
    });
    const info = await notify.发送("k1", "info", { level: "info" });
    assert.equal(info.skipped, true);
    assert.equal(calls.length, 0);
    const critical = await notify.发送("k2", "critical", { level: "critical" });
    assert.equal(critical.ok, true);
    assert.deepEqual(calls, ["https://warn.example/hook", "https://warn.example/hook", "https://crit.example/hook"]);
  });

  it("dedupes the same target and key within five minutes", async () => {
    let calls = 0;
    notify.设置网络请求(async () => { calls += 1; return { ok: true, status: 200 }; });
    notify.保存({ targets: [{ id: "t", name: "t", url: "https://x.example/h", minLevel: "info", enabled: true }], quietFrom: "", quietTo: "" });
    await notify.发送("same", "one", { level: "info" });
    const again = await notify.发送("same", "two", { level: "info" });
    assert.equal(again.ok, false);
    assert.equal(again.results[0].skipped, true);
    assert.equal(calls, 1);
  });
});

describe("panel settings key limits", () => {
  it("stores and matches burst and concurrency", () => {
    const added = settings.addApiKey({ label: "bursty", key: "sk-test-bursty-key", burst: 5, concurrency: 2 });
    assert.equal(added.ok, true);
    const listed = settings.listApiKeys().find((row) => row.label === "bursty");
    assert.equal(listed.burst, 5);
    assert.equal(listed.concurrency, 2);
    const matched = settings.matchApiKey("sk-test-bursty-key");
    assert.equal(matched.burst, 5);
    assert.equal(matched.concurrency, 2);
    settings.updateApiKey(listed.id, { burst: 9, concurrency: 4 });
    const updated = settings.listApiKeys().find((row) => row.id === listed.id);
    assert.equal(updated.burst, 9);
    assert.equal(updated.concurrency, 4);
  });
});
