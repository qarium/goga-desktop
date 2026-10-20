// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ProjectSettings } from "../src/renderer/ProjectSettings";
import { ProjectFlatDocuments } from "../src/renderer/ProjectFlatDocuments";
import {
  createSettingsDocuments,
  documentKey,
} from "../src/renderer/settings-documents";
const project = { id: "p", name: "Fixture", path: "/fixture/p" };
const source = (name = "shared", projectId = "p") => ({
  scope: "project" as const,
  projectId,
  target: { kind: "profile" as const, name },
});
let api: any;
let store: ReturnType<typeof createSettingsDocuments>;
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  store = createSettingsDocuments();
  api = {
    readProjectSettings: vi.fn(async () => ({
      value: { executable: "goga", profile: "shared", env: [] },
      version: "s1",
      profiles: [{ name: "shared", source: "home" }],
    })),
    saveProjectSettings: vi.fn(),
    listProjectProfiles: vi.fn(async () => []),
    readProjectDocument: vi.fn(async (_id: string, t: any) => ({
      text: "broken: [",
      exists: true,
      version: "a".repeat(64),
      relativePath: ".goga/profiles/" + t.name + ".yml",
    })),
    saveProjectDocument: vi.fn(async (_id: string, t: any, text: string) => ({
      text,
      exists: true,
      version: "b".repeat(64),
      relativePath: ".goga/profiles/" + t.name + ".yml",
    })),
    prepareDocumentDeletion: vi.fn(async () => ({
      token: "ticket",
      name: "shared",
      relativePath: ".goga/profiles/shared.yml",
      profileFallback: true,
    })),
    deleteDocument: vi.fn(async () => ({ status: "trashed" })),
  };
  window.goga = api;
});
afterEach(cleanup);
function mountSettings() {
  return render(
    <ProjectSettings
      project={project}
      documents={store}
      guard={{ current: null }}
      onBack={() => {}}
      onBusy={() => {}}
      onSaved={() => {}}
    />,
  );
}
it("uses exact six-tab order and one profile empty screen, then creates a memory-only draft with relative path", async () => {
  const v = mountSettings();
  await screen.findByLabelText("Исполняемый файл");
  expect(
    within(screen.getByRole("navigation", { name: "Разделы настроек проекта" }))
      .getAllByRole("button")
      .map((e) => e.textContent),
  ).toEqual([
    "Запуск",
    "Конфигурация",
    "Рабочие процессы",
    "Конвейеры",
    "Инструменты",
    "Профили",
  ]);
  click("Профили");
  await screen.findByText("В проекте пока нет профилей");
  expect(v.container.querySelectorAll(".empty-file")).toHaveLength(1);
  expect(screen.getByText(/^Проектный профиль имеет приоритет/)).toBeTruthy();
  click("Создать профиль");
  fireEvent.change(screen.getByLabelText("Имя профиля"), {
    target: { value: "new-profile" },
  });
  click("Создать черновик");
  expect(store.get(source("new-profile")).memoryOnly).toBe(true);
  expect(screen.getByText(".goga/profiles/new-profile.yml")).toBeTruthy();
  expect(api.readProjectDocument).not.toHaveBeenCalled();
  expect(api.saveProjectDocument).not.toHaveBeenCalled();
  act(() => store.edit(source("new-profile"), "# exact\r\nvalue: 1\r\n"));
  click("Запуск");
  click("Профили");
  expect(store.get(source("new-profile")).text).toBe("# exact\r\nvalue: 1\r\n");
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await waitFor(() =>
    expect(api.saveProjectDocument).toHaveBeenCalledWith(
      "p",
      { kind: "profile", name: "new-profile" },
      "# exact\r\nvalue: 1\r\n",
      "missing",
    ),
  );
});
it("keys project profile drafts by project, kind and name and removes memory draft without IPC or revision", async () => {
  store.createProjectProfile("p", "same", []);
  store.createProjectProfile("q", "same", []);
  store.createPipeline("p", "same", []);
  store.createProfile("same");
  const sources = [
    source("same"),
    source("same", "q"),
    {
      scope: "project" as const,
      projectId: "p",
      target: { kind: "pipeline" as const, name: "same" },
    },
    { scope: "home" as const, kind: "profile" as const, name: "same" },
  ];
  expect(new Set(sources.map(documentKey)).size).toBe(4);
  sources.forEach((s, i) => store.edit(s, "text " + i));
  await store.prepareDeletion(sources[0]);
  await store.delete(sources[0], store.get(sources[0]).deletion!);
  expect(store.projectProfileState("p").drafts).toEqual([]);
  expect(store.projectProfileState("p").selected).toBe("");
  expect(store.projectRevision("p")).toBe(0);
  expect(api.prepareDocumentDeletion).not.toHaveBeenCalled();
  expect(api.deleteDocument).not.toHaveBeenCalled();
  sources
    .slice(1)
    .forEach((s, i) => expect(store.get(s).text).toBe("text " + (i + 1)));
});
it("shows home fallback warning in deletion dialog, cancel is inert and trash failure preserves raw text", async () => {
  api.listProjectProfiles.mockResolvedValue([
    { name: "shared", path: ".goga/profiles/shared.yml", editable: true },
  ]);
  render(
    <ProjectFlatDocuments kind="profile" project={project} store={store} />,
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Файл .goga/profiles/shared.yml",
    }),
  );
  click("Открыть редактор");
  await waitFor(() => expect(store.get(source()).document).toBeDefined());
  act(() => store.edit(source(), "# retained\nvalue: 2"));
  click("Удалить");
  await screen.findByRole("dialog");
  expect(screen.getByText(/одноимённый.*глобальный/i)).toBeTruthy();
  click("Отмена");
  expect(api.deleteDocument).not.toHaveBeenCalled();
  api.deleteDocument.mockResolvedValue({
    status: "not-trashed",
    message: "Корзина недоступна",
  });
  click("Удалить");
  await screen.findByRole("dialog");
  click("Переместить в корзину");
  await screen.findByText("Корзина недоступна");
  expect(store.get(source()).text).toBe("# retained\nvalue: 2");
  expect(store.projectProfileState("p").selected).toBe("shared");
});
it("refreshes only profile catalog while retaining edited settings and missing default after deletion", async () => {
  mountSettings();
  const exe = await screen.findByLabelText("Исполняемый файл");
  fireEvent.change(exe, { target: { value: "custom-goga" } });
  const timeout = screen.getByLabelText("Тайм-аут запуска конвейера");
  fireEvent.change(timeout, { target: { value: "17" } });
  api.readProjectSettings.mockResolvedValue({
    value: { executable: "external-value", profile: "other", env: [] },
    version: "external-version",
    profiles: [{ name: "shared", source: "project" }],
  });
  await act(async () => {
    store.createProjectProfile("p", "shared", []);
    await store.save(source());
  });
  await screen.findByRole("option", { name: "shared · проектный" });
  expect((exe as HTMLInputElement).value).toBe("custom-goga");
  expect((timeout as HTMLInputElement).value).toBe("17");
  expect(
    (screen.getByLabelText("Профиль по умолчанию") as HTMLSelectElement).value,
  ).toBe("shared");
  expect(api.saveProjectSettings).not.toHaveBeenCalled();
  api.readProjectSettings.mockResolvedValue({
    value: { executable: "goga", profile: "", env: [] },
    version: "s2",
    profiles: [],
  });
  await act(async () => {
    await store.prepareDeletion(source());
    await store.delete(source(), store.get(source()).deletion!);
  });
  await screen.findByRole("option", { name: "shared · не найден" });
  expect(
    (screen.getByLabelText("Профиль по умолчанию") as HTMLSelectElement).value,
  ).toBe("shared");
  expect((exe as HTMLInputElement).value).toBe("custom-goga");
});
it("rejects profile draft names and occupied case aliases without sharing workflow grammar", () => {
  for (const name of ["../x", "tool:name", "é", "a b", "-bad"])
    expect(() => store.createProjectProfile("p", name, [])).toThrow();
  store.createProjectProfile("p", "Shared", []);
  expect(() => store.createProjectProfile("p", "shared", [])).toThrow(
    /существует/,
  );
});
