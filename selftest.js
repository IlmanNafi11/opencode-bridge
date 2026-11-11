const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Runs the repository's own readiness scripts from the panel. One job per
// script, sequential, output kept in memory. Nothing here touches request
// streaming; each script talks to upstream on its own.

const 脚本 = {
  verify: { file: "verify.js", args: ["--quick"], timeoutMs: 180000, title: "Model readiness (verify --quick)" },
  fingerprint: { file: "transport-fingerprint.js", args: ["--check"], timeoutMs: 30000, title: "TLS fingerprint baseline" },
  gatedrill: { file: "gate-drill.js", args: [], timeoutMs: 240000, title: "Gate drill" },
};

const 任务 = new Map();
let 队列 = Promise.resolve();

function 状态(id) {
  const spec = 脚本[id];
  if (!spec) return null;
  const job = 任务.get(id);
  return {
    id,
    title: spec.title,
    running: Boolean(job && job.running),
    startedAt: job ? job.startedAt : null,
    endedAt: job ? job.endedAt : null,
    exitCode: job ? job.exitCode : null,
    ok: job ? job.ok : null,
    output: job ? job.output : "",
  };
}

function 列表() {
  return Object.keys(脚本).map((id) => 状态(id));
}

async function 跑(command, args, { timeoutMs, env, cwd }) {
  const started = Date.now();
  const run = (async () => {
    if (typeof Bun === "undefined" || !Bun.spawn) throw new Error("self-test memerlukan Bun");
    const proc = Bun.spawn([command, ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    let timer;
    const 超时 = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { proc.kill(); } catch {}
        reject(new Error(`timeout after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    });
    try {
      const [stdout, stderr, exitCode] = await Promise.race([
        Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
        超时,
      ]);
      return { stdout, stderr, exitCode, ms: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  })();
  return run;
}

function 启动(id) {
  const spec = 脚本[id];
  if (!spec) return { ok: false, error: "tes tidak dikenal" };
  const current = 任务.get(id);
  if (current && current.running) return { ok: false, error: "tes ini masih berjalan" };
  const job = { running: true, startedAt: Date.now(), endedAt: null, exitCode: null, ok: null, output: "" };
  任务.set(id, job);
  const 执行 = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ofb-selftest-${id}-`));
    const env = {
      ...process.env,
      PANEL_PASSWORD: "",
      FUCKING_OPENCODE_STATE_DIR: dir,
      FUCKING_OPENCODE_CONFIG: "",
    };
    try {
      const result = await 跑(process.execPath, [spec.file, ...spec.args], {
        timeoutMs: spec.timeoutMs,
        env,
        cwd: __dirname,
      });
      job.output = String(result.stdout || "") + String(result.stderr || "");
      job.exitCode = result.exitCode;
      job.ok = result.exitCode === 0;
      job.ms = result.ms;
    } catch (err) {
      job.output = String(err.message || err);
      job.ok = false;
      job.exitCode = null;
    } finally {
      job.running = false;
      job.endedAt = Date.now();
      job.output = String(job.output || "").slice(-24000);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    return 状态(id);
  };
  const chained = 队列.then(执行, 执行);
  队列 = chained.catch(() => {});
  return { ok: true, started: id };
}

module.exports = { 列表, 状态, 启动, 脚本 };
