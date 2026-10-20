export const DEFAULT_STARTUP_TIMEOUT_MINUTES = 10;
export const MIN_STARTUP_TIMEOUT_MINUTES = 1;
export const MAX_STARTUP_TIMEOUT_MINUTES = 120;

export function isStartupTimeoutMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= MIN_STARTUP_TIMEOUT_MINUTES &&
    value <= MAX_STARTUP_TIMEOUT_MINUTES
  );
}
