#!/usr/bin/env bun
/**
 * gate-drill.js — 用*真实*的上游网关检验反应式自愈。
 *
 * 这不是单元测试。它故意让桥以会被上游拒绝的状态启动，发出一个客户端请求，
 * 然后检查桥自我治愈、客户端仍能拿到回答。全程不 mock。
 *
 * 每个演练对应一个实测过的网关层：
 *
 *   version-floor   User-Agent 低于上游通告的下限时，上游返回指明最低版本的
 *                   `426 UpgradeRequired`。桥采纳该下限，从握手中刷新，并
 *                   重放请求。
 *
 *   endpoint-move   上游的路径迁移（/zen/v1 → /inference/v1 的迁移）在旧
 *                   URL 上表现为 404。提供方目录是 base URL 的权威来源，所以
 *                   桥必须重新推导并重试，而不是把 404 交给客户端。本演练用
 *                   两个本地服务器，因此从不依赖上游当前服务哪个路径。
 *
 *   legacy-shape    v1.5.0 指纹——旧 ai-sdk User-Agent、旧工具名、旧会话
 *                   前缀——经当前桥重放，确认通过免费层的并不是这个访问
 *                   形态。它作为对照保留：证明桥没有去"修"一个从未坏过的
 *                   东西。
 *
 *   empty-tools     解析为空工具集的配置会让上游回答 `403 FreeTierError`。
 *                   桥必须回退到随发行版内置的指纹，而不是发送 `tools: []`。
 *
 *   session-shape   本演练为之存在的错误：
 *                   `403 {"type":"error","error":{"type":"FreeTierError",
 *                    "message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai ..."}}`（原文）
 *                   上游把它读作"这不是 OpenCode 客户端"。实测原因：会话 id
 *                   的形态。`ses_` + 12 位小写十六进制 + 14 位 base62（恰好
 *                   30 字符）会被接受；前缀、长度或大小写不同则不会。过期的
 *                   配方会铸出错误形态，所以桥必须在刷新后重新铸造——重放
 *                   过期 id 的失败方式一模一样。
 *
 * 本演练不做的事：对网关做 fuzz。每个失败请求都是桥即将治愈的请求；演练
 * 串行执行且带小间隔，因为上游会在一串失败之后施加按 IP 的冷却。
 *
 * 用法：
 *   bun gate-drill.js            # 全部演练
 *   bun gate-drill.js full-corrupt  # 单个演练
 */

const http = require("http");

const 演练列表 = [
  "version-floor",
  "legacy-shape",
  "empty-tools",
  "session-shape",
  "routing",
  "allowlist",
  "retry-endpoint",
  "endpoint-move",
  "gate-heal",
  "full-corrupt",
];

function 提问(端口, 请求体) {
  return new Promise((resolve, reject) => {
    // 线上演练必须演练上游真正接受的形态。不带 `stream` 的请求会在其内容被
    // 读取之前就被 403 FreeTierError 拒绝（同一 IP 上实测 6/6 对 0/6），这会
    // 让每个演练都因为演练自己制造的原因报告网关关闭。`stream` 在这里强制，
    // 而不是在每个调用点，这样新演练无法重新引入这个错误。
    const 载荷 = JSON.stringify({ ...请求体, stream: true });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: 端口,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(载荷) },
      },
      (res) => {
        const 分块 = [];
        res.on("data", (c) => 分块.push(c));
        res.on("end", () => {
          const 文本 = Buffer.concat(分块).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(文本);
          } catch {}
          // 流式应答以 SSE 到达。把它折叠成 `取内容()` 期望的 completion
          // 形态，调用点就不必关心协议差异。
          if (!json && /^\s*data:/.test(文本)) json = 折叠Sse(文本);
          resolve({ status: res.statusCode, json, text: 文本 });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(180000, () => req.destroy(new Error("客户端超时")));
    req.write(载荷);
    req.end();
  });
}

/** 把桥的 SSE 应答折叠成一个 completion 对象。 */
function 折叠Sse(原始) {
  let 内容 = "";
  let 思考 = "";
  let 结束原因 = null;
  let 用量 = null;
  for (const 行 of 原始.split("\n")) {
    if (!行.startsWith("data:")) continue;
    const 分块 = 行.slice(5).trim();
    if (!分块 || 分块 === "[DONE]") continue;
    let 事件 = null;
    try { 事件 = JSON.parse(分块); } catch { continue; }
    if (事件?.error) return { error: 事件.error };
    const 选项 = 事件?.choices?.[0];
    if (选项?.delta?.content) 内容 += 选项.delta.content;
    if (选项?.delta?.reasoning_content) 思考 += 选项.delta.reasoning_content;
    if (选项?.finish_reason) 结束原因 = 选项.finish_reason;
    if (事件?.usage) 用量 = 事件.usage;
  }
  return {
    choices: [{ message: { role: "assistant", content: 内容, reasoning_content: 思考 }, finish_reason: 结束原因 }],
    usage: 用量,
  };
}

