import { installGitFixtureScope } from "./helpers/git-test-scope";
import { gitIntegrationBudget } from "./helpers/git-integration";
import { gitCommitRequestSchema } from "../src/shared/git-commit";
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { nativeGitIndex } from "../src/host/git-index-scope";
import { AsyncResource } from "node:async_hooks";
import {
  NodeRunner,
  ByteCommandError,
  type ByteCommandResult,
} from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { NativeGitWorkspaceActions } from "../src/host/git-native-commit";
import { NativeGitJournal } from "../src/host/git-native-journal";
import {
  createNativeGitCapability,
  nativeIntent,
} from "../src/host/git-native-context";

const fixtureScope = installGitFixtureScope();
async function fixture(unborn = false, format = "sha1", deadline?: number) {
  const dir = await fs.mkdtemp("/private/tmp/goga-native-commit-");
  fixtureScope().cleanup(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo"),
    home = path.join(dir, "home"),
    directory = path.join(home, "journal");
  await fs.mkdir(root);
  await fs.mkdir(home);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const runner = fixtureScope.runner(new NodeRunner(deadline, env));
  const privateIndexes = new Set<string>();
  fixtureScope().cleanup(async () => {
    await runner.dispose();
    // Faults below are injected after the test child has settled. Production
    // correctly retains unknown-outcome metadata; fixtures can remove their own.
    for (const folder of privateIndexes)
      await fs.rm(folder, { recursive: true, force: true });
  });
  const git = (args: string[], stdin?: string) =>
    runner.command("git", args, root, env, stdin);
  const write = (name: string, data: string | Buffer) =>
    fs.writeFile(path.join(root, name), data);
  await git(["init", "-b", "main", `--object-format=${format}`]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  if (!unborn) {
    await write("selected", "base\n");
    await write("other", "base\n");
    await git(["add", "."]);
    await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "base"]);
  }
  const reader = new GitWorkspaceReader({
    root,
    scope: "project",
    verify: async () => {},
    git: async (args) => (await git(args)).stdout,
  });
  const external = new AsyncResource("native-commit-fixture-external");
  const commands: string[][] = [];
  let fault:
    | ((
        command: string,
        result: ByteCommandResult,
      ) => Promise<ByteCommandResult>)
    | undefined;
  let before: ((command: string) => Promise<void>) | undefined;
  let owner = "initial",
    now = 1000;
  const journal = new NativeGitJournal({ directory });
  const context = {
    root,
    scope: "project",
    ownerKey: "owner",
    verify: async () => {},
    snapshot: () => reader.snapshot(),
    git: (args: string[], options?: { stdin?: string }) =>
      git(args, options?.stdin),
    native: createNativeGitCapability({
      root,
      env,
      journal,
      owner: async () => ({
        scope: "project",
        projectPath: root,
        registryRevision: nativeIntent(owner),
      }),
      runner: {
        commandBytes: async (input) => {
          if (nativeGitIndex())
            privateIndexes.add(path.dirname(nativeGitIndex()!));
          const candidate = [
            "commit",
            "add",
            "update-index",
            "update-ref",
          ].find((c) => input.args.includes(c));
          const command =
            candidate === "update-index" && !nativeGitIndex()
              ? "publish-index"
              : candidate === "update-ref" && !nativeGitIndex()
                ? "publish-ref"
                : candidate;
          if (command) {
            commands.push([...input.args]);
            if (before)
              await external.runInAsyncScope(before, undefined, command);
          }
          const result = await runner.commandBytes(input);
          return command && fault
            ? external.runInAsyncScope(fault, undefined, command, result)
            : result;
        },
      },
    }),
  };
  const actions = new NativeGitWorkspaceActions({
    now: () => now,
    context: async (_scope, fn) => fn(context),
  });
  const prepare = async (paths = ["selected"], message = "Selected files") =>
    actions.prepare({
      scope: "project",
      revision: (await reader.snapshot()).revision,
      paths,
      message,
    });
  const head = async () => (await git(["rev-parse", "HEAD"])).stdout.trim();
  return {
    root,
    home,
    dir,
    index: () => fs.readFile(path.join(root, ".git/index")),
    setNow: (value: number) => {
      now = value;
    },
    directory,
    journal,
    git,
    write,
    reader,
    actions,
    prepare,
    head,
    commands,
    context,
    setFault: (fn: typeof fault) => (fault = fn),
    setBefore: (fn: typeof before) => (before = fn),
    setOwner: (v: string) => (owner = v),
  };
}

