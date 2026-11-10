#!/usr/bin/env bun
/**
 * stats.js：本地用量统计与请求历史。
 *
 * 数据只落本机：`<状态目录>/usage.jsonl`，一行一条 JSON 请求记录。
 * 面板的"用量统计/请求历史"标签页与 `/api/stats`、`/api/history` 都从
 * 这份文件读。绝不存消息内容 —— 只存模型、耗时、词元、状态、错误摘要
 * （截断到 200 字符，错误消息可能包含上游的提示文本）。
 *
 * 写入尽力而为：磁盘满/只读绝不影响推理请求本身。
 * 读取按需扫描；文件超过上限（默认 5 MB）时启动截断到最新一半，
 * 防止长期运行无限增长。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** 状态目录：与 proxy.js 的 proxy.json 同目录（FUCKING_OPENCODE_STATE_DIR
 *  或 ~/.fucking-opencode）。 */
function 状态目录() {
  const raw = process.env.FUCKING_OPENCODE_STATE_DIR;
  const dir = raw && raw.trim()
    ? raw.trim()
    : path.join(process.env.USERPROFILE || process.env.HOME || ".", ".fucking-opencode");
  return dir;
}

/**
 * 用量文件可以单独指定，便于与 opencode2api 或另一个实例并排运行时
 * 各自记账。`FUCKING_OPENCODE_USAGE_FILE` 支持绝对路径，也支持相对
 * 状态目录的路径；未设置时保持旧行为 `<状态目录>/usage.jsonl`。
 */
function 用量文件路径() {
  const raw = process.env.FUCKING_OPENCODE_USAGE_FILE;
  if (raw !== undefined && String(raw).trim()) {
    const value = String(raw).trim();
    return path.isAbsolute(value) ? value : path.join(状态目录(), value);
  }
  return path.join(状态目录(), "usage.jsonl");
}

/** 单条记录上限。超出即丢（不可能发生：字段都截断过）。 */
const 记录上限字节 = 64 * 1024;
/** 文件大小上限：超过则在下次启动时截断到最新一半。 */
const 文件上限字节 = 5 * 1024 * 1024;

let 已截断 = false;

/** 启动时截断超大历史。 */
function 启动截断() {
  if (已截断) return;
  已截断 = true;
  try {
    const file = 用量文件路径();
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return;
    }
    if (st.size <= 文件上限字节) return;
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const keep = lines.slice(Math.floor(lines.length / 2));
    fs.writeFileSync(file, keep.length ? keep.join("\n") + "\n" : "", "utf8");
  } catch {}
}

/** 记一次请求。全部字段先收窄再写盘；任何错误静默。 */
function 记录请求(条目 = {}) {
  try {
    启动截断();
    const rec = {
      at: Date.now(),
      model: String(条目.model || "").slice(0, 120),
      protocol: String(条目.protocol || "openai").slice(0, 24), // openai | anthropic | responses
      status: Number.isFinite(条目.status) ? 条目.status : 0,
      ms: Number.isFinite(条目.ms) ? Math.round(条目.ms) : 0,
      stream: Boolean(条目.stream),
      input_tokens: Number.isFinite(条目.input_tokens) ? 条目.input_tokens : null,
      cached_tokens: Number.isFinite(条目.cached_tokens) ? 条目.cached_tokens : null,
      output_tokens: Number.isFinite(条目.output_tokens) ? 条目.output_tokens : null,
      /** 首字时间：仅流式路径可测；非流式为 null，面板显示「–」。 */
      ttft_ms: Number.isFinite(条目.ttft_ms) ? Math.round(条目.ttft_ms) : null,
      /** 供应商：本桥只有一个上游（opencode.ai），由服务端标注。 */
      provider: String(条目.provider || "").slice(0, 40),
      /** 入站客户端地址，只用于本机分面统计。 */
      client_ip: String(条目.client_ip || "").slice(0, 64),
      /** 密钥标签的机器值（default / none），面板再本地化。 */
      key_label: String(条目.key_label || "").slice(0, 40),
      request_id: String(条目.request_id || "").slice(0, 64),
      egress: String(条目.egress || "").slice(0, 64),
      error: 条目.error ? String(条目.error).slice(0, 200) : null,
    };
    const line = JSON.stringify(rec);
    if (Buffer.byteLength(line) > 记录上限字节) return;
    fs.mkdirSync(状态目录(), { recursive: true });
    fs.appendFileSync(用量文件路径(), line + "\n", "utf8");
  } catch {}
}