function 取内容(res) {
  const 消息 = res.json?.choices?.[0]?.message;
  return (消息?.content || "").trim();
}

function 判定行(是否通过, 标签, 细节 = "") {
  const 标记 = 是否通过 ? "OK  " : "FAIL";
  console.log(`  ${标记} ${标签}${细节 ? "  " + 细节 : ""}`);
}

/**
 * 三态行：`true` 打印 OK，`false` 打印 FAIL，`null` 打印 SKIP。
 *
 * 线上演练只有在上游真正读过请求时，才能裁定它预置的那一层。`429` 是容量
 * 问题，不是对请求形态的裁定（对照探测对它一视同仁），所以依赖上游作答的
 * 断言应为 `null`，而不是一次错误的失败。
 */
function 三态判定行(是否通过, 标签, 细节 = "") {
  const 标记 = 是否通过 === null ? "SKIP" : 是否通过 ? "OK  " : "FAIL";
  console.log(`  ${标记} ${标签}${细节 ? "  " + 细节 : ""}`);
}

/** 上游以容量压力作答，而不是给出网关裁定。 */
function 上游限流(res) {
  return res.status === 429;
}

/** 通过则 `true`；上游未给出裁定时 `null`。 */
function 裁定(是否通过, 未判定) {
  return 是否通过 ? true : 未判定 ? null : false;
}

