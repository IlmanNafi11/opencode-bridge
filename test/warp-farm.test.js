const assert = require("assert");
const { describe, it } = require("node:test");

const farm = require("../warp-farm");

describe("warp-farm bridge", () => {
  it("keeps a cooling /64 out of the pool until its block cooldown expires", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const proxy = require("../proxy");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-farm-block-"));
    const previous = process.env.FUCKING_OPENCODE_STATE_DIR;
    process.env.FUCKING_OPENCODE_STATE_DIR = dir;
    try {
      const one = "socks5://127.0.0.1:41001";
      const two = "socks5://127.0.0.1:41002";
      proxy.setPool({
        entries: [
          { id: "warp-f1", url: one },
          { id: "warp-f2", url: two },
        ],
        strategy: "round-robin",
      });
      proxy.markFailure(one, { reason: "allowance 429", cooldownMs: 60000 });

      const result = farm.applyPool({
        lanes: [
          { index: 1, port: 41001, url: one, egress: "2a09:bac1:34e0:628::1", ready: true },
          { index: 2, port: 41002, url: two, egress: "2a09:bac5:39e3:2646::1", ready: true },
          { index: 3, port: 41003, url: "socks5://127.0.0.1:41003", egress: "", ready: false },
        ],
      });
      assert.equal(result.ok, true);
      assert.deepStrictEqual(
        proxy.getPool().map((entry) => entry.id).sort(),
        ["warp-f2"]
      );
      assert.deepStrictEqual(farm.status().coolingBlocks, [
        { block: "2a09:bac1:34e0:628", until: farm.status().coolingBlocks[0].until },
      ]);
      assert.ok(farm.status().coolingBlocks[0].until > Date.now());
    } finally {
      require("../proxy").setPool({ entries: [] });
      if (previous === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
      else process.env.FUCKING_OPENCODE_STATE_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps lanes to pool entries the proxy module accepts", () => {
    const entries = farm.poolEntries({
      lanes: [
        { index: 1, port: 40001, url: "socks5://127.0.0.1:40001", ready: true },
        { index: 2, port: 40002, url: "socks5://127.0.0.1:40002", ready: false },
      ],
    });
    assert.deepStrictEqual(entries, [
      {
        id: "warp-f1",
        label: "warp-f1",
        url: "socks5://127.0.0.1:40001",
        direct: false,
        enabled: true,
        weight: 1,
      },
      {
        id: "warp-f2",
        label: "warp-f2",
        url: "socks5://127.0.0.1:40002",
        direct: false,
        enabled: true,
        weight: 1,
      },
    ]);
  });

  it("reports stopped state before any start", () => {
    const status = farm.status();
    assert.strictEqual(status.running, false);
    assert.deepStrictEqual(status.lanes, []);
  });

  it("exposes a loopback control URL", () => {
    assert.match(farm.controlUrl(), /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("persists and validates farm settings in the state dir", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-farm-test-"));
    const previous = process.env.FUCKING_OPENCODE_STATE_DIR;
    process.env.FUCKING_OPENCODE_STATE_DIR = dir;
    try {
      const saved = farm.saveSettings({ size: 3, basePort: 41001, stack: "ipv4" });
      assert.equal(saved.ok, true);
      assert.deepStrictEqual(farm.settings(), { size: 3, basePort: 41001, stack: "ipv4", sourceIpv6: "", watchdog: true });
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "warp-farm.json"), "utf8"));
      assert.equal(onDisk.size, 3);
      assert.equal(farm.saveSettings({ watchdog: false }).ok, true);
      assert.equal(farm.settings().watchdog, false);
      assert.equal(farm.saveSettings({ watchdog: true }).ok, true);
      assert.equal(farm.saveSettings({ stack: "bogus" }).ok, false);
      assert.equal(farm.saveSettings({ size: 99 }).ok, false);
      assert.equal(farm.settings().size, 3);
    } finally {
      if (previous === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
      else process.env.FUCKING_OPENCODE_STATE_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports settings and binary availability in status", () => {
    const status = farm.status();
    assert.ok(status.settings && typeof status.settings.size === "number");
    assert.equal(typeof status.binaryAvailable, "boolean");
    assert.ok(Array.isArray(farm.log(10)));
  });
});
