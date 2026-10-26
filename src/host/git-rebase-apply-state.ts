import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { directory, regular, stat, type File } from "./git-conflict-state";
import {
  run,
  readTree,
  type GitRebaseOperationContext,
  type Tree,
} from "./git-rebase-operations-state";
import { sourceCommit, sameLayout } from "./git-rebase-continue-state";

export const refuseApply = () =>
  Error(
    "Неподдерживаемое или изменённое состояние rebase --apply. Требуется подтверждённая линейная последовательность текстовых патчей; git am, нестандартные параметры и посторонние правки не поддерживаются.",
  );
const LIMIT = 1024 * 1024;
const flags: Record<string, string> = {
  rebasing: "",
  threeway: "t\n",
  utf8: "t\n",
  keep: "f\n",
  quiet: "f\n",
  sign: "f\n",
  messageid: "f\n",
  "apply-opt": "",
  "quoted-cr": "",
  scissors: "",
};
const required = [
  "head-name",
  "orig-head",
  "onto",
  "original-commit",
  "abort-safety",
  "next",
  "last",
  "author-script",
  "patch",
  "patch-merge-index",
  "final-commit",
  ...Object.keys(flags),
];
/** Strict data capture. Never source author-script or interpret a patch as a
 * command. git-am and mixed operation directories do not enter this adapter. */
export function readApplyOperation(root: string, gd = path.join(root, ".git")) {
  const base = path.join(gd, "rebase-apply");
  if (!stat(base) || stat(path.join(gd, "rebase-merge"))) throw refuseApply();
  const directoryIdentity = directory(base),
    files: Record<string, File> = Object.create(null);
  let bytes = 0;
  const names = readdirSync(base).sort();
  if (names.length > 160) throw refuseApply();
  for (const n of names) {
    if (!required.includes(n) && n !== "rewritten" && !/^[0-9]{4}$/.test(n))
      throw refuseApply();
    const f = regular(path.join(base, n), LIMIT)!;
    bytes += f.bytes.length;
    if (bytes > 4 * LIMIT) throw refuseApply();
    files[`rebase-apply/${n}`] = f;
  }
  if (required.some((n) => !files[`rebase-apply/${n}`])) throw refuseApply();
  const text = (n: string) => {
    // The common capture reads this semantic field, not a fabricated file.
    if (n === "stopped-sha") n = "original-commit";
    const b = files[`rebase-apply/${n}`]?.bytes;
    if (!b || !Buffer.from(b.toString("utf8")).equals(b) || b.includes(0))
      throw refuseApply();
    return b.toString("utf8");
  };
  for (const [n, expected] of Object.entries(flags))
    if (text(n) !== expected) throw refuseApply();
  const number = (n: string) => {
    const value = text(n);
    if (!/^[1-9][0-9]{0,2}\n$/.test(value) || Number(value) > 128)
      throw refuseApply();
    return Number(value);
  };
  const current = number("next"),
    total = number("last");
  if (current > total) throw refuseApply();
  const patches = names.filter((n) => /^[0-9]{4}$/.test(n));
  if (patches.length !== total) throw refuseApply();
  const commands = Array.from({ length: total }, (_, i) => {
    const value = text(String(i + 1).padStart(4, "0"));
    const oid = /^From ([a-f0-9]{40}) Mon Sep 17 00:00:00 2001\n/.exec(
      value,
    )?.[1];
    if (!oid) throw refuseApply();
    return oid;
  });
  if (
    text("original-commit") !== `${commands[current - 1]}\n` ||
    text("orig-head") !== `${commands.at(-1)}\n`
  )
    throw refuseApply();
  const branch = /^refs\/heads\/([^\0\r\n]+)\n$/.exec(text("head-name"))?.[1];
  if (!branch) throw refuseApply();
  // AUTO_MERGE and MERGE_MSG are merge-backend assumptions, not apply data.
  for (const n of [
    "AUTO_MERGE",
    "MERGE_MSG",
    "MERGE_HEAD",
    "MERGE_MODE",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "sequencer",
    "BISECT_START",
  ])
    if (stat(path.join(gd, n))) throw refuseApply();
  for (const n of ["REBASE_HEAD", "ORIG_HEAD"]) {
    const f = regular(path.join(gd, n));
    if (!f) throw refuseApply();
    files[n] = f;
  }
  if (
    files.REBASE_HEAD.bytes.toString() !== text("original-commit") ||
    files.ORIG_HEAD.bytes.toString() !== text("orig-head") ||
    regular(path.join(gd, "HEAD"))?.bytes.toString() !== text("abort-safety")
  )
    throw refuseApply();
  return {
    backend: "apply" as const,
    files,
    directoryIdentity,
    text,
    branch,
    commands,
    current,
    total,
  };
}

/** The native fake-ancestor index has been patched to the incoming versions.
 * Compare its complete v2 representation, including its optional cache-tree,
 * instead of handing arbitrary index extensions to Git. No index is written. */
