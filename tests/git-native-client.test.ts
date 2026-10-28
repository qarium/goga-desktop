import { expect, it, vi } from "vitest";
import {
  createNativeGitClient,
  gitLiteralPaths,
} from "../src/host/git-native-client";
import { childEnvironment } from "../src/host/process-environment";
import { ByteCommandError } from "../src/host/process";
import type { ByteCommand, ByteCommandResult } from "../src/host/process";
const ok = (stdout = Buffer.alloc(0), exitCode = 0) => ({
  stdout,
  stderr: Buffer.alloc(0),
  exitCode,
  signal: null,
  processSettled: true as const,
});
function transport() {
  const envs: NodeJS.ProcessEnv[] = [];
  const commandBytes = vi.fn(async (command: ByteCommand) => {
    envs.push(
      childEnvironment(
        {
          SSH_AUTH_SOCK: "/fixture/socket",
          SSH_ASKPASS: "not-allowed",
          SSH_ASKPASS_REQUIRE: "force",
          GIT_DIR: "/foreign",
          GIT_CONFIG_PARAMETERS: "hostile",
          GIT_TRACE: "/trace",
          GIT_SSH_COMMAND: "not-allowed",
          GIT_EDITOR: "not-allowed",
          GIT_NAMESPACE: "foreign",
        },
        {},
        command.env,
      ),
    );
    return ok(
      command.args.includes("--version")
        ? Buffer.from("git version 2.55.0\n")
        : Buffer.from([255, 0, 10]),
    );
  });
  return { commandBytes, envs };
}
it("pins the executable, keeps binary output and logs only command class and runtime facts", async () => {
  const runner = transport(),
    report = vi.fn();
  const client = await createNativeGitClient({
    runner,
    executable: "/fixture/git",
    root: "/fixture/repo",
    report,
  });
  const args = ["--porcelain=v2", "-z", "--", "secret filename"];
  const result = await client.run({
    policy: "local-read",
    command: "status",
    args,
  });
  expect(result.stdout).toEqual(Buffer.from([255, 0, 10]));
  expect(runner.commandBytes.mock.calls[1][0]).toMatchObject({
    executable: "/fixture/git",
    cwd: "/fixture/repo",
  });
  expect(runner.commandBytes.mock.calls[1][0].args.slice(-args.length)).toEqual(
    args,
  );
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({
      gitVersion: "2.55.0",
      nodeVersion: process.versions.node,
      policy: "local-read",
      command: "status",
      exitCode: 0,
      processSettled: true,
    }),
  );
  expect(JSON.stringify(report.mock.calls)).not.toMatch(
    /secret|fixture\/repo|socket/,
  );
});
it("applies scoped policy after all environment sources without affecting ordinary terminals", async () => {
  const runner = transport();
  const client = await createNativeGitClient({
    runner,
    executable: "/fixture/git",
    root: "/fixture/repo",
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_DIR: "/explicit",
      GIT_TRACE2_EVENT: "/trace",
      GIT_ALLOW_PROTOCOL: "file",
      GIT_EDITOR: "unsafe",
    },
  });
  await client.run({
    policy: "local-write",
    command: "merge",
    args: ["--abort"],
  });
  const env = runner.envs.at(-1)!;
  expect(env).toMatchObject({
    GIT_ALLOW_PROTOCOL: "",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "/usr/bin/true",
    GIT_SEQUENCE_EDITOR: "/usr/bin/false",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  });
  for (const name of [
    "GIT_DIR",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_TRACE",
    "GIT_SSH_COMMAND",
    "GIT_NAMESPACE",
  ])
    expect(env[name]).toBeUndefined();
  expect(env.GIT_TRACE2_EVENT).toBe("0");
  expect(childEnvironment({ GIT_EDITOR: "user-editor" }).GIT_EDITOR).toBe(
    "user-editor",
  );
});
it("keeps the authentication agent for explicit remote fetch but blocks arbitrary transport executables", async () => {
  const runner = transport();
  const client = await createNativeGitClient({
    runner,
    executable: "/fixture/git",
    root: "/fixture/repo",
  });
  await client.run({
    policy: "remote",
    command: "fetch",
    args: ["--no-tags", "origin"],
  });
  expect(runner.envs.at(-1)).toMatchObject({
    SSH_AUTH_SOCK: "/fixture/socket",
    GIT_ALLOW_PROTOCOL: "https:ssh:file",
  });
  expect(runner.envs.at(-1)!.GIT_SSH_COMMAND).toBeUndefined();
  expect(runner.envs.at(-1)!.SSH_ASKPASS).toBeUndefined();
  expect(runner.envs.at(-1)!.SSH_ASKPASS_REQUIRE).toBe("never");
  await expect(
    client.run({ policy: "remote", command: "merge", args: [] } as never),
  ).rejects.toThrow();
});
it("rejects invalid capabilities and command classes before invoking Git", async () => {
  await expect(
    createNativeGitClient({
      runner: {},
      executable: "/fixture/git",
      root: "/fixture/repo",
    }),
  ).rejects.toThrow();
  const runner = transport();
  await expect(
    createNativeGitClient({ runner, executable: "git", root: "/fixture/repo" }),
  ).rejects.toThrow();
  expect(runner.commandBytes).not.toHaveBeenCalled();
  const client = await createNativeGitClient({
    runner,
    executable: "/fixture/git",
    root: "/fixture/repo",
  });
  for (const request of [
    { policy: "local-read", command: "merge", args: ["--abort"] },
    { policy: "local-write", command: "-c", args: ["alias.x=!false"] },
    { policy: "local-read", command: "status", args: ["a\0b"] },
  ])
    await expect(client.run(request as never)).rejects.toThrow();
  expect(runner.commandBytes).toHaveBeenCalledTimes(1);
});
it("keeps nonzero Git exit and ignores telemetry failure instead of rerunning a command", async () => {
  const runner = transport();
  const client = await createNativeGitClient({
    runner,
    executable: "/fixture/git",
    root: "/fixture/repo",
    report: () => {
      throw Error("telemetry unavailable");
    },
  });
  runner.commandBytes.mockResolvedValueOnce(ok(Buffer.alloc(0), 1));
  expect(
    await client.run({
      policy: "local-write",
      command: "rebase",
      args: ["--continue"],
    }),
  ).toMatchObject({ exitCode: 1 });
  expect(runner.commandBytes).toHaveBeenCalledTimes(2);
});
it("encodes selected paths literally with NUL separators and refuses escapes", () => {
  expect(
    gitLiteralPaths(["-leading", "with\nnewline", ":(glob)*", "dir/я"]),
  ).toEqual(Buffer.from("-leading\0with\nnewline\0:(glob)*\0dir/я\0"));
  for (const value of [
    "",
    ".",
    "..",
    "../outside",
    "/absolute",
    "a/../../b",
    "a\0b",
    "bad\ud800name",
  ])
    expect(() => gitLiteralPaths([value])).toThrow();
  expect(() => gitLiteralPaths([])).toThrow();
});

