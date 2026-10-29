import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  captureNativeGitState,
  assertNativeGitState,
  nativeGitOwnerKey,
  fingerprintNativeGitControls,
  readNativeGitObservation,
} from "../src/host/git-native-state";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function fixture() {
  const base = await fs.mkdtemp("/private/tmp/goga-native-state-");
  cleanup.push(base);
  const root = path.join(base, "repo");
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, "a"), "draft\n");
  let registry = "registry-1",
    policy = hash("policy"),
    ownerProject = "p";
  const options = {
    root,
    paths: ["a", "ignored-target", "untracked-target"],
    owner: async () => ({
      scope: ownerProject,
      registryRevision: registry,
      projectPath: root,
    }),
    observe: async () => ({
      head: "a".repeat(40),
      index: Buffer.from("100644 blob\ta\0"),
      refs: Buffer.from("refs/heads/main\0a\n"),
      status: Buffer.from(" M a\0"),
      policyFingerprint: policy,
      controlFingerprint: hash("no operation"),
    }),
  };
  return {
    root,
    base,
    options,
    registry: () => {
      registry = "registry-2";
    },
    policy: () => {
      policy = hash("changed");
    },
    owner: () => {
      ownerProject = "another";
    },
  };
}
it("captures bounded user bytes, missing destinations and public Git evidence without writes", async () => {
  const f = await fixture();
  const before = await fs.readdir(path.join(f.root, ".git"));
  const s = await captureNativeGitState(f.options);
  expect(s.files[0]).toMatchObject({
    path: "a",
    data: Buffer.from("draft\n").toString("base64"),
    checksum: hash("draft\n"),
  });
  expect(s.files[1]).toMatchObject({ path: "ignored-target", data: null });
  expect(await captureNativeGitState(f.options)).toEqual(s);
  expect(await fs.readdir(path.join(f.root, ".git"))).toEqual(before);
});
it.each(["registry", "policy", "owner"] as const)(
  "invalidates %s drift",
  async (change) => {
    const f = await fixture(),
      before = await captureNativeGitState(f.options);
    f[change]();
    expect(() => assertNativeGitState(before, before)).not.toThrow();
    const after = await captureNativeGitState(f.options);
    expect(() => assertNativeGitState(before, after)).toThrow();
    if (change === "owner")
      expect(nativeGitOwnerKey(before)).not.toBe(nativeGitOwnerKey(after));
  },
);
it.each(["a", "ignored-target", "untracked-target"])(
  "detects content or collision at %s",
  async (name) => {
    const f = await fixture(),
      before = await captureNativeGitState(f.options);
    await fs.writeFile(path.join(f.root, name), "new content");
    const after = await captureNativeGitState(f.options);
    expect(() => assertNativeGitState(before, after)).toThrow();
  },
);
it("rejects root replacement and split physical owner", async () => {
  const f = await fixture(),
    before = await captureNativeGitState(f.options);
  await fs.rename(f.root, f.root + "-old");
  await fs.mkdir(f.root);
  await fs.mkdir(path.join(f.root, ".git"));
  await fs.writeFile(path.join(f.root, "a"), "draft\n");
  const after = await captureNativeGitState(f.options);
  expect(() => assertNativeGitState(before, after)).toThrow();
  expect(nativeGitOwnerKey(before)).not.toBe(nativeGitOwnerKey(after));
});
it.each(["symlink", "hardlink", "directory"])(
  "rejects unsafe protected %s before reading",
  async (kind) => {
    const f = await fixture();
    await fs.unlink(path.join(f.root, "a"));
    const outside = path.join(f.base, "outside");
    await fs.writeFile(outside, "private");
    if (kind === "symlink") await fs.symlink(outside, path.join(f.root, "a"));
    else if (kind === "hardlink")
      await fs.link(outside, path.join(f.root, "a"));
    else await fs.mkdir(path.join(f.root, "a"));
    await expect(captureNativeGitState(f.options)).rejects.toThrow();
    expect(await fs.readFile(outside, "utf8")).toBe("private");
  },
);
it("rejects traversal, .git paths, duplicates, oversized data and changing admission", async () => {
  const f = await fixture();
  for (const paths of [["../x"], [".git/config"], [".GiT/config"], ["a", "a"]])
    await expect(
      captureNativeGitState({ ...f.options, paths }),
    ).rejects.toThrow();
  await expect(
    captureNativeGitState({ ...f.options, maxBytes: 2 }),
  ).rejects.toThrow();
  let n = 0;
  await expect(
    captureNativeGitState({
      ...f.options,
      owner: async () => ({
        ...(await f.options.owner()),
        registryRevision: String(n++),
      }),
    }),
  ).rejects.toThrow();
});
it("does not treat unused object creation as worktree change", async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.root, ".git/objects"));
  const before = await captureNativeGitState(f.options);
  await fs.writeFile(path.join(f.root, ".git/objects/unrelated"), "unused");
  expect((await captureNativeGitState(f.options)).revision).toBe(
    before.revision,
  );
});

