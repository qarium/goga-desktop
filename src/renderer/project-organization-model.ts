/** Presentation order only. Never authorizes an operation on a project. */
export interface ProjectGroup {
  id: string;
  name: string;
  collapsed: boolean;
  projectIds: string[];
}
export interface ProjectOrganization {
  schemaVersion: 1;
  groups: ProjectGroup[];
  ungroupedProjectIds: string[];
}
export const emptyOrganization = (): ProjectOrganization => ({
  schemaVersion: 1,
  groups: [],
  ungroupedProjectIds: [],
});
export type OrganizationCommand =
  | { type: "createGroup" | "renameGroup"; id: string; name: string }
  | { type: "dissolveGroup"; id: string }
  | { type: "setCollapsed"; id: string; collapsed: boolean }
  | {
      type: "moveProject";
      id: string;
      groupId: string | null;
      anchor?: string;
      side?: "before" | "after";
    }
  | { type: "moveGroup"; id: string; anchor: string; side: "before" | "after" };
export const orderedProjectIds = (o: ProjectOrganization) => [
  ...o.groups.flatMap((g) => g.projectIds),
  ...o.ungroupedProjectIds,
];
export function validGroupName(value: string) {
  return (
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 40 &&
    !/[\x00-\x1F\x7F]/.test(value)
  );
}
const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => b[i] === v);
export function reconcileOrganization(
  o: ProjectOrganization,
  ids: readonly string[],
  ready: boolean,
): ProjectOrganization {
  if (!ready) return o;
  const available = new Set(ids);
  const take = (list: string[]) => {
    const next = list.filter((id) => available.delete(id));
    return same(next, list) ? list : next;
  };
  const groups = o.groups.map((g) => {
    const projectIds = take(g.projectIds);
    return projectIds === g.projectIds ? g : { ...g, projectIds };
  });
  let loose = take(o.ungroupedProjectIds);
  if (available.size) loose = [...loose, ...available];
  return loose === o.ungroupedProjectIds &&
    groups.every((g, i) => g === o.groups[i])
    ? o
    : { ...o, groups, ungroupedProjectIds: loose };
}
export function applyOrganizationCommand(
  o: ProjectOrganization,
  c: OrganizationCommand,
): ProjectOrganization {
  const group = o.groups.find((g) => g.id === c.id);
  switch (c.type) {
    case "createGroup":
    case "renameGroup": {
      const name = c.name.trim();
      if (!validGroupName(name))
        throw Error("Введите название группы — от 1 до 40 символов.");
      if (
        o.groups.some(
          (g) =>
            g.name.toLocaleLowerCase() === name.toLocaleLowerCase() &&
            !(c.type === "renameGroup" && g.id === c.id),
        )
      )
        throw Error("Группа с таким названием уже есть.");
      if (c.type === "createGroup") {
        if (!c.id || group) throw Error("Такая группа уже существует.");
        return {
          ...o,
          groups: [
            ...o.groups,
            { id: c.id, name, collapsed: false, projectIds: [] },
          ],
        };
      }
      return !group || group.name === name
        ? o
        : {
            ...o,
            groups: o.groups.map((g) => (g === group ? { ...g, name } : g)),
          };
    }
    case "setCollapsed":
      return !group || group.collapsed === c.collapsed
        ? o
        : {
            ...o,
            groups: o.groups.map((g) =>
              g === group ? { ...g, collapsed: c.collapsed } : g,
            ),
          };
    case "dissolveGroup":
      return group
        ? {
            ...o,
            groups: o.groups.filter((g) => g !== group),
            ungroupedProjectIds: [
              ...o.ungroupedProjectIds,
              ...group.projectIds,
            ],
          }
        : o;
    case "moveGroup": {
      if (
        !group ||
        c.anchor === c.id ||
        !o.groups.some((g) => g.id === c.anchor)
      )
        return o;
      const groups = o.groups.filter((g) => g !== group);
      groups.splice(
        groups.findIndex((g) => g.id === c.anchor) +
          (c.side === "after" ? 1 : 0),
        0,
        group,
      );
      return groups.every((g, i) => g === o.groups[i]) ? o : { ...o, groups };
    }
    case "moveProject": {
      const to =
        c.groupId === null
          ? o.ungroupedProjectIds
          : o.groups.find((g) => g.id === c.groupId)?.projectIds;
      if (
        !to ||
        !orderedProjectIds(o).includes(c.id) ||
        c.anchor === c.id ||
        (c.anchor !== undefined && !to.includes(c.anchor))
      )
        return o;
      const remove = (list: string[]) =>
        list.includes(c.id) ? list.filter((id) => id !== c.id) : list;
      const newTo = to.filter((id) => id !== c.id);
      const pos =
        c.anchor === undefined
          ? newTo.length
          : newTo.indexOf(c.anchor) + (c.side === "before" ? 0 : 1);
      newTo.splice(pos, 0, c.id);
      const target = o.groups.find((g) => g.id === c.groupId);
      if (same(newTo, to) && !target?.collapsed) return o;
      return {
        ...o,
        groups: o.groups.map((g) => {
          if (g === target)
            return { ...g, projectIds: newTo, collapsed: false };
          const projectIds = remove(g.projectIds);
          return projectIds === g.projectIds ? g : { ...g, projectIds };
        }),
        ungroupedProjectIds:
          c.groupId === null ? newTo : remove(o.ungroupedProjectIds),
      };
    }
  }
}
