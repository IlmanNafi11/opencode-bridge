"use strict";
const assert = require("node:assert");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fleet = require("../fleet");
const proxy = require("../proxy");
const orchestrator = require("../fleet-orchestrator");
const probe = require("../probe");

const isBun = typeof process !== "undefined" && Boolean(process.versions && process.versions.bun);
// applyToPool baca/write fleet.db (bun:sqlite) dan panggil proxy.setPool; di Node
// sqlite tak tersedia. Konsisten dengan monitor/probe, Node skip seluruh file.
const 需要Bun = isBun ? false : "bun:sqlite 只在 Bun 运行";

let dir = null;
let previousState = undefined;
let previousPool = undefined;
let previousUrl = undefined;
let previousStrategy = undefined;

function 设置目录() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-orchestrator-"));
  previousState = process.env.FUCKING_OPENCODE_STATE_DIR;
  previousPool = process.env.UPSTREAM_PROXY_POOL;
  previousUrl = process.env.UPSTREAM_PROXY_URL;
  previousStrategy = process.env.FLEET_POOL_STRATEGY;
  process.env.FUCKING_OPENCODE_STATE_DIR = dir;
  delete process.env.FLEET_DB_PATH;
  delete process.env.UPSTREAM_PROXY_POOL;
  delete process.env.UPSTREAM_PROXY_URL;
  delete process.env.FLEET_POOL_STRATEGY;
  // proxy baca env/state dir saat require; `__restart()` simulasikan reload dari
  // disk dengan env bersih → source file/none, bukan env.
  proxy.__restart();
}

function 恢复目录() {
  if (fleet && typeof fleet.close === "function") fleet.close();
  if (previousState === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
  else process.env.FUCKING_OPENCODE_STATE_DIR = previousState;
  if (previousPool === undefined) delete process.env.UPSTREAM_PROXY_POOL;
  else process.env.UPSTREAM_PROXY_POOL = previousPool;
  if (previousUrl === undefined) delete process.env.UPSTREAM_PROXY_URL;
  else process.env.UPSTREAM_PROXY_URL = previousUrl;
  if (previousStrategy === undefined) delete process.env.FLEET_POOL_STRATEGY;
  else process.env.FLEET_POOL_STRATEGY = previousStrategy;
  // reload proxy dari state dir yang sudah dipulihkan, jangan biarkan menunjuk tmpdir.
  proxy.__restart();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
}

test(
  "applyToPool menolak saat pool terkunci env dengan {type:locked, code:pool_env_locked}",
  { skip: 需要Bun },
  () => {
    设置目录();
    try {
      process.env.UPSTREAM_PROXY_POOL = "http://127.0.0.1:1";
      proxy.__restart();

      fleet.initDB();
      fleet.registerNode({
        label: "vps-1",
        node_type: "vps-public",
        connect_kind: "direct-proxy",
        egress_spec: { proxyUrl: "socks5://127.0.0.1:9000" },
      });

      const r = orchestrator.applyToPool();
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.error.type, "locked");
      assert.equal(r.error.code, "pool_env_locked");
    } finally {
      恢复目录();
    }
  }
);

