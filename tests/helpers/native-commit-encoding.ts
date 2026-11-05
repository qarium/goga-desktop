import { expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { gitIntegrationBudget } from "./git-integration";
import { installNativeCommitFixture } from "./native-commit-fixture";

// Each caller installs its own per-file fixture scope; no shared repositories.
export function registerNativeCommitEncodingParity(prototypes: boolean[]) {
  const { fixtureScope, fixture } = installNativeCommitFixture();
  it.each(prototypes)(
    "QUALITY02 independent 27MiB expanding encoding states commit native parity coordinator=%s",
    fixtureScope.run(async (prototype) => {
      // Existing durable 27MiB snapshots measured ~239s for legacy in RED,
      // then ~234s legacy / ~111s coordinator in GREEN. Only these new cases
      // get a finite 300s base (900s in slow-git); product deadlines are unchanged.
      const f = await fixture(false, "sha1", undefined, undefined, prototype);
      const names = ["latin-a", "latin-b", "latin-c"];
      const rawSize = 3 * 1024 * 1024;
      await f.write(
        ".gitattributes",
        "latin-* text working-tree-encoding=ISO-8859-1\n",
      );
      for (const [i, name] of names.entries())
        await f.write(name, Buffer.alloc(rawSize, 0xc0 + i));
      await f.git(["add", "."]);
      await f.git([
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        "encoding base",
      ]);
      const parent = await f.head();
      const oldIds: string[] = [];
      for (const name of names) {
        oldIds.push((await f.git(["rev-parse", `HEAD:${name}`])).stdout.trim());
        expect(
          (await f.git(["cat-file", "-s", `HEAD:${name}`])).stdout.trim(),
        ).toBe(String(2 * rawSize));
      }
      for (const [i, name] of names.entries())
        await f.write(name, Buffer.alloc(rawSize, 0xd0 + i));
      const preview = await f.prepare(names);
      const result = await f.actions.execute(preview.token);
      expect(result.status, result.log).toBe("committed");
      expect(result.recoveryPath).toBeUndefined();
      expect((await f.git(["rev-parse", "HEAD^"])).stdout.trim()).toBe(parent);
      const newIds: string[] = [];
      for (const [i, name] of names.entries()) {
        const oid = (await f.git(["rev-parse", `HEAD:${name}`])).stdout.trim();
        newIds.push(oid);
        expect((await f.git(["rev-parse", `:${name}`])).stdout.trim()).toBe(
          oid,
        );
        expect(
          (await f.git(["cat-file", "-s", `HEAD:${name}`])).stdout.trim(),
        ).toBe(String(2 * rawSize));
        expect(
          (await fs.readFile(path.join(f.root, name))).equals(
            Buffer.alloc(rawSize, 0xd0 + i),
          ),
        ).toBe(true);
      }
      expect(new Set([...oldIds, ...newIds]).size).toBe(6);
      expect((await f.git(["show", "HEAD:other"])).stdout).toBe("base\n");
      expect(await fs.readFile(path.join(f.root, "other"), "utf8")).toBe(
        "base\n",
      );
      expect(f.commands.filter((args) => args.includes("commit"))).toHaveLength(
        1,
      );
    }),
    gitIntegrationBudget(300000),
  );
}
