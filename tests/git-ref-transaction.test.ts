import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  NodeRunner,
  RunnerShutdownError,
  GitRefTransactionError,
} from "../src/host/process";
import { withReadScope } from "../src/host/read-scope";
vi.setConfig({ testTimeout: 15000 });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(timeout = 10000) {
  const root = await fs.mkdtemp("/private/tmp/goga-ref-transaction-");
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await fs.mkdir(home);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
  };
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
  const setup = new NodeRunner(10000, env),
    runner = new NodeRunner(timeout, env);
  cleanup.push(
    () => setup.dispose(),
    () => runner.dispose(),
  );
  const git = async (args: string[], stdin?: string) =>
    (
      await setup.command(
        "git",
        ["-c", "core.hooksPath=/dev/null", ...args],
        root,
        env,
        stdin,
      )
    ).stdout;
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await fs.writeFile(path.join(root, "a"), "base\n");
  await git(["add", "a"]);
  await git(["commit", "-m", "base"]);
  await git(["branch", "other"]);
  const old = (await git(["rev-parse", "HEAD"])).trim(),
    tree = (await git(["rev-parse", "HEAD^{tree}"])).trim(),
    next = (await git(["commit-tree", tree, "-p", old], "next\n")).trim();
  const input = `start\nupdate HEAD ${next} ${old}\nprepare\n`;
  const run = (verify: () => Promise<void>) =>
    runner.gitRefTransaction(
      ["-c", "core.hooksPath=/dev/null", "update-ref", "--stdin"],
      root,
      env,
      input,
      verify,
    );
  return { root, runner, git, old, next, run };
}
describe("bounded Git ref transaction handshake", () => {
  it("holds native HEAD and referent locks while host validates, then commits", async () => {
    const f = await fixture();
    let verified = false;
    const out = await f.run(async () => {
      expect(
        (await fs.stat(path.join(f.root, ".git/HEAD.lock"))).isFile(),
      ).toBe(true);
      expect(
        (
          await fs.stat(path.join(f.root, ".git/refs/heads/main.lock"))
        ).isFile(),
      ).toBe(true);
      await expect(
        f.git(["symbolic-ref", "HEAD", "refs/heads/other"]),
      ).rejects.toThrow();
      verified = true;
    });
    expect(verified).toBe(true);
    expect(out.stdout).toContain("commit: ok");
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.next);
  });
  it("aborts without moving either branch when prepared host validation rejects", async () => {
    const f = await fixture();
    await f.git(["symbolic-ref", "HEAD", "refs/heads/other"]);
    await expect(
      f.run(async () => {
        expect(
          (await fs.readFile(path.join(f.root, ".git/HEAD"), "utf8")).trim(),
        ).toBe("ref: refs/heads/other");
        throw Error("wrong branch");
      }),
    ).rejects.toThrow("wrong branch");
    expect((await f.git(["rev-parse", "main"])).trim()).toBe(f.old);
    expect((await f.git(["rev-parse", "other"])).trim()).toBe(f.old);
    await expect(
      fs.stat(path.join(f.root, ".git/HEAD.lock")),
    ).rejects.toThrow();
  });
  it("times out a pending verifier and never sends commit", async () => {
    const f = await fixture(100);
    await expect(f.run(() => new Promise(() => {}))).rejects.toThrow(
      /вовремя|время/i,
    );
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.old);
  });
  it("disposal interrupts prepared transaction without changing refs", async () => {
    const f = await fixture();
    let ready!: () => void;
    const prepared = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const pending = f.run(async () => {
      ready();
      await new Promise(() => {});
    });
    const failed = expect(pending).rejects.toMatchObject({
      commitSent: false,
      cause: expect.any(RunnerShutdownError),
    });
    await prepared;
    await f.runner.dispose();
    await failed;
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.old);
  });
  it("abort signal cancels prepared transaction without changing refs", async () => {
    const f = await fixture(),
      controller = new AbortController();
    let ready!: () => void;
    const prepared = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const pending = withReadScope(controller.signal, () =>
      f.run(async () => {
        ready();
        await new Promise(() => {});
      }),
    );
    const failed = expect(pending).rejects.toThrow(/отмен/i);
    await prepared;
    controller.abort();
    await failed;
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.old);
  });
  it("checks absolute deadline before commit even when timer processing was blocked", async () => {
    const f = await fixture(100);
    await expect(
      f.run(async () => {
        const until = Date.now() + 150;
        while (Date.now() < until) {}
      }),
    ).rejects.toMatchObject({ commitSent: false });
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.old);
  });
});
