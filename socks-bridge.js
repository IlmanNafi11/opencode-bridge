const net = require("node:net");
const http = require("node:http");

// 把 SOCKS5 出口包装成 127.0.0.1 上的 HTTP CONNECT 代理。
// Bun fetch 只认 http(s):// 代理，直连 socks5:// 会抛
// UnsupportedProxyProtocol；把 SOCKS 握手放在本地 shim 里，TLS 仍由 Bun
// 发出，ClientHello 基线不受影响。
//
// 每个 socks URL 一条桥（按 URL 缓存，含凭据），只监听回环。凭据只出现在
// SOCKS 握手报文中，不写日志、不进 HTTP 响应。

const 连接超时毫秒 = 10000;
const 空闲超时毫秒 = 120000;
const 缓存 = new Map();

function 解析socks地址(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return { ok: false, error: "SOCKS5 URL 无效。示例：socks5://user:pass@host:1080" };
  }
  if (u.protocol !== "socks5:" && u.protocol !== "socks5h:") {
    return { ok: false, error: "只接受 socks5:// 或 socks5h://。" };
  }
  if (!u.hostname) return { ok: false, error: "SOCKS5 主机为空。" };
  if ((u.pathname !== "" && u.pathname !== "/") || u.search || u.hash) {
    return { ok: false, error: "SOCKS5 URL 只能包含协议、凭据、主机与端口。" };
  }
  return {
    ok: true,
    host: u.hostname,
    port: Number(u.port) || 1080,
    username: u.username ? decodeURIComponent(u.username) : "",
    password: u.password ? decodeURIComponent(u.password) : "",
  };
}

class 读取器 {
  constructor(socket) {
    this.socket = socket;
    this.缓冲 = Buffer.alloc(0);
    this.等待 = null;
    this.错误 = null;
    this.关闭 = false;
    const 处理 = () => {
      if (this.等待) return;
      if (this.错误) return;
      const 等待项 = this.待读;
      if (!等待项) return;
      if (this.缓冲.length >= 等待项.n) {
        const 值 = this.缓冲.subarray(0, 等待项.n);
        this.缓冲 = this.缓冲.subarray(等待项.n);
        this.待读 = null;
        等待项.resolve(值);
      }
    };
    this.处理 = 处理;
    socket.on("data", (块) => {
      this.缓冲 = Buffer.concat([this.缓冲, 块]);
      处理();
    });
    socket.on("error", (err) => {
      this.错误 = err;
      if (this.待读) {
        this.待读.reject(err);
        this.待读 = null;
      }
    });
    socket.on("close", () => {
      this.关闭 = true;
      if (this.待读) {
        this.待读.reject(new Error("连接已关闭"));
        this.待读 = null;
      }
    });
  }

  读(n) {
    if (this.错误) return Promise.reject(this.错误);
    if (this.缓冲.length >= n) {
      const 值 = this.缓冲.subarray(0, n);
      this.缓冲 = this.缓冲.subarray(n);
      return Promise.resolve(值);
    }
    if (this.待读) return Promise.reject(new Error("并发读取未支持"));
    return new Promise((resolve, reject) => {
      this.待读 = { n, resolve, reject };
      this.处理();
    });
  }
}

function 写(socket, 数据) {
  return new Promise((resolve, reject) => {
    socket.write(数据, (err) => (err ? reject(err) : resolve()));
  });
}

