// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { installHistoryWorker } from "./helpers/history-worker";
import { TopicTaskText } from "../src/renderer/TopicTaskText";
beforeEach(installHistoryWorker);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("uses the history Markdown renderer for tables, task lists, emphasis and code", async () => {
  render(
    <TopicTaskText
      text={
        "# Задача\n\n| Поле | Значение |\n| --- | --- |\n| status | ready |\n\n- [x] Проверено\n- [ ] Сделать\n\n*курсив* и **жирный**\n\n```sh\necho ready\n```"
      }
    />,
  );
  await screen.findByRole("table");
  expect(screen.getByRole("heading", { name: "Задача" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Выполнено" })).toBeTruthy();
  expect(screen.getByText("курсив").tagName).toBe("EM");
  expect(screen.getByText("echo ready").closest("pre")).toBeTruthy();
});
it("keeps HTML/images inert and does not offer nonfunctional file-link buttons", async () => {
  const { container } = render(
    <TopicTaskText
      text={
        "# Безопасность\n\n<script>alert(1)</script>\n\n![test](https://example.test/secret)\n\n[Файл](plan.md) [Сайт](https://example.test)"
      }
    />,
  );
  await screen.findByRole("heading", { name: "Безопасность" });
  expect(container.querySelector("script,img,iframe,a")).toBeNull();
  expect(screen.queryByRole("button", { name: "Файл" })).toBeNull();
  expect(screen.getByText("Файл")).toBeTruthy();
});
