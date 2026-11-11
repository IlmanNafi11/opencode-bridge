const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-proxy-test-"));
process.env.FUCKING_OPENCODE_STATE_DIR = tmpDir;
delete process.env.UPSTREAM_PROXY_URL;

const proxy = require("../proxy");
const panel = require("../panel");
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
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: data }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function emptyStateDir() {
  // describe 按顺序运行，每个的 `after` 都会清理，所以这里重建目录，
  // 而不是假设先前的套件把它留在了原位。
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true });
}

describe("egress proxy", () => {
  beforeEach(() => {
    emptyStateDir();
    proxy.__reload();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts http and https proxies with optional percent-encoded credentials", () => {
    assert.deepEqual(proxy.parseProxyUrl("http://127.0.0.1:8080"), { ok: true, url: "http://127.0.0.1:8080" });
    assert.deepEqual(proxy.parseProxyUrl(" https://proxy.example.com:3128 "), {
      ok: true,
      url: "https://proxy.example.com:3128",
    });
    // 凭据保持自己的编码：Bun 会为 Proxy-Authorization 解码它们。
    assert.equal(proxy.parseProxyUrl("http://us%40er:p%3Ass@host:8080").url, "http://us%40er:p%3Ass@host:8080");
    assert.equal(proxy.parseProxyUrl("http://user@host:8080").url, "http://user@host:8080");
    // 空值表示直连出口，面板就是这样清除该设置的。
    assert.deepEqual(proxy.parseProxyUrl("   "), { ok: true, url: "" });
  });

  it("accepts SOCKS5, refuses malformed URLs before a request fails", () => {
    assert.deepEqual(proxy.parseProxyUrl("socks5://127.0.0.1:1080"), {
      ok: true,
      url: "socks5://127.0.0.1:1080",
    });
    assert.equal(proxy.parseProxyUrl("socks5h://user:pass@host:1080").ok, true);
    assert.equal(proxy.parseProxyUrl("socks5://host:1080/path").ok, false);

    for (const bad of ["not a url", "http://", "http://host:8080/some/path", "ftp://host:21"]) {
      const parsed = proxy.parseProxyUrl(bad);
      assert.equal(parsed.ok, false, `${bad} must be refused`);
      assert.ok(parsed.error);
    }
  });

  it("persists the proxy to disk with owner-only permissions and never echoes credentials", () => {
    const saved = proxy.setProxyUrl("http://user:secret@10.0.0.5:8080");
    assert.equal(saved.ok, true);
    assert.equal(saved.mode, "proxy");
    assert.equal(saved.proxy, "10.0.0.5:8080");
    assert.equal(saved.hasCredentials, true);
    assert.equal(JSON.stringify(saved).includes("secret"), false, "describe() must not leak the password");

    const file = proxy.configFile();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).url, "http://user:secret@10.0.0.5:8080");

    // 新进程读取同一个文件。
    proxy.__reload();
    assert.equal(proxy.getProxyUrl(), "http://user:secret@10.0.0.5:8080");
    assert.equal(proxy.describe().source, "file");
  });

  it("clearing the URL returns to direct egress and removes the file", () => {
    proxy.setProxyUrl("http://127.0.0.1:8080");
    const cleared = proxy.setProxyUrl("");
    assert.equal(cleared.ok, true);
    assert.equal(cleared.mode, "direct");
    assert.equal(proxy.getProxyUrl(), "");
    assert.equal(fs.existsSync(proxy.configFile()), false);
  });

  it("ignores a corrupt config file instead of refusing to boot", () => {
    fs.writeFileSync(proxy.configFile(), "{not json", "utf8");
    proxy.__reload();
    assert.equal(proxy.getProxyUrl(), "");
    assert.match(proxy.describe().error, /proxy\.json/);
  });

  it("lets UPSTREAM_PROXY_URL win and refuses runtime edits while it is set", () => {
    process.env.UPSTREAM_PROXY_URL = "http://env-proxy:9000";
    proxy.__reload();
    try {
      assert.equal(proxy.getProxyUrl(), "http://env-proxy:9000");
      assert.equal(proxy.describe().locked, true);
      const attempt = proxy.setProxyUrl("http://other:1");
      assert.equal(attempt.ok, false);
      assert.match(attempt.error, /UPSTREAM_PROXY_URL/);
      assert.equal(proxy.getProxyUrl(), "http://env-proxy:9000");
    } finally {
      delete process.env.UPSTREAM_PROXY_URL;
      proxy.__reload();
    }
  });

  it("injects proxy: into every fetch init, and only when one is configured", () => {
    assert.deepEqual(proxy.withProxy({ headers: { a: "b" } }), { headers: { a: "b" } });

    proxy.setProxyUrl("http://127.0.0.1:8080");
    assert.equal(proxy.withProxy({ signal: "s" }).proxy, "http://127.0.0.1:8080");
    // 自己钉住代理的调用方保留它。
    assert.equal(proxy.withProxy({ proxy: "http://pinned:1" }).proxy, "http://pinned:1");

    let seen = null;
    const original = global.fetch;
    global.fetch = async (url, init) => {
      seen = { url, init };
      return { ok: true, json: async () => ({}) };
    };
    try {
      proxy.netFetch("https://example.com/x", { method: "GET" });
    } finally {
      global.fetch = original;
    }
    assert.equal(seen.init.proxy, "http://127.0.0.1:8080");
    assert.equal(seen.init.method, "GET");
  });

  // `testProxy` 拒绝在 Node 上运行，因为 Node 的 fetch 会静默忽略
  // `proxy` init 选项：探测会报告 "ok"，而请求其实直连发出。
  // 这种拒绝是正确行为，所以实时探测断言只在真正尊重该选项的地方适用。
  const PROBE_RUNTIME = typeof Bun !== "undefined";

  it("refuses to probe on a runtime whose fetch ignores the proxy option", async () => {
    if (PROBE_RUNTIME) return;
    const verdict = await proxy.testProxy("http://127.0.0.1:8080");
    assert.equal(verdict.ok, false);
    assert.match(verdict.error, /Bun/);
  });

  it("reports a proxy that cannot reach upstream, and the exit IP when it can", async () => {
    if (!PROBE_RUNTIME) return;
    const original = global.fetch;
    try {
      global.fetch = async (url, init) => {
        if (String(url).includes("cdn-cgi/trace")) return { ok: true, text: async () => "ip=203.0.113.9\nloc=SG\n" };
        assert.equal(init.proxy, "http://127.0.0.1:8080");
        return { ok: true, status: 200 };
      };
      const ok = await proxy.testProxy("http://127.0.0.1:8080");
      assert.equal(ok.ok, true);
      assert.equal(ok.apiStatus, 200);
      assert.equal(ok.exitIp, "203.0.113.9");

      global.fetch = async (url) => {
        if (String(url).includes("cdn-cgi/trace")) throw new Error("tunnel refused");
        return { ok: false, status: 403 };
      };
      const refused = await proxy.testProxy("http://127.0.0.1:8080");
      assert.equal(refused.ok, false);
      assert.equal(refused.apiStatus, 403);
      assert.match(refused.error, /403/);
    } finally {
      global.fetch = original;
    }
  });
});

