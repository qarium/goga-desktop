import { readdirSync } from "node:fs";
import path from "node:path";
import type { WorktreeRecord } from "../shared/worktrees";
import { directory, hash, regular, stat } from "./git-conflict-state";
import { noSymlinks } from "./settings";

const unavailable = () =>
  Error("Не удалось подтвердить остановленный rebase владельца клона.");
const oidPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?\n$/;
const LIMIT = 1024 * 1024;

/** A read-only identity proof, not permission to continue/abort or write. Neither
 * author-script nor todo/patch data is executed. No lock or metadata is created.
 * Rechecking detects observed races; it cannot exclude arbitrary external writers
 * after the last check (Node does not offer an atomic repository snapshot). */
export async function readRebaseBinding(
  owner: Pick<WorktreeRecord, "path" | "gitCommonDir" | "branch">,
  git: (args: string[]) => Promise<string>,
): Promise<string> {
  const gd = owner.gitCommonDir,
    ref = `refs/heads/${owner.branch}`;
  await noSymlinks(owner.path);
  await noSymlinks(gd);
  await noSymlinks(path.join(gd, ref));
  const auditObjects = () => {
    // Even cat-file/merge-base must not follow an object symlink or alternates.
    for (const name of [
      "commondir",
      "objects/info/alternates",
      "objects/info/http-alternates",
      "info/grafts",
    ])
      if (stat(path.join(gd, name))) throw unavailable();
    let count = 0;
    const visit = (file: string, depth: number) => {
      if (++count > 100000 || depth > 8) throw unavailable();
      const info = stat(file);
      if (!info || info.isSymbolicLink()) throw unavailable();
      if (info.isDirectory()) {
        directory(file);
        for (const child of readdirSync(file))
          visit(path.join(file, child), depth + 1);
      } else if (!info.isFile() || info.nlink !== 1n) throw unavailable();
    };
    directory(path.join(gd, "objects"));
    visit(path.join(gd, "objects"), 0);
  };
  const capture = () => {
    const identities: unknown[] = [directory(owner.path), directory(gd)];
    let parent = gd;
    for (const part of ref.split("/").slice(0, -1)) {
      parent = path.join(parent, part);
      identities.push([parent, stat(parent) ? directory(parent) : null]);
    }
    const files = new Map<string, Buffer>();
    let count = 0,
      bytes = 0;
    const visit = (name: string, depth = 0) => {
      if (++count > 4096 || depth > 8) throw unavailable();
      const filename = path.join(gd, name),
        info = stat(filename);
      if (!info) {
        identities.push([name, null]);
        return;
      }
      if (info.isDirectory()) {
        identities.push([
          name,
          directory(filename),
          String(info.mtimeNs),
          String(info.ctimeNs),
        ]);
        for (const child of readdirSync(filename).sort())
          visit(`${name}/${child}`, depth + 1);
      } else {
        const file = regular(filename, LIMIT)!;
        bytes += file.bytes.length;
        if (bytes > 4 * LIMIT) throw unavailable();
        files.set(name, file.bytes);
        identities.push([name, file.identity]);
      }
    };
    for (const name of [
      "HEAD",
      "ORIG_HEAD",
      "REBASE_HEAD",
      "rebase-merge",
      "rebase-apply",
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "sequencer",
      "BISECT_START",
      "packed-refs",
      ref,
    ])
      visit(name);
    const has = (name: string) => stat(path.join(gd, name)) !== null;
    if (
      [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "sequencer",
        "BISECT_START",
      ].some(has)
    )
      throw unavailable();
    const merge = has("rebase-merge"),
      apply = has("rebase-apply");
    if (merge === apply) throw unavailable();
    const base = merge ? "rebase-merge" : "rebase-apply";
    directory(path.join(gd, base));
    const text = (name: string) => {
      const value = files.get(name);
      if (!value) throw unavailable();
      return value.toString("utf8");
    };
    const oid = (name: string) => {
      const value = text(name);
      if (!oidPattern.test(value)) throw unavailable();
      return value.slice(0, -1);
    };
    if (text(`${base}/head-name`) !== `${ref}\n`) throw unavailable();
    const original = oid(`${base}/orig-head`),
      head = oid("HEAD"),
      onto = oid(`${base}/onto`);
    const stopped = oid(`${base}/${merge ? "stopped-sha" : "original-commit"}`);
    if (oid("ORIG_HEAD") !== original || oid("REBASE_HEAD") !== stopped)
      throw unavailable();
    if (files.has(ref) && oid(ref) !== original) throw unavailable();
    const positive = (name: string) => {
      const value = text(`${base}/${name}`);
      if (!/^[1-9][0-9]{0,6}\n$/.test(value)) throw unavailable();
      return Number(value);
    };
    const current = positive(merge ? "msgnum" : "next"),
      total = positive(merge ? "end" : "last");
    if (current > total) throw unavailable();
    if (merge) {
      // Validate every command, not just the stopped tail. This is a small
      // allowlist for linear rebase data, never an interpreter: exec, merge,
      // labels, resets and other interactive forms are deliberately refused.
      const commands = (name: string) => {
        const value = text(`${base}/${name}`);
        if (/[\0\r]/.test(value) || (value && !value.endsWith("\n")))
          throw unavailable();
        return value
          .split("\n")
          .filter((line) => !/^[ \t]*(?:#|$)/.test(line))
          .map((line) => {
            const command =
              /^(?:pick|p|reword|r|edit|e|squash|s|(?:fixup|f)(?: -[Cc])?) ([a-f0-9]{40}(?:[a-f0-9]{24})?)(?: .*)?$/.exec(
                line,
              );
            if (!command) throw unavailable();
            return command[1]!;
          });
      };
      const done = commands("done"),
        todo = commands("git-rebase-todo");
      if (
        done.length !== current ||
        done.length + todo.length !== total ||
        done.at(-1) !== stopped
      )
        throw unavailable();
    } else {
      if (
        text(`${base}/rebasing`) !== "" ||
        has(`${base}/applying`) ||
        oid(`${base}/abort-safety`) !== head
      )
        throw unavailable();
      // Native apply uses a minimum four-digit decimal patch name. The capture
      // above already guarantees bounded, no-follow, single-link regular files.
      // A missing/empty current patch is not a confirmed paused apply operation.
      const patch = files.get(`${base}/${String(current).padStart(4, "0")}`);
      if (!patch?.length) throw unavailable();
    }
    return {
      key: hash(JSON.stringify(identities)),
      original,
      head,
      onto,
      stopped,
    };
  };
  const before = capture();
  auditObjects();
  const raw = await git([
    "--no-replace-objects",
    "rev-parse",
    "--verify",
    "--end-of-options",
    ref,
  ]);
  if (raw !== `${before.original}\n`) throw unavailable();
  for (const oid of new Set([
    before.original,
    before.head,
    before.onto,
    before.stopped,
  ]))
    if (
      (await git(["--no-replace-objects", "cat-file", "-t", oid])) !==
      "commit\n"
    )
      throw unavailable();
  await git([
    "--no-replace-objects",
    "merge-base",
    "--is-ancestor",
    before.onto,
    before.head,
  ]);
  await git([
    "--no-replace-objects",
    "merge-base",
    "--is-ancestor",
    before.stopped,
    before.original,
  ]);
  auditObjects();
  const after = capture();
  if (after.key !== before.key) throw unavailable();
  return before.key;
}