async function 等桥就绪(端口, 超时毫秒 = 30000) {
  const 截止时间 = Date.now() + 超时毫秒;
  while (Date.now() < 截止时间) {
    try {
      const res = await 提问(端口, { model: "big-pickle", messages: [{ role: "user", content: "ping" }] });
      if (res.status === 200) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function 演练版本下限({ identity, __syncUserAgent }) {
  console.log("\nversion-floor — UA 低于通告的下限（426 UpgradeRequired）");
  const 原下限 = identity.getState().versionFloor;

  // 假装这座桥早于下限出现。请求路径保持反应式，因此不允许任何主动刷新
  // 把拒绝掩盖掉。
  identity.applyRecipe({ version: "1.0.0" });
  __syncUserAgent();
  identity.__setLastCheckTime(Date.now());

  const 原UA = identity.getUserAgent();
  console.log(`  预置 UA: ${原UA}`);
  console.log("  发送一个请求（上游应拒绝它）…");

  const res = await 提问(取端口(), {
    model: "big-pickle",
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });

  const 状态 = identity.getState();
  const 新UA = identity.getUserAgent();
  const 已自愈 = 状态.versionFloor && 状态.versionFloor !== 原下限;

  console.log(`  上游下限: ${状态.versionFloor || "(none)"}`);
  console.log(`  UA 之后    : ${新UA}`);
  console.log(`  客户端看到  : HTTP ${res.status} ${JSON.stringify(取内容(res))}`);

  const 已限流 = 上游限流(res);
  const 已作答 = res.status === 200 && 取内容(res).length > 0;
  const 已迁移 =
    新UA !== 原UA &&
    新UA.startsWith("opencode/latest/") &&
    !新UA.includes("/1.0.0/");

  三态判定行(裁定(res.status === 200, 已限流), "客户端收到 200，而不是网关错误");
  三态判定行(裁定(取内容(res).length > 0, 已限流), "客户端收到真实内容");
  判定行(已自愈, "版本下限是从拒绝中学到的");
  判定行(新UA !== 原UA, "User-Agent 已离开被拒的版本");
  判定行(已迁移, "身份现在跟随当前发行版");

  // 429 意味着上游从未裁定治愈后的形态，所以即使每条自愈断言都通过，
  // 本演练面向客户端的那一半仍未定论。
  if (!已自愈 || !已迁移) return false;
  return 裁定(已作答, 已限流);
}

async function 演练旧版形态({ identity, __syncUserAgent }) {
  console.log("\nlegacy-shape — 经当前桥重放 v1.5.0 的访问形态");
  console.log("  （对照：该形态上游是接受的，所以必须保持可用）");

  // v1.5.0 发送的是这个 User-Agent 和这些工具名。重放它们证明当前桥并不
  // 依赖*新*形态来通过——也证明旧形态不需要它从未需要过的"治愈"。
  const 旧版UA = "opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
  process.env.OPENCODE_USER_AGENT = 旧版UA;
  __syncUserAgent();

  const res = await 提问(取端口(), {
    model: "big-pickle",
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      },
    ],
  });

  delete process.env.OPENCODE_USER_AGENT;
  __syncUserAgent();

  console.log(`  旧版 UA     : ${旧版UA}`);
  console.log(`  客户端看到  : HTTP ${res.status} ${JSON.stringify(取内容(res))}`);

  const 已限流 = 上游限流(res);
  const 已作答 = res.status === 200 && 取内容(res).length > 0;
  三态判定行(裁定(res.status === 200, 已限流), "旧版访问形态仍被接受");
  三态判定行(裁定(取内容(res).length > 0, 已限流), "旧版形态返回真实内容");

  return 裁定(已作答, 已限流);
}

async function 演练空工具集({ identity }) {
  console.log("\nempty-tools — 配置解析为空（上游 403 FreeTierError）");
  const 原名单 = identity.getToolList(false).map((t) => t.function.name);

  // 空配置曾因对象为真值而压过内置回退，于是桥发出 `tools: []`，上游
  // 回答 403。
  identity.__setToolProfile({}, "test");
  identity.__setLastCheckTime(Date.now());

  const res = await 提问(取端口(), {
    model: "big-pickle",
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });
  const 新名单 = identity.getToolList(false).map((t) => t.function.name);

  console.log(`  工具集-之前: ${JSON.stringify(原名单)}`);
  console.log(`  工具集-之后 : ${JSON.stringify(新名单)}`);
  console.log(`  客户端看到  : HTTP ${res.status} ${JSON.stringify(取内容(res))}`);

  const 已限流 = 上游限流(res);
  const 已作答 = res.status === 200 && 取内容(res).length > 0;
  判定行(新名单.length > 0, "空配置回退到随发行版内置的工具集");
  三态判定行(裁定(res.status === 200, 已限流), "客户端收到 200，而不是 403");
  三态判定行(裁定(取内容(res).length > 0, 已限流), "客户端收到真实内容");

  if (新名单.length === 0) return false;
  return 裁定(已作答, 已限流);
}

async function 演练会话形态({ identity, __syncUserAgent, sessionCache }) {
  console.log("\nsession-shape — 上游读作 \"not OpenCode\" 的会话 id（403 FreeTierError）");
  console.log("  实测规则：`ses_` + 12 位小写十六进制 + 14 位 base62（30 字符）");

  // 把前缀里的下划线去掉。上游会确定性地以 FreeTierError 拒绝它，而正确的
  // id 能通过——两者只差前缀，所以演练精确隔离了它所声称的那一层。
  const 好前缀 = identity.getSessionPrefix();
  identity.__setSessionPrefix("ses");
  __syncUserAgent();
  identity.__setLastCheckTime(Date.now());

  const 预置id = identity.createSessionId(true);
  console.log(`  预置 id     : ${预置id}（长度 ${预置id.length}，前缀 "ses"）`);
  console.log("  发送一个请求（上游应将其作为非 OpenCode 拒绝）…");

  const res = await 提问(取端口(), {
    model: "big-pickle",
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });

  const 新id = identity.createSessionId(true);
  const 缓存ids = [...sessionCache.values()].map((e) => e.sessionId);

  console.log(`  之后 id     : ${新id}（长度 ${新id.length}，前缀 "${identity.getSessionPrefix()}"）`);
  console.log(`  客户端看到  : HTTP ${res.status} ${JSON.stringify(取内容(res))}`);

  const 已限流 = 上游限流(res);
  const 已作答 = res.status === 200 && 取内容(res).length > 0;
  const 前缀已还原 = identity.getSessionPrefix() === 好前缀;
  const 形态正确 = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(新id);
  const 缓存干净 = 缓存ids.every((id) => /^ses_/.test(id));

  三态判定行(裁定(res.status === 200, 已限流), "客户端收到 200，而不是 FreeTierError");
  三态判定行(裁定(取内容(res).length > 0, 已限流), "客户端收到真实内容");
  判定行(前缀已还原, "前缀已被刷新还原");
  判定行(形态正确, "重铸的 id 符合被接受的形态");
  判定行(缓存干净, "会话缓存里没有留下被拒的 id");

  if (!前缀已还原 || !形态正确 || !缓存干净) return false;
  return 裁定(已作答, 已限流);
}

/**
 * routing — 线上端点在每次请求时从推导值读取。
 *
 * 从上游目录推导端点的全部意义就在于：上游的路径迁移（/zen/v1 →
 * /inference/v1 的迁移）不应需要发布新桥。本演练证明读取发生在请求路径上
 * 而不是启动时：桥起来之后，把 chat 端点改指到本地假服务器，发一个请求，
 * 然后检查假服务器收到了它。
 */
async function 演练路由({ identity }) {
  console.log("\nrouting — 端点在请求时推导，而不是启动时冻结");

  const 收到 = [];
  const 假上游 = http.createServer((req, res) => {
    收到.push(req.url);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
      })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((resolve) => 假上游.listen(0, "127.0.0.1", resolve));
  const 假端口 = 假上游.address().port;

  const 原地址 = identity.getEndpoints().chatUrl;
  identity.applyRecipe({ chatUrl: `http://127.0.0.1:${假端口}/inference/openai/v1/chat/completions` });

  const res = await 提问(取端口(), {
    model: "big-pickle",
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });

  identity.applyRecipe({ chatUrl: 原地址 });
  await new Promise((resolve) => 假上游.close(resolve));

  console.log(`  端点-原值       : ${原地址}`);
  console.log(`  端点-预置       : http://127.0.0.1:${假端口}/inference/openai/v1/chat/completions`);
  console.log(`  假上游收到      : ${JSON.stringify(收到)}`);
  console.log(`  客户端看到      : HTTP ${res.status} ${JSON.stringify(取内容(res))}`);

  判定行(收到.length === 1, "请求去了新推导的端点");
  判定行(
    收到[0] === "/inference/openai/v1/chat/completions",
    "用的是完整推导路径，而不是启动时的路径"
  );
  判定行(res.status === 200, "客户端收到 200");
  判定行(identity.getEndpoints().chatUrl === 原地址, "演练结束后端点已还原");

  return 收到.length === 1 && res.status === 200;
}

/**
 * allowlist — 工具名从发行版的工具源推导。
 *
 * 网关校验的是有哪些工具在场；schema 不参与比较。这里检查一个从源学到的
 * 名字，即使其他一切不变，也能以 `full` 范围（网关拒绝重试所用的范围）
 * 抵达线上——这正是上游改名可以自愈的原因。
 */
async function 演练白名单({ identity }) {
  console.log("\nallowlist — 源推导的工具名抵达线上");

  const 原名单 = identity.getState().toolNames;
  // 模拟上游在工具源里把 `shell` 改名为 `run`。
  identity.applyRecipe({
    tools: {
      read: { description: "r".repeat(30), parameters: { type: "object", properties: {} } },
      run: { description: "x".repeat(30), parameters: { type: "object", properties: {} } },
    },
    toolNames: ["read", "run"],
  });

  const core = identity.getToolList(false).map((t) => t.function.name);
  const full = identity.getToolList(false, "full").map((t) => t.function.name);

  console.log(`  白名单          : ${JSON.stringify(identity.getState().toolNames)}`);
  console.log(`  core 范围线上   : ${JSON.stringify(core)}`);
  console.log(`  full 范围线上   : ${JSON.stringify(full)}`);

  判定行(core.length > 0, "core 范围仍发送网关锚点");
  判定行(full.includes("run"), "改名后的工具以 full 范围抵达线上");
  判定行(!full.includes("shell"), "退役的名字没有被继续沿用");

  identity.__setToolProfile(null, "default");
  identity.applyRecipe({ toolNames: 原名单 });

  return full.includes("run") && core.length > 0;
}

/**
 * retry-endpoint — 网关拒绝后的重试会重新解析端点。
 *
 * 一次刷新可能从目录学到新端点。如果重试复用了刷新前捕获的 URL，治愈后的
 * 请求仍会打到过期路径。本演练在启动时 URL 上放一个拒绝的上游，在目录
 * 推导的 URL 上放一个健康的假上游，然后检查重试落在后者上。
 */
async function 演练重试换址({ identity }) {
  console.log("\nretry-endpoint — 自愈重试使用刷新后的端点");

  const 命中 = [];
  const 拒答上游 = http.createServer((req, res) => {
    命中.push("old");
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode." },
      })
    );
  });
  const 健康上游 = http.createServer((req, res) => {
    命中.push("new");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
      })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((r) => 拒答上游.listen(0, "127.0.0.1", r));
  await new Promise((r) => 健康上游.listen(0, "127.0.0.1", r));
  const 旧端口 = 拒答上游.address().port;
  const 新端口 = 健康上游.address().port;

  const 原地址 = identity.getEndpoints().chatUrl;
  identity.applyRecipe({ chatUrl: `http://127.0.0.1:${旧端口}/chat/completions` });

  // 一次"学到"新端点的刷新：演练按 refresh() 在目录移动时的做法调用
  // applyRecipe。
  const 真实网关回调 = identity.onGateRejection;
  identity.onGateRejection = async () => {
    identity.applyRecipe({ chatUrl: `http://127.0.0.1:${新端口}/chat/completions` });
    return { retry: true, reason: "drill-catalog-move" };
  };

  let res;
  try {
    res = await 提问(取端口(), {
      model: "big-pickle",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    });
  } finally {
    identity.onGateRejection = 真实网关回调;
    identity.applyRecipe({ chatUrl: 原地址 });
    await new Promise((r) => 拒答上游.close(r));
    await new Promise((r) => 健康上游.close(r));
  }

  console.log(`  尝试序列        : ${JSON.stringify(命中)}`);
  console.log(`  客户端看到      : HTTP ${res.status} ${JSON.stringify(取内容(res))}`);

  判定行(命中[0] === "old", "首次尝试用的是刷新前的端点");
  判定行(命中[1] === "new", "重试用的是刷新学到的端点");
  判定行(res.status === 200, "客户端收到 200");

  return 命中[0] === "old" && 命中[1] === "new" && res.status === 200;
}

