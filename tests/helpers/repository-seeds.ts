import * as fs from "node:fs/promises";
import path from "node:path";
interface Seed<T> {
  value: T;
  entries: { name: string; mode: number; data: Buffer | null }[];
}
/** Process-local immutable synthetic setup only, captured BEFORE any operation.
 * No shared indexes, refs, hard links, control files or cached verification results.
 * The caller owns each destination and must remove it even if preparation fails. */
export class RepositorySeeds<T> {
  private seeds = new Map<string, Promise<Seed<T>>>();
  async materialize(
    key: string,
    root: string,
    prepare: () => Promise<T>,
  ): Promise<T> {
    if ((await fs.readdir(root)).length)
      throw Error("Seed destination must be empty");
    let seed = this.seeds.get(key);
    if (!seed) {
      seed = (async () => {
        const value = await prepare();
        const entries: Seed<T>["entries"] = [];
        let bytes = 0;
        const visit = async (dir: string) => {
          for (const name of (await fs.readdir(path.join(root, dir))).sort()) {
            const relative = path.join(dir, name),
              full = path.join(root, relative),
              stat = await fs.lstat(full);
            if (!stat.isDirectory() && !stat.isFile())
              throw Error(
                "Seed accepts only regular files and directories, not symlinks",
              );
            const data = stat.isFile() ? await fs.readFile(full) : null;
            bytes += data?.length ?? 0;
            if (bytes > 32 * 1024 * 1024)
              throw Error("Synthetic repository seed exceeds memory budget");
            entries.push({ name: relative, mode: stat.mode & 0o777, data });
            if (stat.isDirectory()) await visit(relative);
          }
        };
        await visit("");
        return { value: structuredClone(value), entries };
      })();
      this.seeds.set(key, seed);
      try {
        return structuredClone((await seed).value);
      } catch (error) {
        this.seeds.delete(key);
        throw error;
      }
    }
    const ready = await seed;
    for (const entry of ready.entries) {
      const target = path.join(root, entry.name);
      if (entry.data === null) await fs.mkdir(target, { mode: entry.mode });
      else
        await fs.writeFile(target, entry.data, {
          flag: "wx",
          mode: entry.mode,
        });
    }
    return structuredClone(ready.value);
  }
}