describe("proxy HTTP surface", () => {
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
    await new Promise((resolve) => server.close(resolve));
  });

  it("serves the panel at / and keeps /health as JSON", async () => {
    const page = await request(port, "GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.raw, /id="proxy-url"/);
    assert.match(page.raw, /id="save"/);
    assert.match(page.raw, /aria-live="polite"/);

    const health = await request(port, "GET", "/health");
    assert.equal(health.status, 200);
    const body = JSON.parse(health.raw);
    assert.equal(body.status, "ok");
    assert.ok(body.egress.proxy);
    assert.equal(body.egress.proxy.mode, "direct");
  });

  it("round-trips the setting through /api/proxy without returning credentials", async () => {
    emptyStateDir();
    proxy.__reload();

    const saved = await request(port, "POST", "/api/proxy", { url: "http://u:p@127.0.0.1:3128" });
    assert.equal(saved.status, 200);
    const savedBody = JSON.parse(saved.raw);
    assert.equal(savedBody.mode, "proxy");
    assert.equal(savedBody.proxy, "127.0.0.1:3128");
    assert.equal(saved.raw.includes('"p"'), false);

    const read = await request(port, "GET", "/api/proxy");
    assert.equal(read.status, 200);
    assert.equal(JSON.parse(read.raw).mode, "proxy");

    const health = JSON.parse((await request(port, "GET", "/health")).raw);
    assert.equal(health.egress.proxy.mode, "proxy");
    assert.equal(health.egress.proxy.proxy, "127.0.0.1:3128");

    const cleared = await request(port, "POST", "/api/proxy", { url: "" });
    assert.equal(cleared.status, 200);
    assert.equal(JSON.parse(cleared.raw).mode, "direct");

    const socksOk = await request(port, "POST", "/api/proxy", { url: "socks5://127.0.0.1:1080" });
    assert.equal(socksOk.status, 200);
    assert.equal(JSON.parse(socksOk.raw).mode, "proxy");
    const socksBad = await request(port, "POST", "/api/proxy", { url: "socks5://127.0.0.1:1080/path" });
    assert.equal(socksBad.status, 400);
    await request(port, "POST", "/api/proxy", { url: "" });

    const noUrl = await request(port, "POST", "/api/proxy", { proxy: "x" });
    assert.equal(noUrl.status, 400);
  });

  it("answers /api/proxy/test with the probe verdict", async () => {
    if (typeof Bun === "undefined") return;
    const original = global.fetch;
    try {
      global.fetch = async (url) => {
        if (String(url).includes("cdn-cgi/trace")) return { ok: true, text: async () => "ip=198.51.100.7\n" };
        return { ok: true, status: 200 };
      };
      const res = await request(port, "POST", "/api/proxy/test", { url: "http://127.0.0.1:3128" });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.raw);
      assert.equal(body.ok, true);
      assert.equal(body.exitIp, "198.51.100.7");
    } finally {
      global.fetch = original;
    }
  });

  it("refuses cross-site writes and non-JSON bodies (CSRF)", async () => {
    emptyStateDir();
    proxy.__reload();

    // 外部页面可以不经预检发送 text/plain；桥必须仅凭内容类型拒绝它。
    const formPost = await request(port, "POST", "/api/proxy", { url: "http://attacker.example:8080" }, {
      "Content-Type": "text/plain",
    });
    assert.equal(formPost.status, 415);
    assert.equal(proxy.getProxyUrl(), "");

    const crossSite = await request(port, "POST", "/api/proxy", { url: "http://attacker.example:8080" }, {
      Origin: "https://evil.example",
      "Sec-Fetch-Site": "cross-site",
    });
    assert.equal(crossSite.status, 403);
    assert.equal(proxy.getProxyUrl(), "");

    const foreignHost = await request(port, "GET", "/api/proxy", undefined, {
      Host: "evil.example",
    });
    assert.equal(foreignHost.status, 403);

    // 面板本身也不能为被重绑定的名字渲染。
    const panelViaForeignHost = await request(port, "GET", "/", undefined, { Host: "evil.example" });
    assert.equal(panelViaForeignHost.status, 403);

    // 同源面板仍然可用。
    const sameOrigin = await request(port, "POST", "/api/proxy", { url: "http://127.0.0.1:3128" }, {
      Origin: `http://127.0.0.1:${port}`,
      "Sec-Fetch-Site": "same-origin",
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal(proxy.getProxyUrl(), "http://127.0.0.1:3128");
    proxy.setProxyUrl("");
  });
});