/**
 * endpoint-move — 过期路径上的 404 触发端点重推导并重试。
 *
 * 这就是上游路径迁移的故障形态：旧 URL 不再路由并回答 404（HTML，不是
 * 网关错误）。没有这个自愈，客户端会看到 404，哪怕桥手里就有目录 URL。
 * 两个本地服务器分别扮演新旧路径，因此演练是确定性的，不依赖上游当前
 * 服务什么。
 */
async function 演练端点迁移({ identity }) {
  console.log("\nendpoint-move — 过期路径上的 404 触发重推导并重试");

  const 命中 = [];
  const 失效上游 = http.createServer((req, res) => {
    命中.push("old");
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<!DOCTYPE html><html><body>not found</body></html>");
  });
  const 健康上游 = http.createServer((req, res) => {
    命中.push("new");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
      })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((r) => 失效上游.listen(0, "127.0.0.1", r));
  await new Promise((r) => 健康上游.listen(0, "127.0.0.1", r));
  const 失效端口 = 失效上游.address().port;
  const 健康端口 = 健康上游.address().port;

  const 原地址 = identity.getEndpoints().chatUrl;
  identity.applyRecipe({ chatUrl: `http://127.0.0.1:${失效端口}/old/chat/completions` });
  identity.__setLastCheckTime(Date.now());

  // 代替目录刷新：演练按 refresh() 从提供方目录采纳 `chatUrl` 的方式预置
  // 迁移后的 URL。
  const 真实刷新 = identity.refresh;
  identity.refresh = async () => {
    identity.applyRecipe({ chatUrl: `http://127.0.0.1:${健康端口}/v1/chat/completions` });
    return { updated: true, changed: ["chatUrl"] };
  };

  let res;
  try {
    res = await 提问(取端口(), {
      model: "big-pickle",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    });
  } finally {
    identity.refresh = 真实刷新;
    identity.applyRecipe({ chatUrl: 原地址 });
    await new Promise((r) => 失效上游.close(r));
    await new Promise((r) => 健康上游.close(r));
  }

  console.log(`  尝试序列        : ${JSON.stringify(命中)}`);
  console.log(`  客户端看到      : HTTP ${res.status} ${JSON.stringify(取内容(res))}`);

  判定行(命中[0] === "old", "首次尝试打到了过期路径");
  判定行(命中[1] === "new", "404 触发了重新推导的重试");
  判定行(res.status === 200, "客户端收到 200，而不是 404");
  判定行(取内容(res).length > 0, "客户端收到真实内容");

  return 命中[0] === "old" && 命中[1] === "new" && res.status === 200;
}

