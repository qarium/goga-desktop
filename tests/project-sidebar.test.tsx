// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fireEvent,
  render,
  screen,
  within,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { ProjectSidebar } from "../src/renderer/ProjectSidebar";
import { useProjectOrganization } from "../src/renderer/useProjectOrganization";
import { NativeTopicPopupProvider } from "../src/renderer/TopicPickerPopup";
import { organizationKey } from "../src/renderer/project-organization-preferences";
const projects = [
  { id: "a", name: "Alpha", path: "/work/a" },
  { id: "b", name: "Beta", path: "/work/b" },
];
const remove = vi.fn(),
  open = vi.fn();
function Sidebar({
  collapsed = false,
  ready = true,
}: {
  collapsed?: boolean;
  ready?: boolean;
}) {
  const controller = useProjectOrganization(projects, ready);
  return (
    <NativeTopicPopupProvider value={false}>
      <ProjectSidebar
        projects={projects}
        controller={controller}
        activeProjectId="a"
        collapsed={collapsed}
        disabled={false}
        homeActive={false}
        onHome={() => {}}
        onOpen={open}
        onAdd={() => {}}
        addMenuOpen={false}
        onRemove={remove}
        canOpenMenu={() => true}
        unreadByProject={{ a: 3 }}
        onNotifications={() => {}}
        onError={(e) => {
          throw e;
        }}
      />
    </NativeTopicPopupProvider>
  );
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);
it("insets project and group menus without moving drag handles or compact icons", () => {
  localStorage.setItem(
    organizationKey,
    JSON.stringify({
      schemaVersion: 1,
      groups: [
        { id: "g", name: "Работа", collapsed: false, projectIds: ["b"] },
      ],
      ungroupedProjectIds: ["a"],
    }),
  );
  const style = document.createElement("style");
  style.textContent = readFileSync("src/renderer/ProjectSidebar.css", "utf8");
  document.head.appendChild(style);
  try {
    const view = render(<Sidebar />);
    for (const name of [
      "Действия проекта Alpha",
      "Действия проекта Beta",
      "Действия группы Работа",
    ]) {
      expect(
        parseFloat(
          getComputedStyle(screen.getByRole("button", { name }))
            .marginInlineEnd,
        ) || 0,
      ).toBeGreaterThanOrEqual(6);
    }
    expect(
      parseFloat(
        getComputedStyle(
          screen.getByRole("button", { name: "Перетащить проект Alpha" }),
        ).marginInlineEnd,
      ) || 0,
    ).toBe(0);
    view.rerender(<Sidebar collapsed />);
    expect(
      screen.queryByRole("button", { name: "Действия проекта Alpha" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Alpha" })).toBeTruthy();
  } finally {
    style.remove();
  }
});
it("makes groups inline; menu operations move and dissolve but never remove projects", async () => {
  render(<Sidebar />);
  fireEvent.click(screen.getByRole("button", { name: "Создать группу" }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Работа" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Создать" }));
  fireEvent.contextMenu(screen.getByRole("button", { name: "Alpha" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "В группу «Работа»" }),
  );
  const group = await screen.findByRole("group", { name: "Работа" });
  await within(group).findByRole("button", { name: "Alpha" });
  fireEvent.click(
    within(group).getByRole("button", { name: "Действия группы Работа" }),
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Расформировать группу…" }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Расформировать" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("group", { name: "Работа" })).toBeNull(),
  );
  expect(remove).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(
    screen
      .getAllByRole("button")
      .filter((b) => b.classList.contains("project-button"))
      .map((b) => b.getAttribute("aria-label")),
  ).toEqual(["Beta", "Alpha"]);
});
it("keeps every project and its badge in the compact sidebar regardless of group collapse", async () => {
  localStorage.setItem(
    organizationKey,
    JSON.stringify({
      schemaVersion: 1,
      groups: [{ id: "g", name: "Работа", collapsed: true, projectIds: ["b"] }],
      ungroupedProjectIds: ["a"],
    }),
  );
  const view = render(<Sidebar />);
  expect(screen.queryByRole("button", { name: "Beta" })).toBeNull();
  view.rerender(<Sidebar collapsed />);
  expect(
    screen
      .getAllByRole("button")
      .filter((b) => b.classList.contains("project-button"))
      .map((b) => b.getAttribute("aria-label")),
  ).toEqual(["Beta", "Alpha"]);
  expect(
    screen.getByRole("button", { name: "Уведомления проекта Alpha: 3" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Beta" }));
  expect(open).toHaveBeenCalledWith(projects[1]);
});
it("offers the same actions via keyboard, restores focus and blocks duplicate deletion", async () => {
  render(<Sidebar />);
  const b = screen.getByRole("button", { name: "Beta" });
  b.focus();
  fireEvent.keyDown(b, { key: "F10", shiftKey: true });
  const menu = await screen.findByRole("menu", { name: "Действия с проектом" });
  fireEvent.keyDown(menu, { key: "End" });
  expect(document.activeElement).toBe(
    within(menu).getByRole("menuitem", { name: "Убрать из списка…" }),
  );
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(document.activeElement).toBe(b);
  expect(remove).not.toHaveBeenCalled();
});
