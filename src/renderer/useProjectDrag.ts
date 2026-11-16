import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { OrganizationCommand } from "./project-organization-model";
type Item = { kind: "group" | "project"; id: string; label: string };
type Target = Extract<
  OrganizationCommand,
  { type: "moveProject" | "moveGroup" }
>;
export function projectDropAt(
  item: Item,
  el: Element | null,
  y: number,
): Target | null {
  if (!el) return null;
  if (item.kind === "group") {
    const g = el.closest<HTMLElement>("[data-group-target]");
    if (!g || g.dataset.groupTarget === item.id) return null;
    const r = g.getBoundingClientRect();
    return {
      type: "moveGroup",
      id: item.id,
      anchor: g.dataset.groupTarget!,
      side: y < r.top + r.height / 2 ? "before" : "after",
    };
  }
  const row = el.closest<HTMLElement>("[data-project-target]");
  if (row) {
    if (row.dataset.projectTarget === item.id) return null;
    const r = row.getBoundingClientRect();
    return {
      type: "moveProject",
      id: item.id,
      groupId: row.dataset.owner || null,
      anchor: row.dataset.projectTarget,
      side: y < r.top + r.height / 2 ? "before" : "after",
    };
  }
  const group = el.closest<HTMLElement>("[data-drop-group]");
  return group
    ? {
        type: "moveProject",
        id: item.id,
        groupId: group.dataset.dropGroup || null,
      }
    : null;
}
interface Drag {
  item: Item;
  target: Target | null;
  x: number;
  y: number;
}
export function useProjectDrag(
  scroll: RefObject<HTMLElement | null>,
  onDrop: (c: Target) => void,
  catalogVersion: string,
) {
  const drop = useRef(onDrop);
  drop.current = onDrop;
  const pending = useRef<{
    item: Item;
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    active: boolean;
  } | null>(null);
  const [view, setView] = useState<Drag | null>(null);
  useEffect(() => {
    let frame = 0;
    const at = (item: Item, x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      return scroll.current?.contains(el) ? projectDropAt(item, el, y) : null;
    };
    const clear = () => {
      pending.current = null;
      cancelAnimationFrame(frame);
      frame = 0;
      document.body.classList.remove("sidebar-project-dragging");
      setView(null);
    };
    clear();
    const paint = () => {
      const p = pending.current;
      if (!p?.active) return;
      setView({ item: p.item, target: at(p.item, p.x, p.y), x: p.x, y: p.y });
    };
    const autoScroll = () => {
      const p = pending.current,
        el = scroll.current;
      if (!p?.active || !el) return;
      const r = el.getBoundingClientRect();
      if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) {
        const dy = p.y < r.top + 32 ? -7 : p.y > r.bottom - 32 ? 7 : 0;
        if (dy) {
          const previous = el.scrollTop;
          el.scrollTop += dy;
          if (el.scrollTop !== previous) paint();
        }
      }
      frame = requestAnimationFrame(autoScroll);
    };
    const move = (e: PointerEvent) => {
      const p = pending.current;
      if (!p || e.pointerId !== p.pointerId) return;
      p.x = e.clientX;
      p.y = e.clientY;
      if (!p.active) {
        if (Math.hypot(p.x - p.startX, p.y - p.startY) < 6) return;
        p.active = true;
        document.body.classList.add("sidebar-project-dragging");
        frame = requestAnimationFrame(autoScroll);
      }
      e.preventDefault();
      paint();
    };
    const up = (e: PointerEvent) => {
      const p = pending.current;
      if (!p || e.pointerId !== p.pointerId) return;
      const cmd = p.active ? at(p.item, e.clientX, e.clientY) : null;
      clear();
      if (cmd) drop.current(cmd);
    };
    const cancel = (e: PointerEvent) => {
      if (pending.current?.pointerId === e.pointerId) clear();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && pending.current) {
        e.preventDefault();
        e.stopPropagation();
        clear();
      }
    };
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", clear);
    return () => {
      pending.current = null;
      cancelAnimationFrame(frame);
      document.body.classList.remove("sidebar-project-dragging");
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", clear);
    };
  }, [scroll, catalogVersion]);
  return {
    view,
    start(e: ReactPointerEvent, item: Item) {
      if (e.button !== 0 || pending.current) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).focus();
      pending.current = {
        item,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        active: false,
      };
    },
  };
}
