const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const http = require("node:http");

const 桥 = require("../socks-bridge");

function 读取器(socket) {
  let 缓冲 = Buffer.alloc(0);
  let 等待 = null;
  const 泵 = () => {
    if (!等待 || 缓冲.length < 等待.n) return;
    const 值 = 缓冲.subarray(0, 等待.n);
    缓冲 = 缓冲.subarray(等待.n);
    const w = 等待;
    等待 = null;
    w.res(值);
  };
  socket.on("data", (块) => {
    缓冲 = Buffer.concat([缓冲, 块]);
    泵();
  });
  socket.on("error", () => {});
  return (n) =>
    new Promise((res) => {
      等待 = { n, res };
      泵();
    });
}

/** 最小 SOCKS5 服务：忽略目标，直接回连到真实目标。 */
function 启动假socks({ user = "", pass = "" } = {}) {
  const server = net.createServer(async (client) => {
    const 读 = 读取器(client);
    const 问候 = await 读(2);
    const 方法数 = 问候[1];
    if (方法数) await 读(方法数);
    if (user) {
      client.write(Buffer.from([0x05, 0x02]));
      await 读(1);
      const ulen = (await 读(1))[0];
      const u = (await 读(ulen)).toString();
      const plen = (await 读(1))[0];
      const p = (await 读(plen)).toString();
      if (u !== user || p !== pass) {
        client.end(Buffer.from([0x01, 0x01]));
        return;
      }
      client.write(Buffer.from([0x01, 0x00]));
    } else {
      client.write(Buffer.from([0x05, 0x00]));
    }

    const head = await 读(4);
    const atyp = head[3];
    let host = "";
    if (atyp === 0x03) {
      const len = (await 读(1))[0];
      host = (await 读(len)).toString();
    } else if (atyp === 0x01) {
      host = [...(await 读(4))].join(".");
    } else {
      client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      return;
    }
    const portBuf = await 读(2);
    const port = portBuf.readUInt16BE(0);

    const upstream = net.connect({ host, port }, () => {
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => client.destroy());
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

describe("SOCKS5 桥", () => {
  let 假socks, 目标, 目标端口;
  before(async () => {
    目标 = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello via socks " + req.url);
    });
    await new Promise((resolve) => 目标.listen(0, "127.0.0.1", resolve));
    目标端口 = 目标.address().port;
    假socks = await 启动假socks();
  });

  after(async () => {
    桥.关闭全部();
    假socks.server.close();
    await new Promise((resolve) => 目标.close(resolve));
  });

  it("拒绝非 socks5 协议与带路径的 URL", () => {
    assert.equal(桥.解析socks地址("http://127.0.0.1:1").ok, false);
    assert.equal(桥.解析socks地址("socks5://127.0.0.1:1080/path").ok, false);
    assert.equal(桥.解析socks地址("socks5://127.0.0.1:1080").ok, true);
  });

  it("经本地 HTTP 代理把请求送到目标", async () => {
    const 实例 = 桥.确保桥(`socks5://127.0.0.1:${假socks.port}`);
    assert.ok(实例);
    const res = await fetch(`http://127.0.0.1:${目标端口}/ping`, { proxy: 实例.url });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "hello via socks /ping");
    const 状态 = 桥.状态();
    assert.equal(状态.length, 1);
    assert.equal(状态[0].target, `127.0.0.1:${假socks.port}`);
  });

  it("同一 socks URL 复用同一条桥", () => {
    const a = 桥.确保桥(`socks5://127.0.0.1:${假socks.port}`);
    const b = 桥.确保桥(`socks5://127.0.0.1:${假socks.port}`);
    assert.equal(a.url, b.url);
  });

  it("支持用户名密码认证", async () => {
    const 认证socks = await 启动假socks({ user: "u1", pass: "p1" });
    try {
      const 实例 = 桥.确保桥(`socks5://u1:p1@127.0.0.1:${认证socks.port}`);
      const res = await fetch(`http://127.0.0.1:${目标端口}/auth`, { proxy: 实例.url });
      assert.equal(res.status, 200);
    } finally {
      认证socks.server.close();
    }
  });
});
