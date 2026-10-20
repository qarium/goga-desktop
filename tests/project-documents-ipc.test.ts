import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
function fixture() {
  const handlers = new Map<string, Function>();
  const service = {
    listProjectTools: vi.fn(async () => []),
    listProjectWorkflows: vi.fn(async () => []),
    listWorkflowSuggestions: vi.fn(async () => []),
    listProjectPipelines: vi.fn(async () => []),
    listProjectProfiles: vi.fn(async () => []),
    readProjectDocument: vi.fn(async () => ({})),
    saveProjectDocument: vi.fn(async () => ({})),
  };
  registerIPC(
    { handle: (k: string, fn: Function) => handlers.set(k, fn) } as any,
    {
      service,
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
    } as any,
  );
  const event = {
    sender: { id: 1 },
    senderFrame: { url: "file:///app/index.html", parent: null },
  };
  return { service, handlers, event };
}
it("exposes project document channels only to the exact shell main frame", async () => {
  const { service, handlers, event } = fixture();
  for (const name of [
    "list-project-tools",
    "list-project-workflows",
    "list-workflow-suggestions",
    "list-project-pipelines",
    "list-project-profiles",
    "read-project-document",
    "save-project-document",
  ]) {
    expect(handlers.has("goga:" + name)).toBe(true);
    for (const bad of [
      { ...event, sender: { id: 2 } },
      { ...event, senderFrame: { url: "https://afm.example/", parent: null } },
      { ...event, senderFrame: { ...event.senderFrame, parent: {} } },
    ])
      expect(() =>
        handlers.get("goga:" + name)!(
          bad,
          "p",
          { kind: "config" },
          "a: 1",
          "v1",
        ),
      ).toThrow(/IPC/);
  }
  await handlers.get("goga:list-project-tools")!(event, "p");
  expect(service.listProjectTools).toHaveBeenCalledWith("p");
});
it("validates targets before forwarding exact source and full relative path", async () => {
  const { service, handlers, event } = fixture();
  const read = handlers.get("goga:read-project-document")!;
  const save = handlers.get("goga:save-project-document")!;
  const target = {
    kind: "tool",
    tool: "review-kit",
    path: "environments/local/config.yml",
  };
  const text = '# comment\r\nvalue: "🙂"\n';
  await read(event, "p", target);
  await save(event, "p", target, text, "v1");
  expect(service.readProjectDocument).toHaveBeenCalledWith("p", target);
  expect(service.saveProjectDocument).toHaveBeenCalledWith(
    "p",
    target,
    text,
    "v1",
  );
  for (const bad of [
    {},
    { kind: "profile" },
    { kind: "config", path: "../x" },
    { ...target, root: "/tmp" },
    { ...target, tool: "../other" },
    ...[
      "",
      "/etc/passwd",
      "../x.yml",
      "a/../x.yml",
      "a/./x.yml",
      "a//b.yml",
      "a/",
      "a\\b.yml",
      "C:/x.yml",
      "a\0.yml",
    ].map((path) => ({ ...target, path })),
  ]) {
    expect(() => read(event, "p", bad)).toThrow();
    expect(() => save(event, "p", bad, text, "v1")).toThrow();
  }
  expect(service.readProjectDocument).toHaveBeenCalledTimes(1);
  expect(service.saveProjectDocument).toHaveBeenCalledTimes(1);
  for (const badId of ["", 1, null])
    expect(() => read(event, badId, target)).toThrow();
  for (const badText of [
    null,
    {},
    "a".repeat(1024 * 1024 + 1),
    "🙂".repeat(300000),
  ])
    expect(() => save(event, "p", target, badText, "v1")).toThrow();
  expect(() => save(event, "p", target, text, "")).toThrow();
});
it.each([1, 180, 181, 254, 255])(
  "accepts canonical tool names of length %i at the IPC boundary",
  async (length) => {
    const { service, handlers, event } = fixture();
    const target = {
      kind: "tool",
      tool: "a".repeat(length),
      path: "nested/config.yml",
    };
    await handlers.get("goga:read-project-document")!(event, "p", target);
    await handlers.get("goga:save-project-document")!(
      event,
      "p",
      target,
      "{}",
      "v1",
    );
    expect(service.readProjectDocument).toHaveBeenCalledWith("p", target);
    expect(service.saveProjectDocument).toHaveBeenCalledWith(
      "p",
      target,
      "{}",
      "v1",
    );
  },
);
it("enforces shared tool-name and path boundaries without forwarding rejected targets", async () => {
  const { service, handlers, event } = fixture();
  const read = handlers.get("goga:read-project-document")!,
    save = handlers.get("goga:save-project-document")!;
  const target = {
    kind: "tool",
    tool: "review-kit",
    path: "a".repeat(4092) + ".yml",
  };
  await read(event, "p", target);
  await save(event, "p", target, "{}", "v1");
  for (const bad of [
    ...[
      "",
      "a".repeat(256),
      "Tool",
      "a_b",
      "a--b",
      "-a",
      "a-",
      "инструмент",
    ].map((tool) => ({ ...target, tool })),
    ...[
      "a".repeat(4093) + ".yml",
      "C:/x.yml",
      "C:x.yml",
      "a\u0080.yml",
      "a\u0085.yml",
      "a\u009f.yml",
      "a\u007f.yml",
      "/x.yml",
      "a//b.yml",
      "a/../b.yml",
      "a/./b.yml",
      "a\\b.yml",
      "",
    ].map((path) => ({ ...target, path })),
  ]) {
    expect(() => read(event, "p", bad)).toThrow();
    expect(() => save(event, "p", bad, "{}", "v1")).toThrow();
  }
  expect(service.readProjectDocument).toHaveBeenCalledTimes(1);
  expect(service.saveProjectDocument).toHaveBeenCalledTimes(1);
});

