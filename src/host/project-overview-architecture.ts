import { t as tr } from "../shared/i18n";
import { CommandExitError, type Runner } from "./process";
import { basename } from "node:path";
export { buildArchitectureIndex } from "../shared/project-architecture";
import { assertReadActive } from "./read-scope";
import {
  assertOverviewSchemaBounds,
  isNavigableArchitecturePath,
  OVERVIEW_ARCHITECTURE_LIMITS,
  overviewContractSchema,
  overviewSchemaSchema,
  type SchemaCell,
  type CellContract,
} from "../shared/project-architecture";

async function readJson(
  runner: Runner,
  executable: string,
  root: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<unknown> {
  assertReadActive();
  // NodeRunner owns process limits, timeout and request-local cancellation.
  // Never combine stderr (plugin diagnostics) with the public JSON stdout.
  let stdout: string;
  try {
    ({ stdout } = await (env === undefined
      ? runner.command(executable, args, root)
      : runner.command(executable, args, root, env)));
  } catch (error) {
    assertReadActive();
    // Only enrich a confirmed process exit, not cancellation, shutdown or
    // other lifecycle failures. Streams remain host-only diagnostic data.
    if (!(error instanceof CommandExitError)) throw error;
    const word = (value: string) =>
      /^[\w./-]+$/.test(value) ? value : JSON.stringify(value);
    const command = [basename(executable), ...args].map(word).join(" ");
    throw new CommandExitError(
      error.exitCode === null
        ? tr("host.theCommandCommandWasInterruptedByASignal", { command: command })
        : tr("host.theCommandCommandExitedWithCodeExitcode", { command: command, exitCode: error.exitCode }),
      error.exitCode,
      error.stdout,
      error.stderr,
    );
  }
  assertReadActive();
  if (
    Buffer.byteLength(stdout, "utf8") > OVERVIEW_ARCHITECTURE_LIMITS.outputBytes
  )
    throw Error(tr("host.theGogaResponseExceedsTheOverviewSizeLimit"));
  try {
    return JSON.parse(stdout);
  } catch {
    throw Error(tr("host.gogaReturnedInvalidOverviewJson"));
  }
}

export async function readOverviewSchema(
  runner: Runner,
  executable: string,
  root: string,
  env?: NodeJS.ProcessEnv,
): Promise<SchemaCell[]> {
  const raw = await readJson(runner, executable, root, ["schema"], env);
  assertOverviewSchemaBounds(raw);
  const parsed = overviewSchemaSchema.safeParse(raw);
  if (!parsed.success)
    throw Error(tr("host.gogaReturnedAnInvalidSchemaStructure"));
  return parsed.data;
}

export async function readOverviewContract(
  runner: Runner,
  executable: string,
  root: string,
  cell: string,
  env?: NodeJS.ProcessEnv,
): Promise<CellContract> {
  if (!isNavigableArchitecturePath(cell))
    throw Error(tr("host.invalidContractPath"));
  const raw = await readJson(
    runner,
    executable,
    root,
    ["contract", "--", cell],
    env,
  );
  const parsed = overviewContractSchema.safeParse(raw);
  if (!parsed.success || !Object.hasOwn(parsed.data, cell))
    throw Error(
      tr("host.gogaReturnedAnInvalidContractStructureForTheSelectedPath"),
    );
  return parsed.data[cell];
}
