import { t } from "../../shared/i18n";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";

import {
  DEMO_DEFAULT_PORT,
  DEMO_DEFAULT_ENGINE,
  demoEngineSchema,
  demoPortSchema,
  type DemoEngine,
} from "../../shared/demonstrations";
export type DemoPreferences = { port: number; engine: DemoEngine };
async function readRaw(
  file: string,
  repair = false,
): Promise<Partial<Record<keyof DemoPreferences, unknown>>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { port: DEMO_DEFAULT_PORT };
    throw error;
  }
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw Error();
    return v;
  } catch {
    if (repair) return {};
    throw Error();
  }
}
export class InvalidDemoPreferences extends Error {
  constructor(
    readonly port: number,
    readonly engine: DemoEngine,
  ) {
    super(t("hostTerminal.preferencesUnavailable"));
  }
}
export async function readPreferences(file: string): Promise<DemoPreferences> {
  const raw = await readRaw(file).catch(() => {
    throw new InvalidDemoPreferences(DEMO_DEFAULT_PORT, DEMO_DEFAULT_ENGINE);
  });
  const port = demoPortSchema.safeParse(raw.port);
  const engine = demoEngineSchema
    .default(DEMO_DEFAULT_ENGINE)
    .safeParse(raw.engine);
  if (!port.success || !engine.success) {
    // Show valid fields during explicit recovery. Never use a recovered value
    // to start a browser or bind a port until the user actually repairs it.
    throw new InvalidDemoPreferences(
      port.success ? port.data : DEMO_DEFAULT_PORT,
      engine.success ? engine.data : DEMO_DEFAULT_ENGINE,
    );
  }
  return { port: port.data, engine: engine.data };
}
async function write(file: string, prefs: DemoPreferences) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(tmp, JSON.stringify(prefs) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(tmp, file);
    return prefs;
  } finally {
    await rm(tmp, { force: true });
  }
}
// Called within the runtime's serialized settings/ownership queue. Selecting
// an engine never probes, rebinds or repairs the port of a live show.
export async function saveEngine(file: string, engine: DemoEngine) {
  if (!demoEngineSchema.safeParse(engine).success)
    throw Error(t("hostTerminal.engineInvalid"));
  const prefs = await readPreferences(file);
  try {
    return await write(file, { ...prefs, engine });
  } catch {
    throw Error(t("hostTerminal.engineSaveFailed"));
  }
}
export async function savePort(file: string, port: number) {
  if (!demoPortSchema.safeParse(port).success)
    throw Error(t("hostTerminal.portRange"));
  // This check does not reserve the port: arm() checks the exact port again.
  const probe = createServer((s) => s.destroy());
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
  }).catch(() => {
    throw new Error(t("hostTerminal.portUnavailable"));
  });
  try {
    // Explicit port save also repairs a damaged file. Preserve any surviving,
    // valid engine preference; mere reads and engine edits never repair it.
    const engine = demoEngineSchema.safeParse(
      (await readRaw(file, true)).engine,
    );
    return await write(file, {
      port,
      engine: engine.success ? engine.data : DEMO_DEFAULT_ENGINE,
    });
  } catch {
    throw Error(t("hostTerminal.portSaveFailed"));
  }
}