describe("panel document", () => {
  it("escapes config values so a crafted proxy string cannot inject markup", () => {
    const html = panel.renderPanel(
      { mode: "proxy", proxy: '<img src=x onerror="alert(1)">', source: "file", configPath: "/tmp/x", error: null },
      { version: "2.0.3", port: 20134 }
    );
    assert.equal(html.includes("<img src=x"), false);
    assert.match(html, /&lt;img src=x/);
  });

  it("ships no dead controls: every button has a matching listener", () => {
    const html = panel.renderPanel({ mode: "direct" });
    for (const id of ["save", "test", "direct"]) {
      assert.match(html, new RegExp(`id="${id}"`), `button ${id} missing`);
    }
    assert.match(html, /\$\("save"\)/);
    assert.match(html, /saveBtn\.addEventListener\("click"/);
    assert.match(html, /testBtn\.addEventListener\("click"/);
    assert.match(html, /directBtn\.addEventListener\("click"/);
    assert.match(html, /form\.addEventListener\("submit"/);
  });
});

describe("egress pool", () => {
  beforeEach(() => {
    emptyStateDir();
    delete process.env.UPSTREAM_PROXY_POOL;
    delete process.env.UPSTREAM_PROXY_STRATEGY;
    proxy.__reload();
    proxy.resetHealth();
  });

  after(() => {
    delete process.env.UPSTREAM_PROXY_POOL;
    delete process.env.UPSTREAM_PROXY_STRATEGY;
  });

  it("parses a pool from URLs, label=url lines, and objects", () => {
    const spec = proxy.parsePoolSpec("http://a:1, med2=http://b:2");
    assert.equal(spec.errors.length, 0);
    assert.deepEqual(spec.entries.map((e) => [e.label, e.url]), [
      ["a:1", "http://a:1"],
      ["med2", "http://b:2"],
    ]);

    const fromObject = proxy.parsePoolEntry({ id: "x", label: "Laptop", url: "http://c:3", weight: 5 }, 0);
    assert.equal(fromObject.ok, true);
    assert.equal(fromObject.entry.weight, 5);
    // 权重只需是相对值，省略时为 1。
    assert.equal(proxy.parsePoolEntry("http://d:4", 0).entry.weight, 1);
  });

  it("treats #pool and pool+ entries as rotating endpoints that never cool down", () => {
    const spec = proxy.parsePoolSpec("pool+http://r:1, http://s:2#pool, http://n:3");
    assert.equal(spec.errors.length, 0);
    assert.deepEqual(
      spec.entries.map((e) => [e.url, e.rotating]),
      [
        ["http://r:1", true],
        ["http://s:2", true],
        ["http://n:3", false],
      ]
    );

    const saved = proxy.setPool({ entries: ["pool+http://r:1"], strategy: "round-robin" });
    assert.equal(saved.ok, true);
    assert.equal(proxy.pick().url, "http://r:1");

    const failed = proxy.markFailure("http://r:1", { reason: "allowance 429", cooldownMs: 60000 });
    assert.equal(failed.rotating, true);
    const entry = proxy.describe().pool.entries[0];
    assert.equal(entry.rotating, true);
    assert.equal(entry.state, "ready", "a rotating endpoint is new-IP-per-connection");
    assert.equal(proxy.pick().url, "http://r:1");
  });

  it("refuses a malformed or duplicated entry instead of installing half a pool", () => {
    assert.ok(proxy.parsePoolSpec("not a url").errors.length > 0);
    assert.equal(proxy.parsePoolEntry({}, 3).ok, false);

    const dup = proxy.setPool(["http://a:1", "http://a:1"]);
    assert.equal(dup.ok, false);
    assert.match(dup.error, /ganda/);
    assert.equal(proxy.describe().pool.active, false);
  });

  it("persists the pool with 0600 and reports host:port only", () => {
    const saved = proxy.setPool({
      entries: ["http://u:secret@a:1", { label: "b", url: "http://b:2", weight: 3 }],
      strategy: "failover",
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.mode, "pool");
    assert.equal(saved.pool.size, 2);
    assert.equal(saved.pool.strategy, "failover");
    assert.equal(saved.raw ?? JSON.stringify(saved).includes("secret"), false);
    assert.equal(JSON.stringify(saved).includes("secret"), false, "describe() must not leak credentials");

    const file = proxy.configFile();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.pool.length, 2);
    assert.equal(onDisk.strategy, "failover");

    // 新进程读取同一个池。
    proxy.__reload();
    assert.equal(proxy.getPool().length, 2);
    assert.equal(proxy.describe().pool.enabled, 2);
  });

  it("rotates round-robin across enabled entries", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2", "http://c:3"], strategy: "round-robin" });
    const picked = [proxy.pick(), proxy.pick(), proxy.pick(), proxy.pick()].map((p) => p.url);
    assert.deepEqual(picked, ["http://a:1", "http://b:2", "http://c:3", "http://a:1"]);
  });

  it("stays on the first healthy entry in failover mode", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2"], strategy: "failover" });
    assert.equal(proxy.pick().url, "http://a:1");
    assert.equal(proxy.pick().url, "http://a:1");
    proxy.markFailure("http://a:1", { reason: "gate 429" });
    assert.equal(proxy.pick().url, "http://b:2");
  });

  it("skips a cooling entry and returns to it once the cooldown ends", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2"], strategy: "round-robin" });
    const cooldown = proxy.markFailure("http://a:1", { reason: "allowance 429", cooldownMs: 60000 });
    assert.equal(cooldown.failures, 1);
    assert.ok(cooldown.cooldownUntil > Date.now());

    const state = proxy.describe();
    const a = state.pool.entries.find((e) => e.host === "a:1");
    assert.equal(a.state, "cooling");
    assert.equal(state.pool.ready, 1);

    // 现在每次选择都落在健康条目上。
    assert.deepEqual([proxy.pick(), proxy.pick(), proxy.pick()].map((p) => p.url), [
      "http://b:2",
      "http://b:2",
      "http://b:2",
    ]);

    // 时间推进：a 的冷却结束，所以它又成为候选。
    const later = Date.now() + 61000;
    assert.equal(proxy.describe(later).pool.ready, 2);
  });

  it("backs off further on each consecutive failure, capped, and resets on success", () => {
    proxy.setPool({ entries: ["http://a:1"], cooldownMs: 1000, maxCooldownMs: 4000 });
    const first = proxy.markFailure("http://a:1");
    const second = proxy.markFailure("http://a:1");
    const third = proxy.markFailure("http://a:1");
    assert.equal(first.backoffMs, 1000);
    assert.equal(second.backoffMs, 2000);
    assert.equal(third.backoffMs, 4000);
    // 封顶：第四次失败不会超过 maxCooldownMs。
    assert.equal(proxy.markFailure("http://a:1").backoffMs, 4000);

    proxy.markSuccess("http://a:1");
    assert.equal(proxy.describe().pool.entries[0].state, "ready");
    assert.equal(proxy.describe().pool.entries[0].failures, 0);
    assert.equal(proxy.markFailure("http://a:1").backoffMs, 1000);
  });

  it("still sends through the least-cooling entry when every entry is throttled", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2"] });
    proxy.markFailure("http://a:1", { reason: "gate 429", cooldownMs: 9000 });
    proxy.markFailure("http://b:2", { reason: "gate 429", cooldownMs: 3000 });
    const picked = proxy.pick();
    assert.equal(picked.cooling, true);
    // b 先恢复，所以用的是它。
    assert.equal(picked.url, "http://b:2");
  });

  it("honours exclude so a retry can leave the egress that just failed", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2"] });
    assert.equal(proxy.pick({ exclude: "http://a:1" }).url, "http://b:2");
    // 排除全部时回退到池，而不是返回空。
    assert.ok(proxy.pick({ exclude: "http://a:1" }).url);
  });

  it("injects the picked entry as proxy: and never overrides a caller's own", () => {
    proxy.setPool({ entries: ["http://a:1"] });
    assert.equal(proxy.withProxy({}).proxy, "http://a:1");
    assert.equal(proxy.withProxy({ proxy: "http://pinned:9" }).proxy, "http://pinned:9");
    // 显式出口优先于池的轮换。
    proxy.setPool({ entries: ["http://a:1", "http://b:2"] });
    assert.equal(proxy.withProxy({}, "http://c:3").proxy, "http://c:3");
  });

  it("reads UPSTREAM_PROXY_POOL from the environment and locks runtime edits", () => {
    process.env.UPSTREAM_PROXY_POOL = "one=http://a:1,two=http://b:2";
    process.env.UPSTREAM_PROXY_STRATEGY = "failover";
    proxy.__reload();
    try {
      assert.equal(proxy.getPool().length, 2);
      assert.equal(proxy.describe().pool.strategy, "failover");
      assert.equal(proxy.describe().locked, true);
      const attempt = proxy.setPool(["http://c:3"]);
      assert.equal(attempt.ok, false);
      assert.match(attempt.error, /UPSTREAM_PROXY_POOL/);
    } finally {
      delete process.env.UPSTREAM_PROXY_POOL;
      delete process.env.UPSTREAM_PROXY_STRATEGY;
      proxy.__reload();
    }
  });

  it("clearing the pool falls back to direct egress", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2"] });
    const cleared = proxy.setPool({ entries: [] });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.mode, "direct");
    assert.equal(proxy.getPool().length, 0);
    assert.equal(proxy.pick().url, "");
  });

  it("keeps a single proxy configured when a pool is cleared", () => {
    proxy.setProxyUrl("http://single:9");
    proxy.setPool({ entries: ["http://a:1"] });
    assert.equal(proxy.describe().mode, "pool");

    proxy.setPool({ entries: [] });
    assert.equal(proxy.describe().mode, "proxy");
    assert.equal(proxy.getProxyUrl(), "http://single:9");
  });
});

