import { expect, it, vi } from "vitest";
import {
  TerminalScreens,
  type TerminalScreenSurface,
} from "../src/terminal/screens";
import type {
  TerminalGrant,
  TerminalFrame,
} from "../src/shared/terminal-screen";
const grant: TerminalGrant = {
  sessionId: "a",
  generation: "00000000-0000-4000-8000-000000000001",
  capability: "00000000-0000-4000-8000-000000000002",
};
const other = {
  ...grant,
  sessionId: "b",
  capability: "00000000-0000-4000-8000-000000000003",
};
function fixture() {
  const surfaces: (TerminalScreenSurface & {
    writes: { text: string; done: () => void }[];
    data: (text: string) => void;
  })[] = [];
  const ack = vi.fn(),
    input = vi.fn(),
    resize = vi.fn(),
    fault = vi.fn();
  const create = vi.fn(() => {
    const s = {
      writes: [] as { text: string; done: () => void }[],
      data: (_text: string) => {},
      write(text: string, done: () => void) {
        this.writes.push({ text, done });
      },
      onData(cb: (text: string) => void) {
        this.data = cb;
        return { dispose: vi.fn() };
      },
      visible: vi.fn(),
      inputEnabled: vi.fn(),
      fit: vi.fn(() => ({ cols: 100, rows: 30 })),
      dispose: vi.fn(),
    };
    surfaces.push(s);
    return s;
  });
  const screens = new TerminalScreens({ create, ack, input, resize, fault });
  screens.grant(grant);
  return { screens, surfaces, create, ack, input, resize, fault };
}
function frame(
  g: TerminalGrant,
  sequence: number,
  text = "text",
): TerminalFrame {
  return { ...g, sequence, text };
}
it("keeps exactly one screen across repeated grants, selection and main UI reload/hide", () => {
  const f = fixture();
  f.screens.grant(other);
  f.screens.grant(grant);
  f.screens.select(grant);
  f.screens.select(null);
  f.screens.select(other);
  f.screens.select(grant);
  expect(f.create).toHaveBeenCalledTimes(2);
  expect(f.create.mock.calls[0]).toEqual([grant, { scrollback: 5000 }]);
  expect(f.surfaces[0].dispose).not.toHaveBeenCalled();
  expect(f.surfaces[1].visible).toHaveBeenLastCalledWith(false);
  expect(f.surfaces[0].visible).toHaveBeenLastCalledWith(true);
});
it("acks only after actual write callback, including background screens", () => {
  const f = fixture();
  f.screens.grant(other);
  f.screens.select(other);
  f.screens.receive(frame(grant, 1, "\x1b[31;"));
  f.screens.receive(frame(grant, 2, "1mRED"));
  expect(f.ack).not.toHaveBeenCalled();
  f.surfaces[0].writes[1].done();
  expect(f.ack).not.toHaveBeenCalled();
  f.surfaces[0].writes[0].done();
  expect(f.ack.mock.calls.map((x) => x[0].sequence)).toEqual([1, 2]);
  f.surfaces[0].writes[0].done();
  expect(f.ack).toHaveBeenCalledTimes(2);
});
it("only the owning parser sends replies and input, even while hidden", () => {
  const f = fixture();
  f.screens.grant(other);
  f.screens.select(other);
  f.surfaces[0].data("\x1b[1;1R");
  f.surfaces[1].data("Привет");
  expect(f.input.mock.calls).toEqual([
    [{ ...grant, text: "\x1b[1;1R" }],
    [{ ...other, text: "Привет" }],
  ]);
});
it("does not resize hidden sessions; visible fit is deduplicated and owns the PTY dimensions", () => {
  const f = fixture();
  f.screens.grant(other);
  f.screens.select(grant);
  f.screens.fit();
  expect(f.resize.mock.calls).toEqual([[{ ...grant, cols: 100, rows: 30 }]]);
  expect(f.surfaces[1].fit).not.toHaveBeenCalled();
  f.screens.select(null);
  f.screens.fit();
  expect(f.resize).toHaveBeenCalledTimes(1);
  f.screens.select(other);
  expect(f.resize).toHaveBeenLastCalledWith({ ...other, cols: 100, rows: 30 });
});
it("does not parse duplicates, unknown capabilities or old generations", () => {
  const f = fixture();
  f.screens.receive(frame(grant, 1));
  f.screens.receive(frame(grant, 1));
  f.screens.receive(frame({ ...grant, capability: crypto.randomUUID() }, 2));
  f.screens.receive(frame({ ...grant, generation: crypto.randomUUID() }, 2));
  expect(f.surfaces[0].writes).toHaveLength(1);
  expect(f.fault).not.toHaveBeenCalled();
});
it("a sequence gap makes only its screen read-only instead of parsing corrupted state", () => {
  const f = fixture();
  f.screens.grant(other);
  f.screens.receive(frame(grant, 2));
  f.surfaces[0].data("unsafe");
  expect(f.surfaces[0].writes).toHaveLength(0);
  expect(f.input).not.toHaveBeenCalled();
  expect(f.surfaces[0].inputEnabled).toHaveBeenLastCalledWith(false);
  expect(f.fault).toHaveBeenCalledWith(grant);
  f.screens.receive(frame(other, 1));
  expect(f.surfaces[1].writes).toHaveLength(1);
});
it("loss revokes pending callbacks/input and never creates another parser for an existing stream", () => {
  const f = fixture();
  f.screens.receive(frame(grant, 1));
  f.screens.rendererLost();
  f.surfaces[0].writes[0].done();
  f.surfaces[0].data("unsafe");
  f.screens.receive(frame(grant, 2));
  expect(f.ack).not.toHaveBeenCalled();
  expect(f.input).not.toHaveBeenCalled();
  expect(() => f.screens.grant(grant)).toThrow();
  expect(f.create).toHaveBeenCalledTimes(1);
});
it("exited screens retain last output and drain pending writes, but cannot type or resize the PTY", () => {
  const f = fixture();
  f.screens.receive(frame(grant, 1));
  f.screens.exited(grant);
  f.surfaces[0].writes[0].done();
  f.surfaces[0].data("unsafe");
  f.screens.select(grant);
  expect(f.ack).toHaveBeenCalledTimes(1);
  expect(f.input).not.toHaveBeenCalled();
  expect(f.resize).not.toHaveBeenCalled();
  expect(f.surfaces[0].dispose).not.toHaveBeenCalled();
});
it("explicit retirement and new generation cannot accept late old parser callbacks", () => {
  const f = fixture();
  f.screens.receive(frame(grant, 1));
  f.screens.remove(grant);
  const next = {
    ...grant,
    generation: crypto.randomUUID(),
    capability: crypto.randomUUID(),
  };
  f.screens.grant(next);
  f.surfaces[0].writes[0].done();
  f.surfaces[0].data("old");
  f.screens.receive(frame(grant, 2));
  f.screens.receive(frame(next, 1));
  expect(f.ack).not.toHaveBeenCalled();
  expect(f.input).not.toHaveBeenCalled();
  expect(f.surfaces[1].writes).toHaveLength(1);
  expect(f.surfaces[0].dispose).toHaveBeenCalledOnce();
  expect(() => f.screens.grant(grant)).toThrow();
});
it("cannot silently replace a live screen or its capability", () => {
  const f = fixture();
  expect(() =>
    f.screens.grant({ ...grant, capability: crypto.randomUUID() }),
  ).toThrow();
  expect(() =>
    f.screens.grant({ ...grant, generation: crypto.randomUUID() }),
  ).toThrow();
  expect(f.create).toHaveBeenCalledTimes(1);
});
it("parser failure leaves read-only state, no acknowledgement or repeat parser", () => {
  const f = fixture();
  f.surfaces[0].write = () => {
    throw Error("parser");
  };
  f.screens.receive(frame(grant, 1));
  f.screens.receive(frame(grant, 2));
  expect(f.fault).toHaveBeenCalledOnce();
  expect(f.ack).not.toHaveBeenCalled();
  f.surfaces[0].data("unsafe");
  expect(f.input).not.toHaveBeenCalled();
});
it("bounds unparsed renderer payload and rejects oversized wire frames", () => {
  const f = fixture();
  for (let i = 1; i <= 17; i++)
    f.screens.receive(frame(grant, i, "x".repeat(16384)));
  expect(f.surfaces[0].writes).toHaveLength(16);
  expect(f.fault).toHaveBeenCalledOnce();
  const g = fixture();
  g.screens.receive(frame(grant, 1, "x".repeat(16385)));
  expect(g.surfaces[0].writes).toHaveLength(0);
});
it("rejects oversized keyboard payload and invalid fit measurements", () => {
  const f = fixture();
  f.surfaces[0].data("🙂".repeat(270000));
  expect(f.input).not.toHaveBeenCalled();
  f.surfaces[0].fit = () => ({ cols: 0, rows: NaN });
  f.screens.select(grant);
  expect(f.resize).not.toHaveBeenCalled();
});

it("splits approved large paste output without splitting Unicode or losing bracketed-paste boundaries", () => {
  const f = fixture();
  const text = "\x1b[200~" + "😀ж".repeat(40000) + "\rline\x1b[201~";
  f.surfaces[0].data(text);
  expect(f.input.mock.calls.length).toBeGreaterThan(1);
  expect(f.input.mock.calls.map(([v]) => v.text).join("")).toBe(text);
  for (const [value] of f.input.mock.calls) {
    expect(value).toMatchObject(grant);
    expect(Buffer.byteLength(value.text)).toBeLessThanOrEqual(65536);
    expect(value.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  }
  expect(f.fault).not.toHaveBeenCalled();
});
it("stops a chunked paste if its owning screen exits during delivery; never sends remaining bytes", () => {
  const f = fixture();
  f.input.mockImplementationOnce(() => f.screens.exited(grant));
  f.surfaces[0].data("x".repeat(140000));
  expect(f.input).toHaveBeenCalledTimes(1);
});
