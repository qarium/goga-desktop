import { installNativeCommitFixture } from "./helpers/native-commit-fixture";
import { gitIntegrationBudget } from "./helpers/git-integration";
import { gitCommitRequestSchema } from "../src/shared/git-commit";
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import mutableFs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { nativeGitIndex } from "../src/host/git-index-scope";
import { AsyncResource } from "node:async_hooks";
import {
  NodeRunner,
  ByteCommandError,
  CommandExitError,
  type ByteCommandResult,
} from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { CommitProofReader } from "../src/host/git-commit-proof";
import { GitCommitCoordinator } from "../src/host/git-commit-coordinator";
import { NativeGitWorkspaceActions } from "../src/host/git-native-commit";
import { GitMergeSafety } from "../src/host/git-merge-safety";
import { NativeGitJournal } from "../src/host/git-native-journal";
import {
  createNativeGitCapability,
  nativeIntent,
} from "../src/host/git-native-context";

const { fixtureScope, fixture } = installNativeCommitFixture();

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
    gitIntegrationBudget(15000),
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
    gitIntegrationBudget(15000),
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
    gitIntegrationBudget(15000),
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

it(
  "commits with real global settings through frozen-index and live prepared verification",
  fixtureScope.run(async () => {
    const f = await fixture(
      false,
      "sha1",
      undefined,
      "[diff]\n algorithm = histogram\n[color]\n ui = auto\n",
    );
    await f.write("selected", "changed\n");
    const globalBefore = await fs.readFile(path.join(f.home, ".gitconfig"));
    const result = await f.actions.execute((await f.prepare()).token);
    expect(result.status).toBe("committed");
    expect((await f.git(["show", "HEAD:selected"])).stdout).toBe("changed\n");
    expect(await fs.readFile(path.join(f.home, ".gitconfig"))).toEqual(
      globalBefore,
    );
  }),
  gitIntegrationBudget(15000),
);

it(
  "batches twenty unique staged blobs once per fresh observation while keeping all native write checkpoints",
  fixtureScope.run(async () => {
    const f = await fixture();
    const paths = Array.from({ length: 20 }, (_, i) => `batch-${i}`);
    for (const [i, name] of paths.entries())
      await f.write(name, `staged ${i}\n`);
    await f.git(["add", "--", ...paths]);
    for (const [i, name] of paths.entries()) await f.write(name, `work ${i}\n`);
    const sharedCapture = vi.spyOn(
      f.actions as unknown as { capture(...args: unknown[]): Promise<unknown> },
      "capture",
    );
    f.nativeReads.length = 0;
    f.sourceReads.length = 0;
    const prepared = await f.prepare(paths);
    const reads = (command: string, arg: string) =>
      f.nativeReads.filter(
        (args) => args.includes(command) && args.includes(arg),
      );
    expect(sharedCapture).toHaveBeenCalledTimes(3);
    expect(
      f.sourceReads.filter(
        (args) => args.includes("ls-files") && args.includes("-v"),
      ),
    ).toHaveLength(0);
    expect(reads("ls-files", "-v")).toHaveLength(4);
    expect(reads("ls-files", "--stage")).toHaveLength(4);
    expect(reads("cat-file", "--batch-check")).toHaveLength(4);
    expect(reads("cat-file", "--batch")).toHaveLength(4);
    expect(reads("cat-file", "blob")).toHaveLength(0);
    f.nativeReads.length = 0;
    f.sourceReads.length = 0;
    sharedCapture.mockClear();
    const completed = await f.actions.execute(prepared.token);
    expect(completed.status).toBe("committed");
    expect(sharedCapture).toHaveBeenCalledTimes(3);
    expect(
      f.sourceReads.filter(
        (args) => args.includes("ls-files") && args.includes("-v"),
      ),
    ).toHaveLength(0);
    expect(reads("ls-files", "-v")).toHaveLength(24);
    expect(reads("ls-files", "--stage")).toHaveLength(26);
    expect(reads("cat-file", "--batch-check")).toHaveLength(24);
    expect(reads("cat-file", "--batch")).toHaveLength(24);
    expect(reads("cat-file", "blob")).toHaveLength(0);
    expect(f.commands.filter((args) => args.includes("commit"))).toHaveLength(
      1,
    );
    expect(
      f.commands.filter((args) => args.includes("update-ref")),
    ).toHaveLength(3);
    expect(
      f.commands.filter((args) => args.includes("update-index")),
    ).toHaveLength(2);
    for (const [i, name] of paths.entries())
      expect((await f.git(["show", `:${name}`])).stdout).toBe(`work ${i}\n`);
  }),
  gitIntegrationBudget(15000),
);

