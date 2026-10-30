// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ProjectSettings,
  type ProjectSettingsGuard,
} from "../src/renderer/ProjectSettings";
import {
  createSettingsDocuments,
  documentScopeId,
  type DocumentSource,
} from "../src/renderer/settings-documents";
import type { ScopeRef } from "../src/shared/context";
import type { TopicContextRef } from "../src/shared/worktrees";
import type { ProjectDocumentTarget } from "../src/shared/project-documents";

const project = {
  id: "synthetic-project",
  name: "Synthetic",
  path: "/synthetic/primary",
};
const a: TopicContextRef = {
  projectId: project.id,
  year: "2026",
  topic: "a",
  branch: "topic-a",
  contextId: "clone-a",
  revision: "revision-a",
};
const b: TopicContextRef = {
  ...a,
  topic: "b",
  branch: "topic-b",
  contextId: "clone-b",
  revision: "revision-b",
};
const label = (scope: ScopeRef) =>
  typeof scope === "string" ? "primary" : scope.topic;
const settings = (scope: ScopeRef, version = "registry-v1") => ({
  value: { executable: "shared-goga", profile: "", env: [] },
  version,
  profiles: [{ name: label(scope), source: "project" as const }],
});
let api: any;
let store: ReturnType<typeof createSettingsDocuments>;
let guard: { current: ProjectSettingsGuard | null };
const onSaved = vi.fn();
function panel(owner?: TopicContextRef) {
  return (
    <ProjectSettings
      key={documentScopeId(owner ?? project.id)}
      project={project}
      owner={owner}
      documents={store}
      guard={guard}
      onBack={() => {}}
      onBusy={() => {}}
      onSaved={onSaved}
    />
  );
}
async function ready() {
  return (await screen.findByRole("textbox", {
    name: "Исполняемый файл",
  })) as HTMLInputElement;
}
function edit(value: string) {
  fireEvent.change(screen.getByLabelText("Исполняемый файл"), {
    target: { value },
  });
}
function source(
  owner: TopicContextRef | undefined,
  target: ProjectDocumentTarget,
): DocumentSource {
  return {
    scope: "project",
    projectId: project.id,
    ...(owner ? { context: owner } : {}),
    target,
  };
}
beforeEach(() => {
  store = createSettingsDocuments();
  guard = { current: null };
  onSaved.mockClear();
  api = {
    readProjectSettings: vi.fn(async (scope: ScopeRef) => settings(scope)),
    saveProjectSettings: vi.fn(async (scope: ScopeRef, value: any) => ({
      ...settings(scope, "registry-v2"),
      value,
    })),
    listProjectWorkflows: vi.fn(async () => [
      { name: "same", path: ".goga/workflows/same.yml", editable: true },
    ]),
    listProjectPipelines: vi.fn(async () => [
      { name: "same", path: ".goga/pipelines/same.yml", editable: true },
    ]),
    listProjectProfiles: vi.fn(async () => [
      { name: "same", path: ".goga/profiles/same.yml", editable: true },
    ]),
    listProjectTools: vi.fn(async () => [
      {
        name: "same",
        entries: [{ kind: "file", path: "same.yml", editable: true }],
      },
    ]),
    readProjectDocument: vi.fn(async (scope: ScopeRef) => ({
      text: `owner: ${label(scope)}\n`,
      exists: true,
      version: `file-${label(scope)}`,
    })),
    saveProjectDocument: vi.fn(
      async (_scope: ScopeRef, _target: any, text: string) => ({
        text,
        exists: true,
        version: "file-saved",
      }),
    ),
  };
  window.goga = api;
});
afterEach(cleanup);