it("hashes operation controls opaquely without requiring Git-private formats", async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.root, ".git/rebase-merge"));
  await fs.writeFile(
    path.join(f.root, ".git/rebase-merge/message"),
    "any future format\n# Conflicts\n",
  );
  const before = await fingerprintNativeGitControls(f.root);
  await fs.writeFile(
    path.join(f.root, ".git/rebase-merge/message"),
    "another opaque format",
  );
  expect(await fingerprintNativeGitControls(f.root)).not.toBe(before);
  await fs.symlink(
    path.join(f.root, "a"),
    path.join(f.root, ".git/rebase-merge/unsafe"),
  );
  await expect(fingerprintNativeGitControls(f.root)).rejects.toThrow();
});
it("uses documented public byte output and fails on a failed Git observation", async () => {
  const calls: string[][] = [];
  const client = {
    run: async (request: { command: string; args?: readonly string[] }) => {
      calls.push([request.command, ...(request.args ?? [])]);
      return {
        stdout: Buffer.from(
          request.command === "rev-parse"
            ? "a".repeat(40) + "\n"
            : "public\0bytes",
        ),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        signal: null,
        processSettled: true as const,
      };
    },
  };
  expect(
    await readNativeGitObservation(client, {
      policyFingerprint: hash("policy"),
      controlFingerprint: hash("control"),
    }),
  ).toMatchObject({
    head: "a".repeat(40),
    index: Buffer.from("public\0bytes"),
  });
  expect(calls.map((c) => c[0])).toEqual([
    "rev-parse",
    "ls-files",
    "for-each-ref",
    "status",
  ]);
  await expect(
    readNativeGitObservation(
      {
        run: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("failed"),
          exitCode: 128,
          signal: null,
          processSettled: true,
        }),
      },
      {
        policyFingerprint: hash("policy"),
        controlFingerprint: hash("control"),
      },
    ),
  ).rejects.toThrow();
});

it("represents a missing descendant under a regular file after native D/F abort, without following links", async () => {
  const f = await fixture();
  const snapshot = await captureNativeGitState({
    ...f.options,
    paths: ["a/child"],
  });
  expect(snapshot.files).toEqual([
    { path: "a/child", data: null, checksum: null, mode: null },
  ]);
  await fs.unlink(path.join(f.root, "a"));
  await fs.symlink(f.base, path.join(f.root, "a"));
  await expect(
    captureNativeGitState({ ...f.options, paths: ["a/child"] }),
  ).rejects.toThrow();
});

it.each(["scope", "head", "control"] as const)(
  "rejects inconsistent %s observations inside one capture",
  async (kind) => {
    const f = await fixture();
    let n = 0;
    await expect(
      captureNativeGitState({
        ...f.options,
        owner:
          kind === "scope"
            ? async () => ({ ...(await f.options.owner()), scope: `p-${n++}` })
            : f.options.owner,
        observe: async () => ({
          ...(await f.options.observe()),
          ...(kind === "head" ? { head: String(++n).repeat(40) } : {}),
          ...(kind === "control"
            ? { controlFingerprint: hash(String(n++)) }
            : {}),
        }),
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe("draft\n");
  },
);

it("bounds aggregate recovery including ignored and untracked bytes, per-file data and path count", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.root, "ignored-target"), "ignored\n");
  await fs.writeFile(path.join(f.root, "untracked-target"), "untracked\n");
  const total = Buffer.byteLength("draft\nignored\nuntracked\n");
  expect(
    (await captureNativeGitState({ ...f.options, maxBytes: total })).files,
  ).toHaveLength(3);
  await expect(
    captureNativeGitState({ ...f.options, maxBytes: total - 1 }),
  ).rejects.toThrow();
  await expect(
    captureNativeGitState({
      ...f.options,
      paths: Array.from({ length: 4097 }, (_, i) => `p${i}`),
    }),
  ).rejects.toThrow();
  // A sparse fixture exercises the actual bounded per-file read, not an invented private-publisher limit.
  const big = await fs.open(path.join(f.root, "a"), "r+");
  try {
    await big.truncate(8 * 1024 * 1024 + 1);
  } finally {
    await big.close();
  }
  await expect(captureNativeGitState(f.options)).rejects.toThrow();
  expect((await fs.stat(path.join(f.root, "a"))).size).toBe(
    8 * 1024 * 1024 + 1,
  );
  expect(await fs.readFile(path.join(f.root, "ignored-target"), "utf8")).toBe(
    "ignored\n",
  );
  expect(await fs.readFile(path.join(f.root, "untracked-target"), "utf8")).toBe(
    "untracked\n",
  );
});

