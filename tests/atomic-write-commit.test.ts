import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../src/host/settings";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp("/private/tmp/goga-write-commit-");
  roots.push(root);
  return { root, file: path.join(root, "task.md") };
}
it("retains unconditional replacement behavior for existing callers without commit options", async () => {
  const { root, file } = await fixture();
  await atomicWrite(file, "first\r\n");
  await atomicWrite(file, "second\r\n");
  expect(await readFile(file, "utf8")).toBe("second\r\n");
  expect(await readdir(root)).toEqual(["task.md"]);
});
it("invokes the commit guard after staging and never replaces a conflicting existing file", async () => {
  const { root, file } = await fixture();
  await writeFile(file, "original");
  const guard = vi.fn(async () => {
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(
      true,
    );
    await writeFile(file, "external");
    throw Error("same-file conflict");
  });
  await expect(
    atomicWrite(file, "draft", { beforeCommit: guard }),
  ).rejects.toThrow("same-file conflict");
  expect(guard).toHaveBeenCalledOnce();
  expect(await readFile(file, "utf8")).toBe("external");
  expect(await readdir(root)).toEqual(["task.md"]);
});
it("exclusive creation never overwrites a file that appears at the commit boundary", async () => {
  const { root, file } = await fixture();
  await expect(
    atomicWrite(file, "draft", {
      createOnly: true,
      beforeCommit: () => writeFile(file, "external"),
    }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(file, "utf8")).toBe("external");
  expect(await readdir(root)).toEqual(["task.md"]);
});
it("exclusive creation publishes the staged bytes when the destination remains absent", async () => {
  const { root, file } = await fixture();
  await atomicWrite(file, "new task", { createOnly: true });
  expect(await readFile(file, "utf8")).toBe("new task");
  expect(await readdir(root)).toEqual(["task.md"]);
});
