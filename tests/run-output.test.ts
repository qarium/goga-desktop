import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { captureRunOutput } from "../src/host/run-output";
import { watchDashboard } from "../src/host/process";

function childFixture() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
}
afterEach(() => vi.useRealTimers());

it("collects plain stdout and stderr, including post-readiness text", () => {
  const child = childFixture();
  const output = captureRunOutput(child, [], vi.fn());
  child.stdout.write("starting\n");
  child.stderr.write("warning\n");
  child.stdout.write("dashboard: http://localhost:1234\n");
  child.stdout.write("after ready\n");
  expect(output.snapshot()).toEqual({
    text: "starting\nwarning\ndashboard: http://localhost:1234\nafter ready\n",
    truncated: false,
  });
  output.dispose();
});

it("decodes split UTF-8 independently for each stream", () => {
  const child = childFixture();
  const output = captureRunOutput(child, [], vi.fn());
  const bytes = Buffer.from("Ж🙂");
  child.stdout.write(bytes.subarray(0, 1));
  child.stderr.write("stderr\n");
  child.stdout.write(bytes.subarray(1, 4));
  child.stdout.write(bytes.subarray(4));
  expect(output.snapshot().text).toBe("stderr\nЖ🙂");
  output.dispose();
});

it("strips chunk-split CSI, OSC and control strings and normalizes CRLF/progress", () => {
  const child = childFixture();
  const output = captureRunOutput(child, [], vi.fn());
  for (const chunk of [
    "a\x1b[",
    "31mred\x1b[0m\r",
    "\nb\r",
    "c\x1b]title",
    "\x1b",
    "\\d\x1bPpayload",
    "\x1b\\e\x00\x08\x7f\n",
  ])
    child.stdout.write(chunk);
  expect(output.snapshot().text).toBe("ared\nb\ncde\n");
  output.dispose();
});

it("never publishes split or formatted secrets or a trailing secret prefix", () => {
  vi.useFakeTimers();
  const child = childFixture();
  const update = vi.fn();
  const output = captureRunOutput(child, ["private-token"], update);
  child.stdout.write("before pri");
  vi.advanceTimersByTime(100);
  expect(output.snapshot().text).toBe("before ");
  child.stdout.write("vate-\x1b[31mto");
  child.stderr.write("other\n");
  vi.advanceTimersByTime(100);
  child.stdout.write("ken\x1b[0m after pri");
  child.emit("close", 0);
  expect(output.snapshot().text).toContain("[REDACTED] after [REDACTED]");
  for (const [value] of update.mock.calls) {
    expect(value.text).not.toContain("private-token");
    expect(value.text).not.toMatch(/pri$/);
  }
});

it("redacts all overlapping matches rather than exposing a longer secret tail", () => {
  const child = childFixture();
  const output = captureRunOutput(
    child,
    ["abc", "bcdef", "abcdefghi"],
    vi.fn(),
  );
  for (const part of ["ab", "c", "def", "ghi!"]) child.stdout.write(part);
  output.dispose();
  expect(output.snapshot().text).toBe("[REDACTED]!");
});

it("isolates redaction streams and runs despite interleaved chunks", () => {
  const a = childFixture(),
    b = childFixture();
  const first = captureRunOutput(a, ["secret"], vi.fn());
  const second = captureRunOutput(b, [], vi.fn());
  a.stdout.write("sec");
  a.stderr.write("notice\n");
  b.stdout.write("visible\n");
  a.stdout.write("ret\n");
  first.dispose();
  second.dispose();
  expect(first.snapshot().text).toBe("notice\n[REDACTED]\n");
  expect(second.snapshot().text).toBe("visible\n");
});

it("bounds the UTF-8 tail under flooding and marks truncation", () => {
  const child = childFixture();
  const output = captureRunOutput(child, [], vi.fn());
  child.stdout.write("🙂".repeat(100000));
  child.stderr.write("tail");
  const snapshot = output.snapshot();
  expect(Buffer.byteLength(snapshot.text)).toBeLessThanOrEqual(128 * 1024);
  expect(snapshot.text).not.toContain("�");
  expect(snapshot.text.endsWith("tail")).toBe(true);
  expect(snapshot.truncated).toBe(true);
  output.dispose();
});

it("bounds incomplete escape strings without publishing their payload", () => {
  const child = childFixture();
  const output = captureRunOutput(child, [], vi.fn(), { maxBytes: 128 });
  child.stdout.write("ok\x1b]" + "private".repeat(10000));
  expect(output.snapshot()).toEqual({ text: "ok", truncated: true });
  child.stdout.write("\x07done");
  output.dispose();
  expect(output.snapshot().text).toBe("okdone");
});

