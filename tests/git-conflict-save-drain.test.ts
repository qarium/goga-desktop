import { expect, it, vi } from "vitest";
import {
  GitConflictActions,
  type GitConflictActionContext,
} from "../src/host/git-conflict-actions";
import {
  identity,
  stateFingerprint,
  type State,
} from "../src/host/git-conflict-state";

it.each(["symlink", "binary", "read-error"])(
  "drains sibling source reads before rejecting %s preparation",
  async (kind) => {
    const bytes = [
        "base\n",
        kind === "binary" ? "\0" : "current\n",
        "incoming\n",
      ],
      oids = bytes.map((b) => identity(Buffer.from(b), 40));
    const state: State = {
      root: "/private/tmp/no-io-drain-fixture",
      owner: "owner",
      scope: JSON.stringify("project"),
      revision: "a".repeat(64),
      head: "b".repeat(40),
      branch: "main",
      operation: "merge",
      disk: {
        parents: [],
        work: null,
        index: { bytes: Buffer.alloc(0), identity: "index", mode: 0o644 },
        metadata: "[]",
      },
      policy: {
        raw: "",
        attrs: "",
        values: {
          filter: "unset",
          ident: "unset",
          "working-tree-encoding": "unset",
          text: "unspecified",
          eol: "unspecified",
          crlf: "unspecified",
        },
        autocrlf: "false",
        eol: "lf",
        safecrlf: "false",
        filemode: "true",
      },
      stages: oids
        .map(
          (oid, i) =>
            `${kind === "symlink" && i === 1 ? "120000" : "100644"} ${oid} ${i + 1}\tfile\0`,
        )
        .join(""),
    };
    let release!: () => void,
      exited = false,
      completed = false,
      started = 0;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      original = Error("original read failure"),
      late = Error("later sibling failure");
    const git: GitConflictActionContext["git"] = async (args) => {
      const i = oids.indexOf(args.at(-1)!);
      if (i < 0 || !args.includes("cat-file"))
        throw Error("unexpected command");
      if (i !== 1) {
        started++;
        await gate;
        if (i === 0) throw late;
      }
      if (i === 1 && kind === "read-error") throw original;
      return {
        stdout: args.includes("-s")
          ? `${Buffer.byteLength(bytes[i])}\n`
          : bytes[i],
        stderr: "",
      };
    };
    const context = {
      root: state.root,
      scope: "project",
      ownerKey: "owner",
      verify: async () => {},
      git,
      isolatedGit: async () => {
        throw Error("unexpected isolated command");
      },
      snapshot: async () => {
        throw Error("unexpected snapshot");
      },
    } as GitConflictActionContext;
    const actions = new GitConflictActions({
      context: async (_scope, action) => {
        try {
          return await action(context);
        } finally {
          exited = true;
        }
      },
    });
    vi.spyOn(actions as any, "capture").mockResolvedValue(state);
    const pending = actions
      .prepare({
        scope: "project",
        path: "file",
        revision: state.revision,
        fingerprint: stateFingerprint(state),
        resolution: { kind: "delete" },
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        completed = true;
      });
    try {
      await new Promise<void>((r) => setImmediate(r));
      expect(started).toBe(2);
      expect(
        completed,
        "prepare must not reject while its own reads still run",
      ).toBe(false);
      expect(
        exited,
        "owner context must not release before sibling reads settle",
      ).toBe(false);
    } finally {
      release();
      await pending;
    }
    const result = await pending;
    expect("error" in result).toBe(true);
    if ("error" in result) {
      if (kind === "read-error") expect(result.error).toBe(original);
      else
        expect(String(result.error)).toMatch(
          kind === "symlink" ? /symlink/ : /binary/,
        );
    }
    expect(exited).toBe(true);
  },
);