function expectedPatchIndex(tree: Tree, cache: boolean): Buffer {
  const names = Object.keys(tree).sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  const header = Buffer.alloc(12);
  header.write("DIRC");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(names.length, 8);
  const entries = names.map((n) => {
    const name = Buffer.from(n);
    if (name.length >= 4095) throw refuseApply();
    const entry = Buffer.alloc(Math.ceil((62 + name.length + 1) / 8) * 8);
    entry.writeUInt32BE(parseInt(tree[n].mode, 8), 24);
    Buffer.from(tree[n].oid, "hex").copy(entry, 40);
    entry.writeUInt16BE(name.length, 60);
    name.copy(entry, 62);
    return entry;
  });
  const objectHash = (body: Buffer) =>
    createHash("sha1").update(`tree ${body.length}\0`).update(body).digest();
  const subtree = (prefix: string): { hash: Buffer; cache: Buffer } => {
    const children = new Map<
      string,
      { directory: boolean; oid?: string; mode?: string }
    >();
    const members = names.filter((n) => n.startsWith(prefix));
    for (const n of members) {
      const suffix = n.slice(prefix.length),
        slash = suffix.indexOf("/");
      if (slash < 0) children.set(suffix, { directory: false, ...tree[n] });
      else children.set(suffix.slice(0, slash), { directory: true });
    }
    const dirs = new Map<string, ReturnType<typeof subtree>>();
    const body = Buffer.concat(
      [...children]
        .sort(([a, av], [b, bv]) =>
          Buffer.compare(
            Buffer.from(a + (av.directory ? "/" : "")),
            Buffer.from(b + (bv.directory ? "/" : "")),
          ),
        )
        .map(([n, v]) => {
          if (v.directory) dirs.set(n, subtree(prefix + n + "/"));
          return Buffer.concat([
            Buffer.from(`${v.directory ? "40000" : v.mode} ${n}\0`),
            v.directory ? dirs.get(n)!.hash : Buffer.from(v.oid!, "hex"),
          ]);
        }),
    );
    const hash = objectHash(body),
      name = prefix ? prefix.slice(0, -1).split("/").at(-1)! : "";
    return {
      hash,
      cache: Buffer.concat([
        Buffer.from(`${name}\0${members.length} ${dirs.size}\n`),
        hash,
        ...[...dirs]
          .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
          .map(([, v]) => v.cache),
      ]),
    };
  };
  const cached = subtree("").cache,
    ext = Buffer.alloc(8);
  ext.write("TREE");
  ext.writeUInt32BE(cached.length, 4);
  const body = Buffer.concat([
    header,
    ...entries,
    ...(cache ? [ext, cached] : []),
  ]);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}
export async function validateApplyMetadata(
  c: GitRebaseOperationContext,
  op: ReturnType<typeof readApplyOperation>,
) {
  const commits = [];
  for (let i = 0; i < op.commands.length; i++) {
    const source = await sourceCommit(c, op.commands[i]);
    if (i && source.parent !== commits[i - 1].oid) throw refuseApply();
    // Generate canonical mailbox data read-only under explicit diff/format policy.
    // Rebase's mailbox splitter preserves one extra LF between messages.
    const mailbox = await run(c, [
      "-c",
      "diff.algorithm=myers",
      "format-patch",
      "-k",
      "--stdout",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "-1",
      source.oid,
    ]);
    const actual = op.text(String(i + 1).padStart(4, "0"));
    if (actual !== mailbox + (i < op.total - 1 ? "\n" : ""))
      throw refuseApply();
    commits.push(source);
  }
  const source = commits[op.current - 1];
  const base = await readTree(c, source.parent);
  sameLayout(base, source.tree);
  const patch = await run(c, [
    "-c",
    "diff.algorithm=myers",
    "diff-tree",
    "--no-commit-id",
    "-p",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    source.parent,
    source.oid,
  ]);
  if (
    !patch ||
    patch !== op.text("patch") ||
    source.message !== op.text("final-commit")
  )
    throw refuseApply();
  const m = /^author (.+) <([^<>\r\n]+)> [0-9]+ [+-][0-9]{4}$/.exec(
    source.author,
  )!;
  const date = (
    await run(c, ["show", "-s", "--format=%ad", "--date=default", source.oid])
  ).replace(/\n$/, "");
  const quote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  if (
    op.text("author-script") !==
    `GIT_AUTHOR_NAME=${quote(m[1])}\nGIT_AUTHOR_EMAIL=${quote(m[2])}\nGIT_AUTHOR_DATE=${quote(date)}\n`
  )
    throw refuseApply();
  const incoming: Tree = Object.create(null);
  for (const [n, e] of Object.entries(source.tree))
    if (base[n].oid !== e.oid) incoming[n] = e;
  const index = op.files["rebase-apply/patch-merge-index"].bytes;
  if (
    !index.equals(expectedPatchIndex(incoming, true)) &&
    !index.equals(expectedPatchIndex(incoming, false))
  )
    throw refuseApply();
  const rewritten =
    op.files["rebase-apply/rewritten"]?.bytes.toString("utf8") ?? "";
  const rows = rewritten.split("\n").filter(Boolean);
  if (
    rows.length !== op.current - 1 ||
    rewritten !== rows.map((l) => l + "\n").join("")
  )
    throw refuseApply();
  for (let i = 0; i < rows.length; i++) {
    const match = /^([a-f0-9]{40}) ([a-f0-9]{40})$/.exec(rows[i]);
    if (!match || match[1] !== commits[i].oid) throw refuseApply();
    const actual = await sourceCommit(c, match[2]);
    if (
      actual.author !== commits[i].author ||
      actual.message !== commits[i].message ||
      actual.parent !== (i ? rows[i - 1].split(" ")[1] : op.text("onto").trim())
    )
      throw refuseApply();
  }
  const head = op.text("abort-safety").trim();
  if (
    head !== (rows.length ? rows.at(-1)!.split(" ")[1] : op.text("onto").trim())
  )
    throw refuseApply();
  return { source, base };
}
