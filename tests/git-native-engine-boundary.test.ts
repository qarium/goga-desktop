import { expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
const retired = [
  "git-operations",
  "git-rebase-operations",
  "git-rebase-continue",
  "git-rebase-continue-state",
  "git-rebase-apply",
  "git-rebase-apply-state",
  "git-rebase-operations-state",
  "git-sequencer-operations",
  "git-sequencer-state",
  "git-sequencer-plan",
  "git-update-handoff",
  "git-update-start",
];
it("contains no retired Git replay or manual publication engine", () => {
  for (const name of retired)
    expect(existsSync(path.join("src/host", name + ".ts")), name).toBe(false);
  const safety = readFileSync("src/host/git-merge-safety.ts", "utf8");
  expect(safety).not.toContain("pinnedMergeAbort");
  for (const name of [
    "git-workspace-actions",
    "git-discard-actions",
    "git-conflict-actions",
  ]) {
    const source = readFileSync(path.join("src/host", name + ".ts"), "utf8");
    expect(source).toContain("export abstract class");
    expect(source).not.toMatch(/(?:renameSync|linkSync|writeFileSync)\(/);
  }
});
