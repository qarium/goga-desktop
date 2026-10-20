import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(
  new URL("../scripts/release-version.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "goga-release-version-"));
  temporaryDirectories.push(cwd);
  const manifest = {
    name: "fixture-app",
    version: "0.1.51",
    private: true,
    scripts: { version: "node -e \"throw Error('must never execute')\"" },
    dependencies: { example: "^1.2.3" },
    build: { mac: { identity: null } },
  };
  const lock = {
    name: "fixture-app",
    version: "0.1.51",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "fixture-app",
        version: "0.1.51",
        dependencies: { example: "^1.2.3" },
      },
      "node_modules/example": {
        version: "1.2.3",
        resolved: "https://example.invalid/example.tgz",
        integrity: "fixture-integrity",
      },
    },
  };
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify(manifest, null, 4) + "\n",
  );
  await writeFile(
    join(cwd, "package-lock.json"),
    JSON.stringify(lock, null, 2) + "\n",
  );
  return { cwd, manifest, lock };
}

function run(cwd: string, tag: string | undefined, args: string[] = []) {
  const env = { ...process.env };
  delete env.RELEASE_TAG;
  if (tag !== undefined) env.RELEASE_TAG = tag;
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

async function contents(cwd: string) {
  return Promise.all(
    ["package.json", "package-lock.json"].map((name) =>
      readFile(join(cwd, name), "utf8"),
    ),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((cwd) => rm(cwd, { recursive: true, force: true })),
  );
});

const validTags = [
  ["v0.0.0", "0.0.0"],
  ["v1.2.3", "1.2.3"],
  ["v123.456.789", "123.456.789"],
  ["v1.2.3-alpha.0", "1.2.3-alpha.0"],
  ["v1.2.3-beta.12", "1.2.3-beta.12"],
  ["v1.2.3-rc.1", "1.2.3-rc.1"],
];
const invalidTags = [
  undefined,
  null,
  123,
  {},
  [],
  true,
  "",
  "1.2.3",
  "v1.2",
  "v1.2.3.4",
  "V1.2.3",
  "refs/tags/v1.2.3",
  "main",
  "release/v1.2.3",
  "v01.2.3",
  "v1.02.3",
  "v1.2.03",
  "v1.2.3-alpha.01",
  "v1.2.3-beta.00",
  "v1.2.3-rc.01",
  "v-1.2.3",
  "v1.2.3-rc.-1",
  "v1.2.3-alpha",
  "v1.2.3-preview.1",
  "v1.2.3-RC.1",
  "v1.2.3-alpha.1.2",
  "v1.2.3+metadata",
  "v1.2.3-rc.1+metadata",
  " v1.2.3",
  "v1.2.3 ",
  "v1.2.3\n",
  "v1.2.3\r",
  "v1.2.3\r\n",
  "v1.2.3\u2028",
  "v1.2.3\u2029",
  "\nv1.2.3",
  "v1.2.3\t",
  "v1.2.3;echo injected",
  "$(echo v1.2.3)",
  "`echo v1.2.3`",
  "v1.2.3|cat",
  "v1.2.3&true",
  "v1.2.3>file",
  "v１.2.3",
  "v1.2.3\0",
];

describe("versionFromTag", () => {
  it.each(validTags)(
    "derives %s without changing numeric spelling",
    async (tag, version) => {
      const { versionFromTag } = await import("../scripts/release-version.mjs");
      expect(versionFromTag(tag)).toBe(version);
    },
  );

  it.each(invalidTags)("rejects invalid tag %j", async (tag) => {
    const { versionFromTag } = await import("../scripts/release-version.mjs");
    expect(() => versionFromTag(tag)).toThrow(/RELEASE_TAG/);
  });
});

describe("release version CLI", () => {
  it.each(validTags)(
    "updates all three version fields for %s and preserves other data",
    async (tag, version) => {
      const { cwd, manifest, lock } = await fixture();
      const result = run(cwd, tag);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(version);
      const [packageText, lockText] = await contents(cwd);
      expect(JSON.parse(packageText)).toEqual({ ...manifest, version });
      expect(JSON.parse(lockText)).toEqual({
        ...lock,
        version,
        packages: { ...lock.packages, "": { ...lock.packages[""], version } },
      });
    },
  );

  it.each(
    invalidTags.filter(
      (tag): tag is string | undefined =>
        tag === undefined || (typeof tag === "string" && !tag.includes("\0")),
    ),
  )(
    "invalid RELEASE_TAG %j leaves package files byte-identical",
    async (tag) => {
      const { cwd } = await fixture();
      const before = await contents(cwd);
      const result = run(cwd, tag);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("RELEASE_TAG");
      expect(await contents(cwd)).toEqual(before);
    },
  );

  it("--check validates without reading or writing package files", async () => {
    const { cwd } = await fixture();
    const before = await contents(cwd);
    expect(run(cwd, "v2.3.4-rc.0", ["--check"])).toMatchObject({
      status: 0,
      stdout: "2.3.4-rc.0\n",
    });
    expect(await contents(cwd)).toEqual(before);
    await rm(join(cwd, "package.json"));
    await rm(join(cwd, "package-lock.json"));
    expect(run(cwd, "v2.3.4", ["--check"])).toMatchObject({
      status: 0,
      stdout: "2.3.4\n",
    });
    expect(run(cwd, "v2.3.4\n", ["--check"]).status).not.toBe(0);
  });

  it("rejects unknown arguments before writing", async () => {
    const { cwd } = await fixture();
    const before = await contents(cwd);
    expect(run(cwd, "v2.3.4", ["--force"]).status).not.toBe(0);
    expect(await contents(cwd)).toEqual(before);
  });

  it.each([
    ["package.json", "{"],
    ["package.json", "null"],
    ["package.json", "[]"],
    ["package.json", '{"version":42}'],
    ["package-lock.json", "{"],
    ["package-lock.json", "null"],
    ["package-lock.json", '{"version":"0.1.51"}'],
    ["package-lock.json", '{"version":"0.1.51","packages":[]}'],
    ["package-lock.json", '{"version":"0.1.51","packages":{"":null}}'],
    ["package-lock.json", '{"version":"0.1.51","packages":{"":{}}}'],
  ])("invalid %s document %s prevents all writes", async (name, text) => {
    const { cwd } = await fixture();
    await writeFile(join(cwd, name), text);
    const before = await contents(cwd);
    const result = run(cwd, "v2.3.4");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(await contents(cwd)).toEqual(before);
  });

  it("a missing lockfile does not change package.json", async () => {
    const { cwd } = await fixture();
    const before = await readFile(join(cwd, "package.json"), "utf8");
    await rm(join(cwd, "package-lock.json"));
    expect(run(cwd, "v2.3.4").status).not.toBe(0);
    expect(await readFile(join(cwd, "package.json"), "utf8")).toBe(before);
  });

  it("refuses symlinks to avoid changing files outside cwd", async () => {
    const local = await fixture();
    const external = await fixture();
    const externalBefore = await contents(external.cwd);
    const localManifestBefore = await readFile(
      join(local.cwd, "package.json"),
      "utf8",
    );
    await rm(join(local.cwd, "package-lock.json"));
    await symlink(
      join(external.cwd, "package-lock.json"),
      join(local.cwd, "package-lock.json"),
    );
    expect(run(local.cwd, "v2.3.4").status).not.toBe(0);
    expect(await contents(external.cwd)).toEqual(externalBefore);
    expect(await readFile(join(local.cwd, "package.json"), "utf8")).toBe(
      localManifestBefore,
    );
  });
});
