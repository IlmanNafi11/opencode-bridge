#!/usr/bin/env bun
/**
 * fleet.js：egress 节点注册表 + SQLite 存储（Armada Cerdas / C2 基础层）。
 *
 * 网关是唯一的 SQLite 写者：节点从不 push 遥测，本模块只做本机读写。
 * 数据库位于 `<state dir>/fleet.db`（`FLEET_DB_PATH` 可覆盖），WAL 模式，
 * 文件权限 0600 —— 里面是出口地址与隧道元数据，不外泄。
 *
 * 设计边界：
 *  - `proxy.js` / `warp-farm.js` 不在此处被修改或调用；池编排在
 *    `fleet-orchestrator.js`（后续阶段），且只能经 `proxy.setPool()` 落盘。
 *  - 存储驱动只有 `bun:sqlite`（Bun 原生）。Node 下加载本模块不报错，
 *    但任何数据库调用都返回 `{ok:false, error:{type:"unavailable"}}`，
 *    这样 `加载本地模块("fleet", …)` 不会拖垮半安装的网关。
 *
 * 表：nodes / node_health / quota_signals / node_events（+ 5 索引），
 * 见 `FLEET-C2-DESIGN.md` §3。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const 数据库文件名 = "fleet.db";
const 数据库版本号 = 1;
const 忙等待毫秒 = 5000;
const 节点类型 = new Set(["vps-public", "vps-nat", "runner-free", "warp", "other"]);
const 冷却基数毫秒 = () => Number(process.env.FLEET_COOLDOWN_BASE_MS || 120000);

/** SQLite 连接按路径缓存：同一进程内复用，测试换 state dir 时自然分家。 */
let 连接 = null;
let 连接路径 = null;

function 状态目录() {
  const raw = process.env.FUCKING_OPENCODE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return path.join(os.homedir(), ".fucking-opencode");
}

function DBPath() {
  const override = process.env.FLEET_DB_PATH;
  if (override !== undefined && String(override).trim()) return String(override).trim();
  return path.join(状态目录(), 数据库文件名);
}

function 不可用(detail) {
  return {
    ok: false,
    error: { message: detail || "bun:sqlite tidak tersedia (jalankan dengan Bun)", type: "unavailable", code: "sqlite_unavailable" },
  };
}

function 载入驱动() {
  try {
    return require("bun:sqlite");
  } catch {
    return null;
  }
}

/**
 * 打开（或复用）数据库连接。路径变化时先关旧的 —— 测试与面板都要能在
 * 运行中切换 state dir，且不能留下指向旧文件的句柄。
 */
function 打开DB() {
  const target = DBPath();
  if (连接 && 连接路径 === target) return 连接;
  if (连接) {
    try { 连接.close(); } catch {}
    连接 = null;
    连接路径 = null;
  }
  const driver = 载入驱动();
  if (!driver || typeof driver.Database !== "function") return null;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const db = new driver.Database(target, { create: true });
  try { fs.chmodSync(target, 0o600); } catch {}
  db.run(`PRAGMA busy_timeout = ${忙等待毫秒}`);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  连接 = db;
  连接路径 = target;
  return db;
}