/** 通过 SOCKS5 连到目标，完成握手后返回裸 socket。 */
async function socks连接(配置, 目标主机, 目标端口) {
  const dbg = (...a) => process.env.SOCKS_DEBUG && console.error("[socks]", ...a);
  const socket = net.connect({ host: 配置.host, port: 配置.port });
  socket.setTimeout(连接超时毫秒);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
    socket.once("timeout", () => reject(new Error("SOCKS5 连接超时")));
  });
  socket.setTimeout(0);
  const reader = new 读取器(socket);
  try {
    dbg("connected", 配置.host, 配置.port);
    const 方法 = 配置.username || 配置.password ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
    await 写(socket, 方法);
    const 选择 = await reader.读(2);
    dbg("method", [...选择]);
    if (选择[0] !== 0x05) throw new Error("SOCKS5 版本不符");
    if (选择[1] === 0xff) throw new Error("SOCKS5 无可用认证方法");
    if (选择[1] === 0x02) {
      const user = Buffer.from(配置.username);
      const pass = Buffer.from(配置.password);
      if (user.length > 255 || pass.length > 255) throw new Error("SOCKS5 凭据过长");
      await 写(socket, Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      const 认证 = await reader.读(2);
      dbg("auth", [...认证]);
      if (认证[1] !== 0x00) throw new Error("SOCKS5 认证失败");
    }

    const host = Buffer.from(目标主机);
    const 请求头 = Buffer.alloc(5 + host.length + 2);
    请求头[0] = 0x05;
    请求头[1] = 0x01;
    请求头[2] = 0x00;
    请求头[3] = 0x03;
    请求头[4] = host.length;
    host.copy(请求头, 5);
    请求头.writeUInt16BE(目标端口, 5 + host.length);
    await 写(socket, 请求头);
    dbg("connect sent", 目标主机, 目标端口);

    const 应答头 = await reader.读(4);
    dbg("reply", [...应答头]);
    if (应答头[0] !== 0x05) throw new Error("SOCKS5 应答版本不符");
    if (应答头[1] !== 0x00) throw new Error(`SOCKS5 连接失败（代码 ${应答头[1]}）`);
    let 剩余 = 0;
    if (应答头[3] === 0x01) 剩余 = 4 + 2;
    else if (应答头[3] === 0x04) 剩余 = 16 + 2;
    else if (应答头[3] === 0x03) {
      const 长度 = await reader.读(1);
      剩余 = 长度[0] + 2;
    } else throw new Error("SOCKS5 应答地址类型未知");
    if (剩余) await reader.读(剩余);
    socket.setTimeout(空闲超时毫秒, () => socket.destroy(new Error("空闲超时")));
    return socket;
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

function 拆分目标(主机端口) {
  const 文本 = String(主机端口 || "");
  const 匹配 = 文本.match(/^\[?([^\[\]]+?)\]?:(\d+)$/);
  if (!匹配) return null;
  const 端口 = Number(匹配[2]);
  if (!Number.isInteger(端口) || 端口 <= 0 || 端口 > 65535) return null;
  return { host: 匹配[1], port: 端口 };
}

function 处理CONNECT(req, clientSocket, head, 桥) {
  if (process.env.SOCKS_DEBUG) console.error("[bridge] CONNECT", req.url);
  桥.统计.active += 1;
  桥.统计.total += 1;
  const 目标 = 拆分目标(req.url);
  if (!目标) {
    桥.统计.errors += 1;
    clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  socks连接(桥.配置, 目标.host, 目标.port)
    .then((上游) => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) 上游.write(head);
      clientSocket.pipe(上游);
      上游.pipe(clientSocket);
      上游.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => 上游.destroy());
      上游.on("close", () => {
        桥.统计.active = Math.max(0, 桥.统计.active - 1);
        clientSocket.destroy();
      });
      clientSocket.on("close", () => 上游.destroy());
    })
    .catch(() => {
      桥.统计.errors += 1;
      桥.统计.active = Math.max(0, 桥.统计.active - 1);
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
}

function 处理绝对请求(req, res, 桥) {
  if (process.env.SOCKS_DEBUG) console.error("[bridge] REQUEST", req.method, req.url);
  let u;
  try {
    u = new URL(req.url);
  } catch {
    res.writeHead(400);
    return res.end("bad proxy request");
  }
  if (u.protocol !== "http:") {
    res.writeHead(501, { "Content-Type": "text/plain" });
    return res.end("absolute-form https 请求请改用 CONNECT");
  }
  const 端口 = Number(u.port) || 80;
  socks连接(桥.配置, u.hostname, 端口)
    .then((上游) => {
      桥.统计.active += 1;
      桥.统计.total += 1;
      const 头 = { ...req.headers };
      delete 头["proxy-connection"];
      delete 头["proxy-authorization"];
      const 目标请求 = http.request(
        {
          host: u.hostname,
          port: 端口,
          method: req.method,
          path: `${u.pathname}${u.search}`,
          headers: 头,
          createConnection: () => 上游,
        },
        (上游响应) => {
          res.writeHead(上游响应.statusCode, 上游响应.headers);
          上游响应.pipe(res);
          上游响应.on("end", () => {
            桥.统计.active = Math.max(0, 桥.统计.active - 1);
          });
        },
      );
      目标请求.on("error", () => {
        桥.统计.errors += 1;
        桥.统计.active = Math.max(0, 桥.统计.active - 1);
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("SOCKS5 upstream failed");
      });
      req.pipe(目标请求);
    })
    .catch(() => {
      桥.统计.errors += 1;
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("SOCKS5 upstream failed");
    });
}

/** 返回（必要时启动）这条 SOCKS5 URL 的本地 HTTP 代理。 */
function 确保桥(socksUrl) {
  const 键 = String(socksUrl || "").trim();
  const 现有 = 缓存.get(键);
  if (现有 && !现有.server.listening) {
    缓存.delete(键);
  } else if (现有) {
    return 现有;
  }
  const 配置 = 解析socks地址(键);
  if (!配置.ok) return null;
  const 桥 = {
    配置,
    统计: { active: 0, total: 0, errors: 0 },
    server: null,
    url: "",
  };
  桥.server = http.createServer((req, res) => 处理绝对请求(req, res, 桥));
  桥.server.on("connect", (req, socket, head) => 处理CONNECT(req, socket, head, 桥));
  桥.server.on("clientError", (_err, socket) => {
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {}
  });
  桥.server.listen(0, "127.0.0.1");
  const 地址 = 桥.server.address();
  桥.url = `http://127.0.0.1:${地址 && 地址.port ? 地址.port : 0}`;
  缓存.set(键, 桥);
  return 桥;
}

function 可抓取代理(url) {
  if (!url) return url;
  if (!/^socks5h?:\/\//i.test(url)) return url;
  const 桥 = 确保桥(url);
  return 桥 ? 桥.url : url;
}

/** 面板/健康用：只报告目标主机与端口，不含凭据。 */
function 状态() {
  return [...缓存.values()].map((桥) => ({
    target: `${桥.配置.host}:${桥.配置.port}`,
    proxyPort: Number(new URL(桥.url).port) || null,
    active: 桥.统计.active,
    total: 桥.统计.total,
    errors: 桥.统计.errors,
    listening: Boolean(桥.server.listening),
  }));
}

function 关闭全部() {
  for (const [, 桥] of 缓存) {
    try {
      桥.server.close();
    } catch {}
  }
  缓存.clear();
}

module.exports = {
  解析socks地址,
  确保桥,
  可抓取代理,
  状态,
  关闭全部,
};
