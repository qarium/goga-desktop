import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { RepositorySeeds } from "./helpers/repository-seeds";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function root() {
  const dir = await fs.mkdtemp("/private/tmp/goga-fixture-seed-");
  roots.push(dir);
  return dir;
}
it("prepares once but copies working files, index, refs and metadata independently", async () => {
  const seeds = new RepositorySeeds<{ sources: string[] }>();
  let builds = 0;
  const a = await root(),
    b = await root(),
    c = await root();
  const prepare = async (dir: string) => {
    builds++;
    await fs.mkdir(path.join(dir, ".git", "refs"), { recursive: true });
    for (const f of ["file", ".git/index", ".git/refs/main"])
      await fs.writeFile(path.join(dir, f), "base");
    return { sources: ["original"] };
  };
  const [one, two] = await Promise.all([
    seeds.materialize("same", a, () => prepare(a)),
    seeds.materialize("same", b, () => prepare(b)),
  ]);
  expect(builds).toBe(1);
  one.sources.push("changed");
  expect(two.sources).toEqual(["original"]);
  for (const f of ["file", ".git/index", ".git/refs/main"]) {
    expect((await fs.stat(path.join(a, f))).ino).not.toBe(
      (await fs.stat(path.join(b, f))).ino,
    );
    await fs.writeFile(path.join(a, f), "mutated");
    expect(await fs.readFile(path.join(b, f), "utf8")).toBe("base");
  }
  await fs.rm(a, { recursive: true, force: true });
  await seeds.materialize("same", c, () => prepare(c));
  expect(builds).toBe(1);
  expect(await fs.readFile(path.join(c, ".git/index"), "utf8")).toBe("base");
});
it("does not cache failed preparation or cross keys and refuses nonempty destinations", async () => {
  const seeds = new RepositorySeeds<number>();
  let builds = 0;
  await expect(
    seeds.materialize("failed", await root(), async () => {
      throw Error("failed");
    }),
  ).rejects.toThrow("failed");
  await seeds.materialize("failed", await root(), async () => {
    builds++;
    return 1;
  });
  await seeds.materialize("another", await root(), async () => {
    builds++;
    return 2;
  });
  expect(builds).toBe(2);
  const occupied = await root();
  await fs.writeFile(path.join(occupied, "owned"), "preserve");
  await expect(
    seeds.materialize("failed", occupied, async () => 3),
  ).rejects.toThrow(/empty/);
  expect(await fs.readFile(path.join(occupied, "owned"), "utf8")).toBe(
    "preserve",
  );
});
it("preserves executable bits and rejects symlink inputs instead of sharing external state", async () => {
  const seeds = new RepositorySeeds<number>();
  const a = await root(),
    b = await root();
  await seeds.materialize("mode", a, async () => {
    await fs.writeFile(path.join(a, "exe"), "fixture", { mode: 0o755 });
    return 1;
  });
  await seeds.materialize("mode", b, async () => 2);
  expect((await fs.stat(path.join(b, "exe"))).mode & 0o777).toBe(0o755);
  const unsafe = await root();
  await expect(
    seeds.materialize("unsafe", unsafe, async () => {
      await fs.symlink(a, path.join(unsafe, "link"));
      return 1;
    }),
  ).rejects.toThrow(/regular|symlink/);
});