it("confines public plan inspection to edit-todo with a fixed inert editor", async () => {
  const runner = transport();
  const client = await createNativeGitClient({
    runner,
    executable: "/fixture/git",
    root: "/fixture/repo",
  });
  await client.run({ policy: "rebase-plan", command: "rebase" } as never);
  expect(runner.commandBytes.mock.calls.at(-1)![0].args.slice(-2)).toEqual([
    "rebase",
    "--edit-todo",
  ]);
  expect(runner.envs.at(-1)).toMatchObject({
    GIT_SEQUENCE_EDITOR: "/bin/cat",
    GIT_ALLOW_PROTOCOL: "",
    GIT_EDITOR: "/usr/bin/true",
  });
  for (const request of [
    { policy: "rebase-plan", command: "rebase", args: ["--continue"] },
    { policy: "rebase-plan", command: "merge" },
    {
      policy: "rebase-plan",
      command: "rebase",
      stdin: Buffer.from("exec false"),
    },
  ])
    await expect(client.run(request as never)).rejects.toThrow();
  expect(runner.commandBytes).toHaveBeenCalledTimes(2);
  await client.run({
    policy: "local-write",
    command: "rebase",
    args: ["--continue"],
  });
  expect(runner.envs.at(-1)!.GIT_SEQUENCE_EDITOR).toBe("/usr/bin/false");
});

it("rejects an unsettled version response even when its output looks valid", async () => {
  await expect(
    createNativeGitClient({
      root: "/fixture/repo",
      executable: "/fixture/git",
      runner: {
        commandBytes: async () =>
          ({
            ...ok(Buffer.from("git version 2.45.2\n")),
            processSettled: false,
          }) as unknown as ByteCommandResult,
      },
    }),
  ).rejects.toMatchObject({ processSettled: false });
});

