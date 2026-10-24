import { expect, it, vi } from "vitest";
import { TerminalTransport } from "../src/host/terminal-transport";
import { TerminalFlow, FLOW_LIMIT } from "../src/host/terminal-flow";
import { TERMINAL_SOURCE_BYTES } from "../src/shared/terminal-screen";
import type { TerminalSessionRef } from "../src/shared/terminal";
const ref = () => ({
  sessionId: crypto.randomUUID(),
  generation: crypto.randomUUID(),
});
const key = (r: TerminalSessionRef) =>
  JSON.stringify([r.sessionId, r.generation]);
const source = () => ({
  pause: vi.fn(),
  resume: vi.fn(),
  input: vi.fn(),
  resize: vi.fn(),
});
function deferred() {
  let resolve!: () => void, reject!: (e: Error) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const views: any[] = [];
  const create = vi.fn((lost: (ref: TerminalSessionRef) => void) => {
    const ready = deferred(),
      flows = new Map<string, TerminalFlow>(),
      frames: any[] = [];
    const view = {
      isLost: false,
      ready,
      flows,
      frames,
      whenReady: () => ready.promise,
      attach: vi.fn(
        (ref: TerminalSessionRef, src: ReturnType<typeof source>) => {
          const flow = new TerminalFlow(ref, {
            ...src,
            send: (frame) => frames.push(frame),
            lost: () => lost(ref),
          });
          flows.set(key(ref), flow);
          return flow.grant;
        },
      ),
      output: vi.fn((ref: TerminalSessionRef, text: string) =>
        flows.get(key(ref))!.offer(text),
      ),
      status: (ref: TerminalSessionRef) => flows.get(key(ref))!.snapshot(),
      fail: (ref: TerminalSessionRef) => flows.get(key(ref))!.rendererLost(),
      exited: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      remove: vi.fn((ref: TerminalSessionRef) => {
        flows.get(key(ref))!.dispose();
        flows.delete(key(ref));
      }),
      dispose: vi.fn(),
      crash() {
        view.isLost = true;
        ready.reject(Error("crash"));
        for (const flow of flows.values()) flow.rendererLost();
      },
      drain() {
        for (let n = 0; n < frames.length; n++) {
          const frame = frames[n];
          flows.get(key(frame))?.ack({
            sessionId: frame.sessionId,
            generation: frame.generation,
            capability: frame.capability,
            sequence: frame.sequence,
          });
        }
      },
    };
    views.push(view);
    return view;
  });
  return { transport: new TerminalTransport(create), views, create };
}
async function prepared(
  f: ReturnType<typeof fixture>,
  r = ref(),
  lost = vi.fn(),
) {
  const pending = f.transport.prepare(r, lost);
  f.views.at(-1).ready.resolve();
  return { screen: await pending, ref: r, lost };
}
it("shares async renderer initialization and binds only after the host has spawned", async () => {
  const f = fixture(),
    a = ref(),
    b = ref();
  const first = f.transport.prepare(a, vi.fn()),
    second = f.transport.prepare(b, vi.fn());
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.views[0].attach).not.toHaveBeenCalled();
  f.views[0].ready.resolve();
  const [sa, sb] = await Promise.all([first, second]);
  sa.bind(source());
  sb.bind(source());
  expect(f.views[0].attach).toHaveBeenCalledTimes(2);
  expect(() => sa.bind(source())).toThrow();
  await expect(f.transport.prepare(a, vi.fn())).rejects.toThrow();
});
it("renderer failure before binding prevents spawn readiness and cleans unbound reservations", async () => {
  const f = fixture(),
    r = ref(),
    lost = vi.fn();
  const promise = f.transport.prepare(r, lost);
  f.views[0].crash();
  await expect(promise).rejects.toThrow();
  expect(f.views[0].dispose).toHaveBeenCalledOnce();
  expect(f.views[0].attach).not.toHaveBeenCalled();
  const next = await prepared(f);
  f.views[1].crash();
  expect(() => next.screen.assertReady()).toThrow();
  expect(() => next.screen.bind(source())).toThrow();
  next.screen.dispose();
});
it("retries a refused chunk exactly once before resuming native reads", async () => {
  const f = fixture(),
    { screen, ref: r } = await prepared(f),
    src = source(),
    view = f.views[0];
  screen.bind(src);
  screen.output("a".repeat((256 * 1024) / 4));
  for (let n = 0; n < 3; n++) screen.output("b".repeat(64 * 1024));
  view.output.mockReturnValueOnce(false);
  screen.output("REFUSED🙂");
  expect(src.pause).toHaveBeenCalled();
  expect(view.frames.map((x: any) => x.text).join("")).not.toContain("REFUSED");
  view.drain();
  expect(view.frames.map((x: any) => x.text).join("")).toContain("REFUSED🙂");
  expect(view.frames.filter((x: any) => x.text === "REFUSED🙂")).toHaveLength(
    1,
  );
  expect(src.resume).toHaveBeenCalledOnce();
  expect(view.status(r).pendingBytes).toBe(0);
});
it("bounds pending output including a retained chunk and explicitly faults an adapter that ignores pause", async () => {
  const f = fixture(),
    { screen, ref: r, lost } = await prepared(f),
    view = f.views[0],
    src = source();
  screen.bind(src);
  for (let n = 0; n < FLOW_LIMIT / TERMINAL_SOURCE_BYTES - 1; n++)
    screen.output("x".repeat(TERMINAL_SOURCE_BYTES));
  expect(view.status(r).pendingBytes).toBe(
    FLOW_LIMIT - 2 * TERMINAL_SOURCE_BYTES,
  );
  expect(() => screen.output("EXCESS")).toThrow(/поток|транспорт/i);
  expect(lost).toHaveBeenCalledOnce();
  expect(view.status(r).state).toBe("renderer-lost");
  expect(view.status(r).pendingBytes).toBeLessThanOrEqual(
    FLOW_LIMIT - 2 * TERMINAL_SOURCE_BYTES,
  );
  expect(src.pause).toHaveBeenCalled();
});
it("does not reattach old streams after a crash; new generations get a fresh renderer", async () => {
  const f = fixture(),
    first = await prepared(f),
    other = await prepared(f),
    src = source();
  first.screen.bind(src);
  other.screen.bind(source());
  first.screen.output("old-before");
  f.views[0].crash();
  expect(first.lost).toHaveBeenCalledOnce();
  expect(other.lost).toHaveBeenCalledOnce();
  await expect(f.transport.prepare(first.ref, vi.fn())).rejects.toThrow();
  await expect(
    f.transport.prepare(
      { ...first.ref, generation: crypto.randomUUID() },
      vi.fn(),
    ),
  ).rejects.toThrow();
  first.screen.exited();
  const replacement = await prepared(f, {
    ...first.ref,
    generation: crypto.randomUUID(),
  });
  expect(f.views).toHaveLength(2);
  replacement.screen.bind(source());
  replacement.screen.output("new-only");
  expect(f.views[1].frames.map((x: any) => x.text).join("")).toBe("new-only");
  expect(f.views[0].dispose).not.toHaveBeenCalled(); // other session still owned
  other.screen.exited();
  other.screen.dispose();
  expect(f.views[0].dispose).toHaveBeenCalledOnce();
});
it("failed replacement preparation preserves the old completed screen", async () => {
  const f = fixture(),
    first = await prepared(f);
  first.screen.bind(source());
  first.screen.exited();
  const next = await prepared(f, {
    ...first.ref,
    generation: crypto.randomUUID(),
  });
  next.screen.dispose(); // host spawn failed; never bound
  expect(f.views[0].remove).not.toHaveBeenCalled();
  f.transport.show(first.ref, { x: 0, y: 0, width: 500, height: 400 });
  expect(f.views[0].show).toHaveBeenCalled();
});
it("keeps completed output and prevents disposal of a live session", async () => {
  const f = fixture(),
    first = await prepared(f),
    src = source();
  first.screen.bind(src);
  first.screen.output("last");
  expect(() => first.screen.dispose()).toThrow();
  first.screen.exited();
  expect(f.views[0].remove).not.toHaveBeenCalled();
  first.screen.dispose();
  first.screen.dispose();
  expect(f.views[0].remove).toHaveBeenCalledOnce();
  await expect(f.transport.prepare(first.ref, vi.fn())).rejects.toThrow();
});
it("hides other surfaces before selecting and hides everything on stale or lost references", async () => {
  const f = fixture(),
    first = await prepared(f);
  first.screen.bind(source());
  f.views[0].crash();
  const next = await prepared(f);
  next.screen.bind(source());
  const bounds = { x: 0, y: 0, width: 400, height: 300 };
  f.transport.show(next.ref, bounds);
  expect(f.views[0].hide).toHaveBeenCalled();
  expect(f.views[1].hide).not.toHaveBeenCalled();
  expect(() => f.transport.show(first.ref, bounds)).toThrow();
  expect(() => f.transport.show(ref(), bounds)).toThrow();
  expect(f.views[1].hide).toHaveBeenCalled();
});
it("rejects oversized source events without forwarding or leaking content", async () => {
  const f = fixture(),
    { screen, lost } = await prepared(f);
  screen.bind(source());
  expect(() => screen.output("SECRET".repeat(20_000))).toThrow(
    /поток|транспорт/i,
  );
  expect(f.views[0].output).not.toHaveBeenCalled();
  expect(lost).toHaveBeenCalledOnce();
});
it("can finish ownership cleanup when native view attachment fails before creating a flow", async () => {
  const f = fixture(),
    { screen, lost } = await prepared(f),
    view = f.views[0];
  view.attach.mockImplementationOnce(() => {
    throw Error("gone before attach");
  });
  expect(() => screen.bind(source())).toThrow();
  expect(lost).toHaveBeenCalledOnce();
  expect(() => screen.exited()).not.toThrow();
  expect(() => screen.dispose()).not.toThrow();
  expect(view.remove).not.toHaveBeenCalled();
});
it("drains an already lost stream only for confirmed HUP and restores pause if stopping fails", async () => {
  const f = fixture(),
    { screen, ref: r } = await prepared(f),
    src = source(),
    view = f.views[0];
  screen.bind(src);
  screen.drainAfterHangup(); // Healthy output still follows normal acknowledgement/backpressure.
  expect(src.resume).not.toHaveBeenCalled();
  screen.fail();
  const retained = view.status(r).pendingBytes;
  screen.drainAfterHangup();
  expect(src.resume).toHaveBeenCalledOnce();
  for (let i = 0; i < 32; i++) screen.output("x".repeat(64 * 1024));
  expect(view.status(r).pendingBytes).toBe(retained);
  src.pause.mockClear();
  screen.finishClose();
  expect(src.pause).toHaveBeenCalledOnce();
  screen.output("bounded-again");
  expect(view.status(r).pendingBytes).toBe(
    retained + Buffer.byteLength("bounded-again"),
  );
  expect(() => screen.assertReady()).toThrow();
});

it("keeps the selected native view alive and visible across geometry updates", async () => {
  const f = fixture(),
    first = await prepared(f);
  first.screen.bind(source());
  const bounds = { x: 0, y: 0, width: 500, height: 400 };
  f.transport.show(first.ref, bounds);
  f.views[0].hide.mockClear();
  f.transport.show(first.ref, { ...bounds, width: 600 });
  expect(f.views[0].hide).not.toHaveBeenCalled();
});
