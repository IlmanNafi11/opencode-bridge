#!/usr/bin/env bun
/**
 * transport-fingerprint.js — 记录并比对出站 TLS ClientHello。
 *
 * 它存在的理由：免费档网关检查的是传输层，不只是请求头。同一 IP 一分钟内、
 * 完全相同的请求实测：
 *
 *   真 CLI v2.0.32（Bun）      200
 *   桥跑在 Bun 上              200 (6/6)
 *   桥跑在 Node 上             403 (0/6)
 *   curl，HTTP/1.1 或 h2       403
 *
 * 所以桥依赖 Bun 的 TLS 栈与 CLI 一致。Bun 1.4.2（CLI 2.0.32 内置）与 1.4.3
 * 目前产生完全相同的 ClientHello，但没人保证 1.5 也如此。本脚本把漂移变成
 * 可见事实：开一个 TCP 监听，把 fetch 指过去，不用任何 TLS 库直接解析
 * ClientHello。
 *
 *   bun transport-fingerprint.js                 打印当前运行时的指纹
 *   bun transport-fingerprint.js --check         与基线不一致则退出码 1
 *   bun transport-fingerprint.js --write-baseline  记录当前指纹为基线
 *
 * 指纹 = 密码套件列表 + 扩展集合与顺序。`random` 和 `key_share` 字段每次连
 * 接天然不同，不属于指纹。
 */
const net = require("net");
const fs = require("fs");
const path = require("path");

const BASELINE = path.join(__dirname, "transport-baseline.json");

/** 解析一条 TLS ClientHello 记录。不用 TLS 库：字节本身就是 API。 */
function parseClientHello(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 43 || buf[0] !== 0x16) {
    throw new Error("not a TLS handshake record");
  }
  let o = 5; // 记录头：类型(1) 版本(2) 长度(2)
  if (buf[o] !== 0x01) throw new Error("not a ClientHello");
  o += 4; // 握手类型 + 3 字节长度
  const legacyVersion = buf.readUInt16BE(o);
  o += 2 + 32; // 版本 + random
  if (o >= buf.length) throw new Error("truncated ClientHello");
  o += 1 + buf[o]; // session id
  if (o + 2 > buf.length) throw new Error("truncated ClientHello");
  const csLen = buf.readUInt16BE(o);
  o += 2;
  if (csLen % 2 !== 0 || o + csLen >= buf.length) throw new Error("truncated ClientHello");
  const ciphers = [];
  for (let i = 0; i < csLen; i += 2) ciphers.push(buf.readUInt16BE(o + i).toString(16).padStart(4, "0"));
  o += csLen;
  o += 1 + buf[o]; // 压缩方法
  if (o + 2 > buf.length) throw new Error("truncated ClientHello");
  const extLen = buf.readUInt16BE(o);
  o += 2;
  if (o + extLen > buf.length) throw new Error("truncated ClientHello");
  const extensions = [];
  const end = o + extLen;
  while (o < end) {
    if (o + 4 > end) throw new Error("truncated ClientHello");
    const type = buf.readUInt16BE(o);
    const len = buf.readUInt16BE(o + 2);
    if (o + 4 + len > end) throw new Error("truncated ClientHello");
    extensions.push(type.toString(16).padStart(4, "0"));
    o += 4 + len;
  }
  return {
    legacyVersion: "0x" + legacyVersion.toString(16),
    ciphers,
    extensions,
  };
}

/** 把 fetch 指向本地监听，捕获当前运行时的 ClientHello。 */
function capture() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      sock.once("data", (buf) => {
        sock.destroy();
        srv.close();
        try {
          resolve(parseClientHello(buf));
        } catch (err) {
          reject(err);
        }
      });
    });
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      fetch(`https://127.0.0.1:${port}/`, { method: "POST" }).catch(() => {});
      setTimeout(() => {
        try {
          srv.close();
        } catch {}
        reject(new Error("no ClientHello captured within 3s"));
      }, 3000).unref();
    });
  });
}

function describe(fp) {
  const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
  return {
    runtime,
    legacyVersion: fp.legacyVersion,
    cipherCount: fp.ciphers.length,
    extensionCount: fp.extensions.length,
    ciphers: fp.ciphers,
    extensions: fp.extensions,
  };
}

async function main() {
  const fp = await capture();
  const now = describe(fp);
  const wantWrite = process.argv.includes("--write-baseline");
  const wantCheck = process.argv.includes("--check");

  if (wantWrite) {
    fs.writeFileSync(BASELINE, JSON.stringify(now, null, 2) + "\n");
    console.log(`基线已写入：${now.cipherCount} 个密码套件、${now.extensionCount} 个扩展（${now.runtime}）`);
    return 0;
  }

  if (wantCheck) {
    if (!fs.existsSync(BASELINE)) {
      console.error(`${BASELINE} 处没有基线；先以 --write-baseline 运行`);
      return 2;
    }
    const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    const sameCiphers = JSON.stringify(base.ciphers) === JSON.stringify(now.ciphers);
    const sameExts = JSON.stringify(base.extensions) === JSON.stringify(now.extensions);
    if (sameCiphers && sameExts) {
      console.log(
        `OK：${now.runtime} 与基线一致（${now.cipherCount} 个密码套件、${now.extensionCount} 个扩展）`
      );
      return 0;
    }
    console.error(`漂移：${now.runtime} 不再与基线一致（基线记录于 ${base.runtime}）`);
    if (!sameCiphers) {
      console.error(`  密码套件：基线 ${base.cipherCount} → 当前 ${now.cipherCount}`);
      console.error(`    原为：${base.ciphers.join(" ")}`);
      console.error(`    现为：${now.ciphers.join(" ")}`);
    }
    if (!sameExts) {
      console.error(`  扩展：基线 ${base.extensionCount} → 当前 ${now.extensionCount}`);
      console.error(`    原为：${base.extensions.join(" ")}`);
      console.error(`    现为：${now.extensions.join(" ")}`);
    }
    return 1;
  }

  console.log(JSON.stringify(now, null, 2));
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`错误：${err.message}`);
      process.exit(2);
    });
}

module.exports = { parseClientHello, capture, describe };