it("isolates a native temporary index per client call and removes it after settlement", async () => {
  const runner = transport();
  const client = await createNativeGitClient({
    runner,
    executable: "/fixture/git",
    root: "/fixture/repo",
  });
  let folder = "";
  await client.inTemporaryIndex(async (indexed, directory) => {
    folder = directory;
    await indexed.run({
      policy: "local-write",
      command: "read-tree",
      args: ["--empty"],
    });
    expect(runner.envs.at(-1)!.GIT_INDEX_FILE).toBe(directory + "/index");
    await client.run({
      policy: "local-read",
      command: "ls-files",
      args: ["--stage", "-z"],
    });
    expect(runner.envs.at(-1)!.GIT_INDEX_FILE).toBeUndefined();
  });
  const fs = await import("node:fs/promises");
  await expect(fs.stat(folder)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains an index directory while its native process may still be alive", async () => {
  const fs = await import("node:fs/promises");
  const client = await createNativeGitClient({
    executable: "/fixture/git",
    root: "/fixture/repo",
    runner: {
      commandBytes: async (input) => {
        if (input.args.includes("--version"))
          return ok(Buffer.from("git version 2.55.0\n"));
        throw new ByteCommandError(
          "process-unsettled",
          false,
          Buffer.alloc(0),
          Buffer.alloc(0),
          null,
          null,
        );
      },
    },
  });
  let folder = "";
  try {
    await expect(
      client.inTemporaryIndex(async (indexed, directory) => {
        folder = directory;
        await indexed.run({
          policy: "local-write",
          command: "read-tree",
          args: ["--empty"],
        });
      }),
    ).rejects.toBeInstanceOf(ByteCommandError);
    expect((await fs.stat(folder)).isDirectory()).toBe(true);
  } finally {
    if (folder) await fs.rm(folder, { recursive: true, force: true });
  }
});
it("does not accept or clean a replaced temporary-index directory", async () => {
  const fs = await import("node:fs/promises");
  const runner = transport();
  const client = await createNativeGitClient({
    runner,
    executable: "/fixture/git",
    root: "/fixture/repo",
  });
  let folder = "";
  try {
    await expect(
      client.inTemporaryIndex(async (indexed, directory) => {
        folder = directory;
        await fs.rename(directory, directory + "-owned");
        await fs.mkdir(directory);
        await fs.writeFile(directory + "/foreign", "keep");
        await indexed.run({
          policy: "local-write",
          command: "read-tree",
          args: ["--empty"],
        });
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(folder + "/foreign", "utf8")).toBe("keep");
    expect(runner.commandBytes).toHaveBeenCalledTimes(1);
  } finally {
    if (folder) {
      await fs.rm(folder, { recursive: true, force: true });
      await fs.rm(folder + "-owned", { recursive: true, force: true });
    }
  }
});

it("refuses a replaced frozen-index directory before native init can write", async () => {
  const fs = await import("node:fs/promises");
  const os = (await import("node:os")).default;
  const path = (await import("node:path")).default;
  const parent = await fs.mkdtemp("/private/tmp/goga-frozen-init-test-");
  const root = path.join(parent, "repo"),
    temp = path.join(parent, "temp");
  await fs.mkdir(path.join(root, ".git/objects"), { recursive: true });
  await fs.mkdir(temp);
  const mock = vi.spyOn(os, "tmpdir").mockReturnValue(temp);
  let initialized = false,
    foreign = "";
  try {
    const client = await createNativeGitClient({
      root,
      executable: "/fixture/git",
      runner: {
        commandBytes: async (input) => {
          if (input.args.includes("--version"))
            return ok(Buffer.from("git version 2.55.0\n"));
          if (input.args.includes("rev-parse")) {
            foreign = path.join(
              temp,
              (await fs.readdir(temp)).find((n) =>
                n.startsWith("goga-native-index-"),
              )!,
            );
            await fs.rename(foreign, foreign + "-owned");
            await fs.mkdir(foreign);
            await fs.writeFile(path.join(foreign, "foreign"), "untouched");
            return ok(Buffer.from("sha1\n"));
          }
          if (input.args.includes("init")) initialized = true;
          return ok();
        },
      },
    });
    await expect(
      client.inTemporaryIndex(async () => {}, true),
    ).rejects.toThrow();
    expect(initialized).toBe(false);
    expect(await fs.readFile(path.join(foreign, "foreign"), "utf8")).toBe(
      "untouched",
    );
  } finally {
    mock.mockRestore();
    await fs.rm(parent, { recursive: true, force: true });
  }
});
