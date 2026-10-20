// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Topic } from "../src/shared/types";
import { TopicSelect } from "../src/renderer/TopicSelect";

const topics: Topic[] = [
  {
    topic: "export-report-with-a-long-shared-prefix-original",
    branch: "feature/export-report-with-a-long-shared-prefix-original",
    current: true,
    remote: false,
    todo: "",
    statuses: [],
  },
  {
    topic: "export-report-with-a-long-shared-prefix-revised",
    branch: "feature/export-report-with-a-long-shared-prefix-revised",
    current: false,
    remote: false,
    todo: "",
    statuses: [],
  },
  {
    topic: "third-topic",
    branch: "feature/third",
    current: false,
    remote: false,
    todo: "",
    statuses: [],
  },
];
const props = {
  topics,
  value: "0",
  currentBranch: topics[1].branch,
  onChange: vi.fn(),
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
const control = () => screen.getByRole("combobox", { name: "Топик проекта" });
const activeOption = () =>
  document.getElementById(control().getAttribute("aria-activedescendant")!);

describe("TopicSelect", () => {
  it("scrolls only the listbox to reveal focused options without scrolling ancestors", () => {
    render(
      <div className="scroll-area">
        <TopicSelect {...props} />
      </div>,
    );
    const outer = control().closest(".scroll-area")!;
    outer.scrollTop = 60;
    fireEvent.click(control());
    const listbox = screen.getByRole("listbox");
    const options = screen.getAllByRole("option");
    const scrollIntoView = vi.fn();
    for (const option of options)
      Object.defineProperty(option, "scrollIntoView", {
        value: scrollIntoView,
        configurable: true,
      });
    const rect = (top: number, bottom: number) => ({
      top,
      bottom,
      left: 0,
      right: 400,
      width: 400,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON() {},
    });
    vi.spyOn(listbox, "getBoundingClientRect").mockReturnValue(rect(200, 300));
    Object.defineProperty(listbox, "clientHeight", {
      value: 100,
      configurable: true,
    });
    vi.spyOn(options[2], "getBoundingClientRect").mockReturnValue(
      rect(350, 410),
    );
    fireEvent.keyDown(control(), { key: "End" });
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(listbox.scrollTop).toBe(110);
    expect(outer.scrollTop).toBe(60);
    vi.spyOn(options[0], "getBoundingClientRect").mockReturnValue(
      rect(150, 210),
    );
    fireEvent.keyDown(control(), { key: "Home" });
    expect(listbox.scrollTop).toBe(60);
    expect(outer.scrollTop).toBe(60);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  function measurePopup(triggerTop: number, viewportBottom: number) {
    render(
      <div className="scroll-area">
        <TopicSelect {...props} />
      </div>,
    );
    const viewport = control().closest(".scroll-area")!;
    const root = control().closest(".topic-select")!;
    const rect = (top: number, bottom: number) => ({
      top,
      bottom,
      left: 0,
      right: 400,
      width: 400,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON() {},
    });
    const triggerRect = vi
      .spyOn(control(), "getBoundingClientRect")
      .mockReturnValue(rect(triggerTop, triggerTop + 60));
    const rootRect = vi
      .spyOn(root, "getBoundingClientRect")
      .mockReturnValue(rect(triggerTop - 24, triggerTop + 60));
    const viewportRect = vi
      .spyOn(viewport, "getBoundingClientRect")
      .mockReturnValue(rect(80, viewportBottom));
    fireEvent.click(control());
    return { viewport, triggerRect, rootRect, viewportRect, rect };
  }

  it("opens below when there is enough space inside the scrolling viewport", () => {
    measurePopup(120, 740);
    const popup = screen.getByRole("listbox");
    expect(popup.getAttribute("data-placement")).toBe("below");
    expect(popup.style.maxHeight).toBe("320px");
    expect(popup.style.top).toBe("89px");
  });

  it("opens above and limits height to available space in a short viewport", () => {
    measurePopup(350, 500);
    const popup = screen.getByRole("listbox");
    expect(popup.getAttribute("data-placement")).toBe("above");
    expect(popup.style.maxHeight).toBe("265px");
    expect(popup.style.bottom).toBe("65px");
    expect(popup.style.top).toBe("auto");
  });

  it("recomputes popup bounds on ancestor scroll and window resize without closing", () => {
    const { viewport, triggerRect, rootRect, viewportRect, rect } =
      measurePopup(350, 500);
    triggerRect.mockReturnValue(rect(120, 180));
    rootRect.mockReturnValue(rect(96, 180));
    fireEvent.scroll(viewport);
    expect(screen.getByRole("listbox").getAttribute("data-placement")).toBe(
      "below",
    );
    expect(screen.getByRole("listbox").style.maxHeight).toBe("315px");
    viewportRect.mockReturnValue(rect(80, 380));
    fireEvent(window, new Event("resize"));
    expect(screen.getByRole("listbox").style.maxHeight).toBe("195px");
    expect(control().getAttribute("aria-expanded")).toBe("true");
  });

  it("describes the selected topic and branch for assistive technology while closed", () => {
    const { rerender } = render(<TopicSelect {...props} />);
    const descriptionId = control().getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    const description = document.getElementById(descriptionId!);
    expect(description).not.toBeNull();
    expect(within(description!).getByText("Топик")).toBeTruthy();
    expect(within(description!).getByText(topics[0].topic)).toBeTruthy();
    expect(within(description!).getByText("Ветка")).toBeTruthy();
    expect(within(description!).getByText(topics[0].branch)).toBeTruthy();
    expect(
      screen.getByRole("combobox", {
        name: "Топик проекта",
        description: new RegExp(topics[0].branch),
      }),
    ).toBe(control());
    rerender(<TopicSelect {...props} value="1" />);
    expect(control().getAttribute("aria-describedby")).toBe(descriptionId);
    expect(
      screen.getByRole("combobox", {
        name: "Топик проекта",
        description: new RegExp(topics[1].branch),
      }),
    ).toBe(control());
  });

  it("shows separate labelled topic and branch lines with complete values and titles", () => {
    render(<TopicSelect {...props} />);
    const button = control();
    expect(within(button).getByText("Топик")).toBeTruthy();
    expect(within(button).getByText("Ветка")).toBeTruthy();
    expect(within(button).getByText(topics[0].topic).title).toBe(
      topics[0].topic,
    );
    expect(within(button).getByText(topics[0].branch).title).toBe(
      topics[0].branch,
    );
    expect(within(button).queryByText("Текущая ветка")).toBeNull();
    fireEvent.click(button);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    for (const [i, option] of options.entries()) {
      expect(within(option).getByText("Топик")).toBeTruthy();
      expect(within(option).getByText("Ветка")).toBeTruthy();
      expect(within(option).getByText(topics[i].topic).title).toBe(
        topics[i].topic,
      );
      expect(within(option).getByText(topics[i].branch).title).toBe(
        topics[i].branch,
      );
    }
    expect(within(options[0]).queryByText("Текущая ветка")).toBeNull();
    expect(within(options[1]).getByText("Текущая ветка")).toBeTruthy();
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("selects by click and restores focus, displaying controlled changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TopicSelect {...props} />);
    await user.click(control());
    await user.click(screen.getAllByRole("option")[1]);
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith("1");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(control());
    rerender(<TopicSelect {...props} value="1" />);
    expect(within(control()).getByText(topics[1].topic)).toBeTruthy();
    expect(within(control()).getByText("Текущая ветка")).toBeTruthy();
  });

  it("navigates without changing selection, then commits with Enter", async () => {
    const user = userEvent.setup();
    render(<TopicSelect {...props} />);
    control().focus();
    await user.keyboard("{ArrowDown}");
    expect(control().getAttribute("aria-expanded")).toBe("true");
    expect(activeOption()).toBe(screen.getAllByRole("option")[0]);
    await user.keyboard("{ArrowDown}");
    expect(activeOption()).toBe(screen.getAllByRole("option")[1]);
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(activeOption()!.getAttribute("aria-selected")).toBe("false");
    expect(props.onChange).not.toHaveBeenCalled();
    await user.keyboard("{End}");
    expect(activeOption()).toBe(screen.getAllByRole("option")[2]);
    await user.keyboard("{Home}{ArrowDown}{ArrowUp}");
    expect(activeOption()).toBe(screen.getAllByRole("option")[0]);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith("1");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(control());
  });

  it("opens and chooses with Space; Escape cancels and restores focus", async () => {
    const user = userEvent.setup();
    render(<TopicSelect {...props} />);
    control().focus();
    await user.keyboard(" {ArrowDown}{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(props.onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(control());
    await user.keyboard(" {End} ");
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith("2");
  });

  it("closes on Tab without trapping focus or committing", async () => {
    const user = userEvent.setup();
    render(
      <>
        <TopicSelect {...props} />
        <button>Следующий</button>
      </>,
    );
    await user.click(control());
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Следующий" }),
    );
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("closes on outside click without stealing focus", async () => {
    const user = userEvent.setup();
    render(
      <>
        <TopicSelect {...props} />
        <input aria-label="Другое поле" />
      </>,
    );
    await user.click(control());
    await user.click(screen.getByLabelText("Другое поле"));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Другое поле"));
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("is safe for no topics or an invalid selected index", () => {
    const { rerender } = render(<TopicSelect {...props} topics={[]} />);
    expect((control() as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(control()).getByText("Нет существующих топиков"),
    ).toBeTruthy();
    fireEvent.click(control());
    expect(screen.queryByRole("listbox")).toBeNull();
    rerender(<TopicSelect {...props} value="99" />);
    expect(within(control()).getByText("Выберите топик")).toBeTruthy();
    fireEvent.keyDown(control(), { key: "End" });
    expect(activeOption()).toBe(screen.getAllByRole("option")[2]);
  });

  it("ignores click and keyboard while disabled", () => {
    render(<TopicSelect {...props} disabled />);
    fireEvent.click(control());
    fireEvent.keyDown(control(), { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("obeys an ancestor disabled fieldset, including disabling an open list", async () => {
    const { rerender } = render(
      <fieldset>
        <TopicSelect {...props} />
      </fieldset>,
    );
    fireEvent.click(control());
    expect(screen.getByRole("listbox")).toBeTruthy();
    rerender(
      <fieldset disabled>
        <TopicSelect {...props} />
      </fieldset>,
    );
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    fireEvent.keyDown(control(), { key: "ArrowDown" });
    fireEvent.click(control());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(props.onChange).not.toHaveBeenCalled();
    rerender(
      <fieldset>
        <TopicSelect {...props} />
      </fieldset>,
    );
    await waitFor(() =>
      expect((control() as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(control());
    expect(screen.getByRole("listbox")).toBeTruthy();
  });
});
