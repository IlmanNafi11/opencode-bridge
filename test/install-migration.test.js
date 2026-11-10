"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const INSTALLER = path.join(__dirname, "..", "install.sh");

function hasInstaller() {
  return fs.existsSync(INSTALLER);
}

test("installer installs Bun itself instead of dead-ending the user", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // 告诉新用户"先装 Bun"然后退出，就违背了一行安装器的意义。
  // 它必须抓取 Bun，并且除非显式 ALLOW_NODE，绝不回退到 Node。
  assert.match(src, /bun\.sh\/install/, "installer must install Bun when it is missing");
  assert.match(src, /ALLOW_NODE/);
  assert.doesNotMatch(src, /Bun is required but not found/, "installer must not dead-end on a missing Bun");
  // 每次运行时调用都必须走 $RUNTIME，而不是写死的 node。
  const hardcoded = src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .filter((l) => /\bnode\s+["']?\$?BINDIR/.test(l) || /nohup node /.test(l));
  assert.deepEqual(hardcoded, [], "installer still hardcodes node for execution");
});

test("installer fetches every file the runtime needs", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  for (const f of [
    "server.js",
    "identity.js",
    "token-budget.js",
    "verify.js",
    "gate-drill.js",
    "transport-fingerprint.js",
    "transport-baseline.json",
  ]) {
    assert.match(src, new RegExp(`fetch ${f.replace(".", "\\.")}`), `installer does not fetch ${f}`);
  }
});

test("installer ships tunnel-doctor.sh, and validates it before swapping files", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // 已提交但从不下载的文件，对每个用一行命令完成的安装都不可见，
  // tunnel-doctor.sh 最初就是这样漏掉的。
  assert.match(src, /fetch tunnel-doctor\.sh/, "installer does not fetch tunnel-doctor.sh");
  assert.match(
    src,
    /mv -f "\$STAGE\/\$file" "\$BINDIR\/\$file"[\s\S]*tunnel-doctor\.sh|tunnel-doctor\.sh; do[\s\S]*mv -f/,
    "tunnel-doctor.sh is fetched but never moved into BINDIR"
  );
  assert.match(src, /chmod \+x[^\n]*tunnel-doctor\.sh/, "tunnel-doctor.sh is installed without the execute bit");
  // `new Function` 解析不了 bash；只有 `bash -n` 可以，而且必须在停止
  // 运行中的桥之前跑。对照*调用*点：indexOf("stop_own_gateway") 会找到
  // 第 255 行的函数定义。
  const syntaxAt = src.indexOf("bash -n");
  const stopAt = src.indexOf("\nstop_own_gateway\n");
  assert.ok(syntaxAt > -1, "installer never syntax-checks tunnel-doctor.sh");
  assert.ok(stopAt > -1, "installer never calls stop_own_gateway");
  assert.ok(syntaxAt < stopAt, "tunnel-doctor.sh must be validated before the old gateway is stopped");
});

test("installer backs up an existing install before overwriting", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  assert.match(src, /\.backup-v/);
  assert.match(src, /cp -p/);
});

test("installer rewrites a service unit that points at node", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  assert.match(src, /migrate_service_runtime/);
  assert.match(src, /ExecStart=/);
  assert.match(src, /\.bak/);
});

test("installer writes a systemd unit systemd actually accepts", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // systemd 不会剥掉 WorkingDirectory= 上的引号；它把引号当作路径的
  // 一部分并以 "path is not absolute" 失败。ExecStart= 会解析引号，
  // 所以只有目录必须保持裸值。
  assert.doesNotMatch(src, /^WorkingDirectory="/m, "WorkingDirectory must not be quoted");
  assert.match(src, /^WorkingDirectory=\$BINDIR$/m);
  // 重启失败绝不能报告为成功。
  assert.match(src, /if ! systemctl restart fucking-opencode/);
});

test("verify.js separates an IP throttle from a broken gateway", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "verify.js"), "utf8");
  // 403 FreeTierError 是上游拒绝该网络，不是桥的故障。
  // 把它报告为 FAIL 会让正确安装在受限 VPS 上看起来坏掉。
  assert.match(src, /gate-closed/, "verify.js must have a distinct gate-closed state");
  assert.match(src, /process\.exit\(2\)/, "verify.js must exit 2 when only the IP is refused");
  assert.match(src, /free tier can only be used/i, "verify.js must recognise the upstream refusal body");
});

