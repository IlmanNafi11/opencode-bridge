const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-model-groups-"));
let groups;

describe("模型组候选与冷却", () => {
  before(() => {
    process.env.FUCKING_OPENCODE_STATE_DIR = tmpDir;
    delete process.env.FUCKING_OPENCODE_MODEL_GROUPS;
    groups = require("../model-groups");
  });

  beforeEach(() => {
    delete process.env.FUCKING_OPENCODE_MODEL_GROUPS;
    groups.__reload();
    for (const 文件 of fs.readdirSync(tmpDir)) {
      fs.rmSync(path.join(tmpDir, 文件), { recursive: true, force: true });
    }
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.FUCKING_OPENCODE_STATE_DIR;
    delete process.env.FUCKING_OPENCODE_MODEL_GROUPS;
  });

  it("非别名模型只有自身一个候选", () => {
    assert.deepEqual(groups.候选("plain-free"), ["plain-free"]);
  });

  it("按配置顺序返回组内候选并去重", () => {
    process.env.FUCKING_OPENCODE_MODEL_GROUPS = JSON.stringify({
      sota: ["a-free", "b-free", "a-free"],
    });
    assert.deepEqual(groups.候选("sota"), ["a-free", "b-free"]);
    assert.deepEqual(groups.组成员("sota"), ["a-free", "b-free"]);
  });

  it("429 冷却把模型排到后面并持久化", () => {
    process.env.FUCKING_OPENCODE_MODEL_GROUPS = JSON.stringify({
      sota: ["a-free", "b-free", "c-free"],
    });
    groups.记录失败("a-free", 429);
    assert.deepEqual(groups.候选("sota"), ["b-free", "c-free"]);
    assert.equal(groups.诊断()[0].model, "a-free");
    groups.__reload();
    assert.deepEqual(groups.候选("sota"), ["b-free", "c-free"]);
    const stat = fs.statSync(path.join(tmpDir, "model-health.json"));
    if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
  });

  it("全部冷却时仍返回完整顺序，不错杀请求", () => {
    process.env.FUCKING_OPENCODE_MODEL_GROUPS = JSON.stringify({
      sota: ["a-free", "b-free"],
    });
    groups.记录失败("a-free", 404);
    groups.记录失败("b-free", 404);
    assert.deepEqual(groups.候选("sota"), ["a-free", "b-free"]);
  });

  it("成功后清除冷却", () => {
    process.env.FUCKING_OPENCODE_MODEL_GROUPS = JSON.stringify({
      sota: ["a-free", "b-free"],
    });
    groups.记录失败("a-free", 503);
    assert.deepEqual(groups.候选("sota"), ["b-free"]);
    groups.记录成功("a-free");
    assert.deepEqual(groups.候选("sota"), ["a-free", "b-free"]);
  });
});
