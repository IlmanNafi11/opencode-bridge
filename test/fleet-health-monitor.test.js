"use strict";
const assert = require("node:assert");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const fleet = require("../fleet");
const monitor = require("../fleet-health-monitor");

const isBun = typeof process !== "undefined" && Boolean(process.versions && process.versions.bun);
// probe memakai fetch; di Node relay GET tetap jalan, tapi assertion cooldown
// butuh bun:sqlite. Konsisten dengan probe.test.js, Node skip seluruh file.
const 需要Bun = isBun ? false : "bun:sqlite/网络探测只在 Bun 运行";

let dir = null;
let previous = undefined;

function 设置目录() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-monitor-"));
  previous = process.env.FUCKING_OPENCODE_STATE_DIR;
  process.env.FUCKING_OPENCODE_STATE_DIR = dir;
  delete process.env.FLEET_DB_PATH;
}

function 恢复目录() {
  if (monitor && typeof monitor.stop === "function") monitor.stop();
  if (fleet && typeof fleet.close === "function") fleet.close();
  if (previous === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
  else process.env.FUCKING_OPENCODE_STATE_DIR = previous;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
}

test("判断信号 memetakan status/error ke sig_type", () => {
  assert.equal(monitor.判断信号(429, "x"), "429");
  assert.equal(monitor.判断信号(403, "Free models are only available in OpenCode CLI."), "free-tier");
  assert.equal(monitor.判断信号(500, "capacity reached"), "capacity");
  assert.equal(monitor.判断信号(403, "IP abuse block"), "ip-abuse");
  assert.equal(monitor.判断信号(403, "quota exhausted"), "quota");
  assert.equal(monitor.判断信号(200, null), null);
  assert.equal(monitor.判断信号(null, null), null);
});

test(
  "runOnce mendeteksi 429 dari relay, menulis quota_signals + cooldown",
  { skip: 需要Bun },
  async () => {
    设置目录();
    // relay diskalakan merespons 429 → deterministic, tanpa proxy nyata.
    const relay = http.createServer((req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end('{"error":"quota"}');
    });
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const relayPort = relay.address().port;
    try {
      fleet.initDB();
      const reg = fleet.registerNode({
        label: "relay-1",
        node_type: "runner-free",
        connect_kind: "relay-http",
        egress_spec: { proxyUrl: `http://127.0.0.1:${relayPort}`, probePath: "/" },
      });
      assert.equal(reg.ok, true, JSON.stringify(reg));

      const r = await monitor.runOnce();
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(r.results.some((x) => x.nodeId === reg.nodeId && x.httpStatus === 429), JSON.stringify(r.results));

      const signals = fleet.readQuotaSignals();
      assert.equal(signals.length, 1);
      assert.equal(signals[0].node_id, reg.nodeId);
      assert.equal(signals[0].sig_type, "429");

      const h = fleet.readHealthSummaries().find((x) => x.node_id === reg.nodeId);
      assert.ok(h, "node_health harus terisi");
      assert.ok(h.cooling_until, "cooling_until harus terisi");
      assert.equal(h.block_based_on_quota, true);
      assert.equal(h.quota_signal, "429");
    } finally {
      relay.close();
      恢复目录();
    }
  }
);

test(
  "runOnce melewatkan pending/unknown/warp dan hanya memproses yang siap",
  { skip: 需要Bun },
  async () => {
    设置目录();
    try {
      fleet.initDB();
      fleet.registerNode({ label: "w-1", node_type: "warp", connect_kind: "warp", egress_spec: {} });
      fleet.registerNode({ label: "p-1", node_type: "vps-nat", connect_kind: "pending", egress_spec: {} });
      const r = await monitor.runOnce();
      assert.equal(r.ok, true);
      assert.equal(r.scanned, 0, `tak ada node siap; dapat: ${JSON.stringify(r)}`);
      assert.deepEqual(r.results, []);
    } finally {
      恢复目录();
    }
  }
);

test(
  "runOnce tetap mem-probe node yang sempat tidak reachable supaya bisa pulih",
  { skip: 需要Bun },
  async () => {
    设置目录();
    let status = 503;
    const relay = http.createServer((req, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end('{"error":"x"}');
    });
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    try {
      fleet.initDB();
      const reg = fleet.registerNode({
        label: "relay-pulih",
        node_type: "runner-free",
        connect_kind: "relay-http",
        egress_spec: { proxyUrl: `http://127.0.0.1:${relay.address().port}`, probePath: "/" },
      });

      await monitor.runOnce();
      assert.equal(fleet.getNode(reg.nodeId).reachable, false, "gagal probe harus menurunkan reachable");

      status = 200;
      const r = await monitor.runOnce();
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(r.results.some((x) => x.nodeId === reg.nodeId), "node tidak reachable tetap diprobe ulang");
      const after = fleet.getNode(reg.nodeId);
      assert.equal(after.reachable, true, "probe sukses harus memulihkan reachable");
      assert.ok(after.last_heartbeat_at, "pemulihan harus menstempel heartbeat");
    } finally {
      relay.close();
      恢复目录();
    }
  }
);

test("start/stop idempoten; start(0) tak membuat timer", { skip: 需要Bun }, () => {
  设置目录();
  try {
    const a = monitor.start(0);
    assert.equal(a.ok, true);
    const b = monitor.stop();
    assert.equal(b.ok, true);
    // interval positif harus bisa distop dan diulang tanpa error.
    const c = monitor.start(60000);
    assert.equal(c.ok, true);
    monitor.stop();
    monitor.stop();
  } finally {
    恢复目录();
  }
});