describe("egress pool: direct entry", () => {
  beforeEach(() => {
    emptyStateDir();
    delete process.env.UPSTREAM_PROXY_POOL;
    proxy.__reload();
    proxy.resetHealth();
  });

  it("accepts { direct: true } and reports it distinctly", () => {
    const saved = proxy.setPool({ entries: [{ direct: true, label: "petafora" }, "http://a:1"] });
    assert.equal(saved.ok, true);
    assert.deepEqual(
      saved.pool.entries.map((e) => [e.label, e.host, e.state]),
      [
        ["petafora", "direct", "ready"],
        ["a:1", "a:1", "ready"],
      ]
    );
  });

  it("returns an empty egress for the direct entry, so the fetch goes out unproxied", () => {
    proxy.setPool({ entries: [{ direct: true }, "http://a:1"], strategy: "failover" });
    const first = proxy.pick();
    assert.equal(first.url, "");
    assert.equal(first.source, "direct");

    // 即使是直连出口，withProxy 也必须不动 init，即便传入了
    // 显式的空目标。
    assert.deepEqual(proxy.withProxy({ headers: { a: "b" } }, ""), { headers: { a: "b" } });
  });

  it("keeps direct and a proxy independent in health", () => {
    proxy.setPool({ entries: [{ direct: true }, "http://a:1"], strategy: "round-robin" });
    proxy.markFailure("", { reason: "gate 429" });
    const state = proxy.describe();
    const directEntry = state.pool.entries.find((e) => e.host === "direct");
    const proxyEntry = state.pool.entries.find((e) => e.host === "a:1");
    assert.equal(directEntry.failures, 1);
    assert.equal(proxyEntry.failures, 0);
    // 现在健康代理是唯一的候选。
    assert.equal(proxy.pick().url, "http://a:1");
  });

  it("refuses a second direct entry as a duplicate", () => {
    const result = proxy.setPool([{ direct: true }, { direct: true, label: "again" }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /direct/);
  });
});

describe("egress pool: health survives a restart", () => {
  beforeEach(() => {
    emptyStateDir();
    delete process.env.UPSTREAM_PROXY_POOL;
    proxy.__reload();
    proxy.resetHealth();
  });

  it("remembers a cooling entry across a reload and keeps the same desired state", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2"] });
    proxy.markFailure("http://a:1", { reason: "allowance 429", cooldownMs: 60000 });

    // 新进程读取池和健康文件；只有池配置是运维意图，
    // 所以这里丢掉健康状态会重新烧掉一个已耗尽的 IP。
    proxy.__restart();

    const state = proxy.describe();
    const a = state.pool.entries.find((e) => e.host === "a:1");
    assert.equal(a.state, "cooling");
    assert.equal(a.failures, 1);
    assert.ok(a.cooldownMsLeft > 50000, `expected cooldown to survive, got ${a.cooldownMsLeft}`);
    assert.equal(state.pool.ready, 1);
    assert.equal(proxy.pick().url, "http://b:2");
  });

  it("restores the failure count so backoff continues instead of restarting", () => {
    proxy.setPool({ entries: ["http://a:1"], cooldownMs: 1000, maxCooldownMs: 8000 });
    proxy.markFailure("http://a:1");
    proxy.markFailure("http://a:1");
    proxy.__restart();
    // 连续第三次失败从 4000 翻倍，而不是从基数 1000。
    assert.equal(proxy.markFailure("http://a:1").backoffMs, 4000);
  });

  it("forgets a spent entry once it succeeds, so the file does not keep stale cooldowns", () => {
    proxy.setPool({ entries: ["http://a:1"] });
    proxy.markFailure("http://a:1", { cooldownMs: 60000 });
    proxy.markSuccess("http://a:1");
    // `markSuccess` 是合并写入的；重新加载前确定性地写盘，
    // 这样断言的是持久化状态而不是定时器。
    proxy.__flushHealth();
    proxy.__restart();
    const state = proxy.describe();
    assert.equal(state.pool.entries[0].state, "ready");
    assert.equal(state.pool.entries[0].failures, 0);
  });

  it("writes health with 0600 and never stores the proxy URL or its credentials", () => {
    proxy.setPool({ entries: ["http://user:secret@a:1"] });
    proxy.markFailure("http://user:secret@a:1", { reason: "allowance 429" });
    const raw = fs.readFileSync(proxy.healthFile(), "utf8");
    assert.equal(fs.statSync(proxy.healthFile()).mode & 0o777, 0o600);
    // 每个代理令牌的第二份副本就是第二个可能泄漏的东西。
    // 记录以出口身份的不透明哈希为键，标签只携带 `describe()` 已经暴露的
    // 内容（host:port）。
    assert.equal(raw.includes("secret"), false);
    assert.equal(raw.includes("user:"), false);
    assert.equal(raw.includes("http://"), false);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.entries.length, 1);
    assert.match(parsed.entries[0].id, /^[0-9a-f]{16}$/);
  });

  it("ignores a corrupt health file instead of losing the pool", () => {
    proxy.setPool({ entries: ["http://a:1"] });
    proxy.markFailure("http://a:1");
    fs.writeFileSync(proxy.healthFile(), "{ not json");
    proxy.__restart();
    assert.equal(proxy.describe().mode, "pool");
    assert.equal(proxy.describe().pool.entries[0].state, "ready");
    assert.equal(fs.existsSync(proxy.healthFile()), false);
  });

  it("drops health for an entry that leaves the pool", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2"] });
    proxy.markFailure("http://a:1", { cooldownMs: 60000 });
    proxy.setPool({ entries: ["http://b:2"] });
    const raw = JSON.parse(fs.readFileSync(proxy.healthFile(), "utf8"));
    assert.deepEqual(raw.entries.map((e) => e.label), ["b:2"]);
  });

  it("keeping the pool saved does not forget the cooldown it already learned", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2"] });
    proxy.markFailure("http://a:1", { reason: "allowance 429", cooldownMs: 60000 });
    // 再次保存正是面板在每次策略变更时所做的。
    const saved = proxy.setPool({ entries: ["http://a:1", "http://b:2"], strategy: "failover" });
    assert.equal(saved.ok, true);
    assert.equal(saved.pool.entries.find((e) => e.host === "a:1").state, "cooling");
  });
});
