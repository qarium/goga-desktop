import { installHistoryWorker } from "./helpers/history-worker";
// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HistoryMarkdown, artifactLink } from "../src/renderer/HistoryMarkdown";
beforeEach(installHistoryWorker);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("renders Markdown structure without an editor", async () => {
  const { container } = render(
    <HistoryMarkdown
      text={
        "# План\n\n**Важно** и *курсив*.\n\n| Шаг | Итог |\n| --- | --- |\n| 1 | Готово |\n\n- [x] Проверено\n\n```ts\nconst x = 1;\n```\n\n> Примечание"
      }
      path="plan.md"
      onFile={vi.fn()}
    />,
  );
  expect(await screen.findByRole("heading", { name: "План" })).toBeTruthy();
  expect(screen.getByRole("table")).toBeTruthy();
  expect(container.querySelector("strong")?.textContent).toBe("Важно");
  expect(container.querySelector("blockquote")?.textContent).toContain(
    "Примечание",
  );
  expect(container.querySelector("pre code")?.textContent).toContain("const x");
  expect(container.querySelector("input")?.disabled).toBe(true);
  expect(screen.queryByRole("textbox")).toBeNull();
});
it("never executes HTML or loads external images/links", async () => {
  const { container } = render(
    <HistoryMarkdown
      text={
        '<script>alert(1)</script>\n\n<img src="file:///secret">\n\n![pixel](https://remote/pixel.png)\n\n[bad](javascript:alert(1)) [site](https://remote/)'
      }
      path="todo.md"
      onFile={vi.fn()}
    />,
  );
  await screen.findByText(/pixel/);
  expect(
    container.querySelector("script,img,iframe,object,a[href]"),
  ).toBeNull();
  expect(screen.getByText(/pixel/)).toBeTruthy();
});
it("relative file links stay in the entry and navigate without external IO", async () => {
  const open = vi.fn();
  render(
    <HistoryMarkdown
      text="[План](../plan.md)"
      path="reports/result.md"
      onFile={open}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "План" }));
  expect(open).toHaveBeenCalledWith("plan.md");
  for (const value of [
    "../../secret",
    "/etc/passwd",
    "file:///secret",
    "https://host",
    "//host",
    "data:text/html,x",
    "%2e%2e/%2e%2e/secret",
    "..\\secret",
  ])
    expect(artifactLink("reports/a.md", value)).toBeNull();
});
it("unreasonably large Markdown remains readable as plain text", async () => {
  const text = "text ".repeat(45000);
  const { container } = render(
    <HistoryMarkdown text={text} path="large.md" onFile={vi.fn()} />,
  );
  await screen.findByText(/Предпросмотр Markdown недоступен/);
  expect(container.querySelector("pre")?.textContent).toBe(text);
});