describe("native selected commit", () => {
  it.each(["add", "commit"])(
    "never executes a newly installed clean filter during native %s",
    fixtureScope.run(async (phase) => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      const p = await f.prepare();
      const head = await f.head();
      const index = await fs.readFile(path.join(f.root, ".git/index"));
      const sentinel = path.join(f.home, "late-filter-ran");
      let injected = false;
      f.setBefore(async (command) => {
        if (command !== phase || injected) return;
        injected = true;
        // An external writer need not respect our cooperative config.lock.
        await fs.appendFile(
          path.join(f.root, ".git/config"),
          `\n[filter "late"]\n clean = "printf observed > '${sentinel}'; cat"\n`,
        );
        await f.write(".gitattributes", "selected filter=late\n");
      });
      const result = await f.actions.execute(p.token);
      expect(result.status).not.toBe("committed");
      expect(injected).toBe(true);
      expect(await fs.readFile(sentinel, "utf8").catch(() => null)).toBe(null);
      expect(await f.head()).toBe(head);
      expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
      expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
        "changed\n",
      );
    }),
  );
  it.each(["HEAD", "refs/heads/main"])(
    "refuses same-OID symbolic switch of %s before publication",
    fixtureScope.run(async (ref) => {
      const f = await fixture();
      await f.git(["branch", "elsewhere"]);
      await f.write("selected", "changed\n");
      const p = await f.prepare(),
        head = await f.head();
      const index = await fs.readFile(path.join(f.root, ".git/index"));
      let injected = false;
      f.setBefore(async (command) => {
        if (command !== "publish-ref" || injected) return;
        injected = true;
        await f.git(["symbolic-ref", ref, "refs/heads/elsewhere"]);
      });
      const result = await f.actions.execute(p.token);
      expect(result.status).not.toBe("committed");
      expect(injected).toBe(true);
      expect((await f.git(["rev-parse", "main"])).stdout.trim()).toBe(head);
      expect((await f.git(["rev-parse", "elsewhere"])).stdout.trim()).toBe(
        head,
      );
      expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    }),
  );
  it(
    "does not publish a private commit when the source branch moved before CAS",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      const p = await f.prepare();
      const index = await fs.readFile(path.join(f.root, ".git/index"));
      let foreign = "";
      f.setBefore(async (command) => {
        if (command !== "publish-ref") return;
        const tree = (await f.git(["rev-parse", "HEAD^{tree}"])).stdout.trim();
        foreign = (
          await f.git([
            "commit-tree",
            tree,
            "-p",
            await f.head(),
            "-m",
            "external",
          ])
        ).stdout.trim();
        await f.git(["update-ref", "HEAD", foreign]);
      });
      const r = await f.actions.execute(p.token);
      expect(r.status).toBe("uncertain");
      expect(r.recoveryPath).toBeTruthy();
      expect(await f.head()).toBe(foreign);
      expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    }),
  );
  it(
    "preserves source data if a foreign ref lock refuses native publication",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      const p = await f.prepare(),
        head = await f.head();
      const index = await fs.readFile(path.join(f.root, ".git/index"));
      f.setBefore(async (command) => {
        if (command === "publish-ref")
          await fs.writeFile(
            path.join(f.root, ".git/refs/heads/main.lock"),
            "foreign",
          );
      });
      const r = await f.actions.execute(p.token);
      expect(r.status).not.toBe("committed");
      expect(await f.head()).toBe(head);
      expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
      expect(
        await fs.readFile(
          path.join(f.root, ".git/refs/heads/main.lock"),
          "utf8",
        ),
      ).toBe("foreign");
    }),
  );
  it(
    "preserves info attributes precedence with native CRLF normalization",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "changed\r\n");
      await f.write(".gitattributes", "selected -text\n");
      await fs.mkdir(path.join(f.root, ".git/info"), { recursive: true });
      await fs.writeFile(
        path.join(f.root, ".git/info/attributes"),
        "selected text eol=crlf\n",
      );
      const result = await f.actions.execute((await f.prepare()).token);
      expect(result.status, JSON.stringify(result)).toBe("committed");
      expect((await f.git(["show", "HEAD:selected"])).stdout).toBe("changed\n");
      expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
        "changed\r\n",
      );
    }),
  );
  it(
    "verifies Unicode messages independently of configured log output encoding",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["config", "i18n.logOutputEncoding", "ISO-8859-1"]);
      await f.write("selected", "changed\n");
      const p = await f.prepare(["selected"], "café");
      expect(await f.actions.execute(p.token)).toMatchObject({
        status: "committed",
        indexPublished: true,
      });
    }),
  );
  it(
    "uses native commit only, retains unrelated staged/worktree content and removes successful recovery",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "staged\n");
      await f.git(["add", "selected"]);
      await f.write("selected", "whole\n");
      await f.write("other", "staged other\n");
      await f.git(["add", "other"]);
      await f.write("other", "working other\n");
      const p = await f.prepare();
      const r = await f.actions.execute(p.token);
      expect(r).toMatchObject({ status: "committed", indexPublished: true });
      expect(r.recoveryPath).toBeUndefined();
      expect((await f.git(["show", "HEAD:selected"])).stdout).toBe("whole\n");
      expect((await f.git(["show", "HEAD:other"])).stdout).toBe("base\n");
      expect((await f.git(["show", ":other"])).stdout).toBe("staged other\n");
      expect(await fs.readFile(path.join(f.root, "other"), "utf8")).toBe(
        "working other\n",
      );
      expect(f.commands.filter((c) => c.includes("commit"))).toHaveLength(1);
      expect(f.commands.flat()).not.toContain("commit-tree");
      expect(
        (await fs.readdir(path.join(f.root, ".git"))).filter(
          (n) => n.startsWith("goga-") || n.endsWith(".lock"),
        ),
      ).toEqual([]);
      const record = JSON.parse(
        await fs.readFile(
          path.join(
            f.directory,
            (await fs.readdir(f.directory)).find((n) => n.endsWith(".json"))!,
          ),
          "utf8",
        ),
      );
      expect(record).toMatchObject({ state: "completed", recovery: null });
    }),
  );
  it.each(["sha1", "sha256"])(
    "creates unborn %s commit without unrelated staged additions",
    fixtureScope.run(async (format) => {
      const f = await fixture(true, format);
      await f.write("new", "new\n");
      await f.write("other", "other\n");
      await f.git(["add", "other"]);
      const r = await f.actions.execute((await f.prepare(["new"])).token);
      expect(
        r.status,
        JSON.stringify({
          r,
          commands: f.commands,
          index: (await f.git(["ls-files", "--stage", "-z"])).stdout,
          status: (await f.git(["status", "--porcelain=v2", "-z"])).stdout,
          record: r.recoveryPath
            ? JSON.parse(await fs.readFile(r.recoveryPath, "utf8")).result
            : null,
        }),
      ).toBe("committed");
      expect((await f.git(["ls-tree", "--name-only", "HEAD"])).stdout).toBe(
        "new\n",
      );
      expect((await f.git(["diff", "--cached", "--name-only"])).stdout).toBe(
        "other\n",
      );
    }),
  );
  it(
    "preserves literal rename, deletion, untracked, Unicode/newline, wildcard and leading dash paths",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["mv", "selected", "renamed\nЮ"]);
      await fs.unlink(path.join(f.root, "other"));
      const names = ["-option", ":(glob)*", "space name", "line\nfile"];
      for (const name of names) await f.write(name, "new\n");
      expect(
        (
          await f.actions.execute(
            (await f.prepare(["renamed\nЮ", "other", ...names])).token,
          )
        ).status,
      ).toBe("committed");
      expect(
        (await f.git(["ls-tree", "-r", "--name-only", "-z", "HEAD"])).stdout
          .split("\0")
          .filter(Boolean)
          .sort(),
      ).toEqual(["renamed\nЮ", ...names].sort());
    }),
  );
  it(
    "does not execute hooks and preserves complete message",
    fixtureScope.run(async () => {
      const f = await fixture();
      const marker = path.join(f.home, "hook-ran");
      for (const hook of [
        "pre-commit",
        "prepare-commit-msg",
        "commit-msg",
        "post-commit",
        "reference-transaction",
      ])
        await fs.writeFile(
          path.join(f.root, ".git/hooks", hook),
          `#!/bin/sh\ntouch '${marker}'\n`,
          { mode: 0o700 },
        );
      await f.write("selected", "changed\n");
      expect(
        (
          await f.actions.execute(
            (await f.prepare(["selected"], "Subject\n\nBody\n")).token,
          )
        ).status,
      ).toBe("committed");
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await f.git(["log", "-1", "--format=%B"])).stdout).toBe(
        "Subject\n\nBody\n\n",
      );
    }),
  );
  it.each(["owner", "selected", "index"])(
    "rejects stale %s before native mutation",
    fixtureScope.run(async (kind) => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      const p = await f.prepare();
      const old = await f.head();
      if (kind === "owner") f.setOwner("changed");
      else if (kind === "selected") await f.write("selected", "raced\n");
      else {
        await f.write("other", "staged race\n");
        await f.git(["add", "other"]);
      }
      await expect(f.actions.execute(p.token)).rejects.toThrow();
      expect(await f.head()).toBe(old);
      expect(f.commands).toEqual([]);
    }),
  );
  it(
    "keeps unrelated index flags",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["update-index", "--assume-unchanged", "other"]);
      await f.git(["update-index", "--skip-worktree", "other"]);
      const flags = (await f.git(["ls-files", "-v", "-z", "--", "other"]))
        .stdout;
      await f.write("selected", "changed\n");
      expect((await f.actions.execute((await f.prepare()).token)).status).toBe(
        "committed",
      );
      expect(
        (await f.git(["ls-files", "-v", "-z", "--", "other"])).stdout,
      ).toBe(flags);
    }),
  );
  it(
    "retains recovery and refuses replay after lost process settlement",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      const p = await f.prepare();
      f.setFault(async (command, r) => {
        if (command !== "commit") return r;
        throw new ByteCommandError(
          "process-unsettled",
          false,
          r.stdout,
          r.stderr,
          null,
          null,
        );
      });
      const r = await f.actions.execute(p.token);
      expect(r).toMatchObject({
        status: "uncertain",
        indexPublished: false,
        recoveryPath: expect.any(String),
      });
      await expect(f.actions.execute(p.token)).rejects.toThrow();
      expect(f.commands.filter((c) => c.includes("commit"))).toHaveLength(1);
      expect(r.recoveryPath!.startsWith(f.directory)).toBe(true);
    }),
  );
  it.each([1, 2])(
    "retains recovery after native reference cleanup warning at transaction %s",
    fixtureScope.run(async (warningAt) => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      let count = 0;
      const lock = path.join(f.root, ".git/HEAD.lock");
      f.setFault(async (command, r) => {
        if (command !== "publish-ref" || ++count !== warningAt) return r;
        await fs.writeFile(lock, "retained native lock");
        return { ...r, stderr: Buffer.from("ref cleanup warning") };
      });
      const result = await f.actions.execute((await f.prepare()).token);
      expect(result).toMatchObject({
        status: "uncertain",
        indexPublished: warningAt === 2,
        recoveryPath: expect.any(String),
      });
      expect(result.log).toContain("ref cleanup warning");
      expect(await fs.readFile(lock, "utf8")).toBe("retained native lock");
    }),
  );
  it(
    "pins HEAD while native selected index publication is in progress",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["branch", "elsewhere"]);
      await f.write("selected", "changed\n");
      let prevented = false;
      f.setBefore(async (command) => {
        if (command === "publish-index") {
          try {
            await f.git(["symbolic-ref", "HEAD", "refs/heads/elsewhere"]);
          } catch {
            prevented = true;
          }
        }
      });
      const result = await f.actions.execute((await f.prepare()).token);
      expect(prevented).toBe(true);
      expect(result.status).toBe("committed");
    }),
  );
  it(
    "reports known index publication when the final owner read fails",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      f.setFault(async (command, result) => {
        if (command === "publish-index")
          f.context.verify = async () => {
            throw Error("owner unavailable");
          };
        return result;
      });
      const result = await f.actions.execute((await f.prepare()).token);
      expect(result).toMatchObject({
        status: "uncertain",
        indexPublished: true,
        recoveryPath: expect.any(String),
      });
      expect((await f.git(["diff", "--cached", "--name-only"])).stdout).toBe(
        "",
      );
    }),
  );
  it(
    "retains independent staged bytes and flags in recovery after lost settlement",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "selected staged\n");
      await f.write("other", "other staged\n");
      await f.git(["add", "selected", "other"]);
      const staged = (await f.git(["ls-files", "--stage", "-z"])).stdout;
      const flags = (await f.git(["ls-files", "-v", "-z"])).stdout;
      await f.write("selected", "selected working\n");
      await f.write("other", "other working\n");
      f.setFault(async (command, r) => {
        if (command === "publish-index")
          throw new ByteCommandError(
            "process-unsettled",
            false,
            r.stdout,
            r.stderr,
            null,
            null,
          );
        return r;
      });
      const result = await f.actions.execute((await f.prepare()).token);
      expect(result.status).toBe("uncertain");
      const saved = JSON.parse(
        await fs.readFile(result.recoveryPath!, "utf8"),
      ).recovery;
      expect(Buffer.from(saved.indexData, "base64").toString()).toBe(staged);
      expect(saved.indexRecovery).toBeDefined();
      expect(Buffer.from(saved.indexRecovery.flags, "base64").toString()).toBe(
        flags,
      );
      expect(
        saved.indexRecovery.objects
          .map((o: { data: string }) =>
            Buffer.from(o.data, "base64").toString(),
          )
          .sort(),
      ).toEqual(["other staged\n", "selected staged\n"]);
      expect(
        saved.files
          .map((o: { data: string }) =>
            Buffer.from(o.data, "base64").toString(),
          )
          .sort(),
      ).toEqual(["other working\n", "selected working\n"]);
    }),
  );
  it(
    "retains foreign index edits instead of overwriting them after commit",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      f.setFault(async (c, r) => {
        if (c === "publish-ref") {
          await f.write("other", "foreign\n");
          await f.git(["add", "other"]);
        }
        return r;
      });
      const r = await f.actions.execute((await f.prepare()).token);
      expect(r.status).toBe("uncertain");
      expect(r.recoveryPath).toBeTruthy();
      expect((await f.git(["show", ":other"])).stdout).toBe("foreign\n");
      expect(f.commands.filter((c) => c.includes("commit"))).toHaveLength(1);
    }),
  );
  it(
    "keeps native signing rejection unchanged for tracked and newly added files",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      // A signing failure is a real native failure, not a fake zero exit.
      await f.git(["config", "commit.gpgsign", "true"]);
      await f.git(["config", "gpg.program", "/usr/bin/false"]);
      const old = await f.head();
      const r = await f.actions.execute((await f.prepare()).token);
      expect(r.status).toBe("not-committed");
      expect(await f.head()).toBe(old);
      await f.write("new", "new\n");
      const partial = await f.actions.execute((await f.prepare(["new"])).token);
      expect(partial).toMatchObject({
        status: "not-committed",
      });
      expect(partial.recoveryPath).toBeUndefined();
      expect(await f.head()).toBe(old);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "preserves detached HEAD, executable bits, CRLF conversion and binary bytes",
    fixtureScope.run(async () => {
      const f = await fixture();
      const branch = await f.head();
      await f.git(["switch", "--detach"]);
      await f.git(["config", "core.autocrlf", "true"]);
      await f.write("selected", "new\r\n");
      await fs.chmod(path.join(f.root, "selected"), 0o700);
      const bytes = Buffer.from([0, 1, 13, 10, 255]);
      await f.write("binary", bytes);
      const r = await f.actions.execute(
        (await f.prepare(["selected", "binary"])).token,
      );
      expect(r.status, JSON.stringify(r)).toBe("committed");
      expect((await f.git(["rev-parse", "main"])).stdout.trim()).toBe(branch);
      expect((await f.git(["show", "HEAD:selected"])).stdout).toBe("new\n");
      expect(
        (await f.git(["ls-tree", "HEAD", "--", "selected"])).stdout,
      ).toMatch(/^100755 /);
      expect(await fs.readFile(path.join(f.root, "binary"))).toEqual(bytes);
      expect((await fs.stat(path.join(f.root, "selected"))).mode & 0o777).toBe(
        0o700,
      );
    }),
  );
  it(
    "preserves staged executable mode when core.filemode is disabled",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["config", "core.filemode", "false"]);
      await f.git(["update-index", "--chmod=+x", "selected"]);
      await f.write("selected", "changed\n");
      const result = await f.actions.execute((await f.prepare()).token);
      expect(
        result.status,
        JSON.stringify({
          result,
          tree: (await f.git(["ls-tree", "HEAD", "--", "selected"])).stdout,
          index: (await f.git(["ls-files", "--stage", "selected"])).stdout,
        }),
      ).toBe("committed");
      expect(
        (await f.git(["ls-tree", "HEAD", "--", "selected"])).stdout,
      ).toMatch(/^100755 /);
    }),
  );
  it(
    "does not create an empty commit for reverted selected worktree",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "staged\n");
      await f.git(["add", "selected"]);
      await f.write("selected", "base\n");
      const head = await f.head(),
        index = await fs.readFile(path.join(f.root, ".git/index"));
      const r = await f.actions.execute((await f.prepare()).token);
      expect(r.status).toBe("not-committed");
      expect(await f.head()).toBe(head);
      expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    }),
  );
  it(
    "commits staged deletions without including an unrelated staged addition",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["rm", "selected"]);
      await f.write("new", "new\n");
      await f.git(["add", "new"]);
      expect((await f.actions.execute((await f.prepare()).token)).status).toBe(
        "committed",
      );
      expect((await f.git(["ls-tree", "--name-only", "HEAD"])).stdout).toBe(
        "other\n",
      );
      expect((await f.git(["diff", "--cached", "--name-only"])).stdout).toBe(
        "new\n",
      );
    }),
  );
  it(
    "refuses a foreign index lock without deleting it or starting a native write",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      const p = await f.prepare();
      await fs.writeFile(path.join(f.root, ".git/index.lock"), "foreign");
      await expect(f.actions.execute(p.token)).rejects.toThrow();
      expect(f.commands).toEqual([]);
      expect(
        await fs.readFile(path.join(f.root, ".git/index.lock"), "utf8"),
      ).toBe("foreign");
    }),
  );
  it(
    "does not execute filters while refreshing unrelated files",
    fixtureScope.run(async () => {
      const f = await fixture(),
        marker = path.join(f.home, "filter-ran");
      await f.git([
        "config",
        "filter.external.clean",
        `touch '${marker}'; cat`,
      ]);
      await f.write(".gitattributes", "other filter=external\n");
      await f.git(["add", ".gitattributes"]);
      await f.write("other", "new unrelated\n");
      await f.write("selected", "new selected\n");
      await fs.rm(marker, { force: true });
      const preview = await f.prepare();
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      const r = await f.actions.execute(preview.token);
      expect(r.status, JSON.stringify(r)).toBe("committed");
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    }),
  );
  it(
    "stops before commit if the user changes a selected file after private preparation",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("new", "confirmed\n");
      const head = await f.head();
      f.setFault(async (command, result) => {
        if (command === "add") await f.write("new", "foreign\n");
        return result;
      });
      const r = await f.actions.execute((await f.prepare(["new"])).token);
      expect(r.status).toBe("uncertain");
      expect(r.recoveryPath).toBeTruthy();
      expect(await f.head()).toBe(head);
      expect(f.commands.filter((c) => c.includes("commit"))).toHaveLength(0);
      expect(await fs.readFile(path.join(f.root, "new"), "utf8")).toBe(
        "foreign\n",
      );
    }),
  );
  it(
    "blocks new execution after uncertain result even with a restarted journal",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "first\n");
      f.setFault(async (command, r) => {
        if (command !== "commit") return r;
        throw new ByteCommandError(
          "process-unsettled",
          false,
          r.stdout,
          r.stderr,
          null,
          null,
        );
      });
      const r = await f.actions.execute((await f.prepare()).token);
      expect(r.status).toBe("uncertain");
      f.context.native.journal = new NativeGitJournal({
        directory: f.directory,
      });
      f.setFault(undefined);
      await f.write("selected", "second\n");
      const next = new NativeGitWorkspaceActions({
        context: async (_scope, fn) => fn(f.context),
      });
      const p = await next.prepare({
        scope: "project",
        revision: (await f.reader.snapshot()).revision,
        paths: ["selected"],
        message: "do not retry",
      });
      await expect(next.execute(p.token)).rejects.toThrow();
      expect(f.commands.filter((c) => c.includes("commit"))).toHaveLength(1);
    }),
  );
  it(
    "retains recovery and the foreign lock if native real-index update fails after commit",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "new\n");
      const head = await f.head(),
        index = await fs.readFile(path.join(f.root, ".git/index"));
      f.setBefore(async (command) => {
        if (command === "publish-index")
          await fs.writeFile(path.join(f.root, ".git/index.lock"), "foreign");
      });
      const r = await f.actions.execute((await f.prepare()).token);
      expect(r).toMatchObject({
        status: "uncertain",
        indexPublished: false,
        recoveryPath: expect.any(String),
      });
      expect(await f.head()).not.toBe(head);
      expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
      expect(
        await fs.readFile(path.join(f.root, ".git/index.lock"), "utf8"),
      ).toBe("foreign");
      expect(f.commands.filter((c) => c.includes("commit"))).toHaveLength(1);
    }),
  );
  it(
    "does not update the real index after HEAD changes in the native commit/index gap",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["branch", "elsewhere"]);
      await f.write("selected", "new\n");
      const index = await fs.readFile(path.join(f.root, ".git/index"));
      f.setFault(async (command, r) => {
        if (command === "publish-ref")
          await f.git(["symbolic-ref", "HEAD", "refs/heads/elsewhere"]);
        return r;
      });
      const r = await f.actions.execute((await f.prepare()).token);
      expect(r.status).toBe("uncertain");
      expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
      expect((await f.git(["symbolic-ref", "HEAD"])).stdout.trim()).toBe(
        "refs/heads/elsewhere",
      );
    }),
  );
});

