"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const VERIFY = path.join(__dirname, "..", "verify.js");
const INSTALLER = path.join(__dirname, "..", "install.sh");

test("--quick stops at the first success instead of probing every model", () => {
  const src = fs.readFileSync(VERIFY, "utf8");
  // 回归：安装器调用 --quick 后等待全部九个模型，
  // 每个都有 120s 超时。最坏情况让 `install.sh` 看起来卡死。
  assert.match(src, /if \(QUICK && r\.state === "ok"\) break;/, "quick mode must break on first success");
  assert.match(src, /QUICK \? models\.slice\(0, 3\)/, "quick mode must cap how many models it probes");
});

test("--quick uses a shorter per-request timeout", () => {
  const src = fs.readFileSync(VERIFY, "utf8");
  assert.match(src, /timeoutMs = QUICK \? 25000 : 120000/, "quick mode must not inherit the 120s timeout");
});

test("installer bounds its self-check with a timeout", () => {
  const src = fs.readFileSync(INSTALLER, "utf8");
  assert.match(src, /timeout 120/, "installer must not wait forever on a throttled upstream");
  // 安装器过去对每个非零退出都打印 "did not finish in 120s"，
  // 包括快速、正确的"此 IP 被限流"。现在它报告实际结果，
  // 只有退出码 124 才点名为超时。
  assert.match(src, /124\)/, "installer must explain a genuinely timed-out self-check");
  assert.match(src, /CHECK_RC/, "installer must inspect the self-check exit code");
  assert.doesNotMatch(
    src,
    /verify\.js" --quick \|\| \\\n\s+warn "self-check did not finish/,
    "installer must not report every failure as a timeout"
  );
});

test("installer detaches the gateway without a subshell", () => {
  const src = fs.readFileSync(INSTALLER, "utf8");
  // 回归：`( cd ... && nohup ... & )` 让 bash 等待子进程，所以
  // 管道式安装器会阻塞到桥退出。最小复现实测 70s，
  // 真实安装 102s；pushd+setsid 形式 0.004s 完成。
  assert.doesNotMatch(
    src,
    /\(\s*cd[^)]*&\s*\)/,
    "installer must not background the gateway inside a subshell"
  );
  assert.match(src, /pushd "\$BINDIR"/, "installer must change directory without forking");
  assert.match(src, /setsid env PORT=/, "installer must detach into a new session");
  assert.match(src, /<\/dev\/null/, "detached gateway must not inherit the caller's stdin");
});

test("verify maps a labeled abuse block to GATE (exit 2) and a shape rejection to FAIL (exit 1)", async () => {
  const abuse =
    "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address. This isn't related to your account.";

  const runAgainst = (gateHeader) =>
    new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const pathname = String(req.url || "").split("?")[0];
        if (pathname === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ status: "ok", version: "2.0.2", runtime: "bun/1.4.2", discoveredModels: 1 }));
        }
        if (pathname === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ data: [{ id: "fake-free" }] }));
        }
        if (req.method === "POST" && pathname === "/v1/chat/completions") {
          const headers = { "Content-Type": "application/json" };
          if (gateHeader) headers["x-opencode-gate"] = gateHeader;
          res.writeHead(403, headers);
          return res.end(JSON.stringify({ error: { type: "FreeTierError", message: abuse } }));
        }
        res.writeHead(404);
        res.end();
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        const child = spawn(process.execPath, [VERIFY, "--quick"], {
          env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", (err) => {
          server.close();
          reject(err);
        });
        child.on("close", (code) => {
          server.close();
          resolve({ code, stdout, stderr });
        });
      });
    });

  // 桥会给拒绝打标签，所以裁定不依赖措辞。
  const labeled = await runAgainst("ip-abuse");
  assert.equal(labeled.code, 2, labeled.stdout + labeled.stderr);
  assert.match(labeled.stdout, /GATE/);
  assert.match(labeled.stdout, /桥健康，但上游拒绝了这个 IP/);

  // 早于该响应头的桥仍必须按消息分类。
  const unlabeled = await runAgainst(null);
  assert.equal(unlabeled.code, 2, unlabeled.stdout + unlabeled.stderr);
  assert.match(unlabeled.stdout, /GATE/);

  // 同一条消息带形态拒绝标签是桥的 bug，不是 IP 问题。
  const shape = await runAgainst("shape-rejected");
  assert.equal(shape.code, 1, shape.stdout + shape.stderr);
  assert.match(shape.stdout, /FAIL/);
  assert.doesNotMatch(shape.stdout, /桥健康，但上游拒绝了这个 IP/);
});
