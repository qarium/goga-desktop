import { it, expect, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
it("accepts only shell main-frame calls; native chooser is the only add-project path", async () => {
  const handlers = new Map<string, Function>();
  const ipc = { handle: (key: string, fn: Function) => handlers.set(key, fn) };
  const service = {
    listProjects: vi.fn(async () => []),
    addProject: vi.fn(),
    discover: vi.fn(async () => ({})),
    runs: () => [],
  };
  registerIPC(
    ipc as any,
    {
      service,
      settings: {},
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
      choose: async () => null,
      select: () => {},
      stop: async () => {},
    } as any,
  );
  const event = {
    sender: { id: 1 },
    senderFrame: { url: "file:///app/index.html", parent: null },
  };
  expect(handlers.has("goga:list-projects")).toBe(true);
  expect(() =>
    handlers.get("goga:list-projects")!({ ...event, sender: { id: 2 } }),
  ).toThrow("IPC");
  expect(() =>
    handlers.get("goga:list-projects")!({
      ...event,
      senderFrame: { url: "file:///app/index.html", parent: {} },
    }),
  ).toThrow("IPC");
  await handlers.get("goga:list-projects")!(event);
  expect(service.listProjects).toHaveBeenCalledOnce();
  expect(handlers.has("goga:add-project")).toBe(false);
  expect(() => handlers.get("goga:discover")!(event, {})).toThrow();
  await handlers.get("goga:choose-project")!(event);
  expect(service.addProject).not.toHaveBeenCalled();
});

it("validates clean as a required launch-only boolean without coercion", async () => {
  const handlers = new Map<string, Function>();
  const service = { launch: vi.fn(), preview: vi.fn() };
  registerIPC(
    { handle: (key: string, fn: Function) => handlers.set(key, fn) } as any,
    {
      service,
      settings: {},
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
      choose: async () => null,
      select: () => {},
      stop: async () => {},
    } as any,
  );
  const event = {
    sender: { id: 1 },
    senderFrame: { url: "file:///app/index.html", parent: null },
  };
  const pipeline = {
    projectId: "p",
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const request = {
    ...pipeline,
    previewToken: "token",
    task: "",
    confirmEmptyTask: false,
    taskVersion: "a".repeat(64),
    expectedBranch: "main",
    confirmBranchSwitch: false,
    topic: { mode: "existing", branch: "main", topic: "main" },
  };
  for (const clean of [undefined, null, "true", "false", 0, 1, {}, []])
    expect(() =>
      handlers.get("goga:launch")!(event, { ...request, clean }),
    ).toThrow();
  expect(service.launch).not.toHaveBeenCalled();
  for (const clean of [false, true]) {
    await handlers.get("goga:launch")!(event, { ...request, clean });
    expect(service.launch).toHaveBeenLastCalledWith({ ...request, clean });
  }
  expect(() =>
    handlers.get("goga:preview")!(event, { ...pipeline, clean: true }),
  ).toThrow();
  expect(service.preview).not.toHaveBeenCalled();
});

it("close-run accepts only known shell/id and delegates authoritative confirmation to host", async () => {
  const handlers = new Map<string, Function>();
  const confirmClose = vi.fn(async () => false);
  const service = {
    closeRun: vi.fn(async (id, confirm) => {
      if (id !== "run") throw Error("Неизвестный запуск");
      return confirm({ id });
    }),
  };
  registerIPC(
    { handle: (key: string, fn: Function) => handlers.set(key, fn) } as any,
    {
      service,
      settings: {},
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
      confirmClose,
    } as any,
  );
  const event = {
    sender: { id: 1 },
    senderFrame: { url: "file:///app/index.html", parent: null },
  };
  expect(handlers.has("goga:close-run")).toBe(true);
  for (const id of ["", {}, null, 7])
    expect(() => handlers.get("goga:close-run")!(event, id)).toThrow();
  expect(() =>
    handlers.get("goga:close-run")!({ ...event, sender: { id: 2 } }, "run"),
  ).toThrow(/IPC/);
  expect(service.closeRun).not.toHaveBeenCalled();
  expect(await handlers.get("goga:close-run")!(event, "run")).toBe(false);
  expect(confirmClose).toHaveBeenCalledTimes(1);
  await expect(
    handlers.get("goga:close-run")!(event, "unknown"),
  ).rejects.toThrow(/Неизвестный/);
  expect(confirmClose).toHaveBeenCalledTimes(1);
});

it("requires noncoerced checkout expectation/switch consent and validates branch reader", async () => {
  const handlers = new Map<string, Function>();
  const service = {
    launch: vi.fn(),
    checkoutBranch: vi.fn(async () => "main"),
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
  const valid = {
    projectId: "p",
    pipeline: "p",
    workflow: "auto",
    profile: "",
    skips: [],
    clean: false,
    previewToken: "t",
    task: "",
    confirmEmptyTask: false,
    taskVersion: "a".repeat(64),
    topic: { mode: "existing", branch: "main", topic: "main" },
    expectedBranch: "main",
    confirmBranchSwitch: false,
  };
  for (const value of [undefined, null, 1, {}])
    expect(() =>
      handlers.get("goga:launch")!(event, { ...valid, expectedBranch: value }),
    ).toThrow();
  for (const value of [undefined, null, "true", 1])
    expect(() =>
      handlers.get("goga:launch")!(event, {
        ...valid,
        confirmBranchSwitch: value,
      }),
    ).toThrow();
  expect(service.launch).not.toHaveBeenCalled();
  await handlers.get("goga:launch")!(event, valid);
  expect(service.launch).toHaveBeenCalledWith(valid);
  expect(await handlers.get("goga:checkout-branch")!(event, "p")).toBe("main");
  expect(() =>
    handlers.get("goga:checkout-branch")!({ ...event, sender: { id: 9 } }, "p"),
  ).toThrow();
  expect(() => handlers.get("goga:checkout-branch")!(event, {})).toThrow();
});

it("exposes narrow task reader and rejects old overwrite and missing conditional task versions", async () => {
  const handlers = new Map<string, Function>();
  const service = {
    readTopicTask: vi.fn(async (r) => ({
      ...r,
      text: "",
      exists: false,
      version: "v",
    })),
    launch: vi.fn(),
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
  const reader = handlers.get("goga:read-topic-task");
  expect(reader).toBeTypeOf("function");
  const selection = { projectId: "p", branch: "main", topic: "main" };
  await reader!(event, selection);
  expect(service.readTopicTask).toHaveBeenCalledWith(selection);
  for (const bad of [
    { ...selection, path: "/tmp/private" },
    { ...selection, topic: "../x" },
    { ...selection, branch: "-evil" },
    { ...selection, projectId: 4 },
  ])
    expect(() => reader!(event, bad)).toThrow();
  expect(() => reader!({ ...event, sender: { id: 2 } }, selection)).toThrow();
  const valid = {
    projectId: "p",
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
    clean: false,
    previewToken: "t",
    task: "",
    taskVersion: "a".repeat(64),
    confirmEmptyTask: false,
    expectedBranch: "main",
    confirmBranchSwitch: false,
    topic: { mode: "existing", branch: "main", topic: "main" },
  };
  for (const bad of [
    { ...valid, taskVersion: undefined },
    { ...valid, confirmEmptyTask: "true" },
    { ...valid, confirmTaskOverwrite: true },
    { ...valid, taskVersion: "bad" },
    { ...valid, topic: { mode: "new", name: "new", baseRef: "main" } },
  ])
    expect(() => handlers.get("goga:launch")!(event, bad)).toThrow();
  expect(service.launch).not.toHaveBeenCalled();
  await handlers.get("goga:launch")!(event, valid);
  await handlers.get("goga:launch")!(event, {
    ...valid,
    taskVersion: undefined,
    topic: { mode: "new", name: "new", baseRef: "main" },
  });
  expect(service.launch).toHaveBeenCalledTimes(2);
});
it("protects project settings IPC and rejects malformed secret-bearing payload without echoing it", async () => {
  const handlers = new Map<string, Function>();
  const service = {
    readProjectSettings: vi.fn(),
    saveProjectSettings: vi.fn(),
  };
  registerIPC(
    { handle: (key: string, fn: Function) => handlers.set(key, fn) } as any,
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
  await handlers.get("goga:read-project-settings")!(event, "p");
  expect(service.readProjectSettings).toHaveBeenCalledWith("p");
  const value = {
    executable: "goga",
    profile: "",
    env: [
      { key: "DEMO", value: "canary not real", secret: true, runtime: false },
    ],
  };
  await handlers.get("goga:save-project-settings")!(
    event,
    "p",
    value,
    "revision",
  );
  expect(service.saveProjectSettings).toHaveBeenCalledWith(
    "p",
    value,
    "revision",
  );
  expect(() =>
    handlers.get("goga:save-project-settings")!(
      event,
      "p",
      { ...value, env: [{ ...value.env[0], runtime: "canary not real" }] },
      "revision",
    ),
  ).toThrow("Некорректные настройки проекта");
  expect(() =>
    handlers.get("goga:read-project-settings")!(
      { ...event, sender: { id: 2 } },
      "p",
    ),
  ).toThrow("IPC");
});

it("defaults absent project environment flags to false at the IPC boundary", async () => {
  const handlers = new Map<string, Function>();
  const service = { saveProjectSettings: vi.fn() };
  registerIPC(
    { handle: (k: string, f: Function) => handlers.set(k, f) } as any,
    {
      service,
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
    } as any,
  );
  await handlers.get("goga:save-project-settings")!(
    {
      sender: { id: 1 },
      senderFrame: { url: "file:///app/index.html", parent: null },
    },
    "p",
    { executable: "goga", profile: "", env: [{ key: "DEMO", value: "fake" }] },
    "revision",
  );
  expect(service.saveProjectSettings).toHaveBeenCalledWith(
    "p",
    {
      executable: "goga",
      profile: "",
      env: [{ key: "DEMO", value: "fake", runtime: false, secret: false }],
    },
    "revision",
  );
});

it("validates update as an optional launch-only boolean without coercion", async () => {
  const handlers = new Map<string, Function>();
  const service = { launch: vi.fn(), preview: vi.fn(), discover: vi.fn() };
  registerIPC(
    { handle: (key: string, fn: Function) => handlers.set(key, fn) } as any,
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
  const pipeline = {
    projectId: "p",
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const request = {
    ...pipeline,
    clean: false,
    previewToken: "token",
    task: "",
    confirmEmptyTask: false,
    taskVersion: "a".repeat(64),
    expectedBranch: "main",
    confirmBranchSwitch: false,
    topic: { mode: "existing", branch: "main", topic: "main" },
  };
  for (const update of [null, "true", "false", 0, 1, {}, []])
    expect(() =>
      handlers.get("goga:launch")!(event, { ...request, update }),
    ).toThrow();
  expect(service.launch).not.toHaveBeenCalled();
  for (const extra of [
    {},
    { update: undefined },
    { update: false },
    { update: true },
  ]) {
    await handlers.get("goga:launch")!(event, { ...request, ...extra });
    expect(service.launch).toHaveBeenLastCalledWith({ ...request, ...extra });
  }
  for (const update of [false, true]) {
    expect(() =>
      handlers.get("goga:preview")!(event, { ...pipeline, update }),
    ).toThrow();
    expect(() =>
      handlers.get("goga:discover")!(event, { projectId: "p", update }),
    ).toThrow();
  }
  expect(service.preview).not.toHaveBeenCalled();
  expect(service.discover).not.toHaveBeenCalled();
  await handlers.get("goga:preview")!(event, pipeline);
  await handlers.get("goga:discover")!(event, "p");
  expect(service.preview).toHaveBeenCalledWith(pipeline);
  expect(service.discover).toHaveBeenCalledWith("p");
});

it("validates finite integer startup minutes end-to-end through project-settings IPC without coercion", async () => {
  const handlers = new Map<string, Function>(),
    service = { saveProjectSettings: vi.fn() };
  registerIPC(
    { handle: (name: string, fn: Function) => handlers.set(name, fn) } as any,
    {
      service,
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
    } as any,
  );
  const event = {
      sender: { id: 1 },
      senderFrame: { url: "file:///app/index.html", parent: null },
    },
    base = { executable: "goga", profile: "", env: [] };
  const save = (value: any) =>
    handlers.get("goga:save-project-settings")!(event, "p", value, "v");
  for (const minutes of [1, 10, 120]) {
    await save({ ...base, startupTimeoutMinutes: minutes });
    expect(service.saveProjectSettings).toHaveBeenLastCalledWith(
      "p",
      { ...base, startupTimeoutMinutes: minutes },
      "v",
    );
  }
  await save(base);
  expect(service.saveProjectSettings).toHaveBeenLastCalledWith("p", base, "v");
  service.saveProjectSettings.mockClear();
  for (const invalid of [
    null,
    "10",
    0,
    -1,
    0.5,
    1.5,
    121,
    NaN,
    Infinity,
    -Infinity,
    true,
    {},
    [],
  ])
    expect(() => save({ ...base, startupTimeoutMinutes: invalid })).toThrow(
      /настройки/,
    );
  expect(service.saveProjectSettings).not.toHaveBeenCalled();
});
