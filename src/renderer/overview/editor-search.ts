import type { MessageKey } from "../../shared/locale-packs.generated";
import { subscribeLocale, t as msg } from "../../shared/i18n";
import {
  EditorView,
  keymap,
  runScopeHandlers,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";
import { Prec } from "@codemirror/state";
import {
  search,
  SearchQuery,
  getSearchQuery,
  setSearchQuery,
  openSearchPanel,
  closeSearchPanel,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  searchKeymap,
} from "@codemirror/search";

let nextSearchHint = 0;

/** Only the panel is application UI. Matching, selection and edits are CodeMirror commands. */
class OverviewSearchPanel implements Panel {
  dom = document.createElement("div");
  top = true;
  private find = document.createElement("input");
  private clear: HTMLButtonElement;
  private replacement = document.createElement("input");
  private replaceRow = document.createElement("div");
  private replaceButtons: HTMLButtonElement[] = [];
  private replaceMode = false;
  private refreshLabels: (() => void)[] = [];
  private stopLocale?: () => void;
  // Keep the description and its control in the same editor shadow root.
  // The browser's anchored popover follows scrolling without editor updates.
  private hint = document.createElement("span");
  private hinted?: HTMLButtonElement;
  private dismissHint = (event?: KeyboardEvent) => {
    if (!this.hinted || (event && event.key !== "Escape")) return;
    this.hinted.removeAttribute("aria-describedby");
    this.hinted.style.removeProperty("anchor-name");
    this.hinted = undefined;
    if (this.hint.isConnected) this.hint.hidePopover?.();
    this.hint.hidden = true;
    this.dom.ownerDocument.removeEventListener("keydown", this.dismissHint, true);
  };
  private bindHint(node: HTMLButtonElement) {
    const show = () => {
      if (this.hinted === node) return;
      this.dismissHint();
      this.hinted = node;
      node.style.setProperty("anchor-name", `--${this.hint.id}`);
      node.setAttribute("aria-describedby", this.hint.id);
      this.hint.textContent = node.getAttribute("aria-label");
      this.hint.hidden = false;
      this.hint.showPopover?.();
      this.dom.ownerDocument.addEventListener("keydown", this.dismissHint, true);
    };
    const close = () => { if (this.hinted === node) this.dismissHint(); };
    node.addEventListener("mouseenter", show);
    node.addEventListener("focus", show);
    node.addEventListener("mouseleave", close);
    node.addEventListener("blur", close);
    node.addEventListener("click", close);
  }
  private label(key: MessageKey, apply: (text: string) => void) {
    const refresh = () => apply(msg(key));
    this.refreshLabels.push(refresh);
    refresh();
  }
  constructor(private view: EditorView) {
    this.hint.className = "cm-overview-icon-hint";
    this.hint.id = `overview-search-hint-${++nextSearchHint}`;
    this.hint.style.setProperty("position-anchor", `--${this.hint.id}`);
    this.hint.setAttribute("role", "tooltip");
    if (typeof this.hint.showPopover === "function") this.hint.popover = "manual";
    this.hint.hidden = true;
    this.dom.className = "cm-overview-search";
    this.dom.setAttribute("role", "search");
    this.label("overview.findInFile2", text => this.dom.setAttribute("aria-label", text));
    const row = document.createElement("div");
    const input = (node: HTMLInputElement, name: string, label: MessageKey) => {
      node.name = name;
      this.label(label, text => {
        node.placeholder = text;
        node.setAttribute("aria-label", text);
      });
      node.addEventListener("input", () => this.commit());
      return node;
    };
    this.find.setAttribute("main-field", "true");
    const field = document.createElement("div");
    field.className = "cm-overview-search-field";
    field.append(input(this.find, "search", "overview.find"));
    row.append(field);
    const button = (
      parent: HTMLElement,
      name: string,
      label: MessageKey,
      command: (view: EditorView) => boolean,
      isIcon = false,
    ) => {
      const node = document.createElement("button");
      node.type = "button";
      node.name = name;
      this.label(label, text => {
        if (isIcon) {
          node.setAttribute("aria-label", text);
          if (this.hinted === node) this.hint.textContent = text;
        } else {
          node.textContent = text;
        }
      });
      node.addEventListener("click", () => command(this.view));
      parent.append(node);
      return node;
    };
    const iconButton = (
      parent: HTMLElement,
      name: string,
      label: MessageKey,
      command: (view: EditorView) => boolean,
    ) => {
      const node = button(parent, name, label, command, true);
      this.bindHint(node);
      node.className = `cm-overview-search-${name}`;
      const icon = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("width", "14");
      icon.setAttribute("height", "14");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.setAttribute("stroke-width", "2");
      icon.setAttribute("stroke-linecap", "round");
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("focusable", "false");
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute("d", "M18 6 6 18M6 6l12 12");
      icon.append(path);
      node.replaceChildren(icon);
      return node;
    };
    this.clear = iconButton(field, "clear", "overview.clearSearch", () => {
      this.find.value = "";
      this.commit();
      this.find.focus();
      return true;
    });
    button(row, "prev", "overview.previous", findPrevious);
    button(row, "next", "overview.next", findNext);
    iconButton(row, "close", "overview.closeSearch", closeSearchPanel);
    this.replaceRow.append(input(this.replacement, "replace", "overview.replaceWith"));
    this.replaceButtons.push(
      button(this.replaceRow, "replace", "overview.replace", replaceNext),
      button(this.replaceRow, "replaceAll", "overview.replaceAll", replaceAll),
    );
    this.dom.append(row, this.replaceRow, this.hint);
    this.dom.addEventListener("keydown", (event) => {
      if (runScopeHandlers(this.view, event, "search-panel")) {
        event.preventDefault();
      } else if (
        event.key === "Enter" &&
        (event.target === this.find || event.target === this.replacement)
      ) {
        event.preventDefault();
        if (event.target === this.replacement) replaceNext(this.view);
        else (event.shiftKey ? findPrevious : findNext)(this.view);
      }
    });
    // Keep the documented open command focused on the standard main-field.
    this.find.addEventListener("focus", () => this.find.select());
    this.sync();
    this.dom.addEventListener("overview-search-mode", (event) => {
      this.replaceMode = (event as CustomEvent<boolean>).detail;
      this.sync();
      (this.replaceMode && !view.state.readOnly
        ? this.replacement
        : this.find
      ).focus();
      view.requestMeasure();
    });
  }
  private commit() {
    const previous = getSearchQuery(this.view.state);
    this.view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          ...previous,
          search: this.find.value,
          replace: this.replacement.value,
          // Source editor searches are literal: typing a path must not reinterpret escape sequences.
          literal: true,
        }),
      ),
    });
  }
  private sync() {
    const query = getSearchQuery(this.view.state);
    if (this.find.value !== query.search) this.find.value = query.search;
    if (this.replacement.value !== query.replace)
      this.replacement.value = query.replace;
    this.clear.hidden = query.search.length === 0;
    if (this.clear.hidden && this.hinted === this.clear) this.dismissHint();
    this.replaceRow.hidden = !this.replaceMode;
    this.replacement.disabled = this.view.state.readOnly;
    for (const node of this.replaceButtons)
      node.disabled = this.view.state.readOnly;
  }
  update(_update: ViewUpdate) {
    this.sync();
  }
  mount() {
    this.stopLocale = subscribeLocale(() => this.refreshLabels.forEach(refresh => refresh()));
    this.find.focus();
  }
  destroy() { this.dismissHint(); this.stopLocale?.(); }
}

