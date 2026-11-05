import { describe, it, expect, vi } from "vitest";
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
