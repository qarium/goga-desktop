import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createOperationFixture } from "./helpers/git-operation-fixtures";
import {
  createNativeGitClient,
  gitLiteralPaths,
} from "../src/host/git-native-client";
import { NodeRunner } from "../src/host/process";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

it("native client commits literal selected paths, disables hooks and preserves other staged files", async () => {
  const f = await createOperationFixture("merge-rebase", {
    commits: 1,
    conflictAt: [1],
  });
  cleanup.push(() => f.dispose());
  await f.git(["rebase", "--abort"]);
  const executable = (
    await Promise.all(
      (f.env.PATH ?? "/usr/bin:/bin")
        .split(path.delimiter)
        .map(async (folder) => {
          const name = path.join(folder, "git");
          return fs.access(name, fs.constants.X_OK).then(
            () => fs.realpath(name),
            () => undefined,
          );
        }),
    )
  ).find(Boolean)!;
  const runner = new NodeRunner(10000, f.env);
  cleanup.push(() => runner.dispose());
  const client = await createNativeGitClient({
    runner,
    executable,
    root: f.root,
    env: f.env,
  });
  const marker = path.join(f.home, "hook-ran");
  await fs.writeFile(
    path.join(f.root, ".git/hooks/pre-commit"),
    `#!/bin/sh\nprintf test > '${marker}'\nexit 1\n`,
    { mode: 0o700 },
  );
  await f.write("untouched", "staged but not selected\n");
  await f.git(["add", "--", "untouched"]);
  const names = ["-leading", "line\nbreak", ":(glob)*", "имя"];
  for (const name of names) await f.write(name, "selected\n");
  const stdin = gitLiteralPaths(names);
  expect(
    await client.run({
      policy: "local-write",
      command: "add",
      args: ["--pathspec-from-file=-", "--pathspec-file-nul"],
      stdin,
    }),
  ).toMatchObject({ exitCode: 0 });
  expect(
    await client.run({
      policy: "local-write",
      command: "commit",
      args: [
        "--only",
        "-m",
        "native selected commit",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
      ],
      stdin,
    }),
  ).toMatchObject({ exitCode: 0 });
  expect(
    (
      await f.git([
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        "HEAD",
      ])
    )
      .split("\0")
      .filter(Boolean)
      .sort(),
  ).toEqual([...names].sort());
  expect(await f.git(["diff", "--cached", "--name-only", "-z"])).toBe(
    "untouched\0",
  );
  expect(await f.git(["show", "HEAD:untouched"])).toBe("keep\n");
  expect(await f.read("untouched")).toBe("staged but not selected\n");
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("uses the selected Git for both fixture creation and native execution", async () => {
  const originalPath = process.env.PATH ?? "/usr/bin:/bin";
  let executable: string | undefined;
  for (const folder of originalPath.split(path.delimiter)) {
    const candidate = path.join(folder, "git");
    if (
      await fs.access(candidate, fs.constants.X_OK).then(
        () => true,
        () => false,
      )
    ) {
      executable = await fs.realpath(candidate);
      break;
    }
  }
  expect(
    executable,
    "Git must be installed to run compatibility tests",
  ).toBeTruthy();
  const dir = await fs.mkdtemp("/private/tmp/goga-selected-git-");
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "calls");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await fs.writeFile(
    path.join(dir, "git"),
    `#!/bin/sh\nprintf 'call\\n' >> ${quote(marker)}\nexec ${quote(executable!)} "$@"\n`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", `${dir}${path.delimiter}${originalPath}`);
  const fixture = await createOperationFixture("merge-rebase", {
    commits: 1,
    conflictAt: [1],
  });
  cleanup.push(() => fixture.dispose());
  expect(await fs.readFile(marker, "utf8").catch(() => "")).toContain("call\n");
  expect(fixture.env.PATH).toBe(process.env.PATH);
  await fs.writeFile(marker, "");
  expect(await fixture.git(["--version"])).toMatch(/^git version /);
  expect(await fs.readFile(marker, "utf8")).toBe("call\n");
});

it("journals a real native branch write from public snapshots without copying Git internals", async () => {
  const { createHash } = await import("node:crypto");
  const {
    captureNativeGitState,
    fingerprintNativeGitControls,
    readNativeGitObservation,
  } = await import("../src/host/git-native-state");
  const { NativeGitJournal } = await import("../src/host/git-native-journal");
  const f = await createOperationFixture("merge-rebase", {
    commits: 1,
    conflictAt: [1],
  });
  cleanup.push(() => f.dispose());
  await f.git(["rebase", "--abort"]);
  await f.write("untouched", "unrelated local draft\n");
  let executable: string | undefined;
  for (const dir of (f.env.PATH ?? "/usr/bin:/bin").split(path.delimiter)) {
    const candidate = path.join(dir, "git");
    if (
      await fs.access(candidate, fs.constants.X_OK).then(
        () => true,
        () => false,
      )
    ) {
      executable = await fs.realpath(candidate);
      break;
    }
  }
  const runner = new NodeRunner(10000, f.env);
  cleanup.push(() => runner.dispose());
  const client = await createNativeGitClient({
    runner,
    executable: executable!,
    root: f.root,
    env: f.env,
  });
  const capture = () =>
    captureNativeGitState({
      root: f.root,
      paths: ["untouched", "new-destination"],
      owner: async () => ({
        scope: "fixture-project",
        registryRevision: "fixture-registry",
        projectPath: f.root,
      }),
      // Fixture has isolated config, hooks disabled and no executable attributes.
      observe: async () =>
        readNativeGitObservation(client, {
          policyFingerprint: createHash("sha256")
            .update("isolated-fixture-policy")
            .digest("hex"),
          controlFingerprint: await fingerprintNativeGitControls(f.root),
        }),
    });
  const indexPath = path.join(f.root, ".git/index");
  const indexBefore = await fs.stat(indexPath, { bigint: true });
  const indexBytes = await fs.readFile(indexPath);
  const before = await capture();
  expect(await capture()).toEqual(before);
  expect(await fs.readFile(indexPath)).toEqual(indexBytes);
  expect(await fs.stat(indexPath, { bigint: true })).toMatchObject({
    ino: indexBefore.ino,
    mtimeNs: indexBefore.mtimeNs,
    ctimeNs: indexBefore.ctimeNs,
  });
  const journal = new NativeGitJournal({
    directory: path.join(f.home, "desktop-operations"),
  });
  const result = await journal.execute({
    operation: "branch",
    intentFingerprint: "b".repeat(64),
    token: journal.prepare("branch", before, "b".repeat(64)),
    capture,
    run: () =>
      client.run({
        policy: "local-write",
        command: "branch",
        args: ["--no-track", "journal-proof", "HEAD"],
      }),
    verify: async (baseline, after) => {
      expect(after.refs).not.toBe(baseline.refs);
      expect(after.head).toBe(baseline.head);
      expect(after.index).toBe(baseline.index);
      expect(after.files).toEqual(baseline.files);
      return {
        outcome: "completed",
        afterHead: after.head,
        conflicts: [],
        verifiedUnrelatedData: true,
      };
    },
  });
  expect(result).toMatchObject({
    outcome: "completed",
    recovery: "removed",
    processSettled: true,
  });
  expect(await f.read("untouched")).toBe("unrelated local draft\n");
  expect(
    (await f.git(["rev-parse", "--verify", "refs/heads/journal-proof"])).trim(),
  ).toBe(before.head);
  expect(
    (await fs.readdir(path.join(f.root, ".git"))).filter((name) =>
      name.startsWith("goga-"),
    ),
  ).toEqual([]);
});
