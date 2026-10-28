import { test } from "node:test";
import assert from "node:assert/strict";
import { balanceTestFiles } from "../ci-test-shards.mjs";

test("weighted shards retain unknown files once and are independent of discovery order", () => {
  const files = ["a", "b", "c", "d", "new", "extra"];
  const weights = { a: 30, b: 20, c: 10, d: 10 };
  const groups = balanceTestFiles(files, 4, weights);
  assert.deepEqual(groups, balanceTestFiles([...files].reverse(), 4, weights));
  assert.deepEqual(groups.flat().sort(), [...files].sort());
  assert.ok(groups.every((group) => group.length > 0));
  assert.equal(groups.find((group) => group.includes("a")).length, 1);
  assert.equal(new Set(groups.flat()).size, files.length);
});
test("bad scheduling input fails rather than silently omitting tests", () => {
  assert.throws(() => balanceTestFiles(["a", "a"], 4, {}));
  assert.throws(() => balanceTestFiles(["a"], 0, {}));
  assert.throws(() => balanceTestFiles(["a"], 4, { a: -1 }));
  assert.throws(() => balanceTestFiles(["a"], 4, { a: NaN }));
});

test("pinned scheduling weights are finite estimates, not a test allowlist", async () => {
  const { readFile } = await import("node:fs/promises");
  const weights = JSON.parse(
    await readFile(new URL("../ci-test-weights.json", import.meta.url), "utf8"),
  );
  for (const [file, weight] of Object.entries(weights)) {
    assert.match(file, /^tests\/.+\.test\.tsx?$/);
    assert.ok(Number.isInteger(weight) && weight > 0);
  }
  const files = [...Object.keys(weights), "tests/new-unweighted.test.ts"];
  assert.deepEqual(
    balanceTestFiles(files, 4, weights).flat().sort(),
    files.sort(),
  );
});
