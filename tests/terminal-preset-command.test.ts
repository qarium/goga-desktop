import { afterAll, beforeAll, expect, it } from "vitest";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import {
  preparePresetCommand,
  type PreparedPresetCommand,
} from "../src/host/terminal-preset-command";
import { createTerminalInspector } from "../src/host/terminal-inspector";
import { prepareTopicPrompt } from "../src/host/terminal-prompt";
import type { TerminalLaunch } from "../src/host/terminal-environment";

// Native PTY, not a pipe pretending to be a shell. The driver only owns its
// own test child and never imports the account's libraries or login files.
const fixture = `
import sys,os,pty,select,signal
root,shell=sys.argv[1:]
pid,fd=pty.fork()
if pid==0:
 os.chdir(root)
 os.execve(shell,[shell,'-l','-i'],os.environ)
signal.signal(signal.SIGTERM,lambda *_:sys.exit(143))
print(pid,flush=True)
try:
 while True:
  ready,_,_=select.select([0,fd],[],[],0.25)
  if 0 in ready:
   data=os.read(0,8192)
   if not data: break
   os.write(fd,data)
  if fd in ready:
   try: data=os.read(fd,8192)
   except OSError: break
   if not data: break
   os.write(1,data)
finally:
 try: os.kill(pid,signal.SIGKILL)
 except ProcessLookupError: pass
 os.waitpid(pid,0)
`;
const PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
let root: string, binary: string, python: string;
beforeAll(() => {
  root = mkdtempSync("/private/tmp/goga-presets-native-");
  binary = path.join(root, "inspect");
  const env = { HOME: root, TMPDIR: root, PATH };
  execFileSync(
    "/usr/bin/clang",
    [
      "-Wall",
      "-Wextra",
      "-Werror",
      path.resolve("src/native/terminal-inspect.c"),
      "-o",
      binary,
    ],
    { env, timeout: 15000 },
  );
  python = execFileSync(
    "/usr/bin/python3",
    ["-I", "-c", "import sys;print(sys.executable)"],
    { env, timeout: 10000, encoding: "utf8" },
  ).trim();
}, 30000);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Shell redirection creates the file before pwd/printf writes its value.
function hasText(file: string, text: string) {
  try {
    return readFileSync(file, "utf8") === text;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
async function until(check: () => boolean) {
  const end = Date.now() + 6000;
  while (!check()) {
    if (Date.now() > end)
      throw Error("Test shell did not reach the expected state");
    await sleep(10);
  }
}
for (const shell of ["/bin/bash", "/bin/zsh"]) {
  it.each(["run", "interrupt", "refuse", "cancel", "wrong-peer"])(
    "%s: " + shell + " one-shot at the real root prompt",
    async (mode) => {
      const dir = mkdtempSync(root + "/a b'"),
        home = path.join(dir, "home"),
        wd = path.join(dir, "project");
      for (const p of [home, wd, wd + "/nested"]) mkdirSync(p);
      const z = shell.endsWith("zsh");
      const env: Record<string, string> = {
        HOME: home,
        PATH,
        SHELL: shell,
        TMPDIR: dir,
        TERM: "xterm-256color",
        TERM_PROGRAM: "GogaDesktop",
        PORT: "4100",
      };
      if (!z) env.PROMPT_COMMAND = `printf p >> "$HOME/previous"`;
      const old = z ? await prepareTopicPrompt(wd, "demo", env) : undefined;
      if (old) env.ZDOTDIR = old.directory;
      const launch: TerminalLaunch = {
        context: { kind: "primary", projectId: "fixture" },
        presetShellHooks: old?.presetShellHooks,
        shell,
        cwd: wd,
        args: ["-l", "-i"],
        env,
        verifyRoot: async () => {},
      };
      const profile = [
        z
          ? '[[ -o login ]] && touch "$HOME/login"'
          : 'shopt -q login_shell && touch "$HOME/login"',
        'PS1="Probe> "',
        z
          ? ""
          : `PROMPT_COMMAND='printf h >> "$HOME/user-hook"; '"$PROMPT_COMMAND"`,
        "alias mark='printf alias-ok'",
        mode === "refuse"
          ? z
            ? "unsetopt zle"
            : "PROMPT_COMMAND='printf r >> \"$HOME/replaced\"'"
          : "",
        'printf READY_TO_READ; read answer; printf "%s" "$answer" > "$HOME/input"',
        "/bin/sleep .05",
        z
          ? 'autoload -Uz add-zle-hook-widget; _fixture_prompt_ready() { builtin printf "%s\\n" "$$" > "$HOME/prompt-ready"; }; add-zle-hook-widget line-init _fixture_prompt_ready'
          : 'PROMPT_COMMAND=\'printf "%s\\n" "$$" > "$HOME/prompt-ready"; \'"$PROMPT_COMMAND"',
      ].join("\n");
      writeFileSync(home + (z ? "/.zshrc" : "/.bash_profile"), profile + "\n");
      // Ready comes from the actual foreground owner, after installing its
      // SIGINT handler. No timing dependency between touch and exec'ing sleep.
      if (mode === "interrupt")
        writeFileSync(
          home + "/foreground.py",
          [
            "import os,sys,signal",
            "def interrupt(*_):",
            ' open(os.environ["HOME"]+"/interrupted","w").close()',
            " sys.exit(130)",
            "signal.signal(signal.SIGINT,interrupt)",
            'open(os.environ["HOME"]+"/block","w").close()',
            "while True: signal.pause()",
          ].join("\n"),
        );
      const cmd =
        mode === "interrupt"
          ? `"${python}" -I "$HOME/foreground.py"`
          : 'mark >> "$HOME/mark"; cd nested; printf "%s:" "$PORT" > "$HOME/ran"; false';
      const inspect = createTerminalInspector(binary);
      let calls = 0;
      let accepted = 0;
      const prepared: PreparedPresetCommand = await preparePresetCommand(
        launch,
        cmd,
        (fd, pid) => {
          calls++;
          const ok = inspect.presetPeer!(
            fd,
            mode === "wrong-peer" ? process.pid : pid,
          );
          if (ok) accepted++;
          return ok;
        },
        mode === "refuse" || mode === "wrong-peer" ? 600 : 6000,
      );
      let child: ChildProcessWithoutNullStreams | undefined;
      let closed: Promise<void> | undefined;
      let phase = "spawn";
      const wait = async (label: string, check: () => boolean) => {
        phase = label;
        try {
          await until(check);
        } catch (error) {
          throw Error(phase + ": " + String(error));
        }
      };
      const write = (text: string) => {
        old?.activity.input(text);
        child!.stdin.write(text);
      };
      try {
        expect(prepared.launch.args).toEqual(["-l", "-i"]);
        expect(JSON.stringify(prepared.launch.env)).not.toContain(cmd);
        const shim = z
          ? path.join(prepared.launch.env.ZDOTDIR, ".zshenv")
          : prepared.launch.env.PROMPT_COMMAND.match(/source '([^']+)'/)![1];
        expect(readFileSync(shim, "utf8")).not.toContain(cmd);
        child = spawn(python, ["-I", "-c", fixture, wd, shell], {
          cwd: dir,
          env: prepared.launch.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        closed = new Promise<void>((resolve) =>
          child!.once("close", () => resolve()),
        );
        let output = "";
        child.stdout.on("data", (s) => {
          output += s;
        });
        const pid = () => Number(output.match(/^(\d+)\n/)?.[1]);
        await wait("driver reports root PID", () => !!pid());
        prepared.arm(pid());
        await wait("root startup read", () => output.includes("READY_TO_READ"));
        await sleep(50);
        expect(calls).toBe(0);
        if (mode === "cancel") prepared.dispose();
        write("fixture-answer\r");
        await wait("root startup read consumed answer", () =>
          hasText(home + "/input", "fixture-answer"),
        );
        expect(readFileSync(home + "/input", "utf8")).toBe("fixture-answer");
        expect(existsSync(home + "/login")).toBe(true);
        if (mode === "run") {
          expect(
            await prepared.result,
            `peer attempts=${calls}, accepted=${accepted}, pty=${output.slice(-300)}`,
          ).toBe("delivered");
          phase = "preset transport delivered";
          prepared.dispose();
          await wait("preset executed", () => hasText(home + "/ran", "4100:"));
          if (z)
            await wait("root prompt after preset", () =>
              old!.activity.idle(pid()),
            );
          expect(readFileSync(home + "/mark", "utf8")).toBe("alias-ok");
          expect(readFileSync(home + "/ran", "utf8")).toBe("4100:");
          write('pwd > "$HOME/cwd"\r');
          await wait("pwd after preset", () =>
            hasText(home + "/cwd", wd + "/nested\n"),
          );
          expect(readFileSync(home + "/cwd", "utf8").trim()).toBe(
            wd + "/nested",
          );
          if (!z)
            expect(
              readFileSync(home + "/previous", "utf8").length,
            ).toBeGreaterThan(0);
          // A nested interactive login has its own prompt, never another ticket.
          if (z)
            await wait("root prompt before nested shell", () =>
              old!.activity.idle(pid()),
            );
          write(shell + " -l -i\r");
          await wait(
            "nested startup read",
            () => output.split("READY_TO_READ").length >= 3,
          );
          write("nested-answer\r");
          await wait("nested read consumed answer", () =>
            hasText(home + "/input", "nested-answer"),
          );
          await wait("nested prompt after startup read", () => {
            try {
              return (
                /^[0-9]+\n$/.test(
                  readFileSync(home + "/prompt-ready", "utf8"),
                ) && !hasText(home + "/prompt-ready", pid() + "\n")
              );
            } catch {
              return false;
            }
          });
          // A delivered command is not a prompt barrier; verify the nested
          // line-init actually ran before asserting no replay and leaving it.
          expect(accepted).toBe(1);
          write("exit\r");
          await wait(
            "root prompt after nested exit",
            () =>
              hasText(home + "/prompt-ready", pid() + "\n") &&
              (!z || old!.activity.idle(pid())),
          );
          expect(readFileSync(home + "/mark", "utf8")).toBe("alias-ok");
          expect(accepted).toBe(1);
          expect(output).not.toMatch(/No such file or directory/);
        } else if (mode === "interrupt") {
          expect(
            await prepared.result,
            `peer attempts=${calls}, accepted=${accepted}, pty=${output.slice(-300)}`,
          ).toBe("delivered");
          await until(() => existsSync(home + "/block"));
          const cut = output.length;
          child.stdin.write("\x03");
          await until(() => existsSync(home + "/interrupted"));
          // Wait for actual readiness after Ctrl+C: zsh's first-line ZLE
          // marker, or Bash returning to its primary prompt.
          await until(() =>
            z
              ? !!old?.activity.idle(pid())
              : output.slice(cut).includes("Probe> "),
          );
          child.stdin.write('printf alive > "$HOME/alive"\r');
          await until(() => hasText(home + "/alive", "alive"));
        } else {
          expect(await prepared.result).toBe("unavailable");
          child.stdin.write('printf alive > "$HOME/alive"\r');
          await until(() => hasText(home + "/alive", "alive"));
          expect(existsSync(home + "/ran")).toBe(false);
        }
      } finally {
        try {
          if (child && closed) {
            // Subscribe at spawn, not in finally: a signalled/exited PTY driver
            // may have emitted close already (exitCode stays null on signal).
            child.stdin.end();
            const terminate = setTimeout(() => child!.kill("SIGTERM"), 1000);
            let deadline: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                closed,
                new Promise<never>((_, reject) => {
                  deadline = setTimeout(
                    () =>
                      reject(
                        Error(
                          "PTY driver cleanup after " +
                            phase +
                            " did not settle",
                        ),
                      ),
                    2000,
                  );
                }),
              ]);
            } finally {
              clearTimeout(terminate);
              if (deadline) clearTimeout(deadline);
            }
          }
        } finally {
          prepared.dispose();
          old?.dispose();
        }
      }
    },
    12000,
  );
}
