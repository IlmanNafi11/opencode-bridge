// server.js 在 `node` 下会拒绝启动（TLS 指纹过不了免费档网关），只有显式
// ALLOW_NODE=1 才进入离线模式。这些测试在两种运行时下都要验证 HTTP 契约，
// 所以子进程一律带该开关，并用最小启动器抹平 Bun/Node 的 spawn 差异。
const { spawn } = require("node:child_process");

function 启动子进程(args, options = {}) {
  if (typeof Bun !== "undefined" && typeof Bun.spawn === "function") {
    const proc = Bun.spawn(args, options);
    return { kill: () => proc.kill(), exited: proc.exited };
  }
  const [cmd, ...rest] = args;
  const proc = spawn(cmd, rest, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", options.stdout || "ignore", options.stderr || "ignore"],
  });
  return {
    kill: () => {
      try {
        proc.kill();
      } catch {}
    },
    exited: new Promise((resolve) => proc.once("exit", () => resolve())),
  };
}

module.exports = { 启动子进程 };