test(
  "applyToPool menyusun entry: filter reachable/cooling/connect_kind, gabung farm lane ready",
  { skip: 需要Bun },
  () => {
    设置目录();
    try {
      fleet.initDB();

      // Dua node direct-proxy reachable → wajib masuk.
      const a = fleet.registerNode({
        label: "a-direct",
        node_type: "vps-public",
        connect_kind: "direct-proxy",
        egress_spec: { proxyUrl: "socks5://127.0.0.1:9001" },
      });
      const b = fleet.registerNode({
        label: "b-direct",
        node_type: "vps-nat",
        connect_kind: "ssh-reverse-tunnel",
        egress_spec: { proxyUrl: "socks5://127.0.0.1:9002" },
      });
      // relay-http → tak pernah masuk proxy.json.
      fleet.registerNode({
        label: "relay-1",
        node_type: "runner-free",
        connect_kind: "relay-http",
        egress_spec: { proxyUrl: "http://127.0.0.1:8080" },
      });
      // pending → belum siap, dikecualikan.
      fleet.registerNode({ label: "p-1", node_type: "vps-nat", connect_kind: "pending", egress_spec: {} });
      // cooling_until di masa depan → dikecualikan.
      const cooling = fleet.registerNode({
        label: "c-hot",
        node_type: "vps-public",
        connect_kind: "direct-proxy",
        egress_spec: { proxyUrl: "socks5://127.0.0.1:9003" },
      });
      const 未来 = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      fleet.writeHealth({ nodeId: cooling.nodeId, coolingUntil: 未来, blockBasedOnQuota: true });
      // cooling_until di masa lalu → tidak memblokir, tetap masuk.
      const oldCool = fleet.registerNode({
        label: "c-old",
        node_type: "vps-public",
        connect_kind: "direct-proxy",
        egress_spec: { proxyUrl: "socks5://127.0.0.1:9004" },
      });
      fleet.writeHealth({ nodeId: oldCool.nodeId, coolingUntil: new Date(Date.now() - 1000).toISOString() });

      const farmStatus = {
        lanes: [
          { index: 0, url: "socks5://127.0.0.1:40001", ready: true },
          { index: 1, url: "socks5://127.0.0.1:40002", ready: false },
        ],
      };

      const r = orchestrator.applyToPool({ farmStatus });
      assert.equal(r.ok, true, JSON.stringify(r));
      // 1 node a + 1 node b + 1 node c-old + 1 farm lane ready.
      assert.equal(r.entryCount, 4);
      assert.equal(r.farmCount, 1);
      assert.deepEqual([...r.nodeIds].sort(), [a.nodeId, b.nodeId, oldCool.nodeId].sort());

      const pool = proxy.describe().pool;
      assert.equal(pool.size, 4, JSON.stringify(pool));
      const ids = pool.entries.map((e) => e.id).sort();
      assert.deepEqual(ids, [a.nodeId, b.nodeId, oldCool.nodeId, "warp-f0"].sort());

      // proxy.json diperbarui lewat setPool.
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "proxy.json"), "utf8"));
      assert.equal(Array.isArray(onDisk.pool), true);
      assert.equal(onDisk.pool.length, 4);
      assert.ok(["round-robin", "failover", "random"].includes(r.strategy));

      // node yang dikecualikan tercatat dengan alasan yang bisa dibaca.
      const reasons = Object.fromEntries(r.skipped.map((s) => [s.nodeId, s.reason]));
      const relayNode = fleet.getNodes().find((n) => n.label === "relay-1");
      const pendingNode = fleet.getNodes().find((n) => n.label === "p-1");
      assert.ok(relayNode, "relay-1 harus terdaftar");
      assert.equal(reasons[relayNode.id], "relay-http");
      assert.equal(reasons[pendingNode.id], "pending");
      assert.equal(reasons[cooling.nodeId], "cooling");
    } finally {
      恢复目录();
    }
  }
);

test(
  "applyToPool tanpa node siap menyet pool kosong dan melaporkan farmCount",
  { skip: 需要Bun },
  () => {
    设置目录();
    try {
      fleet.initDB();
      fleet.registerNode({ label: "p-only", node_type: "vps-nat", connect_kind: "pending", egress_spec: {} });

      const r = orchestrator.applyToPool({ farmStatus: { lanes: [] } });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.entryCount, 0);
      assert.equal(r.farmCount, 0);
      assert.deepEqual(r.nodeIds, []);
      assert.equal(r.skipped.length, 1);
      assert.equal(proxy.describe().pool.size, 0);
    } finally {
      恢复目录();
    }
  }
);

test(
  "applyToPool tidak menerbitkan node yang probe terakhirnya gagal",
  { skip: 需要Bun },
  async () => {
    设置目录();
    try {
      fleet.initDB();
      const reg = fleet.registerNode({
        label: "mati-1",
        node_type: "vps-nat",
        connect_kind: "ssh-reverse-tunnel",
        egress_spec: { proxyUrl: "http://127.0.0.1:1" },
      });
      assert.equal(reg.ok, true, JSON.stringify(reg));

      // Probe nyata ke port mati: registry harus turun ke reachable=false.
      const verdict = await probe.probeNode(fleet.getNode(reg.nodeId), { timeoutMs: 2000 });
      assert.equal(verdict.ok, false);
      assert.equal(fleet.getNode(reg.nodeId).reachable, false);

      const r = orchestrator.applyToPool({ farmStatus: { lanes: [] } });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.entryCount, 0, `node mati tidak boleh masuk pool: ${JSON.stringify(r.nodeIds)}`);
      assert.deepEqual(r.skipped.map((s) => s.reason), ["unreachable"]);
      assert.equal(proxy.describe().pool.size, 0);
    } finally {
      恢复目录();
    }
  }
);