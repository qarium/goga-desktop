import { expect, it, vi } from "vitest";
import { createTerminalControlAPI } from "../src/main/terminal-control-preload";
it("connects once per preload document, wraps every request, and strips Electron events", async () => {
  const documentId = crypto.randomUUID();
  let listener: Function = () => {};
  const off = vi.fn(),
    send = vi.fn(async (channel: string) =>
      channel === "goga:terminal-connect" ? documentId : { ok: true },
    );
  const api = createTerminalControlAPI(send, (_channel, cb) => {
    listener = cb;
    return off;
  });
  const changed = vi.fn(),
    unsubscribe = api.onChanged(changed);
  await Promise.all([
    api.request({ kind: "read", scope: "p" }),
    api.request({ kind: "read", scope: "q" }),
  ]);
  expect(
    send.mock.calls.filter(([name]) => name === "goga:terminal-connect"),
  ).toHaveLength(1);
  expect(send).toHaveBeenCalledWith("goga:terminal-request", {
    documentId,
    request: { kind: "read", scope: "p" },
  });
  listener({ documentId: crypto.randomUUID() });
  expect(changed).not.toHaveBeenCalled();
  listener({ documentId });
  expect(changed).toHaveBeenCalledExactlyOnceWith();
  unsubscribe();
  expect(off).toHaveBeenCalledOnce();
  expect(Object.keys(api).sort()).toEqual(["onChanged", "request"]);
});
it("never reconnects an invalidated old document to renew its authority automatically", async () => {
  const send = vi.fn(async (channel: string) => {
    if (channel === "goga:terminal-connect") return crypto.randomUUID();
    throw Error("old document");
  });
  const api = createTerminalControlAPI(send, () => () => {});
  await expect(api.request({ kind: "read", scope: "p" })).rejects.toThrow(
    "old document",
  );
  await expect(api.request({ kind: "read", scope: "p" })).rejects.toThrow(
    "old document",
  );
  expect(
    send.mock.calls.filter(([name]) => name === "goga:terminal-connect"),
  ).toHaveLength(1);
});
it("validates selection invalidation scope and preserves the document boundary", async () => {
  const documentId = crypto.randomUUID();
  let emit!: Function;
  const api = createTerminalControlAPI(
    async () => documentId,
    (_, listener) => {
      emit = listener;
      return () => {};
    },
  );
  const changed = vi.fn();
  api.onChanged(changed);
  await api.request({ kind: "read", scope: "p" });
  emit({ documentId, selectionScope: "p" });
  expect(changed).toHaveBeenCalledExactlyOnceWith({ selectionScope: "p" });
  changed.mockClear();
  emit({ documentId, selectionScope: { arbitrary: true } });
  emit({ documentId: crypto.randomUUID(), selectionScope: "p" });
  emit({ documentId, selectionScope: "p", extra: true });
  expect(changed).not.toHaveBeenCalled();
});