it.each([a, b, undefined])(
  "reads and saves registry settings with exact owner %j, without writing on view",
  async (owner) => {
    render(panel(owner));
    await ready();
    expect(api.readProjectSettings).toHaveBeenCalledWith(owner ?? project.id);
    expect(
      await screen.findByRole("option", {
        name: `${label(owner ?? project.id)} · проектный`,
      }),
    ).toBeTruthy();
    expect(api.saveProjectSettings).not.toHaveBeenCalled();
    edit("changed-goga");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(api.saveProjectSettings).toHaveBeenCalledWith(
        owner ?? project.id,
        { executable: "changed-goga", profile: "", env: [] },
        "registry-v1",
      ),
    );
  },
);

it("restores separate unsaved registry drafts across A/B/primary remounts and retains stale version for conflict checks", async () => {
  const view = render(panel(a));
  await ready();
  edit("draft-a");
  fireEvent.change(screen.getByLabelText("Тайм-аут запуска конвейера"), {
    target: { value: "37" },
  });
  view.rerender(panel(b));
  await ready();
  edit("draft-b");
  view.rerender(panel());
  await ready();
  edit("draft-primary");
  api.readProjectSettings.mockImplementation(async (scope: ScopeRef) =>
    settings(scope, "registry-v9"),
  );
  view.rerender(panel(a));
  expect((await ready()).value).toBe("draft-a");
  expect(
    (screen.getByLabelText("Тайм-аут запуска конвейера") as HTMLInputElement)
      .value,
  ).toBe("37");
  api.saveProjectSettings.mockRejectedValueOnce(
    Error("Registry version conflict"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await screen.findByText("Registry version conflict");
  expect(api.saveProjectSettings).toHaveBeenLastCalledWith(
    a,
    expect.objectContaining({
      executable: "draft-a",
      startupTimeoutMinutes: 37,
    }),
    "registry-v1",
  );
  expect((await ready()).value).toBe("draft-a");
  view.rerender(panel(b));
  expect((await ready()).value).toBe("draft-b");
  view.rerender(panel());
  expect((await ready()).value).toBe("draft-primary");
});

const cases: [string, ProjectDocumentTarget, string | null][] = [
  ["Конфигурация", { kind: "config" }, null],
  [
    "Рабочие процессы",
    { kind: "workflow", name: "same" },
    "listProjectWorkflows",
  ],
  ["Конвейеры", { kind: "pipeline", name: "same" }, "listProjectPipelines"],
  ["Профили", { kind: "profile", name: "same" }, "listProjectProfiles"],
  [
    "Инструменты",
    { kind: "tool", tool: "same", path: "same.yml" },
    "listProjectTools",
  ],
];
it.each(cases)(
  "routes %s catalog/read/save to A/B/primary and retains independent document drafts",
  async (tab, target, method) => {
    const view = render(panel(a));
    for (const owner of [a, b, undefined]) {
      view.rerender(panel(owner));
      await ready();
      fireEvent.click(screen.getByRole("button", { name: tab }));
      if (method) {
        await waitFor(() =>
          expect(api[method]).toHaveBeenCalledWith(owner ?? project.id),
        );
        const path =
          target.kind === "tool"
            ? "same.yml"
            : `.goga/${target.kind}s/same.yml`;
        fireEvent.click(
          await screen.findByRole("button", { name: `Файл ${path}` }),
        );
      }
      expect(api.saveProjectDocument).not.toHaveBeenCalled();
      fireEvent.click(
        await screen.findByRole("button", { name: "Открыть редактор" }),
      );
      await waitFor(() =>
        expect(api.readProjectDocument).toHaveBeenCalledWith(
          owner ?? project.id,
          target,
        ),
      );
      await waitFor(() =>
        expect(store.get(source(owner, target)).document).toBeTruthy(),
      );
      act(() =>
        store.edit(
          source(owner, target),
          `draft: ${label(owner ?? project.id)}\n`,
        ),
      );
    }
    for (const owner of [a, b, undefined]) {
      const captured = source(owner, target);
      expect(store.get(captured).text).toBe(
        `draft: ${label(owner ?? project.id)}\n`,
      );
      await act(async () => {
        await store.save(captured);
      });
      expect(api.saveProjectDocument).toHaveBeenLastCalledWith(
        owner ?? project.id,
        target,
        `draft: ${label(owner ?? project.id)}\n`,
        `file-${label(owner ?? project.id)}`,
      );
      expect(store.projectRevision(owner ?? project.id)).toBe(1);
    }
  },
);

it("ignores late read from A after switching to B, and rejects a broken clone without primary fallback", async () => {
  let resolve!: (value: any) => void;
  api.readProjectSettings.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(panel(a));
  view.rerender(panel(b));
  await ready();
  await act(async () =>
    resolve({
      ...settings(a),
      value: { ...settings(a).value, executable: "late-a" },
    }),
  );
  expect((await ready()).value).toBe("shared-goga");
  expect(screen.queryByRole("option", { name: "a · проектный" })).toBeNull();
  api.readProjectSettings.mockRejectedValueOnce(Error("clone unavailable"));
  view.rerender(panel({ ...a, revision: "unavailable" }));
  await screen.findByRole("button", { name: "Повторить загрузку" });
  expect(
    api.readProjectSettings.mock.calls.every(
      ([scope]: any[]) => typeof scope !== "string",
    ),
  ).toBe(true);
  expect(api.saveProjectSettings).not.toHaveBeenCalled();
});

it("settles a late save only in captured A draft, keeping B and its guard untouched", async () => {
  let resolve!: (value: any) => void;
  api.saveProjectSettings.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(panel(a));
  await ready();
  edit("saved-a");
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  view.rerender(panel(b));
  await ready();
  edit("draft-b");
  await act(async () =>
    resolve({
      ...settings(a, "registry-v2"),
      value: { ...settings(a).value, executable: "saved-a" },
    }),
  );
  expect((await ready()).value).toBe("draft-b");
  expect(guard.current?.dirty).toBe(true);
  expect(onSaved).not.toHaveBeenCalled();
  api.readProjectSettings.mockImplementation(async (scope: ScopeRef) => ({
    ...settings(scope, "registry-v2"),
    value: { ...settings(scope).value, executable: "saved-a" },
  }));
  view.rerender(panel(a));
  expect((await ready()).value).toBe("saved-a");
  expect(guard.current?.dirty).toBe(false);
  expect(api.saveProjectSettings).toHaveBeenCalledWith(
    a,
    expect.objectContaining({ executable: "saved-a" }),
    "registry-v1",
  );
});

it("preserves registry draft and base version when its scoped document catalog refreshes", async () => {
  render(panel(a));
  await ready();
  edit("dirty-a");
  api.readProjectSettings.mockResolvedValue({
    ...settings(a, "registry-v7"),
    profiles: [{ name: "new-a-profile", source: "project" }],
  });
  const file = source(a, { kind: "profile", name: "new" });
  await act(async () => {
    await store.open(file);
    store.edit(file, "profile: a\n");
    await store.save(file);
  });
  await screen.findByRole("option", { name: "new-a-profile · проектный" });
  expect((await ready()).value).toBe("dirty-a");
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() =>
    expect(api.saveProjectSettings).toHaveBeenCalledWith(
      a,
      expect.objectContaining({ executable: "dirty-a" }),
      "registry-v1",
    ),
  );
  expect(
    api.readProjectSettings.mock.calls.every(
      ([scope]: any[]) => JSON.stringify(scope) === JSON.stringify(a),
    ),
  ).toBe(true);
});

it("keeps an in-flight registry save busy and undiscardable when its owner remounts", async () => {
  let resolve!: (value: any) => void;
  api.saveProjectSettings.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(panel(a));
  await ready();
  edit("saving-a");
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(store.busy()).toBe(true);
  view.rerender(panel(b));
  await ready();
  view.rerender(panel(a));
  await ready();
  expect(guard.current?.busy).toBe(true);
  act(() => guard.current?.discard());
  expect((await ready()).value).toBe("saving-a");
  await act(async () =>
    resolve({
      ...settings(a, "registry-v2"),
      value: { ...settings(a).value, executable: "saving-a" },
    }),
  );
  expect(store.busy()).toBe(false);
  expect(guard.current?.dirty).toBe(false);
});

it("does not replace a just-saved registry value with an older remount read", async () => {
  let saveResolve!: (value: any) => void;
  let readResolve!: (value: any) => void;
  api.saveProjectSettings.mockImplementationOnce(
    () =>
      new Promise((r) => {
        saveResolve = r;
      }),
  );
  const view = render(panel(a));
  await ready();
  edit("saved-a");
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  view.rerender(panel(b));
  await ready();
  api.readProjectSettings.mockImplementationOnce(
    () =>
      new Promise((r) => {
        readResolve = r;
      }),
  );
  view.rerender(panel(a));
  await act(async () =>
    saveResolve({
      ...settings(a, "registry-v2"),
      value: { ...settings(a).value, executable: "saved-a" },
    }),
  );
  await act(async () => readResolve(settings(a, "registry-v1")));
  expect((await ready()).value).toBe("saved-a");
  expect(guard.current?.dirty).toBe(false);
  edit("next-a");
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() =>
    expect(api.saveProjectSettings).toHaveBeenLastCalledWith(
      a,
      expect.objectContaining({ executable: "next-a" }),
      "registry-v2",
    ),
  );
});

