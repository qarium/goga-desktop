// A narrow, version-locked upstream grammar correction. Uses the platform's
// standard patch tool; never parses or rewrites project/user YAML.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const project = fileURLToPath(new URL("../", import.meta.url));
const patchFile = path.join(project, "patches/lezer-yaml-1.0.4.patch");
const hashes = {
  js: {
    original:
      "761bb6fa2f88915f916b33429b8d0f06639efe288b695c8abc6f32c0d116c9c5",
    patched: "4518b40b43a808abc963f333ef427686708037546dcc431f87b30a02271f9571",
  },
  cjs: {
    original:
      "7cd304145c9dcebe623d739c9291ccefc3012f7ac91c18003dec8489623615b2",
    patched: "10d85dda725958bdf259e305120f5601cbef054d696eb41b9b6994d1d7da85f1",
  },
};
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
export function patchYamlParser(root = project) {
  const modules = path.join(root, "node_modules");
  const dependency = path.join(modules, "@lezer/yaml");
  const manifest = JSON.parse(
    readFileSync(path.join(dependency, "package.json"), "utf8"),
  );
  const fail = () => {
    throw Error(
      "YAML parser patch requires the reviewed @lezer/yaml 1.0.4 source. Reinstall dependencies or review/remove the patch when upgrading; refusing an unverified grammar.",
    );
  };
  if (
    manifest.name !== "@lezer/yaml" ||
    manifest.version !== "1.0.4" ||
    hash(patchFile) !==
      "cb8db793e33e70258e0b9cea7e849a53caf4424d92b19f804458e65a37143734"
  )
    fail();
  const files = Object.entries(hashes).map(([ext, expected]) => ({
    file: path.join(dependency, "dist/index." + ext),
    expected,
  }));
  if (files.every(({ file, expected }) => hash(file) === expected.patched))
    return "already-applied";
  if (!files.every(({ file, expected }) => hash(file) === expected.original))
    fail();
  const args = ["--batch", "--forward", "-p1", "-i", patchFile];
  execFileSync("/usr/bin/patch", ["--dry-run", ...args], {
    cwd: modules,
    stdio: "pipe",
  });
  execFileSync("/usr/bin/patch", args, { cwd: modules, stdio: "pipe" });
  if (!files.every(({ file, expected }) => hash(file) === expected.patched))
    fail();
  return "applied";
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log("YAML parser: " + patchYamlParser());
}
