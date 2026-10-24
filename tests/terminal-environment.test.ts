import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rename, rm, symlink } from "node:fs/promises";
import {
  prepareTerminalEnvironment as prepareRealEnvironment,
  type TerminalRoot,
} from "../src/host/terminal-environment";
import type { TerminalContext } from "../src/shared/terminal";
const disposers: Array<() => void> = [];
async function prepareTerminalEnvironment(
  ...args: Parameters<typeof prepareRealEnvironment>
) {
  const launch = await prepareRealEnvironment(...args);
  if (launch.dispose) disposers.push(launch.dispose);
  return launch;
}
const temporary: string[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const dir of temporary.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const primary: TerminalContext = { kind: "primary", projectId: "p" };
const topic: TerminalContext = {
  kind: "topic",
  projectId: "p",
  year: "2026",
  topic: "a",
  branch: "a",
  contextId: `ctx-${"a".repeat(64)}`,
};
async function fixture(context = primary) {
  const dir = await mkdtemp("/private/tmp/goga-terminal-env-");
  temporary.push(dir);
  const root = dir + "/root";
  await mkdir(root);
  const resolved: TerminalRoot = { context, root, env: [] };
  return { dir, root, resolved, resolve: async () => resolved };
}
const system = {
  accountShell: () => "/bin/zsh",
  inherited: {
    PATH: "/bin:/usr/bin",
    HOME: "/synthetic/home",
    LANG: "ru_RU.UTF-8",
  },
};
it("starts in the exact resolved root and uses account shell, not SHELL from env", async () => {
  for (const context of [primary, topic]) {
    const f = await fixture(context);
    const launch = await prepareTerminalEnvironment(context, f.resolve, {
      ...system,
      inherited: { ...system.inherited, SHELL: "/foreign/shell" },
    });
    expect(launch.cwd).toBe(f.root);
    expect(launch.context).toEqual(context);
    expect(launch.shell).toBe("/bin/zsh");
    expect(launch.args).toEqual(["-l", "-i"]);
    expect(launch.env).toMatchObject({
      ...system.inherited,
      SHELL: "/bin/zsh",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "GogaDesktop",
    });
    await launch.verifyRoot();
  }
});
it("copies all Desktop rows regardless of runtime without changing inherited env or process.env", async () => {
  const f = await fixture();
  f.resolved.env = [
    { key: "LOCAL", value: "synthetic-secret", runtime: false, secret: true },
    { key: "RUNTIME", value: "yes", runtime: true, secret: false },
  ];
  const inherited = {
    ...system.inherited,
    LOCAL: "old",
    TERM: "dumb",
    PWD: "/wrong",
    OLDPWD: "/wrong",
  };
  const before = { ...process.env };
  const launch = await prepareTerminalEnvironment(primary, f.resolve, {
    ...system,
    inherited,
  });
  expect(launch.env.LOCAL).toBe("synthetic-secret");
  expect(launch.env.RUNTIME).toBe("yes");
  expect(launch.env.TERM).toBe("xterm-256color");
  expect(launch.env.PWD).toBeUndefined();
  expect(launch.env.OLDPWD).toBeUndefined();
  expect(inherited.LOCAL).toBe("old");
  expect(inherited.TERM).toBe("dumb");
  expect(process.env).toEqual(before);
});
it("removes launch injection from inherited and Desktop environment", async () => {
  const f = await fixture();
  const keys = [
    "NODE_OPTIONS",
    "NODE_PATH",
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_NO_ASAR",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "BASH_ENV",
    "ENV",
  ];
  const injection = Object.fromEntries(
    keys.map((k) => [k, "synthetic-secret"]),
  );
  f.resolved.env = keys.map((key) => ({
    key,
    value: "synthetic-secret",
    runtime: true,
    secret: true,
  }));
  const launch = await prepareTerminalEnvironment(primary, f.resolve, {
    ...system,
    inherited: { ...system.inherited, ...injection },
  });
  for (const key of keys) expect(launch.env[key], key).toBeUndefined();
});
it.each([null, "", "zsh", "/bin/fish", "/missing/zsh"])(
  "rejects unsupported/missing shell without fallback: %s",
  async (shell) => {
    const f = await fixture();
    await expect(
      prepareTerminalEnvironment(primary, f.resolve, {
        ...system,
        accountShell: () => shell,
      }),
    ).rejects.toThrow(/оболочк/i);
  },
);
it("supports bash with the same login interactive policy", async () => {
  const f = await fixture();
  expect(
    (
      await prepareTerminalEnvironment(primary, f.resolve, {
        ...system,
        accountShell: () => "/bin/bash",
      })
    ).args,
  ).toEqual(["-l", "-i"]);
});
it("rejects foreign owner, missing directory and symlink instead of falling back", async () => {
  const f = await fixture(topic);
  f.resolved.context = primary;
  await expect(
    prepareTerminalEnvironment(topic, f.resolve, system),
  ).rejects.toThrow(/контекст/);
  f.resolved.context = topic;
  await rm(f.root, { recursive: true });
  await expect(
    prepareTerminalEnvironment(topic, f.resolve, system),
  ).rejects.toThrow(/папк/);
  await symlink(f.dir, f.root);
  await expect(
    prepareTerminalEnvironment(topic, f.resolve, system),
  ).rejects.toThrow(/папк/);
});
it("revalidates ownership and directory identity before spawn or reuse", async () => {
  const f = await fixture(topic);
  const launch = await prepareTerminalEnvironment(topic, f.resolve, system);
  await rename(f.root, f.root + "-old");
  await mkdir(f.root);
  await expect(launch.verifyRoot()).rejects.toThrow(/папк/);
  await rm(f.root, { recursive: true });
  await rename(f.root + "-old", f.root);
  f.resolved.context = { ...topic, projectId: "foreign" };
  await expect(launch.verifyRoot()).rejects.toThrow(/контекст/);
});
it("does not expose arbitrary resolver or OS errors containing env values", async () => {
  const f = await fixture();
  await expect(
    prepareTerminalEnvironment(
      primary,
      async () => {
        throw Error("synthetic-secret");
      },
      system,
    ),
  ).rejects.not.toThrow("synthetic-secret");
  await expect(
    prepareTerminalEnvironment(primary, f.resolve, {
      ...system,
      accountShell: () => {
        throw Error("synthetic-secret");
      },
    }),
  ).rejects.not.toThrow("synthetic-secret");
});
it("lets isolated shell rc change cwd and env without injecting corrective commands", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const f = await fixture();
  const home = f.dir + "/home";
  await mkdir(home);
  const changed = f.dir + "/rc-cwd";
  await mkdir(changed);
  await writeFile(
    home + "/.zshrc",
    `cd '${changed}'\nexport FROM_RC=retained\nHISTFILE='${home}/history'\n`,
  );
  const launch = await prepareTerminalEnvironment(primary, f.resolve, {
    accountShell: () => "/bin/zsh",
    inherited: { HOME: home, ZDOTDIR: home, PATH: "/usr/bin:/bin" },
  });
  const result = await promisify(execFile)(
    launch.shell,
    [...launch.args, "-c", 'printf "PROBE:%s|%s" "$PWD" "$FROM_RC"'],
    { cwd: launch.cwd, env: launch.env, timeout: 5000 },
  );
  expect(result.stdout).toContain(`PROBE:${changed}|retained`);
});
it("preserves ordinary Node settings instead of treating every NODE_ key as launch injection", async () => {
  const f = await fixture();
  f.resolved.env = [
    { key: "NODE_ENV", value: "development", secret: false, runtime: false },
  ];
  const launch = await prepareTerminalEnvironment(primary, f.resolve, {
    ...system,
    inherited: {
      ...system.inherited,
      NODE_EXTRA_CA_CERTS: "/synthetic/certs.pem",
    },
  });
  expect(launch.env.NODE_ENV).toBe("development");
  expect(launch.env.NODE_EXTRA_CA_CERTS).toBe("/synthetic/certs.pem");
});

