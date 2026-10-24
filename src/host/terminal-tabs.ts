import {
  terminalContextFromKey,
  terminalContextKey,
  terminalContextSchema,
  terminalProjectTabsSchema,
  terminalTabMatches,
  terminalTabSchema,
  type TerminalContext,
  type TerminalTab,
  type TerminalProjectTabs,
} from "../shared/terminal";
const invalid = () =>
  Error("Вкладка недоступна в выбранном контексте терминала.");
export const visibleTerminalTabs = (
  tabs: TerminalTab[],
  context: TerminalContext,
): TerminalTab[] => tabs.filter((t) => terminalTabMatches(t, context));
export function nextTerminalName(tabs: TerminalTab[]): string {
  const used = new Set(tabs.map((t) => t.name));
  if (!used.has("console")) return "console";
  for (let n = 1; ; n++)
    if (!used.has(`console (${n})`)) return `console (${n})`;
}
/** Swap adjacent visible entries; hidden positions and relative order stay intact. */
export function moveTerminalTab(
  tabs: TerminalTab[],
  context: TerminalContext,
  id: string,
  direction: "left" | "right",
): TerminalTab[] {
  if (direction !== "left" && direction !== "right") throw invalid();
  const visible = visibleTerminalTabs(tabs, context),
    current = visible.findIndex((t) => t.id === id);
  if (current < 0) throw invalid();
  const neighbor = visible[current + (direction === "left" ? -1 : 1)],
    result = [...tabs];
  if (neighbor) {
    const a = result.findIndex((t) => t.id === id),
      b = result.findIndex((t) => t.id === neighbor.id);
    [result[a], result[b]] = [result[b], result[a]];
  }
  return result;
}
/** Move across visible slots in one transaction; other contexts retain their slots. */
export function reorderTerminalTab(
  tabs: TerminalTab[],
  context: TerminalContext,
  id: string,
  targetId: string,
): TerminalTab[] {
  const visible = visibleTerminalTabs(tabs, context);
  const from = visible.findIndex((t) => t.id === id),
    to = visible.findIndex((t) => t.id === targetId);
  if (from < 0 || to < 0) throw invalid();
  const reordered = [...visible];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  const visibleIds = new Set(visible.map((t) => t.id));
  let index = 0;
  return tabs.map((t) => (visibleIds.has(t.id) ? reordered[index++] : t));
}
export function createTerminalTab(
  state: TerminalProjectTabs,
  context: TerminalContext,
  kind: "common" | "context",
  id: string,
): TerminalProjectTabs {
  const next = terminalProjectTabsSchema.parse(state),
    owner = terminalContextSchema.parse(context);
  if (next.tabs.some((t) => t.projectId !== owner.projectId || t.id === id))
    throw invalid();
  if (kind !== "common" && kind !== "context") throw invalid();
  const tab = terminalTabSchema.parse({
    id,
    projectId: owner.projectId,
    name: nextTerminalName(next.tabs),
    scope: kind === "common" ? { kind } : { kind, context: owner },
  });
  next.initialized = true;
  next.tabs.push(tab);
  next.selectedByContext[terminalContextKey(owner)] = tab.id;
  return terminalProjectTabsSchema.parse(next);
}
export function initializeTerminalProject(
  state: TerminalProjectTabs,
  context: TerminalContext,
  id: string,
): TerminalProjectTabs {
  const valid = terminalProjectTabsSchema.parse(state);
  return valid.initialized
    ? valid
    : createTerminalTab(valid, context, "common", id);
}
export function renameTerminalTab(
  state: TerminalProjectTabs,
  id: string,
  name: string,
): TerminalProjectTabs {
  const next = terminalProjectTabsSchema.parse(state),
    index = next.tabs.findIndex((t) => t.id === id);
  if (index < 0) throw invalid();
  next.tabs[index] = terminalTabSchema.parse({ ...next.tabs[index], name });
  return next;
}
export function selectTerminalTab(
  state: TerminalProjectTabs,
  context: TerminalContext,
  id: string,
): TerminalProjectTabs {
  const next = terminalProjectTabsSchema.parse(state),
    owner = terminalContextSchema.parse(context);
  if (!visibleTerminalTabs(next.tabs, owner).some((t) => t.id === id))
    throw invalid();
  next.selectedByContext[terminalContextKey(owner)] = id;
  return next;
}
/** Metadata only. Caller must complete confirmed session shutdown before removing a tab. */
export function removeTerminalTab(
  state: TerminalProjectTabs,
  id: string,
): TerminalProjectTabs {
  const next = terminalProjectTabsSchema.parse(state);
  if (!next.tabs.some((t) => t.id === id)) throw invalid();
  next.tabs = next.tabs.filter((t) => t.id !== id);
  for (const [key, selected] of Object.entries(next.selectedByContext))
    if (selected === id) {
      const fallback = visibleTerminalTabs(
        next.tabs,
        terminalContextFromKey(key),
      )[0];
      if (fallback) next.selectedByContext[key] = fallback.id;
      else delete next.selectedByContext[key];
    }
  return terminalProjectTabsSchema.parse(next);
}