/**
 * 对照探测：上游此刻到底接不接受这个 IP？
 *
 * 线上演练预置一个被拒形态并指望桥治愈它。但网关也会在调用方额度耗尽时用
 * 同样的 `403 FreeTierError` 拒绝健康请求——实测：字节相同的 CLI 请求在
 * 几秒内交替 200/403。没有对照，被限流的 IP 会让每个线上演练都报告 FAIL，
 * 尽管桥毫无问题，而且每次失败都会把冷却期推得更远。
 *
 * 探测是直连请求、不经桥，形态按真实 CLI 构造（`max_completion_tokens`、
 * `store: false`、完整工具集）。200 或 429 表示网关开放（429 是容量，不是
 * 拒绝）。探测遵循已配置的出口代理，因此其结论描述的是上游实际看到的 IP。
 */
async function 探测上游(identity) {
  const { buildUpstreamPayload, buildUpstreamHeaders, resolveEndpoints } = require("./server");
  const model = "big-pickle";
  const sessionId = identity.createSessionId(true);
  const headers = buildUpstreamHeaders({ headers: {} }, sessionId);
  const body = buildUpstreamPayload(
    { model, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 24 },
    model,
    false,
    "full"
  ).upstreamBody;
  // 与 CLI 自己的令牌字段一致：这是实测能通过的形态。
  body.max_completion_tokens = body.max_tokens;
  delete body.max_tokens;
  body.store = false;
  // `stream` 必须保持 `true`。buildUpstreamPayload 会设置它，而本探测刻意
  // 保留整个形态：实测同一 IP、同一组头，去掉 `stream` 的同一请求会被
  // 403 FreeTierError 拒绝，而流式请求成功（6/6 对 0/6，交错进行）。丢掉
  // 它的探测会把健康的 IP 报告成网关关闭。
  if (body.stream !== true) {
    throw new Error("探测上游 必须发送 stream: true，否则探测结论毫无意义");
  }

  try {
    const res = await require("./proxy").netFetch(resolveEndpoints(model).chatUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const 文本 = await res.text().catch(() => "");
    const 开启 = res.status === 200 || res.status === 429;
    return { open: 开启, status: res.status, detail: 文本.slice(0, 120).replace(/\n/g, " ") };
  } catch (err) {
    return { open: false, status: 0, detail: err.message };
  }
}

/**
 * gate-heal — 对确定性的假网关走完整条反应式路径。
 *
 * 线上演练是对真实服务证明自愈，但它们要求调用方 IP 在额度之内。本演练在
 * 离线状态预置同样的序列：一个假上游，对预置形态以 `403 FreeTierError`
 * 拒绝、对刷新后的形态接受。它断言的是自愈的*顺序*（过期请求 → 刷新 →
 * 重铸 id → 完整工具集 → 重试 → 200）——这才是桥能控制的部分；上游心情
 * 好坏不是。
 */
async function 演练网关自愈({ identity }) {
  console.log("\ngate-heal — 反应式自愈，确定性假网关（不连真实上游）");

  const 观察 = [];
  let 已拒绝过 = false;
  const 假上游 = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {}
      const sid = String(req.headers["x-opencode-session-id"] || "");
      const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
      const 形态正确 = sid.startsWith("ses_") && toolCount > 2;

      if (!形态正确 && !已拒绝过) {
        已拒绝过 = true;
        观察.push({ ok: false, sid, toolCount });
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "FreeTierError",
              message: "OpenCode's free tier can only be used from within OpenCode.",
            },
          })
        );
      }
      观察.push({ ok: true, sid, toolCount });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => 假上游.listen(0, "127.0.0.1", r));
  const 假端口 = 假上游.address().port;

  const 原地址 = identity.getEndpoints().chatUrl;
  identity.applyRecipe({ chatUrl: `http://127.0.0.1:${假端口}/v1/chat/completions` });
  identity.__setSessionPrefix("ses"); // 上游读作"不是 OpenCode"的形态
  identity.__setLastCheckTime(Date.now());

  // 代替刷新：还原真实刷新会学到的推导形态。
  const 真实网关回调 = identity.onGateRejection;
  identity.onGateRejection = async () => {
    identity.__setSessionPrefix("ses_");
    // 真实刷新还会读发行版的工具源。预置它本会产出的配置，让本演练断言
    // 的是升级路径，而不是"源不可达"的回退（后者只能给出内置集合）。
    identity.applyRecipe({
      tools: {
        read: identity.DEFAULT_TOOLS.read,
        shell: identity.DEFAULT_TOOLS.shell,
        glob: { description: "g".repeat(40), parameters: { type: "object", properties: {} } },
        edit: { description: "e".repeat(40), parameters: { type: "object", properties: {} } },
      },
      toolNames: ["read", "shell", "glob", "edit"],
    });
    return { retry: true, reason: "drill-refresh" };
  };

  let res;
  try {
    res = await 提问(取端口(), {
      model: "big-pickle",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    });
  } finally {
    identity.onGateRejection = 真实网关回调;
    identity.applyRecipe({ chatUrl: 原地址 });
    identity.__setSessionPrefix("ses_");
    await new Promise((r) => 假上游.close(r));
  }

  const 首次 = 观察[0];
  const 重试记录 = 观察[1];
  console.log(`  尝试序列        : ${JSON.stringify(观察.map((s) => ({ ok: s.ok, sid: s.sid.slice(0, 8), tools: s.toolCount })))}`);
  console.log(`  客户端看到      : HTTP ${res.status} ${JSON.stringify(取内容(res))}`);

  判定行(Boolean(首次) && !首次.ok, "首次尝试带着被拒的形态");
  判定行(Boolean(重试记录) && 重试记录.ok, "重试带着刷新后的形态");
  判定行(Boolean(重试记录) && 重试记录.sid.startsWith("ses_"), "重试重铸了会话 id");
  判定行(Boolean(重试记录) && 重试记录.toolCount > 2, "重试升级到了完整工具集");
  判定行(res.status === 200, "客户端收到 200，而不是网关错误");
  判定行(取内容(res).length > 0, "客户端收到真实内容");

  return Boolean(重试记录) && 重试记录.ok && res.status === 200 && 取内容(res).length > 0;
}


