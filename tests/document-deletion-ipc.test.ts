import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
function fixture() {
  const handlers = new Map<string, Function>();
  const service = { prepareDocumentDeletion: vi.fn(), deleteDocument: vi.fn() };
  registerIPC(
    { handle: (key: string, fn: Function) => handlers.set(key, fn) } as any,
    {
      service,
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
    } as any,
  );
  return {
    handlers,
    service,
    event: {
      sender: { id: 1 },
      senderFrame: { url: "file:///app/index.html", parent: null },
    },
  };
}
it("exposes only typed prepare and token confirmation to the shell main frame", async () => {
  const f = fixture();
  for (const channel of ["prepare-document-deletion", "delete-document"]) {
    const fn = f.handlers.get("goga:" + channel);
    expect(typeof fn).toBe("function");
    for (const bad of [
      { ...f.event, sender: { id: 2 } },
      {
        ...f.event,
        senderFrame: { url: "https://afm.example/", parent: null },
      },
      { ...f.event, senderFrame: { ...f.event.senderFrame, parent: {} } },
    ])
      expect(() => fn!(bad)).toThrow(/IPC/);
  }
  const prepare = f.handlers.get("goga:prepare-document-deletion")!,
    remove = f.handlers.get("goga:delete-document")!;
  for (const source of [
    {
      scope: "project",
      projectId: "p",
      target: { kind: "workflow", name: "build" },
    },
    {
      scope: "project",
      projectId: "p",
      target: { kind: "pipeline", name: "build" },
    },
    {
      scope: "project",
      projectId: "p",
      target: { kind: "tool", tool: "demo", path: "x.yml" },
    },
    { scope: "home", kind: "profile", name: "dev" },
  ]) {
    await prepare(f.event, source, "a".repeat(64));
    expect(f.service.prepareDocumentDeletion).toHaveBeenLastCalledWith(
      source,
      "a".repeat(64),
    );
  }
  for (const source of [
    { scope: "home", kind: "config" },
    { scope: "home", kind: "profile", name: "../x" },
    { scope: "project", projectId: "p", target: { kind: "config" } },
    { scope: "home", kind: "profile", name: "dev", path: "/tmp/x" },
    {
      scope: "project",
      projectId: "p",
      target: { kind: "tool", tool: "demo", path: "../x.yml" },
    },
  ])
    expect(() => prepare(f.event, source)).toThrow();
  const source = { scope: "home", kind: "profile", name: "dev" };
  for (const version of ["", {}, "missing", "x".repeat(65)])
    expect(() => prepare(f.event, source, version)).toThrow();
  for (const token of ["", {}, "/tmp/file", "x".repeat(257)])
    expect(() => remove(f.event, token)).toThrow();
  await remove(f.event, "123e4567-e89b-42d3-a456-426614174000");
  expect(f.service.deleteDocument).toHaveBeenCalledOnce();
});