it.each(["regular", "symlink", "hardlink"] as const)(
  "opaque control %s replacement preserves semantic identity only for safe regular bytes",
  async (kind) => {
    const f = await fixture(),
      file = path.join(f.root, ".git/AUTO_MERGE"),
      copy = path.join(f.base, "control");
    await fs.writeFile(file, "a".repeat(40) + "\n");
    const before = await fingerprintNativeGitControls(f.root);
    await fs.rename(file, copy);
    if (kind === "regular") await fs.copyFile(copy, file);
    else if (kind === "symlink") await fs.symlink(copy, file);
    else await fs.link(copy, file);
    if (kind === "regular")
      expect(await fingerprintNativeGitControls(f.root)).toBe(before);
    else await expect(fingerprintNativeGitControls(f.root)).rejects.toThrow();
    expect(await fs.readFile(copy, "utf8")).toBe("a".repeat(40) + "\n");
  },
);

it.each(["sha1", "sha256"])(
  "captures portable staged recovery with %s and rejects corrupted or incomplete blobs",
  async (algorithm) => {
    const f = await fixture();
    const bytes = Buffer.from([255, 0, 10]),
      oid = createHash(algorithm)
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
    const recovery = {
      flags: Buffer.from("H a\0").toString("base64"),
      objects: [
        {
          oid,
          checksum: createHash("sha256").update(bytes).digest("hex"),
          data: bytes.toString("base64"),
        },
      ],
    };
    const options = {
      ...f.options,
      observe: async () => ({
        ...(await f.options.observe()),
        index: Buffer.from(`100644 ${oid} 0\ta\0`),
      }),
      indexRecovery: async () => recovery,
    };
    expect((await captureNativeGitState(options)).indexRecovery).toEqual(
      recovery,
    );
    await expect(
      captureNativeGitState({
        ...options,
        indexRecovery: async () => ({ ...recovery, objects: [] }),
      }),
    ).rejects.toThrow();
    await expect(
      captureNativeGitState({
        ...options,
        indexRecovery: async () => ({
          ...recovery,
          objects: [
            {
              ...recovery.objects[0],
              data: Buffer.from("changed").toString("base64"),
            },
          ],
        }),
      }),
    ).rejects.toThrow();
    await expect(
      captureNativeGitState({
        ...options,
        indexRecovery: async () => ({
          ...recovery,
          objects: [...recovery.objects, ...recovery.objects],
        }),
      }),
    ).rejects.toThrow();
    await expect(
      captureNativeGitState({ ...options, maxBytes: 2 }),
    ).rejects.toThrow();
  },
);
it("refuses changing staged recovery flags during capture", async () => {
  const f = await fixture();
  let calls = 0;
  await expect(
    captureNativeGitState({
      ...f.options,
      observe: async () => ({
        ...(await f.options.observe()),
        index: Buffer.alloc(0),
      }),
      indexRecovery: async () => ({
        flags: Buffer.from(++calls === 1 ? "" : "h a\0").toString("base64"),
        objects: [],
      }),
    }),
  ).rejects.toThrow();
});

it("canonicalizes owner fields before hashing without changing validated snapshot keys", async () => {
  const f = await fixture();
  const snapshot = await captureNativeGitState(f.options);
  const { scope, registryRevision, projectPath } = snapshot.owner;
  const legacyKey = hash(
    JSON.stringify([
      hash(
        JSON.stringify([
          snapshot.root,
          snapshot.physicalRoot,
          snapshot.physicalGit,
        ]),
      ),
      snapshot.owner,
    ]),
  );
  expect(nativeGitOwnerKey(snapshot)).toBe(legacyKey);
  expect(
    nativeGitOwnerKey({
      ...snapshot,
      owner: { projectPath, scope, registryRevision },
    }),
  ).toBe(legacyKey);
  expect(
    nativeGitOwnerKey({
      ...snapshot,
      owner: { scope: "other", registryRevision, projectPath },
    }),
  ).not.toBe(legacyKey);
});
