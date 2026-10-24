import { expect, it, vi } from "vitest";
import {
  terminalAssets,
  lazyTerminalDriver,
} from "../src/main/terminal-bootstrap";
it("resolves dev and packaged assets from fixed app locations, never renderer input", () => {
  expect(terminalAssets("/repo", "/unused", false)).toEqual({
    preload: "/repo/dist-electron/terminal-preload.cjs",
    url: "file:///repo/dist/terminal/index.html",
    inspector: "/repo/dist-electron/native/terminal-inspect",
  });
  expect(
    terminalAssets(
      "/App/Contents/Resources/app.asar",
      "/App/Contents/Resources",
      true,
    ),
  ).toEqual({
    preload:
      "/App/Contents/Resources/app.asar/dist-electron/terminal-preload.cjs",
    url: "file:///App/Contents/Resources/app.asar/dist/terminal/index.html",
    inspector: "/App/Contents/Resources/terminal/terminal-inspect",
  });
  for (const root of ["relative", "/repo/../other", "/repo\0bad"])
    expect(() => terminalAssets(root, "/resources", true)).toThrow();
});
it("does not import/spawn native code until explicit session startup; loads only pinned dependency", () => {
  const spawn = vi.fn(() => ({ pid: 200 })),
    load = vi.fn((name: string) =>
      name.endsWith("package.json") ? { version: "1.1.0" } : { spawn },
    );
  const driver = lazyTerminalDriver("/repo", load);
  expect(load).not.toHaveBeenCalled();
  const options = {
    cwd: "/safe",
    env: { SECRET: "synthetic" },
    cols: 80,
    rows: 24,
    encoding: "utf8" as const,
    handleFlowControl: false as const,
    name: "xterm",
  };
  expect(driver.spawn("/bin/zsh", ["-l", "-i"], options)).toEqual({ pid: 200 });
  expect(load.mock.calls.map((c) => c[0])).toEqual([
    "/repo/node_modules/node-pty/package.json",
    "/repo/node_modules/node-pty",
  ]);
  driver.spawn("/bin/zsh", [], options);
  expect(load).toHaveBeenCalledTimes(2);
  expect(spawn).toHaveBeenCalledWith("/bin/zsh", ["-l", "-i"], options);
});
it("refuses unknown native dependency version before module loading/spawn", () => {
  const load = vi.fn(() => ({ version: "1.2.0" }));
  const driver = lazyTerminalDriver("/repo", load);
  expect(() => driver.spawn("/bin/zsh", [], {} as any)).toThrow();
  expect(load.mock.calls).toHaveLength(1);
});
