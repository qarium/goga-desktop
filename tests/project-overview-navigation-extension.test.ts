// @vitest-environment jsdom
// The 18 approved V1 navigation assertions, adapted only for the product API/ShadowRoot.
import { test, beforeAll, vi } from "vitest";
import assert from "node:assert/strict";
import { Compartment, EditorState, StateEffect } from "@codemirror/state";
import {
  EditorView,
  showTooltip,
  getTooltip,
  repositionTooltips,
} from "@codemirror/view";
import { history, undo, undoDepth } from "@codemirror/commands";
import { foldCode, foldedRanges, foldGutter } from "@codemirror/language";
import {
  createNavigation,
  type NavigationOptions,
} from "../src/renderer/overview/navigation/extension";
import { navigationHistory } from "../src/renderer/overview/navigation/state";
import type {
  LocalResolver,
  NavigationPresentation,
  NavigationResult,
} from "../src/renderer/overview/navigation/types";
import { loadNavigationSupports } from "./helpers/overview-navigation-fixtures";
const supports = await loadNavigationSupports();
beforeAll(() => {
  // jsdom does not implement ShadowRoot selection APIs used by CodeMirror.
  document.execCommand = () => false;
  Range.prototype.getClientRects = () =>
    Object.assign([], { item: () => null });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
const text =
  "def alpha():\n    return 1\n\ndef beta():\n    return 2\n\nalpha()\n";
const call = text.lastIndexOf("alpha");
const alpha = {
  name: "alpha",
  signature: "def alpha()",
  from: 4,
  to: 9,
  line: 1,
};
const beta = {
  name: "beta",
  signature: "def beta()",
  from: text.indexOf("beta"),
  to: text.indexOf("beta") + 4,
  line: 4,
};
function setup(
  result: NavigationResult | LocalResolver,
  modifier: "meta" | "ctrl" | null = "meta",
  options: Partial<NavigationOptions> = {},
) {
  const reports: NavigationPresentation[] = [];
  const nav = createNavigation({
    languageId: "python",
    resolve: typeof result === "function" ? result : () => result,
    onReport: (r) => reports.push(r),
    modifier,
    ...options,
  });
  const parent = document.createElement("div");
  document.body.append(parent);
  const root = parent.attachShadow({ mode: "open" });
  const state = EditorState.create({
    doc: text,
    selection: { anchor: call },
    extensions: [supports.python, history(), foldGutter(), nav.extensions],
  });
  const view = new EditorView({ state, parent: root, root });
  return {
    nav,
    root,
    parent,
    view,
    state,
    reports,
    clean() {
      view.destroy();
      parent.remove();
    },
  };
}
const resolved: NavigationResult = {
  kind: "resolved",
  targets: [alpha],
  token: { from: call, to: call + 5 },
};
const ambiguous: NavigationResult = {
  kind: "candidates",
  targets: [alpha, beta],
  token: { from: call, to: call + 5 },
};
test("exact navigation and Back restore position in current file", () => {
  const x = setup(resolved);
  try {
    x.nav.go(x.view);
    assert.equal(x.view.state.selection.main.from, alpha.from);
    assert.equal(x.nav.back(x.view), true);
    assert.equal(x.view.state.selection.main.head, call);
    assert.equal(x.nav.back(x.view), false);
  } finally {
    x.clean();
  }
});
test("candidate popup does not move cursor; explicit selection jumps", () => {
  const x = setup(ambiguous);
  try {
    x.nav.go(x.view);
    assert.equal(x.view.state.selection.main.head, call);
    const list = x.root.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.ok(list);
    assert.match(list.textContent ?? "", /Кандидаты в этом файле/);
    assert.match(list.textContent ?? "", /def alpha/);
    assert.match(list.textContent ?? "", /стр. 4/);
    list.querySelectorAll<HTMLButtonElement>("[data-candidate]")[1].click();
    assert.equal(x.view.state.selection.main.from, beta.from);
    assert.equal(x.root.querySelector<HTMLElement>('[role="dialog"]'), null);
  } finally {
    x.clean();
  }
});
test("single unproven candidate stays popup", () => {
  const x = setup({ ...ambiguous, targets: [alpha] });
  try {
    x.nav.go(x.view);
    assert.equal(x.view.state.selection.main.head, call);
    assert.ok(x.root.querySelector<HTMLElement>('[role="dialog"]'));
  } finally {
    x.clean();
  }
});
test("Escape closes popup without navigation", () => {
  const x = setup(ambiguous);
  try {
    x.nav.go(x.view);
    x.root.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(x.root.querySelector<HTMLElement>('[role="dialog"]'), null);
    assert.equal(x.view.state.selection.main.head, call);
  } finally {
    x.clean();
  }
});
test("ArrowDown and Enter select second candidate", () => {
  const x = setup(ambiguous);
  try {
    x.nav.go(x.view);
    const list = x.root.querySelector<HTMLElement>('[role="dialog"]')!;
    list.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    list.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    assert.equal(x.view.state.selection.main.from, beta.from);
  } finally {
    x.clean();
  }
});
test("edit closes popup; detached candidate cannot jump", () => {
  const x = setup(ambiguous);
  try {
    x.nav.go(x.view);
    const button = x.root.querySelector<HTMLElement>("[data-candidate]")!;
    x.view.dispatch({ changes: { from: 0, insert: "# prefix\n" } });
    const position = x.view.state.selection.main.head;
    assert.equal(x.root.querySelector<HTMLElement>('[role="dialog"]'), null);
    button.click();
    assert.equal(x.view.state.selection.main.head, position);
  } finally {
    x.clean();
  }
});
test("switch file disposes popup and keeps histories per state", () => {
  const x = setup(ambiguous);
  try {
    x.nav.go(x.view);
    const old = x.root.querySelector<HTMLElement>("[data-candidate]")!;
    x.view.setState(
      EditorState.create({ doc: "other file", extensions: x.nav.extensions }),
    );
    old.click();
    assert.equal(x.view.state.selection.main.head, 0);
    assert.equal(x.root.querySelector<HTMLElement>('[role="dialog"]'), null);
    assert.equal(x.nav.back(x.view), false);
  } finally {
    x.clean();
  }
});
test("history positions map through unsaved edits, ordinary undo remains", () => {
  const x = setup(resolved);
  try {
    x.nav.go(x.view);
    x.view.dispatch({
      changes: { from: 0, insert: "# note\n" },
      userEvent: "input",
    });
    assert.equal(x.nav.back(x.view), true);
    assert.equal(x.view.state.selection.main.head, call + 7);
    assert.equal(undo(x.view), true);
    assert.equal(x.view.state.doc.toString(), text);
  } finally {
    x.clean();
  }
});
test("unavailable result does not move selection and reports reason", () => {
  const x = setup({ kind: "unavailable", targets: [], reason: "shadowed" });
  try {
    x.nav.go(x.view);
    assert.equal(x.view.state.selection.main.head, call);
    assert.ok(x.reports.some((r) => r.message.includes("Переход недоступен")));
    assert.equal(x.root.querySelector<HTMLElement>('[role="dialog"]'), null);
  } finally {
    x.clean();
  }
});
test("normal and shift-modifier selection matches unmodified CodeMirror", () => {
  let calls = 0;
  const x = setup(() => {
    calls++;
    return resolved;
  });
  const parent = document.createElement("div");
  document.body.append(parent);
  const baseline = new EditorView({
    state: EditorState.create({
      doc: text,
      selection: { anchor: call },
      extensions: [supports.python],
    }),
    parent,
  });
  try {
    for (const opts of [
      {},
      { shiftKey: true, metaKey: true },
      { altKey: true, metaKey: true },
    ]) {
      const send = (view: EditorView) => {
        const event = new window.MouseEvent("mousedown", {
          button: 0,
          bubbles: true,
          cancelable: true,
          ...opts,
        });
        view.contentDOM.dispatchEvent(event);
        return event.defaultPrevented;
      };
      assert.equal(send(x.view), send(baseline));
      assert.equal(calls, 0);
      assert.deepEqual(
        x.view.state.selection.toJSON(),
        baseline.state.selection.toJSON(),
      );
    }
  } finally {
    x.clean();
    baseline.destroy();
    parent.remove();
  }
});
test("jump unfolds destination", () => {
  const x = setup({ ...resolved, targets: [{ ...alpha, from: 17, to: 23 }] });
  try {
    x.view.dispatch({ selection: { anchor: 0 } });
    assert.equal(foldCode(x.view), true);
    assert.ok(foldedRanges(x.view.state).size > 0);
    x.view.dispatch({ selection: { anchor: call } });
    x.nav.go(x.view);
    assert.equal(foldedRanges(x.view.state).size, 0);
  } finally {
    x.clean();
  }
});
test("Cmd click Back returns to clicked call, not previously parked cursor", () => {
  const x = setup(resolved);
  try {
    x.view.dispatch({ selection: { anchor: 0 } });
    x.view.posAtCoords = () => call;
    x.view.contentDOM.dispatchEvent(
      new window.MouseEvent("mousedown", {
        button: 0,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(x.view.state.selection.main.from, alpha.from);
    x.nav.back(x.view);
    assert.equal(x.view.state.selection.main.head, call);
  } finally {
    x.clean();
  }
});
test("Cmd click candidate selection Back returns to clicked call", () => {
  const x = setup(ambiguous);
  try {
    x.view.dispatch({ selection: { anchor: 0 } });
    x.view.posAtCoords = () => call;
    x.view.contentDOM.dispatchEvent(
      new window.MouseEvent("mousedown", {
        button: 0,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(x.view.state.selection.main.head, 0);
    x.root.querySelector<HTMLElement>("[data-candidate]")!.click();
    x.nav.back(x.view);
    assert.equal(x.view.state.selection.main.head, call);
  } finally {
    x.clean();
  }
});
test("outside editor click dismisses candidates without moving cursor", () => {
  const x = setup(ambiguous);
  try {
    x.nav.go(x.view);
    const event = new window.MouseEvent("mousedown", {
      button: 0,
      bubbles: true,
      cancelable: true,
    });
    x.view.contentDOM.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(x.view.state.selection.main.head, call);
    assert.equal(x.root.querySelector<HTMLElement>('[role="dialog"]'), null);
    assert.equal(x.view.hasFocus, true);
  } finally {
    x.clean();
  }
});
test("Cmd click same already selected definition still records new clicked origin", () => {
  const x = setup(resolved);
  try {
    x.view.dispatch({ selection: { anchor: alpha.from, head: alpha.to } });
    x.view.posAtCoords = () => call;
    x.view.contentDOM.dispatchEvent(
      new window.MouseEvent("mousedown", {
        button: 0,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(x.nav.back(x.view), true);
    assert.equal(x.view.state.selection.main.head, call);
  } finally {
    x.clean();
  }
});

for (const [platform, key] of [
  ["MacIntel", "metaKey"],
  ["Win32", "ctrlKey"],
  ["Linux x86_64", "ctrlKey"],
]) {
  test(`native modifier selection on ${platform}`, () => {
    const original = Object.getOwnPropertyDescriptor(
      window.navigator,
      "platform",
    );
    Object.defineProperty(window.navigator, "platform", {
      value: platform,
      configurable: true,
    });
    const x = setup(resolved, null);
    try {
      x.view.dispatch({ selection: { anchor: 0 } });
      x.view.posAtCoords = () => call;
      const event = new window.MouseEvent("mousedown", {
        button: 0,
        [key]: true,
        bubbles: true,
        cancelable: true,
      });
      x.view.contentDOM.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
      assert.equal(x.view.state.selection.main.from, alpha.from);
      assert.equal(x.nav.back(x.view), true);
      assert.equal(x.view.state.selection.main.head, call);
    } finally {
      x.clean();
      if (original)
        Object.defineProperty(window.navigator, "platform", original);
      else Reflect.deleteProperty(window.navigator, "platform");
    }
  });
}

const wait = (ms = 100) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function hover(view: EditorView) {
  view.posAtCoords = () => call;
  view.contentDOM.dispatchEvent(
    new MouseEvent("mousemove", {
      bubbles: true,
      composed: true,
      metaKey: true,
      clientX: 5,
      clientY: 5,
    }),
  );
}

test("switching files cannot restore an old modifier-hover underline", async () => {
  const x = setup(resolved);
  try {
    hover(x.view);
    await wait();
    assert.equal(x.view.dom.querySelectorAll(".nav-symbol").length, 1);
    const original = x.view.state;
    x.view.setState(
      EditorState.create({ doc: "other file", extensions: x.nav.extensions }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Meta", bubbles: true }),
    );
    x.view.setState(original);
    assert.equal(x.view.dom.querySelectorAll(".nav-symbol").length, 0);
  } finally {
    x.clean();
  }
});

test("popup is a native tooltip inside the real editor shadow, not document.body", () => {
  const x = setup(ambiguous);
  try {
    x.nav.go(x.view);
    const dialog = x.root.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.ok(dialog);
    assert.equal(dialog.getRootNode(), x.root);
    assert.equal(dialog.closest(".cm-editor"), x.view.dom);
    assert.equal(document.body.querySelector('[role="dialog"]'), null);
    const descriptor = x.view.state.facet(showTooltip).find(Boolean)!;
    assert.ok(descriptor);
    assert.equal(getTooltip(x.view, descriptor)?.dom, dialog);
    assert.equal(
      x.root.activeElement,
      dialog.querySelector("[data-candidate]"),
    );
  } finally {
    x.clean();
  }
});

test("composed outside clicks dismiss text without moving caret, but controls still act", () => {
  const x = setup(ambiguous);
  const control = document.createElement("button");
  document.body.append(control);
  let clicks = 0;
  control.addEventListener("click", () => clicks++);
  try {
    x.nav.go(x.view);
    const candidate = x.root.querySelector<HTMLElement>("[data-candidate]")!;
    candidate.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    assert.ok(
      x.root.querySelector('[role="dialog"]'),
      "retargeted candidate is inside the popup",
    );
    const textClick = new MouseEvent("mousedown", {
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    x.view.contentDOM.dispatchEvent(textClick);
    assert.equal(textClick.defaultPrevented, true);
    assert.equal(x.view.state.selection.main.head, call);
    assert.equal(x.root.querySelector('[role="dialog"]'), null);
    assert.equal(x.view.hasFocus, true);
    x.nav.go(x.view);
    const outside = new MouseEvent("mousedown", {
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    control.dispatchEvent(outside);
    assert.equal(outside.defaultPrevented, false);
    control.click();
    assert.equal(clicks, 1);
    assert.equal(x.root.querySelector('[role="dialog"]'), null);
  } finally {
    control.remove();
    x.clean();
  }
});

test("F12 navigates while right click and extra modifiers do not resolve", () => {
  let calls = 0;
  const x = setup(() => {
    calls++;
    return resolved;
  });
  try {
    x.view.posAtCoords = () => call;
    for (const opts of [
      { button: 2, metaKey: true },
      { button: 0, metaKey: true, shiftKey: true },
      { button: 0, metaKey: true, altKey: true },
    ]) {
      x.view.contentDOM.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, ...opts }),
      );
    }
    assert.equal(calls, 0);
    const key = new KeyboardEvent("keydown", {
      key: "F12",
      keyCode: 123,
      bubbles: true,
      cancelable: true,
    });
    x.view.contentDOM.dispatchEvent(key);
    assert.equal(key.defaultPrevented, true);
    assert.equal(calls, 1);
    assert.equal(x.view.state.selection.main.from, alpha.from);
  } finally {
    x.clean();
  }
});

test("candidate text is safe, owner and line stay separate, ArrowUp wraps, X restores focus", () => {
  const signature =
    '<script>alert("no")</script> ' + "parameter: LongType, ".repeat(60);
  const x = setup({
    ...ambiguous,
    targets: [{ ...alpha, signature, owner: "Owner<Class>" }, beta],
  });
  try {
    x.nav.go(x.view);
    const dialog = x.root.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(dialog.querySelector("script"), null);
    assert.equal(dialog.querySelector("code")?.textContent, signature);
    assert.equal(dialog.querySelector("small")?.textContent, "Owner<Class>");
    assert.equal(
      dialog.querySelector(".nav-candidate-line")?.textContent,
      "стр. 1",
    );
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
    assert.equal(
      x.root.activeElement,
      dialog.querySelectorAll("[data-candidate]")[1],
    );
    dialog
      .querySelector<HTMLButtonElement>('[aria-label="Закрыть кандидатов"]')!
      .click();
    assert.equal(x.root.querySelector('[role="dialog"]'), null);
    assert.equal(x.view.state.selection.main.head, call);
    assert.equal(x.view.hasFocus, true);
  } finally {
    x.clean();
  }
});

test("navigation leaves document, content notifications, and text undo untouched", () => {
  const x = setup(resolved);
  let changes = 0;
  try {
    x.view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changes++;
        }),
      ),
    });
    const doc = x.view.state.doc;
    const depth = undoDepth(x.view.state);
    x.nav.go(x.view);
    x.nav.back(x.view);
    assert.equal(x.view.state.doc, doc);
    assert.equal(changes, 0);
    assert.equal(undoDepth(x.view.state), depth);
    assert.equal(undo(x.view), false);
  } finally {
    x.clean();
  }
});

test("history is bounded to 50 origins and survives reconfigure/remount with a new controller", () => {
  const x = setup(resolved);
  let restored: EditorView | undefined;
  try {
    for (let i = 0; i < 55; i++) {
      x.view.dispatch({ selection: { anchor: call } });
      x.nav.go(x.view);
    }
    assert.equal(x.view.state.field(navigationHistory).length, 50);
    const next = createNavigation({
      languageId: "python",
      resolve: () => resolved,
    });
    const state = x.view.state.update({
      effects: StateEffect.reconfigure.of([
        supports.python,
        history(),
        next.extensions,
      ]),
    }).state;
    x.view.destroy();
    restored = new EditorView({ parent: x.root, root: x.root, state });
    assert.equal(next.canBack(restored), true);
    for (let i = 0; i < 50; i++) assert.equal(next.back(restored), true);
    assert.equal(next.back(restored), false);
    assert.equal(restored.state.selection.main.head, call);
  } finally {
    restored?.destroy();
    x.parent.remove();
  }
});

test("same saved state remount never restores popup or hover", async () => {
  const x = setup(ambiguous);
  let restored: EditorView | undefined;
  try {
    x.nav.go(x.view);
    const oldButton =
      x.root.querySelector<HTMLButtonElement>("[data-candidate]")!;
    const state = x.view.state;
    x.view.destroy();
    restored = new EditorView({ parent: x.root, root: x.root, state });
    assert.equal(x.root.querySelector('[role="dialog"]'), null);
    assert.equal(x.root.querySelector(".nav-symbol"), null);
    oldButton.click();
    assert.equal(restored.state.selection.main.head, call);
    await wait(0);
    assert.equal(restored.state.facet(showTooltip).filter(Boolean).length, 0);
  } finally {
    restored?.destroy();
    x.parent.remove();
  }
});

test("grammar availability config keeps history from first mount and Back during loading", async () => {
  let calls = 0;
  const x = setup(
    () => {
      calls++;
      return resolved;
    },
    "meta",
    { ready: false },
  );
  try {
    assert.deepEqual(x.view.state.field(navigationHistory), []);
    assert.equal(x.nav.go(x.view), false);
    hover(x.view);
    await wait();
    assert.equal(calls, 0);
    x.nav.configure(x.view, { ready: true });
    assert.equal(x.nav.go(x.view), true);
    assert.equal(x.nav.canBack(x.view), true);
    x.nav.configure(x.view, { ready: false });
    assert.equal(x.nav.go(x.view), false);
    assert.equal(x.nav.back(x.view), true);
    assert.equal(x.view.state.selection.main.head, call);
    assert.equal(x.reports.at(-1)?.ready, false);
    assert.equal(x.reports.at(-1)?.canBack, false);
  } finally {
    x.clean();
  }
});

test("inactive and disposed views ignore commands, timers, stale popup and global modifiers", async () => {
  let calls = 0;
  const x = setup(() => {
    calls++;
    return ambiguous;
  });
  try {
    x.nav.go(x.view);
    const button = x.root.querySelector<HTMLButtonElement>("[data-candidate]")!;
    hover(x.view);
    x.nav.configure(x.view, { active: false });
    const count = calls;
    button.click();
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Meta",
        metaKey: true,
        bubbles: true,
      }),
    );
    await wait();
    assert.equal(calls, count);
    assert.equal(x.nav.go(x.view), false);
    assert.equal(x.nav.back(x.view), false);
    assert.equal(x.root.querySelector('[role="dialog"]'), null);
    assert.equal(x.root.querySelector(".nav-symbol"), null);
    x.nav.configure(x.view, { active: true });
    x.nav.go(x.view);
    hover(x.view);
    x.view.destroy();
    const afterDestroy = calls;
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Meta",
        metaKey: true,
        bubbles: true,
      }),
    );
    await wait();
    assert.equal(calls, afterDestroy);
    assert.equal(x.nav.go(x.view), false);
    assert.equal(x.nav.back(x.view), false);
    assert.equal(x.root.querySelector('[role="dialog"]'), null);
  } finally {
    x.parent.remove();
  }
});

test("hover is silent and resolver exceptions are an unavailable command, not a broken editor", async () => {
  const x = setup(() => {
    throw new Error("parser failure");
  });
  try {
    await wait(0);
    const reports = x.reports.length;
    hover(x.view);
    await wait();
    assert.equal(x.reports.length, reports);
    assert.equal(x.root.querySelector(".nav-symbol"), null);
    assert.equal(x.nav.go(x.view), true);
    assert.match(x.reports.at(-1)?.message ?? "", /анализ|недоступ/i);
    assert.equal(x.view.state.selection.main.head, call);
    x.view.dispatch({
      changes: { from: 0, insert: "# editing still works\n" },
    });
    assert.equal(x.reports.at(-1)?.message, "");
  } finally {
    x.clean();
  }
});

test("a disposed view cannot reconfigure a remounted controller", () => {
  const x = setup(resolved);
  let next: EditorView | undefined;
  try {
    const state = x.view.state;
    x.view.destroy();
    next = new EditorView({ state, parent: x.root, root: x.root });
    x.nav.configure(x.view, { ready: false, active: false, languageId: null });
    assert.equal(x.nav.go(next), true);
    assert.equal(next.state.selection.main.from, alpha.from);
  } finally {
    next?.destroy();
    x.parent.remove();
  }
});

test("explanatory command statuses are Russian and emitted only when presentation changes", async () => {
  const x = setup({
    kind: "unavailable",
    targets: [],
    reason: "parser-mismatch-or-missing",
  });
  try {
    await wait(0);
    assert.deepEqual(x.reports.at(-1), {
      supported: true,
      ready: true,
      canBack: false,
      message: "",
    });
    x.nav.go(x.view);
    assert.match(x.reports.at(-1)?.message ?? "", /парсер|анализатор|загруз/i);
    assert.doesNotMatch(
      x.reports.at(-1)?.message ?? "",
      /parser-mismatch-or-missing/,
    );
    const count = x.reports.length;
    x.nav.go(x.view);
    hover(x.view);
    await wait();
    x.view.dispatch({ selection: { anchor: call + 1 } });
    assert.equal(x.reports.length, count);
    x.nav.configure(x.view, { ready: false });
    assert.equal(x.reports.at(-1)?.message, "");
  } finally {
    x.clean();
  }
});

test("arrow navigation scrolls only the candidate list to reveal an offscreen choice", () => {
  const x = setup({
    ...ambiguous,
    targets: Array.from({ length: 10 }, () => alpha),
  });
  try {
    x.nav.go(x.view);
    const dialog = x.root.querySelector<HTMLElement>('[role="dialog"]')!;
    const list = dialog.querySelector<HTMLElement>(".nav-candidates-list")!;
    list.getBoundingClientRect = () => new DOMRect(20, 80, 400, 100);
    const buttons = [
      ...list.querySelectorAll<HTMLButtonElement>("[data-candidate]"),
    ];
    buttons.forEach((button, index) => {
      button.getBoundingClientRect = () =>
        new DOMRect(20, 80 + index * 40 - list.scrollTop, 400, 40);
    });
    const editorScroll = x.view.scrollDOM.scrollTop;
    const pageScroll = document.documentElement.scrollTop;
    for (let i = 0; i < 4; i++)
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    assert.equal(x.root.activeElement, buttons[4]);
    assert.equal(list.scrollTop, 100);
    for (let i = 0; i < 4; i++)
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
    assert.equal(x.root.activeElement, buttons[0]);
    assert.equal(list.scrollTop, 0);
    assert.equal(x.view.scrollDOM.scrollTop, editorScroll);
    assert.equal(document.documentElement.scrollTop, pageScroll);
  } finally {
    x.clean();
  }
});

test("native tooltip positioning clamps to viewport margins at the right and bottom edges", async () => {
  const x = setup(ambiguous);
  try {
    for (const [width, height] of [
      [1024, 768],
      [320, 400],
    ]) {
      vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
        width,
      );
      vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
        height,
      );
      vi.spyOn(x.view, "inView", "get").mockReturnValue(true);
      x.view.dom.getBoundingClientRect = () => new DOMRect(0, 0, width, height);
      x.view.scrollDOM.getBoundingClientRect = () =>
        new DOMRect(0, 0, width, height);
      x.view.contentDOM.getBoundingClientRect = () =>
        new DOMRect(0, 0, width, height);
      x.view.coordsAtPos = () => ({
        left: width - 20,
        right: width - 16,
        top: height - 24,
        bottom: height - 18,
      });
      x.nav.go(x.view);
      const dialog = x.root.querySelector<HTMLElement>('[role="dialog"]')!;
      const tooltipWidth = Math.min(560, width - 24);
      dialog.getBoundingClientRect = () =>
        new DOMRect(
          parseFloat(dialog.style.left) || 0,
          parseFloat(dialog.style.top) || 0,
          tooltipWidth,
          160,
        );
      repositionTooltips(x.view);
      await wait();
      const left = parseFloat(dialog.style.left),
        top = parseFloat(dialog.style.top);
      assert.ok(
        left >= 12 && left + tooltipWidth <= width - 12,
        `horizontal bounds ${left}/${width}`,
      );
      assert.ok(
        top >= 12 && top + 160 <= height - 12,
        `vertical bounds ${top}/${height}`,
      );
      assert.ok(dialog.classList.contains("cm-tooltip-above"));
      // jsdom has no CSS layout; actual positions above come from CM's measurement
      // pipeline with controlled rectangles. Browser wrapping remains N6 evidence.
      const styles = [...x.root.querySelectorAll("style")]
        .map((style) => style.textContent)
        .join("\n");
      assert.match(styles, /min\(560px, calc\(100vw - 24px\)\)/);
      assert.match(styles, /overflow-wrap: anywhere/);
      assert.match(styles, /white-space: pre-wrap/);
      x.nav.close(x.view);
    }
  } finally {
    vi.restoreAllMocks();
    x.clean();
  }
});

