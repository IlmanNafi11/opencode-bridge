"use strict";
const assert = require("node:assert");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { 分类配额信号 } = require("../server");
const fleet = require("../fleet");
const proxy = require("../proxy");
const srv = require("../server");

const isBun = typeof process !== "undefined" && Boolean(process.versions && process.versions.bun);
const 需要Bun = isBun ? false : "bun:sqlite 只在 Bun 运行";

let dir = null;
let previous = undefined;

function 设置目录() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-quota-hook-"));
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

function sseStreamFromLines(lines) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

function httpRequest(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

test("分类配额信号 memetakan reason → sig_type", () => {
  assert.equal(分类配额信号("allowance 429"), "429");
  assert.equal(分类配额信号("ip-abuse block"), "ip-abuse");
  assert.equal(分类配额信号("gate 403"), "free-tier");
  assert.equal(分类配额信号("gate 429"), "capacity");
  assert.equal(分类配额信号("first_event_timeout"), null);
  assert.equal(分类配额信号("transport: x"), null);
  assert.equal(分类配额信号(null), null);
});

test(
  "onRequestQuotaSignal menulis sinyal + cooldown untuk node terdaftar",
  { skip: 需要Bun },
  () => {
    设置目录();
    try {
      fleet.initDB();
      const reg = fleet.registerNode({
        label: "first-node",
        node_type: "vps-public",
        connect_kind: "direct-proxy",
        egress_spec: { proxyUrl: "http://first:1" },
      });
      assert.equal(reg.ok, true, JSON.stringify(reg));

      const r = fleet.onRequestQuotaSignal({ proxyUrl: "http://first:1", sigType: "429" });
      assert.equal(r.matched, true, JSON.stringify(r));
      assert.equal(r.ok, true);

      const signals = fleet.readQuotaSignals();
      assert.equal(signals.length, 1);
      assert.equal(signals[0].node_id, reg.nodeId);
      assert.equal(signals[0].sig_type, "429");

      const h = fleet.readHealthSummaries().find((x) => x.node_id === reg.nodeId);
      assert.ok(h, "node_health harus terisi");
      assert.equal(h.block_based_on_quota, true);
      assert.ok(h.cooling_until, "cooling_until harus terisi");

      // URL tak terdaftar → benign no-match, tidak menulis apa pun.
      const miss = fleet.onRequestQuotaSignal({ proxyUrl: "http://unknown:9", sigType: "quota" });
      assert.equal(miss.matched, false);
      assert.equal(fleet.readQuotaSignals().length, 1);
    } finally {
      恢复目录();
    }
  }
);

test(
  "request nyata egress 429 → quota_signal tercatat di fleet",
  { skip: 需要Bun },
  async () => {
    设置目录();
    const originalFetch = global.fetch;
    let server;
    let port;
    try {
      fleet.initDB();
      const reg = fleet.registerNode({
        label: "first-node",
        node_type: "vps-public",
        connect_kind: "direct-proxy",
        egress_spec: { proxyUrl: "http://first:1" },
      });
      assert.equal(reg.ok, true, JSON.stringify(reg));

      proxy.__reload();
      proxy.resetHealth();
      const saved = proxy.setPool({
        entries: ["http://first:1", "http://second:2"],
        strategy: "failover",
        cooldownMs: 60000,
      });
      assert.equal(saved.ok, true);

      global.fetch = async (_url, init) => {
        const egress = init?.proxy || "direct";
        if (egress === "http://first:1") {
          return {
            ok: false,
            status: 429,
            text: async () => JSON.stringify({ error: { type: "FreeUsageLimitError", message: "Free usage limit reached." } }),
          };
        }
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"id":"1","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      };

      await new Promise((resolve) => {
        server = srv.server.listen(0, "127.0.0.1", () => {
          port = server.address().port;
          resolve();
        });
      });

      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "glm-5.3-flash-free",
        messages: [{ role: "user", content: "quota-hook" }],
        stream: true,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const signals = fleet.readQuotaSignals();
      assert.equal(signals.length, 1, JSON.stringify(signals));
      assert.equal(signals[0].node_id, reg.nodeId);
      assert.equal(signals[0].sig_type, "429");

      const h = fleet.readHealthSummaries().find((x) => x.node_id === reg.nodeId);
      assert.equal(h.block_based_on_quota, true);
      assert.ok(h.cooling_until);
    } finally {
      global.fetch = originalFetch;
      proxy.setPool({ entries: [] });
      proxy.resetHealth();
      proxy.__reload();
      if (server) await new Promise((resolve) => server.close(resolve));
      if (fleet && typeof fleet.close === "function") fleet.close();
      if (previous === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
      else process.env.FUCKING_OPENCODE_STATE_DIR = previous;
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  }
);