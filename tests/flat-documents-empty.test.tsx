// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ProjectFlatDocuments } from "../src/renderer/ProjectFlatDocuments";
import { createSettingsDocuments } from "../src/renderer/settings-documents";

afterEach(cleanup);
const project = { id: "p", name: "Fixture", path: "/synthetic" };
describe.each(["pipeline", "workflow", "profile"] as const)(
  "%s empty layout",
  (kind) => {
    const label =
      kind === "profile"
        ? "профиль"
        : kind === "pipeline"
          ? "конвейер"
          : "рабочий процесс";
    const nameLabel =
      kind === "profile"
        ? "Имя профиля"
        : kind === "pipeline"
          ? "Имя конвейера"
          : "Имя рабочего процесса";
    const emptyHeading =
      kind === "profile"
        ? "В проекте пока нет профилей"
        : kind === "pipeline"
          ? "В проекте пока нет конвейеров"
          : "В проекте пока нет рабочих процессов";
    const choose = `Выберите ${label}`;
    const source = {
      scope: "project" as const,
      projectId: project.id,
      target: { kind, name: "retained" },
    };
    const file = {
      name: "retained",
      path: `.goga/${kind}s/retained.yml`,
      editable: true,
    };
    function setup() {
      const list = vi.fn(async (): Promise<(typeof file)[]> => []);
      const read = vi.fn(async () => ({
        text: "# original\n",
        version: "v1",
        exists: true,
        relativePath: file.path,
      }));
      const save = vi.fn(
        async (_id: string, _target: unknown, text: string) => ({
          text,
          version: "v2",
          exists: true,
          relativePath: file.path,
        }),
      );
      window.goga = {
        listProjectPipelines: list,
        listProjectProfiles: list,
        listProjectWorkflows: list,
        readProjectDocument: read,
        saveProjectDocument: save,
      } as any;
      const store = createSettingsDocuments();
      return {
        list,
        read,
        save,
        store,
        show: () =>
          render(
            <ProjectFlatDocuments
              project={project}
              store={store}
              kind={kind}
            />,
          ),
      };
    }
    function noDetail(container: HTMLElement) {
      expect(container.querySelector(".master-detail")).toBeNull();
      expect(container.querySelector(".tree-pane")).toBeNull();
      expect(container.querySelector(".file-tree")).toBeNull();
      expect(screen.queryByRole("heading", { name: choose })).toBeNull();
    }
    it("renders exactly one empty card, no tree/divider/selection card, and no filesystem calls", async () => {
      const f = setup(),
        { container } = f.show();
      await screen.findByRole("heading", { name: emptyHeading });
      noDetail(container);
      expect(container.querySelectorAll(".empty-file")).toHaveLength(1);
      expect(
        screen.getByRole("button", { name: `Создать ${label}` }),
      ).toBeTruthy();
      expect(f.read).not.toHaveBeenCalled();
      expect(f.save).not.toHaveBeenCalled();
    });
    it("does not render either empty card or master-detail during initial loading", () => {
      const f = setup();
      f.list.mockImplementationOnce(() => new Promise(() => {}));
      const { container } = f.show();
      expect(screen.getByRole("status")).toBeTruthy();
      noDetail(container);
      expect(container.querySelectorAll(".empty-file")).toHaveLength(0);
    });
    it("shows initial failure and retry without an empty tree or misleading empty heading", async () => {
      const f = setup();
      f.list.mockRejectedValueOnce(Error("catalog unavailable"));
      const { container } = f.show();
      await screen.findByRole("alert");
      noDetail(container);
      expect(container.querySelectorAll(".empty-file")).toHaveLength(0);
      fireEvent.click(
        screen.getByRole("button", { name: "Повторить загрузку" }),
      );
      await screen.findByRole("heading", { name: emptyHeading });
      noDetail(container);
      expect(container.querySelectorAll(".empty-file")).toHaveLength(1);
    });
    it("keeps normal list plus choose placeholder when real files exist", async () => {
      const f = setup();
      f.list.mockResolvedValue([file]);
      const { container } = f.show();
      await screen.findByRole("button", { name: `Файл ${file.path}` });
      expect(container.querySelector(".master-detail")).not.toBeNull();
      expect(screen.getByRole("heading", { name: choose })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: emptyHeading })).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: `Файл ${file.path}` }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Открыть редактор" }));
      await waitFor(() =>
        expect(container.querySelector(".yaml-code-editor")).not.toBeNull(),
      );
    });
    it("keeps one empty card with the creation form then switches to a memory draft before Save", async () => {
      const f = setup(),
        { container } = f.show();
      await screen.findByRole("heading", { name: emptyHeading });
      fireEvent.click(screen.getByRole("button", { name: `Создать ${label}` }));
      noDetail(container);
      expect(container.querySelectorAll(".empty-file")).toHaveLength(1);
      fireEvent.change(screen.getByLabelText(nameLabel), {
        target: { value: "retained" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Создать черновик" }));
      expect(container.querySelector(".master-detail")).not.toBeNull();
      expect(container.querySelectorAll(".empty-file")).toHaveLength(0);
      expect(f.read).not.toHaveBeenCalled();
      expect(f.save).not.toHaveBeenCalled();
      act(() => f.store.edit(source, "# memory only\n"));
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
      await waitFor(() =>
        expect(f.save).toHaveBeenCalledWith(
          "p",
          source.target,
          "# memory only\n",
          "missing",
        ),
      );
      await waitFor(() => expect(f.list).toHaveBeenCalledTimes(2));
      expect(container.querySelector(".editor-pane")).not.toBeNull();
      expect(screen.queryByRole("heading", { name: emptyHeading })).toBeNull();
    });
    it.each(["empty", "failure", "loading"])(
      "retains a loaded edited source when its file disappears and catalog is %s",
      async (state) => {
        const f = setup();
        await f.store.open(source);
        f.store.edit(source, "# unsaved retained\n");
        (kind === "profile"
          ? f.store.updateProjectProfile
          : kind === "pipeline"
            ? f.store.updatePipeline
            : f.store.updateWorkflow)("p", { selected: "retained" });
        if (state === "failure")
          f.list.mockRejectedValueOnce(Error("refresh unavailable"));
        if (state === "loading")
          f.list.mockImplementationOnce(() => new Promise(() => {}));
        const { container } = f.show();
        if (state === "failure") await screen.findByRole("alert");
        if (state === "empty")
          await waitFor(() =>
            expect(screen.queryByText(/Загружаем/)).toBeNull(),
          );
        expect(container.querySelector(".editor-pane")).not.toBeNull();
        expect(
          container.querySelector(".yaml-code-editor")?.shadowRoot?.textContent,
        ).toContain("unsaved retained");
        expect(
          screen.queryByRole("heading", { name: emptyHeading }),
        ).toBeNull();
        expect(screen.queryByRole("heading", { name: choose })).toBeNull();
        f.save.mockRejectedValueOnce(Error("external conflict"));
        if (state === "loading") {
          expect(
            screen.queryByRole("button", { name: "Сохранить" }),
          ).toBeNull();
          // The editor remains mounted; exercise its store while presentation is hidden.
          await act(async () => {
            await f.store.save(source);
          });
          expect(f.store.get(source).error).toBe("external conflict");
        } else {
          fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
          await screen.findByText("external conflict");
        }
        expect(f.store.get(source).text).toBe("# unsaved retained\n");
        expect(container.querySelector(".yaml-code-editor")).not.toBeNull();
      },
    );
    it("does not hide a selected loaded draft even if no catalog or draft-list entry remains", async () => {
      const f = setup();
      await f.store.open(source);
      f.store.edit(source, "# fallback\n");
      (kind === "profile"
        ? f.store.updateProjectProfile
        : kind === "pipeline"
          ? f.store.updatePipeline
          : f.store.updateWorkflow)("p", { selected: "retained", drafts: [] });
      const { container } = f.show();
      await waitFor(() => expect(screen.queryByText(/Загружаем/)).toBeNull());
      expect(container.querySelector(".yaml-code-editor")).not.toBeNull();
      expect(screen.queryByRole("heading", { name: emptyHeading })).toBeNull();
    });
    it.each(["plain", kind === "profile" ? "local.v2" : "tool:release"])(
      "shows relative context path for selected %s before and after opening, preserving identity",
      async (name) => {
        const f = setup();
        const target = { kind, name };
        const relativePath = `.goga/${kind}s/${name}.yml`;
        f.list.mockResolvedValue([
          { name, path: relativePath, editable: true },
        ]);
        const { container } = f.show();
        fireEvent.click(
          await screen.findByRole("button", { name: `Файл ${relativePath}` }),
        );
        const checkPath = () => {
          expect(container.querySelector(".context-path")?.textContent).toBe(
            relativePath,
          );
          expect(
            container.querySelector(".context-path")?.textContent,
          ).not.toContain(project.path);
        };
        checkPath();
        expect(f.read).not.toHaveBeenCalled();
        fireEvent.click(
          screen.getByRole("button", { name: "Открыть редактор" }),
        );
        await waitFor(() =>
          expect(container.querySelector(".yaml-code-editor")).not.toBeNull(),
        );
        checkPath();
        expect(f.read).toHaveBeenCalledWith(project.id, target);
        const selectedSource = {
          scope: "project" as const,
          projectId: project.id,
          target,
        };
        act(() => f.store.edit(selectedSource, "# relative display only\n"));
        fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
        await waitFor(() =>
          expect(f.save).toHaveBeenCalledWith(
            project.id,
            target,
            "# relative display only\n",
            "v1",
          ),
        );
        checkPath();
      },
    );
    it.each(["plain", kind === "profile" ? "local.v2" : "tool:release"])(
      "shows relative context path for memory draft %s without changing draft or Save identity",
      async (name) => {
        const f = setup(),
          { container } = f.show();
        await screen.findByRole("heading", { name: emptyHeading });
        fireEvent.click(
          screen.getByRole("button", { name: `Создать ${label}` }),
        );
        fireEvent.change(screen.getByLabelText(nameLabel), {
          target: { value: name },
        });
        fireEvent.click(
          screen.getByRole("button", { name: "Создать черновик" }),
        );
        expect(container.querySelector(".context-path")?.textContent).toBe(
          `.goga/${kind}s/${name}.yml`,
        );
        expect(
          container.querySelector(".context-path")?.textContent,
        ).not.toContain(project.path);
        expect(f.read).not.toHaveBeenCalled();
        expect(f.save).not.toHaveBeenCalled();
        const target = { kind, name },
          draftSource = {
            scope: "project" as const,
            projectId: project.id,
            target,
          };
        act(() => f.store.edit(draftSource, "# memory\n"));
        fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
        await waitFor(() =>
          expect(f.save).toHaveBeenCalledWith(
            project.id,
            target,
            "# memory\n",
            "missing",
          ),
        );
        expect(f.store.get(draftSource).text).toBe("# memory\n");
      },
    );
  },
);
