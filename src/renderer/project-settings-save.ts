import type { ScopeRef } from "../shared/context";
import type { ProjectSettings, ProjectSettingsView } from "../shared/types";
import { preparationErrorMessage } from "./preparation-error";

const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export interface SettingsConflict {
  fields: string[];
  mine: ProjectSettings;
  current: ProjectSettings;
}
/** Merge only edits relative to the form's captured base. Values never enter diagnostics. */
export function reconcileProjectSettings(
  base: ProjectSettings,
  draft: ProjectSettings,
  latest: ProjectSettings,
): SettingsConflict {
  const fields: string[] = [];
  function select<T>(before: T, mine: T, current: T, label: string): [T, T] {
    if (equal(mine, before)) return [current, current];
    if (equal(current, before) || equal(mine, current)) return [mine, mine];
    fields.push(label);
    return [mine, current];
  }
  const mine = { ...latest, env: [] } as ProjectSettings;
  const current = { ...latest, env: [] } as ProjectSettings;
  for (const [key, label] of [
    ["executable", "Исполняемый файл"],
    ["profile", "Профиль"],
    ["startupTimeoutMinutes", "Тайм-аут запуска"],
  ] as const) {
    const values = select(base[key], draft[key], latest[key], label);
    Object.assign(mine, { [key]: values[0] });
    Object.assign(current, { [key]: values[1] });
  }
  function rows(value: ProjectSettings) {
    const map = new Map(value.env.map((row) => [row.key, row]));
    if (
      map.size !== value.env.length ||
      value.env.some((row) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.key))
    )
      throw Error(
        "Укажите уникальные корректные имена переменных. Введённые значения сохранены в форме.",
      );
    return map;
  }
  const b = rows(base),
    d = rows(draft),
    l = rows(latest);
  for (const key of new Set([...l.keys(), ...d.keys(), ...b.keys()])) {
    const [m, c] = select(
      b.get(key),
      d.get(key),
      l.get(key),
      `Переменная ${key}`,
    );
    if (m) mine.env.push({ ...m });
    if (c) current.env.push({ ...c });
  }
  return { fields, mine, current };
}
interface Api {
  readProjectSettings(scope: ScopeRef): Promise<ProjectSettingsView>;
  saveProjectSettings(
    scope: ScopeRef,
    value: ProjectSettings,
    version: string,
  ): Promise<ProjectSettingsView>;
}
/** Retry only a confirmed CAS refusal, after a fresh read and three-way reconciliation. */
export async function saveProjectSettingsReconciled(
  api: Api,
  scope: ScopeRef,
  base: ProjectSettingsView,
  draft: ProjectSettings,
) {
  let captured = base,
    desired = draft;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return {
        document: await api.saveProjectSettings(
          scope,
          desired,
          captured.version,
        ),
        conflict: undefined,
      };
    } catch (error) {
      if (
        preparationErrorMessage(error) !==
        "Настройки изменены извне. Откройте их заново."
      )
        throw error;
      const latest = await api.readProjectSettings(scope);
      const conflict = reconcileProjectSettings(
        captured.value,
        desired,
        latest.value,
      );
      if (conflict.fields.length) return { document: latest, conflict };
      captured = latest;
      desired = conflict.mine;
    }
  }
  throw Error(
    "Настройки сейчас меняются в другом окне. Ваш ввод сохранён; повторите сохранение после завершения изменений.",
  );
}
