import { NativeGitMergeOperations } from "../src/host/git-native-merge";
import { NativeGitSequenceAPI } from "../src/host/git-native-sequence-api";
import { NativeGitUpdateHandoff } from "../src/host/git-native-update-handoff";
import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { NativeGitWorkspaceActions } from "../src/host/git-native-commit";
import { NativeGitDiscardActions } from "../src/host/git-native-discard";
import { NativeGitConflictActions } from "../src/host/git-native-conflict-save";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
it("Host routes selected-file writes and stopped operations to the native engine without fallback", async () => {
  const home = await fs.mkdtemp("/private/tmp/goga-native-routing-");
  cleanup.push(() => fs.rm(home, { recursive: true, force: true }));
  const host = new HostService({
    home,
    dataDir: path.join(home, "data"),
    goga: "/nonexistent/disabled",
  });
  cleanup.push(() => host.dispose());
  expect((host as any).gitMergeOperations).toBeInstanceOf(NativeGitMergeOperations);
  expect((host as any).gitNativeSequence).toBeInstanceOf(NativeGitSequenceAPI);
  expect((host as any).gitUpdateHandoff).toBeInstanceOf(NativeGitUpdateHandoff);
  expect((host as any).gitActions).toBeInstanceOf(NativeGitWorkspaceActions);
  expect((host as any).gitDiscardActions).toBeInstanceOf(
    NativeGitDiscardActions,
  );
  expect((host as any).gitConflictActions).toBeInstanceOf(
    NativeGitConflictActions,
  );
});
