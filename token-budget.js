// 为推理模型计算令牌预算。
//
// 推理模型（Muse Spark、MiMo、Nemotron、LongCat 等）会产生思维链令牌，与可
// 见答案共用同一个输出预算。客户端只要一个很小的 max_tokens —— 探测、起标
// 题、一词回答 —— 模型会把预算全部花在思考上，返回 finish_reason: "length"
// 而内容为空。失败是无声的：不报错、无内容、令照计费。
//
// OpenRouter 对此有文档（"reasoning tokens count against max_tokens ...
// set max_tokens well above the expected reasoning length"），生态里公认的
// 修法是"加法预算"：
//
//   max_tokens = 回答预算 + 思考预算
//
// （见 goose#11142，采用 pi coding agent 的公式。）本模块在此应用它，短请求
// 也能拿到可见回答。
//
// 调参记录，基于对 OpenCode Zen 网关的实测：
//   - max_tokens  50  -> Muse 空回复
//   - max_tokens 100  -> Muse 与 cat-jam 空回复
//   - max_tokens 256  -> big-pickle 空回复；longcat 恰好顶格完成
//   - max_tokens 512  -> 有内容，长回答被截断
//   - max_tokens 2048 + 思考余量 -> 回答完整
//
// 因此 MIN_ANSWER_TOKENS = 1024（对齐 pi 与 Anthropic 的预留）、
// THINKING_BUDGET = 4096，覆盖这里观测到的 ~100-800 推理令牌且有余量。

const MIN_ANSWER_TOKENS = 1024;
const THINKING_BUDGET = 4096;
const MAX_OUTPUT_TOKENS = 131072;
// 非推理模型也有下限，客户端给的极小值不能把正常回答截断在半句话。
const MIN_PLAIN_TOKENS = 512;

// 回答前先思考的模型。供应商目录直接给出该事实（所有在线免费模型都是
// `reasoning: true`），目录首次拉取后缓存落盘，所以桥去问目录，而不是维护
// 手写的子串清单。
const REASONING_MODEL_HINTS = Object.freeze([]);

function 是推理模型(modelId) {
  const id = String(modelId || "").toLowerCase();
  if (!id) return false;
  try {
    const facts = require("./identity").getModelFacts(id);
    if (facts && typeof facts.reasoning === "boolean") return facts.reasoning;
  } catch {
    // identity 不可用：走下面默认。
  }
  return false;
}

// 请求绑定推理预算的两种情形：目标是已知思考模型，或客户端显式要求推理力度。
function 是推理请求(body, modelId) {
  if (是推理模型(modelId)) return true;
  const effort = body && body.reasoning_effort;
  return Boolean(effort) && effort !== "none";
}

// 把客户端请求的预算夹进"必然给可见回答留出空间"的区间。客户端的值绝不调低
// —— 只在它小到活不过思考阶段时才抬高。
function 解析请求令牌(requested) {
  if (requested === undefined || requested === null || typeof requested === "boolean") {
    return MAX_OUTPUT_TOKENS;
  }
  if (typeof requested === "string" && requested.trim() === "") {
    return MAX_OUTPUT_TOKENS;
  }
  const raw = Number(requested);
  if (!Number.isFinite(raw) || raw < 0) {
    return MAX_OUTPUT_TOKENS;
  }
  return Math.floor(raw);
}

function 生效输出上限(requested, modelId, body) {
  const wanted = 解析请求令牌(requested);

  const effective = 是推理请求(body, modelId)
    ? Math.max(wanted, MIN_ANSWER_TOKENS) + THINKING_BUDGET
    : Math.max(wanted, MIN_PLAIN_TOKENS);

  // 目录里有每个模型的输出上限（`limit.output`）。要得超出模型能吐的量会被
  // 拒绝或被上游悄悄截断，所以上限跟着模型走，而不是单一全局常量。
  let ceiling = MAX_OUTPUT_TOKENS;
  try {
    const facts = require("./identity").getModelFacts(modelId);
    if (facts && facts.maxOutput > 0) ceiling = Math.min(ceiling, facts.maxOutput);
  } catch {}
  return Math.min(effective, ceiling);
}

module.exports = {
  MIN_ANSWER_TOKENS,
  THINKING_BUDGET,
  MAX_OUTPUT_TOKENS,
  MIN_PLAIN_TOKENS,
  REASONING_MODEL_HINTS,
  isReasoningModel: 是推理模型,
  isReasoningRequest: 是推理请求,
  effectiveMaxTokens: 生效输出上限,
};
