"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseClientHello, capture } = require("../transport-fingerprint.js");

test("parseClientHello reads ciphers and extension order from raw bytes", async () => {
  // 使用运行时自己的 ClientHello：这会让解析器对照真实记录断言，
  // 而不是手工构造的样本，这是真正验证偏移量的唯一方式。
  const fp = await capture();
  assert.ok(fp.ciphers.length > 0, "expected at least one cipher");
  assert.ok(fp.extensions.length > 0, "expected at least one extension");
  for (const c of fp.ciphers) assert.match(c, /^[0-9a-f]{4}$/);
  for (const e of fp.extensions) assert.match(e, /^[0-9a-f]{4}$/);
  assert.equal(fp.legacyVersion, "0x303", "TLS 1.2 legacy version in ClientHello");
});

test("parseClientHello rejects non-TLS and truncated input", () => {
  assert.throws(() => parseClientHello(Buffer.from("GET / HTTP/1.1\r\n\r\n")), /not a TLS handshake/);
  assert.throws(() => parseClientHello(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05])), /not a TLS handshake/);
  const truncated = Buffer.alloc(44);
  truncated[0] = 0x16;
  truncated[5] = 0x01;
  truncated[43] = 32; // session-id length beyond buffer end
  assert.throws(() => parseClientHello(truncated), /truncated ClientHello/);
});

test("the supported runtime's fingerprint matches the recorded baseline", async () => {
  // Bun 是受支持的运行时；Node 会被线上网关拒绝。在 Node 下
  // 本测试记录差异而不是失败，因为 CI 在两者上都跑套件以捕获 API 变更。
  const fs = require("fs");
  const path = require("path");
  const baselinePath = path.join(__dirname, "..", "transport-baseline.json");
  if (!fs.existsSync(baselinePath)) return;
  const base = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const fp = await capture();
  if (process.versions.bun) {
    assert.deepEqual(fp.ciphers, base.ciphers, "Bun's cipher list drifted from the baseline");
    assert.deepEqual(fp.extensions, base.extensions, "Bun's extension order drifted from the baseline");
  } else {
    assert.notDeepEqual(
      fp.ciphers,
      base.ciphers,
      "Node is expected to differ from the Bun baseline; if this passes, re-measure the gate"
    );
  }
});
