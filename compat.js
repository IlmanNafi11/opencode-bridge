#!/usr/bin/env bun
/**
 * compat.js：协议兼容层。
 *
 * 把两条额外客户端协议翻译成桥已有的 Chat Completions 内部形态，让
 * `/v1/messages`（Anthropic Messages，Claude Code / Cherry Studio 等客户端）
 * 与 `/v1/responses`（Responses API，Codex 等客户端）复用同一条上游管线。
 * 本桥不新增上游调用 —— 两条路由都在桥内自call `/v1/chat/completions`
 * 的处理器，网关自愈、出口池、形态审计全部照常工作。
 *
 * 方向（全部就地翻译，绝不向上游发 Anthropic/Responses 原文）：
 *   Anthropic 请求  → OpenAI Chat Completions 请求体
 *   OpenAI SSE 块   → Anthropic SSE 事件流 / Responses SSE 事件流
 *   OpenAI 完成体   → Anthropic Messages 完成体 / Responses 完成体
 *
 * 计数端点：`/v1/messages/count_tokens` 用与 CLI 同一个 tokenizer 规则做
 * 近似（4 字符/词元），给客户端一个诚实的估计值，不向上游花钱。
 */

const crypto = require("crypto");

/** Anthropic system（字符串或块数组）→ OpenAI system 消息文本。 */
function 提取Anthropic系统(system) {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((块) => (typeof 块 === "string" ? 块 : 块?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Anthropic content 块（字符串或数组）→ OpenAI content 形态。
 *  tool_result 块在这里不处理 —— 那是消息级转换的事。 */
function 转换Anthropic内容(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const 块 of content) {
    if (!块 || typeof 块 === "string") {
      parts.push(typeof 块 === "string" ? { type: "text", text: 块 } : null);
      continue;
    }
    if (块.type === "text") {
      parts.push({ type: "text", text: 块.text || "" });
    } else if (块.type === "image" && 块.source) {
      // Anthropic 的 source = { type: "base64", media_type, data }
      if (块.source.type === "base64") {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${块.source.media_type || "image/png"};base64,${块.source.data}` },
        });
      } else if (块.source.type === "url") {
        parts.push({ type: "image_url", image_url: { url: 块.source.url } });
      }
    }
    // thinking / tool_use / tool_result 块在消息级转换里处理。
  }
  return parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts.filter(Boolean);
}

/** Anthropic thinking 配置 → OpenAI reasoning_effort。
 *  budget_tokens >= 16384 视为 high；其余按档位映射。 */
function Anthropic思考到力度(thinking) {
  if (!thinking || thinking.type !== "enabled") return undefined;
  const budget = Number(thinking.budget_tokens) || 0;
  if (budget >= 16384) return "high";
  if (budget >= 8192) return "medium";
  return "low";
}

/** Anthropic 消息 → OpenAI 消息。
 *  返回 { messages, systemText }：system 提出来单独传，兼容两个上游通道。 */
function AnthropicToOpenAI(anthropicBody = {}) {
  const systemText = 提取Anthropic系统(anthropicBody.system);
  const messages = [];
  if (systemText) messages.push({ role: "system", content: systemText });

  for (const 消息 of Array.isArray(anthropicBody.messages) ? anthropicBody.messages : []) {
    if (!消息 || typeof 消息 !== "object") continue;

    // assistant 带 tool_use：拆成 OpenAI 的 tool_calls。
    if (消息.role === "assistant" && Array.isArray(消息.content)) {
      const toolUses = 消息.content.filter((b) => b?.type === "tool_use");
      if (toolUses.length > 0) {
        const 文本块 = 消息.content.filter((b) => b?.type === "text").map((b) => b.text || "").join("");
        const oaiMessage = {
          role: "assistant",
          content: 文本块 || null,
          tool_calls: toolUses.map((工具) => ({
            id: 工具.id || `call_${crypto.randomBytes(8).toString("hex")}`,
            type: "function",
            function: {
              name: 工具.name || "unknown",
              arguments: JSON.stringify(工具.input ?? {}),
            },
          })),
        };
        messages.push(oaiMessage);
        continue;
      }
    }

    // user 带 tool_result：每个结果拆成一条 OpenAI tool 消息。
    if (消息.role === "user" && Array.isArray(消息.content)) {
      const 结果块 = 消息.content.filter((b) => b?.type === "tool_result");
      if (结果块.length > 0) {
        const 其余块 = 消息.content.filter((b) => b?.type !== "tool_result");
        for (const 结果 of 结果块) {
          let 输出 = "";
          const c = 结果.content;
          if (typeof c === "string") 输出 = c;
          else if (Array.isArray(c)) 输出 = c.map((b) => b?.text || "").join("");
          else if (c) 输出 = JSON.stringify(c);
          if (结果.is_error) 输出 = `[tool error] ${输出}`;
          messages.push({ role: "tool", tool_call_id: 结果.tool_use_id || "call_unknown", content: 输出 });
        }
        if (其余块.length > 0) {
          messages.push({ role: "user", content: 转换Anthropic内容(其余块) });
        }
        continue;
      }
    }

    messages.push({ role: 消息.role || "user", content: 转换Anthropic内容(消息.content) });
  }

  return { messages, systemText };
}

/** Anthropic 工具 → OpenAI 工具。input_schema 即 JSON Schema。 */
function Anthropic工具到OpenAI(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((工具) => ({
    type: "function",
    function: {
      name: 工具.name || "unknown",
      description: 工具.description || "",
      parameters: 工具.input_schema || { type: "object", properties: {} },
    },
  }));
}

/** OpenAI 的 tool_calls → Anthropic 的 tool_use 块。 */
function OpenAI工具到Anthropic(toolCalls) {
  return toolCalls.map((调用) => ({
    type: "tool_use",
    id: 调用.id || `toolu_${crypto.randomBytes(12).toString("hex")}`,
    name: 调用.function?.name || "unknown",
    input: 解析JSON对象(调用.function?.arguments),
  }));
}

/** Anthropic 的 tool_choice → OpenAI 的 tool_choice。 */
function Anthropic选择到OpenAI(choice) {
  if (!choice) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "tool") return { type: "function", function: { name: choice.name || "unknown" } };
  return undefined;
}

/** stop_sequences 转为 stop。 */
function Anthropic停止到OpenAI(anthropicBody) {
  const seq = anthropicBody.stop_sequences;
  if (Array.isArray(seq) && seq.length > 0) return seq;
  return anthropicBody.stop_sequence ? [anthropicBody.stop_sequence] : undefined;
}

/** 把 OpenAI 的非流式完成体折成 Anthropic Messages 完成体。 */
function OpenAI完成到Anthropic(oai, anthropicModel) {
  const 消息 = oai?.choices?.[0]?.message || {};
  const content = [];
  if (消息.reasoning_content) {
    content.push({ type: "thinking", thinking: String(消息.reasoning_content) });
  }
  if (消息.content) content.push({ type: "text", text: String(消息.content) });
  if (Array.isArray(消息.tool_calls) && 消息.tool_calls.length > 0) {
    content.push(...OpenAI工具到Anthropic(消息.tool_calls));
  }
  const stop = oai?.choices?.[0]?.finish_reason;
  return {
    id: oai?.id || `msg_${crypto.randomBytes(12).toString("hex")}`,
    type: "message",
    role: "assistant",
    model: anthropicModel || oai?.model || "",
    content,
    stop_reason: 停止原因到Anthropic(stop, 消息.tool_calls),
    stop_sequence: null,
    usage: {
      input_tokens: oai?.usage?.prompt_tokens || 0,
      cached_tokens: oai?.usage?.prompt_tokens_details?.cached_tokens || 0,
      output_tokens: oai?.usage?.completion_tokens || 0,
    },
  };
}

/** OpenAI 的 finish_reason → Anthropic 的 stop_reason。 */
function 停止原因到Anthropic(finish, toolCalls) {
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return "tool_use";
  switch (finish) {
    case "length": return "max_tokens";
    case "content_filter": return "refusal";
    default: return "end_turn";
  }
}

/** 近似计词：CLI 侧同用 4 字符/词元 的粗估。数字/URL 压缩比更好，
 *  但这里只承诺"估计"。系统提示与消息全算上，工具定义按 32 词元/个。 */
function 估算词元(messages, systemText, tools) {
  let chars = typeof systemText === "string" ? systemText.length : 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    const c = m?.content;
    if (typeof c === "string") chars += c.length;
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (p?.text) chars += p.text.length;
        else if (p?.image_url?.url) chars += 1024; // 图像按固定估计
      }
    }
    if (Array.isArray(m?.tool_calls)) chars += JSON.stringify(m.tool_calls).length;
  }
  const toolTokens = Array.isArray(tools) ? tools.length * 32 : 0;
  return Math.max(1, Math.ceil(chars / 4) + toolTokens);
}

/** 从 Anthropic 请求体构造 OpenAI Chat Completions 请求体。
 *  返回 null 表示缺必填字段（调用方回 400）。 */
function Anthropic请求转OpenAI(anthropicBody = {}, modelOverride = null) {
  const { messages, systemText } = AnthropicToOpenAI(anthropicBody);
  const oai = {
    model: modelOverride || anthropicBody.model || "",
    messages,
  };
  const maxTokens = Number(anthropicBody.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) oai.max_tokens = maxTokens;
  if (typeof anthropicBody.temperature === "number") oai.temperature = anthropicBody.temperature;
  if (typeof anthropicBody.top_p === "number") oai.top_p = anthropicBody.top_p;
  const 思考 = Anthropic思考到力度(anthropicBody.thinking);
  if (思考) oai.reasoning_effort = 思考;
  const stop = Anthropic停止到OpenAI(anthropicBody);
  if (stop) oai.stop = stop;
  const tools = Anthropic工具到OpenAI(anthropicBody.tools);
  if (tools) oai.tools = tools;
  const choice = Anthropic选择到OpenAI(anthropicBody.tool_choice);
  if (choice) oai.tool_choice = choice;
  if (anthropicBody.stream) oai.stream = true;
  return { oai, systemText };
}

// ---------------------------------------------------------------------------
// Responses API（客户端侧）：/v1/responses 进，OpenAI chat 出。
// ---------------------------------------------------------------------------

/** Responses 输入 → OpenAI 消息。支持 string 与 item 数组。 */
function Responses输入转Messages(input) {
  const messages = [];
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;
  for (const item of input) {
    if (!item || typeof item === "string") {
      messages.push({ role: "user", content: typeof item === "string" ? item : "" });
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id || "call_unknown", content: String(item.output ?? "") });
      continue;
    }
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.call_id || `call_${crypto.randomBytes(8).toString("hex")}`,
          type: "function",
          function: { name: item.name || "unknown", arguments: String(item.arguments ?? "{}") },
        }],
      });
      continue;
    }
    if (item.type === "message" || item.role) {
      const content = typeof item.content === "string"
        ? item.content
        : Array.isArray(item.content)
          ? item.content.map((p) => {
              if (typeof p === "string") return { type: "text", text: p };
              if (p?.type === "output_text" || p?.type === "input_text") return { type: "text", text: p.text || "" };
              if (p?.type === "input_image" && p.image_url) return { type: "image_url", image_url: { url: p.image_url } };
              return null;
            }).filter(Boolean)
          : "";
      messages.push({ role: item.role || "user", content });
    }
  }
  return messages;
}

/** Responses 工具（扁平化 JSON schema）→ OpenAI 工具。 */
function Responses工具转OpenAI(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools
    .filter((t) => !t || t.type === undefined || t.type === "function")
    .map((t) => ({
      type: "function",
      function: {
        name: t.name || "unknown",
        description: t.description || "",
        parameters: t.parameters || { type: "object", properties: {} },
      },
    }));
}

/** Responses 请求体 → OpenAI Chat Completions 请求体。 */
function Responses请求转OpenAI(responsesBody = {}) {
  const messages = Responses输入转Messages(responsesBody.input);
  if (typeof responsesBody.instructions === "string" && responsesBody.instructions) {
    messages.unshift({ role: "system", content: responsesBody.instructions });
  }
  const oai = {
    model: responsesBody.model || "",
    messages,
  };
  const maxTokens = responsesBody.max_output_tokens ?? responsesBody.max_completion_tokens ?? responsesBody.max_tokens;
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) oai.max_tokens = Number(maxTokens);
  if (typeof responsesBody.temperature === "number") oai.temperature = responsesBody.temperature;
  if (typeof responsesBody.top_p === "number") oai.top_p = responsesBody.top_p;
  const tools = Responses工具转OpenAI(responsesBody.tools);
  if (tools) oai.tools = tools;
  if (responsesBody.tool_choice) oai.tool_choice = responsesBody.tool_choice;
  if (responsesBody.stream) oai.stream = true;
  return oai;
}

/** OpenAI 完成体 → Responses API 完成体（非流式）。 */
function OpenAI完成到Responses(oai) {
  const 消息 = oai?.choices?.[0]?.message || {};
  const output = [];
  if (消息.reasoning_content) {
    output.push({ type: "reasoning", content: [{ type: "summary_text", text: String(消息.reasoning_content) }] });
  }
  if (消息.content) {
    output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: String(消息.content) }] });
  }
  for (const 调用 of Array.isArray(消息.tool_calls) ? 消息.tool_calls : []) {
    output.push({
      type: "function_call",
      call_id: 调用.id || `call_${crypto.randomBytes(8).toString("hex")}`,
      name: 调用.function?.name || "unknown",
      arguments: 调用.function?.arguments || "{}",
    });
  }
  return {
    id: oai?.id || `resp_${crypto.randomBytes(12).toString("hex")}`,
    object: "response",
    created_at: oai?.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: oai?.model || "",
    output,
    usage: {
      input_tokens: oai?.usage?.prompt_tokens || 0,
      cached_tokens: oai?.usage?.prompt_tokens_details?.cached_tokens || 0,
      output_tokens: oai?.usage?.completion_tokens || 0,
      total_tokens: oai?.usage?.total_tokens || 0,
    },
  };
}

// ---------------------------------------------------------------------------
// SSE 变换：OpenAI chat.completion.chunk 流 → Anthropic / Responses 事件流。
// ---------------------------------------------------------------------------

/** Anthropic 事件包装。 */
function Anthropic事件(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 逐块把 OpenAI chunk 转成 Anthropic 事件。有状态：块间共享索引。
 *  返回要写给客户端的字符串（可能为空）。 */
function 创建Anthropic流变换(model) {
  let started = false;
  let outputTokens = 0;
  let inputTokens = 0;
  let stopReason = "end_turn";
  let blockIndex = -1; // -1 = 尚未开块
  let blockType = null;
  const toolNameById = new Map();

  const 开块 = (write, type) => {
    blockIndex += 1;
    blockType = type;
    write(Anthropic事件("content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: type === "text"
        ? { type: "text", text: "" }
        : type === "thinking"
          ? { type: "thinking", thinking: "" }
          : { type: "tool_use", id: "", name: "", input: {} },
    }));
  };
  const 关块 = (write) => {
    if (blockIndex < 0) return;
    write(Anthropic事件("content_block_stop", { type: "content_block_stop", index: blockIndex }));
    // 不把 blockIndex 归零：Anthropic 的 index 全流单调递增，
    // 归零会让后续块都顶着 index 0 发（客户端侧块互相覆盖）。
    blockType = null;
  };

  return {
    /** 处理一个 OpenAI chunk（已解析对象）。 */
    chunk(chunk, write) {
      const choice = chunk?.choices?.[0];
      if (chunk?.usage) {
        inputTokens = chunk.usage.prompt_tokens || inputTokens;
        outputTokens = chunk.usage.completion_tokens || outputTokens;
      }
      if (!started) {
        started = true;
        write(Anthropic事件("message_start", {
          type: "message_start",
          message: {
            id: chunk?.id || `msg_${crypto.randomBytes(12).toString("hex")}`,
            type: "message",
            role: "assistant",
            model: model || chunk?.model || "",
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }));
      }
      const delta = choice?.delta || {};
      // 推理块
      if (delta.reasoning_content) {
        if (blockType !== "thinking") {
          关块(write);
          开块(write, "thinking");
        }
        write(Anthropic事件("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "thinking_delta", thinking: delta.reasoning_content },
        }));
      }
      // 文本块
      if (delta.content) {
        if (blockType !== "text") {
          关块(write);
          开块(write, "text");
        }
        write(Anthropic事件("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text: delta.content },
        }));
      }
      // 工具调用：块在拿到 id/name 的同一个事件里开，不发空 start。
      for (const 调用 of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        if (blockType !== "tool_use") {
          关块(write);
          blockIndex += 1;
          blockType = "tool_use";
          const id = 调用.id || `toolu_${调用.index ?? 0}`;
          const name = 调用.function?.name || "";
          toolNameById.set(调用.index ?? 0, { id, name });
          write(Anthropic事件("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "tool_use", id, name, input: {} },
          }));
        }
        if (调用.function?.arguments) {
          write(Anthropic事件("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: 调用.function.arguments },
          }));
        }
      }
      if (choice?.finish_reason) {
        // finish chunk 的 delta 已空，tool_calls 从打开的块推断。
        stopReason = 停止原因到Anthropic(choice.finish_reason, blockType === "tool_use" ? [{}] : delta.tool_calls);
      }
    },
    /** 流结束：关块 + message_delta + message_stop。返回完整尾部。 */
    finish(write) {
      关块(write);
      write(Anthropic事件("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }));
      write(Anthropic事件("message_stop", { type: "message_stop" }));
    },
    get usage() {
      return { input_tokens: inputTokens, output_tokens: outputTokens };
    },
  };
}

/** 逐块把 OpenAI chunk 转成 Responses API 事件流。 */
function 创建Responses流变换(model) {
  let started = false;
  let seq = 0;
  let itemIndex = -1;
  let itemType = null;
  const 工具 = new Map();

  const 事件 = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
  const 开项 = (write, type) => {
    itemIndex += 1;
    itemType = type;
    write(事件({
      type: "response.output_item.added",
      output_index: itemIndex,
      item: type === "message"
        ? { type: "message", role: "assistant", content: [] }
        : type === "reasoning"
          ? { type: "reasoning", content: [] }
          : { type: "function_call", name: "", arguments: "", call_id: "" },
    }));
  };
  const 关项 = (write) => {
    if (itemIndex < 0) return;
    write(事件({ type: "response.output_item.done", output_index: itemIndex }));
    itemIndex = -1;
    itemType = null;
  };

  return {
    chunk(chunk, write) {
      if (!started) {
        started = true;
        seq += 1;
        write(事件({
          type: "response.created",
          sequence_number: seq,
          response: {
            id: chunk?.id || `resp_${crypto.randomBytes(12).toString("hex")}`,
            object: "response",
            status: "in_progress",
            model: model || chunk?.model || "",
            output: [],
          },
        }));
      }
      const delta = chunk?.choices?.[0]?.delta || {};
      if (delta.reasoning_content) {
        if (itemType !== "reasoning") {
          关项(write);
          开项(write, "reasoning");
        }
        seq += 1;
        write(事件({
          type: "response.reasoning_summary_text.delta",
          item_id: `item_${itemIndex}`,
          output_index: itemIndex,
          sequence_number: seq,
          delta: delta.reasoning_content,
        }));
      }
      if (delta.content) {
        if (itemType !== "message") {
          关项(write);
          开项(write, "message");
        }
        seq += 1;
        write(事件({
          type: "response.output_text.delta",
          item_id: `item_${itemIndex}`,
          output_index: itemIndex,
          sequence_number: seq,
          delta: delta.content,
        }));
      }
      for (const 调用 of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        if (itemType !== "function_call") {
          关项(write);
          开项(write, "function_call");
          const id = 调用.id || `call_${调用.index ?? 0}`;
          工具.set(itemIndex, id);
          seq += 1;
          write(事件({
            type: "response.output_item.added",
            output_index: itemIndex,
            item: { type: "function_call", call_id: id, name: 调用.function?.name || "", arguments: "" },
          }));
        }
        if (调用.function?.arguments) {
          seq += 1;
          write(事件({
            type: "response.function_call_arguments.delta",
            item_id: `item_${itemIndex}`,
            output_index: itemIndex,
            sequence_number: seq,
            delta: 调用.function.arguments,
          }));
        }
      }
    },
    finish(write, usage) {
      关项(write);
      seq += 1;
      write(事件({
        type: "response.completed",
        sequence_number: seq,
        response: {
          id: `resp_${crypto.randomBytes(12).toString("hex")}`,
          object: "response",
          status: "completed",
          model: model || "",
          output: [],
          usage: usage
            ? {
                input_tokens: usage.prompt_tokens || 0,
                output_tokens: usage.completion_tokens || 0,
                total_tokens: usage.total_tokens || 0,
              }
            : undefined,
        },
      }));
    },
  };
}

/** 安全解析 JSON 对象参数；坏参不炸协议。 */
function 解析JSON对象(text) {
  if (typeof text !== "string" || !text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { _raw: text };
  }
}

module.exports = {
  Anthropic请求转OpenAI,
  Anthropic工具到OpenAI,
  OpenAI完成到Anthropic,
  OpenAI完成到Responses,
  Responses请求转OpenAI,
  创建Anthropic流变换,
  创建Responses流变换,
  估算词元,
  解析JSON对象,
};
