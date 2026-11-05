import type { Run } from "./types";
/** Deliberately narrower than URL's permissive host normalization. */
export function allowedDashboardURL(value: string): boolean {
  if (
    !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/?$/.test(
      value,
    )
  )
    return false;
  try {
    const url = new URL(value);
    return Number(url.port) > 0 && Number(url.port) <= 65535;
  } catch {
    return false;
  }
}
export const dashboardServerId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value);

/** Server identity is only one factor; the host separately proves process ownership. */
export async function readDashboardIdentity(
  origin: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!allowedDashboardURL(origin))
    throw Error("Недопустимый адрес панели конвейера.");
  const controller = new AbortController();
  const unavailable = () =>
    Error(
      "Не удалось подтвердить панель этого запуска. Процесс не перезапускался.",
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => {
      controller.abort();
      reject(unavailable());
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(abort, 5000);
  });
  const read = async () => {
    if (controller.signal.aborted) throw unavailable();
    const response = await fetcher(`${new URL(origin).origin}/api/status`, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
    });
    if (!response.ok || response.redirected || !response.body)
      throw unavailable();
    const max = 2 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > max)
      throw unavailable();
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > max) throw unavailable();
        chunks.push(next.value);
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const raw = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      raw.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (
      !body ||
      typeof body !== "object" ||
      !("run_id" in body) ||
      !dashboardServerId(body.run_id) ||
      !("stages" in body) ||
      !Array.isArray(body.stages)
    )
      throw unavailable();
    return body.run_id;
  };
  try {
    return await Promise.race([read(), cancelled]);
  } catch {
    throw unavailable();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

/** Host-issued capability; never inferred from a URL supplied by the renderer. */
export function dashboardRecoveryAllowed(run: Run): boolean {
  return (
    !run.recovery ||
    (run.recovery === "confirmed" &&
      run.dashboardRecoveryVersion === 1 &&
      run.dashboardReconnect === true &&
      dashboardServerId(run.dashboardRunId))
  );
}