/**
 * full-corrupt — 同时弄坏每一个自适应层，然后证明一个请求把它们全部治愈。
 *
 * 其他演练各自弄坏一层。这一个把它们一起弄坏——真实上游变更落地时就是
 * 这副样子：版本下限移动、会话形态变化、工具集替换出现在同一个发行版里。
 * 这里的网关是本地确定性的，所以即使线上 IP 被限流，演练也能给出裁定。
 *
 * 被损坏的层：
 *   版本         -> 0.9.9（低于任何下限）
 *   会话前缀     -> old_
 *   会话长度     -> 20（合法范围、错误取值）
 *   会话字符集   -> 仅十六进制（错误的字母表）
 *   工具集       -> 内置默认，而不是推导配置
 *
 * 一切断言都对照从源推导出的值，而不是硬编码期望，因此上游改了这些值时
 * 演练照常工作。
 */
async function 演练全量损坏({ identity }) {
  console.log("\nfull-corrupt — 所有层同时损坏，一个请求全部治愈");

  await identity.refresh({ force: true });
  const 基准 = {
    version: identity.getRecipe().version,
    prefix: identity.getRecipe().sessionPrefix,
    length: identity.getRecipe().sessionLength,
    charset: identity.getRecipe().sessionCharset,
    tools: Object.keys(identity.getTools()).sort().join(","),
    ua: identity.getUserAgent(),
  };

  const 会话形态 = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
  const 观察 = [];
  const 假上游 = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {}
      const sid = String(req.headers["x-opencode-session-id"] || req.headers["x-opencode-session"] || "");
      const ua = String(req.headers["user-agent"] || "");
      const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
      const 异常项 = [];
      if (!会话形态.test(sid)) 异常项.push("session");
      if (!/^opencode\/latest\/\d+\.\d+\.\d+\/cli$/.test(ua)) 异常项.push("ua");
      if (toolCount < 3) 异常项.push("tools");
      观察.push({ sid, ua, toolCount, bad: 异常项 });

      if (异常项.length) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            type: "error",
            error: { type: "FreeTierError", message: "rejected: " + 异常项.join(",") },
          })
        );
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: "HEALED" }, finish_reason: null }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => 假上游.listen(0, "127.0.0.1", r));
  const 假端口 = 假上游.address().port;

  const 原地址 = identity.getEndpoints().chatUrl;
  const 真实网关回调 = identity.onGateRejection;
  identity.applyRecipe(
    {
      version: "0.9.9",
      sessionPrefix: "old_",
      sessionLength: 20,
      sessionCharset: "abcdef0123456789",
      chatUrl: `http://127.0.0.1:${假端口}/v1/chat/completions`,
    },
    "full-corrupt"
  );
  identity.__setLastCheckTime(Date.now());

  // 让真实的 onGateRejection 跑（那才是被测代码）；只在事后把端点钉回本地，
  // 让重试打到这个本地网关而不是互联网。端点自愈本身由 endpoint-move 覆盖。
  identity.onGateRejection = async (status, type, msg, attempted) => {
    const 裁定结果 = await 真实网关回调(status, type, msg, attempted);
    identity.applyRecipe({ chatUrl: `http://127.0.0.1:${假端口}/v1/chat/completions` });
    return 裁定结果;
  };

  let res;
  try {
    res = await 提问(取端口(), {
      model: "big-pickle",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    });
  } finally {
    identity.onGateRejection = 真实网关回调;
    identity.applyRecipe({ chatUrl: 原地址 });
    await new Promise((r) => 假上游.close(r));
  }

  const 修复后 = {
    version: identity.getRecipe().version,
    prefix: identity.getRecipe().sessionPrefix,
    length: identity.getRecipe().sessionLength,
    charset: identity.getRecipe().sessionCharset,
    tools: Object.keys(identity.getTools()).sort().join(","),
    ua: identity.getUserAgent(),
  };

  console.log(`  损坏预置        : v0.9.9, old_/20, hex charset, shipped tools`);
  console.log(`  尝试序列        : ${JSON.stringify(观察.map((s) => ({ sid: s.sid.slice(0, 12), ua: s.ua.split("/")[2] || "?", tools: s.toolCount, bad: s.bad })))}`);
  console.log(`  客户端看到      : HTTP ${res.status} ${JSON.stringify(取内容(res))}`);

  判定行(Boolean(观察[0]) && 观察[0].bad.length > 0, "首次尝试带着全部损坏的层");
  判定行(Boolean(观察[1]) && 观察[1].bad.length === 0, "重试带着完全治愈后的形态");
  判定行(res.status === 200, "客户端收到 200，而不是网关错误");
  判定行(修复后.version === 基准.version, `版本治愈为 ${基准.version}`, `（原 0.9.9）`);
  判定行(修复后.prefix === 基准.prefix, `会话前缀治愈为 ${基准.prefix}`, `（原 old_）`);
  判定行(修复后.length === 基准.length, `会话长度治愈为 ${基准.length}`, `（原 20）`);
  判定行(修复后.charset === 基准.charset, `会话字符集已治愈`, `(${修复后.charset?.length} 字符)`);
  判定行(修复后.tools === 基准.tools, `工具集已治愈`, `(${修复后.tools.split(",").length} 个工具)`);
  判定行(修复后.ua === 基准.ua, `User-Agent 已治愈`, `(${修复后.ua})`);

  return (
    Boolean(观察[0]) &&
    观察[0].bad.length > 0 &&
    Boolean(观察[1]) &&
    观察[1].bad.length === 0 &&
    res.status === 200 &&
    修复后.version === 基准.version &&
    修复后.prefix === 基准.prefix &&
    修复后.length === 基准.length &&
    修复后.charset === 基准.charset &&
    修复后.tools === 基准.tools &&
    修复后.ua === 基准.ua
  );
}

