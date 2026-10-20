import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readWorkingTask, taskPath } from "../src/host/topic-task";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it(
  "rejects a FIFO task without waiting on a writer",
  { timeout: 2000 },
  async () => {
    const root = await mkdtemp("/private/tmp/goga-task-safety47-");
    roots.push(root);
    await promisify(execFile)("mkfifo", [path.join(root, "todo.md")]);
    await expect(readWorkingTask(root, "todo.md")).rejects.toThrow(
      /обычным|Недопустим/,
    );
  },
);
it("requires an exact four-digit task year rather than accepting a path fragment", () => {
  expect(taskPath("feature-test", "2025")).toBe(
    ".goga/history/2025/feature-test/todo.md",
  );
  for (const year of ["../2026", "2026/other", "26", "2026x"])
    expect(() => taskPath("feature-test", year)).toThrow();
});