it("validates workflow catalog and strict workflow targets before forwarding raw source", async () => {
  const { service, handlers, event } = fixture();
  const list = handlers.get("goga:list-project-workflows");
  expect(typeof list).toBe("function");
  await list!(event, "p");
  expect(service.listProjectWorkflows).toHaveBeenCalledWith("p");
  for (const id of [null, "", 1, "x".repeat(257)])
    expect(() => list!(event, id)).toThrow();
  const read = handlers.get("goga:read-project-document")!;
  const save = handlers.get("goga:save-project-document")!;
  const target = { kind: "workflow", name: "Сборка_β.v2" };
  const text = "\ufeff{% if x %}\r\na: [\r\n{% endif %}\r\n";
  await read(event, "p", target);
  await save(event, "p", target, text, "missing");
  expect(service.readProjectDocument).toHaveBeenCalledWith("p", target);
  expect(service.saveProjectDocument).toHaveBeenCalledWith(
    "p",
    target,
    text,
    "missing",
  );
  for (const bad of [
    { ...target, path: "/tmp/x" },
    { ...target, root: "/tmp" },
    { ...target, tool: "x" },
    ...[
      "",
      "../x",
      "a/b",
      "a\\b",
      "a b",
      "-x",
      "a\u007f",
      "a\u0085",
      "a".repeat(181),
      "é".repeat(126),
    ].map((name) => ({ kind: "workflow", name })),
  ]) {
    expect(() => read(event, "p", bad)).toThrow();
    expect(() => save(event, "p", bad, text, "missing")).toThrow();
  }
  expect(service.readProjectDocument).toHaveBeenCalledTimes(1);
  expect(service.saveProjectDocument).toHaveBeenCalledTimes(1);
});

it("validates pipeline catalog and strict pipeline targets before forwarding raw source", async () => {
  const { service, handlers, event } = fixture();
  const list = handlers.get("goga:list-project-pipelines");
  expect(typeof list).toBe("function");
  await list!(event, "p");
  expect(service.listProjectPipelines).toHaveBeenCalledWith("p");
  for (const id of [null, "", 1, "x".repeat(257)])
    expect(() => list!(event, id)).toThrow();
  const read = handlers.get("goga:read-project-document")!;
  const save = handlers.get("goga:save-project-document")!;
  const target = { kind: "pipeline", name: "tool:Сборка_β.v2" };
  const text = "\ufeff{% if x %}\r\na: [\r\n{% endif %}\r\n";
  await read(event, "p", target);
  await save(event, "p", target, text, "missing");
  expect(service.readProjectDocument).toHaveBeenCalledWith("p", target);
  expect(service.saveProjectDocument).toHaveBeenCalledWith(
    "p",
    target,
    text,
    "missing",
  );
  for (const bad of [
    { ...target, path: "/tmp/x" },
    { ...target, root: "/tmp" },
    { ...target, tool: "x" },
    ...[
      "",
      "../x",
      "a/b",
      "a\\b",
      "a b",
      "-x",
      "a\u007f",
      "a\u0085",
      "a".repeat(181),
      "é".repeat(126),
    ].map((name) => ({ kind: "pipeline", name })),
  ]) {
    expect(() => read(event, "p", bad)).toThrow();
    expect(() => save(event, "p", bad, text, "missing")).toThrow();
  }
  expect(service.readProjectDocument).toHaveBeenCalledTimes(1);
  expect(service.saveProjectDocument).toHaveBeenCalledTimes(1);
});

it("validates suggestion project IDs and forwards only the ID", async () => {
  const { service, handlers, event } = fixture();
  const list = handlers.get("goga:list-workflow-suggestions");
  expect(typeof list).toBe("function");
  for (const invalid of [
    null,
    undefined,
    "",
    1,
    {},
    { projectId: "p" },
    "x".repeat(257),
  ])
    expect(() => list!(event, invalid)).toThrow();
  expect(service.listWorkflowSuggestions).not.toHaveBeenCalled();
  await list!(event, "p", { executable: "attacker", env: { TOKEN: "evil" } });
  expect(service.listWorkflowSuggestions.mock.calls).toEqual([["p"]]);
});

it("validates project profile targets and catalog only through trusted shell", async () => {
  const { service, handlers, event } = fixture();
  const read = handlers.get("goga:read-project-document")!,
    save = handlers.get("goga:save-project-document")!;
  await handlers.get("goga:list-project-profiles")!(event, "p");
  expect(service.listProjectProfiles).toHaveBeenCalledWith("p");
  const target = { kind: "profile", name: "local.v2" };
  await read(event, "p", target);
  await save(event, "p", target, "{}", "missing");
  expect(service.saveProjectDocument).toHaveBeenCalledWith(
    "p",
    target,
    "{}",
    "missing",
  );
  for (const name of ["../x", "x/y", "é", "tool:x", "-bad", "a".repeat(181)])
    expect(() =>
      save(event, "p", { kind: "profile", name }, "{}", "missing"),
    ).toThrow();
  for (const bad of [
    { ...target, path: "/tmp/x" },
    { ...target, root: "/tmp" },
  ])
    expect(() => read(event, "p", bad)).toThrow();
});
