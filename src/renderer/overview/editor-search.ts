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
  constructor(private view: EditorView) {
    this.dom.className = "cm-overview-search";
    this.dom.setAttribute("role", "search");
    this.dom.setAttribute("aria-label", "Поиск в файле");
    const row = document.createElement("div");
    const input = (node: HTMLInputElement, name: string, label: string) => {
      node.name = name;
      node.placeholder = label;
      node.setAttribute("aria-label", label);
      node.addEventListener("input", () => this.commit());
      return node;
    };
    this.find.setAttribute("main-field", "true");
    const field = document.createElement("div");
    field.className = "cm-overview-search-field";
    field.append(input(this.find, "search", "Найти"));
    row.append(field);
    const button = (
      parent: HTMLElement,
      name: string,
      label: string,
      command: (view: EditorView) => boolean,
    ) => {
      const node = document.createElement("button");
      node.type = "button";
      node.name = name;
      node.textContent = label;
      node.addEventListener("click", () => command(this.view));
      parent.append(node);
      return node;
    };
    const iconButton = (
      parent: HTMLElement,
      name: string,
      label: string,
      command: (view: EditorView) => boolean,
    ) => {
      const node = button(parent, name, label, command);
      node.className = `cm-overview-search-${name}`;
      node.setAttribute("aria-label", label);
      node.title = label;
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
    this.clear = iconButton(field, "clear", "Очистить поиск", () => {
      this.find.value = "";
      this.commit();
      this.find.focus();
      return true;
    });
    button(row, "prev", "Назад", findPrevious);
    button(row, "next", "Далее", findNext);
    iconButton(row, "close", "Закрыть поиск", closeSearchPanel);
    this.replaceRow.append(input(this.replacement, "replace", "Заменить на"));
    this.replaceButtons.push(
      button(this.replaceRow, "replace", "Заменить", replaceNext),
      button(this.replaceRow, "replaceAll", "Заменить всё", replaceAll),
    );
    this.dom.append(row, this.replaceRow);
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
    this.replaceRow.hidden = !this.replaceMode;
    this.replacement.disabled = this.view.state.readOnly;
    for (const node of this.replaceButtons)
      node.disabled = this.view.state.readOnly;
  }
  update(_update: ViewUpdate) {
    this.sync();
  }
  mount() {
    this.find.focus();
  }
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
