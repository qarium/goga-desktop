import { runSmokeCommand } from "./smoke-command.mjs";
import { performance } from "node:perf_hooks";
const execute = runSmokeCommand;
/** A monotonic total deadline. Callers reserve a separate finite cleanup budget. */
export function smokeBudget(
  milliseconds,
  { now = () => performance.now(), run = execute } = {},
) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0)
    throw Error("Invalid smoke budget");
  const deadline = now() + milliseconds;
  const check = () => {
    const remaining = Math.floor(deadline - now());
    if (remaining <= 0)
      throw Error("Release smoke deadline exceeded; verification incomplete");
    return remaining;
  };
  return {
    check,
    async run(file, args, options = {}) {
      const result = await run(file, args, {
        ...options,
        timeout: Math.min(options.timeout ?? 90000, 90000, check()),
      });
      check();
      return result;
    },
  };
}
