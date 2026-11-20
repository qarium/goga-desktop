import { t as tr } from "./i18n";
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
  value.trim().length > 0 &&
  value.length <= 256 &&
  !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value);

/** Only bounded display fields leave the status parser. Stage bodies may contain
 * arbitrary instructions/output and are never copied into an attachment. */
const displayText = (value: unknown, max: number): string | undefined =>
  typeof value === "string"
    ? value
        .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
        .trim()
        .slice(0, max) || undefined
    : undefined;

export interface DashboardStatus {
  runId: string;
  name: string;
  description?: string;
  startedAt?: string;
  status?: string;
  terminal: boolean;
}

export async function readDashboardStatus(
  origin: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<DashboardStatus> {
  if (!allowedDashboardURL(origin))
    throw Error(tr("host.invalidPipelineDashboardAddress"));
  const controller = new AbortController();
  const unavailable = () =>
    Error(
      tr("host.couldNotVerifyTheDashboardForThisRunTheProcess"),
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
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const read = async () => {
    if (controller.signal.aborted) throw unavailable();
    const endpoint = `${new URL(origin).origin}/api/status`;
    const response = await fetcher(endpoint, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
    });
    const max = 2 * 1024 * 1024;
    if (
      controller.signal.aborted ||
      !response.ok ||
      response.redirected ||
      (!!response.url && response.url !== endpoint) ||
      !response.body ||
      Number(response.headers.get("content-length")) > max
    ) {
      void response.body?.cancel().catch(() => {});
      throw unavailable();
    }
    reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const next = await reader.read();
      if (controller.signal.aborted) throw unavailable();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > max) throw unavailable();
      if (next.value.byteLength) chunks.push(next.value);
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
    const data = body as Record<string, unknown>;
    const status = displayText(data.run_status, 64);
    const startedAt = displayText(data.started_at, 64);
    return {
      runId: body.run_id,
      name: displayText(data.flow_name, 128) ?? body.run_id,
      description: displayText(data.description, 1024),
      startedAt:
        startedAt && Number.isFinite(Date.parse(startedAt))
          ? startedAt
          : undefined,
      status,
      terminal:
        !!data.ended_at ||
        status === "finished" ||
        status === "failed" ||
        status === "interrupted",
    };
  };
  try {
    return await Promise.race([read(), cancelled]);
  } catch {
    throw unavailable();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

/** Server identity is only one factor; the host separately proves process ownership. */
export async function readDashboardIdentity(
  origin: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  return (await readDashboardStatus(origin, signal, fetcher)).runId;
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
