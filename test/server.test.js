const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pkg = require("../package.json");
const {
  VERSION,
  MAX_SESSIONS,
  CANONICAL_TOOLS_CHAT,
  CANONICAL_TOOLS_RESPONSES,
  sessionCache,
  createId,
  normalizeModel,
  isResponsesModel,
  markProtocolSupport,
  prepareToolsWithFingerprint,
  restoreClientToolName,
  buildUpstreamHeaders,
  buildUpstreamPayload,
  getPersistentSessionId,
  readRequestBody,
  server,
  identity,
  discoverModels,
  __getDiscoveryState,
} = require("../server");
const srv_markProtocolSupport = require("../server").markProtocolSupport;
function sseStreamFromLines(lines) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

function httpRequest(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined
        ? null
        : typeof body === "string"
          ? body
          : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload !== null
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
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

describe("server unit & integration tests", () => {
  beforeEach(() => {
    sessionCache.clear();
  });

  it("keeps VERSION synced with package.json", () => {
    assert.equal(VERSION, pkg.version);
  });
  it("normalizeModel rejects empty/missing models and strips provider prefixes", () => {
    assert.equal(normalizeModel(undefined), "");
    assert.equal(normalizeModel(null), "");
    assert.equal(normalizeModel(""), "");
    assert.equal(normalizeModel("   "), "");
    assert.equal(normalizeModel("oc/"), "");
    // 别名现在只来自目录（它的 `family` 字段）或磁盘目录缓存 —— 绝不来自
    // 本仓库里的表。没有目录时这些解析不到任何东西，字面名字原样透传，
    // 这是诚实的答案：桥不发明模型名。
    const { identity } = require("../server");
    const canDerive = Boolean(identity.resolveModelAlias("mimo"));
    if (canDerive) {
      assert.equal(normalizeModel("zen/mimo"), "mimo-v2.6-flash-free");
      // 目录把 `longcat` 家族指向当下的具体修订；断言"解析到 longcat 家族的
      // 某个真实 id"而不是钉死某个修订号 —— 上游换修订不该让测试变红。
      const longcat = normalizeModel("opencode/longcat");
      assert.match(longcat, /^longcat-[0-9.]+(-preview)?-free$/);
      assert.equal(longcat, identity.resolveModelAlias("longcat"));
    } else {
      assert.equal(normalizeModel("zen/mimo"), "mimo");
      assert.equal(normalizeModel("opencode/longcat"), "longcat");
    }
    // `cat-jam` 过去映射到 `cat-jam-free`。目录现在把该模型标记为退役，
    // 所以别名不再解析到它：发送已退役的 id 只会从上游挣到 410。
    // 简写落到字面名字，调用方得到真实的"模型不可用"。
    assert.equal(normalizeModel("cat-jam"), "cat-jam");
    assert.notEqual(normalizeModel("muse-spark"), "muse-spark-1.3-contributor-free");
  });

  it("createId never overflows the 12-bit counter into timestamp bits and keeps counter <= 16", () => {
    const ts = 1_760_000_000_000;
    const seen = new Set();
    for (let i = 0; i < 64; i++) {
      const id = createId(true, ts);
      assert.match(id, /^[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      seen.add(id);
      const invertedPrefix = BigInt(`0x${id.slice(0, 12)}`);
      const decoded = ~invertedPrefix & ((1n << 48n) - 1n);
      const counterBits = Number(decoded & 0xfffn);
      const decodedTs = decoded >> 12n;
      const expectedTs36 = BigInt(ts + Math.floor(i / 16)) & ((1n << 36n) - 1n);
      assert.ok(counterBits >= 1 && counterBits <= 16, `counter ${counterBits} out of 1..16`);
      assert.equal(decodedTs, expectedTs36);
    }
    assert.equal(seen.size, 64);
  });

  it("getPersistentSessionId evicts least-recently-used (LRU) session instead of FIFO", () => {
    for (let i = 0; i < MAX_SESSIONS; i++) {
      getPersistentSessionId({ headers: { "x-session-id": `s-${i}` } }, {});
    }
    assert.equal(sessionCache.size, MAX_SESSIONS);

    // 触碰 s-0 使其成为最近使用；s-1 现在是 LRU
    const s0Before = getPersistentSessionId({ headers: { "x-session-id": "s-0" } }, {});
    // 插入超出容量的新会话
    getPersistentSessionId({ headers: { "x-session-id": "s-new" } }, {});

    assert.equal(sessionCache.has("hdr:s-0"), true, "Touched session s-0 must not be evicted");
    assert.equal(sessionCache.has("hdr:s-1"), false, "Oldest untouched session s-1 must be evicted");
    const s0After = getPersistentSessionId({ headers: { "x-session-id": "s-0" } }, {});
    assert.equal(s0After, s0Before);
  });

  it("buildUpstreamHeaders and buildUpstreamPayload satisfy OpenCode v2 /inference/v1 gate", () => {
    // identity 在模块加载时热启动磁盘上的发行版缓存。缓存内容随机器而变，
    // 而这里断言的是随发行版内置的形态，所以先清空推导状态再断言。
    identity.__reset();
    identity.__setLastCheckTime(Date.now());
    const sessionId = "ses_" + createId(true);
    const headers = buildUpstreamHeaders({ headers: { "user-agent": "OpenAI/Python" } }, sessionId);
    assert.match(headers["User-Agent"], /^opencode\/latest\/\d+\.\d+\.\d+\/cli$/);
    assert.equal(headers["x-opencode-client"], "cli");
    assert.equal(headers["x-opencode-session"], sessionId);
    assert.equal(headers["x-opencode-session-id"], sessionId);
    assert.equal(headers["x-session-affinity"], sessionId);
    assert.equal(headers["x-session-id"], sessionId);
    assert.equal("x-opencode-request" in headers, false);

    // 带客户端 'read' 工具冲突 + longcat 上 max_tokens: 50 的 Chat 负载
    identity.applyRecipe({
      modelFacts: { "longcat-2.5-preview-free": { reasoning: true, maxOutput: 131072 } },
    });
    const { upstreamBody, aliasToOriginal } = buildUpstreamPayload(
      {
        model: "big-pickle",
        max_tokens: 50,
        tool_choice: "none",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "Custom client read tool",
              parameters: { type: "object", properties: { file: { type: "string" } } },
            },
          },
        ],
      },
      "longcat-2.5-preview-free",
      false
    );

    // 加法预算：max(50, 1024) + 4096 = 5120。字段按 CLI 的拼法写
    // （`max_completion_tokens`），并发送 `store: false`。
    assert.equal(upstreamBody.max_completion_tokens, 5120);
    assert.equal(upstreamBody.store, false);
    assert.equal("max_tokens" in upstreamBody, false, "the legacy field must not be sent");
    assert.deepEqual(upstreamBody.stream_options, { include_usage: true });
    assert.equal("tool_choice" in upstreamBody, false, "tool_choice: 'none' must be omitted");

    const toolNames = upstreamBody.tools.map((t) => t.function.name);
    assert.deepEqual(toolNames, ["read_client", "read", "shell"]);
    assert.equal(aliasToOriginal.get("read_client"), "read");

    // Responses 负载把 system/developer 消息提取进 instructions，保留图片，并转发 temperature/top_p
    const { upstreamBody: respBody } = buildUpstreamPayload(
      {
        model: "muse-spark-1.3-contributor-free",
        temperature: 0.2,
        top_p: 0.9,
        messages: [
          { role: "system", content: "You are a concise assistant." },
          { role: "developer", content: "Always answer in Indonesian." },
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
            ],
          },
        ],
      },
      "muse-spark-1.3-contributor-free",
      true
    );
    assert.match(respBody.instructions, /You are a concise assistant\./);
    assert.match(respBody.instructions, /Always answer in Indonesian\./);
    assert.match(respBody.instructions, /Do not call the `read` or `shell` tools/);
    assert.equal(respBody.input.length, 1);
    assert.equal(respBody.input[0].role, "user");
    assert.deepEqual(respBody.input[0].content, [
      { type: "input_text", text: "What is in this image?" },
      { type: "input_image", image_url: "https://example.com/cat.png" },
    ]);
    assert.equal(respBody.temperature, 0.2);
    assert.equal(respBody.top_p, 0.9);
  });

  it("adds the harness <env> block the gateway requires, in both lanes", () => {
    // 2026-10-25 实测：没有 `<env>` + `Working directory:` 行的系统提示
    // 会被回 `429 FreeUsageLimitError` —— 与额度耗尽相同的消息 ——
    // 而 65 字节的 env 块能过。12 KB 的通用提示仍然失败，所以这是形态锚点，
    // 不是长度规则。两条通道都必须携带它，否则桥看起来像被限流。
    const envRe = /<env>[\s\S]*?Working directory:[\s\S]*?<\/env>/;
    const model = "glm-5.3-flash-free";
    const user = { role: "user", content: "hi" };

    // Chat 通道，完全没有系统消息：会合成一条。
    const bare = buildUpstreamPayload({ model, messages: [user] }, model, false, "core").upstreamBody;
    assert.match(bare.messages[0].content, envRe);
    assert.equal(bare.messages[0].role, "system");

    // Chat 通道，客户端系统提示很短：追加该块，
    // 客户端自己的文本原样保留。
    const short = buildUpstreamPayload(
      { model, messages: [{ role: "system", content: "You are helpful." }, user] },
      model,
      false,
      "core"
    ).upstreamBody;
    assert.match(short.messages[0].content, /^You are helpful\./);
    assert.match(short.messages[0].content, envRe);

    // 已经转发 CLI 提示的客户端保留自己的块 ——
    // 恰好一次，不重复。
    const own = "<env>\n  Working directory: /x\n</env>";
    const forwarded = buildUpstreamPayload(
      { model, messages: [{ role: "system", content: `prompt\n\n${own}` }, user] },
      model,
      false,
      "core"
    ).upstreamBody;
    assert.equal(forwarded.messages[0].content.match(/<env>/g).length, 1);
    assert.match(forwarded.messages[0].content, /Working directory: \/x/);

    // Responses 通道在 `instructions` 里携带同一个锚点。
    const responses = buildUpstreamPayload(
      { model, messages: [{ role: "system", content: "You are helpful." }, user] },
      model,
      true,
      "core"
    ).upstreamBody;
    assert.match(responses.instructions, envRe);
  });
  it("avoids session hash collisions when headerless requests share a >1000-char prefix", () => {
    const sharedPrefix = "S".repeat(2000);
    const bodyA = {
      messages: [
        { role: "system", content: sharedPrefix },
        { role: "user", content: sharedPrefix + "::conversation-A" },
      ],
    };
    const bodyB = {
      messages: [
        { role: "system", content: sharedPrefix },
        { role: "user", content: sharedPrefix + "::conversation-B" },
      ],
    };
    const sA = getPersistentSessionId({ headers: {} }, bodyA);
    const sB = getPersistentSessionId({ headers: {} }, bodyB);
    assert.notEqual(sA, sB, "Different tails after a shared 2000-char prefix must not collide");
    assert.equal(getPersistentSessionId({ headers: {} }, bodyA), sA);
  });

  it("detaches listeners and pauses stream immediately when chunked body exceeds maxBytes", async () => {
    const { EventEmitter } = require("node:events");
    const fakeReq = new EventEmitter();
    fakeReq.headers = {};
    let paused = false;
    fakeReq.pause = () => {
      paused = true;
    };
    const p = readRequestBody(fakeReq, 10);
    fakeReq.emit("data", Buffer.from("0123456789ABCDEF"));
    await assert.rejects(p, /exceeds limit/);
    assert.equal(paused, true);
    assert.equal(fakeReq.listenerCount("data"), 0);
    assert.equal(fakeReq.listenerCount("end"), 0);
    assert.equal(fakeReq.listenerCount("error"), 0);
  });

  it("returns the fingerprint tools on zero-tool requests, shaped per protocol lane", () => {
    const chat = prepareToolsWithFingerprint([], false);
    const responses = prepareToolsWithFingerprint([], true);

    // 定义从实时配置解析，所以对照 identity 报告的内容，
    // 而不是冻结的模块常量。
    const names = identity.getToolList(false).map((t) => t.function.name);
    assert.deepEqual(
      chat.tools.map((t) => t.function.name),
      names
    );
    assert.deepEqual(
      responses.tools.map((t) => t.name),
      names
    );
    assert.equal(chat.aliasToOriginal.size, 0);
    // Chat 把定义嵌在 `function` 下；Responses 则平铺。
    assert.ok(chat.tools.every((t) => t.function && t.type === "function"));
    assert.ok(responses.tools.every((t) => !t.function && t.type === "function"));
  });

  it("renames a client tool upstream refuses by name, then restores it on the way back", () => {
    // 对线上网关实测：唯一毛病是工具名为 `run_code` 的请求
    // 会回 `429 FreeUsageLimitError`，而同样模式在 `run-code`、`runcode`、
    // `run_program` 或 `code_exec` 下回 `200`。拒绝是披着额度措辞的名字
    // 过滤器，所以桥用可接受的名字发送该工具，并为客户端映射回去。
    const tool = (name) => ({
      type: "function",
      function: {
        name,
        description: "Execute a program",
        parameters: { type: "object", properties: { code: { type: "string" } } },
      },
    });

    const chat = prepareToolsWithFingerprint([tool("run_code")], false);
    const chatNames = chat.tools.map((t) => t.function.name);
    assert.ok(chatNames.includes("run_program"));
    assert.ok(!chatNames.some((n) => /run_code/.test(n)));
    assert.equal(chat.aliasToOriginal.get("run_program"), "run_code");
    assert.equal(chat.originalToAlias.get("run_code"), "run_program");
    assert.equal(restoreClientToolName("run_program", chat.aliasToOriginal), "run_code");
    // 无关的名字原样透传。
    assert.equal(restoreClientToolName("pwsh", chat.aliasToOriginal), "pwsh");

    const responses = prepareToolsWithFingerprint([tool("run_code")], true);
    assert.ok(responses.tools.some((t) => t.name === "run_program"));
    assert.ok(!responses.tools.some((t) => /run_code/.test(t.name)));

    // 已经拥有别名的客户端保留它；改名副本让位，
    // 而不是遮蔽一个活工具。
    const both = prepareToolsWithFingerprint([tool("run_program"), tool("run_code")], false);
    const bothNames = both.tools.map((t) => t.function.name);
    assert.ok(bothNames.includes("run_program"));
    assert.ok(bothNames.includes("run_program2"));
    assert.equal(both.aliasToOriginal.get("run_program2"), "run_code");
  });

  it("generates 10,000 session IDs using pooled random bytes in <25ms", () => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 10_000; i++) {
      createId(true, 1_760_000_000_000 + i);
    }
    const dtMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(dtMs < 50, `10k createId calls took ${dtMs.toFixed(2)}ms`);
  });
  describe("HTTP endpoint behavior (mocked upstream fetch)", () => {
    let port;
    let originalFetch;
    let mockFetchImpl;

    before(async () => {
      originalFetch = global.fetch;
      global.fetch = async (...args) => mockFetchImpl(...args);
      await new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          port = server.address().port;
          resolve();
        });
      });
    });

    // 身份层从请求路径惰性刷新。这些测试断言桥发出的确切上游调用，
    // 所以每个用例前把身份标记为新鲜：否则后台刷新会表现为额外抓取，
    // 让调用计数断言变得含糊。
    beforeEach(() => {
      identity.__reset();
      identity.__setLastCheckTime(Date.now());
      // 通道分配是有意学习和保留的（上游告诉我们的），
      // 所以播种它的用例不得泄漏到下一个。
      require("../server").__resetProtocolLanes();
    });

    after(async () => {
      global.fetch = originalFetch;
      await new Promise((resolve) => server.close(resolve));
    });

    it("returns 400 when model is missing or empty, and 400 on invalid JSON", async () => {
      const rMissing = await httpRequest(port, "POST", "/v1/chat/completions", {
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(rMissing.status, 400);
      assert.equal(rMissing.body.error.code, "model_required");

      const rEmpty = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "   ",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(rEmpty.status, 400);
      assert.equal(rEmpty.body.error.code, "model_required");

      const rBadJson = await httpRequest(port, "POST", "/v1/chat/completions", "{bad json");
      assert.equal(rBadJson.status, 400);
      assert.equal(rBadJson.body.error.code, "invalid_json");
    });

    it("propagates real usage and finish_reason='length' in non-streaming Chat Completions", async () => {
      let capturedBody = null;
      mockFetchImpl = async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"choices":[{"index":0,"delta":{"reasoning":"thinking...","content":"partial answer"},"finish_reason":null}],"usage":null}\n\n',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":null}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":512,"total_tokens":632}}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      };
      // 推理状态来自目录（`modelFacts`），
      // 而不是 token-budget.js 里的子串列表。
      identity.applyRecipe({
        modelFacts: { "cat-jam-free": { reasoning: true, maxOutput: 131072 } },
      });
      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "cat-jam-free",
        max_tokens: 0,
        stream: false,
        messages: [{ role: "user", content: "Tell a story" }],
      });

      assert.equal(res.status, 200);
      assert.equal(capturedBody.max_completion_tokens, 5120);
      assert.deepEqual(capturedBody.stream_options, { include_usage: true });
      assert.equal(res.body.choices[0].message.content, "partial answer");
      assert.equal(res.body.choices[0].message.reasoning_content, "thinking...");
      assert.equal(res.body.choices[0].finish_reason, "length");
      assert.deepEqual(res.body.usage, {
        prompt_tokens: 120,
        completion_tokens: 512,
        total_tokens: 632,
      });
    });

    it("applies configured reasoning effort when the client omits it, and keeps an explicit client value", async () => {
      const previousStateDir = process.env.FUCKING_OPENCODE_STATE_DIR;
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-effort-test-"));
      process.env.FUCKING_OPENCODE_STATE_DIR = stateDir;
      let capturedBody = null;
      mockFetchImpl = async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":null}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      };

      process.env.REASONING_EFFORT = "high";
      try {
        const first = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(first.status, 200);
        assert.equal(capturedBody.reasoning_effort, "high");

        capturedBody = null;
        const second = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          stream: false,
          reasoning_effort: "minimal",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(second.status, 200);
        assert.equal(capturedBody.reasoning_effort, "minimal", "the client must win");
      } finally {
        delete process.env.REASONING_EFFORT;
        if (previousStateDir === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
        else process.env.FUCKING_OPENCODE_STATE_DIR = previousStateDir;
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("fails over to the next model-group candidate on a first-event timeout", async () => {
      const previousStateDir = process.env.FUCKING_OPENCODE_STATE_DIR;
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-failover-"));
      process.env.FUCKING_OPENCODE_STATE_DIR = stateDir;
      process.env.FUCKING_OPENCODE_MODEL_GROUPS = JSON.stringify({
        "rotate-test": ["longcat-2.5-preview-free", "big-pickle"],
      });
      process.env.FIRST_EVENT_TIMEOUT_MS = "50";
      require("../config").__reload();

      const seen = [];
      let call = 0;
      mockFetchImpl = async (_url, init) => {
        seen.push(JSON.parse(init.body).model);
        call += 1;
        if (call === 1) {
          return { ok: true, status: 200, body: new ReadableStream({ start() {} }) };
        }
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":null}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      };
      try {
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "rotate-test",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(res.status, 200);
        assert.deepStrictEqual(seen, ["longcat-2.5-preview-free", "big-pickle"]);
      } finally {
        delete process.env.FIRST_EVENT_TIMEOUT_MS;
        delete process.env.FUCKING_OPENCODE_MODEL_GROUPS;
        require("../config").__reload();
        if (previousStateDir === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
        else process.env.FUCKING_OPENCODE_STATE_DIR = previousStateDir;
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("returns 504 quickly when upstream accepts the request but never sends a first event", async () => {
      const previousStateDir = process.env.FUCKING_OPENCODE_STATE_DIR;
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-first-event-"));
      process.env.FUCKING_OPENCODE_STATE_DIR = stateDir;
      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start() {
            // Headers arrived; the body never yields a byte.
          },
        }),
      });
      process.env.FIRST_EVENT_TIMEOUT_MS = "50";
      try {
        const started = Date.now();
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(res.status, 504);
        assert.equal(res.body.error.type, "first_event_timeout");
        assert.ok(Date.now() - started < 2000, "must not hang for the upstream timeout");
      } finally {
        delete process.env.FIRST_EVENT_TIMEOUT_MS;
        if (previousStateDir === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
        else process.env.FUCKING_OPENCODE_STATE_DIR = previousStateDir;
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("pauses the anonymous lane after repeated final 429s when the breaker is enabled", async () => {
      const previousStateDir = process.env.FUCKING_OPENCODE_STATE_DIR;
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-breaker-test-"));
      process.env.FUCKING_OPENCODE_STATE_DIR = stateDir;
      process.env.ANON_BACKOFF_THRESHOLD = "1";
      mockFetchImpl = async () => ({
        ok: false,
        status: 429,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () =>
          JSON.stringify({ error: { type: "FreeUsageLimitError", message: "quota exhausted" } }),
      });
      try {
        require("../server").__resetAnonymousBackoff();
        require("../proxy").setPool({ entries: [] });
        const first = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(first.status, 429);
        assert.notEqual(first.body.error.type, "anonymous_lane_paused");

        const second = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(second.status, 429);
        assert.equal(second.body.error.type, "anonymous_lane_paused");
        assert.ok(Number(second.headers["retry-after"]) > 0);
      } finally {
        delete process.env.ANON_BACKOFF_THRESHOLD;
        require("../server").__resetAnonymousBackoff();
        require("../proxy").setPool({ entries: [] });
        if (previousStateDir === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
        else process.env.FUCKING_OPENCODE_STATE_DIR = previousStateDir;
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("propagates finish_reason='length' on Responses API incomplete and restores aliased client tool names", async () => {
      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        body: sseStreamFromLines([
          'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","call_id":"call_abc","type":"function_call","name":"read_client"}}\n\n',
          'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"file\\":\\"a.txt\\"}"}\n\n',
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":50,"output_tokens":15,"total_tokens":65}}}\n\n',
        ]),
      });

      // 现在显式声明通道：过去从模型名推断（`includes("muse")`），
      // 而该家族退役时，正是这类名字规则坏了。模型需要 Responses 通道，
      // 是因为上游这么说（ModelProtocolUnsupported），
      // 或因为 RESPONSES_MODELS 播种了它。
      srv_markProtocolSupport("big-pickle", true);
      const toolRes = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        stream: false,
        messages: [{ role: "user", content: "read a.txt" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "client read",
              parameters: { type: "object", properties: { file: { type: "string" } } },
            },
          },
        ],
      });

      assert.equal(toolRes.status, 200);
      assert.equal(toolRes.body.choices[0].finish_reason, "tool_calls");
      assert.equal(toolRes.body.choices[0].message.tool_calls[0].function.name, "read");
      assert.equal(
        toolRes.body.choices[0].message.tool_calls[0].function.arguments,
        '{"file":"a.txt"}'
      );
      assert.deepEqual(toolRes.body.usage, {
        prompt_tokens: 50,
        completion_tokens: 15,
        total_tokens: 65,
      });

      // 现在测试 response.incomplete -> finish_reason: "length"
      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        body: sseStreamFromLines([
          'data: {"type":"response.output_text.delta","delta":"truncated"}\n\n',
          'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":10,"output_tokens":100,"total_tokens":110}}}\n\n',
        ]),
      });

      const truncRes = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        stream: false,
        messages: [{ role: "user", content: "long text" }],
      });
      assert.equal(truncRes.status, 200);
      assert.equal(truncRes.body.choices[0].finish_reason, "length");
      assert.equal(truncRes.body.choices[0].message.content, "truncated");
    });

    it("automatically retries on the opposite protocol lane when upstream returns ModelProtocolUnsupported", async () => {
      const urlsCalled = [];
      mockFetchImpl = async (url) => {
        urlsCalled.push(url);
        if (url.endsWith("/chat/completions")) {
          return {
            ok: false,
            status: 400,
            text: async () =>
              JSON.stringify({
                type: "error",
                error: {
                  type: "ModelProtocolUnsupported",
                  message: "Model does not support this protocol.",
                },
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"type":"response.output_text.delta","delta":"OK from responses"}\n\n',
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14}}}\n\n',
          ]),
        };
      };

      const newModel = "future-responses-model-free";
      assert.equal(isResponsesModel(newModel), false);

      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: newModel,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.choices[0].message.content, "OK from responses");
      assert.equal(urlsCalled.length, 2);
      assert.match(urlsCalled[0], /\/inference\/v1\/chat\/completions$/);
      assert.match(urlsCalled[1], /\/inference\/v1\/responses$/);
      assert.equal(isResponsesModel(newModel), true);
      markProtocolSupport(newModel, false);
    });

    it("restricts CORS to localhost origins by default and rejects external websites", async () => {
      const localRes = await httpRequest(port, "GET", "/health", undefined, {
        Origin: "http://localhost:3000",
      });
      assert.equal(localRes.status, 200);
      assert.equal(localRes.headers["access-control-allow-origin"], "http://localhost:3000");

      const evilRes = await httpRequest(port, "GET", "/health", undefined, {
        Origin: "https://evil.example.com",
      });
      assert.equal(evilRes.status, 200);
      assert.equal(evilRes.headers["access-control-allow-origin"], undefined);
    });

    it("refuses a paid or retired model locally instead of forwarding it", async () => {
      // 上游对付费模型回 `401 AuthError: Missing API key.`
      // 本桥没有账号，所以该响应会让用户去找一个不存在的登录。
      // 目录已经知道价格，所以请求在这里被拒，理由指向 /v1/models。
      const realVerdict = identity.getCatalogVerdict;
      identity.getCatalogVerdict = (id) => {
        const lower = String(id).toLowerCase();
        if (lower === "gpt-5.4") return "paid";
        if (lower === "cat-jam-free") return "deprecated";
        return undefined;
      };
      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        return { ok: true, status: 200, body: sseStreamFromLines(["data: [DONE]\n\n"]) };
      };

      try {
        const paid = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(paid.status, 404);
        assert.equal(paid.body.error.code, "model_not_free");
        assert.match(paid.body.error.message, /no account/);

        const retired = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "cat-jam-free",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(retired.status, 404);
        assert.equal(retired.body.error.code, "model_deprecated");

        assert.equal(calls, 0, "neither request may reach upstream");
      } finally {
        identity.getCatalogVerdict = realVerdict;
      }
    });

    it("lets the catalog, not the model's name, decide what is free", async () => {
      // 网关的 /models 列表不是权威：它仍可能列出目录标记为退役的模型，
      // 也可能漏掉目录称为免费的模型。命名（`-free`）是惯例，不是价格。
      const realGetFree = identity.getFreeModels;
      const realVerdict = identity.getCatalogVerdict;
      identity.getFreeModels = () => ["glm-5.3-flash-free", "nemotron-3-ultra-free"];
      identity.getCatalogVerdict = (id) => {
        const lower = String(id).toLowerCase();
        if (lower === "glm-5.3-flash-free") return "free";
        if (lower === "nemotron-3-ultra-free") return "free";
        if (lower === "cat-jam-free") return "deprecated";
        return undefined;
      };
      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "cat-jam-free" },        // catalog: deprecated → must drop
            { id: "glm-5.3-flash-free" },  // catalog: free → keep
            { id: "jev-1.13-free" },       // evaluator → never listed
            { id: "some-new-free" },       // unknown to catalog → keep
          ],
        }),
      });

      try {
        await discoverModels();
        const ids = __getDiscoveryState().activeModels.map((m) => m.id);
        assert.ok(ids.includes("glm-5.3-flash-free"));
        assert.ok(ids.includes("nemotron-3-ultra-free"), "catalog-free survives /models omitting it");
        assert.ok(ids.includes("some-new-free"), "an id the catalog does not describe keeps the name heuristic");
        assert.ok(!ids.includes("cat-jam-free"), "a deprecated model drops even though /models lists it");
        assert.ok(!ids.includes("jev-1.13-free"));
      } finally {
        identity.getFreeModels = realGetFree;
        identity.getCatalogVerdict = realVerdict;
      }
    });

    it("turns an in-stream error into a real error, not an empty 200 (non-stream client)", async () => {
      // 上游实测行为：网关回 HTTP 200，然后在流里写
      // `data: {"error":...}`（例如模型自身后端的 503）。原样转发会让
      // 非流式客户端得到 200 + content:null + finish_reason "stop" ——
      // 一个假成功。客户端必须看到失败。
      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        body: sseStreamFromLines([
          'data: {"error":{"type":"server_error","message":"Streaming response failed: [503] Upstream unavailable"}}\n\n',
        ]),
      });

      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      });

      assert.equal(res.status, 502);
      assert.match(res.body.error.message, /503/);
      assert.equal(res.body.choices, undefined, "no fake completion may be returned");
    });

    it("returns HTTP 502 before committing SSE headers when the first stream event is an error, and emits SSE error event on mid-stream failure", async () => {
      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        body: sseStreamFromLines([
          'data: {"error":{"type":"server_error","message":"Streaming response failed: [503] Upstream unavailable"}}\n\n',
        ]),
      });

      const preChunkRes = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });
      assert.equal(preChunkRes.status, 502);
      assert.match(preChunkRes.body.error.message, /503/);

      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        body: sseStreamFromLines([
          'data: {"id":"x","choices":[{"index":0,"delta":{"content":"hel"},"finish_reason":null}]}\n\n',
          'data: {"error":{"type":"server_error","message":"Streaming response failed: [503] Upstream unavailable"}}\n\n',
        ]),
      });

      const midStreamRes = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });
      assert.equal(midStreamRes.status, 200);
      assert.match(midStreamRes.raw, /"error"/);
      assert.match(midStreamRes.raw, /503/);
      assert.match(midStreamRes.raw, /\[DONE\]/);
    });

    it("does not emit trailing completion chunks or duplicate [DONE] after an in-stream error", async () => {
      srv_markProtocolSupport("big-pickle", true);
      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        body: sseStreamFromLines([
          'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
          'data: {"error":{"type":"server_error","message":"Streaming response failed: [503] Upstream unavailable"}}\n\n',
          'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        ]),
      });

      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });

      assert.equal(res.status, 200);
      const doneCount = (res.raw.match(/data: \[DONE\]/g) || []).length;
      assert.equal(doneCount, 1, `expected exactly 1 [DONE] marker, got ${doneCount}`);
      assert.doesNotMatch(res.raw, /"finish_reason":"stop"/);
    });

    it("re-derives the endpoint and retries once when the path moves (404)", async () => {
      // 上游路径迁移表现为旧 URL 的 404，而不是网关拒绝。
      // 目录是基址的权威，所以桥必须重新推导并重试 ——
      // 客户端永远不应看到陈旧端点产生的 404。
      const seen = [];
      const realRefresh = identity.refresh;
      const realGetEndpoints = identity.getEndpoints;
      let moved = false;
      identity.refresh = async () => {
        moved = true;
        return { updated: true, changed: ["chatUrl"] };
      };
      identity.getEndpoints = (model) => {
        const base = realGetEndpoints(model);
        if (!moved) return base;
        return { ...base, chatUrl: "https://moved.example/v1/chat/completions" };
      };

      mockFetchImpl = async (url) => {
        seen.push(String(url));
        if (String(url).includes("/old/")) {
          return { ok: false, status: 404, text: async () => "<!DOCTYPE html>not found" };
        }
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"id":"x","choices":[{"index":0,"delta":{"content":"healed"},"finish_reason":null}]}\n\n',
            'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      };

      try {
        // 按迁移前发行版的做法，布置一个陈旧端点。
        identity.applyRecipe({ chatUrl: "https://opencode.ai/old/chat/completions" });
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(res.status, 200, "client must not see the stale-path 404");
        assert.equal(res.body.choices[0].message.content, "healed");
        assert.equal(seen.length, 2, "one rejected attempt plus one retry");
        assert.match(seen[0], /\/old\/chat\/completions$/);
        assert.match(seen[1], /moved\.example\/v1\/chat\/completions$/);
      } finally {
        identity.refresh = realRefresh;
        identity.getEndpoints = realGetEndpoints;
        identity.__reset();
        identity.__setLastCheckTime(Date.now());
      }
    });

    it("surfaces a model-level 410 verbatim instead of retrying it as an endpoint move", async () => {
      // 410 可能点名模型（`ModelDeprecated`），而不是路由。换 URL 重试
      // 会重复同样的答案，原始消息必须到达客户端，
      // 而不是泛化的 "Upstream error 410"。
      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        return {
          ok: false,
          status: 410,
          text: async () =>
            JSON.stringify({
              type: "error",
              error: { type: "ModelDeprecated", message: "Model x has been deprecated." },
            }),
        };
      };
      const realRefresh = identity.refresh;
      identity.refresh = async () => ({ updated: true, changed: ["chatUrl"] });
      try {
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(res.status, 410);
        assert.equal(calls, 1, "a model-level 410 must not be retried");
        assert.match(res.body.error.message, /has been deprecated/);
        assert.equal(res.body.error.type, "ModelDeprecated");
      } finally {
        identity.refresh = realRefresh;
      }
    });

    it("does not loop when a 404 is not an endpoint move", async () => {
      // 如果目录推导出同一个 URL，重试会重放同一个 404。
      // 桥必须把它暴露出来。
      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        return { ok: false, status: 404, text: async () => "not found" };
      };
      const realRefresh = identity.refresh;
      identity.refresh = async () => ({ updated: false, changed: [] });
      try {
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(res.status, 404);
        assert.equal(calls, 1, "a 404 with an unchanged endpoint must not be retried");
      } finally {
        identity.refresh = realRefresh;
      }
    });

    it("retries a 403 gate rejection after the identity learns something (body must be read first)", async () => {
      // 回归：网关分支过去在读取 body 之前测试
      // `isFreeTierCliGateError(status, "", "")`。403 只在 body 里带类型，
      // 所以该分支对 403 不可达 —— 只有 426 会自愈。这里断言 body 点名
      // FreeTierError 的 403 确实到达自愈路径。
      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        if (calls === 1) {
          return {
            ok: false,
            status: 403,
            text: async () =>
              JSON.stringify({
                type: "error",
                error: { type: "FreeTierError", message: "Free models are only available in OpenCode CLI." },
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          // Chat-completions 通道：big-pickle 不是 Responses 模型。
          body: sseStreamFromLines([
            'data: {"id":"x","choices":[{"index":0,"delta":{"content":"healed"},"finish_reason":null}]}\n\n',
            'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      };

      // 让身份刷新报告变化，这样重试才合理。
      const realOnGate = identity.onGateRejection;
      identity.onGateRejection = async () => ({ retry: true, reason: "test-update" });
      try {
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(calls, 2, "the rejected request must be replayed once");
        assert.equal(res.status, 200);
        assert.equal(res.body.choices[0].message.content, "healed");
      } finally {
        identity.onGateRejection = realOnGate;
      }
    });

    it("re-mints the session id on retry, so a rejected id shape is not replayed", async () => {
      // 上面的 FreeTierError 是请求不像 OpenCode 客户端时上游返回的东西。
      // 实测原因：会话 id 形态。id 从配方推导，所以刷新前铸出的 id
      // 编码的是刚被拒的形态 —— 重放它还会同样失败。
      // 这里断言重试携带*不同*且正确的 id。
      const seen = [];
      let calls = 0;
      mockFetchImpl = async (url, opts) => {
        calls++;
        seen.push(opts?.headers?.["x-opencode-session-id"] || opts?.headers?.["x-opencode-session"]);
        if (calls === 1) {
          return {
            ok: false,
            status: 403,
            text: async () =>
              JSON.stringify({
                type: "error",
                error: {
                  type: "FreeTierError",
                  message:
                    "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
                },
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"id":"x","choices":[{"index":0,"delta":{"content":"healed"},"finish_reason":null}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      };

      const realOnGate = identity.onGateRejection;
      identity.onGateRejection = async () => ({ retry: true, reason: "test-update" });
      sessionCache.clear();
      try {
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
          headers: { "x-opencode-session": "client-session-1" },
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 2, "one rejected request, one replay");
        assert.notEqual(seen[0], seen[1], "the replay must not reuse the rejected session id");
        assert.match(seen[1], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      } finally {
        identity.onGateRejection = realOnGate;
        sessionCache.clear();
      }
    });

    it("evicts a rejected session id from the cache so it is never reused", async () => {
      // 被拒的 id 从配方推导，所以缓存于客户端键下。如果它挺过自愈，
      // 该客户端之后每个请求都会重放同一个被拒形态 —— 桥会卡死。
      sessionCache.clear();
      const body = { model: "big-pickle", messages: [{ role: "user", content: "cache me" }] };
      const req = { headers: {} };
      const first = getPersistentSessionId(req, body);
      assert.equal(sessionCache.size, 1);

      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        if (calls === 1) {
          return {
            ok: false,
            status: 403,
            text: async () =>
              JSON.stringify({
                type: "error",
                error: {
                  type: "FreeTierError",
                  message:
                    "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
                },
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"id":"x","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      };

      const realOnGate = identity.onGateRejection;
      identity.onGateRejection = async () => ({ retry: true, reason: "test-update" });
      try {
        const res = await httpRequest(port, "POST", "/v1/chat/completions", body);
        assert.equal(res.status, 200);
        // 旧 id 必须消失；应改为缓存新的 id。
        const cached = [...sessionCache.values()].map((e) => e.sessionId);
        assert.equal(cached.includes(first), false, "rejected id must be evicted");
        assert.equal(cached.length, 1, "exactly one replacement id");
      } finally {
        identity.onGateRejection = realOnGate;
        sessionCache.clear();
      }
    });

    it("always retries once with fresh values, then surfaces the real error", async () => {
      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        return {
          ok: false,
          status: 403,
          text: async () =>
            JSON.stringify({ error: { type: "FreeTierError", message: "free tier" } }),
        };
      };
      const realOnGate = identity.onGateRejection;
      identity.onGateRejection = async () => ({ retry: false, reason: "no-change" });
      try {
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
        });
        // 两次上游调用：原始请求 + 一次用新铸会话 id + 完整工具集的重试。
        // 仍然有界 —— 绝不是重试循环。
        assert.equal(calls, 2, "exactly one retry, never a loop");
        assert.equal(res.status, 403);
        assert.equal(res.body.error.type, "FreeTierError");
      } finally {
        identity.onGateRejection = realOnGate;
      }
    });

    it("does not refresh or retry when upstream reports an IP-level abuse block", async () => {
      const abuse =
        "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address. This isn't related to your account. If you're on a VPN or proxy, turn it off and try again, or subscribe to OpenCode Go at https://opencode.ai/go to keep building.";
      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        return {
          ok: false,
          status: 403,
          headers: { get: (h) => (String(h).toLowerCase() === "x-opencode-log-id" ? "log-abuse-1" : null) },
          text: async () =>
            JSON.stringify({ type: "error", error: { type: "FreeTierError", message: abuse } }),
        };
      };
      const realOnGate = identity.onGateRejection;
      let gateCalls = 0;
      identity.onGateRejection = async () => {
        gateCalls++;
        return { retry: true, reason: "test-update" };
      };
      try {
        const proxyMod = require("../proxy");
        delete process.env.UPSTREAM_PROXY_POOL;
        proxyMod.setPool({ entries: [] });
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(calls, 1, "an IP-level block must not be replayed upstream without another exit");
        assert.equal(gateCalls, 0, "an IP-level block must not trigger an identity refresh");
        assert.equal(res.status, 403);
        assert.equal(res.headers["x-opencode-gate"], "ip-abuse");
        assert.equal(res.headers["x-opencode-log-id"], "log-abuse-1");
        assert.equal(res.body.error.message, abuse, "the refusal must reach the client verbatim");
        assert.doesNotMatch(res.body.error.message, /install\.sh \| bash/);

        const health = await httpRequest(port, "GET", "/health");
        assert.equal(health.body.identity.gate.status, "ip-blocked");
        assert.equal(health.body.identity.gate.lastRejection.kind, "ip-abuse");
      } finally {
        identity.onGateRejection = realOnGate;
        sessionCache.clear();
      }
    });

    it("recognises the gateway's short abuse phrasing too", async () => {
      const abuse = "Forbidden, OpenCode Free Model Gateway Detect Abuse Traffic";
      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        return {
          ok: false,
          status: 403,
          text: async () =>
            JSON.stringify({ type: "error", error: { type: "FreeTierError", message: abuse } }),
        };
      };
      const realOnGate = identity.onGateRejection;
      let gateCalls = 0;
      identity.onGateRejection = async () => {
        gateCalls++;
        return { retry: true, reason: "test-update" };
      };
      try {
        const proxyMod = require("../proxy");
        delete process.env.UPSTREAM_PROXY_POOL;
        proxyMod.setPool({ entries: [] });
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(calls, 1, "the short abuse phrasing must be terminal too without another exit");
        assert.equal(gateCalls, 0);
        assert.equal(res.status, 403);
        assert.equal(res.headers["x-opencode-gate"], "ip-abuse");
        assert.equal(res.body.error.message, abuse);
      } finally {
        identity.onGateRejection = realOnGate;
        sessionCache.clear();
      }
    });

    it("treats an abuse block discovered on the retry as terminal, without an update hint", async () => {
      const abuse =
        "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address.";
      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        const message =
          calls === 1
            ? "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."
            : abuse;
        return {
          ok: false,
          status: 403,
          text: async () =>
            JSON.stringify({ type: "error", error: { type: "FreeTierError", message } }),
        };
      };
      const realOnGate = identity.onGateRejection;
      identity.onGateRejection = async () => ({ retry: true, reason: "test-update" });
      try {
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(calls, 2, "the first attempt was a shape gate, so it still retries once");
        assert.equal(res.status, 403);
        assert.equal(res.headers["x-opencode-gate"], "ip-abuse");
        assert.equal(res.body.error.message, abuse);
        assert.doesNotMatch(res.body.error.message, /install\.sh \| bash/);
      } finally {
        identity.onGateRejection = realOnGate;
        sessionCache.clear();
      }
    });

    it("suppresses redundant 403 retries during an active IP cooldown until identity changes", async () => {
      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        return {
          ok: false,
          status: 403,
          text: async () =>
            JSON.stringify({ error: { type: "FreeTierError", message: "free tier" } }),
        };
      };
      const realOnGate = identity.onGateRejection;
      let shouldRetry = false;
      identity.onGateRejection = async () => ({
        retry: shouldRetry,
        reason: shouldRetry ? "test-update" : "no-change",
      });
      try {
        // 第一次请求：1 次初始尝试 + 1 次完整形态重试 = 2 次调用
        const res1 = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "first" }],
        });
        assert.equal(res1.status, 403);
        assert.equal(res1.headers["x-opencode-gate"], "ip-throttled");
        assert.ok(Number(res1.headers["retry-after"]) > 0);
        assert.equal(calls, 2);

        const healthThrottled = await httpRequest(port, "GET", "/health");
        assert.equal(healthThrottled.body.identity.gate.status, "throttled");

        // 冷却期间无身份变化的第二次请求：1 次尝试，无重复重试
        const res2 = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "second" }],
        });
        assert.equal(res2.status, 403);
        assert.equal(res2.headers["x-opencode-gate"], "ip-throttled");
        assert.equal(calls, 3, "must not double-hit upstream while full-shape retry already failed on current identity");

        // 可选 IP_LIMIT_STATUS=429 把确认的 IP 限制 403 翻译成 429，供标准路由器使用。
        process.env.IP_LIMIT_STATUS = "429";
        try {
          const res429 = await httpRequest(port, "POST", "/v1/chat/completions", {
            model: "big-pickle",
            messages: [{ role: "user", content: "second-429" }],
          });
          assert.equal(res429.status, 429);
          assert.equal(res429.headers["x-opencode-gate"], "ip-throttled");
          assert.equal(calls, 4);
        } finally {
          delete process.env.IP_LIMIT_STATUS;
        }
        // 如果身份确实学到更新，立即重新启用重试
        shouldRetry = true;
        const res3 = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "third" }],
        });
        assert.equal(res3.status, 403);
        assert.equal(calls, 6, "a learned identity change must retry immediately");
      } finally {
        identity.onGateRejection = realOnGate;
      }
    });

    it("omits the update hint when the refreshed identity is already rejected (budget gate)", async () => {
      mockFetchImpl = async () => ({
        ok: false,
        status: 403,
        text: async () =>
          JSON.stringify({
            error: {
              type: "FreeTierError",
              message: "Free models are only available in OpenCode CLI.",
            },
          }),
      });

      const gateRes = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(gateRes.status, 403);
      assert.match(gateRes.body.error.message, /Free models are only available in OpenCode CLI/);
      // 重试已经携带最新的推导身份（端点、会话 id、完整工具集），
      // 所以重复拒绝是每 IP 额度，而不是陈旧桥。
      // 指向 install.sh 会误导。
      assert.doesNotMatch(gateRes.body.error.message, /install\.sh \| bash/);

      // 非网关错误（例如 429 限流）绝不能包含更新提示
      mockFetchImpl = async () => ({
        ok: false,
        status: 429,
        text: async () =>
          JSON.stringify({
            error: { type: "RateLimitError", message: "Endpoint is unavailable" },
          }),
      });

      const rateRes = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(rateRes.status, 429);
      assert.equal(rateRes.body.error.message, "Endpoint is unavailable");
    });

    it("moves to another pool entry when an egress is out of allowance", async () => {
      // 这里覆盖的失败：429 从不进入网关分支，所以此前池什么也不记录，
      // 之后每个请求都选同一个已耗尽的 IP。集群实测：六个请求轮换六个 IP，
      // 其中四个回 429，而 /health 仍显示每个条目就绪。
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const proxy = require("../proxy");

      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-429-pool-"));
      const previousStateDir = process.env.FUCKING_OPENCODE_STATE_DIR;
      process.env.FUCKING_OPENCODE_STATE_DIR = stateDir;
      delete process.env.UPSTREAM_PROXY_POOL;
      proxy.__reload();
      proxy.resetHealth();

      try {
        const saved = proxy.setPool({
          entries: ["http://first:1", "http://second:2"],
          strategy: "failover",
          cooldownMs: 60000,
        });
        assert.equal(saved.ok, true);

        const spent = new Set();
        const usedEgress = [];
        mockFetchImpl = async (_url, init) => {
          // Bun 的 fetch 在 `init.proxy` 里携带出口；
          // 测试关心的是当时生效的池条目。
          const egress = init?.proxy || "direct";
          usedEgress.push(egress);
          if (egress === "http://first:1") {
            spent.add(egress);
            return {
              ok: false,
              status: 429,
              text: async () =>
                JSON.stringify({
                  error: {
                    type: "FreeUsageLimitError",
                    message: "Free usage limit reached.",
                  },
                }),
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

        const first = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "glm-5.3-flash-free",
          messages: [{ role: "user", content: "pool-429" }],
          stream: true,
        });
        assert.equal(first.status, 200, "the retry through a healthy entry must succeed");
        assert.deepEqual(usedEgress, ["http://first:1", "http://second:2"]);

        const state = proxy.describe();
        const firstEntry = state.pool.entries.find((e) => e.host === "first:1");
        const secondEntry = state.pool.entries.find((e) => e.host === "second:2");
        assert.equal(firstEntry.state, "cooling", "the spent egress must be parked");
        assert.equal(firstEntry.failures, 1);
        assert.equal(secondEntry.state, "ready");
        assert.equal(state.pool.ready, 1);

        // 下一个请求绝不能回到已耗尽的条目。
        usedEgress.length = 0;
        const second = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "glm-5.3-flash-free",
          messages: [{ role: "user", content: "pool-429-again" }],
          stream: true,
        });
        assert.equal(second.status, 200);
        assert.deepEqual(usedEgress, ["http://second:2"]);
      } finally {
        proxy.setPool({ entries: [] });
        proxy.resetHealth();
        if (previousStateDir === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
        else process.env.FUCKING_OPENCODE_STATE_DIR = previousStateDir;
        proxy.__reload();
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("moves to another pool entry when an egress is IP-blocked", async () => {
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const proxy = require("../proxy");

      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-abuse-pool-"));
      const previousStateDir = process.env.FUCKING_OPENCODE_STATE_DIR;
      process.env.FUCKING_OPENCODE_STATE_DIR = stateDir;
      delete process.env.UPSTREAM_PROXY_POOL;
      proxy.__reload();
      proxy.resetHealth();

      try {
        assert.equal(proxy.setPool({ entries: ["http://first:1", "http://second:2"], strategy: "failover" }).ok, true);
        const usedEgress = [];
        mockFetchImpl = async (_url, init) => {
          const egress = init?.proxy || "direct";
          usedEgress.push(egress);
          if (egress === "http://first:1") {
            return {
              ok: false,
              status: 403,
              text: async () =>
                JSON.stringify({
                  type: "error",
                  error: {
                    type: "FreeTierError",
                    message:
                      "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address.",
                  },
                }),
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

        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "glm-5.3-flash-free",
          messages: [{ role: "user", content: "abuse-pool" }],
          stream: true,
        });
        assert.equal(res.status, 200, "a blocked exit must not decide the request");
        assert.deepEqual(usedEgress, ["http://first:1", "http://second:2"]);
        const firstEntry = proxy.describe().pool.entries.find((e) => e.host === "first:1");
        assert.equal(firstEntry.state, "cooling");
      } finally {
        proxy.setPool({ entries: [] });
        proxy.resetHealth();
        if (previousStateDir === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
        else process.env.FUCKING_OPENCODE_STATE_DIR = previousStateDir;
        proxy.__reload();
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("moves to another pool entry on upstream 5xx", async () => {
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const proxy = require("../proxy");

      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-5xx-pool-"));
      const previousStateDir = process.env.FUCKING_OPENCODE_STATE_DIR;
      process.env.FUCKING_OPENCODE_STATE_DIR = stateDir;
      delete process.env.UPSTREAM_PROXY_POOL;
      proxy.__reload();
      proxy.resetHealth();

      try {
        assert.equal(proxy.setPool({ entries: ["http://first:1", "http://second:2"], strategy: "failover" }).ok, true);
        const usedEgress = [];
        mockFetchImpl = async (_url, init) => {
          const egress = init?.proxy || "direct";
          usedEgress.push(egress);
          if (egress === "http://first:1") {
            return { ok: false, status: 503, text: async () => "" };
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

        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "glm-5.3-flash-free",
          messages: [{ role: "user", content: "5xx-pool" }],
          stream: true,
        });
        assert.equal(res.status, 200);
        assert.deepEqual(usedEgress, ["http://first:1", "http://second:2"]);
      } finally {
        proxy.setPool({ entries: [] });
        proxy.resetHealth();
        if (previousStateDir === undefined) delete process.env.FUCKING_OPENCODE_STATE_DIR;
        else process.env.FUCKING_OPENCODE_STATE_DIR = previousStateDir;
        proxy.__reload();
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("retries once with a fresh session ID on transient upstream 5xx and recovers to 200", async () => {
      const seenSessions = [];
      let attempt = 0;
      mockFetchImpl = async (_url, opts) => {
        attempt++;
        seenSessions.push(opts?.headers?.["x-opencode-session"]);
        if (attempt === 1) {
          return {
            ok: false,
            status: 500,
            headers: new Map([["x-opencode-log-id", "01a14df2-first-500"]]),
            text: async () => "",
          };
        }
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"id":"1","choices":[{"index":0,"delta":{"content":"RECOVERED"},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      };

      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.choices[0].message.content, "RECOVERED");
      assert.equal(attempt, 2, "must retry once on upstream 5xx");
      assert.equal(seenSessions.length, 2);
      assert.notEqual(seenSessions[0], seenSessions[1], "5xx retry must mint a fresh session ID");
    });

    it("records lastUpstreamError in /health and forwards X-OpenCode-Log-Id when 5xx persists", async () => {
      let attempt = 0;
      mockFetchImpl = async () => {
        attempt++;
        return {
          ok: false,
          status: 500,
          headers: new Map([
            ["x-opencode-log-id", `01a14df2-persist-${attempt}`],
            ["cf-ray", "a4c5e229db07709c-SEA"],
            ["cf-placement", "remote-IAD"],
          ]),
          text: async () => "",
        };
      };

      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 500);
      assert.equal(attempt, 2, "must stop after one 5xx retry");
      assert.equal(res.headers["x-opencode-log-id"], "01a14df2-persist-2");
      assert.equal(res.headers["x-opencode-gate"], "upstream-error");
      assert.equal(res.body.error.log_id, "01a14df2-persist-2");

      const health = await httpRequest(port, "GET", "/health");
      const lastErr = health.body.identity.gate.lastUpstreamError;
      assert.ok(lastErr, "/health must expose lastUpstreamError after persistent 5xx");
      assert.equal(lastErr.status, 500);
      assert.equal(lastErr.logId, "01a14df2-persist-2");
      assert.equal(lastErr.cfRay, "a4c5e229db07709c-SEA");
      assert.equal(lastErr.cfPlacement, "remote-IAD");
      assert.equal(lastErr.model, "big-pickle");
    });
  });
});