test("installer reports the self-check outcome instead of always claiming a timeout", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  assert.match(src, /CHECK_RC/, "installer must capture the self-check exit code");
  assert.match(src, /124\)/, "installer must distinguish a real timeout");
});

test("installer finds bun installed outside PATH", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // `curl https://bun.sh/install | bash` 只修改交互式 shell 的 PATH。
  // 非交互 SSH 会话即使已安装 bun 也看不到它，
  // 这正是 VPS 在 bun 安装成功后仍失败的原因。
  assert.match(src, /find_bun/, "installer must probe standard bun locations");
  assert.match(src, /\.bun\/bin\/bun/, "installer must look in ~/.bun/bin");
});

test("installer survives a probe that matches nothing under pipefail", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // set -euo pipefail 加上无匹配的 `grep` 会以 1 退出，从而中止整个安装
  // 且不给消息。空探测必须被容忍。
  assert.match(src, /pid_on_port/, "pid probing must go through a pipefail-safe helper");
  assert.match(src, /grep -oP 'pid=\\K\[0-9\]\+' \| head -1 \|\| true/);
});

test("installer can replace its own running gateway", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // 重跑安装器是文档化的更新路径，所以本安装器启动的桥不算端口冲突。
  // 只有外来进程才算。
  assert.match(src, /port_held_by_own_gateway/);
  assert.match(src, /stop_own_gateway/);
  assert.match(src, /! port_held_by_own_gateway/);
});

test("installer parses staged files instead of running bun --check", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // `bun --check` 不是 Bun 支持的标志。Bun 会把参数当作入口点并运行它，
  // 这曾在安装中途启动服务器，让每次升级的"语法检查"都失败。
  assert.doesNotMatch(src, /\$RUNTIME" --check/, "installer must not use bun --check");
  assert.match(src, /new Function\(src\)/, "installer must parse without executing");
});

test("installer refuses to claim success when the gateway never answered", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // 无法绑定的 HOST 过去会让健康循环卡在没有超时的 curl 上，
  // 然后照样打印 "Done"。
  assert.match(src, /curl -fsS -m 2/, "health probe must have a timeout");
  assert.match(src, /GATEWAY_UP/, "installer must track whether /health answered");
  assert.match(src, /install finished but the service is not running/);
});

test("installer checks the TLS fingerprint before declaring success", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // 过旧的 Bun 能安装并运行，然后挣到一个看起来和 IP 额度耗尽一模一样的
  // 403。安装器必须说明这一点。
  assert.match(src, /transport-fingerprint\.js --check/);
  assert.match(src, /does not match the recorded OpenCode CLI baseline/);
});

test("macOS service redirects its log where the docs say it is", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  assert.match(src, /StandardOutPath/);
  assert.match(src, /Library\/Logs\/fucking-opencode\.log/);
});

test("installer stages and validates downloads before stopping the old gateway", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  const stageAt = src.indexOf("ofb-stage");
  const retireCall = src.indexOf("\nretire_legacy_service\n");
  const syntaxAt = src.indexOf("failed a syntax check");
  assert.ok(stageAt > 0, "installer must stage downloads");
  assert.ok(retireCall > 0, "installer must retire the legacy unit");
  assert.ok(syntaxAt > 0, "installer must syntax-check the staged files");
  // 顺序很重要：下载失败必须让运行中的桥保持原样。
  assert.ok(stageAt < retireCall, "staging must happen before the old gateway is stopped");
  assert.ok(syntaxAt < retireCall, "validation must happen before the old gateway is stopped");
});

test("installer retires the pre-2.0 unit that owns the same port", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // 旧发行版发布 fucking-opencode.service。让它保持启用会让新服务在
  // EADDRINUSE 上重启循环，所以升级必须停止并禁用它，
  // 而不是假设机器是干净的。
  assert.match(src, /retire_legacy_service/);
  assert.match(src, /fucking-opencode\.service/);
  assert.match(src, /already in use/, "installer must report a port held by another process");
  assert.match(src, /port \$PORT is occupied/, "an occupied port must abort before anything is changed");
});