it.each([
  "config",
  "include",
  "global",
  "attributes",
  "global attributes",
  "flags",
  "deleted object",
  "corrupt object",
] as const)(
  "fresh native observation rejects late %s drift without executing a clean filter",
  fixtureScope.run(async (kind) => {
    const f = await fixture(false, "sha1", undefined, "[color]\n ui = auto\n");
    await f.write("selected", "staged before\n");
    await f.git(["add", "selected"]);
    await f.write("selected", "work after\n");
    const include = path.join(f.home, "included");
    await fs.writeFile(include, "[color]\n diff = false\n");
    await f.git(["config", "include.path", include]);
    const attributeSource = path.join(f.home, "global-attributes");
    if (kind === "global attributes") {
      await fs.writeFile(attributeSource, "selected -text\n");
      await f.git(["config", "core.attributesfile", attributeSource]);
    }
    const prepared = await f.prepare();
    const beforeHead = await f.head(),
      beforeIndex = await f.index();
    const oid = (await f.git(["rev-parse", ":selected"])).stdout.trim();
    const object = path.join(
      f.root,
      ".git/objects",
      oid.slice(0, 2),
      oid.slice(2),
    );
    const sentinel = path.join(f.home, "filter-ran");
    let changed = false;
    f.nativeReads.length = 0;
    f.setAfterNativeRead(async (args) => {
      const betweenObservations = [
        "flags",
        "deleted object",
        "corrupt object",
      ].includes(kind);
      if (
        changed ||
        !(betweenObservations
          ? args.includes("cat-file") && args.includes("--batch")
          : args.includes("ls-files") && args.includes("--stage"))
      )
        return;
      changed = true;
      if (kind === "config")
        await fs.appendFile(
          path.join(f.root, ".git/config"),
          "\n[color]\n ui = never\n",
        );
      if (kind === "include")
        await fs.appendFile(include, "\n[color]\n ui = never\n");
      if (kind === "global")
        await fs.appendFile(
          path.join(f.home, ".gitconfig"),
          "\n[color]\n ui = never\n",
        );
      if (kind === "attributes")
        await f.write(".gitattributes", "selected text eol=crlf\n");
      if (kind === "global attributes")
        await fs.writeFile(attributeSource, "selected text eol=crlf\n");
      if (kind === "flags")
        await f.git(["update-index", "--assume-unchanged", "other"]);
      if (kind === "deleted object") await fs.unlink(object);
      if (kind === "corrupt object") {
        const { deflateSync } = await import("node:zlib");
        await fs.writeFile(
          object,
          deflateSync(Buffer.from("blob 14\0corrupt bytes\n")),
        );
      }
    });
    await expect(f.actions.execute(prepared.token)).rejects.toThrow();
    expect(changed).toBe(true);
    if (["config", "include", "global"].includes(kind)) {
      expect(
        f.nativeReads.filter((args) => args.includes("cat-file")),
      ).toHaveLength(0);
    }
    expect(await f.head()).toBe(beforeHead);
    if (kind !== "flags") expect(await f.index()).toEqual(beforeIndex);
    expect(await fs.readFile(sentinel).catch(() => null)).toBe(null);
    expect(f.commands.filter((args) => args.includes("commit"))).toHaveLength(
      0,
    );
  }),
  gitIntegrationBudget(15000),
);

it(
  "prototype budget: one selected commit preserves foreign staged and worktree bytes within 119 Git calls",
  fixtureScope.run(async () => {
    const f = await fixture(false, "sha1", undefined, undefined, true);
    await f.write("other", "foreign staged\n");
    await f.git(["add", "other"]);
    await f.write("other", "foreign worktree\n");
    await f.write("selected", "selected worktree\n");
    const phases: string[] = [];
    const prove = CommitProofReader.prototype.prove;
    const phaseSpy = vi
      .spyOn(CommitProofReader.prototype, "prove")
      .mockImplementation(async function (
        this: CommitProofReader,
        expected,
        readback,
      ) {
        phases.push(expected.phase);
        try {
          return await prove.call(this, expected, readback);
        } catch (error) {
          phases.push(String((error as Error).stack));
          throw error;
        }
      });
    fixtureScope().cleanup(() => phaseSpy.mockRestore());
    const preview = await f.prepare();
    const parent = await f.head();
    const staged = (await f.git(["show", ":other"])).stdout;
    const sharedCapture = vi.spyOn(
      f.actions as unknown as { capture(...args: unknown[]): Promise<unknown> },
      "capture",
    );
    f.nativeReads.length = 0;
    f.sourceReads.length = 0;
    const result = await f.actions.execute(preview.token);
    const executeGitCount = f.nativeReads.length + f.sourceReads.length;
    expect(result.status, phases.join("\n")).toBe("committed");
    expect((await f.git(["rev-parse", "HEAD^"])).stdout.trim()).toBe(parent);
    expect((await f.git(["show", "HEAD:selected"])).stdout).toBe(
      "selected worktree\n",
    );
    expect((await f.git(["show", "HEAD:other"])).stdout).toBe("base\n");
    expect((await f.git(["show", ":other"])).stdout).toBe(staged);
    expect(await fs.readFile(path.join(f.root, "other"), "utf8")).toBe(
      "foreign worktree\n",
    );
    expect(f.commands.filter((args) => args.includes("commit"))).toHaveLength(
      1,
    );
    expect.soft(sharedCapture).toHaveBeenCalledTimes(0);
    // SPEC-02: 6 independent closing scopes add 3 config/attribute discovery
    // calls each (the second status is moved, not duplicated). SPEC-03 adds the
    // original HEAD tree back to execute. Previous 100 bound + 18 + 1 = 119.
    expect(
      f.sourceReads.filter((args) => args.includes("status")),
    ).toHaveLength(12);
    expect(executeGitCount).toBeLessThanOrEqual(119);
  }),
  gitIntegrationBudget(15000),
);

