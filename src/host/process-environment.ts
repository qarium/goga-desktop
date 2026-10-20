/** Per-child policy only. Never changes process.env or a user's Git configuration. */
export const gitRedirectKeys = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const;
const configInjection = (key: string) =>
  key === "GIT_CONFIG_COUNT" ||
  key === "GIT_CONFIG_PARAMETERS" ||
  /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key);
export function childEnvironment(
  inherited: NodeJS.ProcessEnv,
  defaults: NodeJS.ProcessEnv = {},
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const ambient = { ...inherited };
  for (const key of Object.keys(ambient))
    if (configInjection(key)) delete ambient[key];
  const result = { ...ambient, ...defaults, ...overrides };
  for (const key of Object.keys(result))
    if (configInjection(key)) delete result[key];
  for (const key of gitRedirectKeys) delete result[key];
  return result;
}
export function assertContextEnvironment(
  rows: readonly { key: string; value: string }[],
) {
  if (
    rows.some(
      ({ key }) =>
        (gitRedirectKeys as readonly string[]).includes(key) ||
        configInjection(key),
    )
  )
    throw new Error(
      "Переменные перенаправления Git недопустимы для контекста топика.",
    );
}
