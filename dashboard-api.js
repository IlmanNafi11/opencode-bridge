// Read-mostly admin endpoints for the panel's observability, diagnostics,
// fleet, ops, key and self-test views. server.js calls 初始化 once and then
// forwards any request whose path starts with one of the handled prefixes.
//
// Every endpoint repeats the management-plane guards: panel session, loopback
// Host/Origin for writes, and JSON Content-Type for JSON bodies.

let ctx = null;

function 初始化(context) {
  ctx = context;
}

function 发送(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function 保护(req, res, { write = false } = {}) {
  if (write) {
    const denied = ctx.adminRequestError(req);
    if (denied) {
      发送(res, 403, { error: denied });
      return false;
    }
  }
  if (!ctx.panelAuthorized(req)) {
    ctx.panelUnauthorized(res);
    return false;
  }
  return true;
}

async function 读JSON(req, res, limit = 256 * 1024) {
  const type = String(req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    发送(res, 415, { error: "Content-Type harus application/json." });
    return null;
  }
  try {
    const text = await ctx.readRequestBody(req, limit);
    return text ? JSON.parse(text) : {};
  } catch (err) {
    发送(res, err.statusCode === 413 ? 413 : 400, { error: `请求体无效：${err.message}` });
    return null;
  }
}

function 样本() {
  try {
    return ctx.采样样本() || {};
  } catch {
    return {};
  }
}

function 模型详情(alias) {
  const groups = ctx.config.取("modelGroups") || {};
  const names = alias ? [alias] : Object.keys(groups);
  const cooldowns = ctx.modelGroups.诊断();
  const 冷却表 = new Map(cooldowns.map((row) => [row.model, row]));
  return names
    .filter((name) => !alias || groups[name])
    .map((name) => {
      const candidates = ctx.modelGroups.组成员(name) || [];
      const allowed = ctx.modelGroups.候选(name);
      const rows = candidates.map((model) => {
        const cooldown = 冷却表.get(model);
        const verdict = typeof ctx.模型判定 === "function" ? ctx.模型判定(model) : null;
        return {
          model,
          skipped: Boolean(cooldown) || (verdict && verdict !== "free"),
          cooldown: cooldown || null,
          verdict: verdict || "free",
        };
      });
      return { alias: name, candidates: rows, usable: allowed, configured: candidates };
    });
}

async function 处理(req, res, pathname) {
  if (!ctx) return false;
  const method = req.method;
  const url = new URL(req.url, `http://${req.headers?.host || "127.0.0.1"}`);

  if (pathname === "/api/observability" && method === "GET") {
    if (!保护(req, res)) return true;
    发送(res, 200, {
      ...ctx.obs.快照(样本()),
      ops: { safeMode: ctx.ops.状态(), maintenance: ctx.ops.维护状态() },
      webhook: ctx.notify.配置(),
      sessions: typeof ctx.会话快照 === "function" ? ctx.会话快照() : [],
      alerts: typeof ctx.告警 === "function" ? ctx.告警() : [],
      now: Date.now(),
    });
    return true;
  }

  if (pathname === "/api/observability/clear" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 16 * 1024);
    if (body === null) return true;
    const result = ctx.obs.清空();
    ctx.记录事件("面板：jejak observability dibersihkan", "info");
    ctx.审计(req, "observability.clear", { ok: true });
    发送(res, 200, result);
    return true;
  }

  if (pathname === "/api/models" && method === "GET") {
    if (!保护(req, res)) return true;
    发送(res, 200, {
      groups: 模型详情(null),
      cooldowns: ctx.modelGroups.诊断(),
      online: typeof ctx.模型列表 === "function" ? ctx.模型列表() : [],
      defaultModel: ctx.config.取("defaultModel") || "",
    });
    return true;
  }

  if (pathname === "/api/models/test" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 16 * 1024);
    if (body === null) return true;
    const alias = String(body.alias || "").trim();
    if (!alias) {
      发送(res, 400, { error: "alias wajib diisi" });
      return true;
    }
    const detail = 模型详情(alias);
    if (detail.length === 0) {
      const verdict = typeof ctx.模型判定 === "function" ? ctx.模型判定(alias) : "free";
      发送(res, 200, {
        alias,
        candidates: [{ model: alias, skipped: verdict !== "free", cooldown: null, verdict }],
        usable: verdict === "free" ? [alias] : [],
        configured: [alias],
        probe: "shape-only",
      });
      return true;
    }
    发送(res, 200, { alias, ...detail[0] });
    return true;
  }

  if (pathname === "/api/diag/payload" && method === "GET") {
    if (!保护(req, res)) return true;
    发送(res, 200, {
      shapes: ctx.obs.快照(样本()).shapes,
      gate: typeof ctx.健康上下文 === "function" ? ctx.健康上下文() : {},
    });
    return true;
  }

  if (pathname === "/api/diagnostics/bundle" && method === "GET") {
    if (!保护(req, res)) return true;
    try {
      const bundle = ctx.diagnostics.构建({ 收集: ctx.收集诊断 });
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${bundle.filename}"`,
        "Content-Length": bundle.bytes.length,
        "Cache-Control": "no-store",
      });
      res.end(bundle.bytes);
    } catch (err) {
      发送(res, 500, { error: `gagal membuat bundle: ${err.message}` });
    }
    return true;
  }

  if (pathname === "/api/selftest" && method === "GET") {
    if (!保护(req, res)) return true;
    发送(res, 200, { tests: ctx.selftest.列表() });
    return true;
  }

  if (pathname === "/api/selftest" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 8 * 1024);
    if (body === null) return true;
    const result = ctx.selftest.启动(String(body.test || ""));
    if (!result.ok) {
      发送(res, 400, result);
      return true;
    }
    ctx.记录事件(`面板：self-test ${body.test} dimulai`, "info");
    发送(res, 200, { ...result, tests: ctx.selftest.列表() });
    return true;
  }

  if (pathname === "/api/ops" && method === "GET") {
    if (!保护(req, res)) return true;
    发送(res, 200, {
      safeMode: ctx.ops.状态(),
      maintenance: ctx.ops.维护状态(),
      webhook: ctx.notify.配置(),
      selftest: ctx.selftest.列表(),
    });
    return true;
  }

  if (pathname === "/api/ops/safe-mode" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 8 * 1024);
    if (body === null) return true;
    const state = body.enabled === false
      ? ctx.ops.关闭()
      : ctx.ops.开启({
          minutes: body.minutes,
          singleLane: body.singleLane,
          noRotation: body.noRotation,
          reason: body.reason,
        });
    ctx.记录事件(`面板：safe mode ${state.enabled ? "aktif" : "nonaktif"}`, state.enabled ? "warn" : "info");
    ctx.审计(req, "ops.safe-mode", { ok: true, enabled: state.enabled });
    发送(res, 200, { ok: true, safeMode: state });
    return true;
  }

  if (pathname === "/api/ops/maintenance" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 16 * 1024);
    if (body === null) return true;
    const result = ctx.ops.保存维护(body);
    if (!result.ok) {
      发送(res, 400, result);
      return true;
    }
    ctx.记录事件(`面板：maintenance ${result.maintenance.enabled ? "aktif" : "nonaktif"}`, "info");
    ctx.审计(req, "ops.maintenance", { ok: true, enabled: result.maintenance.enabled });
    发送(res, 200, result);
    return true;
  }

  if (pathname === "/api/ops/webhook-test" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 8 * 1024);
    if (body === null) return true;
    try {
      const result = await ctx.notify.测试();
      发送(res, 200, { ok: Boolean(result.ok), result });
    } catch (err) {
      发送(res, 200, { ok: false, error: err.message });
    }
    return true;
  }

  if (pathname === "/api/keys/usage" && method === "GET") {
    if (!保护(req, res)) return true;
    发送(res, 200, typeof ctx.密钥用量 === "function" ? ctx.密钥用量() : { keys: [] });
    return true;
  }

  if (pathname === "/api/sessions" && method === "GET") {
    if (!保护(req, res)) return true;
    发送(res, 200, { sessions: typeof ctx.会话快照 === "function" ? ctx.会话快照() : [] });
    return true;
  }

  if (pathname === "/api/farm/probe" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 8 * 1024);
    if (body === null) return true;
    const farm = ctx.farm.状态() || {};
    const lanes = Array.isArray(farm.lanes) ? farm.lanes : [];
    const lane = lanes.find((row) => Number(row.index) === Number(body.index)) || lanes[Number(body.index) || 0];
    if (!lane || !lane.url) {
      发送(res, 404, { error: "lane tidak ditemukan" });
      return true;
    }
    const started = Date.now();
    const verdict = await ctx.proxy.testProxy(lane.url, { timeoutMs: 15000 });
    发送(res, 200, {
      lane: { index: lane.index, port: lane.port, ready: Boolean(lane.ready), egress: lane.egress || null },
      ok: Boolean(verdict.ok),
      apiStatus: verdict.apiStatus || null,
      exitIp: verdict.exitIp || null,
      latencyMs: verdict.latencyMs || Date.now() - started,
      error: verdict.error || null,
    });
    return true;
  }

  if (pathname === "/api/farm/rotate" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 8 * 1024);
    if (body === null) return true;
    const farm = ctx.farm.状态() || {};
    const lanes = Array.isArray(farm.lanes) ? farm.lanes : [];
    const lane = lanes.find((row) => Number(row.index) === Number(body.index));
    const port = body.port || (lane && lane.port);
    const result = await ctx.farm.轮换(port || null);
    ctx.记录事件(`面板：rotate lane ${port || "semua"} (${result.ok ? "ok" : result.error || "gagal"})`, result.ok ? "info" : "warn");
    ctx.审计(req, "farm.rotate", { ok: Boolean(result.ok), port: port || null });
    发送(res, result.ok ? 200 : 502, result);
    return true;
  }

  if (pathname === "/api/backup/preview" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 1024 * 1024);
    if (body === null) return true;
    if (typeof ctx.备份预览 !== "function") {
      发送(res, 501, { error: "preview tidak tersedia" });
      return true;
    }
    发送(res, 200, ctx.备份预览(body.files || {}));
    return true;
  }

  if (pathname === "/api/audit" && method === "GET") {
    if (!保护(req, res)) return true;
    const limit = Number(url.searchParams.get("limit")) || 200;
    发送(res, 200, { entries: ctx.audit.读取(limit), stats: ctx.audit.统计() });
    return true;
  }

  if (pathname === "/api/audit" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 8 * 1024);
    if (body === null) return true;
    if (body.clear === true) {
      const result = ctx.audit.清理(0);
      ctx.审计(req, "audit.clear", { removed: result.removed });
      发送(res, 200, { ok: true, ...result });
      return true;
    }
    发送(res, 400, { error: "aksi tidak dikenal" });
    return true;
  }

  if (pathname === "/api/retention" && method === "GET") {
    if (!保护(req, res)) return true;
    发送(res, 200, { retention: ctx.retention.状态() });
    return true;
  }

  if (pathname === "/api/retention" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 8 * 1024);
    if (body === null) return true;
    const result = ctx.retention.保存(body);
    ctx.审计(req, "retention.save", { enabled: result.retention.enabled });
    发送(res, 200, result);
    return true;
  }

  if (pathname === "/api/retention/run" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const result = ctx.retention.执行();
    ctx.审计(req, "retention.run", { ok: result.ok });
    发送(res, result.ok ? 200 : 500, result);
    return true;
  }

  if (pathname === "/api/backups" && method === "GET") {
    if (!保护(req, res)) return true;
    发送(res, 200, { backup: ctx.backup.状态(), snapshots: ctx.backup.列表(), whitelist: ctx.backup.白名单 });
    return true;
  }

  if (pathname === "/api/backups" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 8 * 1024);
    if (body === null) return true;
    if (body.create === true || body.action === "create") {
      const result = ctx.backup.创建();
      ctx.审计(req, "backup.create", { ok: result.ok, files: result.files || [] });
      发送(res, result.ok ? 200 : 500, { ...result, snapshots: ctx.backup.列表() });
      return true;
    }
    const result = ctx.backup.保存(body);
    ctx.审计(req, "backup.save", { enabled: result.backup.enabled, intervalHours: result.backup.intervalHours });
    发送(res, 200, result);
    return true;
  }

  if (pathname === "/api/backups/restore" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 8 * 1024);
    if (body === null) return true;
    const name = String(body.name || "").trim();
    if (!name) {
      发送(res, 400, { error: "name wajib diisi" });
      return true;
    }
    const result = ctx.backup.恢复(name, { reload: (files) => ctx.reloadState && ctx.reloadState(files) });
    ctx.审计(req, "backup.restore", { ok: result.ok, name, restored: result.restored || [], error: result.error || "" });
    发送(res, result.ok ? 200 : 400, result);
    return true;
  }

  if (pathname === "/api/autoheal" && method === "GET") {
    if (!保护(req, res)) return true;
    发送(res, 200, { autoheal: ctx.autoheal.快照() });
    return true;
  }

  if (pathname === "/api/autoheal" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 8 * 1024);
    if (body === null) return true;
    const result = ctx.autoheal.保存(body);
    ctx.审计(req, "autoheal.save", { enabled: result.autoheal ? result.autoheal.enabled : null });
    发送(res, 200, result);
    return true;
  }

  if (pathname === "/api/autoheal/run" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const result = await ctx.runAutoheal();
    ctx.审计(req, "autoheal.run", { ok: result.ok !== false });
    发送(res, 200, result);
    return true;
  }

  if (pathname === "/api/notify" && method === "GET") {
    if (!保护(req, res)) return true;
    发送(res, 200, { notify: ctx.notify.配置() });
    return true;
  }

  if (pathname === "/api/notify" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 32 * 1024);
    if (body === null) return true;
    const result = ctx.notify.保存(body);
    ctx.审计(req, "notify.save", { ok: result.ok !== false, targets: Array.isArray(body.targets) ? body.targets.length : null });
    发送(res, result.ok === false ? 400 : 200, result);
    return true;
  }

  if (pathname === "/api/notify/test" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 8 * 1024);
    if (body === null) return true;
    try {
      const result = await ctx.notify.测试(String(body.targetId || ""));
      ctx.审计(req, "notify.test", { ok: Boolean(result.ok), target: String(body.targetId || "") });
      发送(res, 200, { ok: Boolean(result.ok), result });
    } catch (err) {
      发送(res, 200, { ok: false, error: err.message });
    }
    return true;
  }

  if (pathname === "/api/models/simulate" && method === "GET") {
    if (!保护(req, res)) return true;
    const model = String(url.searchParams.get("model") || "").trim();
    if (!model) {
      发送(res, 400, { error: "model wajib diisi" });
      return true;
    }
    发送(res, 200, ctx.modelGroups.模拟(model));
    return true;
  }

  if (pathname === "/api/farm/resize" && method === "POST") {
    if (!保护(req, res, { write: true })) return true;
    const body = await 读JSON(req, res, 8 * 1024);
    if (body === null) return true;
    if (typeof ctx.farm.调整规模 !== "function") {
      发送(res, 501, { error: "resize tidak tersedia" });
      return true;
    }
    const result = await ctx.farm.调整规模(Number(body.size));
    ctx.审计(req, "farm.resize", { ok: result.ok, size: Number(body.size) });
    发送(res, result.ok ? 200 : 400, result);
    return true;
  }

  return false;
}

module.exports = { 初始化, 处理 };