it("separates registry and file drafts by all six owner fields including revision", async () => {
  const view = render(panel(a));
  await ready();
  edit("old-revision-draft");
  const file = source(a, { kind: "config" });
  await act(async () => {
    await store.open(file);
    store.edit(file, "old: draft\n");
  });
  const refreshed = { ...a, revision: "revision-new" };
  view.rerender(panel(refreshed));
  expect((await ready()).value).toBe("shared-goga");
  expect(
    store.get(source(refreshed, { kind: "config" })).document,
  ).toBeUndefined();
  expect(api.readProjectSettings).toHaveBeenLastCalledWith(refreshed);
  view.rerender(panel(a));
  expect((await ready()).value).toBe("old-revision-draft");
  expect(store.get(file).text).toBe("old: draft\n");
});

it.each(cases)(
  "captures delayed %s read/save ownership across A/B/primary",
  async (_tab, target) => {
    let readResolve!: (value: any) => void;
    let saveResolve!: (value: any) => void;
    api.readProjectDocument.mockImplementationOnce(
      () =>
        new Promise((r) => {
          readResolve = r;
        }),
    );
    const sa = source(a, target),
      sb = source(b, target),
      sp = source(undefined, target);
    const pendingRead = store.open(sa);
    await store.open(sb);
    await store.open(sp);
    store.edit(sb, "dirty-b");
    store.edit(sp, "dirty-primary");
    readResolve({ text: "loaded-a", exists: true, version: "file-a" });
    await pendingRead;
    expect(store.get(sb).text).toBe("dirty-b");
    expect(store.get(sp).text).toBe("dirty-primary");
    store.edit(sa, "saved-a");
    api.saveProjectDocument.mockImplementationOnce(
      () =>
        new Promise((r) => {
          saveResolve = r;
        }),
    );
    const pendingSave = store.save(sa);
    expect(store.busy()).toBe(true);
    store.discard(sa);
    store.edit(sa, "forbidden-while-saving");
    expect(store.get(sa).text).toBe("saved-a");
    saveResolve({ text: "saved-a", exists: true, version: "file-a2" });
    await pendingSave;
    expect(api.saveProjectDocument).toHaveBeenCalledWith(
      a,
      target,
      "saved-a",
      "file-a",
    );
    expect(store.get(sa).document?.version).toBe("file-a2");
    expect(store.get(sb).text).toBe("dirty-b");
    expect(store.get(sp).text).toBe("dirty-primary");
    expect(store.projectRevision(a)).toBe(1);
    expect(store.projectRevision(b)).toBe(0);
    expect(store.projectRevision(project.id)).toBe(0);
    expect(store.busy()).toBe(false);
  },
);

