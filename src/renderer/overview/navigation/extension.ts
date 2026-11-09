import {
  StateEffect,
  StateField,
  type EditorState,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  showTooltip,
  tooltips,
  type DecorationSet,
  type Tooltip,
  type TooltipView,
  type ViewUpdate,
} from "@codemirror/view";
import { foldedRanges, unfoldEffect } from "@codemirror/language";
import type {
  NavigationController,
  LocalResolver,
  NavigationLanguage,
  NavigationPresentation,
  NavigationConfiguration,
  NavigationResult,
  NavigationTarget,
} from "./types";
import {
  navigationHistory,
  pushNavigationOrigin,
  popNavigationOrigin,
  type NavigationOrigin,
} from "./state";
import { resolveLocal } from "./resolver";
import { candidateSpace, createCandidateTooltip } from "./candidates";
import { navigationTheme } from "./theme";

export interface NavigationOptions extends NavigationConfiguration {
  languageId: NavigationLanguage | null;
  resolve?: LocalResolver;
  onReport?: (presentation: NavigationPresentation) => void;
  modifier?: "meta" | "ctrl" | null;
}
interface Popup {
  result: NavigationResult;
  origin: NavigationOrigin;
  doc: Text;
  revision: number;
  tooltip: Tooltip;
  dom?: HTMLElement;
}