it("abbreviates only the standard zsh prompt at the topic root without changing cwd or user startup files", async () => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const { execFileSync } = await import("node:child_process");
  const f = await fixture({ ...topic, topic: "support-afm-hooks" });
  const home = f.dir + "/home";
  await mkdir(home);
  await mkdir(f.root + "/nested");
  await writeFile(home + "/.zshenv", "unsetopt GLOBAL_RCS\n");
  const rc = 'PROMPT="%n@%m %1~ %# "\n';
  await writeFile(home + "/.zshrc", rc);
  const launch = await prepareTerminalEnvironment(
    f.resolved.context,
    f.resolve,
    {
      accountShell: () => "/bin/zsh",
      inherited: { HOME: home, PATH: "/usr/bin:/bin" },
    },
  );
  try {
    const result = execFileSync(
      launch.shell,
      [
        ...launch.args,
        "-c",
        `for hook in $precmd_functions; do "$hook"; done; print -P -- "$PROMPT"; print -r -- "ROOT:$PWD"; cd nested; for hook in $precmd_functions; do "$hook"; done; print -P -- "$PROMPT"; print -r -- "ZDOT:\${ZDOTDIR-unset}"`,
      ],
      { cwd: launch.cwd, env: launch.env, encoding: "utf8", timeout: 5000 },
    );
    expect(result).toContain(" support-afm-hooks ");
    expect(result).toContain(`ROOT:${f.root}`);
    expect(result).toContain(" nested ");
    expect(result).toContain("ZDOT:unset");
    expect(await readFile(home + "/.zshrc", "utf8")).toBe(rc);
  } finally {
    await (launch as any).dispose?.();
  }
});
