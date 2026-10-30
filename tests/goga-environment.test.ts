import { expect, it, vi } from "vitest";
import {
  createGogaPathReader,
  gogaEnvironment,
} from "../src/host/goga-environment";
it("loads shell PATH once with a fixed script in HOME, never a project command or variable value", async () => {
  const runner = {
    command: vi.fn(async () => ({
      stdout: "startup banner\n\0GOGA_DESKTOP_PATH\0/fixture/bin:/usr/bin\0",
      stderr: "",
    })),
  };
  const read = createGogaPathReader("/fixture/home", runner, () => "/bin/zsh");
  expect(await read()).toBe("/fixture/bin:/usr/bin");
  expect(await read()).toBe("/fixture/bin:/usr/bin");
  expect(runner.command).toHaveBeenCalledTimes(1);
  expect(runner.command.mock.calls[0]).toMatchObject([
    "/bin/zsh",
    ["-i", "-l", "-c", expect.stringContaining('"$PATH"')],
    "/fixture/home",
    expect.objectContaining({ HOME: "/fixture/home" }),
  ]);
});
it("applies explicit project PATH after shell PATH and keeps host-only env out of runtime decisions", async () => {
  const read = vi.fn(async () => "/shell/bin:/usr/bin");
  expect(
    await gogaEnvironment(
      [{ key: "TOKEN", value: "synthetic", secret: true, runtime: false }],
      read,
    ),
  ).toEqual({ PATH: "/shell/bin:/usr/bin", TOKEN: "synthetic" });
  read.mockClear();
  expect(
    await gogaEnvironment(
      [{ key: "PATH", value: "/project/bin", secret: false, runtime: false }],
      read,
    ),
  ).toEqual({ PATH: "/project/bin" });
  expect(read).not.toHaveBeenCalled();
});
it("rejects malformed path output and does not cache a failed shell read", async () => {
  const runner = {
    command: vi
      .fn()
      .mockResolvedValueOnce({ stdout: "not a path", stderr: "private" })
      .mockResolvedValueOnce({
        stdout: "\0GOGA_DESKTOP_PATH\0/bin\0",
        stderr: "",
      }),
  };
  const read = createGogaPathReader("/fixture/home", runner, () => "/bin/bash");
  await expect(read()).rejects.toThrow(/PATH/);
  expect(await read()).toBe("/bin");
});

it("runs a synthetic CLI and its env shebang with the prepared PATH, including an absolute executable", async () => {
  const fs = await import("node:fs/promises"),
    path = await import("node:path");
  const { NodeRunner } = await import("../src/host/process");
  const root = await fs.mkdtemp("/private/tmp/goga-cli-path-");
  const bin = path.join(root, "cli bin"),
    home = path.join(root, "home");
  await fs.mkdir(bin);
  await fs.mkdir(home);
  const executable = path.join(bin, "synthetic-goga");
  await fs.writeFile(
    executable,
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME }))\n",
    { mode: 0o700 },
  );
  const runner = new NodeRunner(2000, { HOME: home, PATH: "/usr/bin:/bin" });
  const inherited = process.env.PATH;
  try {
    const env = await gogaEnvironment(
      [],
      async () => `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    );
    for (const exe of ["synthetic-goga", executable]) {
      expect(
        JSON.parse(
          (
            await runner.command(
              exe,
              ["pipeline", "--list", "--info"],
              root,
              env,
            )
          ).stdout,
        ),
      ).toEqual({ args: ["pipeline", "--list", "--info"], home });
    }
    expect(process.env.PATH).toBe(inherited);
  } finally {
    await runner.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("keeps absolute PATH entries when shell also lists current-directory or relative entries", async () => {
  const runner = {
    command: vi.fn(async () => ({
      stdout: "\0GOGA_DESKTOP_PATH\0/shell/bin::relative:.:/usr/bin\0",
      stderr: "",
    })),
  };
  expect(
    await createGogaPathReader("/fixture/home", runner, () => "/bin/zsh")(),
  ).toBe("/shell/bin:/usr/bin");
});

it("reads PATH from a real shell with only disposable HOME startup files", async () => {
  const fs = await import("node:fs/promises");
  const { NodeRunner } = await import("../src/host/process");
  const home = await fs.mkdtemp("/private/tmp/goga-shell-path-");
  const runner = new NodeRunner(5000, { HOME: home });
  try {
    await fs.writeFile(
      `${home}/.zshrc`,
      'export PATH="/synthetic/goga/bin:/usr/bin:/bin"\nprintf "startup banner\\n"\n',
    );
    expect(await createGogaPathReader(home, runner, () => "/bin/zsh")()).toBe(
      "/synthetic/goga/bin:/usr/bin:/bin",
    );
  } finally {
    await runner.dispose();
    await fs.rm(home, { recursive: true, force: true });
  }
});
