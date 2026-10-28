import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createNativeGitClient } from "../src/host/git-native-client";
import {
  NodeRunner,
  ByteCommandError,
  type ByteCommandResult,
} from "../src/host/process";
import { createOperationFixture } from "./helpers/git-operation-fixtures";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function files(root: string) {
  const result: [string, string][] = [];
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else
        result.push([
          path.relative(root, full),
          createHash("sha256")
            .update(await fs.readFile(full))
            .digest("hex"),
        ]);
    }
  };
  await walk(root);
  return result.sort(([a], [b]) => a.localeCompare(b));
}
async function fixture(
  fault: "throw-switch" | "version" | "format" | "init" | undefined = undefined,
) {
  const f = await createOperationFixture("merge-rebase", {
    commits: 1,
    conflictAt: [1],
  });
  cleanup.push(f.dispose);
  const runner = new NodeRunner(10000, f.env);
  cleanup.push(() => runner.dispose());
  const calls: { cwd: string; args: readonly string[] }[] = [];
  const executable = (
    await runner.command("/usr/bin/which", ["git"], f.root, f.env)
  ).stdout.trim();
  const client = await createNativeGitClient({
    root: f.root,
    executable,
    env: f.env,
    configuration: [
      ["user.name", "Fixture"],
      ["user.email", "fixture@example.invalid"],
    ],
    runner: {
      commandBytes: async (request) => {
        calls.push({ cwd: request.cwd, args: request.args });
        if (
          fault === "throw-switch" &&
          request.cwd !== f.root &&
          request.args.includes("switch")
        )
          throw new ByteCommandError(
            "process-unsettled",
            false,
            Buffer.alloc(0),
            Buffer.alloc(0),
            null,
            null,
          );
        if (
          (fault === "version" &&
            request.cwd !== f.root &&
            request.args.includes("--version")) ||
          (fault === "format" &&
            request.args.includes("--show-object-format")) ||
          (fault === "init" && request.args.includes("init"))
        )
          return {
            stdout: Buffer.from(
              fault === "version"
                ? "git version 2.45.2\n"
                : fault === "format"
                  ? "sha1\n"
                  : "",
            ),
            stderr: Buffer.alloc(0),
            exitCode: 0,
            signal: null,
            processSettled: false,
          } as unknown as ByteCommandResult;
        return runner.commandBytes(request);
      },
    },
  });
  return { ...f, client, calls };
}
it("isolated calculation cannot write source objects, index, refs, controls or worktree and removes its own files", async () => {
  const f = await fixture();
  const before = await files(f.root);
  let temporary = "";
  await f.client.inTemporaryRepository(async (client, root) => {
    temporary = root;
    expect(root).not.toBe(f.root);
    expect(
      (
        await client.run({
          policy: "local-write",
          command: "switch",
          args: ["--detach", f.onto],
        })
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await client.run({
          policy: "local-write",
          command: "cherry-pick",
          args: ["--no-commit", f.sources[0]],
        })
      ).exitCode,
    ).toBe(1);
    expect(
      (
        await client.run({
          policy: "local-read",
          command: "ls-files",
          args: ["--unmerged"],
        })
      ).stdout.length,
    ).toBeGreaterThan(0);
  });
  expect(await files(f.root)).toEqual(before);
  await expect(fs.stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
});
it("failed witness callback removes only its settled temporary repository", async () => {
  const f = await fixture(),
    before = await files(f.root);
  let temporary = "";
  await expect(
    f.client.inTemporaryRepository(async (_client, root) => {
      temporary = root;
      throw Error("fixture failure");
    }),
  ).rejects.toThrow("fixture failure");
  await expect(fs.stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await files(f.root)).toEqual(before);
});
it("unsettled witness is not removed while a child may still own its directory", async () => {
  const f = await fixture("throw-switch"),
    before = await files(f.root);
  let temporary = "";
  await expect(
    f.client.inTemporaryRepository(async (client, root) => {
      temporary = root;
      await client.run({
        policy: "local-write",
        command: "switch",
        args: ["--detach", f.onto],
      });
    }),
  ).rejects.toBeInstanceOf(ByteCommandError);
  // Fake runner starts no child. The test owns and may remove this retained fixture.
  cleanup.push(() => fs.rm(temporary, { recursive: true, force: true }));
  expect((await fs.stat(temporary)).isDirectory()).toBe(true);
  expect(await files(f.root)).toEqual(before);
});

it.each(["version", "format", "init"] as const)(
  "unsettled %s result cannot certify an isolated witness",
  async (fault) => {
    const f = await fixture(fault),
      before = await files(f.root);
    let called = false;
    await expect(
      f.client.inTemporaryRepository(async () => {
        called = true;
      }),
    ).rejects.toMatchObject({
      processSettled: false,
    });
    expect(called).toBe(false);
    expect(await files(f.root)).toEqual(before);
    const temporary = f.calls.find((call) => call.cwd !== f.root)!.cwd;
    if (fault === "format") {
      // The unsettled source read never owned the settled scratch directory.
      await expect(fs.stat(temporary)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } else {
      cleanup.push(() => fs.rm(temporary, { recursive: true, force: true }));
      expect((await fs.stat(temporary)).isDirectory()).toBe(true);
    }
  },
);