export function openOverviewSearch(view: EditorView, replace = false) {
  openSearchPanel(view);
  view.dom
    .querySelector(".cm-overview-search")
    ?.dispatchEvent(
      new CustomEvent("overview-search-mode", { detail: replace }),
    );
  return true;
}

export const overviewSearch = [
  search({
    top: true,
    literal: true,
    createPanel: (view) => new OverviewSearchPanel(view),
  }),
  Prec.highest(
    keymap.of([
      {
        key: "Mod-f",
        run: (view) => openOverviewSearch(view),
        preventDefault: true,
        scope: "editor search-panel",
      },
      {
        key: "Ctrl-f",
        run: (view) => openOverviewSearch(view),
        preventDefault: true,
        scope: "editor search-panel",
      },
      {
        key: "Ctrl-r",
        run: (view) => openOverviewSearch(view, true),
        preventDefault: true,
        scope: "editor search-panel",
      },
      {
        key: "Mod-Alt-f",
        run: (view) => openOverviewSearch(view, true),
        preventDefault: true,
        scope: "editor search-panel",
      },
      ...searchKeymap.filter((binding) =>
        ["F3", "Mod-g", "Escape"].includes(binding.key ?? ""),
      ),
    ]),
  ),
  EditorView.theme({
    ".cm-overview-search": {
      padding: "8px",
      background: "#101b2b",
      color: "#d7e2f2",
      fontFamily: "system-ui, sans-serif",
      fontSize: "12px",
    },
    ".cm-overview-icon-hint": {
      position: "fixed", inset: "auto", positionArea: "top", positionTryFallbacks: "flip-block",
      positionVisibility: "anchors-visible", justifySelf: "anchor-center", margin: "8px 0",
      padding: "7px 10px", width: "max-content", maxWidth: "calc(100vw - 24px)",
      color: "var(--overlay-fg)", background: "var(--overlay-bg)", border: "1px solid var(--overlay-line)",
      borderRadius: "6px", boxShadow: "0 6px 20px #0005", font: "700 12px/1.4 system-ui, sans-serif",
      overflowWrap: "anywhere", pointerEvents: "none",
    },
    ".cm-overview-search > div": {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: "6px",
      margin: "3px 0",
    },
    ".cm-overview-search > [hidden]": { display: "none" },
    ".cm-overview-search input": {
      flex: "1 1 130px",
      minWidth: "80px",
      padding: "5px 8px",
      background: "#0a1221",
      color: "#d7e2f2",
      border: "1px solid #33485f",
      borderRadius: "4px",
    },
    ".cm-overview-search-field": {
      position: "relative",
      display: "flex",
      flex: "1 1 130px",
      minWidth: "0",
    },
    ".cm-overview-search-field input": {
      boxSizing: "border-box",
      width: "100%",
      flex: "1 1 auto",
      minWidth: "0",
      paddingRight: "28px",
    },
    ".cm-overview-search button": {
      padding: "5px 8px",
      background: "#1b293e",
      color: "#d7e2f2",
      border: "1px solid #33485f",
      borderRadius: "4px",
      cursor: "pointer",
    },
    ".cm-overview-search-clear, .cm-overview-search-close": {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
    },
    ".cm-overview-search button.cm-overview-search-clear": {
      position: "absolute",
      right: "4px",
      top: "50%",
      transform: "translateY(-50%)",
      padding: "3px",
      background: "transparent",
      border: "none",
    },
    ".cm-overview-search-close": { marginLeft: "auto" },
    ".cm-overview-search button[hidden]": { display: "none" },
    ".cm-overview-search button:disabled": {
      opacity: "0.45",
      cursor: "default",
    },
    ".cm-overview-search input:focus-visible, .cm-overview-search button:focus-visible":
      { outline: "1px solid #20cab8", outlineOffset: "1px" },
    ".cm-searchMatch": { backgroundColor: "#4c4a28" },
    ".cm-searchMatch-selected": { backgroundColor: "#376a65" },
  }),
];