describe("native commit retained admission", () => {
  it(
    "rejects empty, duplicate, unsafe paths, unknown keys and blank/oversized messages",
    fixtureScope.run(() => {
      const valid = {
        scope: "project",
        revision: "a".repeat(64),
        paths: ["a"],
        message: "ok",
      };
      expect(gitCommitRequestSchema.safeParse(valid).success).toBe(true);
      for (const patch of [
        { paths: [] },
        { paths: ["a", "a"] },
        { paths: ["../outside"] },
        { paths: [".git/config"] },
        { message: " \n " },
        { message: "a".repeat(16385) },
        { message: "bad\0message" },
        { root: "/tmp" },
      ])
        expect(
          gitCommitRequestSchema.safeParse({ ...valid, ...patch }).success,
        ).toBe(false);
    }),
  );
  it(
    "fails closed on missing configured identity",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      await f.git(["config", "--unset", "user.name"]);
      await f.git(["config", "--unset", "user.email"]);
      await expect(f.prepare()).rejects.toThrow();
    }),
  );
  it(
    "refuses external clean filters without running them",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      await f.write(".gitattributes", "selected filter=hostile\n");
      await f.git(["config", "filter.hostile.clean", "touch filter-ran; cat"]);
      await expect(f.prepare()).rejects.toThrow(/filter|фильтр/i);
      await expect(fs.stat(path.join(f.root, "filter-ran"))).rejects.toThrow();
    }),
  );
  it(
    "refuses symlinks, nested repositories and active operations before commit",
    fixtureScope.run(async () => {
      const f = await fixture();
      await fs.symlink(path.join(f.root, "other"), path.join(f.root, "link"));
      await expect(f.prepare(["link"])).rejects.toThrow(/ссыл|тип|файл/i);
      await fs.mkdir(path.join(f.root, "nested"));
      await fs.mkdir(path.join(f.root, "nested/.git"));
      await f.write("nested/a", "nested\n");
      await expect(f.prepare(["nested/a"])).rejects.toThrow();
      await f.write("selected", "changed\n");
      await fs.writeFile(
        path.join(f.root, ".git/MERGE_HEAD"),
        `${await f.head()}\n`,
      );
      await expect(f.prepare()).rejects.toThrow(/операц|слиян/i);
    }),
  );
  it(
    "accepts literal object-prototype filenames and nested paths",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("__proto__", "literal path\n");
      await fs.mkdir(path.join(f.root, "folder"));
      await f.write("folder/deep file", "nested\n");
      const p = await f.prepare(["__proto__", "folder/deep file"]);
      expect((await f.actions.execute(p.token)).status).toBe("committed");
      expect((await f.git(["show", "HEAD:__proto__"])).stdout).toBe(
        "literal path\n",
      );
      expect((await f.git(["show", "HEAD:folder/deep file"])).stdout).toBe(
        "nested\n",
      );
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "refuses a recreated rename source unless it was explicitly selected",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["mv", "selected", "renamed"]);
      await f.write("selected", "unselected recreated content\n");
      const before = await f.index(),
        head = await f.head();
      await expect(f.prepare(["renamed"])).rejects.toThrow(
        /переимен|исходн|выбер/i,
      );
      expect(await f.index()).toEqual(before);
      expect(await f.head()).toBe(head);
      const p = await f.prepare(["renamed", "selected"]);
      expect((await f.actions.execute(p.token)).status).toBe("committed");
      expect((await f.git(["show", "HEAD:selected"])).stdout).toBe(
        "unselected recreated content\n",
      );
    }),
  );
  it(
    "preserves explicit executable mode, message, author, committer and HEAD reflog",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "executable\n");
      await fs.chmod(path.join(f.root, "selected"), 0o755);
      const message = "subject\n\nbody with trailing spaces  \n";
      const p = await f.prepare(["selected"], message);
      expect((await f.actions.execute(p.token)).status).toBe("committed");
      expect((await f.git(["ls-tree", "HEAD", "selected"])).stdout).toMatch(
        /^100755 blob /,
      );
      expect((await f.git(["show", "-s", "--format=%B", "HEAD"])).stdout).toBe(
        message + "\n",
      );
      expect(
        (
          await f.git(["show", "-s", "--format=%an <%ae>|%cn <%ce>", "HEAD"])
        ).stdout.trim(),
      ).toBe(
        "Fixture <fixture@example.invalid>|Fixture <fixture@example.invalid>",
      );
      expect(
        (
          await f.git(["reflog", "show", "-1", "--format=%gs", "HEAD"])
        ).stdout.trim(),
      ).toBe("commit: subject");
    }),
  );
  it(
    "uses only owner execute bit when deriving Git file mode",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "group executable only\n");
      await fs.chmod(path.join(f.root, "selected"), 0o654);
      const p = await f.prepare();
      expect(await f.actions.execute(p.token)).toMatchObject({
        status: "committed",
        indexPublished: true,
      });
      expect((await f.git(["ls-tree", "HEAD", "selected"])).stdout).toMatch(
        /^100644 blob /,
      );
    }),
  );
});

