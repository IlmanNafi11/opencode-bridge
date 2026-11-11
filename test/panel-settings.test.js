const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const settings = require("../panel-settings");

let dir;

function 重置环境() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-settings-test-"));
  process.env.FUCKING_OPENCODE_STATE_DIR = dir;
  delete process.env.FUCKING_OPENCODE_API_KEYS;
  delete process.env.PANEL_PASSWORD;
}

function 写文件(data) {
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(data, null, 2));
}

function 读文件() {
  return JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
}

beforeEach(重置环境);

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.FUCKING_OPENCODE_STATE_DIR;
  delete process.env.FUCKING_OPENCODE_API_KEYS;
  delete process.env.PANEL_PASSWORD;
});

describe("panel-settings 多密钥", () => {
  it("把旧的单 apiKey 迁移成列表，且不外泄完整密钥", () => {
    写文件({ apiKey: "legacy-secret-key", panelPassword: "pw-1234" });
    assert.equal(settings.getApiKey(), "legacy-secret-key");
    assert.equal(settings.hasApiKeys(), true);
    const info = settings.describe();
    assert.equal(info.apiKeys.length, 1);
    assert.equal(info.apiKeys[0].label, "default");
    assert.equal(info.apiKeys[0].source, "file");
    assert.ok(!JSON.stringify(info).includes("legacy-secret-key"));
  });

  it("增删改 key 并立即生效", () => {
    const added = settings.addApiKey({ label: "laptop", key: "laptop-key-1" });
    assert.equal(added.ok, true);
    assert.equal(settings.matchApiKey("laptop-key-1").label, "laptop");

    const id = settings.listApiKeys()[0].id;
    const renamed = settings.updateApiKey(id, { label: "ci", enabled: false });
    assert.equal(renamed.ok, true);
    assert.equal(settings.matchApiKey("laptop-key-1"), null);
    assert.equal(settings.hasApiKeys(), true);

    assert.equal(settings.updateApiKey(id, { enabled: true }).ok, true);
    assert.equal(settings.matchApiKey("laptop-key-1").label, "ci");

    const removed = settings.deleteApiKey(id);
    assert.equal(removed.ok, true);
    assert.equal(settings.hasApiKeys(), false);
    assert.equal(settings.getApiKey(), "");
  });

  it("拒绝重复 key、过短 key 和未知 id", () => {
    assert.equal(settings.addApiKey({ label: "a", key: "same-key-1" }).ok, true);
    assert.equal(settings.addApiKey({ label: "b", key: "same-key-1" }).ok, false);
    assert.equal(settings.addApiKey({ label: "c", key: "abc" }).ok, false);
    assert.equal(settings.updateApiKey("missing", { label: "x" }).ok, false);
    assert.equal(settings.deleteApiKey("missing").ok, false);
  });

  it("环境变量 key 只读且依然开启门禁", () => {
    process.env.FUCKING_OPENCODE_API_KEYS = "env-key-alpha, env-key-beta";
    assert.equal(settings.hasApiKeys(), true);
    assert.equal(settings.matchApiKey("env-key-alpha").source, "env");
    const envKey = settings.listApiKeys().find((entry) => entry.source === "env");
    assert.equal(settings.deleteApiKey(envKey.id).ok, false);
    assert.equal(settings.updateApiKey(envKey.id, { enabled: false }).ok, false);
  });

  it("收窄并持久化每 key 限额，matchApiKey 回传限额", () => {
    const added = settings.addApiKey({ label: "lim", key: "limit-key-99", rpm: 999, daily: -5, models: ["m1", "", "m2"] });
    assert.equal(added.ok, true);
    const entry = settings.listApiKeys()[0];
    assert.equal(entry.rpm, 600);
    assert.equal(entry.daily, 0);
    assert.deepEqual(entry.models, ["m1", "m2"]);

    const saved = 读文件();
    assert.equal(saved.apiKeys[0].rpm, 600);
    assert.deepEqual(saved.apiKeys[0].models, ["m1", "m2"]);
    assert.equal(saved.apiKeys[0].daily, undefined);

    const matched = settings.matchApiKey("limit-key-99");
    assert.equal(matched.rpm, 600);
    assert.deepEqual(matched.models, ["m1", "m2"]);

    assert.equal(settings.updateApiKey(entry.id, { rpm: 5, daily: 100, models: [] }).ok, true);
    const after = settings.matchApiKey("limit-key-99");
    assert.equal(after.rpm, 5);
    assert.equal(after.daily, 100);
    assert.deepEqual(after.models, []);
  });

  it("文件写入保持 0600 且包含全部条目", () => {
    settings.addApiKey({ label: "one", key: "first-key-1" });
    settings.addApiKey({ label: "two", key: "second-key-2" });
    const saved = 读文件();
    assert.equal(saved.apiKeys.length, 2);
    assert.equal(saved.apiKey, undefined);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(dir, "settings.json")).mode & 0o777, 0o600);
    }
  });
});
