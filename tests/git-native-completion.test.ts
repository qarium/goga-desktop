import { expect, it } from "vitest";
import {
  withNativeGitCompletion,
  deferNativeGitRecovery,
} from "../src/host/git-native-completion";
import type { NativeGitOperationResult } from "../src/shared/git-native-operation";
const proof = (): NativeGitOperationResult => ({
  operationId: "11111111-1111-4111-8111-111111111111",
  outcome: "completed",
  beforeHead: "a".repeat(40),
  afterHead: "b".repeat(40),
  conflicts: [],
  exitCode: 0,
  signal: null,
  processSettled: true,
  verifiedUnrelatedData: true,
  recovery: "retained",
  recoveryPath: "/fixture/journal.json",
});
it("keeps recovery through nested operation and outer context verification", async () => {
  const n = proof();
  let cleaned = false;
  const result = await withNativeGitCompletion(async () => {
    const inner = await withNativeGitCompletion(async () => {
      deferNativeGitRecovery(async () => {
        cleaned = true;
        const { recoveryPath, ...rest } = n;
        return { ...rest, recovery: "removed" };
      }, n);
      return {
        status: "success",
        native: { ...n },
        recoveryPath: n.recoveryPath,
      };
    });
    expect(cleaned).toBe(false);
    return inner;
  });
  expect(cleaned).toBe(true);
  expect(result.native.recovery).toBe("removed");
  expect(result.native.recoveryPath).toBeUndefined();
  expect(result.recoveryPath).toBeUndefined();
});
it("never cleans after throwing or returned-uncertain outer context", async () => {
  for (const throws of [true, false]) {
    let cleaned = false;
    const n = proof();
    const run = withNativeGitCompletion(async () => {
      deferNativeGitRecovery(async () => {
        cleaned = true;
        return n;
      }, n);
      if (throws) throw Error("fixture-private-output");
      return { status: "uncertain", native: n };
    });
    if (throws) await expect(run).rejects.toThrow(/провер/);
    else expect((await run).native.outcome).toBe("uncertain");
    expect(cleaned).toBe(false);
  }
});
it("unknown cleanup cannot report branch success or discard retained recovery", async () => {
  const n = proof();
  const result = await withNativeGitCompletion(async () => {
    deferNativeGitRecovery(async () => ({ ...n, recovery: "unknown" }), n);
    return {
      status: "success",
      recoveryPath: n.recoveryPath,
      message: "success",
    };
  });
  expect(result.status).toBe("uncertain");
  expect(result.recoveryPath).toBe(n.recoveryPath);
  expect(result.message).not.toBe("success");
});
it("verified rejection cleans after context but unbound result cannot clear another operation", async () => {
  let cleaned = false;
  const n = { ...proof(), outcome: "rejected" as const, exitCode: 1 };
  const finish = async () => {
    cleaned = true;
    const { recoveryPath, ...rest } = n;
    return { ...rest, recovery: "removed" as const };
  };
  const result = await withNativeGitCompletion(async () => {
    deferNativeGitRecovery(finish, n);
    return { status: "error", native: n };
  });
  expect(cleaned).toBe(true);
  expect(result.status).toBe("error");
  cleaned = false;
  const unrelated = await withNativeGitCompletion(async () => {
    deferNativeGitRecovery(finish, n);
    return { status: "success", recoveryPath: "/other/journal.json" };
  });
  expect(unrelated.status).toBe("uncertain");
  expect(cleaned).toBe(false);
});
