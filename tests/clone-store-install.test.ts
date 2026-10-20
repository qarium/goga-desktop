import { expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { CloneStore } from "../src/host/clone-store";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
it("removes the first-install temporary hardlink before directory fsync exposes crash state", async () => {
  const root = await fs.mkdtemp(
      "/private/tmp/goga-context-ab-research-20261019-impl-install-",
    ),
    home = path.join(root, "home");
  await fs.mkdir(home);
  const store = new CloneStore(home),
    actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
  let checked = false;
  vi.mocked(fs.open).mockImplementation(async (...args: any[]) => {
    const handle = await (actual.open as any)(...args);
    if (String(args[0]) !== store.root) return handle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === "sync")
          return async () => {
            const stat = await actual
              .stat(path.join(store.root, "registry.json"))
              .catch(() => null);
            if (stat) {
              checked = true;
              expect(stat.nlink).toBe(1);
            }
            return target.sync();
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  try {
    await store.read();
    expect(checked).toBe(true);
    expect((await new CloneStore(home).read()).records).toEqual([]);
  } finally {
    vi.mocked(fs.open).mockRestore();
  }
});
