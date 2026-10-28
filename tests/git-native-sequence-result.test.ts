import { expect, it } from "vitest";
import {
  verifiedNativeSequenceResult,
  nativeSequenceDiagnostics,
} from "../src/renderer/git-native-sequence-result";
const head = "a".repeat(40),
  original = "b".repeat(40);
const submitted = {
  scope: "p",
  operation: "rebase",
  action: "abort",
  head,
  original,
} as const;
const value = () => ({
  scope: "p",
  operation: "rebase",
  action: "abort",
  status: "success",
  changed: true,
  lockRetained: false,
  retainedLocks: [],
  uncheckedLocks: [],
  message: "native completed",
  log: "",
  native: {
    operationId: "11111111-1111-4111-8111-111111111111",
    outcome: "completed",
    exitCode: 0,
    signal: null,
    beforeHead: original,
    afterHead: original,
    conflicts: [],
    verifiedUnrelatedData: true,
    processSettled: true,
    recovery: "removed",
  },
});
it("accepts verified native completion without invented publication flags", () => {
  expect(verifiedNativeSequenceResult(value(), submitted)).toBe(true);
  expect(nativeSequenceDiagnostics(value(), true)).not.toMatch(
    /reflog не|объектов|Индекс опубликован/,
  );
});
it.each([
  "owner",
  "action",
  "beforeHead",
  "afterHead",
  "signal",
  "unsettled",
  "unverified",
  "recovery",
  "lock",
  "status",
])("rejects inconsistent native completion: %s", (change) => {
  const v: any = value();
  if (change === "owner") v.scope = "other";
  if (change === "action") v.action = "continue";
  if (change === "beforeHead") v.native.beforeHead = head;
  if (change === "afterHead") v.native.afterHead = head;
  if (change === "signal") v.native.signal = "SIGTERM";
  if (change === "unsettled") v.native.processSettled = false;
  if (change === "unverified") v.native.verifiedUnrelatedData = false;
  if (change === "recovery") v.native.recovery = "unknown";
  if (change === "lock") v.uncheckedLocks = ["config.lock"];
  if (change === "status") v.status = "uncertain";
  expect(verifiedNativeSequenceResult(v, submitted)).toBe(false);
});
it("recognizes a next conflict only with retained recovery and exit one", () => {
  const v: any = value();
  Object.assign(v, { action: "continue", status: "conflict" });
  Object.assign(v.native, {
    outcome: "conflicts",
    exitCode: 1,
    conflicts: ["file"],
    recovery: "retained",
    recoveryPath: "/fixture/recovery",
  });
  expect(
    verifiedNativeSequenceResult(v, { ...submitted, action: "continue" }),
  ).toBe(true);
  delete v.native.recoveryPath;
  expect(
    verifiedNativeSequenceResult(v, { ...submitted, action: "continue" }),
  ).toBe(false);
});