it("keeps personal profiles explicitly global and clone workflow suggestions scoped", async () => {
  api.readSettings = vi.fn(async () => ({
    text: "personal: true",
    exists: true,
    version: "home-v1",
  }));
  api.saveSettings = vi.fn(async (_kind, _name, text) => ({
    text,
    exists: true,
    version: "home-v2",
  }));
  api.listWorkflowSuggestions = vi.fn(async () => []);
  render(panel(a));
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Рабочие процессы" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Создать рабочий процесс" }),
  );
  await waitFor(() =>
    expect(api.listWorkflowSuggestions).toHaveBeenCalledWith(a),
  );
  const personal: DocumentSource = {
    scope: "home",
    kind: "profile",
    name: "same",
  };
  await act(async () => {
    await store.open(personal);
    store.edit(personal, "personal: changed");
    await store.save(personal);
  });
  expect(api.readSettings).toHaveBeenCalledWith("profile", "same");
  expect(api.saveSettings).toHaveBeenCalledWith(
    "profile",
    "same",
    "personal: changed",
    "home-v1",
  );
  expect(api.saveProjectDocument).not.toHaveBeenCalled();
});

it("retains selected subsection, editor DOM and its draft across project navigation", async () => {
  const { RetainedViews } = await import("../src/renderer/RetainedViews");
  const ui = (key: string) => (
    <RetainedViews activeKey={key}>
      {key === "a" ? panel(a) : panel(b)}
    </RetainedViews>
  );
  const f = render(ui("a"));
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Конфигурация" }));
  const button = await screen.findByRole("button", {
    name: "Открыть редактор",
  });
  const reads = api.readProjectSettings.mock.calls.length;
  f.rerender(ui("b"));
  await ready();
  f.rerender(ui("a"));
  expect(screen.getByRole("button", { name: "Открыть редактор" })).toBe(button);
  expect(api.readProjectSettings.mock.calls).toHaveLength(reads + 1);
  // Returning within Project also preserves the exact subsection view.
  fireEvent.click(screen.getByRole("button", { name: "Запуск" }));
  fireEvent.click(screen.getByRole("button", { name: "Конфигурация" }));
  expect(screen.getByRole("button", { name: "Открыть редактор" })).toBe(button);
});

