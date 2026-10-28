import { expect, it } from "vitest";
import {
  validatePublicRebasePlan,
  verifyNativeAutoMerge,
} from "../src/host/git-native-result-verifier";
import type { createNativeGitClient } from "../src/host/git-native-client";
import type { NativeGitState } from "../src/host/git-native-state";
import { ByteCommandError, type ByteCommandResult } from "../src/host/process";
const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40);
it("admits only ordered remaining picks from the fixed native start", () => {
  expect(() =>
    validatePublicRebasePlan(
      `pick ${b.slice(0, 7)} title\np ${c} anything\n# exec is a comment\n`,
      [a, b, c],
      a,
    ),
  ).not.toThrow();
  expect(() =>
    validatePublicRebasePlan("noop\n# no remaining commits", [a], a),
  ).not.toThrow();
});
it.each([
  "exec touch marker",
  "x false",
  `reword ${b}`,
  `pick ${a}`,
  `pick ${"d".repeat(40)}`,
  `pick ${c}\npick ${b}`,
  `pick ${b}\npick ${b}`,
  "noop\nexec false",
  `pick ${b}\nnoop`,
])("rejects public plan command %s", (plan) => {
  expect(() => validatePublicRebasePlan(plan, [a, b, c], a)).toThrow();
});

type Client = Awaited<ReturnType<typeof createNativeGitClient>>;
function witness(index = `100644 ${a} 0\tuntouched\0`) {
  const calls: string[] = [];
  const outputs: ByteCommandResult[] = [
    {
      stdout: Buffer.from(c + "\n"),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      signal: null,
      processSettled: true,
    },
    {
      stdout: Buffer.from(`100644 blob ${a}\tuntouched\0`),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      signal: null,
      processSettled: true,
    },
    {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      signal: null,
      processSettled: true,
    },
  ];
  const client: Client = {
    gitVersion: "test",
    inTemporaryIndex: async () => {
      throw Error("unused");
    },
    inTemporaryRepository: async () => {
      throw Error("unexpected isolated calculation");
    },
    run: async (request: { command: string }) => {
      calls.push(request.command);
      const result = outputs.shift();
      if (!result) throw Error("unexpected command");
      return result;
    },
  };
  return {
    client,
    outputs,
    calls,
    state: {
      indexData: Buffer.from(index).toString("base64"),
    } as NativeGitState,
  };
}
it("uses Git's witness for unchanged index and worktree", async () => {
  const f = witness();
  await expect(verifyNativeAutoMerge(f.client, f.state, [])).resolves.toBe(
    true,
  );
  expect(f.calls).toEqual(["rev-parse", "ls-tree", "diff"]);
});
it("rejects an index-only substitution even when worktree diff would be clean", async () => {
  const f = witness(`100644 ${b} 0\tuntouched\0`);
  await expect(verifyNativeAutoMerge(f.client, f.state, [])).rejects.toThrow();
  expect(f.calls).toEqual(["rev-parse", "ls-tree"]);
});
it("rejects changed conflict text reported by the native diff", async () => {
  const f = witness();
  f.outputs[2].stdout = Buffer.from("conflict\0");
  await expect(
    verifyNativeAutoMerge(f.client, f.state, ["conflict"]),
  ).rejects.toThrow();
});
it("distinguishes absent AUTO_MERGE from a failed or unsettled probe", async () => {
  const absent = witness();
  Object.assign(absent.outputs[0], { stdout: Buffer.alloc(0), exitCode: 1 });
  await expect(
    verifyNativeAutoMerge(absent.client, absent.state, []),
  ).resolves.toBe(false);
  const failed = witness();
  Object.assign(failed.outputs[0], {
    stdout: Buffer.alloc(0),
    exitCode: 1,
    stderr: Buffer.from("failed"),
  });
  await expect(
    verifyNativeAutoMerge(failed.client, failed.state, []),
  ).rejects.toThrow();
  const unsettled = witness();
  Object.assign(unsettled.outputs[0], {
    stdout: Buffer.alloc(0),
    exitCode: 1,
    processSettled: false,
  });
  await expect(
    verifyNativeAutoMerge(unsettled.client, unsettled.state, []),
  ).rejects.toBeInstanceOf(ByteCommandError);
});

it("matches full native index records, independent of order", async () => {
  const { verifyNativeConflictIndex } =
    await import("../src/host/git-native-result-verifier");
  const first = `100644 ${a} 1\tx\nфайл\0`;
  const second = `100755 ${b} 2\tx\nфайл\0`;
  expect(
    verifyNativeConflictIndex(
      `${first}${second}100644 ${a} 0\tother\0`,
      `${second}100644 ${a} 0\tother\0${first}`,
    ),
  ).toEqual(["x\nфайл"]);
});
it.each([
  `100644 ${a} 1\tx\0`,
  `100644 ${b} 1\tx\0`,
  `100755 ${a} 1\tx\0`,
  `100644 ${a} 1\tx\0` + `100644 ${b} 3\tx\0`,
  `100644 ${a} 1\tx\0` + `100644 ${b} 2\tx\0` + `100644 ${b} 3\tother\0`,
  `100644 ${a} 1\tx\0` + `100644 ${b} 2\tx\0` + `100644 ${b} 0\tx\0`,
  `100644 ${a} 1\tx\0` + `100644 ${b} 2\tx\0` + `100644 ${b} 2\tx\0`,
])(
  "rejects missing, extra, changed or malformed unmerged tuple %s",
  async (index) => {
    const { verifyNativeConflictIndex } =
      await import("../src/host/git-native-result-verifier");
    expect(() =>
      verifyNativeConflictIndex(
        `100644 ${a} 1\tx\0` + `100644 ${b} 2\tx\0`,
        index,
      ),
    ).toThrow();
  },
);
