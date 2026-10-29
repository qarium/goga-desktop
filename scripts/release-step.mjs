import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, appendFile } from "node:fs/promises";
import { runSmokeCommand } from "./smoke-command.mjs";

/** Fixed build phases only: no user-provided command, retry or publication. */
export async function runReleaseStep(
  phase,
  {
    root = process.cwd(),
    arch = process.env.EXPECTED_ARCH,
    env = process.env,
    now = () => performance.now(),
    run = runSmokeCommand,
    write = (text) => process.stdout.write(text),
  } = {},
) {
  const phases = {
    install: { args: ["ci"], timeout: 180000 },
    build: { args: ["run", "build"], timeout: 420000 },
    package: {
      args: ["run", "package:release", "--", `--${arch}`],
      timeout: 240000,
    },
  };
  if (!Object.hasOwn(phases, phase) || !["arm64", "x64"].includes(arch))
    throw Error("Invalid release phase or native architecture");
  const config = phases[phase];
  const directory = path.join(root, "work/release-report");
  await mkdir(directory, { recursive: true });
  const record = (event) =>
    appendFile(
      path.join(directory, "phases.jsonl"),
      JSON.stringify(event) + "\n",
      { mode: 0o600 },
    );
  const started = now();
  await record({ phase, arch, status: "running" });
  write(
    `Release phase ${phase} (${arch}) started; budget ${config.timeout / 1000}s\n`,
  );
  try {
    const result = await run("npm", config.args, {
      cwd: root,
      env,
      timeout: config.timeout,
    });
    write(result.stdout ?? "");
    write(result.stderr ?? "");
    await record({
      phase,
      arch,
      status: "success",
      durationMs: Math.max(0, now() - started),
    });
    return result;
  } catch (error) {
    await record({
      phase,
      arch,
      status: "failed",
      durationMs: Math.max(0, now() - started),
    });
    throw error;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [phase, ...extra] = process.argv.slice(2);
  if (extra.length) {
    console.error("Usage: node scripts/release-step.mjs install|build|package");
    process.exitCode = 1;
  } else
    await runReleaseStep(phase).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
