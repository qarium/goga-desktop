import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, output } from "../locales.mjs";
test("bundled locale packs match the checked-in registry and their message/parameter contracts", async () => {
  assert.equal(await readFile(output, "utf8"), generate());
});
test("a third complete pack is discovered automatically; missing or altered text parameters fail the build", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "goga-locale-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [tag, name] of [
    ["en", "English"],
    ["de", "Deutsch"],
  ]) {
    await mkdir(join(root, tag));
    await writeFile(
      join(root, tag, "manifest.json"),
      JSON.stringify({ tag, name }),
    );
    await writeFile(
      join(root, tag, "settings.json"),
      JSON.stringify({ title: "{name}" }),
    );
  }
  assert.match(generate(root), /Deutsch/);
  for (const invalid of [{}, { title: "" }, { title: "{different}" }]) {
    await writeFile(join(root, "de/settings.json"), JSON.stringify(invalid));
    assert.throws(() => generate(root));
  }
});