function close() {
  if (!连接) return { ok: true };
  try { 连接.close(); } catch {}
  连接 = null;
  连接路径 = null;
  return { ok: true };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  node_type TEXT NOT NULL CHECK(node_type IN ('vps-public','vps-nat','runner-free','warp','other')),
  connect_kind TEXT NOT NULL,
  egress_spec TEXT,
  reachable BOOLEAN DEFAULT true,
  tags TEXT,
  weight INTEGER DEFAULT 1,
  pool_subset TEXT DEFAULT 'default',
  enrolled_at TEXT,
  last_heartbeat_at TEXT
);
CREATE TABLE IF NOT EXISTS node_health (
  node_id TEXT PRIMARY KEY,
  last_probe_at TEXT,
  ok BOOLEAN,
  exit_ip TEXT,
  latency_ms INTEGER,
  http_status INTEGER,
  error TEXT,
  cooling_until TEXT,
  quota_signal TEXT,
  block_based_on_quota BOOLEAN DEFAULT false
);
CREATE TABLE IF NOT EXISTS quota_signals (
  id INTEGER PRIMARY KEY,
  node_id TEXT,
  label TEXT,
  sig_type TEXT,
  weight INTEGER DEFAULT 1,
  at TEXT
);
CREATE TABLE IF NOT EXISTS node_events (
  id INTEGER PRIMARY KEY,
  node_id TEXT,
  action TEXT,
  detail TEXT,
  at TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_nodes_reachable ON nodes(reachable);
CREATE INDEX IF NOT EXISTS idx_health_node ON node_health(node_id);
CREATE INDEX IF NOT EXISTS idx_signals_node ON quota_signals(node_id, sig_type);
CREATE INDEX IF NOT EXISTS idx_events_node ON node_events(node_id, at DESC);
`;

/** 幂等建库：schema 只前进不后退，版本号存在 `PRAGMA user_version`。 */
function initDB() {
  const db = 打开DB();
  if (!db) return 不可用();
  const 目标 = DBPath();
  try {
    db.transaction(() => {
      db.exec(SCHEMA);
    })();
    const 版本 = Number(db.query("PRAGMA user_version").get().user_version || 0);
    if (版本 < 数据库版本号) db.run(`PRAGMA user_version = ${数据库版本号}`);
    return { ok: true, dbPath: 目标, version: Math.max(版本, 数据库版本号) };
  } catch (err) {
    return { ok: false, error: { message: `initDB gagal: ${err.message}`, type: "sqlite", code: "init_failed" }, dbPath: 目标 };
  }
}

function 时间戳() {
  return new Date().toISOString();
}

/** 稳定 id：标签转 slug；同名标签复用，不同标签撞 slug 时加序号。 */
function 生成id(db, label) {
  const slug =
    String(label)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "node";
  const 依次 = (candidate) => db.query("SELECT id FROM nodes WHERE id = ?").get(candidate);
  let candidate = slug;
  for (let i = 2; ; i += 1) {
    const 现有 = 依次(candidate);
    if (!现有) return candidate;
    candidate = `${slug}-${i}`;
  }
}

function 解析JSON(text, fallback) {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function 节点行(row) {
  if (!row) return null;
  return {
    ...row,
    reachable: Boolean(row.reachable),
    weight: Number(row.weight || 1),
    egress_spec: 解析JSON(row.egress_spec, {}),
    tags: 解析JSON(row.tags, []),
  };
}

/**
 * 注册节点。同一 label 再次注册时只更新元数据并返回同一个 id（幂等），
 * id 由服务端生成，调用方不能指定。
 */
function registerNode(entry = {}) {
  const db = 打开DB();
  if (!db) return 不可用();
  const label = String(entry.label || "").trim();
  if (!label) return { ok: false, error: { message: "label wajib diisi", type: "validation", code: "label_required" } };
  const nodeType = String(entry.node_type || "other");
  if (!节点类型.has(nodeType)) {
    return {
      ok: false,
      error: { message: `node_type tidak dikenal: ${nodeType}`, type: "validation", code: "bad_node_type" },
    };
  }
  const connectKind = String(entry.connect_kind || "pending");
  try {
    return db.transaction(() => {
      const 现有 = db.query("SELECT * FROM nodes WHERE label = ?").get(label);
      if (现有) {
        db.run("UPDATE nodes SET node_type = ?, connect_kind = ?, egress_spec = COALESCE(?, egress_spec), tags = COALESCE(?, tags), weight = COALESCE(?, weight) WHERE id = ?", [
          nodeType,
          connectKind,
          entry.egress_spec !== undefined ? JSON.stringify(entry.egress_spec) : null,
          entry.tags !== undefined ? JSON.stringify(entry.tags) : null,
          entry.weight !== undefined ? Number(entry.weight) : null,
          现有.id,
        ]);
        return { ok: true, nodeId: 现有.id, created: false };
      }
      const id = 生成id(db, label);
      const now = 时间戳();
      db.run(
        "INSERT INTO nodes (id, label, node_type, connect_kind, egress_spec, reachable, tags, weight, pool_subset, enrolled_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        [
          id,
          label,
          nodeType,
          connectKind,
          JSON.stringify(entry.egress_spec || {}),
          entry.reachable === false ? 0 : 1,
          JSON.stringify(Array.isArray(entry.tags) ? entry.tags : []),
          Number.isFinite(Number(entry.weight)) ? Number(entry.weight) : 1,
          String(entry.pool_subset || "default"),
          now,
        ]
      );
      writeEvent({ nodeId: id, action: "register", detail: `${nodeType}/${connectKind}` });
      return { ok: true, nodeId: id, created: true };
    })();
  } catch (err) {
    return { ok: false, error: { message: `registerNode gagal: ${err.message}`, type: "sqlite", code: "register_failed" } };
  }
}

function getNodes() {
  const db = 打开DB();
  if (!db) return [];
  try {
    return db.query("SELECT * FROM nodes ORDER BY enrolled_at, id").all().map(节点行);
  } catch {
    return [];
  }
}

function getNode(id) {
  const db = 打开DB();
  if (!db) return null;
  try {
    return 节点行(db.query("SELECT * FROM nodes WHERE id = ?").get(String(id)));
  } catch {
    return null;
  }
}

/** 允许更新的列白名单：registry 是观测入口，不能借它改造 schema。 */
const 可更新列 = new Set(["reachable", "last_heartbeat_at", "connect_kind", "egress_spec", "tags", "weight", "pool_subset"]);

function updateNode(id, patch = {}) {
  const db = 打开DB();
  if (!db) return 不可用();
  const sets = [];
  const values = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!可更新列.has(key)) continue;
    if (key === "egress_spec" || key === "tags") {
      sets.push(`${key} = ?`);
      values.push(JSON.stringify(value));
    } else if (key === "reachable") {
      sets.push("reachable = ?");
      values.push(value ? 1 : 0);
    } else {
      sets.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (!sets.length) return { ok: false, error: { message: "tidak ada kolom yang bisa diperbarui", type: "validation", code: "no_fields" } };
  try {
    const result = db.run(`UPDATE nodes SET ${sets.join(", ")} WHERE id = ?`, [...values, String(id)]);
    if (!result.changes) return { ok: false, error: { message: `node tidak ditemukan: ${id}`, type: "not_found", code: "node_missing" } };
    return { ok: true, nodeId: String(id), changes: result.changes };
  } catch (err) {
    return { ok: false, error: { message: `updateNode gagal: ${err.message}`, type: "sqlite", code: "update_failed" } };
  }
}

function writeEvent({ nodeId = null, action = "", detail = null } = {}) {
  const db = 打开DB();
  if (!db) return 不可用();
  if (!action) return { ok: false, error: { message: "action wajib diisi", type: "validation", code: "action_required" } };
  try {
    const result = db.run("INSERT INTO node_events (node_id, action, detail, at) VALUES (?, ?, ?, ?)", [
      nodeId ? String(nodeId) : null,
      String(action),
      detail == null ? null : typeof detail === "string" ? detail : JSON.stringify(detail),
      时间戳(),
    ]);
    return { ok: true, id: Number(result.lastInsertRowid) };
  } catch (err) {
    return { ok: false, error: { message: `writeEvent gagal: ${err.message}`, type: "sqlite", code: "event_failed" } };
  }
}
function readQuotaSignals({ nodeId = null, since = null, limit = 100 } = {}) {
  const db = 打开DB();
  if (!db) return [];
  try {
    const 条件 = [];
    const 参数 = [];
    if (nodeId) {
      条件.push("node_id = ?");
      参数.push(String(nodeId));
    }
    if (since) {
      条件.push("at >= ?");
      参数.push(String(since));
    }
    const where = 条件.length ? `WHERE ${条件.join(" AND ")}` : "";
    const n = Number.isFinite(Number(limit)) ? Math.max(0, Math.min(Number(limit), 500)) : 100;
    return db.query(`SELECT * FROM quota_signals ${where} ORDER BY at DESC, id DESC LIMIT ${n}`).all(...参数);
  } catch {
    return [];
  }
}
/**
 * Sinkronisasi sinyal kuota dari request nyata (hook 记录出口失败 di server.js).
 * Cocokkan URL egress ke node terdaftar; kalau ketemu, catat sinyal + set
 * cooldown (block_based_on_quota). URL tak terdaftar → matched:false, no-op.
 */
function onRequestQuotaSignal({ proxyUrl = null, sigType = "quota" } = {}) {
  const db = 打开DB();
  if (!db) return { matched: false, ok: false, error: 不可用().error };
  const url = String(proxyUrl || "").trim();
  if (!url) return { matched: false, ok: true };
  try {
    const rows = db.query("SELECT id, label FROM nodes WHERE egress_spec IS NOT NULL").all();
    const node = rows
      .map((r) => {
        let spec = {};
        try { spec = JSON.parse(db.query("SELECT egress_spec FROM nodes WHERE id = ?").get(r.id).egress_spec || "{}"); } catch {}
        return { ...r, spec };
      })
      .find((r) => String(r.spec.proxyUrl || "").trim() === url);
    if (!node) return { matched: false, ok: true };

    const sig = String(sigType || "quota");
    const wrote = writeQuotaSignal({ nodeId: node.id, label: node.label, sigType: sig });
    if (!wrote.ok) return { matched: true, ok: false, error: wrote.error };
    const 冷却至 = new Date(Date.now() + 冷却基数毫秒()).toISOString();
    const health = writeHealth({
      nodeId: node.id,
      coolingUntil: 冷却至,
      quotaSignal: sig,
      blockBasedOnQuota: true,
    });
    return { matched: true, ok: health.ok, nodeId: node.id };
  } catch (err) {
    return { matched: false, ok: false, error: { message: `onRequestQuotaSignal gagal: ${err.message}`, type: "sqlite", code: "signal_failed" } };
  }
}

function writeQuotaSignal({ nodeId = null, label = null, sigType = "quota", weight = 1 } = {}) {
  const db = 打开DB();
  if (!db) return 不可用();
  try {
    const result = db.run("INSERT INTO quota_signals (node_id, label, sig_type, weight, at) VALUES (?, ?, ?, ?, ?)", [
      nodeId ? String(nodeId) : null,
      label == null ? null : String(label),
      String(sigType),
      Number.isFinite(Number(weight)) ? Number(weight) : 1,
      时间戳(),
    ]);
    return { ok: true, id: Number(result.lastInsertRowid) };
  } catch (err) {
    return { ok: false, error: { message: `writeQuotaSignal gagal: ${err.message}`, type: "sqlite", code: "signal_failed" } };
  }
}

/**
 * 健康快照是覆盖写：一个节点只有一行"当前状态"，历史在 quota_signals /
 * node_events 里。`last_probe_at` 缺省为此刻。
 */
function writeHealth({
  nodeId,
  ok = false,
  exitIp = null,
  latencyMs = null,
  httpStatus = null,
  error = null,
  coolingUntil = null,
  quotaSignal = null,
  blockBasedOnQuota = null,
} = {}) {
  const db = 打开DB();
  if (!db) return 不可用();
  if (!nodeId) return { ok: false, error: { message: "nodeId wajib diisi", type: "validation", code: "node_required" } };
  try {
    db.run(
      `INSERT INTO node_health (node_id, last_probe_at, ok, exit_ip, latency_ms, http_status, error, cooling_until, quota_signal, block_based_on_quota)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0))
       ON CONFLICT(node_id) DO UPDATE SET
         last_probe_at = excluded.last_probe_at,
         ok = excluded.ok,
         exit_ip = COALESCE(excluded.exit_ip, node_health.exit_ip),
         latency_ms = COALESCE(excluded.latency_ms, node_health.latency_ms),
         http_status = COALESCE(excluded.http_status, node_health.http_status),
         error = excluded.error,
         cooling_until = COALESCE(excluded.cooling_until, node_health.cooling_until),
         quota_signal = COALESCE(excluded.quota_signal, node_health.quota_signal),
         block_based_on_quota = COALESCE(?, node_health.block_based_on_quota)`,
      [
        String(nodeId),
        时间戳(),
        ok ? 1 : 0,
        exitIp == null ? null : String(exitIp),
        latencyMs == null ? null : Math.round(Number(latencyMs)),
        httpStatus == null ? null : Number(httpStatus),
        error == null ? null : String(error),
        coolingUntil == null ? null : String(coolingUntil),
        quotaSignal == null ? null : String(quotaSignal),
        blockBasedOnQuota == null ? null : blockBasedOnQuota ? 1 : 0,
        blockBasedOnQuota == null ? null : blockBasedOnQuota ? 1 : 0,
      ]
    );
    return { ok: true, nodeId: String(nodeId) };
  } catch (err) {
    return { ok: false, error: { message: `writeHealth gagal: ${err.message}`, type: "sqlite", code: "health_failed" } };
  }
}

function readHealthSummaries() {
  const db = 打开DB();
  if (!db) return [];
  try {
    return db
      .query("SELECT * FROM node_health ORDER BY node_id")
      .all()
      .map((row) => ({
        ...row,
        ok: row.ok === null || row.ok === undefined ? null : Boolean(row.ok),
        block_based_on_quota: Boolean(row.block_based_on_quota),
      }));
  } catch {
    return [];
  }
}

module.exports = {
  initDB,
  registerNode,
  getNodes,
  getNode,
  updateNode,
  writeEvent,
  writeQuotaSignal,
  readQuotaSignals,
  onRequestQuotaSignal,
  writeHealth,
  readHealthSummaries,
  DBPath,
  状态目录,
  close,
};