export function createNavigation(
  options: NavigationOptions,
): NavigationController {
  let configuration = {
    languageId: options.languageId,
    ready: options.ready ?? true,
    active: options.active ?? true,
  };
  const resolve = options.resolve ?? resolveLocal;
  const refresh = StateEffect.define<null>();
  // Only an invalidation counter, never popup data, is retained in EditorState.
  const signal = StateField.define<number>({
    create: () => 0,
    update: (value, tr) =>
      tr.effects.some((effect) => effect.is(refresh)) ? value + 1 : value,
  });
  let tooltipOwner: Navigation | null = null;
  const createTooltip = (view: EditorView): TooltipView => {
    const instance = view.plugin(plugin);
    return instance?.createTooltip() ?? { dom: hiddenTooltip(view) };
  };
  function hiddenTooltip(view: EditorView): HTMLElement {
    // A restored state can retain a computed facet descriptor. It carries no
    // candidate data and must never recreate a popup for the new view instance.
    const dom = view.dom.ownerDocument.createElement("div");
    dom.hidden = true;
    return dom;
  }

  class Navigation {
    alive = true;
    decorations: DecorationSet = Decoration.none;
    popup: Popup | null = null;
    revision = 0;
    timer: ReturnType<typeof setTimeout> | null = null;
    lastPoint: { x: number; y: number } | null = null;
    message = "";
    lastReport: NavigationPresentation | null = null;
    readonly modifier: "meta" | "ctrl";
    constructor(readonly view: EditorView) {
      this.modifier =
        options.modifier ??
        (view.dom.ownerDocument.defaultView!.navigator.platform.includes("Mac")
          ? "meta"
          : "ctrl");
      const doc = view.dom.ownerDocument;
      view.contentDOM.addEventListener("mousedown", this.mouseDown, true);
      view.contentDOM.addEventListener("mousemove", this.mouseMove);
      view.contentDOM.addEventListener("mouseleave", this.leave);
      doc.addEventListener("keyup", this.keyUp);
      doc.addEventListener("keydown", this.keyDown);
      doc.addEventListener("mousedown", this.outside, true);
      doc.defaultView!.addEventListener("blur", this.blur);
      // No dispatch during construction/update. Clear any cached facet from a
      // saved EditorState after all native view plugins have mounted.
      queueMicrotask(() => {
        if (!this.alive) return;
        if (
          view.state
            .facet(showTooltip)
            .some((tip) => tip?.create === createTooltip)
        )
          this.invalidate();
        this.report();
      });
    }
    get active() {
      return this.alive && configuration.active && this.view.dom.isConnected;
    }
    get ready() {
      return (
        this.active && configuration.ready && configuration.languageId !== null
      );
    }
    isModified(event: MouseEvent | KeyboardEvent) {
      return (
        !!event[this.modifier === "meta" ? "metaKey" : "ctrlKey"] &&
        !event.altKey &&
        !event.shiftKey
      );
    }
    invalidate() {
      if (this.alive) this.view.dispatch({ effects: refresh.of(null) });
    }
    report() {
      if (!this.alive) return;
      const next: NavigationPresentation = {
        supported: configuration.languageId !== null,
        ready: this.ready,
        canBack:
          this.active && this.view.state.field(navigationHistory).length > 0,
        message: this.message,
      };
      const previous = this.lastReport;
      if (
        !previous ||
        previous.supported !== next.supported ||
        previous.ready !== next.ready ||
        previous.canBack !== next.canBack ||
        previous.message !== next.message
      ) {
        this.lastReport = next;
        options.onReport?.(next);
      }
    }
    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.revision++;
        this.resetTransient();
        this.message = "";
      }
      this.report();
    }
    resolve(position: number): NavigationResult {
      try {
        return resolve(this.view.state, configuration.languageId!, position);
      } catch {
        return { kind: "unavailable", targets: [], reason: "analysis-error" };
      }
    }
    cancelHover() {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }
    clearHover() {
      this.cancelHover();
      if (this.decorations.size) {
        this.decorations = Decoration.none;
        this.invalidate();
      }
    }
    resetTransient() {
      this.cancelHover();
      this.lastPoint = null;
      this.decorations = Decoration.none;
      this.popup = null;
      if (tooltipOwner === this) tooltipOwner = null;
    }
    close() {
      if (!this.alive) return;
      // A restored state's cached facet may own a hidden native TooltipView,
      // even though this fresh plugin has no popup. Remove it synchronously so
      // an immediate Go cannot reuse that inert DOM by its create identity.
      const changed =
        this.popup !== null ||
        this.decorations.size > 0 ||
        this.view.state
          .facet(showTooltip)
          .some((tip) => tip?.create === createTooltip);
      this.resetTransient();
      if (changed) this.invalidate();
    }
    configure() {
      this.resetTransient();
      this.message = "";
      this.invalidate();
    }
    mouseMove = (event: MouseEvent) => {
      if (!this.ready) return;
      this.lastPoint = { x: event.clientX, y: event.clientY };
      if (!this.isModified(event) || event.buttons) this.clearHover();
      else this.queueHover(this.lastPoint);
    };
    leave = () => {
      this.lastPoint = null;
      this.clearHover();
    };
    blur = () => this.close();
    keyUp = (event: KeyboardEvent) => {
      if (this.active && !this.isModified(event)) this.clearHover();
    };
    keyDown = (event: KeyboardEvent) => {
      if (this.ready && this.lastPoint && this.isModified(event))
        this.queueHover(this.lastPoint);
    };
    queueHover(point: { x: number; y: number }) {
      this.cancelHover();
      const state = this.view.state;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.ready || this.view.state !== state) return;
        const position = this.view.posAtCoords(point);
        const result = position === null ? null : this.resolve(position);
        const token = result?.kind !== "unavailable" ? result?.token : null;
        this.decorations =
          token &&
          token.from >= 0 &&
          token.to <= state.doc.length &&
          token.to > token.from
            ? Decoration.set([
                Decoration.mark({ class: "nav-symbol" }).range(
                  token.from,
                  token.to,
                ),
              ])
            : Decoration.none;
        this.invalidate();
      }, 70);
    }
    outside = (event: MouseEvent) => {
      if (!this.active || !this.popup) return;
      const path = event.composedPath();
      if (this.popup.dom && path.includes(this.popup.dom)) return;
      const editorClick =
        path.includes(this.view.contentDOM) && event.button === 0;
      if (editorClick) {
        event.preventDefault();
        event.stopPropagation();
      }
      this.close();
      if (editorClick) this.view.focus();
    };
    mouseDown = (event: MouseEvent) => {
      if (!this.active || event.button !== 0) return;
      // Also covers non-composed synthetic events within this ShadowRoot.
      if (this.popup) {
        event.preventDefault();
        event.stopPropagation();
        this.close();
        this.view.focus();
        return;
      }
      if (!this.ready || !this.isModified(event)) return;
      const position = this.view.posAtCoords({
        x: event.clientX,
        y: event.clientY,
      });
      if (position === null) return;
      event.preventDefault();
      event.stopPropagation();
      this.go(position, { anchor: position, head: position });
    };
    go(
      position = this.view.state.selection.main.head,
      origin: NavigationOrigin = this.view.state.selection.main,
    ): boolean {
      if (!this.ready) return false;
      this.close();
      this.message = "";
      const result = this.resolve(position);
      if (result.kind === "resolved" && result.targets.length === 1)
        this.jump(result.targets[0], origin);
      else if (result.kind === "candidates" && result.targets.length)
        this.open(result, position, origin);
      else {
        this.message = unavailableMessage(result.reason);
        this.report();
      }
      return true;
    }
    jump(target: NavigationTarget, origin: NavigationOrigin) {
      const state = this.view.state;
      if (
        !this.ready ||
        target.from < 0 ||
        target.to > state.doc.length ||
        target.to <= target.from
      )
        return;
      const effects: StateEffect<unknown>[] = [
        EditorView.scrollIntoView(target.from, { y: "center" }),
      ];
      if (
        Math.min(origin.anchor, origin.head) !== target.from ||
        Math.max(origin.anchor, origin.head) !== target.to
      ) {
        effects.push(
          pushNavigationOrigin.of({ anchor: origin.anchor, head: origin.head }),
        );
      }
      foldedRanges(state).between(target.from, target.to, (from, to) => {
        effects.push(unfoldEffect.of({ from, to }));
      });
      this.resetTransient();
      this.message = "";
      effects.push(refresh.of(null));
      this.view.dispatch({
        selection: { anchor: target.from, head: target.to },
        effects,
      });
      this.view.focus();
    }
    back(): boolean {
      if (!this.active) return false;
      const origin = this.view.state.field(navigationHistory).at(-1);
      if (!origin) return false;
      this.resetTransient();
      this.message = "";
      const effects: StateEffect<unknown>[] = [
        popNavigationOrigin.of(null),
        refresh.of(null),
        EditorView.scrollIntoView(origin.head, { y: "center" }),
      ];
      foldedRanges(this.view.state).between(
        Math.min(origin.anchor, origin.head),
        Math.max(origin.anchor, origin.head),
        (from, to) => {
          effects.push(unfoldEffect.of({ from, to }));
        },
      );
      this.view.dispatch({ selection: origin, effects });
      this.view.focus();
      return true;
    }
    open(result: NavigationResult, position: number, origin: NavigationOrigin) {
      this.popup = {
        result,
        origin: { anchor: origin.anchor, head: origin.head },
        doc: this.view.state.doc,
        revision: this.revision,
        tooltip: { pos: position, create: createTooltip, clip: false },
      };
      tooltipOwner = this;
      this.invalidate();
    }
    createTooltip(): TooltipView {
      const popup = this.popup;
      if (!popup || !this.ready) return { dom: hiddenTooltip(this.view) };
      const valid = () =>
        this.ready &&
        this.popup === popup &&
        popup.revision === this.revision &&
        popup.doc === this.view.state.doc;
      const tooltip = createCandidateTooltip(
        this.view,
        popup.result.targets,
        valid,
        (target) => this.jump(target, popup.origin),
        () => this.close(),
      );
      popup.dom = tooltip.dom;
      return tooltip;
    }
    destroy() {
      this.alive = false;
      this.resetTransient();
      const doc = this.view.dom.ownerDocument;
      this.view.contentDOM.removeEventListener(
        "mousedown",
        this.mouseDown,
        true,
      );
      this.view.contentDOM.removeEventListener("mousemove", this.mouseMove);
      this.view.contentDOM.removeEventListener("mouseleave", this.leave);
      doc.removeEventListener("keyup", this.keyUp);
      doc.removeEventListener("keydown", this.keyDown);
      doc.removeEventListener("mousedown", this.outside, true);
      doc.defaultView!.removeEventListener("blur", this.blur);
    }
  }
  const plugin = ViewPlugin.fromClass(Navigation, {
    decorations: (instance) => instance.decorations,
  });
  const currentTooltip = (state: EditorState): Tooltip | null => {
    const popup = tooltipOwner?.popup;
    return popup && popup.doc === state.doc && tooltipOwner?.ready
      ? popup.tooltip
      : null;
  };
  return {
    extensions: [
      navigationHistory,
      signal,
      plugin,
      showTooltip.compute([signal, "doc"], currentTooltip),
      tooltips({ tooltipSpace: candidateSpace }),
      navigationTheme,
      keymap.of([
        { key: "F12", run: (view) => view.plugin(plugin)?.go() ?? false },
      ]),
    ],
    go: (view) => view.plugin(plugin)?.go() ?? false,
    back: (view) => view.plugin(plugin)?.back() ?? false,
    close: (view) => view.plugin(plugin)?.close(),
    canBack: (view) =>
      !!view.plugin(plugin)?.active &&
      (view.state.field(navigationHistory, false)?.length ?? 0) > 0,
    configure(view, next) {
      const instance = view.plugin(plugin);
      if (!instance?.alive) return;
      configuration = { ...configuration, ...next };
      instance.configure();
    },
  };
}

