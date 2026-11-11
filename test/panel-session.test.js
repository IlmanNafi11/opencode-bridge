const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

let dir;
let session;

function fakeReq(token) {
  return { headers: { cookie: token ? `ofb_panel=${token}` : "" } };
}

function fakeRes() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; } };
}

function tokenFor(expires, jti = crypto.randomBytes(16).toString("hex")) {
  return { jti, token: `${expires}.${jti}.${session.sign(expires, jti)}` };
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-session-test-"));
  process.env.FUCKING_OPENCODE_STATE_DIR = dir;
  process.env.PANEL_PASSWORD = "session-test-pass";
  delete process.env.FUCKING_OPENCODE_CONFIG;
  delete process.env.FUCKING_OPENCODE_API_KEYS;
  ({ __panelSession: session } = require("../server"));
  session.reset();
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.FUCKING_OPENCODE_STATE_DIR;
  delete process.env.PANEL_PASSWORD;
});

describe("无状态面板会话", () => {
  it("签名令牌跨进程有效，篡改/过期/坏格式无效", () => {
    const good = tokenFor(Date.now() + 60_000).token;
    assert.equal(session.verify(fakeReq(good)), true);
    const [expires, jti] = good.split(".");
    assert.equal(session.verify(fakeReq(`${expires}.${jti}.deadbeef`)), false);
    assert.equal(session.verify(fakeReq(tokenFor(Date.now() - 1).token)), false);
    assert.equal(session.verify(fakeReq(`${expires}.not-hex.${session.sign(Number(expires), "not-hex")}`)), false);
    assert.equal(session.verify(fakeReq("")), false);
    assert.equal(session.verify(fakeReq("not-a-token")), false);
  });

  it("secret 持久化在状态目录，轮换后吊销旧令牌", () => {
    const first = tokenFor(Date.now() + 60_000).token;
    assert.equal(session.verify(fakeReq(first)), true);
    const secretFile = path.join(dir, "panel-session-secret");
    assert.match(fs.readFileSync(secretFile, "utf8").trim(), /^[0-9a-f]{64}$/);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
    }
    const secretBefore = fs.readFileSync(secretFile, "utf8");
    session.reset();
    const second = tokenFor(Date.now() + 60_000).token;
    assert.equal(session.verify(fakeReq(first)), false);
    assert.equal(session.verify(fakeReq(second)), true);
    assert.notEqual(fs.readFileSync(secretFile, "utf8"), secretBefore);
  });

  it("注销只吊销当前令牌并持久化到状态目录", () => {
    const a = tokenFor(Date.now() + 60_000);
    const b = tokenFor(Date.now() + 60_000);
    assert.equal(session.verify(fakeReq(a.token)), true);
    assert.equal(session.verify(fakeReq(b.token)), true);
    session.clear(fakeReq(a.token), fakeRes());
    assert.equal(session.verify(fakeReq(a.token)), false);
    assert.equal(session.verify(fakeReq(b.token)), true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "panel-revocations.json"), "utf8"));
    assert.ok(saved[a.jti]);
    assert.equal(saved[b.jti], undefined);
  });
});