test("destroy removes navigation DOM/global listeners and cancels pending hover", async () => {
  const add = vi.spyOn(document, "addEventListener");
  const remove = vi.spyOn(document, "removeEventListener");
  const windowAdd = vi.spyOn(window, "addEventListener");
  const windowRemove = vi.spyOn(window, "removeEventListener");
  let resolves = 0;
  const x = setup(() => {
    resolves++;
    return resolved;
  });
  const contentAdd = vi.spyOn(x.view.contentDOM, "addEventListener");
  const contentRemove = vi.spyOn(x.view.contentDOM, "removeEventListener");
  try {
    // Reconfigure recreates the plugin so local listener registrations are visible.
    const state = x.view.state;
    x.view.setState(state);
    const registrations = [...add.mock.calls];
    const windowRegistrations = [...windowAdd.mock.calls];
    const localRegistrations = [...contentAdd.mock.calls];
    hover(x.view);
    x.view.destroy();
    await wait();
    assert.equal(resolves, 0);
    for (const [event, handler, capture] of registrations.filter(([event]) =>
      ["keydown", "keyup", "mousedown"].includes(event),
    )) {
      assert.ok(
        remove.mock.calls.some(
          (call) =>
            call[0] === event && call[1] === handler && !!call[2] === !!capture,
        ),
        event,
      );
    }
    for (const [event, handler] of windowRegistrations.filter(
      ([event]) => event === "blur",
    )) {
      assert.ok(
        windowRemove.mock.calls.some(
          (call) => call[0] === event && call[1] === handler,
        ),
      );
    }
    for (const [event, handler] of localRegistrations.filter(([event]) =>
      ["mousedown", "mousemove", "mouseleave"].includes(event),
    )) {
      assert.ok(
        contentRemove.mock.calls.some(
          (call) => call[0] === event && call[1] === handler,
        ),
      );
    }
  } finally {
    vi.restoreAllMocks();
    x.parent.remove();
  }
});

