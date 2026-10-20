// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ProjectDocuments } from "../src/renderer/ProjectDocuments";
import { ProjectSettings } from "../src/renderer/ProjectSettings";
import { RunOutput } from "../src/renderer/RunOutput";
import { createSettingsDocuments } from "../src/renderer/settings-documents";

const project = {
  id: "p",
  name: "Copy fixture",
  path: "/private/fixture/project",
};
beforeEach(() => {
  window.goga = {
    readProjectSettings: vi.fn(async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "v1",
      profiles: [],
    })),
    listProjectTools: vi.fn(async () => [
      { name: "fixture-tool", entries: [] },
    ]),
  } as any;
});
afterEach(cleanup);

it("shows relative config label without changing the document source", async () => {
  render(
    <ProjectDocuments
      project={project}
      tab="config"
      store={createSettingsDocuments()}
    />,
  );
  expect(await screen.findByText(".goga/config.yml")).toBeTruthy();
  expect(screen.queryByText(project.path + "/.goga/config.yml")).toBeNull();
});
it("keeps only useful selected-tool description", async () => {
  render(
    <ProjectDocuments
      project={project}
      tab="tools"
      store={createSettingsDocuments()}
    />,
  );
  expect(
    await screen.findByText(
      "Файлы выбранного инструмента в проекте Copy fixture.",
    ),
  ).toBeTruthy();
  expect(document.body.textContent).not.toContain("общей схемы нет");
});
it("uses exact short environment hint without examples", async () => {
  render(
    <ProjectSettings
      project={project}
      onBack={() => {}}
      onSaved={() => {}}
      onBusy={() => {}}
      guard={{ current: null }}
    />,
  );
  expect(
    await screen.findByText(
      "Значения указываются в одну строку. Служебные переменные нельзя переопределять",
    ),
  ).toBeTruthy();
  expect(document.body.textContent).not.toMatch(
    /GOGA_\*|AFM_\*|HTTP_PROXY|HTTPS_PROXY|NO_PROXY/,
  );
  const privacyHint = await screen.findByText(
    "Скрытие маскирует значение только на экране. Значения сохраняются без шифрования. Не показывайте их посторонним",
  );
  expect(privacyHint.textContent).not.toMatch(
    /~\/\.goga\/desktop|0600|права файла/,
  );
  expect(document.body.textContent).not.toContain("~/.goga/desktop");
  expect(document.body.textContent).not.toContain("0600");
});
it("removes only browser qualifier from timeout hint", async () => {
  render(
    <ProjectSettings
      project={project}
      onBack={() => {}}
      onSaved={() => {}}
      onBusy={() => {}}
      guard={{ current: null }}
    />,
  );
  await screen.findByText("Ожидание запуска");
  const help = document
    .querySelector("#startup-timeout-help")!
    .textContent!.replace(/\s+/g, " ");
  expect(help).toContain(
    "От запуска процесса Goga после подтверждений до получения ссылки Dashboard и успешного открытия.",
  );
  expect(help).not.toContain("в браузере");
  expect(help).toContain("Включает подготовку и обновление Docker.");
});
it("renames app-owned error heading but preserves raw process output", () => {
  render(
    <RunOutput
      run={
        {
          id: "a",
          status: "running",
          output: { text: "raw AFM output", truncated: false },
        } as any
      }
      viewError="fixture error"
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Панель конвейера недоступна" }),
  ).toBeTruthy();
  expect(screen.getByText("raw AFM output")).toBeTruthy();
});
it("has no AFM in app-owned natural-language strings or JSX across src", () => {
  const violations: string[] = [];
  function inspect(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        inspect(file);
        continue;
      }
      if (!/\.tsx?$/.test(file)) continue;
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      function visit(node: ts.Node) {
        if (
          (ts.isStringLiteralLike(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node) ||
            ts.isJsxText(node)) &&
          /AFM/i.test(node.text) &&
          /[А-Яа-яЁё]/.test(node.text)
        ) {
          violations.push(file + ": " + node.text.trim());
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  inspect("src");
  expect(violations).toEqual([]);
});
