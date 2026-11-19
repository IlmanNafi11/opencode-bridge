const { test } = require("node:test");
const assert = require("node:assert/strict");
const { onlineAssertion } = require("../gate-drill");

test("429 from upstream leaves online drill assertions inconclusive", () => {
  assert.equal(onlineAssertion({ status: 429 }, false), null);
});

test("non-429 upstream responses keep online drill assertions decisive", () => {
  assert.equal(onlineAssertion({ status: 403 }, false), false);
  assert.equal(onlineAssertion({ status: 200 }, true), true);
});
