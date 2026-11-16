import { createServer, type Socket } from "node:net";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { TerminalLaunch } from "./terminal-environment";

export type PresetCommandOutcome = "delivered" | "unavailable" | "uncertain";
export interface PreparedPresetCommand {
  launch: TerminalLaunch;
  result: Promise<PresetCommandOutcome>;
  arm(pid: number): void;
  dispose(): void;
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const unavailable = () =>
  Error("Не удалось подготовить первый запуск команды терминала.");

/** The one-shot secret stays in host memory until a prompt asks for it.
 * No keyboard input, command argument, command file, PATH lookup, or TCP.
 * The kernel verifies the connected peer before a byte of shell code is sent. */
export async function preparePresetCommand(
  launch: TerminalLaunch,
  command: string,
  verifyPeer: (fd: number, pid: number) => boolean,
  waitMs = 30_000,
): Promise<PreparedPresetCommand> {
  const shell = path.basename(launch.shell);
  if (
    !["bash", "zsh"].includes(shell) ||
    !command.trim() ||
    /[\x00-\x1f\x7f]/u.test(command) ||
    Buffer.byteLength(command) > 65536 ||
    !Number.isSafeInteger(waitMs) ||
    waitMs < 1
  )
    throw unavailable();
  // Darwin has a 104-byte sockaddr_un; actual per-user TMPDIR can exceed it.
  // mkdtemp is atomic and creates the directory 0700 in the sticky /private/tmp.
  const dir = await mkdtemp("/private/tmp/goga-pt-");
  const address = path.join(dir, "p");
  const env = { ...launch.env };
  const guard = "_goga_" + randomBytes(12).toString("hex");
  const token = randomBytes(16).toString("hex");
  // Only when installed in the host-owned zsh shim. Never place our transient
  // directory in ZDOTDIR: cancelling before zsh sources .zshenv must NOT skip
  // restoration of the user's original ZDOTDIR and startup files.
  const anchor = launch.presetShellHooks;

  let payload: string | undefined = command;
  let root: number | undefined, timer: NodeJS.Timeout | undefined;
  let pending: Socket | undefined,
    sent = false,
    settled = false,
    disposed = false;
  let resolveResult!: (outcome: PresetCommandOutcome) => void;
  const result = new Promise<PresetCommandOutcome>((resolve) => {
    resolveResult = resolve;
  });
  const clients = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, accept);
  server.maxConnections = 8;
  function finish(outcome: PresetCommandOutcome) {
    if (settled) return;
    settled = true;
    payload = undefined;
    clearTimeout(timer);
    server.close();
    for (const sock of clients) sock.destroy();
    resolveResult(outcome);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    finish(sent ? "uncertain" : "unavailable");
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* No plaintext data on disk. */
    }
  }
  function accept(sock: Socket) {
    if (settled || clients.size >= 8) {
      sock.destroy();
      return;
    }
    clients.add(sock);
    sock.on("error", () => {
      if (sent && sock === pending) finish("uncertain");
    });
    sock.on("close", () => {
      clients.delete(sock);
      if (pending === sock && !sent) pending = undefined;
    });
    sock.setTimeout(2000, () => sock.destroy());
    let request = "";
    sock.on("data", (data: Buffer) => {
      request += data.toString("ascii");
      if (request.length > 64 || settled || (pending && pending !== sock)) {
        sock.destroy();
        return;
      }
      if (!request.includes("\n")) return;
      if (!new RegExp("^" + token + " [1-9][0-9]{0,9}\\n$").test(request)) {
        sock.destroy();
        return;
      }
      pending = sock;
      dispatch(sock, Number(request.slice(token.length + 1).trim()));
    });
  }
  const verificationAttempts = new WeakMap<Socket, number>();
  let waiting: number | undefined;
  function dispatch(sock: Socket, claimed: number) {
    if (!root) {
      waiting = claimed;
      return;
    }
    // Node does not expose Darwin peer credentials; pass only this accepted
    // socket's local FD to the bundled read-only inspector. Unknown => refuse.
    const fd = (sock as Socket & { _handle?: { fd?: number } })._handle?.fd;
    if (
      claimed !== root ||
      fd === undefined ||
      sock.destroyed ||
      !payload ||
      sent ||
      settled
    ) {
      if (pending === sock) pending = undefined;
      sock.destroy();
      return;
    }
    let valid = false;
    try {
      valid = verifyPeer(fd, root);
    } catch {
      /* fail closed */
    }
    if (!valid) {
      // Pipe setup/exec and kernel process snapshots can briefly overlap. Only
      // retry verification on the *same still-connected socket*; never retry
      // sending a command and never treat elapsed time as proof of identity.
      const attempts = (verificationAttempts.get(sock) ?? 0) + 1;
      verificationAttempts.set(sock, attempts);
      if (attempts < 3) {
        setTimeout(() => {
          if (pending === sock && !sock.destroyed && !settled)
            dispatch(sock, claimed);
        }, 15).unref();
      } else {
        pending = undefined;
        sock.destroy();
      }
      return;
    }
    const body = payload;
    sent = true;
    payload = undefined;
    // Result acknowledges transport only, never a command's exit status.
    sock.end(body + "\n", () => finish("delivered"));
  }
  const receive =
    "builtin printf '%s %s\\n' " +
    quote(token) +
    ' "$$" | /usr/bin/nc -U ' +
    quote(address) +
    " 2>/dev/null";
  try {
    if (shell === "zsh") {
      if (!anchor) throw unavailable();
      const rc = [
        guard + "() {",
        "  [[ $CONTEXT == start ]] || return 0",
        "  add-zle-hook-widget -d line-init " + guard,
        "  local line",
        "  line=$(" + receive + ") || :",
        "  if [[ -n $line ]]; then BUFFER=$line; CURSOR=${#BUFFER}; zle .accept-line; fi",
        "}",
        "zmodload zsh/zle",
        "autoload -Uz add-zle-hook-widget",
        "add-zle-hook-widget line-init " + guard,
      ];
      await anchor.addZshHook(rc.join("\n") + "\n");
    } else {
      // A scalar PROMPT_COMMAND works with macOS Bash 3.2. Include any
      // inherited prompt hook unchanged. If a login file replaces ours, no
      // command is injected. Nested shells cannot obtain the root's payload.
      const old = env.PROMPT_COMMAND ?? "";
      const line = guard + "_line";
      const hook = [
        "if [[ -z ${" + guard + "-} ]]; then",
        "  " + guard + "=1",
        "  " + line + "=$(" + receive + ") || :",
        "  if [[ -n $" + line + ' ]]; then builtin eval "$' + line + '"; fi',
        "  unset " + line,
        "fi",
      ].join("\n");
      // Do not write inherited hook text or payload to files. Remove our
      // prefix alone: a login profile may append its own PROMPT_COMMAND.
      const file = path.join(dir, "prompt");
      const prefix =
        "if [[ -r " +
        quote(file) +
        " ]]; then builtin source " +
        quote(file) +
        "; fi";
      await writeFile(
        file,
        [
          "if [[ $PROMPT_COMMAND == " +
            quote(prefix) +
            " ]]; then unset PROMPT_COMMAND;",
          "elif [[ $PROMPT_COMMAND == " +
            quote(prefix + "; ") +
            "* ]]; then PROMPT_COMMAND=${PROMPT_COMMAND#" +
            quote(prefix + "; ") +
            "}; fi",
          hook,
        ].join("\n") + "\n",
        { flag: "wx", mode: 0o600 },
      );
      env.PROMPT_COMMAND = prefix + (old ? "; " + old : "");
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    server.on("error", () => finish(sent ? "uncertain" : "unavailable"));
    await chmod(address, 0o600);
    return {
      launch: { ...launch, env },
      result,
      arm(pid) {
        if (settled || root) return;
        if (!Number.isSafeInteger(pid) || pid < 2 || pid > 2147483647) {
          finish("unavailable");
          return;
        }
        root = pid;
        timer = setTimeout(
          () => finish(sent ? "uncertain" : "unavailable"),
          waitMs,
        );
        timer.unref();
        if (pending && waiting !== undefined) dispatch(pending, waiting);
      },
      dispose,
    };
  } catch {
    dispose();
    throw unavailable();
  }
}