it("reconciles stale project-wide settings after another scope saved without losing either edit", async () => {
  let current = settings(a);
  api.readProjectSettings.mockImplementation(async (scope: ScopeRef) => ({
    ...structuredClone(current),
    profiles: settings(scope).profiles,
  }));
  api.saveProjectSettings.mockImplementation(
    async (scope: ScopeRef, value: any, version: string) => {
      if (version !== current.version)
        throw Error(
          "Error invoking remote method 'goga:save-project-settings': Error: Настройки изменены извне. Откройте их заново.",
        );
      current = { ...settings(scope, "registry-v3"), value };
      return structuredClone(current);
    },
  );
  const view = render(panel(a));
  await ready();
  edit("my-executable");
  view.rerender(panel(b));
  await ready();
  current = {
    ...settings(b, "registry-v2"),
    value: { ...settings(b).value, startupTimeoutMinutes: 37 },
  } as any;
  view.rerender(panel(a));
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await screen.findByText(
    "Сохранено. Изменения применятся к следующим запускам.",
  );
  expect(current.value).toMatchObject({
    executable: "my-executable",
    startupTimeoutMinutes: 37,
  });
  expect(api.saveProjectSettings).toHaveBeenCalledTimes(2);
  expect(guard.current?.dirty).toBe(false);
});