test("the real resolver works after a grammar compartment loads without replacing history", () => {
  const x = setup(resolved, "meta", { ready: false, resolve: undefined });
  const grammar = new Compartment();
  try {
    x.view.setState(
      EditorState.create({
        doc: text,
        selection: { anchor: call },
        extensions: [history(), grammar.of([]), x.nav.extensions],
      }),
    );
    const initialHistory = x.view.state.field(navigationHistory);
    assert.deepEqual(initialHistory, []);
    assert.equal(x.nav.go(x.view), false);
    x.view.dispatch({ effects: grammar.reconfigure(supports.python) });
    assert.equal(x.view.state.field(navigationHistory), initialHistory);
    x.nav.configure(x.view, { ready: true });
    assert.equal(x.nav.go(x.view), true);
    assert.equal(x.view.state.selection.main.from, alpha.from);
    x.nav.configure(x.view, { active: false });
    assert.equal(x.nav.canBack(x.view), false);
    assert.equal(x.view.state.field(navigationHistory).length, 1);
    x.nav.configure(x.view, { active: true });
    assert.equal(x.nav.canBack(x.view), true);
    assert.equal(x.nav.back(x.view), true);
    assert.equal(x.view.state.selection.main.head, call);
  } finally {
    x.clean();
  }
});