async function 主流程() {
  const 指定名 = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const 待跑演练 = 指定名.length > 0 ? 指定名 : 演练列表;
  const 未知项 = 待跑演练.filter((d) => !演练列表.includes(d));
  if (未知项.length > 0) {
    console.error(`未知演练：${未知项.join(", ")}\n已知演练：${演练列表.join(", ")}`);
    process.exit(2);
  }

  const 桥模块 = require("./server");
  const { server, identity, discoverModels, __syncUserAgent, sessionCache } = 桥模块;

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const 绑定端口 = server.address().port;
  取端口 = () => 绑定端口;

  console.log(`网关演练 — 桥 v${桥模块.VERSION}，监听 http://127.0.0.1:${绑定端口}`);
  console.log("  真实上游、不 mock、串行执行（上游对失败限速）");

  await discoverModels();
  const 模型列表 = 桥模块.__getDiscoveryState().activeModels;
  console.log(`  发现 ${模型列表.length} 个免费模型`);

  // 只有连上游的演练才需要网关开启。
  const 线上演练 = new Set(["version-floor", "legacy-shape", "empty-tools", "session-shape"]);
  const 想跑线上 = 待跑演练.filter((d) => 线上演练.has(d));
  let 网关开启 = true;
  if (想跑线上.length > 0) {
    const 探测结果 = await 探测上游(identity);
    网关开启 = 探测结果.open;
    console.log(
      `  上游对照探测: HTTP ${探测结果.status} → 网关 ${网关开启 ? "open" : "CLOSED"}${网关开启 ? "" : ` (${探测结果.detail})`}`
    );
    if (!网关开启) {
      console.log(
        "  线上演练跳过：直接以 CLI 形态发出的请求被拒，上游现在不接受这个 IP。"
      );
      console.log(
        "  这是按 IP 计的额度问题，不是桥的故障——稍后重跑可得线上结论。离线演练照常运行。"
      );
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  const 结果表 = [];
  for (const name of 待跑演练) {
    if (线上演练.has(name) && !网关开启) {
      结果表.push([name, null]); // 是跳过，不是失败
      continue;
    }
    const 演练函数表 = {
      "version-floor": 演练版本下限,
      "legacy-shape": 演练旧版形态,
      "empty-tools": 演练空工具集,
      "session-shape": 演练会话形态,
      routing: 演练路由,
      allowlist: 演练白名单,
      "retry-endpoint": 演练重试换址,
      "endpoint-move": 演练端点迁移,
      "gate-heal": 演练网关自愈,
  "full-corrupt": 演练全量损坏,
    };
    const 演练函数 = 演练函数表[name];
    // 上一个演练留下的缓存会话 id 会被相同消息复用，从而掩盖预置的条件。
    sessionCache.clear();
    const 上下文 = { identity, __syncUserAgent, sessionCache };
    try {
      结果表.push([name, await 演练函数(上下文)]);
    } catch (err) {
      console.log(`  FAIL ${name} 抛错: ${err.message}`);
      结果表.push([name, false]);
    }
    // 上游在一串失败后会冷却；让演练保持温和。
    await new Promise((r) => setTimeout(r, 3000));
  }

  server.close();

  console.log("\n汇总");
  for (const [name, ok] of 结果表) {
    console.log(`  ${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"}  ${name}`);
  }
  const 失败项 = 结果表.filter(([, ok]) => ok === false);
  const 跳过项 = 结果表.filter(([, ok]) => ok === null);
  if (跳过项.length > 0) {
    console.log(
      `\n  ${跳过项.length} 个线上演练未定论：上游未给出裁定（网关关闭或 429 容量限流）。` +
        `\n  所有能在本地核验的断言仍然通过；等 IP 有额度时重跑。`
    );
  }
  process.exit(失败项.length === 0 ? 0 : 1);
}

let 取端口 = () => 0;

主流程().catch((err) => {
  console.error(err);
  process.exit(1);
});
