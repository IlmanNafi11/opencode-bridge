// Builds a redacted diagnostics ZIP with no external tools: ZIP "store"
// entries plus a central directory, built by hand so the gateway keeps its
// zero-dependency rule. Secrets never enter the archive.

function crc32(bytes) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

function 去敏文本(text) {
  return String(text || "")
    .replace(/\b(sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9._-]{8,}/g, "[redacted-token]")
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//[redacted]@")
    .replace(/(authorization["':\s]+bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|password|secret|token)["':\s=]+)[^\s,"'}]{4,}/gi, "$1[redacted]");
}

function 去敏(value, depth = 0) {
  if (depth > 6) return "[depth-limit]";
  if (typeof value === "string") return 去敏文本(value);
  if (Array.isArray(value)) return value.map((item) => 去敏(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/password|secret|authorization|credential|proxy.?credential/i.test(key)) {
        out[key] = item ? "[redacted]" : item;
        continue;
      }
      out[key] = 去敏(item, depth + 1);
    }
    return out;
  }
  return value;
}

function 建Zip(文件列表) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const { time, day } = dosTime(now);
  for (const file of 文件列表) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(day, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(文件列表.length, 8);
  end.writeUInt16LE(文件列表.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuffer, end]);
}

function 时间戳(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** ctx.收集() → { health, config, pool, farm, modelHealth, observability, incidents, events, shapes, summary } */
function 构建(ctx) {
  const 数据 = ctx.收集() || {};
  const files = [];
  const add = (name, value) => {
    const body = typeof value === "string" ? value : JSON.stringify(去敏(value), null, 2);
    files.push({ name, data: 去敏文本(body) });
  };
  add("health.json", 数据.health || {});
  add("config.json", 数据.config || {});
  if (数据.pool) add("pool.json", 数据.pool);
  if (数据.farm) add("farm.json", 数据.farm);
  if (数据.modelHealth) add("model-health.json", 数据.modelHealth);
  if (数据.observability) add("observability.json", 数据.observability);
  if (数据.incidents) add("incidents.json", 数据.incidents);
  if (数据.events) add("events.json", 数据.events);
  if (数据.shapes) add("payload-shapes.json", 数据.shapes);
  add("README.txt", [
    "fucking-opencode diagnostic bundle",
    `created: ${new Date().toISOString()}`,
    "contains: health, effective config without credentials, pool/farm/model state,",
    "request traces without prompts, incidents, recent events, payload shapes.",
    "never contains: API keys, panel password, proxy credentials, message text.",
    "",
    数据.summary || "",
  ].join("\n"));
  return {
    filename: `fucking-opencode-diag-${时间戳()}.zip`,
    bytes: 建Zip(files),
    files: files.map((file) => file.name),
  };
}

module.exports = { 构建, 建Zip, 去敏, 去敏文本, crc32 };
