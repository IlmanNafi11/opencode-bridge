"use strict";
/**
 * 免费档网关契约。
 *
 * 上游对至少四种互不相关的原因都只回一个 `403 FreeTierError` —— 原文
 * "OpenCode's free tier can only be used from within OpenCode"：
 *
 *   1. 出口 IP 被拒，
 *   2. 请求不带名为 `read` 的工具，
 *   3. User-Agent 不是 `opencode/<channel>/<semver>/<name>`，
 *   4. 请求不带会话头。
 *
 * 原因 2-4 是*本桥*的形态问题。出现这些时，桥原本会报告原因 1，让运维去追
 * 一个并不存在的额度问题。下面的锚点就是为此存在，这些测试把它们锁住。
 *
 * 实测（2026-10-18，从被拒出口与干净出口重放逐字节相同的请求，每次只变一个
 * 字段）记录在 identity.js 的 GATE_ANCHOR_TOOL_NAMES /
 * GATE_ANCHOR_HEADER_NAMES 旁边。
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const identity = require("../identity");
const srv = require("../server");

const FULL = "full";
const CORE = "core";

function toolNames(list) {
  return list.map((t) => t.function?.name || t.name);
}

function wireTools(scope, modelId = "big-pickle", body = { messages: [{ role: "user", content: "x" }] }) {
  const { upstreamBody } = srv.buildUpstreamPayload(
    { model: modelId, ...body },
    modelId,
    false,
    scope
  );
  return toolNames(upstreamBody.tools || []);
}

beforeEach(() => identity.__reset());

afterEach(() => {
  identity.__reset();
  delete process.env.OPENCODE_USER_AGENT;
});

describe("gate contract: the `read` tool anchor", () => {
  it("sends a tool named `read` in every scope and protocol lane", () => {
    for (const scope of [CORE, FULL]) {
      assert.ok(wireTools(scope).includes("read"), `chat/${scope} must carry \`read\``);
    }
    const responses = srv.buildUpstreamPayload(
      { model: "big-pickle", messages: [{ role: "user", content: "x" }] },
      "big-pickle",
      true,
      null
    ).upstreamBody;
    assert.ok(toolNames(responses.tools || []).includes("read"), "responses lane must carry `read`");
  });

  it("keeps the anchor when upstream renames the tool", () => {
    // 上游把 `read` 改名为 `read_file`。推导出的配置跟随改名 ——
    // 这正是桥存在的自适应能力 —— 但网关仍在找 `read`，
    // 所以锚点必须独立存活。
    identity.applyRecipe({
      tools: {
        read_file: { description: "r".repeat(30), parameters: { type: "object", properties: {} } },
        shell: { description: "s".repeat(30), parameters: { type: "object", properties: {} } },
      },
      toolNames: ["read_file", "shell"],
    });
    for (const scope of [CORE, FULL]) {
      const names = wireTools(scope);
      assert.ok(names.includes("read"), `${scope} must still carry \`read\` after a rename`);
    }
    // `core` 刻意只发送经过验证的最小集合，所以改名后的工具只应在
    // `full` 里出现 —— 自愈重试所用的范围。
    assert.ok(
      wireTools(FULL).includes("read_file"),
      "full scope must also carry the renamed tool, so the wire keeps following upstream"
    );
  });

  it("keeps the anchor when upstream drops the tool entirely", () => {
    identity.applyRecipe({
      tools: { shell: { description: "s".repeat(30), parameters: { type: "object", properties: {} } } },
      toolNames: ["shell"],
    });
    for (const scope of [CORE, FULL]) {
      assert.ok(wireTools(scope).includes("read"), `${scope} must carry \`read\` from the shipped fallback`);
    }
  });

  it("still sends the anchor when the client supplies its own tools", () => {
    // 客户端的 `read` 被别名成 `read_client`，以便把指纹注入到它旁边。
    // 锚点必须是注入的那个，而不是别名。
    const { upstreamBody } = srv.buildUpstreamPayload(
      {
        model: "big-pickle",
        messages: [{ role: "user", content: "x" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "client read",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          },
        ],
      },
      "big-pickle",
      false,
      CORE
    );
    const names = toolNames(upstreamBody.tools);
    assert.ok(names.includes("read"), "the gate anchor must be present");
    assert.ok(names.includes("read_client"), "the client's own definition must be preserved under an alias");
  });

  it("uses the shipped definition when the profile no longer has one", () => {
    identity.applyRecipe({ tools: { shell: identity.DEFAULT_TOOLS.shell }, toolNames: ["shell"] });
    const list = identity.getToolList(false, CORE);
    const read = list.find((t) => t.function.name === "read");
    assert.ok(read, "`read` must be present");
    // 网关接受的必须是*有效*定义，而不是空壳。
    assert.equal(read.function.parameters.type, "object");
    assert.ok(read.function.description.length > 0);
  });
});

describe("gate contract: the header anchors", () => {
  const ctx = {
    userAgent: "opencode/latest/2.0.32/cli",
    client: "cli",
    project: "global",
    sessionId: "ses_abc",
  };

  it("always sends a User-Agent and a session header", () => {
    // 一个都不列的配方正是本测试钉住的回归：上游会回与拒绝 IP 时
    // 完全相同的 403。
    identity.applyRecipe({ headers: [] });
    const { headers } = identity.buildGateHeaders(ctx);
    assert.equal(headers["User-Agent"], ctx.userAgent);
    assert.equal(headers["x-opencode-session"], ctx.sessionId);
    assert.equal(headers["x-session-affinity"], ctx.sessionId);
  });

  it("never emits a User-Agent the gate refuses", () => {
    // 实测拒绝：缺失、裸 `opencode`、`Mozilla/5.0 …`、`curl/8.18.0`。
    const { headers } = identity.buildGateHeaders({ ...ctx, userAgent: "curl/8.18.0" });
    // identity.js 原样传递值；server.js 负责 UA 校验。这里断言校验器，
    // 这样绕过 server.js 的调用方仍被覆盖。
    assert.equal(srv.isValidV2UserAgent("curl/8.18.0"), false);
    assert.equal(srv.isValidV2UserAgent("Mozilla/5.0 (X11; Linux x86_64)"), false);
    assert.equal(srv.isValidV2UserAgent("opencode"), false);
    assert.equal(srv.isValidV2UserAgent("opencode/9.9.9"), false, "needs the full 3-segment shape");
    assert.equal(srv.isValidV2UserAgent("opencode/latest/2.0.32/cli"), true);
    assert.equal(srv.isValidV2UserAgent("OpenCode/2.0.32"), false, "identity.js uses the 4-segment form");
  });

  it("replaces an operator override the gate would refuse", () => {
    process.env.OPENCODE_USER_AGENT = "curl/8.18.0";
    const ua = srv.gateSafeUserAgent();
    assert.match(ua, /^opencode\/[A-Za-z0-9-]+\/\d+\.\d+\.\d+\/[A-Za-z0-9-]+$/);
  });

  it("honours an operator override the gate accepts", () => {
    process.env.OPENCODE_USER_AGENT = "opencode/latest/9.9.9/cli";
    assert.equal(srv.gateSafeUserAgent(), "opencode/latest/9.9.9/cli");
  });

  it("derives the session headers from the request, not a constant", () => {
    const { headers } = identity.buildGateHeaders({ ...ctx, sessionId: "ses_other" });
    assert.equal(headers["x-opencode-session"], "ses_other");
    assert.equal(headers["x-session-affinity"], "ses_other");
  });
});

describe("gate contract: the shape audit", () => {
  it("reports a complete shape as ok", () => {
    const audit = srv.__auditGateShape(
      { tools: [{ type: "function", function: { name: "read" } }] },
      {
        "User-Agent": "opencode/latest/2.0.32/cli",
        "x-opencode-session": "ses_abc",
      }
    );
    assert.equal(audit.hasReadTool, true);
    assert.equal(audit.userAgentOk, true);
    assert.ok(audit.sessionHeaders.length > 0);
  });

  it("names every missing anchor, so a log line is actionable", () => {
    const audit = srv.__auditGateShape(
      { tools: [{ type: "function", function: { name: "shell" } }] },
      { "User-Agent": "curl/8.18.0" }
    );
    assert.equal(audit.hasReadTool, false);
    assert.equal(audit.userAgentOk, false);
    assert.deepEqual(audit.sessionHeaders, []);
  });

  it("reads flat (responses-lane) tool definitions too", () => {
    const audit = srv.__auditGateShape({ tools: [{ type: "function", name: "read" }] }, {
      "User-Agent": "opencode/latest/2.0.32/cli",
      "x-session-affinity": "ses_abc",
    });
    assert.equal(audit.hasReadTool, true);
  });
});

describe("gate contract: anchors are visible in /health", () => {
  it("exposes the anchors and the last rejection", async () => {
    const { server } = srv;
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const body = await new Promise((resolve, reject) => {
        require("node:http")
          .get({ host: "127.0.0.1", port, path: "/health" }, (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => resolve(JSON.parse(raw)));
          })
          .on("error", reject);
      });
      assert.deepEqual(body.identity.gate.anchors.tools, ["read"]);
      assert.deepEqual(body.identity.gate.anchors.headers, [
        "user-agent",
        "x-opencode-session",
        "x-session-affinity",
      ]);
      assert.ok("lastRejection" in body.identity.gate);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
