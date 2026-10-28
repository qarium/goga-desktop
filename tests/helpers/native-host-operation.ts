import { expect, vi } from "vitest";
import type { HostService } from "../../src/host/service";
import {
  NativeGitSequence,
  type NativeSequenceStart,
} from "../../src/host/git-native-sequence";
import type { GitMergeContext } from "../../src/host/git-merge-safety";
import type { ScopeRef } from "../../src/shared/context";
import type { ByteCommandResult, NodeRunner } from "../../src/host/process";

/** Real Desktop start, not an external Git process or a fabricated receipt. */
export async function startNativeHostOperation(
  host: HostService,
  scope: ScopeRef,
  start: NativeSequenceStart,
) {
  const engine = new NativeGitSequence({
    context: (s, action) =>
      (
        host as unknown as {
          gitNativeSequenceContext<T>(
            scope: ScopeRef,
            action: (context: GitMergeContext) => Promise<T>,
          ): Promise<T>;
        }
      ).gitNativeSequenceContext(s, action),
  });
  const preview = await engine.prepareStart(scope, start);
  const result = await engine.execute(preview.token);
  expect(result).toMatchObject({
    outcome: "conflicts",
    processSettled: true,
    verifiedUnrelatedData: true,
    recovery: "retained",
  });
  return result;
}

/** The old manual publication callback has no native analogue. Inject only
 * AFTER the actual child has settled, BEFORE native capture/verification.
 * Preserve its real exit status/output; never fake native success or retry. */
export function afterNativeHostCommand(
  runner: NodeRunner,
  action: "continue" | "abort",
  fault: (result: ByteCommandResult) => void | Promise<void>,
) {
  const command = runner.commandBytes.bind(runner);
  let calls = 0;
  const spy = vi
    .spyOn(runner, "commandBytes")
    .mockImplementation(async (input) => {
      const result = await command(input);
      if (input.args.includes("rebase") && input.args.includes(`--${action}`)) {
        calls++;
        await fault(result);
      }
      return result;
    });
  return {
    get calls() {
      return calls;
    },
    restore: () => spy.mockRestore(),
  };
}
