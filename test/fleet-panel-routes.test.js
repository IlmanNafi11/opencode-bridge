"use strict";
const assert = require("node:assert");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fleet = require("../fleet");
const panelRoutes = require("../fleet-panel-routes");

const isBun = typeof process !== "undefined" && Boolean(process.versions && process.versions.bun);
// fleet.db membutuhkan bun:sqlite (runtime produksi). Konsisten dengan
// fleet.test.js / fleet-orchestrator.test.js, Node melewati seluruh file.
const 需要Bun = isBun ? false : "bun:sqlite tidak tersedia di Node";

let dir = null;
let previous = undefined;

function 设置目录() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-panel-routes-"));
  previous = process.env.FUCKING_OPENCODE_STATE_DIR;
  process.env.FUCKING_OPENCODE_STATE_DIR = dir;
  delete process.env.FLEET_DB_PATH;
  delete process.env.UPSTREAM_PROXY_POOL;
  delete process.env.UPSTREAM_PROXY_URL;
}

function 恢复目录() {
  if (fleet && typeof fleet.close === "function") fleet.close();
  if (previous === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
  else process.env.FUCKING_OPENCODE_STATE_DIR = previous;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
}

test(
  "fleetStatus menyusun nodes, health, quotaSignalCounts, poolConfig, lastAppliedAt",
  { skip: 需要Bun },
  () => {
    设置目录();
    try {
      fleet.initDB();
      const reg = fleet.registerNode({
        label: "status-vps-1",
        node_type: "vps-public",
        connect_kind: "direct-proxy",
        egress_spec: { proxyUrl: "socks5://127.0.0.1:9000" },
      });
      fleet.updateNode(reg.nodeId, { reachable: true });
      fleet.writeHealth({ nodeId: reg.nodeId, ok: true, exitIp: "203.0.113.7", latencyMs: 42 });
      fleet.writeQuotaSignal({ nodeId: reg.nodeId, label: reg.label, sigType: "429" });

      const r = panelRoutes.fleetStatus();

      assert.equal(r.ok, true);
      // nodes + health terpisah, join lewat id/node_id.
      assert.equal(Array.isArray(r.nodes), true);
      assert.equal(r.nodes.length, 1);
      assert.equal(r.nodes[0].id, reg.nodeId);
      assert.equal(Array.isArray(r.health), true);
      const h = r.health.find((x) => x.node_id === reg.nodeId);
      assert.ok(h, "health harus berisi baris node yang baru di-probe");
      assert.equal(h.ok, true);
      assert.equal(h.exit_ip, "203.0.113.7");
      // quota dikumpulkan per sig_type + total.
      assert.equal(typeof r.quotaSignalCounts, "object");
      assert.equal(r.quotaSignalCounts["429"], 1);
      assert.equal(r.quotaSignalCounts.total, 1);
      // poolConfig: strategy + entry yang aktif.
      assert.equal(typeof r.poolConfig, "object");
      assert.equal(r.poolConfig.strategy, "round-robin");
      assert.equal(typeof r.poolConfig.entryCount, "number");
      // belum pernah apply-pool → lastAppliedAt null.
      assert.equal(r.lastAppliedAt, null);
      // ringkasan kondisi masuk salah satu nilai yang dijanjikan.
      assert.ok(["OK", "DEGRADED", "CRITICAL"].includes(r.summary.condition));
    } finally {
      恢复目录();
    }
  }
);

test(
  "fleetStatus merangkum kondisi CRITICAL saat tidak ada node siap",
  { skip: 需要Bun },
  () => {
    设置目录();
    try {
      fleet.initDB();
      // cuma node pending: tidak pernah siap masuk pool.
      fleet.registerNode({ label: "p-only", node_type: "vps-nat", connect_kind: "pending", egress_spec: {} });

      const r = panelRoutes.fleetStatus();
      assert.equal(r.ok, true);
      assert.equal(r.summary.condition, "CRITICAL");
    } finally {
      恢复目录();
    }
  }
);

test(
  "fleetEvents memfilter nodeId/action/since dan mengurutkan terbaru dulu",
  { skip: 需要Bun },
  () => {
    设置目录();
    try {
      fleet.initDB();
      const a = fleet.registerNode({ label: "ev-a", node_type: "vps-public", connect_kind: "direct-proxy", egress_spec: {} });
      const b = fleet.registerNode({ label: "ev-b", node_type: "vps-nat", connect_kind: "direct-proxy", egress_spec: {} });
      fleet.writeEvent({ nodeId: a.nodeId, action: "cooldown", detail: "429" });
      fleet.writeEvent({ nodeId: b.nodeId, action: "register", detail: "b" });

      const all = panelRoutes.fleetEvents({});
      assert.equal(all.ok, true);
      assert.equal(all.events.length >= 2, true);

      const byA = panelRoutes.fleetEvents({ nodeId: a.nodeId });
      assert.ok(byA.events.length >= 1);
      assert.ok(byA.events.every((e) => e.node_id === a.nodeId));

      const cooldown = panelRoutes.fleetEvents({ action: "cooldown" });
      assert.ok(cooldown.events.length >= 1);
      assert.ok(cooldown.events.every((e) => e.action === "cooldown"));

      // since di masa depan → kosong; since di masa lalu → isi.
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      assert.deepEqual(panelRoutes.fleetEvents({ since: future }).events, []);
      const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      assert.equal(panelRoutes.fleetEvents({ since: past }).events.length >= 2, true);
    } finally {
      恢复目录();
    }
  }
);