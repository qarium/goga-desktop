import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { Topic } from "../shared/types";
import "./TopicSelect.css";

export interface TopicSelectProps {
  topics: Topic[];
  value: string;
  onChange: (value: string) => void;
  currentBranch: string;
  disabled?: boolean;
}

function TopicLines({
  topic,
  currentBranch,
}: {
  topic: Topic;
  currentBranch: string;
}) {
  return (
    <span className="topic-select-lines">
      <span className="topic-select-line">
        <span className="topic-select-key">Топик</span>
        <span className="topic-select-value" title={topic.topic}>
          {topic.topic}
        </span>
      </span>
      <span className="topic-select-line">
        <span className="topic-select-key">Ветка</span>
        <span
          className="topic-select-value topic-select-branch"
          title={topic.branch}
        >
          {topic.branch}
        </span>
      </span>
      {topic.branch === currentBranch && (
        <span className="topic-select-current">Текущая ветка</span>
      )}
    </span>
  );
}

export function TopicSelect({
  topics,
  value,
  onChange,
  currentBranch,
  disabled = false,
}: TopicSelectProps) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listbox = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(0);
  const [popup, setPopup] = useState({
    above: false,
    maxHeight: 320,
    offset: 0,
  });
  const selected = topics.findIndex((_, index) => String(index) === value);
  const unavailable = disabled || topics.length === 0;
  const expanded = open && !unavailable;
  const active = Math.min(focused, topics.length - 1);
  const optionId = (index: number) => `${id}-option-${index}`;
  // Native fieldset disabling also applies when a popup is already open.
  const isDisabled = () =>
    unavailable || !!trigger.current?.matches(":disabled");

  useLayoutEffect(() => {
    if (!expanded) return;
    const viewport = root.current?.closest(".scroll-area");
    const measure = () => {
      if (!root.current || !trigger.current) return;
      const bounds = trigger.current.getBoundingClientRect();
      const container = root.current.getBoundingClientRect();
      const clip = viewport?.getBoundingClientRect();
      const top = Math.max(0, clip?.top ?? 0);
      const bottom = Math.min(
        window.innerHeight,
        clip?.bottom ?? window.innerHeight,
      );
      const below = Math.max(0, bottom - bounds.bottom - 5);
      const above = Math.max(0, bounds.top - top - 5);
      const useAbove = below < 320 && above > below;
      const next = {
        above: useAbove,
        maxHeight: Math.min(320, useAbove ? above : below),
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
    if (root.current) observer?.observe(root.current);
    return () => {
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
      observer?.disconnect();
    };
  }, [expanded]);

  useEffect(() => {
    const fieldsets: Element[] = [];
    for (
      let parent = root.current?.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      if (parent.tagName === "FIELDSET") fieldsets.push(parent);
    }
    const observer = new MutationObserver(() => {
      if (trigger.current?.matches(":disabled")) setOpen(false);
    });
    for (const fieldset of fieldsets)
      observer.observe(fieldset, {
        attributes: true,
        attributeFilter: ["disabled"],
      });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (unavailable) setOpen(false);
  }, [unavailable]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);

  useLayoutEffect(() => {
    if (!expanded || !listbox.current) return;
    const option = document.getElementById(optionId(active));
    if (!option) return;
    const list = listbox.current;
    const visibleTop = list.getBoundingClientRect().top + list.clientTop;
    const visibleBottom = visibleTop + list.clientHeight;
    const bounds = option.getBoundingClientRect();
    // Keep the outer form stationary: scrollIntoView also scrolls ancestors.
    if (bounds.top < visibleTop) list.scrollTop += bounds.top - visibleTop;
    else if (bounds.bottom > visibleBottom)
      list.scrollTop += Math.min(
        bounds.top - visibleTop,
        bounds.bottom - visibleBottom,
      );
  }, [expanded, active, id, popup.maxHeight, popup.above]);

  function show(index = selected < 0 ? 0 : selected) {
    if (isDisabled()) return;
    setFocused(index);
    setOpen(true);
  }
  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }
  function choose(index: number) {
    if (isDisabled() || !topics[index]) return;
    onChange(String(index));
    close(true);
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (isDisabled()) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        if (!expanded) show();
        else
          setFocused(
            Math.max(
              0,
              Math.min(
                topics.length - 1,
                active + (event.key === "ArrowDown" ? 1 : -1),
              ),
            ),
          );
        break;
      case "Home":
      case "End":
        event.preventDefault();
        show(event.key === "Home" ? 0 : topics.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (expanded) choose(active);
        else show();
        break;
      case "Escape":
        if (expanded) {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
        break;
      case "Tab":
        close();
        break;
    }
  }

  return (
    <div
      className="topic-select"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <label
        className="topic-select-label"
        id={`${id}-label`}
        htmlFor={`${id}-trigger`}
      >
        Топик проекта
      </label>
      <button
        id={`${id}-trigger`}
        ref={trigger}
        type="button"
        className="topic-select-trigger"
        role="combobox"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-value`}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={expanded ? `${id}-listbox` : undefined}
        aria-activedescendant={expanded ? optionId(active) : undefined}
        disabled={unavailable}
        onClick={() => {
          if (!isDisabled()) expanded ? close() : show();
        }}
        onKeyDown={keyDown}
      >
        <span id={`${id}-value`}>
          {selected >= 0 ? (
            <TopicLines
              topic={topics[selected]}
              currentBranch={currentBranch}
            />
          ) : (
            <span>
              {topics.length ? "Выберите топик" : "Нет существующих топиков"}
            </span>
          )}
        </span>
        <span className="topic-select-arrow" aria-hidden="true" />
      </button>
      {expanded && (
        <div
          id={`${id}-listbox`}
          ref={listbox}
          className="topic-select-popup"
          data-placement={popup.above ? "above" : "below"}
          style={{
            maxHeight: popup.maxHeight,
            top: popup.above ? "auto" : popup.offset,
            bottom: popup.above ? popup.offset : "auto",
          }}
          role="listbox"
          aria-labelledby={`${id}-label`}
        >
          {topics.map((topic, index) => (
            <div
              id={optionId(index)}
              key={`${topic.branch}-${topic.topic}-${index}`}
              className={`topic-select-option${index === active ? " is-focused" : ""}`}
              role="option"
              aria-selected={index === selected}
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => setFocused(index)}
              onClick={() => choose(index)}
            >
              <TopicLines topic={topic} currentBranch={currentBranch} />
              {index === selected && (
                <span className="topic-select-selected" aria-hidden="true">
                  ✓
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
