"use strict";
const assert = require("node:assert");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fleet = require("../fleet");
const autoactions = require("../fleet-autoactions");

const isBun = typeof process !== "undefined" && Boolean(process.versions && process.versions.bun);
// 节拍 baca/tulis fleet.db (bun:sqlite). Konsisten dengan monitor/orchestrator,
// Node skip seluruh file.
const 需要Bun = isBun ? false : "bun:sqlite 只在 Bun 运行";

let dir = null;
const previous = {};

function 设置目录() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-autoactions-"));
  previous.state = process.env.FUCKING_OPENCODE_STATE_DIR;
  previous.master = process.env.FLEET_AUTO_ACTIONS;
  previous.scale = process.env.FLEET_AUTO_SCALE;
  process.env.FUCKING_OPENCODE_STATE_DIR = dir;
  delete process.env.FLEET_DB_PATH;
  delete process.env.UPSTREAM_PROXY_POOL;
  delete process.env.UPSTREAM_PROXY_URL;
  delete process.env.FLEET_AUTO_ACTIONS;
  delete process.env.FLEET_AUTO_SCALE;
  if (typeof autoactions.__reset === "function") autoactions.__reset();
}

function 恢复目录() {
  if (typeof autoactions.__reset === "function") autoactions.__reset();
  if (typeof fleet.close === "function") fleet.close();
  if (previous.state === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
  else process.env.FUCKING_OPENCODE_STATE_DIR = previous.state;
  if (previous.master === undefined) delete process.env.FLEET_AUTO_ACTIONS;
  else process.env.FLEET_AUTO_ACTIONS = previous.master;
  if (previous.scale === undefined) delete process.env.FLEET_AUTO_SCALE;
  else process.env.FLEET_AUTO_SCALE = previous.scale;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
}

function 开启() {
  process.env.FLEET_AUTO_ACTIONS = "1";
}
function 开启扩容() {
  process.env.FLEET_AUTO_SCALE = "1";
}

function 记录通知() {
  const sent = [];
  return {
    sent,
    notify: { 发送: async (key, text, options = {}) => { sent.push({ key, text, level: options.level || "warn" }); return { ok: true }; } },
  };
}

function 注册Node({ label, connectKind = "direct-proxy", reachable = true, proxyUrl = "socks5://127.0.0.1:9999" }) {
  return fleet.registerNode({
    label,
    node_type: "vps-public",
    connect_kind: connectKind,
    egress_spec: { proxyUrl },
    reachable,
  });
}

test(
  "节拍 no-op saat FLEET_AUTO_ACTIONS belum aktif",
  { skip: 需要Bun },
  async () => {
    设置目录();
    try {
      fleet.initDB();
      const { notify, sent } = 记录通知();
      const standby = 注册Node({ label: "cadangan", reachable: false });
      const applied = { called: false };
      const result = await autoactions.节拍({ notify, applyPool: async () => { applied.called = true; return { ok: true }; } });

      assert.equal(result.enabled, false);
      assert.equal(sent.length, 0);
      assert.equal(applied.called, false);
      assert.equal(fleet.getNode(standby.nodeId).reachable, false);
    } finally {
      恢复目录();
    }
  }
);

test(
  "节拍 mendeteksi node masuk cooling (edge) dan mengirim notifikasi sekali",
  { skip: 需要Bun },
  async () => {
    设置目录();
    开启();
    try {
      fleet.initDB();
      const nodeA = 注册Node({ label: "a" });
      注册Node({ label: "b", proxyUrl: "socks5://127.0.0.1:9998" });
      const { notify, sent } = 记录通知();

      // ronde 1: belum ada yang cooling → tanpa notifikasi.
      await autoactions.节拍({ notify, applyPool: async () => ({ ok: true }) });
      assert.equal(sent.length, 0);

      // nodeA masuk cooling (quota signal) → edge false→true.
      fleet.writeHealth({
        nodeId: nodeA.nodeId,
        coolingUntil: new Date(Date.now() + 60000).toISOString(),
        quotaSignal: "429",
        blockBasedOnQuota: true,
      });
      await autoactions.节拍({ notify, applyPool: async () => ({ ok: true }) });
      assert.equal(sent.length, 1);
      assert.match(sent[0].key, /cooldown/);
      assert.match(sent[0].text, /a/);
      assert.match(sent[0].text, /429/);

      // ronde 3: masih cooling → tidak kirim duplikat.
      await autoactions.节拍({ notify, applyPool: async () => ({ ok: true }) });
      assert.equal(sent.length, 1);
    } finally {
      恢复目录();
    }
  }
);

test(
  "节拍 mengirim notifikasi pool kosong saat tidak ada node siap",
  { skip: 需要Bun },
  async () => {
    设置目录();
    开启();
    try {
      fleet.initDB();
      // node pending tidak bisa masuk pool → pool kosong.
      fleet.registerNode({ label: "tunggu", node_type: "vps-nat", connect_kind: "pending" });
      const { notify, sent } = 记录通知();

      const result = await autoactions.节拍({ notify, applyPool: async () => ({ ok: true }) });

      assert.equal(result.poolEmpty, true);
      assert.equal(sent.length, 1);
      assert.match(sent[0].key, /pool-empty/);
    } finally {
      恢复目录();
    }
  }
);

test(
  "节拍 mengaktifkan node cadangan lalu apply pool saat kosong (FLEET_AUTO_SCALE=1)",
  { skip: 需要Bun },
  async () => {
    设置目录();
    开启();
    开启扩容();
    try {
      fleet.initDB();
      const standby = 注册Node({
        label: "cadangan",
        reachable: false,
        proxyUrl: "socks5://127.0.0.1:9001",
      });
      const { notify, sent } = 记录通知();
      let applyCalls = 0;
      const applyPool = async () => { applyCalls += 1; return { ok: true, entryCount: 1 }; };

      await autoactions.节拍({ notify, applyPool });

      assert.equal(applyCalls, 1);
      assert.equal(fleet.getNode(standby.nodeId).reachable, true);
      assert.equal(sent.length, 1);
      assert.match(sent[0].key, /scale/);
    } finally {
      恢复目录();
    }
  }
);

test(
  "节拍 tidak mengaktifkan cadangan saat FLEET_AUTO_SCALE belum aktif",
  { skip: 需要Bun },
  async () => {
    设置目录();
    开启();
    try {
      fleet.initDB();
      const standby = 注册Node({ label: "cadangan", reachable: false });
      const { notify, sent } = 记录通知();
      let applyCalls = 0;
      const applyPool = async () => { applyCalls += 1; return { ok: true }; };

      await autoactions.节拍({ notify, applyPool });

      assert.equal(applyCalls, 0);
      assert.equal(fleet.getNode(standby.nodeId).reachable, false);
      // pool kosong → tetap ada notifikasi pool-empty.
      assert.equal(sent.length, 1);
      assert.match(sent[0].key, /pool-empty/);
    } finally {
      恢复目录();
    }
  }
);

test(
  "节拍 tidak menghidupkan node yang baru saja gagal probe (FLEET_AUTO_SCALE=1)",
  { skip: 需要Bun },
  async () => {
    设置目录();
    开启();
    开启扩容();
    try {
      fleet.initDB();
      // probe 失败把 reachable 降为 false —— 与"待命节点"同形，但原因不同。
      const mati = 注册Node({ label: "mati", reachable: false });
      fleet.writeHealth({ nodeId: mati.nodeId, ok: false, error: "relay 返回 503" });
      const { notify, sent } = 记录通知();
      let applyCalls = 0;
      const applyPool = async () => { applyCalls += 1; return { ok: true, entryCount: 1 }; };

      const r = await autoactions.节拍({ notify, applyPool });

      assert.equal(r.scaled, false, `node mati tidak boleh diskalakan: ${JSON.stringify(r)}`);
      assert.equal(applyCalls, 0);
      assert.equal(fleet.getNode(mati.nodeId).reachable, false);
      assert.ok(sent.some((m) => /pool-empty/.test(m.key)), "pool tetap kosong → notifikasi pool-empty");
    } finally {
      恢复目录();
    }
  }
);