import type { TopicContextRef } from "../shared/worktrees";
import { contextRef, contextRequestKey } from "./topic-context";
import { readRequest } from "./read-request";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { Pipeline } from "../shared/types";
import type { ProjectWorkflow } from "../shared/project-documents";
import { availableWorkflowPipelines } from "../shared/workflow-suggestions";
import "./WorkflowNameInput.css";

type Suggestions = {
  context: string;
  status: "ready" | "error";
  pipelines: Pipeline[];
};

export function WorkflowNameInput({
  projectId,
  owner,
  savedSettingsVersion,
  projectRevision,
  files,
  drafts,
  value,
  onChange,
}: {
  projectId: string;
  owner?: TopicContextRef;
  savedSettingsVersion?: string;
  projectRevision: number;
  files: ProjectWorkflow[];
  drafts: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listbox = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [result, setResult] = useState<Suggestions>();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<{ key: string; id: string }>();
  const [popup, setPopup] = useState({
    above: false,
    maxHeight: 280,
    offset: 0,
  });
  const context = JSON.stringify([
    owner ? contextRequestKey(owner) : projectId,
    savedSettingsVersion ?? null,
    projectRevision,
  ]);
  // Validate at render time: an effect cleanup alone leaves old options visible
  // for the first commit of a new project/settings/revision context.
  const current = result?.context === context ? result : undefined;
  const options = availableWorkflowPipelines(
    current?.pipelines ?? [],
    files,
    drafts,
  ).filter((item) =>
    `${item.id}\n${item.name}`
      .toLocaleLowerCase()
      .includes(value.toLocaleLowerCase()),
  );
  const optionKey = JSON.stringify([
    context,
    value,
    options.map((item) => [item.id, item.name]),
  ]);
  const active =
    highlight?.key === optionKey
      ? options.findIndex((item) => item.id === highlight.id)
      : -1;
  const expanded = open && options.length > 0;
  const optionId = (index: number) => `${id}-option-${index}`;

  useEffect(() => {
    let live = true;
    setResult(undefined);
    // A missing bridge in an older host is the same nonblocking failure as a
    // rejected catalog request. Never alter the controlled name on completion.
    Promise.resolve()
      .then(() =>
        readRequest(
          "listWorkflowSuggestions",
          owner ? contextRef(owner) : projectId,
        ),
      )
      .then(
        (pipelines) => {
          if (live) setResult({ context, status: "ready", pipelines });
        },
        () => {
          if (live) setResult({ context, status: "error", pipelines: [] });
        },
      );
    return () => {
      live = false;
    };
  }, [context, projectId]);

  useEffect(() => {
    setHighlight((previous) =>
      previous?.key === optionKey ? previous : undefined,
    );
  }, [optionKey]);

  useLayoutEffect(() => {
    if (!expanded) return;
    const viewport = root.current?.closest(".scroll-area");
    const tabs = root.current
      ?.closest(".project-settings-panel")
      ?.querySelector(":scope > .section-tabs");
    const measure = () => {
      if (!root.current || !input.current) return;
      const bounds = input.current.getBoundingClientRect();
      const container = root.current.getBoundingClientRect();
      const clip = viewport?.getBoundingClientRect();
      // The tabs share the scroll area with this form. Its clipping edge alone
      // is not a safe upper bound: an upward popup must leave the tabs usable.
      const top = Math.max(
        0,
        clip?.top ?? 0,
        tabs ? tabs.getBoundingClientRect().bottom + 5 : 0,
      );
      const bottom = Math.min(
        window.innerHeight,
        clip?.bottom ?? window.innerHeight,
      );
      const below = Math.max(0, bottom - bounds.bottom - 5);
      const above = Math.max(0, bounds.top - top - 5);
      const useAbove = below < 280 && above > below;
      const next = {
        above: useAbove,
        maxHeight: Math.min(280, useAbove ? above : below),
        offset: useAbove
          ? container.bottom - bounds.top + 5
          : bounds.bottom - container.top + 5,
      };
      setPopup((previous) =>
        previous.above === next.above &&
        previous.maxHeight === next.maxHeight &&
        previous.offset === next.offset
          ? previous
          : next,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    if (viewport) observer?.observe(viewport);
    if (tabs) observer?.observe(tabs);
    if (root.current) observer?.observe(root.current);
    return () => {
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
      observer?.disconnect();
    };
  }, [expanded]);

  useLayoutEffect(() => {
    if (!expanded || active < 0 || !listbox.current) return;
    const option = document.getElementById(optionId(active));
    if (!option) return;
    const list = listbox.current;
    const top = list.getBoundingClientRect().top + list.clientTop;
    const bounds = option.getBoundingClientRect();
    if (bounds.top < top) list.scrollTop += bounds.top - top;
    else if (bounds.bottom > top + list.clientHeight)
      list.scrollTop += Math.min(
        bounds.top - top,
        bounds.bottom - top - list.clientHeight,
      );
  }, [expanded, active, id, popup.maxHeight, popup.above]);

  function close() {
    setOpen(false);
    setHighlight(undefined);
  }
  function choose(index: number) {
    if (composing.current || !options[index]) return;
    onChange(options[index].id);
    close();
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (
      composing.current ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    ) {
      if (event.key === "Enter") event.preventDefault();
      return;
    }
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        setOpen(true);
        if (!options.length) break;
        const next =
          active < 0
            ? event.key === "ArrowDown"
              ? 0
              : options.length - 1
            : Math.max(
                0,
                Math.min(
                  options.length - 1,
                  active + (event.key === "ArrowDown" ? 1 : -1),
                ),
              );
        setHighlight({ key: optionKey, id: options[next].id });
        break;
      }
      case "Enter":
        if (expanded) {
          event.preventDefault();
          if (active >= 0) choose(active);
        }
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          event.stopPropagation();
        }
        close();
        break;
      case "Tab":
        close();
        break;
    }
  }
  const hint = !current
    ? "Загружаем подсказки… Имя можно ввести вручную."
    : current.status === "error"
      ? "Подсказки недоступны. Имя можно ввести вручную."
      : !options.length
        ? "Нет доступных подсказок. Имя можно ввести вручную."
        : "Выбор подставляет ID конвейера, но не проверяет содержимое рабочего процесса. Можно ввести своё имя.";

  return (
    <div className="workflow-name-input" ref={root}>
      <label htmlFor={`${id}-input`}>
        Имя рабочего процесса
        <input
          id={`${id}-input`}
          ref={input}
          value={value}
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={expanded}
          aria-controls={expanded ? `${id}-listbox` : undefined}
          aria-activedescendant={
            expanded && active >= 0 ? optionId(active) : undefined
          }
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
            setHighlight(undefined);
          }}
          onFocus={() => {
            setOpen(true);
            setHighlight(undefined);
          }}
          onBlur={close}
          onKeyDown={keyDown}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
        />
      </label>
      <p className="hint workflow-name-hint" id={`${id}-hint`}>
        {hint}
      </p>
      {expanded && (
        <div
          id={`${id}-listbox`}
          ref={listbox}
          role="listbox"
          aria-label="Подсказки имени рабочего процесса"
          className="workflow-name-popup"
          data-placement={popup.above ? "above" : "below"}
          style={{
            maxHeight: popup.maxHeight,
            top: popup.above ? "auto" : popup.offset,
            bottom: popup.above ? popup.offset : "auto",
          }}
        >
          {options.map((item, index) => (
            <div
              id={optionId(index)}
              key={item.id}
              role="option"
              aria-selected={value === item.id}
              className={`workflow-name-option${active === index ? " is-focused" : ""}`}
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() =>
                setHighlight({ key: optionKey, id: item.id })
              }
              onClick={() => choose(index)}
            >
              <span>{item.name}</span>
              <small>{item.id}.yml</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
