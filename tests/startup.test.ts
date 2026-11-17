import { afterEach, it, expect, vi } from "vitest";
import { loadShell } from "../src/main/load-shell";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareRendererAssets } from "../src/main/renderer-assets";

it("navigates before awaiting renderer-dependent zoom setup", async () => {
  let loaded = false;
  const win = {
    loadFile: vi.fn(async () => {
      loaded = true;
    }),
    webContents: {
      setVisualZoomLevelLimits: vi.fn(async () => {
        if (!loaded)
          throw new Error("No renderer loaded: zoom IPC cannot resolve");
      }),
    },
  };
  await loadShell(win as any, "/app/index.html");
  expect(win.loadFile).toHaveBeenCalledWith("/app/index.html");
  expect(loaded).toBe(true);
});

const assetRoots: string[] = [];
const assetCopies: Awaited<ReturnType<typeof prepareRendererAssets>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(assetCopies.splice(0).map((copy) => copy.dispose()));
  await Promise.all(
    assetRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function rendererFixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "goga-renderer-test-"));
  assetRoots.push(root);
  const source = path.join(root, "dist");
  await fs.mkdir(path.join(source, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(source, "index.html"),
    '<script type="module" src="./assets/main-a.js"></script>',
  );
  await fs.writeFile(
    path.join(source, "assets/main-a.js"),
    'export const grammar = () => import("./python-a.js");',
  );
  await fs.writeFile(
    path.join(source, "assets/python-a.js"),
    "export const language = 'python';\n",
  );
  await fs.mkdir(path.join(source, "terminal"));
  await fs.writeFile(
    path.join(source, "terminal/index.html"),
    "terminal fixture\r\n",
  );
  return { root, source };
}

it("keeps packaged renderer paths unchanged without creating or reading a runtime copy", async () => {
  const source = path.join(
    tmpdir(),
    "goga-renderer-not-present",
    "app.asar/dist",
  );
  const renderer = await prepareRendererAssets(source, true);
  expect(renderer.html).toBe(path.join(source, "index.html"));
  await renderer.dispose();
  await renderer.dispose();
});

it("loads a private immutable renderer generation so a clean rebuild cannot remove lazy Python chunks", async () => {
  const { source } = await rendererFixture();
  const renderer = await prepareRendererAssets(source, false);
  assetCopies.push(renderer);
  const snapshot = path.dirname(renderer.html);
  expect(snapshot).not.toBe(source);
  expect((await fs.stat(snapshot)).mode & 0o777).toBe(0o700);
  expect((await fs.stat(renderer.html)).mode & 0o777).toBe(0o600);
  expect(await fs.readFile(renderer.html, "utf8")).toBe(
    await fs.readFile(path.join(source, "index.html"), "utf8"),
  );
  expect(
    await fs.readFile(path.join(snapshot, "terminal/index.html"), "utf8"),
  ).toBe("terminal fixture\r\n");
  // Vite's default rebuild deletes the former generation and writes new hashes.
  await fs.rm(path.join(source, "assets"), { recursive: true });
  await fs.mkdir(path.join(source, "assets"));
  await fs.writeFile(
    path.join(source, "assets/main-b.js"),
    "export const generation = 2;",
  );
  await fs.writeFile(
    path.join(source, "index.html"),
    '<script type="module" src="./assets/main-b.js"></script>',
  );
  expect(
    await fs.readFile(path.join(snapshot, "assets/python-a.js"), "utf8"),
  ).toContain("'python'");
  expect(await fs.readFile(renderer.html, "utf8")).toContain("main-a.js");
  expect(await fs.readdir(path.join(source, "assets"))).toEqual(["main-b.js"]);
  const next = await prepareRendererAssets(source, false);
  assetCopies.push(next);
  expect(next.html).not.toBe(renderer.html);
  expect(
    await fs.readdir(path.join(path.dirname(next.html), "assets")),
  ).toEqual(["main-b.js"]);
  await renderer.dispose();
  await renderer.dispose();
  await expect(fs.access(snapshot)).rejects.toThrow();
  await expect(fs.access(next.html)).resolves.toBeUndefined();
  await expect(
    fs.access(path.join(source, "index.html")),
  ).resolves.toBeUndefined();
});

it.each(["root", "file", "directory"] as const)(
  "rejects a symbolic-link %s instead of copying data outside the renderer tree",
  async (kind) => {
    const { root, source } = await rendererFixture();
    const outside = path.join(root, "not-renderer");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "private.txt"), "not renderer data");
    let input = source;
    if (kind === "root") {
      input = path.join(root, "linked-dist");
      await fs.symlink(source, input);
    } else {
      await fs.symlink(
        kind === "file" ? path.join(outside, "private.txt") : outside,
        path.join(source, "assets", "linked"),
      );
    }
    await expect(prepareRendererAssets(input, false)).rejects.toThrow(
      /symbolic|ссылк/i,
    );
    expect(await fs.readFile(path.join(outside, "private.txt"), "utf8")).toBe(
      "not renderer data",
    );
  },
);

it("rejects special files before attempting to read a FIFO", async () => {
  const { source } = await rendererFixture();
  const fifo = path.join(source, "assets/pipe");
  const result = spawnSync("mkfifo", [fifo]);
  expect(result.status).toBe(0);
  await expect(prepareRendererAssets(source, false)).rejects.toThrow(
    /regular|обычн/i,
  );
});

it("rejects a missing index and cleans any incomplete private runtime", async () => {
  const { source } = await rendererFixture();
  await fs.rm(path.join(source, "index.html"));
  await expect(prepareRendererAssets(source, false)).rejects.toThrow(
    /index\.html/,
  );
});

it("fails explicitly and deletes the partial snapshot when a build changes the source during copying", async () => {
  const { source } = await rendererFixture();
  const writeFile = fs.writeFile;
  let snapshot: string | undefined;
  const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    await writeFile(...args);
    const file = String(args[0]);
    if (
      file.endsWith(`${path.sep}index.html`) &&
      !file.startsWith(source + path.sep)
    ) {
      snapshot = path.dirname(file);
      await writeFile(
        path.join(source, "index.html"),
        "generation changed during copy",
      );
    }
  });
  await expect(prepareRendererAssets(source, false)).rejects.toThrow(
    /changed|измен/i,
  );
  spy.mockRestore();
  expect(snapshot).toBeDefined();
  await expect(fs.access(snapshot!, constants.F_OK)).rejects.toThrow();
  expect(await fs.readFile(path.join(source, "index.html"), "utf8")).toBe(
    "generation changed during copy",
  );
});

it("rejects oversized source trees before reading a sparse file into memory", async () => {
  const { source } = await rendererFixture();
  const oversized = path.join(source, "assets/oversized.js");
  await fs.writeFile(oversized, "");
  await fs.truncate(oversized, 256 * 1024 * 1024 + 1);
  await expect(prepareRendererAssets(source, false)).rejects.toThrow(
    /limit|больш|лимит/i,
  );
});