test("server refuses to start on Node without ALLOW_NODE", () => {
  // 这是 Node 特有的行为，所以需要真实的 `node` 二进制 ——
  // 在 Bun 下 process.execPath 是 Bun，服务器会（正确地）启动。
  let nodeBin = null;
  for (const candidate of ["/usr/bin/node", "/usr/local/bin/node"]) {
    if (fs.existsSync(candidate)) {
      nodeBin = candidate;
      break;
    }
  }
  if (!nodeBin) {
    try {
      nodeBin = execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim() || null;
    } catch {
      nodeBin = null;
    }
  }
  if (!nodeBin) return; // no Node on this machine; nothing to assert

  const server = path.join(__dirname, "..", "server.js");
  const env = { ...process.env, PORT: "0" };
  delete env.ALLOW_NODE;
  let code = 0;
  let stderr = "";
  try {
    execFileSync(nodeBin, [server], { env, stdio: "pipe", timeout: 5000 });
  } catch (err) {
    code = err.status;
    stderr = String(err.stderr || "");
  }
  assert.equal(code, 1, "Node must exit non-zero");
  assert.match(stderr, /requires Bun/);
  assert.match(stderr, /0\/6[\s\S]*6\/6/, "the message must cite the measurement");
});

test("self-updater in server.js parses JS and JSON in-process instead of spawning bun --check", async () => {
  const serverPath = path.join(__dirname, "..", "server.js");
  const src = fs.readFileSync(serverPath, "utf8");
  assert.doesNotMatch(src, /\["--check"/, "server.js must not invoke --check on Bun");
  assert.match(src, /new Function\(text\.replace\(\/\^#!\.\*\\n\/, ""\)\)/);

  const srv = require("../server");
  const origFetch = global.fetch;
  const prevAuto = process.env.AUTO_UPDATE;
  process.env.AUTO_UPDATE = "force";
  srv.__setLastUpdateCheck(0);
  try {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("package.json")) {
        return {
          ok: true,
          json: async () => ({ version: "99.0.0" }),
          text: async () => JSON.stringify({ name: "fucking-opencode", version: "99.0.0" }),
        };
      }
      if (u.includes("identity.js")) {
        return {
          ok: true,
          text: async () => "const broken = {{{ syntax error;",
        };
      }
      return { ok: true, text: async () => "// valid placeholder script content\nmodule.exports = {};" };
    };
    const res = await srv.checkAndApplyUpdate();
    assert.equal(res.updated, false);
    assert.match(res.error, /syntax check failed for identity\.js/);
  } finally {
    global.fetch = origFetch;
    if (prevAuto === undefined) delete process.env.AUTO_UPDATE;
    else process.env.AUTO_UPDATE = prevAuto;
    srv.__setLastUpdateCheck(Date.now());
  }
});

test("every shipped file reaches installed hosts through both delivery paths", () => {
  const root = path.join(__dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const serverSrc = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const installSrc = fs.readFileSync(path.join(root, "install.sh"), "utf8");

  const updateBlock = serverSrc.match(/const UPDATE_FILES = \[([\s\S]*?)\];/);
  assert.ok(updateBlock, "server.js has no UPDATE_FILES list");
  const updateFiles = [...updateBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  // 这些是已安装桥需要的运行时文件。出现在 package.json 里却不在任一
  // 交付路径的文件谁都装不到，tunnel-doctor.sh 就是这样被提交却缺席于
  // 集群每台主机的。
  const runtime = pkg.files.filter((f) => f !== "README.md" && f !== "AGENTS.md" && f !== "install.sh");
  for (const f of runtime) {
    assert.ok(updateFiles.includes(f), `${f} is in package.json files but not in UPDATE_FILES`);
    assert.ok(installSrc.includes(f), `${f} is in package.json files but install.sh never fetches it`);
  }

  // 没有能理解它的解析器，.sh 条目毫无用处。
  if (updateFiles.some((f) => f.endsWith(".sh"))) {
    assert.match(serverSrc, /bash", \["-n"/, "self-updater fetches a shell script but never runs bash -n on it");
    assert.match(serverSrc, /chmodSync\(tmpPath, 0o755\)/, "self-updater does not mark the shell script executable");
  }
});

test("installer installs the local checkout instead of 404ing on unpushed files", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // 从克隆运行 install.sh 意味着安装该工作树。它过去总是从 GitHub 下载，
  // 所以发布列表加入 proxy.js 后，只存在于本地的文件会以裸
  // `curl: (22) ... 404` 失败。
  assert.match(src, /SOURCE="\$\{SOURCE:-auto\}"/);
  assert.match(src, /cp -p "\$SRC_DIR\/\$file"/, "local source must copy the checkout file");
  assert.match(src, /Source: local checkout/, "the installer must say where files came from");
  // 远端路径必须点明失败的文件以及出路。
  assert.match(src, /could not download \$file from \$RAW/);
  assert.match(src, /SOURCE=local/);
  // 而且两条路径之后健康探测都必须仍然运行。
  assert.match(src, /probe_health/);
});

test("verify.js checks runtime and TLS baseline before blaming the IP for a closed gate", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "verify.js"), "utf8");
  assert.match(src, /health\.runtime\.startsWith\("node\/"\)/);
  assert.match(src, /TLS fingerprint drift detected/);
});

test("a server.js that requires a module the old updater never fetched still boots", async () => {
  // 2.1.0 的 UPDATE_FILES 没有 proxy.js/panel.js。把该安装更新到 2.2.0
  // 因此写出了顶层 require 指向更新器从未下载的文件的 server.js，
  // 重启便在 "Cannot find module './proxy'" 上崩溃循环。这里对临时树复现：
  // 模块加载器必须退化为直连出口，而不是抛错。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-missing-module-"));
  const serverPath = path.join(tmp, "server.js");
  try {
    // 每个真实的同级模块，除了 2.1.0 更新器不知道的那两个。
    // `token-budget` 是硬 require，必须保留，否则测的就是另一种失败。
    for (const f of fs.readdirSync(path.join(__dirname, ".."))) {
      if (!f.endsWith(".js") || f === "proxy.js" || f === "panel.js") continue;
      fs.copyFileSync(path.join(__dirname, "..", f), path.join(tmp, f));
    }
    fs.copyFileSync(path.join(__dirname, "..", "package.json"), path.join(tmp, "package.json"));
    assert.equal(fs.existsSync(path.join(tmp, "proxy.js")), false);
    // `proxy.js` 和 `panel.js` 被刻意从这个目录排除。
    const out = execFileSync(
      process.execPath,
      ["-e", `const m = require(${JSON.stringify(serverPath)}); console.log(typeof m.__repairMissingModules)`],
      { encoding: "utf8", env: { ...process.env, ALLOW_NODE: "1" } }
    );
    assert.match(out, /function/, "server.js must load without proxy.js/panel.js");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the updater stages every local module the incoming server.js requires", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // 守卫必须读取*传入的* server.js 并抓取它的 import，这样旧文件清单
  // 无法安装一个它启动不了的服务器。
  assert.match(src, /本地require\(fs\.readFileSync\(incoming\.tmpPath/, "updater does not inspect the incoming server.js");
  assert.match(src, /已暂存新要求的模块/, "updater never logs a staged dependency");
  // 而且启动要修复一棵已经缺模块的树。
  assert.match(src, /repairMissingModules\(\)/, "boot never repairs missing modules");
});

test("the panel API refuses cross-site and non-JSON writes", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /function adminRequestError/, "no admin request guard");
  assert.match(src, /sec-fetch-site/, "guard ignores Sec-Fetch-Site");
  assert.match(src, /type !== "application\/json"/, "guard accepts non-JSON bodies (CSRF)");
  assert.match(src, /PANEL_ALLOWED_HOSTS/, "no escape hatch documented for a reverse proxy");
});

test("the Docker image persists the panel proxy setting outside the container", () => {
  const root = path.join(__dirname, "..");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const compose = fs.readFileSync(path.join(root, "docker-compose.yaml"), "utf8");
  assert.match(dockerfile, /FUCKING_OPENCODE_STATE_DIR=\/data\/state/);
  assert.match(compose, /FUCKING_OPENCODE_STATE_DIR: \/data\/state/);
  assert.match(compose, /fucking-opencode-state:\/data\/state/);
  assert.match(compose, /^  fucking-opencode-state:$/m, "compose does not declare the fucking-opencode-state volume");
});
