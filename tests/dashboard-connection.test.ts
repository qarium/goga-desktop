import { describe, it, expect, vi } from "vitest";
import { AttachedDashboards } from "../src/main/attached-dashboards";
import {
  allowedDashboardURL,
  readDashboardIdentity,
} from "../src/shared/dashboard-connection";

describe("trusted dashboard identity", () => {
  it("accepts only explicit loopback root origins", () => {
    expect(allowedDashboardURL("http://127.0.0.1:8123/")).toBe(true);
    for (const value of [
      "https://127.0.0.1:8123",
      "http://127.1:8123",
      "http://localhost:8123/?token=x",
      "http://user@localhost:8123",
      "http://localhost:8123/path",
      "http://localhost:65536",
    ])
      expect(allowedDashboardURL(value)).toBe(false);
  });
  it("reads only bounded read-only status without redirects or credentials", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ run_id: "afm-1", stages: [] })),
    );
    expect(
      await readDashboardIdentity("http://localhost:8123/", undefined, fetcher),
    ).toBe("afm-1");
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:8123/api/status",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        credentials: "omit",
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it("rejects missing identity, bad shape, redirected responses and oversized bodies", async () => {
    for (const body of [
      { stages: [] },
      { run_id: "other\nrun", stages: [] },
      { run_id: "r" },
      { run_id: "r", stages: [], padding: "x".repeat(2 * 1024 * 1024) },
    ]) {
      await expect(
        readDashboardIdentity(
          "http://localhost:8123",
          undefined,
          async () => new Response(JSON.stringify(body)),
        ),
      ).rejects.toThrow();
    }
    const response = new Response(JSON.stringify({ run_id: "r", stages: [] }));
    Object.defineProperty(response, "redirected", { value: true });
    await expect(
      readDashboardIdentity(
        "http://localhost:8123",
        undefined,
        async () => response,
      ),
    ).rejects.toThrow();
  });
  it("rejects a different endpoint even when the transport reports no redirect", async () => {
    const substituted = new Response(
      JSON.stringify({ run_id: "substitute", stages: [] }),
    );
    Object.defineProperty(substituted, "url", {
      value: "http://localhost:8124/api/status",
    });
    await expect(
      readDashboardIdentity(
        "http://localhost:8123",
        undefined,
        async () => substituted,
      ),
    ).rejects.toThrow();
  });
  it("cancels the body on declared overflow or a mid-stream abort", async () => {
    for (const oversized of [true, false]) {
      const cancel = vi.fn();
      let started!: () => void;
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      const body = new ReadableStream<Uint8Array>({ pull: started, cancel });
      const answer = new Response(body, {
        headers: oversized
          ? { "content-length": String(2 * 1024 * 1024 + 1) }
          : {},
      });
      const controller = new AbortController();
      const outcome = expect(
        readDashboardIdentity(
          "http://localhost:8123",
          controller.signal,
          async () => answer,
        ),
      ).rejects.toThrow();
      if (!oversized) {
        await reading;
        controller.abort();
      }
      await outcome;
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    }
  });
  it("aborts on caller cancellation and has a finite deadline even for a stuck transport", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(async () => new Response("{}"));
    await expect(
      readDashboardIdentity(
        "http://localhost:8123",
        controller.signal,
        fetcher,
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    vi.useFakeTimers();
    try {
      const result = readDashboardIdentity(
        "http://localhost:8123",
        undefined,
        () => new Promise(() => {}),
      );
      const failure = expect(result).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(5001);
      await failure;
    } finally {
      vi.useRealTimers();
    }
  });
});

const url = "http://127.0.0.1:49152";
const project = { projectId: "p" };
const topic = {
  projectId: "p",
  context: {
    projectId: "p",
    year: "2026",
    topic: "feature",
    branch: "t/feature",
    contextId: "ctx-" + "a".repeat(64),
    revision: "2753444e-d054-4561-a773-a2e3dc2ace04",
  },
};
const response = (extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ run_id: "run-1", stages: [], ...extra }));

