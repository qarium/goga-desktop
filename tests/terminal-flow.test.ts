import { expect, it, vi } from "vitest";
import {
  TerminalFlow,
  FLOW_HIGH,
  FLOW_LOW,
  FLOW_LIMIT,
} from "../src/host/terminal-flow";
import type { TerminalFrame } from "../src/shared/terminal-screen";
const ref = {
  sessionId: "s",
  generation: "00000000-0000-4000-8000-000000000001",
};
function fixture() {
  const frames: TerminalFrame[] = [];
  const pause = vi.fn(),
    resume = vi.fn(),
    lost = vi.fn();
  const flow = new TerminalFlow(ref, {
    send: (f) => frames.push(f),
    pause,
    resume,
    lost,
  });
  const ack = (f: TerminalFrame) =>
    flow.ack({ ...flow.grant, sequence: f.sequence });
  return { flow, frames, pause, resume, lost, ack };
}
it("accounts UTF-8 bytes and only releases after exact acknowledgement", () => {
  const f = fixture();
  expect(f.flow.offer("Привет🙂")).toBe(true);
  expect(f.flow.snapshot().pendingBytes).toBe(Buffer.byteLength("Привет🙂"));
  expect(f.frames).toHaveLength(1);
  expect(f.flow.ack({ ...f.flow.grant, sequence: 2 })).toBe(false);
  expect(f.ack(f.frames[0])).toBe(true);
  expect(f.flow.snapshot().pendingBytes).toBe(0);
  expect(f.ack(f.frames[0])).toBe(false);
});
it("pauses at 256 KiB, resumes only at 64 KiB, never on duplicate ack", () => {
  const f = fixture();
  for (let n = 0; n < 4; n++)
    expect(f.flow.offer("x".repeat(65536))).toBe(true);
  expect(f.flow.snapshot().pendingBytes).toBe(FLOW_HIGH);
  expect(f.pause).toHaveBeenCalledTimes(1);
  while (f.flow.snapshot().pendingBytes > FLOW_LOW) f.ack(f.frames.shift()!);
  expect(f.resume).toHaveBeenCalledTimes(1);
  expect(f.flow.snapshot().pendingBytes).toBe(FLOW_LOW);
});
it("bounds both queued and sent data; refused chunks remain the caller's responsibility", () => {
  const f = fixture();
  const chunks = Array.from({ length: 16 }, (_, n) =>
    String(n % 10).repeat(65536),
  );
  for (const chunk of chunks) expect(f.flow.offer(chunk)).toBe(true);
  expect(f.flow.snapshot().pendingBytes).toBe(FLOW_LIMIT);
  expect(f.frames.reduce((n, x) => n + Buffer.byteLength(x.text), 0)).toBe(
    FLOW_HIGH,
  );
  expect(f.flow.offer("TAIL")).toBe(false);
  let output = "";
  while (f.flow.snapshot().pendingBytes) {
    const frame = f.frames.shift()!;
    output += frame.text;
    f.ack(frame);
  }
  expect(f.flow.offer("TAIL")).toBe(true);
  output += f.frames[0].text;
  expect(output).toBe(chunks.join("") + "TAIL");
});
it("splits frames without damaging Unicode or a split escape sequence", () => {
  const f = fixture();
  const chunks = [
    "🙂ю".repeat(5000),
    "\x1b[31;",
    "1mRED\x1b[0m",
    "\ud83d",
    "\ude42",
  ];
  for (const s of chunks) f.flow.offer(s);
  expect(f.frames.map((f) => f.text).join("")).toBe(chunks.join(""));
  for (const frame of f.frames)
    expect(Buffer.byteLength(frame.text)).toBeLessThanOrEqual(16384);
});
it("rejects old generation, wrong capability, extra fields and out-of-order acknowledgements", () => {
  const f = fixture();
  f.flow.offer("one");
  f.flow.offer("two");
  for (const value of [
    { ...f.flow.grant, sequence: 2 },
    { ...f.flow.grant, sequence: 1, capability: crypto.randomUUID() },
    { ...f.flow.grant, sequence: 1, generation: crypto.randomUUID() },
    { ...f.flow.grant, sequence: 1, bytes: 100 },
    { ...f.flow.grant, sequence: NaN },
  ])
    expect(f.flow.ack(value)).toBe(false);
  expect(f.flow.snapshot().pendingBytes).toBe(6);
  expect(f.ack(f.frames[0])).toBe(true);
  expect(f.ack(f.frames[1])).toBe(true);
});
it("renderer loss revokes input/acks and pauses without restarting or discarding pending output", () => {
  const f = fixture();
  const grant = f.flow.grant;
  f.flow.offer("before");
  f.flow.rendererLost();
  f.flow.rendererLost();
  expect(f.flow.accepts(grant)).toBe(false);
  expect(f.ack(f.frames[0])).toBe(false);
  expect(f.flow.offer("after")).toBe(true);
  expect(f.frames).toHaveLength(1);
  expect(f.flow.snapshot()).toMatchObject({
    state: "renderer-lost",
    pendingBytes: 11,
  });
  expect(f.pause).toHaveBeenCalledTimes(1);
  expect(f.resume).not.toHaveBeenCalled();
  expect(f.lost).toHaveBeenCalledTimes(1);
});
it("transport send failure retains payload and fails closed", () => {
  const lost = vi.fn(),
    pause = vi.fn();
  const flow = new TerminalFlow(ref, {
    send: () => {
      throw Error("transport");
    },
    pause,
    resume: vi.fn(),
    lost,
  });
  expect(flow.offer("not silently lost")).toBe(true);
  expect(flow.snapshot()).toMatchObject({
    state: "renderer-lost",
    pendingBytes: 17,
  });
  expect(lost).toHaveBeenCalledOnce();
  expect(pause).toHaveBeenCalledOnce();
});
it("handles synchronous acknowledgements without reentrancy or double sends", () => {
  const sent: string[] = [];
  let flow: TerminalFlow;
  flow = new TerminalFlow(ref, {
    send: (f) => {
      sent.push(f.text);
      flow.ack({ ...flow.grant, sequence: f.sequence });
    },
    pause: vi.fn(),
    resume: vi.fn(),
    lost: vi.fn(),
  });
  flow.offer("🙂".repeat(16000));
  expect(sent.join("")).toBe("🙂".repeat(16000));
  expect(flow.snapshot().pendingBytes).toBe(0);
});
it("does not leak a mutable capability or accept an oversized source event", () => {
  const f = fixture(),
    grant = f.flow.grant;
  grant.capability = crypto.randomUUID();
  expect(f.flow.accepts(grant)).toBe(false);
  expect(() => f.flow.offer("x".repeat(65537))).toThrow();
  expect(f.flow.snapshot().pendingBytes).toBe(0);
});
it("bounds tiny frame metadata and allows explicit disposal only, not reattachment", () => {
  const f = fixture();
  let count = 0;
  while (f.flow.offer("x")) {
    count++;
    if (count > 10000) throw Error("unbounded metadata");
  }
  expect(count).toBeLessThanOrEqual(4096);
  expect(f.pause).toHaveBeenCalled();
  f.flow.dispose();
  expect(f.flow.snapshot()).toMatchObject({
    state: "disposed",
    pendingBytes: 0,
  });
  expect(f.flow.offer("x")).toBe(false);
  expect(f.flow.accepts(f.flow.grant)).toBe(false);
  expect(f.resume).not.toHaveBeenCalled();
});