test("tooltip width uses the usable viewport, including scrollbar width, and follows resize", () => {
  const x = setup(ambiguous);
  try {
    const width = vi
      .spyOn(document.documentElement, "clientWidth", "get")
      .mockReturnValue(300);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
      400,
    );
    x.nav.go(x.view);
    const dialog = x.root.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(dialog.style.width, "276px");
    assert.equal(dialog.style.maxHeight, "376px");
    width.mockReturnValue(1000);
    window.dispatchEvent(new Event("resize"));
    assert.equal(dialog.style.width, "560px");
    x.nav.close(x.view);
    width.mockReturnValue(200);
    window.dispatchEvent(new Event("resize"));
    assert.equal(
      dialog.style.width,
      "560px",
      "detached tooltip no longer listens to resize",
    );
  } finally {
    vi.restoreAllMocks();
    x.clean();
  }
});

test("immediate Go after restoring a candidate state creates a live popup before the mount microtask", async () => {
  const x = setup(ambiguous);
  let next: EditorView | undefined;
  try {
    x.nav.go(x.view);
    const saved = x.view.state;
    x.view.destroy();
    next = new EditorView({ state: saved, parent: x.root, root: x.root });
    assert.equal(
      x.root.querySelector('[role="dialog"]'),
      null,
      "saved candidates must not reopen automatically",
    );
    assert.equal(x.nav.go(next), true);
    const dialog = x.root.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(
      dialog,
      "an explicit immediate Go must create the current candidates",
    );
    assert.equal(dialog.hidden, false);
    const descriptor = next.state.facet(showTooltip).find(Boolean)!;
    assert.equal(getTooltip(next, descriptor)?.dom, dialog);
    await wait(0);
    assert.equal(
      x.root.querySelector('[role="dialog"]'),
      dialog,
      "mount cleanup must preserve the explicitly opened popup",
    );
    dialog.querySelectorAll<HTMLButtonElement>("[data-candidate]")[1].click();
    assert.equal(next.state.selection.main.from, beta.from);
    assert.equal(x.nav.back(next), true);
    assert.equal(next.state.selection.main.head, call);
  } finally {
    next?.destroy();
    x.parent.remove();
  }
});