describe("native commit token boundaries", () => {
  it(
    "expires tickets and denies replay",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      const p = await f.prepare();
      f.setNow(p.expiresAt + 1);
      await expect(f.actions.execute(p.token)).rejects.toThrow(
        /ист|подтверж|токен/i,
      );
      f.setNow(1000);
      const p2 = await f.prepare();
      await f.actions.execute(p2.token);
      await expect(f.actions.execute(p2.token)).rejects.toThrow(
        /подтверж|токен/i,
      );
    }),
  );
  it(
    "rechecks expiry after waiting for serialized context admission",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      let time = 1000,
        delay = false;
      const actions = new NativeGitWorkspaceActions({
        now: () => time,
        context: async (_scope, run) => {
          if (delay) time += 300001;
          return run(f.context);
        },
      });
      const p = await actions.prepare({
        scope: "project",
        revision: (await f.reader.snapshot()).revision,
        paths: ["selected"],
        message: "before expiry",
      });
      delay = true;
      const before = await f.index();
      await expect(actions.execute(p.token)).rejects.toThrow(/ист|подтверж/i);
      expect(await f.index()).toEqual(before);
    }),
  );
});

it.each(["COMMIT_EDITMSG", "logs/HEAD"])(
  "refuses linked metadata %s before native writes",
  fixtureScope.run(async (name) => {
    const f = await fixture();
    await f.write("selected", "changed");
    const outside = path.join(f.home, "outside");
    await fs.writeFile(outside, "untouched");
    await fs.rm(path.join(f.root, ".git", name), { force: true });
    await fs.symlink(outside, path.join(f.root, ".git", name));
    await expect(f.prepare()).rejects.toThrow();
    expect(await fs.readFile(outside, "utf8")).toBe("untouched");
    expect(f.commands).toEqual([]);
  }),
);
it(
  "refuses a real index change during private preparation before publishing HEAD",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.write("selected", "changed");
    const head = await f.head();
    let changed = false;
    f.setBefore(async (command) => {
      if (command === "add" && !changed) {
        changed = true;
        await f.write("other", "external staged");
        await f.git(["add", "other"]);
      }
    });
    const result = await f.actions.execute((await f.prepare()).token);
    expect(result.status).not.toBe("committed");
    expect(await f.head()).toBe(head);
    expect((await f.git(["show", ":other"])).stdout).toBe("external staged");
  }),
);

