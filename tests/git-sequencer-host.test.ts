import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
async function fixture(
  kind: "primary" | "managed",
  operation: "cherry-pick" | "revert",
) {
  const base = await fs.mkdtemp("/private/tmp/goga-sequencer-host-"),
    home = path.join(base, "home"),
    source = path.join(base, "source");
  await fs.mkdir(home);
  await fs.mkdir(source);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_NO_LAZY_FETCH: "1",
    GIT_EDITOR: ":",
  };
  const runner = new NodeRunner(10000, env),
    git = (cwd: string, a: string[]) =>
      runner.command(
        "git",
        ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...a],
        cwd,
        env,
      );
  const host = new HostService({
    home,
    dataDir: path.join(base, "data"),
    runner,
    goga: "/nonexistent/disabled",
  });
  const dispose = async () => {
    await host.dispose();
    await runner.dispose();
    await fs.rm(base, { recursive: true, force: true });
  };
  try {
    await git(source, ["init", "-b", "main"]);
    for (const n of ["first", "second"])
      await fs.writeFile(path.join(source, n), "base\n");
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "base"]);
    await git(source, ["branch", "feature"]);
    const project = await host.addProject(source),
      manager = new CloneManager(home, runner),
      record =
        kind === "managed"
          ? await manager.ensure(project, {
              projectId: project.id,
              year: "2026",
              topic: "feature",
              branch: "feature",
            })
          : null;
    const root = record?.path ?? source,
      branch = record?.branch ?? "main",
      scope = record ? worktreeContextRef(record) : project.id;
    await git(root, ["checkout", "-b", "source-fixture"]);
    const sources: string[] = [];
    for (const n of ["first", "second"]) {
      await fs.writeFile(path.join(root, n), "incoming " + n + "\n");
      await git(root, ["commit", "-am", n]);
      sources.push((await git(root, ["rev-parse", "HEAD"])).stdout.trim());
    }
    await git(root, ["checkout", branch]);
    if (operation === "revert")
      await git(root, ["merge", "--ff-only", "source-fixture"]);
    for (const n of ["first", "second"])
      await fs.writeFile(path.join(root, n), "local\n");
    await git(root, ["commit", "-am", "local"]);
    const original = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    await expect(
      git(root, [
        operation,
        ...(operation === "revert" ? [...sources].reverse() : sources),
      ]),
    ).rejects.toThrow();
    const first = operation === "revert" ? "second" : "first",
      second = operation === "revert" ? "first" : "second";
    await fs.writeFile(path.join(root, first), "resolved first\n");
    await git(root, ["add", first]);
    const registryPath = path.join(manager.store.root, "registry.json"),
      registry = record ? await fs.readFile(registryPath) : null,
      sourceHead = (await git(source, ["rev-parse", "HEAD"])).stdout;
    return {
      host,
      scope,
      root,
      source,
      sourceHead,
      record,
      registryPath,
      registry,
      git,
      original,
      second,
      dispose,
    };
  } catch (e) {
    await dispose();
    throw e;
  }
}
for (const operation of ["cherry-pick", "revert"] as const)
  describe.each(["primary", "managed"] as const)(
    `${operation} %s owner lifecycle`,
    (kind) => {
      let f: Awaited<ReturnType<typeof fixture>>;
      beforeAll(async () => {
        f = await fixture(kind, operation);
      });
      afterAll(async () => {
        await f?.dispose();
      });
      it("continues into next conflict under the original owner", async () => {
        expect((f.host as any).prepareGitSequencerOperation).toBeTypeOf(
          "function",
        );
        const snapshot = await f.host.readGitWorkspace(f.scope);
        const p = await f.host.prepareGitSequencerOperation({
          scope: f.scope,
          revision: snapshot.revision,
          operation,
          action: "continue",
        });
        const r = await f.host.executeGitSequencerOperation(p.token);
        expect(r.status, r.log).toBe("conflict");
        expect(r.lockRetained).toBe(false);
        expect((await f.host.readGitWorkspace(f.scope)).operation).toBe(
          operation,
        );
      });
      it("saves the next conflict using the existing three-pane resolver", async () => {
        const snapshot = await f.host.readGitWorkspace(f.scope),
          request = {
            scope: f.scope,
            revision: snapshot.revision,
            path: f.second,
          };
        const doc = await f.host.readGitConflict(request);
        const p = await f.host.prepareGitConflictSave({
          ...request,
          fingerprint: doc.fingerprint,
          resolution: { kind: "text", text: "resolved second\n" },
        });
        const r = await f.host.executeGitConflictSave(p.token);
        expect(r.status).toBe("saved");
      });
      it("finishes without changing source project or clone identity", async () => {
        const snapshot = await f.host.readGitWorkspace(f.scope),
          p = await f.host.prepareGitSequencerOperation({
            scope: f.scope,
            revision: snapshot.revision,
            operation,
            action: "continue",
          }),
          r = await f.host.executeGitSequencerOperation(p.token);
        expect(r.status, r.log).toBe("success");
        expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("none");
        if (f.record) {
          expect((await f.git(f.source, ["rev-parse", "HEAD"])).stdout).toBe(
            f.sourceHead,
          );
          expect(await fs.readFile(f.registryPath)).toEqual(f.registry);
        }
      });
    },
  );
for (const operation of ["cherry-pick", "revert"] as const)
  it.each(["primary", "managed"] as const)(
    `${operation} %s host abort restores the owned branch`,
    async (kind) => {
      const f = await fixture(kind, operation);
      try {
        const p = await f.host.prepareGitSequencerOperation({
            scope: f.scope,
            revision: (await f.host.readGitWorkspace(f.scope)).revision,
            operation,
            action: "abort",
          }),
          r = await f.host.executeGitSequencerOperation(p.token);
        expect(r.status, r.log).toBe("success");
        expect((await f.git(f.root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
          f.original,
        );
        expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("none");
        if (f.record) {
          expect((await f.git(f.source, ["rev-parse", "HEAD"])).stdout).toBe(
            f.sourceHead,
          );
          expect(await fs.readFile(f.registryPath)).toEqual(f.registry);
        }
      } finally {
        await f.dispose();
      }
    },
  );
