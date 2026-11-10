const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const 平台跳过 = process.platform === "win32" ? "Windows 无 warp-cli 脚本语义" : false;

function 写假CLI(dir, { version = "warp-cli 2024.1.0" } = {}) {
  const file = path.join(dir, "warp-cli");
  fs.writeFileSync(
    file,
    [
      "#!/bin/sh",
      'state="' + path.join(dir, "state") + '"',
      'case "$1" in',
      '  --version) echo "' + version + '"; exit 0;;',
      "  status) if [ -f \"$state\" ]; then echo \"Status update: Connected\"; else echo \"Status update: Disconnected\"; fi; exit 0;;",
      '  connect) echo connected > "$state"; echo "Success"; exit 0;;',
      '  disconnect) rm -f "$state"; echo "Success"; exit 0;;',
      "esac",
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(file, 0o755);
  return file;
}

describe("WARP 管理器", { skip: 平台跳过 }, () => {
  let dir, 原PATH, 原WARP, warp;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "warp-test-"));
    写假CLI(dir);
    原PATH = process.env.PATH;
    process.env.PATH = dir + path.delimiter + 原PATH;
    原WARP = process.env.WARP_MANAGE;
    delete process.env.WARP_MANAGE;
    warp = require("../warp");
    warp.__reset();
  });

  after(() => {
    process.env.PATH = 原PATH;
    if (原WARP === undefined) delete process.env.WARP_MANAGE;
    else process.env.WARP_MANAGE = 原WARP;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("探测已安装的 warp-cli", () => {
    const state = warp.状态();
    assert.equal(state.available, true);
    assert.equal(state.enabled, false);
    assert.match(state.version, /warp-cli/);
  });

  it("WARP_MANAGE 未启用时拒绝动作", () => {
    const result = warp.连接();
    assert.equal(result.ok, false);
    assert.match(result.error, /WARP_MANAGE/);
  });

  it("启用后连接与断开反映在状态里", () => {
    process.env.WARP_MANAGE = "1";
    const connect = warp.连接();
    assert.equal(connect.ok, true);
    assert.equal(warp.状态().connected, true);
    const disconnect = warp.断开();
    assert.equal(disconnect.ok, true);
    const state = warp.状态();
    assert.equal(state.connected, false);
    assert.equal(state.disconnected, true);
  });
});

describe("POST /api/warp 门禁", () => {
  let server, port, 原WARP, 原状态目录;

  before(async () => {
    原WARP = process.env.WARP_MANAGE;
    delete process.env.WARP_MANAGE;
    原状态目录 = process.env.FUCKING_OPENCODE_STATE_DIR;
    process.env.FUCKING_OPENCODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "warp-api-"));
    ({ server } = require("../server"));
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(() => {
    if (server) server.close();
    if (原WARP !== undefined) process.env.WARP_MANAGE = 原WARP;
    if (原状态目录 === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
    else process.env.FUCKING_OPENCODE_STATE_DIR = 原状态目录;
  });

  function request(method, body, contentType = "application/json") {
    return new Promise((resolve, reject) => {
      const payload = body == null ? "" : JSON.stringify(body);
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/warp",
          method,
          headers: {
            "Content-Type": contentType,
            "Content-Length": Buffer.byteLength(payload),
            Host: `127.0.0.1:${port}`,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data || "{}") }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  }

  it("GET 报告 disabled 且不暴露命令", async () => {
    const res = await request("GET");
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, false);
    assert.equal(res.body.command, null);
  });

  it("未启用时动作返回 409", async () => {
    const res = await request("POST", { action: "connect" });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /WARP_MANAGE/);
  });

  it("非 JSON 写入被 415 拒绝", async () => {
    const res = await request("POST", { action: "connect" }, "text/plain");
    assert.equal(res.status, 415);
  });
});