function unavailableMessage(reason?: string): string {
  switch (reason) {
    case "analysis-error":
      return "Локальный анализ недоступен. Редактирование доступно.";
    case "parser-mismatch-or-missing":
      return "Переход недоступен: анализатор языка не загружен.";
    case "document-limit":
    case "candidate-limit":
    case "index-budget-exceeded":
    case "parse-budget-exceeded":
      return "Переход недоступен: превышен лимит локального анализа.";
    case "unsupported-language":
      return "Переход недоступен для этого языка.";
    case "unsupported-syntax-region":
    case "opaque-raw-string":
    case "untrustworthy-scope":
    case "incomplete-call":
      return "Переход недоступен: этот фрагмент нельзя надёжно разобрать.";
    case "shadowed-or-dynamic-binding":
    case "dynamic-with-scope":
    case "wildcard-import":
      return "Переход недоступен: локальное определение затенено или неоднозначно.";
    case "unknown-receiver-no-local-candidates":
      return "Переход недоступен: тип объекта неизвестен, локальных кандидатов нет.";
    case "not-a-supported-identifier":
    case "not-an-expression-reference":
    case "non-expression-position":
    case "binding-position-not-reference":
    case "argument-label-not-reference":
    case "outside-identifier":
    case "invalid-position":
    case "string-content":
      return "Установите курсор на имя в месте использования.";
    default:
      return "Переход недоступен: определение в этом файле не найдено.";
  }
}
