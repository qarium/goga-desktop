import { spawn } from "node:child_process";
/** Owns only disposable smoke children, never user terminal sessions. */
export function runSmokeCommand(
  file,
  args,
  {
    timeout = 90000,
    maxBuffer = 8 * 1024 * 1024,
    cwd,
    env,
    spawnProcess = spawn,
    signalGroup = process.kill.bind(process),
  } = {},
) {
  if (!Number.isFinite(timeout) || timeout <= 0)
    return Promise.reject(Error("Invalid smoke command timeout"));
  return new Promise((resolve, reject) => {
    const child = spawnProcess(file, args, {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [],
      err = [];
    let size = 0,
      done = false,
      failure,
      settling = false,
      poll;
    const exists = () => {
      if (!child.pid) return false;
      try {
        signalGroup(-child.pid, 0);
        return true;
      } catch (e) {
        return e.code !== "ESRCH";
      }
    };
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(poll);
      // Even unconfirmed OS settlement cannot keep this verifier's event loop alive.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      if (error) reject(error);
      else
        resolve({
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
    };
    const abort = (error) => {
      if (done || settling) return;
      settling = true;
      clearTimeout(poll);
      failure = error;
      if (child.pid)
        try {
          signalGroup(-child.pid, "SIGKILL");
        } catch (e) {
          if (e.code !== "ESRCH")
            failure = Error("Smoke process group could not be stopped");
        }
      const deadline = performance.now() + 1000;
      const check = () => {
        if (done) return;
        if (!exists()) finish(failure);
        else if (performance.now() >= deadline)
          finish(Error(`${failure.message}; process settlement not confirmed`));
        else poll = setTimeout(check, 25);
      };
      check();
    };
    const timer = setTimeout(
      () => abort(Error("Smoke command timed out")),
      timeout,
    );
    const receive = (parts, chunk) => {
      if (failure || done) return;
      size += chunk.length;
      if (size > maxBuffer) abort(Error("Smoke command output exceeded limit"));
      else parts.push(chunk);
    };
    child.stdout.on("data", (chunk) => receive(out, chunk));
    child.stderr.on("data", (chunk) => receive(err, chunk));
    child.once("error", (error) => {
      if (exists()) abort(error);
      else finish(error);
    });
    child.once("close", (code, signal) => {
      if (done) return;
      const error =
        failure ??
        (code === 0 && !signal
          ? undefined
          : Error(
              `Smoke command failed (${code ?? signal}): ${Buffer.concat(err).toString("utf8")}`,
            ));
      // Electron helpers may close just after the main process. Allow a short
      // bounded natural drain, then reject and stop any surviving owned group.
      const deadline = performance.now() + 250;
      const drained = () => {
        if (done || settling) return;
        if (!exists()) finish(error);
        else if (performance.now() >= deadline)
          abort(error ?? Error("Smoke descendant outlived the main process"));
        else poll = setTimeout(drained, 25);
      };
      if (settling) {
        if (!exists()) finish(error);
      } else drained();
    });
  });
}