it("throttles ordinary updates and immediately flushes on stream end and close", () => {
  vi.useFakeTimers();
  const child = childFixture();
  const update = vi.fn();
  const output = captureRunOutput(child, [], update);
  for (let i = 0; i < 100; i++) child.stdout.write("x");
  expect(update).not.toHaveBeenCalled();
  vi.advanceTimersByTime(100);
  expect(update).toHaveBeenCalledTimes(1);
  child.stderr.write("final");
  child.stderr.emit("end");
  expect(update).toHaveBeenCalledTimes(2);
  child.emit("close", 0);
  vi.advanceTimersByTime(1000);
  expect(update).toHaveBeenCalledTimes(2);
  expect(output.snapshot().text.endsWith("final")).toBe(true);
});

it("dispose flushes pending safe output and removes only its own listeners and timer", () => {
  vi.useFakeTimers();
  const child = childFixture();
  const existing = vi.fn();
  child.stdout.on("data", existing);
  const update = vi.fn();
  const output = captureRunOutput(child, ["secret"], update);
  child.stdout.write("ok sec");
  output.dispose();
  output.dispose();
  expect(output.snapshot().text).toBe("ok [REDACTED]");
  expect(child.stdout.listenerCount("data")).toBe(1);
  expect(child.stderr.listenerCount("data")).toBe(0);
  expect(child.listenerCount("close")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  child.stdout.write("ignored");
  expect(existing).toHaveBeenCalledTimes(2);
  expect(update).toHaveBeenCalledTimes(1);
});

it("does not reproduce a known secret in its redaction placeholder", () => {
  const child = childFixture();
  const output = captureRunOutput(child, ["REDACTED", "СКРЫТО"], vi.fn());
  child.stdout.write("REDACTED СКРЫТО");
  output.dispose();
  expect(output.snapshot().text).not.toContain("REDACTED");
  expect(output.snapshot().text).not.toContain("СКРЫТО");
});

it("does not split surrogate pairs when a stream already has an encoding", () => {
  const child = childFixture();
  child.stdout.setEncoding("utf8");
  const output = captureRunOutput(child, [], vi.fn());
  child.stdout.write("x".repeat(4095) + "🙂".repeat(100000));
  output.dispose();
  expect(output.snapshot().text).toBe("🙂".repeat(32768));
});

it("fails closed for oversized secret definitions and ignores empty secrets", () => {
  for (const secrets of [
    ["a".repeat(4097)],
    Array.from({ length: 40 }, (_, n) => `${n}${"a".repeat(4000)}`),
  ]) {
    const child = childFixture();
    const output = captureRunOutput(child, secrets, vi.fn());
    child.stdout.write("possibly sensitive output");
    output.dispose();
    expect(output.snapshot()).toEqual({ text: "", truncated: true });
  }
  const child = childFixture();
  const output = captureRunOutput(child, [""], vi.fn());
  child.stdout.write("visible");
  output.dispose();
  expect(output.snapshot().text).toBe("visible");
});

it("holds a secret prefix through an explicit live flush and dashboard cancellation", () => {
  const child = childFixture();
  const output = captureRunOutput(child, ["secret"], vi.fn());
  const cancel = watchDashboard(child, {
    timeoutMs: null,
    onReady: vi.fn(),
    onFinish: vi.fn(),
    onFailure: vi.fn(),
  });
  child.stdout.write("sec");
  output.flush();
  expect(output.snapshot().text).toBe("");
  cancel();
  child.stdout.write("ret after cancellation");
  output.dispose();
  expect(output.snapshot().text).toBe("[REDACTED] after cancellation");
});

it("keeps a long overlapping secret bounded under a single oversized write", () => {
  const child = childFixture();
  const output = captureRunOutput(child, ["a".repeat(4096)], vi.fn());
  child.stdout.write("a".repeat(256 * 1024));
  output.dispose();
  expect(output.snapshot().text).toBe("[REDACTED]");
});

it("strips C1 controls and independently completes split OSC terminators", () => {
  const child = childFixture();
  const output = captureRunOutput(child, ["secret"], vi.fn());
  child.stdout.write("se\u009b31mcr\u009dhidden");
  child.stderr.write("visible\n");
  child.stdout.write("\u009cet\u009b0m!");
  output.dispose();
  expect(output.snapshot().text).toBe("visible\n[REDACTED]!");
});

it("does not share pending carriage returns between streams", () => {
  const child = childFixture();
  const output = captureRunOutput(child, [], vi.fn());
  child.stdout.write("first\r");
  child.stderr.write("\nsecond\r");
  child.stdout.write("\nthird");
  output.dispose();
  expect(output.snapshot().text).toBe("first\n\nsecond\nthird");
});

it("does not allow a caller to raise the output cap or exceed the notification rate", () => {
  vi.useFakeTimers();
  const child = childFixture();
  const update = vi.fn();
  const output = captureRunOutput(child, [], update, {
    maxBytes: 1e9,
    throttleMs: 1,
  });
  child.stdout.write("x".repeat(256 * 1024));
  vi.advanceTimersByTime(99);
  expect(update).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(update).toHaveBeenCalledTimes(1);
  expect(Buffer.byteLength(output.snapshot().text)).toBe(128 * 1024);
  output.dispose();
});