/** 读全部历史（ newest 在后）。文件损坏的行跳过。 */
function 读历史() {
  try {
    const raw = fs.readFileSync(用量文件路径(), "utf8");
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec === "object" && rec.at) out.push(rec);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

/** 汇总统计（可选 from/to 毫秒时间戳过滤）。 */
function 汇总({ from = null, to = null } = {}) {
  const 全部 = 读历史().filter((r) => (from == null || r.at >= from) && (to == null || r.at <= to));
  const 按模型 = new Map();
  let 成功 = 0;
  let 失败 = 0;
  let 总耗时 = 0;
  let 输入词元 = 0;
  let 缓存词元 = 0;
  let 输出词元 = 0;
  let 有词元 = 0;
  for (const r of 全部) {
    const ok = r.status >= 200 && r.status < 300;
    if (ok) 成功 += 1;
    else 失败 += 1;
    总耗时 += r.ms || 0;
    if (r.input_tokens != null) 输入词元 += r.input_tokens;
    if (r.cached_tokens != null) 缓存词元 += r.cached_tokens;
    if (r.output_tokens != null) 输出词元 += r.output_tokens;
    if (r.input_tokens != null || r.output_tokens != null) 有词元 += 1;
    const key = r.model || "(未知)";
    const m = 按模型.get(key) || { model: key, requests: 0, ok: 0, fail: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, total_ms: 0 };
    m.requests += 1;
    if (ok) m.ok += 1;
    else m.fail += 1;
    m.input_tokens += r.input_tokens || 0;
    m.cached_tokens += r.cached_tokens || 0;
    m.output_tokens += r.output_tokens || 0;
    m.total_ms += r.ms || 0;
    按模型.set(key, m);
  }
  const models = [...按模型.values()].sort((a, b) => b.requests - a.requests);

  /** 按任意字段分面聚合：面板的「分类」标签页直接消费这份结果。 */
  const 分组 = (字段) => {
    const map = new Map();
    for (const r of 全部) {
      const 键 = String(r[字段] || "").slice(0, 80) || "(未知)";
      const g = map.get(键) || {
        key: 键, requests: 0, ok: 0, fail: 0,
        input_tokens: 0, cached_tokens: 0, output_tokens: 0, total_ms: 0,
      };
      const ok = r.status >= 200 && r.status < 300;
      g.requests += 1;
      if (ok) g.ok += 1;
      else g.fail += 1;
      g.input_tokens += r.input_tokens || 0;
      g.cached_tokens += r.cached_tokens || 0;
      g.output_tokens += r.output_tokens || 0;
      g.total_ms += r.ms || 0;
      map.set(键, g);
    }
    return [...map.values()].sort((a, b) => b.requests - a.requests);
  };

  // 分位数只取成功请求的耗时：失败请求的毫秒数是放弃时间，不是延迟。
  const 成功耗时 = 全部
    .filter((r) => r.status >= 200 && r.status < 300)
    .map((r) => r.ms || 0)
    .sort((a, b) => a - b);
  const 分位 = (p) => (成功耗时.length ? 成功耗时[Math.min(成功耗时.length - 1, Math.floor((成功耗时.length - 1) * p))] : 0);

  // 首字时间只统计测到的流式请求。
  let 首字和 = 0;
  let 首字数 = 0;
  for (const r of 全部) {
    if (Number.isFinite(r.ttft_ms)) {
      首字和 += r.ttft_ms;
      首字数 += 1;
    }
  }
  const 客户端集合 = new Set();
  for (const r of 全部) if (r.client_ip) 客户端集合.add(r.client_ip);

  return {
    total: 全部.length,
    ok: 成功,
    fail: 失败,
    avg_ms: 全部.length ? Math.round(总耗时 / 全部.length) : 0,
    input_tokens: 输入词元,
    cached_tokens: 缓存词元,
    output_tokens: 输出词元,
    token_coverage: 全部.length ? Math.round((有词元 / 全部.length) * 100) : 0,
    series: 时间序列(全部, from, to),
    models,
    providers: 分组("provider"),
    clients: 分组("client_ip"),
    keys: 分组("key_label"),
    p50_ms: 分位(0.5),
    p95_ms: 分位(0.95),
    p99_ms: 分位(0.99),
    ttft_avg_ms: 首字数 ? Math.round(首字和 / 首字数) : null,
    ttft_samples: 首字数,
    client_count: 客户端集合.size,
  };
}

/**
 * 词元组成的时间序列。范围缺省时取首条记录到最后一刻；固定切成
 * 24 个桶，让图表点数稳定，不随历史长度膨胀。
 */
function 时间序列(记录, from, to) {
  if (!记录.length) return [];
  const 起点 = from != null ? from : Math.min(...记录.map((r) => r.at));
  const 终点 = to != null ? to : Math.max(Date.now(), Math.max(...记录.map((r) => r.at)));
  const 跨度 = Math.max(终点 - 起点, 60 * 60 * 1000);
  const 桶数 = 24;
  const 宽度 = 跨度 / 桶数;
  const 桶 = Array.from({ length: 桶数 }, (_, i) => ({ t: Math.round(起点 + i * 宽度), requests: 0, input: 0, cached: 0, output: 0 }));
  for (const r of 记录) {
    const index = Math.min(桶数 - 1, Math.max(0, Math.floor((r.at - 起点) / 宽度)));
    桶[index].requests += 1;
    桶[index].input += r.input_tokens || 0;
    桶[index].cached += r.cached_tokens || 0;
    桶[index].output += r.output_tokens || 0;
  }
  return 桶;
}

/** 按出口/模型汇总近期结果：429、5xx、连续成功与最后 429 时间。 */
function 诊断汇总({ hours = 24 } = {}) {
  const 起 = Date.now() - Math.max(1, Number(hours) || 24) * 3600 * 1000;
  const 全部 = 读历史().filter((r) => r.at >= 起);
  const 聚合 = (字段) => {
    const map = new Map();
    for (const r of 全部) {
      const 键 = String(r[字段] || "").slice(0, 80) || "(未知)";
      const g = map.get(键) || {
        key: 键, requests: 0, ok: 0, fail: 0, rate429: 0, count5xx: 0,
        last429At: null, 连续成功: 0,
      };
      const ok = r.status >= 200 && r.status < 300;
      g.requests += 1;
      if (ok) { g.ok += 1; g.连续成功 += 1; }
      else { g.fail += 1; g.连续成功 = 0; }
      if (r.status === 429) { g.rate429 += 1; g.last429At = r.at || null; }
      if (r.status >= 500 && r.status < 600) g.count5xx += 1;
      map.set(键, g);
    }
    return [...map.values()].sort((a, b) => b.requests - a.requests);
  };
  return {
    hours: Math.max(1, Number(hours) || 24),
    total: 全部.length,
    egress: 聚合("egress"),
    models: 聚合("model"),
  };
}

/** 清空历史。`before` 为毫秒时间戳时只删更早的。 */
function 清空历史({ before = null } = {}) {
  try {
    if (before == null) {
      fs.rmSync(用量文件路径(), { force: true });
      return { ok: true, removed: "all" };
    }
    const 全部 = 读历史();
    const keep = 全部.filter((r) => r.at >= before);
    fs.writeFileSync(用量文件路径(), keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""), "utf8");
    return { ok: true, removed: 全部.length - keep.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** 新请求 id：req_ + 12 随机字节。 */
function 新请求标识() {
  return `req_${crypto.randomBytes(12).toString("hex")}`;
}

module.exports = {
  记录请求,
  读历史,
  汇总,
  诊断汇总,
  清空历史,
  新请求标识,
  用量文件路径,
};
