import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { domainGroups, selectDomainShard } from "../ci-test-domains.mjs";

const load = async () =>
  JSON.parse(
    await readFile(new URL("../ci-test-domains.json", import.meta.url), "utf8"),
  );
async function discover(
  root = new URL("../../tests/", import.meta.url),
  prefix = "tests/",
) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory())
      files.push(
        ...(await discover(
          new URL(`${entry.name}/`, root),
          `${prefix}${entry.name}/`,
        )),
      );
    else if (/\.test\.tsx?$/.test(entry.name)) files.push(prefix + entry.name);
  }
  return files.sort();
}
test("eight functional domains own every test once including UI, without a catch-all", async () => {
  const manifest = await load();
  assert.deepEqual(Object.keys(manifest), [
    "git-workspace",
    "git-conflicts",
    "git-safety",
    "topics",
    "terminal",
    "launches",
    "documents",
    "shell",
  ]);
  const all = await discover();
  const groups = domainGroups(all, manifest);
  assert.deepEqual(Object.values(groups).flat().sort(), all);
  for (const [domain, files] of Object.entries(groups)) {
    assert.ok(files.length > 0, domain);
    if (domain !== "git-safety")
      assert.ok(
        files.some((f) => f.endsWith(".tsx")),
        domain,
      );
  }
  assert.ok(
    groups["git-conflicts"].includes("tests/git-sequencer-ui.test.tsx"),
  );
  assert.ok(groups.topics.includes("tests/clone-context-app.test.tsx"));
});
test("new, stale, duplicate and ambiguous test ownership fail closed", () => {
  assert.throws(() => domainGroups(["a", "new"], { a: ["a"] }), /Unassigned/);
  assert.throws(() => domainGroups(["a"], { a: ["a", "old"] }), /Stale/);
  assert.throws(() => domainGroups(["a"], { a: ["a", "a"] }), /Duplicate/);
  assert.throws(() => domainGroups(["a"], { a: ["a"], b: ["a"] }), /Duplicate/);
  assert.throws(() => domainGroups(["a", "a"], { a: ["a"] }), /Duplicate/);
  assert.throws(() => domainGroups(["a"], { a: [] }), /empty/i);
});
test("subshards are deterministic, complete, nonempty and confined to their domain", () => {
  const files = ["a", "b", "c", "d", "e"];
  const manifest = { first: ["a", "b", "c"], second: ["d", "e"] };
  const weights = { a: 20, b: 10, c: 1 };
  const selected = [1, 2].map((index) =>
    selectDomainShard(files, manifest, "first", index, 2, weights),
  );
  assert.deepEqual(selected.flat().sort(), ["a", "b", "c"]);
  assert.deepEqual(
    selectDomainShard([...files].reverse(), manifest, "first", 1, 2, weights),
    selected[0],
  );
  for (const [domain, index, count] of [
    ["missing", 1, 1],
    ["first", 0, 2],
    ["first", 3, 2],
    ["first", 1, 0],
    ["second", 1, 3],
  ])
    assert.throws(() =>
      selectDomainShard(files, manifest, domain, index, count, weights),
    );
});

test("real configured Vitest sequencer partitions discovered specs across the ARM matrix", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const p = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
  import {createVitest} from 'vitest/node';
  import {readFileSync} from 'node:fs';
  import {parse} from 'yaml';
  const jobs=parse(readFileSync('.github/workflows/ci.yml','utf8')).jobs;
  const rows=Object.values(jobs).flatMap(job=>job.strategy?.matrix?.include??[]).filter(row=>row.domain);
  const groups=[];let all;
  for(const row of rows){
   process.env.GOGA_CI_DOMAIN=row.domain;
   const ctx=await createVitest({watch:false,shard:row.shard+'/'+row.count});
   try{
    const specs=await ctx.globTestSpecifications();all=specs.map(s=>s.moduleId);
    const sequencer=new ctx.config.sequence.sequencer(ctx);
    const selected=await sequencer.shard(specs);
    const sorted=await sequencer.sort(selected);
    const weights=JSON.parse(readFileSync('scripts/ci-test-weights-arm64.json','utf8'));
    for(let i=1;i<sorted.length;i++){
     const key=s=>s.moduleId.slice(ctx.config.root.length+1);
     if((weights[key(sorted[i-1])]??1)<(weights[key(sorted[i])]??1))throw Error('Domain files must run longest-first');
    }
    groups.push(sorted.map(s=>s.moduleId));
   }finally{await ctx.close();}
  }
  console.log(JSON.stringify({all,groups}));
 `,
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(p.status, 0, p.stderr);
  const { all, groups } = JSON.parse(p.stdout);
  assert.ok(groups.every((g) => g.length > 0));
  assert.deepEqual(groups.flat().sort(), all.sort());
  assert.equal(new Set(groups.flat()).size, all.length);
});

test("native merge/rebase lifecycle contracts use the conflict integration domain", async () => {
  const manifest = await load();
  const owners = Object.entries(manifest)
    .filter(([, files]) => files.includes("tests/git-native-contract.test.ts"))
    .map(([domain]) => domain);
  assert.deepEqual(owners, ["git-conflicts"]);
});
