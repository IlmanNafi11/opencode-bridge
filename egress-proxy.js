#!/usr/bin/env bun
/**
 * egress-proxy.js：一个极简 HTTP 代理，用于把一台主机变成池里的一个条目。
 *
 * 桥的代理池走 HTTP CONNECT（见 proxy.js），所以每个池成员只需要有东西应答
 * CONNECT 并转发字节 —— 仅此而已。这就是它：单进程、零依赖、无缓存、无检
 * 查。它存在的原因：在运维没有 root 的主机上，替代方案是完整安装 squid/
 * nginx；而一个池条目只需要承载一台机器的出口。
 *
 * 这里刻意不做的：TLS 终结、改写头、记录请求体、共享令牌之外的任何认证。
 * 桥本来就端到端打 TLS 隧道，所以它只做字节泵，看不见明文。
 *
 * 可达性：默认绑定 loopback。让其他主机访问到它是隧道的职责（SSH `-L`），
 * 隧道顺带承载认证，所以令牌是可选的，只在监听口对外暴露时才有意义。
 *
 *   PORT=8888 EGRESS_PROXY_TOKEN=secret bun egress-proxy.js
 *   curl -x http://secret@node:8888 https://api.ipify.org
 */

const net = require("net");
const http = require("http");

const PORT = parseInt(process.env.PORT || "8888", 10);
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN = (process.env.EGRESS_PROXY_TOKEN || "").trim();
const CONNECT_TIMEOUT_MS = parseInt(process.env.CONNECT_TIMEOUT_MS || "15000", 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || "120000", 10);
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS || "512", 10);

let active = 0;
const startedAt = Date.now();

function 已授权(req) {
  if (!TOKEN) return true;
  // Proxy-Authorization: Basic base64(user:token)。只校验密码部分，因为代理
  // URL 的 user 段惯例上是自由格式。
  const header = req.headers["proxy-authorization"] || "";
  const match = /^Basic\s+(.+)$/i.exec(header);
  if (!match) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return password === TOKEN;
}

function 要求认证(res) {
  res.writeHead(407, {
    "Proxy-Authenticate": 'Basic realm="egress"',
    "Content-Type": "text/plain",
  });
  res.end("proxy authentication required\n");
}

/**
 * 只接受池条目需要的两种形态：TLS 走 CONNECT，偶尔的明文探测走绝对 URI 的
 * HTTP。接受任意方法的正向代理，攻击面比需要的大。
 */
const server = http.createServer((req, res) => {
  // 健康检查故意不认证：它只带连接数和运行时长，监控不该为了问一句"代理活
  // 着吗"而持有代理凭据。它绝不报告令牌或目标。
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        role: "egress-proxy",
        activeConnections: active,
        uptimeMs: Date.now() - startedAt,
      })
    );
    return;
  }

  if (!已授权(req)) return 要求认证(res);

  const target = req.url || "";
  if (!/^http:\/\//i.test(target)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Only CONNECT and absolute http:// URLs are proxied." }));
    return;
  }

  const parsed = new URL(target);
  转发HTTP(req, res, parsed);
});

/** 明文 HTTP 转发：以 origin-form 路径重放请求。 */
function 转发HTTP(clientReq, clientRes, target) {
  if (active >= MAX_CONNECTIONS) {
    clientRes.writeHead(503, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify({ error: "proxy connection limit reached" }));
    return;
  }
  active += 1;

  const headers = { ...clientReq.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  headers.host = target.host;

  const upstream = http.request(
    {
      host: target.hostname,
      port: target.port || 80,
      method: clientReq.method,
      path: target.pathname + target.search,
      headers,
    },
    (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
      upstreamRes.on("end", () => {
        active -= 1;
      });
    }
  );

  upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (err) => {
    active -= 1;
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({ error: `upstream: ${err.message}` }));
    } else {
      clientRes.destroy();
    }
  });
  clientReq.pipe(upstream);
}

/** CONNECT：开一条裸 TCP 隧道，双向接通。 */
server.on("connect", (req, clientSocket, head) => {
  if (!已授权(req)) {
    clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"egress\"\r\n\r\n");
    return;
  }
  if (active >= MAX_CONNECTIONS) {
    clientSocket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return;
  }

  const [host, portRaw] = 拆分主机端口(req.url || "");
  const port = parseInt(portRaw || "443", 10);
  if (!host || !Number.isFinite(port)) {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  active += 1;
  const upstream = net.connect({ host, port });

  upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy(new Error("idle timeout")));

  upstream.on("connect", () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  const 关闭 = () => {
    active = Math.max(0, active - 1);
    upstream.destroy();
    clientSocket.destroy();
  };

  upstream.on("error", () => {
    if (!clientSocket.destroyed) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    关闭();
  });
  upstream.on("close", 关闭);
  clientSocket.on("error", 关闭);
  clientSocket.on("close", 关闭);
});

function 拆分主机端口(value) {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return [null, null];
    return [value.slice(1, end), value.slice(end + 1).replace(/^:/, "")];
  }
  const index = value.lastIndexOf(":");
  if (index === -1) return [value, null];
  return [value.slice(0, index), value.slice(index + 1)];
}

server.listen(PORT, HOST, () => {
  console.log(
    `[egress-proxy] 监听 ${HOST}:${PORT}` +
      (TOKEN ? "（需要令牌）" : "（无令牌）")
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[egress-proxy] ${signal}: 正在关闭`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
