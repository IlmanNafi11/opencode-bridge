"use strict";
const assert = require("node:assert");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const fleet = require("../fleet");
const probe = require("../probe");

const isBun = typeof process !== "undefined" && Boolean(process.versions && process.versions.bun);
// proxy.testProxy 需要 Bun 的 `proxy:` fetch；Node 运行时下网络探测不可用。
const 需要Bun = isBun ? false : "bun:sqlite/proxy 网络探测只在 Bun 运行";

let dir = null;
let previous = undefined;

function 设置目录() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-probe-"));
  previous = process.env.FUCKING_OPENCODE_STATE_DIR;
  process.env.FUCKING_OPENCODE_STATE_DIR = dir;
  delete process.env.FLEET_DB_PATH;
}

function 恢复目录() {
  if (fleet && typeof fleet.close === "function") fleet.close();
  if (previous === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
  else process.env.FUCKING_OPENCODE_STATE_DIR = previous;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
}

function 节点(overrides = {}) {
  return {
    id: "vps-1",
    label: "vps-1",
    node_type: "vps-public",
    connect_kind: "direct-proxy",
    egress_spec: { proxyUrl: "http://127.0.0.1:1" },
    reachable: true,
    ...overrides,
  };
}

test("probeNode pending → ok:false tanpa jaringan, tanpa baris health", async () => {
  设置目录();
  try {
    fleet.initDB();
    const r = await probe.probeNode(节点({ connect_kind: "pending" }));
    assert.equal(r.ok, false);
    assert.ok(String(r.error || "").includes("pending"), `error harus menyebut pending, dapat: ${r.error}`);
    assert.equal(fleet.readHealthSummaries().length, 0);
  } finally {
    恢复目录();
  }
});

test("probeNode unknown → ok:false tanpa jaringan", async () => {
  设置目录();
  try {
    fleet.initDB();
    const r = await probe.probeNode(节点({ connect_kind: "unknown" }));
    assert.equal(r.ok, false);
  } finally {
    恢复目录();
  }
});

test("probeNode warp → skip, tidak menulis health (farm punya status sendiri)", async () => {
  设置目录();
  try {
    fleet.initDB();
    const r = await probe.probeNode(节点({ connect_kind: "warp" }));
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
    assert.equal(fleet.readHealthSummaries().length, 0);
  } finally {
    恢复目录();
  }
});

test("probeNode proxy tanpa proxyUrl → ok:false validasi, tanpa jaringan", async () => {
  设置目录();
  try {
    fleet.initDB();
    const r = await probe.probeNode(节点({ egress_spec: {} }));
    assert.equal(r.ok, false);
    assert.ok(String(r.error || "").includes("proxyUrl"), `error harus menyebut proxyUrl, dapat: ${r.error}`);
  } finally {
    恢复目录();
  }
});

test(
  "probeNode proxy tidak reachable → ok:false dan node_health tercatat failed",
  { skip: 需要Bun },
  async () => {
    设置目录();
    try {
      fleet.initDB();
      // 127.0.0.1:1 拒绝连接 → deterministic, cepat.
      const r = await probe.probeNode(节点({ connect_kind: "ssh-reverse-tunnel", egress_spec: { proxyUrl: "http://127.0.0.1:1" } }), { timeoutMs: 2000 });
      assert.equal(r.ok, false);
      const rows = fleet.readHealthSummaries();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].node_id, "vps-1");
      assert.equal(rows[0].ok, false);
      assert.ok(rows[0].error);
    } finally {
      恢复目录();
    }
  }
);

test(
  "probeNode relay gagal → registry reachable=false supaya node mati tidak masuk pool",
  { skip: 需要Bun },
  async () => {
    设置目录();
    const relay = http.createServer((req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end('{"error":"unavailable"}');
    });
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    try {
      fleet.initDB();
      const reg = fleet.registerNode({
        label: "relay-mati",
        node_type: "runner-free",
        connect_kind: "relay-http",
        egress_spec: { proxyUrl: `http://127.0.0.1:${relay.address().port}`, probePath: "/" },
      });
      assert.equal(reg.ok, true, JSON.stringify(reg));
      assert.equal(fleet.getNode(reg.nodeId).reachable, true, "prasyarat: node terdaftar reachable");

      const r = await probe.probeNode(fleet.getNode(reg.nodeId));
      assert.equal(r.ok, false);
      assert.equal(fleet.getNode(reg.nodeId).reachable, false);
    } finally {
      relay.close();
      恢复目录();
    }
  }
);

test(
  "probeNode sukses → registry reachable=true dan last_heartbeat_at terisi",
  { skip: 需要Bun },
  async () => {
    设置目录();
    const relay = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    try {
      fleet.initDB();
      const reg = fleet.registerNode({
        label: "relay-hidup",
        node_type: "runner-free",
        connect_kind: "relay-http",
        egress_spec: { proxyUrl: `http://127.0.0.1:${relay.address().port}`, probePath: "/" },
        reachable: false,
      });
      assert.equal(reg.ok, true, JSON.stringify(reg));
      assert.equal(fleet.getNode(reg.nodeId).last_heartbeat_at, null, "prasyarat: belum pernah heartbeat");

      const r = await probe.probeNode(fleet.getNode(reg.nodeId));
      assert.equal(r.ok, true, JSON.stringify(r));
      const after = fleet.getNode(reg.nodeId);
      assert.equal(after.reachable, true);
      assert.ok(after.last_heartbeat_at, "probe sukses harus menstempel last_heartbeat_at");
      assert.ok(Number.isFinite(Date.parse(after.last_heartbeat_at)), `heartbeat bukan waktu valid: ${after.last_heartbeat_at}`);
    } finally {
      relay.close();
      恢复目录();
    }
  }
);