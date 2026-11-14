const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-fleet-e2e-"));
process.env.FUCKING_OPENCODE_STATE_DIR = tmpDir;
delete process.env.FLEET_DB_PATH;
delete process.env.UPSTREAM_PROXY_POOL;
delete process.env.UPSTREAM_PROXY_URL;

const fleet = require("../fleet");
const srv = require("../server");

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          ...(payload !== null
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        });
      }
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

describe("/api/fleet/* HTTP surface", () => {
  let port;
  let server;

  before(async () => {
    await new Promise((resolve) => {
      server = srv.server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    if (typeof fleet.close === "function") fleet.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("POST /api/fleet/init creates fleet.db and reports its path", async () => {
    const res = await request(port, "POST", "/api/fleet/init", {});
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(typeof res.body.dbPath === "string");
    assert.ok(fs.existsSync(res.body.dbPath));
  });

  it("POST /api/fleet/register assigns a server-side id and is idempotent per label", async () => {
    const first = await request(port, "POST", "/api/fleet/register", {
      label: "VPS-1 PUBLIK",
      node_type: "vps-public",
      connect_kind: "direct-proxy",
      egress_spec: { proxyUrl: "http://127.0.0.1:3128" },
      tags: ["prd"],
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(typeof first.body.nodeId, "string");
    assert.equal(first.body.created, true);

    const again = await request(port, "POST", "/api/fleet/register", {
      label: "VPS-1 PUBLIK",
      node_type: "vps-public",
      connect_kind: "direct-proxy",
      egress_spec: { proxyUrl: "http://127.0.0.1:3128" },
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.ok, true);
    assert.equal(again.body.nodeId, first.body.nodeId);
    assert.equal(again.body.created, false);
  });

  it("rejects missing label with a structured validation error", async () => {
    const res = await request(port, "POST", "/api/fleet/register", {
      node_type: "vps-public",
      connect_kind: "direct-proxy",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.deepEqual(res.body.error, {
      message: "label wajib diisi",
      type: "validation",
      code: "label_required",
    });
  });

  it("rejects non-POST methods on /api/fleet/init", async () => {
    const res = await request(port, "GET", "/api/fleet/init");
    assert.equal(res.status, 405);
  });
});

describe("/api/fleet/probe", () => {
  let port;
  let server;
  let nodeId;

  before(async () => {
    await new Promise((resolve) => {
      server = srv.server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });
    const r1 = await request(port, "POST", "/api/fleet/register", {
      label: "probe-vps-1",
      node_type: "vps-public",
      connect_kind: "direct-proxy",
      egress_spec: { proxyUrl: "http://127.0.0.1:1" },
    });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    nodeId = r1.body.nodeId;
    await request(port, "POST", "/api/fleet/register", {
      label: "probe-vps-pending",
      node_type: "vps-nat",
      connect_kind: "pending",
      egress_spec: {},
    });
  });

  after(async () => {
    if (typeof fleet.close === "function") fleet.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("probes all eligible nodes when no nodeId is given, skipping pending", async () => {
    const r = await request(port, "POST", "/api/fleet/probe", {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.ok(Array.isArray(r.body.results));
    const ids = r.body.results.map((x) => x.nodeId);
    assert.ok(!ids.includes("probe-vps-pending"), `pending node harus dilewati, dapat: ${ids.join(",")}`);
    assert.ok(ids.includes(nodeId), `node eligible harus di-probe, dapat: ${ids.join(",")}`);
  });

  it("probes a single node by nodeId and records its health", async () => {
    const r = await request(port, "POST", "/api/fleet/probe", { nodeId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.results.length, 1);
    assert.equal(r.body.results[0].nodeId, nodeId);
    const h = fleet.readHealthSummaries().find((x) => x.node_id === nodeId);
    assert.ok(h, "node_health harus terisi");
    assert.equal(h.ok, false, "proxy ke port mati harus tercatat tidak reachable");
    assert.ok(h.error, "error harus ada");
  });

  it("returns structured 404 for an unknown nodeId", async () => {
    const r = await request(port, "POST", "/api/fleet/probe", { nodeId: "tidak-ada" });
    assert.equal(r.status, 404);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error.code, "not_found");
  });

  it("is locked to POST", async () => {
    const r = await request(port, "GET", "/api/fleet/probe");
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, "POST");
  });
});

describe("/api/fleet/health-monitor", () => {
  let port;
  let server;

  before(async () => {
    await new Promise((resolve) => {
      server = srv.server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    if (typeof fleet.close === "function") fleet.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("triggers one health round and reports scanned count", async () => {
    const r = await request(port, "POST", "/api/fleet/health-monitor", {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(typeof r.body.scanned, "number");
    assert.ok(Array.isArray(r.body.results));
    assert.ok(r.body.lastRunAt);
  });

  it("is locked to POST", async () => {
    const r = await request(port, "GET", "/api/fleet/health-monitor");
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, "POST");
  });
});