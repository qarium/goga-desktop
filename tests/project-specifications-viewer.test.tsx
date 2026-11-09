// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ProjectSpecifications } from "../src/renderer/ProjectSpecifications";
import {
  specificationAPI,
  specificationProject as project,
} from "./helpers/project-specifications";
import { installHistoryWorker } from "./helpers/history-worker";
import { readTimeoutMessage } from "../src/shared/read-deadlines";
let api: ReturnType<typeof specificationAPI>;
beforeEach(() => {
  installHistoryWorker();
  api = specificationAPI();
  window.goga = api as any;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const open = () =>
  render(
    <main className="main-area">
      <ProjectSpecifications project={project} />
    </main>,
  );
it("opens root README read-only using the History reader", async () => {
  open();
  await screen.findByRole("heading", { name: "Спецификации" });
  expect(screen.getByText(".goga/usages/README.md")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Развернуть документ" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /Сохранить|Удалить/ }),
  ).toBeNull();
  expect(api.readProjectSpecification).toHaveBeenCalledWith("p", "README.md");
});
it("searches full paths, clears via X and reveals a chosen deep result", async () => {
  open();
  await screen.findByRole("heading", { name: "Спецификации" });
  const search = screen.getByRole("textbox", { name: "Найти спецификацию" });
  fireEvent.change(search, { target: { value: "usage" } });
  const results = screen.getByRole("list", { name: "Результаты поиска" });
  expect(within(results).getAllByRole("listitem")).toHaveLength(2);
  expect(within(results).getByText("api/usage.md")).toBeTruthy();
  fireEvent.click(within(results).getByText("api/usage.md"));
  await screen.findByRole("heading", { name: "API usage" });
  expect((search as HTMLInputElement).value).toBe("");
  expect(
    screen
      .getByRole("treeitem", { name: "Файл api/usage.md" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.change(search, { target: { value: "absent" } });
  expect(screen.getByText("Ничего не найдено")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Очистить поиск" }));
  expect((search as HTMLInputElement).value).toBe("");
});
it("follows internal Markdown links and keeps the current reader on missing links", async () => {
  open();
  await screen.findByRole("heading", { name: "Спецификации" });
  fireEvent.click(screen.getByRole("button", { name: "Нет файла" }));
  expect(screen.getByRole("alert").textContent).toContain("missing.md");
  expect(screen.queryByRole("button", { name: "Снаружи" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Вложенный документ" }));
  await screen.findByRole("heading", { name: "API usage" });
  fireEvent.click(screen.getByRole("button", { name: "Назад" }));
  await screen.findByRole("heading", { name: "Спецификации" });
});
it("distinguishes missing folder, no Markdown, no initial README and empty file", async () => {
  api.listProjectSpecifications.mockResolvedValueOnce({
    exists: false,
    paths: [],
    skippedUnsupported: 0,
  });
  const f = open();
  await screen.findByText("Спецификаций пока нет");
  expect(api.readProjectSpecification).not.toHaveBeenCalled();
  f.unmount();
  api.listProjectSpecifications.mockResolvedValueOnce({
    exists: true,
    paths: [],
    skippedUnsupported: 0,
  });
  const e = open();
  await screen.findByText("Markdown-файлы не найдены");
  e.unmount();
  api.listProjectSpecifications.mockResolvedValueOnce({
    exists: true,
    paths: ["blank.md"],
    skippedUnsupported: 0,
  });
  open();
  await screen.findByText("Выберите Markdown-файл");
  fireEvent.click(screen.getByRole("treeitem", { name: "Файл blank.md" }));
  await screen.findByText("Файл пуст");
});
it("allows retry after a friendly filesystem timeout without Electron wrapper", async () => {
  api.listProjectSpecifications.mockRejectedValueOnce(
    Error(
      `Error invoking remote method 'goga:read-request': Error: ${readTimeoutMessage(30000)}`,
    ),
  );
  open();
  await screen.findByRole("alert");
  expect(
    screen.getByRole("heading", { name: "Не удалось загрузить спецификации" }),
  ).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("30 секунд");
  expect(screen.getByRole("alert").textContent).not.toMatch(
    /remote method|Docker|Черновик/,
  );
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  await screen.findByRole("heading", { name: "Спецификации" });
});
it("does not replace deleted selection on refresh and rereads the selected document", async () => {
  open();
  await screen.findByRole("heading", { name: "Спецификации" });
  api.listProjectSpecifications.mockResolvedValueOnce({
    exists: true,
    paths: ["blank.md"],
    skippedUnsupported: 0,
  });
  api.readProjectSpecification.mockResolvedValueOnce({
    path: "README.md",
    exists: false,
    text: "",
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Обновить спецификации" }),
  );
  await screen.findByText("Файл больше недоступен");
  await waitFor(() =>
    expect(api.readProjectSpecification).toHaveBeenCalledTimes(2),
  );
  expect(api.readProjectSpecification).toHaveBeenLastCalledWith(
    "p",
    "README.md",
  );
});

it("integrates the new tab between Image and History without a YAML draft note", async () => {
  const { ProjectSettings } = await import("../src/renderer/ProjectSettings");
  Object.assign(api, {
    readProjectSettings: vi.fn(async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "v1",
      profiles: [],
    })),
  });
  render(
    <ProjectSettings
      project={project}
      onBack={() => {}}
      onSaved={() => {}}
      guard={{ current: null }}
      onBusy={() => {}}
    />,
  );
  const nav = screen.getByRole("navigation", {
    name: "Разделы настроек проекта",
  });
  const names = within(nav)
    .getAllByRole("button")
    .map((x) => x.textContent);
  expect(
    names.slice(names.indexOf("Образ"), names.indexOf("История") + 1),
  ).toEqual(["Образ", "Спецификации", "История"]);
  fireEvent.click(within(nav).getByRole("button", { name: "Спецификации" }));
  await screen.findByRole("heading", { name: "Спецификации" });
  expect(screen.queryByText(/Черновики настроек и YAML/)).toBeNull();
});

it("starts with every folder collapsed while keeping root files and README available", async () => {
  open();
  await screen.findByRole("heading", { name: "Спецификации" });
  for (const folder of ["api", "other"])
    expect(
      screen
        .getByRole("treeitem", { name: `Папка ${folder}` })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  expect(
    screen.queryByRole("treeitem", { name: "Файл api/usage.md" }),
  ).toBeNull();
  expect(
    screen.queryByRole("treeitem", { name: "Файл other/usage.md" }),
  ).toBeNull();
  expect(
    screen
      .getByRole("treeitem", { name: "Файл README.md" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByRole("treeitem", { name: "Файл blank.md" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Вложенный документ" }));
  await screen.findByRole("heading", { name: "API usage" });
  expect(
    screen
      .getByRole("treeitem", { name: "Папка api" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    screen
      .getByRole("treeitem", { name: "Папка other" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
});