it.each(["Оставить мои значения", "Использовать актуальные значения"])(
  "offers explicit field conflict resolution: %s",
  async (choice) => {
    let current = settings(a);
    api.readProjectSettings.mockImplementation(async () =>
      structuredClone(current),
    );
    api.saveProjectSettings.mockImplementation(
      async (scope: ScopeRef, value: any, version: string) => {
        if (version !== current.version)
          throw Error(
            "Error invoking remote method 'goga:save-project-settings': Error: Настройки изменены извне. Откройте их заново.",
          );
        current = { ...settings(scope, "registry-v3"), value };
        return structuredClone(current);
      },
    );
    render(panel(a));
    await ready();
    edit("my-private-executable");
    fireEvent.change(screen.getByLabelText("Тайм-аут запуска конвейера"), {
      target: { value: "37" },
    });
    current = {
      ...settings(a, "registry-v2"),
      value: {
        ...settings(a).value,
        executable: "external-private-executable",
      },
    };
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    const resolution = await screen.findByRole("button", { name: choice });
    expect(api.saveProjectSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("Исполняемый файл");
    expect(screen.getByRole("alert").textContent).not.toMatch(
      /private-executable|Error invoking/,
    );
    fireEvent.click(resolution);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText(
      "Сохранено. Изменения применятся к следующим запускам.",
    );
    expect(current.value).toMatchObject({
      executable:
        choice === "Оставить мои значения"
          ? "my-private-executable"
          : "external-private-executable",
      startupTimeoutMinutes: 37,
    });
  },
);

it("merges environment additions/removals and retains explicit runtime flags without leaking values", async () => {
  const { reconcileProjectSettings } =
    await import("../src/renderer/project-settings-save");
  const row = (key: string, value: string, runtime = false) => ({
    key,
    value,
    runtime,
    secret: true,
  });
  const base = {
    ...settings(a).value,
    env: [row("REMOVE", "secret-1"), row("KEEP", "secret-2")],
  };
  const draft = {
    ...base,
    env: [row("KEEP", "secret-2"), row("NEW", "secret-3", true)],
  };
  const latest = { ...base, env: [...base.env, row("OTHER", "secret-4")] };
  const merged = reconcileProjectSettings(base, draft, latest);
  expect(merged.fields).toEqual([]);
  expect(merged.mine.env).toEqual([
    row("KEEP", "secret-2"),
    row("OTHER", "secret-4"),
    row("NEW", "secret-3", true),
  ]);
  const conflict = reconcileProjectSettings(base, draft, {
    ...base,
    env: [row("REMOVE", "secret-changed"), row("KEEP", "secret-2")],
  });
  expect(conflict.fields).toEqual(["Переменная REMOVE"]);
  expect(conflict.mine.env.some((r) => r.key === "REMOVE")).toBe(false);
  expect(conflict.current.env.find((r) => r.key === "REMOVE")?.value).toBe(
    "secret-changed",
  );
});

it("re-reads between CAS races, bounds retry and never retries unrelated save failures", async () => {
  const { saveProjectSettingsReconciled } =
    await import("../src/renderer/project-settings-save");
  const base = settings(a);
  const api = {
    readProjectSettings: vi.fn(async () => ({ ...base, version: "fresh" })),
    saveProjectSettings: vi.fn(async () => {
      throw Error("Настройки изменены извне. Откройте их заново.");
    }),
  };
  await expect(
    saveProjectSettingsReconciled(api, a, base, {
      ...base.value,
      executable: "new",
    }),
  ).rejects.toThrow(/Ваш ввод сохранён/);
  expect(api.saveProjectSettings).toHaveBeenCalledTimes(3);
  expect(api.readProjectSettings).toHaveBeenCalledTimes(3);
  api.saveProjectSettings.mockClear();
  api.readProjectSettings.mockClear();
  api.saveProjectSettings.mockRejectedValue(Error("Storage is read only"));
  await expect(
    saveProjectSettingsReconciled(api, a, base, base.value),
  ).rejects.toThrow("read only");
  expect(api.saveProjectSettings).toHaveBeenCalledTimes(1);
  expect(api.readProjectSettings).not.toHaveBeenCalled();
});
