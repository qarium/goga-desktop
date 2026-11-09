import {
  repositionTooltips,
  type EditorView,
  type Rect,
  type TooltipView,
} from "@codemirror/view";
import type { NavigationTarget } from "./types";

export function candidateSpace(view: EditorView): Rect {
  const doc = view.dom.ownerDocument;
  const win = doc.defaultView!;
  return {
    left: 12,
    right: Math.max(
      12,
      (doc.documentElement.clientWidth || win.innerWidth) - 12,
    ),
    top: 12,
    bottom: Math.max(
      12,
      (doc.documentElement.clientHeight || win.innerHeight) - 12,
    ),
  };
}

export function createCandidateTooltip(
  view: EditorView,
  targets: readonly NavigationTarget[],
  valid: () => boolean,
  choose: (target: NavigationTarget) => void,
  close: () => void,
): TooltipView {
  const doc = view.dom.ownerDocument;
  const box = doc.createElement("div");
  box.className = "nav-candidates";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Кандидаты в этом файле");
  const cleanups: (() => void)[] = [];
  function listen<K extends keyof HTMLElementEventMap>(
    node: HTMLElement,
    event: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ) {
    node.addEventListener(event, listener);
    cleanups.push(() => node.removeEventListener(event, listener));
  }
  const header = doc.createElement("div");
  header.className = "nav-candidates-heading";
  const title = doc.createElement("strong");
  title.textContent = "Кандидаты в этом файле";
  const dismiss = doc.createElement("button");
  dismiss.type = "button";
  dismiss.className = "icon-button";
  dismiss.textContent = "×";
  dismiss.setAttribute("aria-label", "Закрыть кандидатов");
  const cancel = () => {
    if (valid()) {
      close();
      view.focus();
    }
  };
  listen(dismiss, "click", cancel);
  header.append(title, dismiss);
  const note = doc.createElement("p");
  note.textContent =
    "Найдено несколько возможных объявлений или точная связь не установлена.";
  note.className = "nav-candidates-note";
  const list = doc.createElement("div");
  list.className = "nav-candidates-list";
  let selected = 0;
  const buttons = targets.map((target, index) => {
    const button = doc.createElement("button");
    button.type = "button";
    button.dataset.candidate = String(index);
    button.className = "nav-candidate";
    const body = doc.createElement("span");
    body.className = "nav-candidate-body";
    const signature = doc.createElement("code");
    signature.textContent = target.signature || target.name;
    body.append(signature);
    if (target.owner) {
      const owner = doc.createElement("small");
      owner.textContent = target.owner;
      body.append(owner);
    }
    const line = doc.createElement("span");
    line.className = "nav-candidate-line";
    line.textContent = `стр. ${target.line}`;
    button.append(body, line);
    listen(button, "click", () => {
      if (valid()) choose(target);
    });
    listen(button, "focus", () => {
      selected = index;
    });
    list.append(button);
    return button;
  });
  listen(box, "keydown", (event) => {
    if (!valid()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      selected =
        (selected + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
        buttons.length;
      const button = buttons[selected];
      button.focus({ preventScroll: true });
      // Reveal only within the list: native scrollIntoView can scroll the page
      // or editor as well, while preventScroll alone hides long-list choices.
      const item = button.getBoundingClientRect();
      const visible = list.getBoundingClientRect();
      if (item.top < visible.top) list.scrollTop -= visible.top - item.top;
      else if (item.bottom > visible.bottom)
        list.scrollTop += item.bottom - visible.bottom;
    }
    if (event.key === "Enter" && event.target !== dismiss) {
      event.preventDefault();
      buttons[selected].click();
    }
  });
  const hint = doc.createElement("div");
  hint.className = "nav-candidates-footer";
  hint.textContent = "↑ ↓ выбрать  ·  Enter перейти  ·  Esc закрыть";
  box.append(header, note, list, hint);
  const size = () => {
    const space = candidateSpace(view);
    const width = `${Math.min(560, Math.max(0, space.right - space.left))}px`;
    const height = `${Math.max(0, space.bottom - space.top)}px`;
    const changed = box.style.width !== width || box.style.maxHeight !== height;
    box.style.width = width;
    box.style.maxHeight = height;
    return changed;
  };
  const resize = () => {
    if (valid() && size()) repositionTooltips(view);
  };
  return {
    dom: box,
    getCoords(position) {
      const anchor =
        view.coordsAtPos(position) ?? view.dom.getBoundingClientRect();
      const space = candidateSpace(view);
      // Keep the candidate list usable when its anchor is scrolled offscreen.
      const top = Math.max(space.top, Math.min(anchor.top, space.bottom - 1));
      return {
        left: anchor.left,
        right: anchor.right,
        top,
        bottom: Math.min(space.bottom, Math.max(top, anchor.bottom)),
      };
    },
    mount() {
      size();
      doc.defaultView!.addEventListener("resize", resize);
      cleanups.push(() =>
        doc.defaultView!.removeEventListener("resize", resize),
      );
      if (valid()) buttons[0]?.focus({ preventScroll: true });
    },
    positioned: resize,
    destroy() {
      for (const cleanup of cleanups) cleanup();
    },
  };
}