it(
  "retains recovery after successful live index publication with a cleanup warning",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    f.setFault(async (command, result) =>
      command === "publish-index"
        ? { ...result, stderr: Buffer.from("index cleanup warning") }
        : result,
    );
    const result = await f.actions.execute((await f.prepare()).token);
    expect(result).toMatchObject({
      status: "uncertain",
      indexPublished: true,
      recoveryPath: expect.any(String),
    });
    expect(result.log).toContain("index cleanup warning");
  }),
);

it(
  "retains portable recovery when outer context cleanup fails after a verified commit",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.write("selected", "staged version\n");
    await f.git(["add", "selected"]);
    await f.write("selected", "committed work\n");
    let fail = false;
    const actions = new NativeGitWorkspaceActions({
      context: async (_scope, run) => {
        const result = await run(f.context);
        if (fail) throw Error("fixture outer cleanup failed");
        return result;
      },
    });
    const p = await actions.prepare({
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      paths: ["selected"],
      message: "outer cleanup",
    });
    f.setFault(async (command, result) =>
      command === "commit"
        ? { ...result, stdout: Buffer.from("fixture-secret-native-commit") }
        : result,
    );
    fail = true;
    const result = await actions.execute(p.token);
    expect(result).toMatchObject({
      status: "uncertain",
      indexPublished: true,
      recoveryPath: expect.any(String),
    });
    expect(result.log).not.toContain("fixture-secret-native-commit");
    const recovery = JSON.parse(
      await fs.readFile(result.recoveryPath!, "utf8"),
    );
    expect(
      recovery.recovery.indexRecovery.objects.some(
        (o: { data: string }) =>
          Buffer.from(o.data, "base64").toString() === "staged version\n",
      ),
    ).toBe(true);
    expect((await f.git(["show", "HEAD:selected"])).stdout).toBe(
      "committed work\n",
    );
    await expect(actions.execute(p.token)).rejects.toThrow();
  }),
);

