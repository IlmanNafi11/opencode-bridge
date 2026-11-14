"use strict";
const assert = require("node:assert");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fleet = require("../fleet");
const isBun = typeof process !== "undefined" && Boolean(process.versions && process.versions.bun);
// bun:sqlite hanya ada di Bun (runtime produksi). Di Node seluruh modul ini
// melewati (skip) — sama seperti transport-fingerprint.test.js.
const 需要Bun = isBun ? false : "bun:sqlite tidak tersedia di Node";

let dir = null;
let previous = undefined;

function 设置目录() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-fleet-"));
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

test("initDB 建 schema lengkap: 4 tabel + 5 index, mode WAL", { skip: 需要Bun }, () => {
  设置目录();
  try {
    const out = fleet.initDB();
    assert.equal(out.ok, true);
    assert.equal(out.dbPath, path.join(dir, "fleet.db"));
    assert.ok(fs.existsSync(out.dbPath), "fleet.db harus tercipta");

    const { Database } = require("bun:sqlite");
    const db = new Database(out.dbPath, { readonly: true });
    try {
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((r) => r.name);
      assert.deepStrictEqual(tables, ["node_events", "node_health", "nodes", "quota_signals"]);
      const indexes = db
        .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
        .all()
        .map((r) => r.name);
      assert.deepStrictEqual(indexes, [
        "idx_events_node",
        "idx_health_node",
        "idx_nodes_reachable",
        "idx_nodes_type",
        "idx_signals_node",
      ]);
      const mode = db.query("PRAGMA journal_mode").get();
      assert.equal(String(mode.journal_mode || "").toLowerCase(), "wal");
    } finally {
      db.close();
    }
  } finally {
    恢复目录();
  }
});

test("registerNode idempotent per label: id sama, hanya 1 baris", { skip: 需要Bun }, () => {
  设置目录();
  try {
    fleet.initDB();
    const first = fleet.registerNode({
      label: "VPS Jakarta 1",
      node_type: "vps-public",
      connect_kind: "direct-proxy",
      egress_spec: { proxyUrl: "socks5://127.0.0.1:1080" },
    });
    assert.equal(first.ok, true);
    assert.equal(first.created, true);

    const second = fleet.registerNode({
      label: "VPS Jakarta 1",
      node_type: "vps-public",
      connect_kind: "direct-proxy",
    });
    assert.equal(second.ok, true);
    assert.equal(second.created, false);
    assert.equal(second.nodeId, first.nodeId);

    const nodes = fleet.getNodes();
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].id, first.nodeId);
  } finally {
    恢复目录();
  }
});

test("updateNode mengubah reachable & last_heartbeat_at", { skip: 需要Bun }, () => {
  设置目录();
  try {
    fleet.initDB();
    const reg = fleet.registerNode({
      label: "NAT-1",
      node_type: "vps-nat",
      connect_kind: "ssh-reverse-tunnel",
    });
    assert.equal(reg.ok, true);

    const before = fleet.getNode(reg.nodeId);
    assert.equal(before.reachable, true);

    const upd = fleet.updateNode(reg.nodeId, {
      reachable: false,
      last_heartbeat_at: "2026-11-12T00:00:00.000Z",
    });
    assert.equal(upd.ok, true);

    const after = fleet.getNode(reg.nodeId);
    assert.equal(after.reachable, false);
    assert.equal(after.last_heartbeat_at, "2026-11-12T00:00:00.000Z");
  } finally {
    恢复目录();
  }
});

test("writeHealth/writeQuotaSignal/writeEvent menulis baris yang bisa diamati", { skip: 需要Bun }, () => {
  设置目录();
  try {
    fleet.initDB();
    const reg = fleet.registerNode({ label: "warp-0", node_type: "warp", connect_kind: "warp" });
    const id = reg.nodeId;

    const h = fleet.writeHealth({
      nodeId: id,
      ok: false,
      error: "429 quota",
      httpStatus: 429,
      latencyMs: 12,
      exitIp: "1.2.3.4",
    });
    assert.equal(h.ok, true);
    const health = fleet.readHealthSummaries();
    assert.equal(health.length, 1);
    assert.equal(health[0].node_id, id);
    assert.equal(health[0].http_status, 429);
    assert.equal(health[0].ok, false);

    const qs = fleet.writeQuotaSignal({ nodeId: id, label: "warp-0", sigType: "429", weight: 1 });
    assert.equal(qs.ok, true);
    const ev = fleet.writeEvent({ nodeId: id, action: "cooldown", detail: "block_based_on_quota" });
    assert.equal(ev.ok, true);

    const { Database } = require("bun:sqlite");
    const db = new Database(fleet.DBPath(), { readonly: true });
    try {
      assert.equal(db.query("SELECT COUNT(*) AS c FROM quota_signals").get().c, 1);
      // `register` 自己也会写一条审计事件：这里断言的是那条 cooldown 事件存在。
      assert.equal(db.query("SELECT COUNT(*) AS c FROM node_events WHERE action = 'cooldown'").get().c, 1);
    } finally {
      db.close();
    }
  } finally {
    恢复目录();
  }
});