import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { prepareTopicPrompt } from "../src/host/terminal-prompt";
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function fixture(topic = "support-afm-hooks", custom = false) {
  const dir = await mkdtemp("/private/tmp/goga-prompt-test-");
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const root = dir + "/support-afm-hooks-1234567890",
    home = dir + "/home",
    zdot = dir + "/rc";
  for (const p of [root, home, zdot, root + "/nested"]) await mkdir(p);
  await writeFile(
    zdot + "/.zshenv",
    "unsetopt GLOBAL_RCS\nexport FROM_ENV=retained\n",
  );
  await writeFile(zdot + "/.zprofile", "export FROM_PROFILE=retained\n");
  await writeFile(zdot + "/.zlogin", "export FROM_LOGIN=retained\n");
  const rc = custom ? "PROMPT='CUSTOM> '\n" : "PROMPT='%n@%m %1~ %# '\n";
  await writeFile(zdot + "/.zshrc", rc);
  const env = { HOME: home, ZDOTDIR: zdot, PATH: "/usr/bin:/bin" };
  const integration = await prepareTopicPrompt(root, topic, env);
  cleanup.push(integration.dispose);
  const run = (code: string) =>
    execFileSync("/bin/zsh", ["-l", "-i", "-c", code], {
      cwd: root,
      env: { ...env, ZDOTDIR: integration.directory },
      encoding: "utf8",
      timeout: 5000,
    });
  return { dir, root, home, env, zdot, rc, integration, run };
}
const update = 'for hook in $precmd_functions; do "$hook"; done;';
it("preserves custom themes, startup files, history location and ZDOTDIR for nested shells", async () => {
  const f = await fixture("topic", true);
  expect(
    f.run(
      `${update} print -P -- "$PROMPT"; print -r -- "$FROM_ENV:$FROM_PROFILE:$FROM_LOGIN:$ZDOTDIR"`,
    ),
  ).toContain(`CUSTOM> \nretained:retained:retained:${f.zdot}`);
  expect(await readFile(f.zdot + "/.zshrc", "utf8")).toBe(f.rc);
  expect((await stat(f.integration.directory)).mode & 0o777).toBe(0o700);
  f.integration.dispose();
  await expect(stat(f.integration.directory)).rejects.toThrow();
});
it("returns from a subdirectory to the abbreviated root and never changes the actual path", async () => {
  const f = await fixture();
  const output = f.run(
    `${update} print -P -- "$PROMPT"; cd nested; ${update} print -P -- "$PROMPT"; cd ..; ${update} print -P -- "$PROMPT"; print -r -- "$PWD"`,
  );
  expect(output.match(/ support-afm-hooks /g)).toHaveLength(2);
  expect(output).toContain(" nested ");
  expect(output).toContain(f.root);
});
it("treats topic text as literal, including percent and shell expansions, and stops when promptsubst is enabled", async () => {
  const f = await fixture("evil%F{red}$(print INJECTED)`print BACKTICK`");
  const first = f.run(`${update} print -P -- "$PROMPT"`);
  expect(first).toContain("evil%F{red}$(print INJECTED)`print BACKTICK`");
  const changed = f.run(
    `${update} setopt promptsubst; ${update} print -P -- "$PROMPT"`,
  );
  expect(changed).not.toContain("INJECTED");
  expect(changed).not.toContain("BACKTICK");
});

it("records line-editor readiness and invalidates it for preexec and host input", async () => {
  const f = await fixture();
  const pid = Number(
    f.run("CONTEXT=start; _goga_desktop_idle; print -r -- $$").trim(),
  );
  expect(f.integration.activity.idle(pid)).toBe(true);
  expect(f.integration.activity.idle(pid + 1)).toBe(false);
  f.integration.activity.input("echo x\r");
  expect(f.integration.activity.idle(pid)).toBe(false);
  const busyPid = Number(
    f.run("_goga_desktop_idle; _goga_desktop_busy; print -r -- $$").trim(),
  );
  expect(f.integration.activity.idle(busyPid)).toBe(false);
});

it.skipIf(process.platform !== "darwin")(
  "real interactive zsh distinguishes its prompt, builtin read and exec without relying on child jobs",
  async () => {
    const f = await fixture();
    const child = spawn(
      "/usr/bin/python3",
      [
        "-u",
        "-c",
        `
import os, pty, select, signal
pid, master = pty.fork()
if pid == 0:
    os.execv('/bin/zsh', ['/bin/zsh', '-l', '-i'])
def stop(*_):
    try: os.kill(pid, signal.SIGHUP)
    except ProcessLookupError: pass
signal.signal(signal.SIGTERM, stop)
fds = [0, master]
try:
    while True:
        ready, _, _ = select.select(fds, [], [])
        if master in ready:
            try: data = os.read(master, 8192)
            except OSError: break
            if not data: break
            os.write(1, data)
        if 0 in ready:
            data = os.read(0, 8192)
            if data: os.write(master, data)
            else: fds.remove(0)
finally:
    stop()
    os.waitpid(pid, 0)
`,
      ],
      {
        cwd: f.root,
        env: {
          ...f.env,
          ZDOTDIR: f.integration.directory,
          TERM: "xterm-256color",
          TMPDIR: f.dir,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", () => resolve());
    });
    const waitFor = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 3000;
      while (!(await check())) {
        if (Date.now() > deadline)
          throw Error("shell state deadline: " + output.slice(-2000));
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    let pid = 0;
    try {
      await waitFor(async () => {
        try {
          pid = Number(
            (
              await readFile(f.integration.directory + "/activity", "utf8")
            ).split(":")[0],
          );
        } catch {
          return false;
        }
        return f.integration.activity.idle(pid);
      });
      // Send through the PTY directly so this proves shell hooks, not host input invalidation.
      child.stdin.write("read -t 1 answer\r");
      await waitFor(async () => !f.integration.activity.idle(pid));
      await waitFor(async () => f.integration.activity.idle(pid));
      child.stdin.write("vared -p 'VARED_READY> ' -c answer\r");
      await waitFor(async () => output.split("VARED_READY> ").length >= 3);
      await new Promise((r) => setTimeout(r, 30));
      expect(f.integration.activity.idle(pid)).toBe(false);
      child.stdin.write("fixture\r");
      await waitFor(async () => f.integration.activity.idle(pid));
      child.stdin.write("exec /bin/sleep 0.3\r");
      await waitFor(async () => !f.integration.activity.idle(pid));
      await exited;
      expect(f.integration.activity.idle(pid)).toBe(false);
    } finally {
      child.stdin.end("exit\r");
      const timer = setTimeout(() => child.kill("SIGTERM"), 2000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
  },
  10000,
);