describe("attached external dashboards", () => {
  it("uses only the explicit local status endpoint and only copies documented display fields", async () => {
    const meta = {
      flow_name: "Editor",
      description: "Проверка",
      started_at: "2026-11-01T12:30:00Z",
      run_status: "running",
      cwd: "/not-authority",
      process: { pid: 123 },
    };
    const fetcher = vi.fn(async () => response(meta));
    const tabs = new AttachedDashboards(fetcher);
    const item = await tabs.attach(topic, "➜ dashboard: " + url + "/");
    expect(item).toEqual({
      id: expect.stringMatching(/^attached:/),
      owner: topic,
      url,
      runId: "run-1",
      name: "Editor",
      description: "Проверка",
      startedAt: meta.started_at,
      status: "running",
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      url + "/api/status",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      }),
    );
    item.owner.context!.topic = "changed";
    expect(tabs.get(topic, item.id)?.owner.context?.topic).toBe("feature");
    expect(tabs.all()).toEqual(tabs.list(topic));
  });
  it("deduplicates exact pins, never flow titles, and refuses reassignment across owners", async () => {
    const fetcher = vi.fn(async () => response({ flow_name: "Build" }));
    const tabs = new AttachedDashboards(fetcher);
    const first = await tabs.attach(topic, url);
    const newRevision = {
      ...topic,
      context: {
        ...topic.context,
        revision: "96097673-4803-4395-a505-7a21cca7292e",
      },
    };
    expect((await tabs.attach(newRevision, url + "/")).id).toBe(first.id);
    expect(tabs.get(newRevision, first.id)?.owner).toEqual(newRevision);
    for (const other of [
      project,
      { projectId: "q" },
      { ...topic, context: { ...topic.context, year: "2025" } },
    ]) {
      expect(tabs.list(other)).toEqual([]);
      expect(tabs.get(other, first.id)).toBeUndefined();
      await expect(tabs.attach(other, url)).rejects.toThrow();
      await expect(tabs.revalidate(other, first.id)).rejects.toThrow();
      tabs.detach(other, first.id);
    }
    const second = await tabs.attach(topic, "http://127.0.0.1:49153");
    expect(second.id).not.toBe(first.id);
    expect(tabs.list(topic)).toHaveLength(2);
  });
  it("rejects ambiguous input or a mismatched owner before probing", async () => {
    const fetcher = vi.fn(async () => response());
    const tabs = new AttachedDashboards(fetcher);
    for (const invalid of [
      url + "?port=1",
      url + "/path",
      "try " + url,
      "http://127.1:8080",
      "http://u@localhost:5000",
    ]) {
      await expect(tabs.attach(project, invalid)).rejects.toThrow();
    }
    await expect(
      tabs.attach({ ...topic, projectId: "q" }, url),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects finished runs and malformed AFM even if HTTP succeeded; fallback uses the exact ID", async () => {
    for (const invalid of [
      { run_status: "finished" },
      { run_status: "interrupted" },
      { run_status: "failed" },
      { ended_at: "2026-11-01T12:32:00Z" },
      { run_id: "" },
      { run_id: "   " },
      { stages: null },
    ]) {
      const tabs = new AttachedDashboards(async () => response(invalid));
      await expect(tabs.attach(project, url)).rejects.toThrow();
      expect(tabs.all()).toEqual([]);
    }
    const tabs = new AttachedDashboards(async () =>
      response({ flow_name: "  ", started_at: "not a date", description: {} }),
    );
    expect(await tabs.attach(project, url)).toEqual(
      expect.objectContaining({ name: "run-1", runId: "run-1" }),
    );
    expect(tabs.list(project)[0].startedAt).toBeUndefined();
  });
  it("never follows a replacement run even with the same flow name and port", async () => {
    let id = "first",
      status = "running";
    const tabs = new AttachedDashboards(async () =>
      response({ run_id: id, run_status: status, flow_name: "Build" }),
    );
    const first = await tabs.attach(project, url);
    id = "replacement";
    await expect(tabs.revalidate(project, first.id)).rejects.toThrow(
      /другому запуску/,
    );
    await expect(tabs.attach(project, url)).rejects.toThrow(/другому запуску/);
    expect(tabs.list(project)).toEqual([first]);
    id = "first";
    status = "finished";
    expect((await tabs.revalidate(project, first.id)).status).toBe("finished");
    tabs.detach(project, first.id);
    status = "running";
    id = "replacement";
    expect((await tabs.attach(project, url)).id).not.toBe(first.id);
  });
  it("cancels pending requests on close, explicit abort and window disposal; late responses never restore a tab", async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(value: Response) => void> = [];
    const tabs = new AttachedDashboards((_url, init) => {
      signals.push(init!.signal!);
      return new Promise((resolve) => resolvers.push(resolve));
    });
    const connect = tabs.attach(project, url);
    resolvers.shift()!(response());
    const tab = await connect;
    const refresh = tabs.revalidate(project, tab.id);
    const duplicate = tabs.attach(project, url);
    tabs.detach(project, tab.id);
    await expect(refresh).rejects.toThrow();
    await expect(duplicate).rejects.toThrow();
    expect(signals.slice(1).every((s) => s.aborted)).toBe(true);
    const c = new AbortController();
    const pending = tabs.attach(project, url, c.signal);
    c.abort();
    await expect(pending).rejects.toThrow();
    const pendingClose = tabs.attach(project, url);
    tabs.dispose();
    await expect(pendingClose).rejects.toThrow();
    expect(signals.every((s) => s.aborted)).toBe(true);
    for (const resolve of resolvers) resolve(response());
    await expect(tabs.attach(project, url)).rejects.toThrow();
    expect(tabs.all()).toEqual([]);
  });
});