describe("isolated commit coordinator phase boundaries", () => {
  it.each([
    "admit",
    "attempt-ready",
    "before-commit",
    "publish-prepared",
    "index-prepared",
    "result",
  ] as const)(
    "rejects a selected-byte edit at fresh %s without overwriting it",
    fixtureScope.run(async (phase) => {
      const f = await fixture(false, "sha1", undefined, undefined, true);
      await f.write("selected", "approved\n");
      const preview = await f.prepare(),
        before = await f.head(),
        index = await f.index();
      let injected = false;
      const original = CommitProofReader.prototype.prove;
      const spy = vi
        .spyOn(CommitProofReader.prototype, "prove")
        .mockImplementation(async function (
          this: CommitProofReader,
          expected,
          readback,
        ) {
          if (expected.phase === phase) {
            if (phase !== "admit") {
              const files = await fs.readdir(f.directory);
              expect(files.some((name) => name.endsWith(".pending"))).toBe(
                true,
              );
              const record = JSON.parse(
                await fs.readFile(
                  path.join(
                    f.directory,
                    files.find((name) => name.endsWith(".json"))!,
                  ),
                  "utf8",
                ),
              );
              expect(record.state).toBe("running");
            }
            if (phase === "publish-prepared" || phase === "index-prepared")
              expect(
                await fs.stat(path.join(f.root, ".git/HEAD.lock")),
              ).toBeTruthy();
            injected = true;
            await f.write("selected", "external\n");
          }
          return original.call(this, expected, readback);
        });
      fixtureScope().cleanup(() => spy.mockRestore());
      if (phase === "admit")
        await expect(f.actions.execute(preview.token)).rejects.toThrow();
      else {
        const result = await f.actions.execute(preview.token);
        expect(result.status).toBe("uncertain");
        expect(result.indexPublished).toBe(phase === "result");
        expect(result.recoveryPath).toEqual(expect.any(String));
      }
      expect(injected).toBe(true);
      expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
        "external\n",
      );
      if (!["index-prepared", "result"].includes(phase))
        expect(await f.head()).toBe(before);
      if (phase !== "result") expect(await f.index()).toEqual(index);
      expect(
        f.commands.filter((args) => args.includes("commit")).length,
      ).toBeLessThanOrEqual(1);
      await expect(f.actions.execute(preview.token)).rejects.toThrow();
    }),
  );
  it.each(["delete", "same-size-corruption"])(
    "fresh second object body rejects actual %s",
    fixtureScope.run(async (kind) => {
      const f = await fixture(false, "sha1", undefined, undefined, true);
      await f.write("selected", "approved\n");
      const preview = await f.prepare(),
        head = await f.head(),
        index = await f.index();
      const oid = (await f.git(["rev-parse", ":selected"])).stdout.trim();
      const object = path.join(
        f.root,
        ".git/objects",
        oid.slice(0, 2),
        oid.slice(2),
      );
      let injected = false;
      f.setAfterNativeRead(async (args) => {
        if (injected || !args.includes("--batch")) return;
        injected = true;
        if (kind === "delete") await fs.unlink(object);
        else {
          const { deflateSync } = await import("node:zlib");
          await fs.writeFile(
            object,
            deflateSync(Buffer.from("blob 5\0evil\n")),
          );
        }
      });
      await expect(f.actions.execute(preview.token)).rejects.toThrow();
      expect(injected).toBe(true);
      expect(await f.head()).toBe(head);
      expect(await f.index()).toEqual(index);
      expect(f.commands).toEqual([]);
    }),
  );
  it(
    "closes bytes after a mutation during the awaited authoritative owner read",
    fixtureScope.run(async () => {
      const f = await fixture(false, "sha1", undefined, undefined, true);
      await f.write("selected", "approved\n");
      const preview = await f.prepare(),
        head = await f.head();
      const owner = f.context.native.owner;
      let injected = false;
      f.context.native.owner = async () => {
        const result = await owner();
        if (!injected) {
          injected = true;
          await f.write("selected", "external\n");
        }
        return result;
      };
      await expect(f.actions.execute(preview.token)).rejects.toThrow();
      expect(injected).toBe(true);
      expect(await f.head()).toBe(head);
      expect(f.commands).toEqual([]);
    }),
  );
  it(
    "closes source and protected bytes after private-read cleanup awaits",
    fixtureScope.run(async () => {
      const f = await fixture(false, "sha1", undefined, undefined, true);
      await f.write("selected", "approved\n");
      const preview = await f.prepare(),
        head = await f.head(),
        original = fs.rm;
      let injected = false;
      const spy = vi
        .spyOn(mutableFs, "rm")
        .mockImplementation(async (filename, options) => {
          await original(filename, options);
          if (!injected && String(filename).includes("goga-git-read-")) {
            injected = true;
            await f.write("selected", "external\n");
          }
        });
      syncBuiltinESMExports();
      fixtureScope().cleanup(() => {
        spy.mockRestore();
        syncBuiltinESMExports();
      });
      await expect(f.actions.execute(preview.token)).rejects.toThrow();
      expect(injected).toBe(true);
      expect(await f.head()).toBe(head);
      expect(f.commands).toEqual([]);
    }),
  );
});