it(
  "keeps indexPublished true when the prepared deadline expires immediately after native publication",
  fixtureScope.run(async () => {
    const f = await fixture(false, "sha1", 10000);
    await f.write("selected", "committed work\n");
    const clock = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock() + offset);
    f.setFault(async (command, result) => {
      if (command === "publish-index") offset = 20000;
      return result;
    });
    const result = await f.actions.execute((await f.prepare()).token);
    expect(result).toMatchObject({
      status: "uncertain",
      indexPublished: true,
      recoveryPath: expect.any(String),
    });
    expect((await f.git(["show", ":selected"])).stdout).toBe(
      "committed work\n",
    );
  }),
);
it(
  "keeps published facts and portable recovery when final journal persistence fails",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.write("selected", "staged before\n");
    await f.git(["add", "selected"]);
    await f.write("selected", "committed work\n");
    let published = false;
    f.setFault(async (command, result) => {
      if (command === "publish-index") published = true;
      return result;
    });
    // Inject a storage boundary failure, not a Git/index-format implementation.
    const storage = f.journal as unknown as {
      write(...args: unknown[]): Promise<unknown>;
    };
    const write = storage.write.bind(storage);
    vi.spyOn(storage, "write").mockImplementation(async (...args) => {
      if (published && (args[1] as { state: string }).state === "completed")
        throw Object.assign(Error("journal write failed"), { code: "EIO" });
      return write(...args);
    });
    const result = await f.actions.execute((await f.prepare()).token);
    expect(result).toMatchObject({
      status: "uncertain",
      indexPublished: true,
      recoveryPath: expect.any(String),
    });
    const record = JSON.parse(await fs.readFile(result.recoveryPath!, "utf8"));
    expect(
      record.recovery.indexRecovery.objects.some(
        (o: { data: string }) =>
          Buffer.from(o.data, "base64").toString() === "staged before\n",
      ),
    ).toBe(true);
    expect((await f.git(["show", ":selected"])).stdout).toBe(
      "committed work\n",
    );
  }),
);
