import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { parser } from "@lezer/yaml";
import { patchYamlParser } from "../patch-yaml-parser.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const patch = path.join(root, "patches/lezer-yaml-1.0.4.patch");
function fixture(fn) {
  const target = mkdtempSync(path.join(tmpdir(), "goga-yaml-patch-"));
  try {
    const pkg = path.join(target, "node_modules/@lezer/yaml");
    mkdirSync(path.join(pkg, "dist"), { recursive: true });
    for (const file of ["package.json", "dist/index.js", "dist/index.cjs"])
      copyFileSync(
        path.join(root, "node_modules/@lezer/yaml", file),
        path.join(pkg, file),
      );
    patchYamlParser(target);
    execFileSync("/usr/bin/patch", ["--batch", "-R", "-p1", "-i", patch], {
      cwd: path.join(target, "node_modules"),
      stdio: "pipe",
    });
    fn(target, pkg);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}
test("applies exactly the reviewed ESM/CJS correction and is idempotent", () =>
  fixture((target, pkg) => {
    assert.equal(patchYamlParser(target), "applied");
    const once = ["js", "cjs"].map((ext) =>
      readFileSync(path.join(pkg, "dist/index." + ext), "utf8"),
    );
    assert.equal(patchYamlParser(target), "already-applied");
    assert.deepEqual(
      ["js", "cjs"].map((ext) =>
        readFileSync(path.join(pkg, "dist/index." + ext), "utf8"),
      ),
      once,
    );
  }));
test("refuses a different dependency version without writing source", () =>
  fixture((target, pkg) => {
    const manifest = path.join(pkg, "package.json");
    const value = JSON.parse(readFileSync(manifest, "utf8"));
    value.version = "1.0.5";
    writeFileSync(manifest, JSON.stringify(value));
    const before = readFileSync(path.join(pkg, "dist/index.js"), "utf8");
    assert.throws(() => patchYamlParser(target), /requires the reviewed/);
    assert.equal(readFileSync(path.join(pkg, "dist/index.js"), "utf8"), before);
  }));
test("refuses tampered or partly patched sources rather than silently accepting them", () =>
  fixture((target, pkg) => {
    patchYamlParser(target);
    const cjs = path.join(pkg, "dist/index.cjs");
    writeFileSync(cjs, readFileSync(cjs, "utf8") + "\n// unexpected");
    const before = readFileSync(path.join(pkg, "dist/index.js"), "utf8");
    assert.throws(() => patchYamlParser(target), /requires the reviewed/);
    assert.equal(readFileSync(path.join(pkg, "dist/index.js"), "utf8"), before);
  }));
test("ESM and CJS parse valid indicator keys and sequence/explicit-key markers identically", () => {
  const cjs = createRequire(import.meta.url)("@lezer/yaml").parser;
  for (const text of [
    '->Type: {}\n?flag: true\n"Foo(x: str)": {}\n',
    "items:\n  - key: value\n  - item\n? explicit\n: value\n",
    "-foo: { ?bar: 1 }\n",
  ]) {
    const tree = parser.parse(text);
    const errors = [];
    tree.iterate({
      enter: (n) => {
        if (n.type.isError) errors.push(n.from);
      },
    });
    assert.deepEqual(errors, []);
    assert.equal(cjs.parse(text).toString(), tree.toString());
  }
});

test("clean dependency installs require the reviewed parser patch", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(
    readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  assert.equal(pkg.scripts.postinstall, "node scripts/patch-yaml-parser.mjs");
  assert.equal(lock.packages[""].hasInstallScript, true);
  assert.equal(lock.packages["node_modules/@lezer/yaml"].version, "1.0.4");
});