// Same real-Git regression assertions, isolated coordinator only; legacy tests above remain intact.
const prototypeFixture = (
  unborn = false,
  format = "sha1",
  deadline?: number,
  globalConfig?: string,
) => fixture(unborn, format, deadline, globalConfig, true);
describe("isolated coordinator regression parity", () => {
  it.each(["add", "commit"])(
    "never executes a newly installed clean filter during native %s",
    fixtureScope.run(async (phase) => {
      const f = await prototypeFixture();
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
      const f = await prototypeFixture();
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
      const f = await prototypeFixture();
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
      const f = await prototypeFixture();
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
      const f = await prototypeFixture();
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
  it.each(["sha1", "sha256"])(
    "creates unborn %s commit without unrelated staged additions",
    fixtureScope.run(async (format) => {
      const f = await prototypeFixture(true, format);
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
      const f = await prototypeFixture();
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
      const f = await prototypeFixture();
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
      const f = await prototypeFixture();
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
      const f = await prototypeFixture();
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
      const f = await prototypeFixture();
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
      const f = await prototypeFixture();
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
    "keeps native signing rejection unchanged for tracked and newly added files",
    fixtureScope.run(async () => {
      const f = await prototypeFixture();
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
      const f = await prototypeFixture();
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
    gitIntegrationBudget(15000),
  );
  it(
    "preserves staged executable mode when core.filemode is disabled",
    fixtureScope.run(async () => {
      const f = await prototypeFixture();
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
    "commits staged deletions without including an unrelated staged addition",
    fixtureScope.run(async () => {
      const f = await prototypeFixture();
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
    "stops before commit if the user changes a selected file after private preparation",
    fixtureScope.run(async () => {
      const f = await prototypeFixture();
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
      const f = await prototypeFixture();
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
      const next = new GitCommitCoordinator({
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
    "expires tickets and denies replay",
    fixtureScope.run(async () => {
      const f = await prototypeFixture();
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
    gitIntegrationBudget(15000),
  );
  it(
    "retains recovery after successful live index publication with a cleanup warning",
    fixtureScope.run(async () => {
      const f = await prototypeFixture();
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
      const f = await prototypeFixture();
      await f.write("selected", "staged version\n");
      await f.git(["add", "selected"]);
      await f.write("selected", "committed work\n");
      let fail = false;
      const actions = new GitCommitCoordinator({
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
      const f = await prototypeFixture(false, "sha1", 10000);
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
      const f = await prototypeFixture();
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
      const record = JSON.parse(
        await fs.readFile(result.recoveryPath!, "utf8"),
      );
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
});

// Delegate to the Git already selected by the caller/CI PATH, while proving
// that fixture setup and native writes do not bypass that selection.
async function controlledGitPath() {
  const original = process.env.PATH;
  let executable: string | undefined;
  for (const directory of (original ?? "").split(path.delimiter)) {
    const candidate = path.resolve(directory || ".", "git");
    try {
      await fs.access(candidate, fs.constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) {
        executable = candidate;
        break;
      }
    } catch (error) {
      if (
        !["ENOENT", "ENOTDIR", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
  if (!executable) throw Error("No executable Git in controlled PATH");
  const directory = await fs.mkdtemp("/private/tmp/goga-selected-git-");
  fixtureScope().cleanup(() =>
    fs.rm(directory, { recursive: true, force: true }),
  );
  const log = path.join(directory, "calls");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  await fs.writeFile(
    path.join(directory, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(log)}\nexec ${quote(executable)} "$@"\n`,
    { mode: 0o700 },
  );
  await fs.writeFile(log, "");
  process.env.PATH = directory + path.delimiter + (original ?? "");
  fixtureScope().cleanup(() => {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  });
  return {
    calls: async () => (await fs.readFile(log, "utf8")).trim().split("\n"),
    clear: () => fs.writeFile(log, ""),
  };
}

it.each([false, true])(
  "controlled PATH Git preserves global attrs and encoding with typed129 fallback=%s",
  fixtureScope.run(async (fallback) => {
    const selectedGit = await controlledGitPath();
    const f = await fixture(
      false,
      "sha1",
      undefined,
      "[core]\n autocrlf = false\n[color]\n ui = false\n",
      true,
    );
    expect(
      (await selectedGit.calls()).some((call) => call.startsWith("init ")),
    ).toBe(true);
    const attrs = path.join(f.home, "global-attributes");
    await fs.writeFile(attrs, "selected text eol=crlf\n");
    await f.git(["config", "core.attributesfile", attrs]);
    const original = f.context.git;
    f.context.git = async (args, options) => {
      if (
        fallback &&
        args.includes("var") &&
        args.includes("GIT_ATTR_SYSTEM")
      ) {
        f.sourceReads.push([...args]);
        throw new CommandExitError("synthetic unsupported exact var", 129);
      }
      return original(args, options);
    };
    await f.write("selected", "normalized\r\n");
    const preview = await f.prepare();
    f.sourceReads.length = 0;
    await selectedGit.clear();
    const result = await f.actions.execute(preview.token);
    expect(result.status).toBe("committed");
    expect((await f.git(["show", "HEAD:selected"])).stdout).toBe(
      "normalized\n",
    );
    expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
      "normalized\r\n",
    );
    const calls = await selectedGit.calls();
    for (const command of f.commands)
      expect(calls).toContain(command.join(" "));
    expect(f.commands.filter((args) => args.includes("commit"))).toHaveLength(
      1,
    );
    if (fallback) {
      expect(
        f.sourceReads.some((args) => args.includes("GIT_ATTR_SYSTEM")),
      ).toBe(true);
      expect(
        f.sourceReads.some((args) => args.includes("GIT_ATTR_GLOBAL")),
      ).toBe(false);
    }
  }),
);

it(
  "isolated coordinator rejects physical object-store replacement after confirmation",
  fixtureScope.run(async () => {
    const f = await prototypeFixture();
    await f.write("selected", "approved\n");
    const preview = await f.prepare(),
      head = await f.head(),
      index = await f.index();
    const objects = path.join(f.root, ".git/objects"),
      saved = path.join(f.dir, "original-objects");
    await fs.rename(objects, saved);
    await fs.cp(saved, objects, { recursive: true });
    await expect(f.actions.execute(preview.token)).rejects.toThrow();
    expect(await f.head()).toBe(head);
    expect(await f.index()).toEqual(index);
    expect(f.commands).toEqual([]);
  }),
);

it(
  "isolated coordinator permits a harmless unreachable object addition",
  fixtureScope.run(async () => {
    const f = await prototypeFixture();
    await f.write("selected", "approved\n");
    const preview = await f.prepare();
    await f.git(
      ["hash-object", "-w", "--stdin"],
      "unreachable fixture object\n",
    );
    expect((await f.actions.execute(preview.token)).status).toBe("committed");
    expect((await f.git(["show", "HEAD:selected"])).stdout).toBe("approved\n");
  }),
);

it(
  "isolated coordinator preserves a foreign index changed inside the second prepared callback",
  fixtureScope.run(async () => {
    const f = await prototypeFixture();
    await f.write("selected", "approved\n");
    const preview = await f.prepare();
    const original = CommitProofReader.prototype.prove;
    let foreign: Buffer | undefined;
    const spy = vi
      .spyOn(CommitProofReader.prototype, "prove")
      .mockImplementation(async function (
        this: CommitProofReader,
        expected,
        readback,
      ) {
        if (expected.phase === "index-prepared") {
          await f.write("other", "foreign staged\n");
          await f.git(["add", "other"]);
          foreign = await f.index();
        }
        return original.call(this, expected, readback);
      });
    fixtureScope().cleanup(() => spy.mockRestore());
    const result = await f.actions.execute(preview.token);
    expect(result).toMatchObject({
      status: "uncertain",
      indexPublished: false,
      recoveryPath: expect.any(String),
    });
    expect(foreign).toBeTruthy();
    expect(await f.index()).toEqual(foreign);
    expect((await f.git(["show", ":other"])).stdout).toBe("foreign staged\n");
  }),
);
it(
  "isolated coordinator rejects same-OID HEAD retarget inside the native prepared callback",
  fixtureScope.run(async () => {
    const f = await prototypeFixture();
    await f.git(["branch", "elsewhere"]);
    await f.write("selected", "approved\n");
    const preview = await f.prepare(),
      head = await f.head();
    const original = CommitProofReader.prototype.prove;
    const spy = vi
      .spyOn(CommitProofReader.prototype, "prove")
      .mockImplementation(async function (
        this: CommitProofReader,
        expected,
        readback,
      ) {
        if (expected.phase === "publish-prepared")
          await fs.writeFile(
            path.join(f.root, ".git/HEAD"),
            "ref: refs/heads/elsewhere\n",
          );
        return original.call(this, expected, readback);
      });
    fixtureScope().cleanup(() => spy.mockRestore());
    const result = await f.actions.execute(preview.token);
    expect(result).toMatchObject({
      status: "uncertain",
      indexPublished: false,
    });
    expect(await f.head()).toBe(head);
    expect((await f.git(["rev-parse", "main"])).stdout.trim()).toBe(head);
    expect((await f.git(["symbolic-ref", "HEAD"])).stdout).toBe(
      "refs/heads/elsewhere\n",
    );
  }),
);
it(
  "isolated coordinator retains recovery when a result-readback corrupts a protected object",
  fixtureScope.run(async () => {
    const f = await prototypeFixture();
    await f.write("selected", "approved\n");
    const preview = await f.prepare(),
      oid = (await f.git(["rev-parse", ":selected"])).stdout.trim();
    const object = path.join(
      f.root,
      ".git/objects",
      oid.slice(0, 2),
      oid.slice(2),
    );
    const original = CommitProofReader.prototype.prove;
    let injected = false;
    const spy = vi
      .spyOn(CommitProofReader.prototype, "prove")
      .mockImplementation(async function (
        this: CommitProofReader,
        expected,
        readback,
      ) {
        if (expected.phase === "result")
          f.setAfterNativeRead(async (args) => {
            if (injected || !args.includes("--batch")) return;
            injected = true;
            const { deflateSync } = await import("node:zlib");
            await fs.writeFile(
              object,
              deflateSync(Buffer.from("blob 5\0evil\n")),
            );
          });
        return original.call(this, expected, readback);
      });
    fixtureScope().cleanup(() => spy.mockRestore());
    const result = await f.actions.execute(preview.token);
    expect(result).toMatchObject({
      status: "uncertain",
      indexPublished: true,
      recoveryPath: expect.any(String),
    });
    expect(injected).toBe(true);
    const record = JSON.parse(await fs.readFile(result.recoveryPath!, "utf8"));
    expect(
      record.recovery.files.find(
        (file: { path: string }) => file.path === "selected",
      ).data,
    ).toBe(Buffer.from("approved\n").toString("base64"));
    expect((await f.git(["show", "HEAD:selected"])).stdout).toBe("approved\n");
  }),
);

it(
  "isolated coordinator publishes a packed branch without changing other packed refs",
  fixtureScope.run(async () => {
    const f = await prototypeFixture();
    await f.git(["branch", "other-branch"]);
    await f.git(["pack-refs", "--all"]);
    const packed = await fs.readFile(path.join(f.root, ".git/packed-refs"));
    const other = (await f.git(["rev-parse", "other-branch"])).stdout;
    await f.write("selected", "approved\n");
    const preview = await f.prepare();
    expect((await f.actions.execute(preview.token)).status).toBe("committed");
    expect(await fs.readFile(path.join(f.root, ".git/packed-refs"))).toEqual(
      packed,
    );
    expect((await f.git(["rev-parse", "other-branch"])).stdout).toBe(other);
    expect((await f.git(["show", "HEAD:selected"])).stdout).toBe("approved\n");
  }),
);
it.each([
  "config",
  "include",
  "global",
  "attributes",
  "global-attributes",
  "flags",
])(
  "isolated coordinator closes late %s drift after its first fresh object body",
  fixtureScope.run(async (kind) => {
    const f = await fixture(
      false,
      "sha1",
      undefined,
      "[color]\n ui = auto\n",
      true,
    );
    const include = path.join(f.home, "included"),
      attrs = path.join(f.home, "global-attributes");
    await fs.writeFile(include, "[color]\n diff = auto\n");
    await f.git(["config", "include.path", include]);
    await fs.writeFile(attrs, "selected -text\n");
    await f.git(["config", "core.attributesfile", attrs]);
    await f.write("selected", "approved\n");
    const preview = await f.prepare(),
      head = await f.head(),
      index = await f.index();
    let injected = false;
    f.setAfterNativeRead(async (args) => {
      if (injected || !args.includes("--batch")) return;
      injected = true;
      if (kind === "config")
        await fs.appendFile(
          path.join(f.root, ".git/config"),
          "\n[color]\n ui = false\n",
        );
      if (kind === "include")
        await fs.appendFile(include, "\n[color]\n diff = false\n");
      if (kind === "global")
        await fs.appendFile(
          path.join(f.home, ".gitconfig"),
          "\n[color]\n ui = false\n",
        );
      if (kind === "attributes")
        await f.write(".gitattributes", "selected text eol=crlf\n");
      if (kind === "global-attributes")
        await fs.writeFile(attrs, "selected text eol=crlf\n");
      if (kind === "flags")
        await f.git(["update-index", "--assume-unchanged", "other"]);
    });
    await expect(f.actions.execute(preview.token)).rejects.toThrow();
    expect(injected).toBe(true);
    expect(await f.head()).toBe(head);
    expect(f.commands).toEqual([]);
    if (kind !== "flags") expect(await f.index()).toEqual(index);
    else
      expect((await f.git(["ls-files", "-v", "other"])).stdout).toBe(
        "h other\n",
      );
  }),
);
it(
  "isolated coordinator keeps index publication facts after a failing final owner read",
  fixtureScope.run(async () => {
    const f = await prototypeFixture();
    await f.write("selected", "approved\n");
    const preview = await f.prepare();
    let published = false;
    const owner = f.context.native.owner;
    f.setFault(async (command, result) => {
      if (command === "publish-index") published = true;
      return result;
    });
    f.context.native.owner = async () => {
      if (published) throw Error("fixture final owner failure");
      return owner();
    };
    const result = await f.actions.execute(preview.token);
    expect(result).toMatchObject({
      status: "uncertain",
      indexPublished: true,
      recoveryPath: expect.any(String),
    });
    expect((await f.git(["show", ":selected"])).stdout).toBe("approved\n");
  }),
);
it.each(["root", ".git"])(
  "isolated coordinator rejects physical %s replacement",
  fixtureScope.run(async (kind) => {
    const f = await prototypeFixture();
    await f.write("selected", "approved\n");
    const preview = await f.prepare();
    const target = kind === "root" ? f.root : path.join(f.root, ".git"),
      saved = path.join(f.dir, "physical-original");
    await fs.rename(target, saved);
    await fs.cp(saved, target, { recursive: true });
    await expect(f.actions.execute(preview.token)).rejects.toThrow();
    expect(f.commands).toEqual([]);
    expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
      "approved\n",
    );
  }),
);

// SPEC review regressions: real native publication and actual filesystem seams.
function trackPrototypePhase() {
  let phase = "";
  const original = CommitProofReader.prototype.prove;
  const spy = vi
    .spyOn(CommitProofReader.prototype, "prove")
    .mockImplementation(async function (
      this: CommitProofReader,
      expected,
      readback,
    ) {
      phase = expected.phase;
      return original.call(this, expected, readback);
    });
  fixtureScope().cleanup(() => spy.mockRestore());
  return () => phase;
}
async function expectOriginalRecovery(
  f: Awaited<ReturnType<typeof fixture>>,
  result: Awaited<ReturnType<GitCommitCoordinator["execute"]>>,
  head: string,
  indexData: string,
) {
  expect(result.status).toBe("uncertain");
  expect(result.recoveryPath).toEqual(expect.any(String));
  const record = JSON.parse(await fs.readFile(result.recoveryPath!, "utf8"));
  expect(record.recovery.head).toBe(head);
  expect(record.recovery.indexData).toBe(
    Buffer.from(indexData).toString("base64"),
  );
  expect(
    record.recovery.files.find(
      (file: { path: string }) => file.path === "selected",
    ).data,
  ).toBe(Buffer.from("approved\n").toString("base64"));
  await expect(
    new NativeGitJournal({ directory: f.directory }).assertAdmission(
      f.root,
      await f.context.native.owner(),
    ),
  ).rejects.toThrow();
  expect(f.commands.filter((args) => args.includes("commit"))).toHaveLength(1);
}
it.each(["publish-prepared", "index-prepared", "result"])(
  "SPEC-01 rejects owner drift after the first body in %s",
  fixtureScope.run(async (phase) => {
    const f = await prototypeFixture();
    await f.write("selected", "approved\n");
    const preview = await f.prepare(),
      head = await f.head(),
      index = await f.index(),
      indexData = (await f.git(["ls-files", "--stage", "-z"])).stdout;
    const current = trackPrototypePhase();
    let injected = false;
    f.setAfterNativeRead(async (args) => {
      if (current() === phase && !injected && args.includes("--batch")) {
        injected = true;
        f.setOwner("changed-after-first-body");
      }
    });
    const result = await f.actions.execute(preview.token);
    expect(injected).toBe(true);
    expect(result.indexPublished).toBe(phase === "result");
    if (phase === "publish-prepared") expect(await f.head()).toBe(head);
    if (phase !== "result") expect(await f.index()).toEqual(index);
    await expectOriginalRecovery(f, result, head, indexData);
    await expect(f.actions.execute(preview.token)).rejects.toThrow();
  }),
);
it.each(
  ["publish-prepared", "result"].flatMap((phase) =>
    ["cleanup", "owner-await"].flatMap((seam) =>
      ["new-untracked", "other"].map((name) => ({ phase, seam, name })),
    ),
  ),
)(
  "SPEC-02 closes unexpected $name after $seam in $phase",
  fixtureScope.run(async ({ phase, seam, name }) => {
    const f = await prototypeFixture();
    await f.write("selected", "approved\n");
    const preview = await f.prepare(),
      head = await f.head(),
      index = await f.index(),
      indexData = (await f.git(["ls-files", "--stage", "-z"])).stdout;
    const current = trackPrototypePhase();
    let injected = false;
    const mutate = async () => {
      if (!injected && current() === phase) {
        injected = true;
        await f.write(name, "external\n");
      }
    };
    if (seam === "cleanup") {
      const original = fs.rm;
      const spy = vi
        .spyOn(mutableFs, "rm")
        .mockImplementation(async (filename, options) => {
          await original(filename, options);
          if (String(filename).includes("goga-git-read-")) await mutate();
        });
      syncBuiltinESMExports();
      fixtureScope().cleanup(() => {
        spy.mockRestore();
        syncBuiltinESMExports();
      });
    } else {
      const original = f.context.native.owner;
      f.context.native.owner = async () => {
        const owner = await original();
        await mutate();
        return owner;
      };
    }
    const result = await f.actions.execute(preview.token);
    expect(injected).toBe(true);
    expect(result.indexPublished).toBe(phase === "result");
    if (phase === "publish-prepared") {
      expect(await f.head()).toBe(head);
      expect(await f.index()).toEqual(index);
    }
    await expectOriginalRecovery(f, result, head, indexData);
    expect(await fs.readFile(path.join(f.root, name), "utf8")).toBe(
      "external\n",
    );
    await expect(f.actions.execute(preview.token)).rejects.toThrow();
  }),
);
it(
  "SPEC-03 reads the full original HEAD tree only in execute F0, never prepare",
  fixtureScope.run(async () => {
    const f = await prototypeFixture();
    await f.write("selected", "approved\n");
    const head = await f.head();
    f.nativeReads.length = 0;
    f.sourceReads.length = 0;
    const preview = await f.prepare();
    const fullTree = (args: readonly string[]) =>
      args.includes("ls-tree") &&
      args.includes("-r") &&
      args.includes("--full-tree") &&
      args.includes(head);
    expect([...f.nativeReads, ...f.sourceReads].filter(fullTree)).toEqual([]);
    f.nativeReads.length = 0;
    f.sourceReads.length = 0;
    const current = trackPrototypePhase(),
      phases: string[] = [];
    f.setAfterNativeRead(async (args) => {
      if (fullTree(args)) phases.push(current());
    });
    expect((await f.actions.execute(preview.token)).status).toBe("committed");
    expect(phases).toEqual(["admit"]);
    expect([...f.nativeReads, ...f.sourceReads].filter(fullTree)).toHaveLength(
      1,
    );
  }),
);
it.each([
  "config-before",
  "config-after",
  "config-foreign",
  "journal-retained",
  "journal-removed",
  "fence-retained",
  "fence-removed",
])(
  "SPEC-04 keeps original recovery and publication facts after %s cleanup",
  fixtureScope.run(async (kind) => {
    const f = await prototypeFixture();
    await f.write("selected", "approved\n");
    const preview = await f.prepare(),
      head = await f.head(),
      indexData = (await f.git(["ls-files", "--stage", "-z"])).stdout;
    let injected = false,
      phase = "",
      outerReturned = false;
    f.setAfterContext(() => {
      outerReturned = true;
    });
    const current = trackPrototypePhase();
    if (kind === "config-before" || kind === "config-after") {
      const spy = vi
        .spyOn(
          GitMergeSafety.prototype as unknown as {
            releaseLockFault(name: string, phase: string): void;
          },
          "releaseLockFault",
        )
        .mockImplementation((name, when) => {
          if (
            name === "config.lock" &&
            kind === `config-${when}` &&
            !injected
          ) {
            injected = true;
            phase = current();
            throw Error("fixture config cleanup failed");
          }
        });
      fixtureScope().cleanup(() => spy.mockRestore());
    } else if (kind === "config-foreign") {
      f.setFault(async (command, result) => {
        if (command === "publish-index" && !injected) {
          injected = true;
          phase = current();
          await fs.rename(
            path.join(f.root, ".git/config.lock"),
            path.join(f.dir, "our-config-lock"),
          );
          await fs.writeFile(
            path.join(f.root, ".git/config.lock"),
            "foreign-lock\n",
          );
        }
        return result;
      });
    } else {
      const original = fs.unlink;
      const spy = vi
        .spyOn(mutableFs, "unlink")
        .mockImplementation(async (filename) => {
          const target = String(filename),
            suffix = kind.startsWith("journal-")
              ? ".json.lock"
              : ".json.pending";
          if (
            !injected &&
            target.startsWith(f.directory + path.sep) &&
            target.endsWith(suffix)
          ) {
            injected = true;
            phase = current();
            expect(outerReturned).toBe(kind.startsWith("fence-"));
            if (kind.endsWith("removed")) await original(filename);
            throw Object.assign(Error("fixture durable cleanup failed"), {
              code: "EIO",
            });
          }
          return original(filename);
        });
      syncBuiltinESMExports();
      fixtureScope().cleanup(() => {
        spy.mockRestore();
        syncBuiltinESMExports();
      });
    }
    const result = await f.actions.execute(preview.token);
    expect(injected).toBe(true);
    expect(phase).toBe(
      kind.startsWith("config-") ? "index-prepared" : "result",
    );
    expect(result.indexPublished).toBe(true);
    await expectOriginalRecovery(f, result, head, indexData);
    const record = JSON.parse(await fs.readFile(result.recoveryPath!, "utf8"));
    expect(record.result).toMatchObject({
      exitCode: 0,
      signal: null,
      processSettled: true,
    });
    expect((await f.git(["show", "HEAD:selected"])).stdout).toBe("approved\n");
    expect((await f.git(["show", ":selected"])).stdout).toBe("approved\n");
    expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
      "approved\n",
    );
    if (kind.startsWith("config-")) {
      const lock = await fs
        .readFile(path.join(f.root, ".git/config.lock"), "utf8")
        .catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      expect(lock).toBe(
        kind === "config-before"
          ? ""
          : kind === "config-after"
            ? null
            : "foreign-lock\n",
      );
    } else {
      const suffix = kind.startsWith("journal-") ? ".lock" : ".pending";
      expect(
        await fs.stat(result.recoveryPath! + suffix).then(
          () => true,
          () => false,
        ),
      ).toBe(kind.endsWith("retained"));
    }
    await expect(f.actions.execute(preview.token)).rejects.toThrow();
    const next = new GitCommitCoordinator({
      context: async (_scope, fn) =>
        fn({
          ...f.context,
          native: {
            ...f.context.native,
            journal: new NativeGitJournal({ directory: f.directory }),
          },
        }),
    });
    await f.write("selected", "second attempt\n");
    // Fresh previews are harmless, but restart must not admit another write.
    const prepareNext = next.prepare({
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      paths: ["selected"],
      message: "no replay",
    });
    if (kind === "config-before" || kind === "config-foreign")
      await expect(prepareNext).rejects.toThrow();
    else {
      const p = await prepareNext;
      await expect(next.execute(p.token)).rejects.toThrow();
    }
    expect(f.commands.filter((args) => args.includes("commit"))).toHaveLength(
      1,
    );
  }),
  gitIntegrationBudget(15000),
);
