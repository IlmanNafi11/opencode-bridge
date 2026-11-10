#!/usr/bin/env bun
/**
 * compat.test.js — 协议兼容层与用量统计的离线测试。
 *
 * 覆盖三块：
 *   1. compat.js 纯函数：Anthropic ↔ OpenAI 请求/完成体互转、
 *      Responses 请求/完成体互转、SSE 流变换、词元估算。
 *   2. stats.js：记录/读取/汇总/清空、损坏行跳过、状态目录隔离
 *      （FUCKING_OPENCODE_STATE_DIR 指向临时目录）。
 *   3. 端到端：桥起在随机端口，mock 全局 fetch（上游），自call
 *      /v1/messages 与 /v1/responses 走通到 mock 上游并正确变换回来；
 *      /api/stats 反映记录；API key 门禁与默认模型。
 *
 * 全部离线：fetch 被 mock，绝不触网。
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-compat-test-"));
process.env.FUCKING_OPENCODE_STATE_DIR = tmpDir;
delete process.env.FUCKING_OPENCODE_API_KEYS;
delete process.env.FUCKING_OPENCODE_DEFAULT_MODEL;

const compat = require("../compat");
const stats = require("../stats");
const identity = require("../identity");

function emptyStateDir() {
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true });
}

// ---------------------------------------------------------------------------
// 1. compat 纯函数
// ---------------------------------------------------------------------------

describe("compat: Anthropic → OpenAI 请求变换", () => {
  it("把 system 字符串、消息与 stop_sequences 翻成 OpenAI 形状", () => {
    const { oai } = compat.Anthropic请求转OpenAI({
      model: "any-model",
      system: "你是测试助手",
      max_tokens: 256,
      temperature: 0.5,
      stop_sequences: ["END", "STOP"],
      messages: [
        { role: "user", content: "你好" },
        { role: "assistant", content: [{ type: "text", text: "回复" }] },
      ],
    });
    assert.equal(oai.model, "any-model");
    assert.equal(oai.max_tokens, 256);
    assert.equal(oai.temperature, 0.5);
    assert.deepEqual(oai.stop, ["END", "STOP"]);
    assert.equal(oai.messages[0].role, "system");
    assert.equal(oai.messages[0].content, "你是测试助手");
    assert.equal(oai.messages[1].content, "你好");
    assert.equal(oai.messages[2].content, "回复");
  });

  it("把 tool_use / tool_result 拆成 OpenAI tool_calls 与 tool 消息", () => {
    const { oai } = compat.Anthropic请求转OpenAI({
      model: "m",
      max_tokens: 100,
      messages: [
        { role: "user", content: "查天气" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "我来查" },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Jakarta" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "30°C 晴" }],
        },
      ],
      tools: [{ name: "get_weather", description: "查天气", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
    });
    const assistant = oai.messages[1];
    assert.equal(assistant.role, "assistant");
    assert.equal(assistant.content, "我来查");
    assert.equal(assistant.tool_calls[0].function.name, "get_weather");
    assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { city: "Jakarta" });
    const toolMsg = oai.messages[2];
    assert.equal(toolMsg.role, "tool");
    assert.equal(toolMsg.tool_call_id, "toolu_1");
    assert.equal(toolMsg.content, "30°C 晴");
    assert.equal(oai.tools[0].function.name, "get_weather");
    assert.deepEqual(oai.tools[0].function.parameters.properties.city, { type: "string" });
  });

  it("tool_result is_error 前缀化，图片块转 image_url", () => {
    const { oai } = compat.Anthropic请求转OpenAI({
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
            { type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" },
          ],
        },
      ],
    });
    const toolMsg = oai.messages.find((m) => m.role === "tool");
    assert.equal(toolMsg.content, "[tool error] boom");
    const userText = oai.messages.find((m) => m.role === "user");
    assert.deepEqual(userText.content, [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }]);
  });

  it("thinking.budget_tokens 映射 reasoning_effort，tool_choice any→required", () => {
    const { oai } = compat.Anthropic请求转OpenAI({
      model: "m",
      max_tokens: 10,
      thinking: { type: "enabled", budget_tokens: 16384 },
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(oai.reasoning_effort, "high");
    assert.equal(oai.tool_choice, "required");
  });

  it("缺 model 不补、缺 max_tokens 不造", () => {
    const { oai } = compat.Anthropic请求转OpenAI({ messages: [{ role: "user", content: "x" }] });
    assert.equal(oai.model, "");
    assert.equal(oai.max_tokens, undefined);
  });
});

describe("compat: OpenAI 完成 → Anthropic / Responses", () => {
  it("非流式完成折成 Anthropic message（text + tool_use + usage）", () => {
    const out = compat.OpenAI完成到Anthropic(
      {
        id: "chatcmpl-1",
        model: "m-free",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "答案",
              reasoning_content: "想了想",
              tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{\"a\":1}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      "any-model"
    );
    assert.equal(out.type, "message");
    assert.equal(out.role, "assistant");
    assert.equal(out.model, "any-model");
    assert.equal(out.stop_reason, "tool_use");
    assert.equal(out.content[0].type, "thinking");
    assert.equal(out.content[1].type, "text");
    assert.equal(out.content[1].text, "答案");
    assert.equal(out.content[2].type, "tool_use");
    assert.deepEqual(out.content[2].input, { a: 1 });
    assert.equal(out.usage.input_tokens, 10);
    assert.equal(out.usage.output_tokens, 5);
  });

  it("finish_reason length→max_tokens；Responses 输出形状正确", () => {
    const a = compat.OpenAI完成到Anthropic({
      choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "length" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }, "m");
    assert.equal(a.stop_reason, "max_tokens");

    const r = compat.OpenAI完成到Responses({
      id: "chatcmpl-2",
      created: 1700000000,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    assert.equal(r.object, "response");
    assert.equal(r.status, "completed");
    assert.equal(r.output[0].type, "message");
    assert.equal(r.output[0].content[0].text, "hello");
    assert.equal(r.usage.total_tokens, 5);
  });
});

describe("compat: Responses 请求变换", () => {
  it("string input 与 instructions 拆成 system+user", () => {
    const oai = compat.Responses请求转OpenAI({
      model: "m",
      instructions: "be brief",
      input: "hello there",
      max_output_tokens: 64,
    });
    assert.equal(oai.messages[0].role, "system");
    assert.equal(oai.messages[0].content, "be brief");
    assert.equal(oai.messages[1].content, "hello there");
    assert.equal(oai.max_tokens, 64);
  });

  it("item 数组：function_call / function_call_output 成对变 tool 消息", () => {
    const oai = compat.Responses请求转OpenAI({
      model: "m",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "what time" }] },
        { type: "function_call", call_id: "c1", name: "clock", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "noon" },
      ],
    });
    assert.equal(oai.messages[1].role, "assistant");
    assert.equal(oai.messages[1].tool_calls[0].function.name, "clock");
    assert.equal(oai.messages[2].role, "tool");
    assert.equal(oai.messages[2].content, "noon");
  });

  it("非 function 工具（web_search 等）被过滤", () => {
    const oai = compat.Responses请求转OpenAI({
      model: "m",
      input: "x",
      tools: [{ type: "web_search" }, { type: "function", name: "f", parameters: {} }],
    });
    assert.equal(oai.tools.length, 1);
    assert.equal(oai.tools[0].function.name, "f");
  });
});

describe("compat: SSE 流变换", () => {
  it("OpenAI chunk 流 → Anthropic 事件序列完整", () => {
    const 变换 = compat.创建Anthropic流变换("any-model");
    const out = [];
    const write = (s) => out.push(s);
    变换.chunk({ id: "c1", model: "m-free", choices: [{ index: 0, delta: { reasoning_content: "思考" }, finish_reason: null }] }, write);
    变换.chunk({ choices: [{ index: 0, delta: { content: "答案" }, finish_reason: null }] }, write);
    变换.chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "f", arguments: "{\"x\":" } }] }, finish_reason: null }] }, write);
    变换.chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 7, completion_tokens: 3 } }, write);
    变换.finish(write);

    const text = out.join("");
    assert.ok(text.includes("event: message_start"));
    assert.ok(text.includes("thinking_delta"));
    assert.ok(text.includes("text_delta"));
    assert.ok(text.includes("input_json_delta"));
    assert.ok(text.includes('"stop_reason":"tool_use"'));
    assert.ok(text.includes("event: message_stop"));
    assert.deepEqual(变换.usage, { input_tokens: 7, output_tokens: 3 });
    // 块序号单调递增：thinking(0) text(1) tool_use(2)。
    // "index":N 在 content_block_delta 里出现，tool_use 的 start 也带 index。
    const idxOf = (n) => text.indexOf('"index":' + n);
    assert.ok(idxOf(0) >= 0 && idxOf(1) > idxOf(0) && idxOf(2) > idxOf(1));
  });

  it("OpenAI chunk 流 → Responses 事件序列完整", () => {
    const 变换 = compat.创建Responses流变换("any-model");
    const out = [];
    const write = (s) => out.push(s);
    变换.chunk({ id: "c1", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }, write);
    变换.finish(write, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    const text = out.join("");
    assert.ok(text.includes("event: response.created"));
    assert.ok(text.includes("event: response.output_text.delta"));
    assert.ok(text.includes("event: response.completed"));
    assert.ok(text.includes('"total_tokens":2'));
  });
});

describe("compat: 估算词元", () => {
  it("4 字符/词元近似 + 工具 32/个", () => {
    const n = compat.估算词元([{ role: "user", content: "abcd".repeat(10) }], "", [{ name: "f" }]);
    assert.equal(n, 10 + 32);
    assert.ok(compat.估算词元([], "", []) >= 1);
  });
});

// ---------------------------------------------------------------------------
// 2. stats.js
// ---------------------------------------------------------------------------

describe("stats: 记录/汇总/清空", () => {
  beforeEach(() => emptyStateDir());

  it("记录后能读回且汇总正确", () => {
    stats.记录请求({ model: "m1", protocol: "openai", status: 200, ms: 100, input_tokens: 10, output_tokens: 5, request_id: "req_a", egress: "warp-n1" });
    stats.记录请求({ model: "m1", protocol: "anthropic", status: 502, ms: 30, error: "上游在流内失败", request_id: "req_b" });
    stats.记录请求({ model: "m2", protocol: "responses", status: 200, ms: 200, input_tokens: 1, output_tokens: 1 });
    const rows = stats.读历史();
    assert.equal(rows.length, 3);
    const s = stats.汇总();
    assert.equal(s.total, 3);
    assert.equal(s.ok, 2);
    assert.equal(s.fail, 1);
    assert.equal(s.input_tokens, 11);
    assert.equal(s.output_tokens, 6);
    assert.equal(s.models[0].model, "m1");
    assert.equal(s.models[0].requests, 2);
    assert.equal(s.avg_ms, 110);
  });

  it("损坏行跳过、days 过滤生效、清空删除全部", () => {
    stats.记录请求({ model: "m", status: 200, ms: 1 });
    fs.appendFileSync(stats.用量文件路径(), "{broken json\n", "utf8");
    assert.equal(stats.读历史().length, 1);
    const s = stats.汇总({ from: Date.now() + 60_000 });
    assert.equal(s.total, 0);
    stats.记录请求({ model: "m", status: 200, ms: 1 });
    const cleared = stats.清空历史({});
    assert.equal(cleared.ok, true);
    assert.equal(stats.读历史().length, 0);
  });

  it("记录绝不抛错（只读目录也不炸推理）", () => {
    const bad = path.join(tmpDir, "file-not-dir");
    fs.writeFileSync(bad, "x");
    const orig = process.env.FUCKING_OPENCODE_STATE_DIR;
    process.env.FUCKING_OPENCODE_STATE_DIR = bad;
    try {
      assert.doesNotThrow(() => stats.记录请求({ model: "m", status: 200, ms: 1 }));
    } finally {
      process.env.FUCKING_OPENCODE_STATE_DIR = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 端到端（独立进程）：compat-e2e.test.js 起完整桥打真实端口。
// ---------------------------------------------------------------------------
