import { describe, expect, it } from "vitest";
import { ChangeSet } from "@codemirror/state";
import type {
  GitConflictDocument,
  GitConflictBlock,
} from "../src/shared/git-conflicts";
import {
  openConflictDraft,
  reconstructConflictDraft,
  editConflictDraft,
  applyConflictBlock,
  resolveConflictBlockManually,
} from "../src/renderer/git-conflict-draft";

const block = (
  id: string,
  from: number,
  to: number,
  current = "ours\n",
  incoming = "theirs\n",
): GitConflictBlock => ({
  id,
  resultRange: { from, to },
  base: { text: "base\n", range: null },
  current: { text: current, range: null },
  incoming: { text: incoming, range: null },
});
function document(
  text = "prefix\nbase\nmiddle\nbase\nsuffix\n",
  blocks = [block("one", 7, 12), block("two", 19, 24)],
): GitConflictDocument {
  return {
    scope: "project",
    path: "file",
    revision: "a".repeat(64),
    fingerprint: "b".repeat(64),
    base: { kind: "text", oid: null, mode: null, text },
    current: { kind: "text", oid: null, mode: null, text },
    incoming: { kind: "text", oid: null, mode: null, text },
    working: { kind: "text", text: "existing manual changes\r\n" },
    generated: {
      kind: "text",
      text,
      blocks,
      requiresExplicitReconstruction: true,
    },
  };
}
function edit(
  draft: ReturnType<typeof reconstructConflictDraft>,
  from: number,
  to: number,
  insert: string,
) {
  return editConflictDraft(
    draft,
    ChangeSet.of({ from, to, insert }, draft.text.length, "\n"),
  );
}
describe("conflict drafts bound to exact host-generated blocks", () => {
  it("opens existing working text unchanged, never reconstructs implicitly", () => {
    const d = openConflictDraft(document());
    expect(d.text).toBe("existing manual changes\r\n");
    expect(d.blocks).toEqual([]);
    expect(d.fingerprint).toBe("b".repeat(64));
    expect(() => applyConflictBlock(d, "one", "current")).toThrow();
  });
  it("requires explicit reconstruction and applies repeated blocks independently", () => {
    let d = reconstructConflictDraft(document());
    d = applyConflictBlock(d, "two", "incoming");
    expect(d.text).toBe("prefix\nbase\nmiddle\ntheirs\nsuffix\n");
    expect(d.blocks.map((b) => b.choice)).toEqual([null, "incoming"]);
    d = applyConflictBlock(d, "one", "current");
    expect(d.text).toBe("prefix\nours\nmiddle\ntheirs\nsuffix\n");
    expect(d.blocks[1].from).toBe(d.text.indexOf("theirs"));
  });
  it("retains manual edits outside a target while applying it", () => {
    let d = reconstructConflictDraft(document());
    d = edit(d, 0, 6, "hand edited prefix");
    d = edit(
      d,
      d.text.indexOf("middle"),
      d.text.indexOf("middle") + 6,
      "HAND\r\nMIDDLE",
    );
    d = applyConflictBlock(d, "two", "both");
    d = applyConflictBlock(d, "one", "current");
    expect(d.text).toBe(
      "hand edited prefix\nours\nHAND\r\nMIDDLE\nours\ntheirs\nsuffix\n",
    );
  });
  it("preserves exact CRLF, BOM, Unicode and missing trailing newline", () => {
    let d = reconstructConflictDraft(
      document("\ufeff🙂\r\nBASE", [block("one", 5, 9, "OURS\r\n", "THEIRS")]),
    );
    d = applyConflictBlock(d, "one", "both");
    expect(d.text).toBe("\ufeff🙂\r\nOURS\r\nTHEIRS");
  });
  it("does not discard insertions exactly at either boundary", () => {
    let d = reconstructConflictDraft(document());
    d = edit(d, 7, 7, "BEFORE");
    d = edit(d, d.blocks[0].to, d.blocks[0].to, "AFTER");
    d = applyConflictBlock(d, "one", "current");
    expect(d.text).toBe("prefix\nBEFOREours\nAFTERmiddle\nbase\nsuffix\n");
  });
  it("tracks zero-width conflicts without reversed ranges or lost boundary text", () => {
    let d = reconstructConflictDraft(
      document("ab", [block("one", 1, 1, "X", "Y")]),
    );
    d = edit(d, 1, 1, "manual");
    expect(d.blocks[0].from).toBe(d.blocks[0].to);
    d = applyConflictBlock(d, "one", "both");
    expect(d.text).toBe("amanualXYb");
    d = applyConflictBlock(d, "one", "incoming");
    expect(d.text).toBe("amanualYb");
  });
  it("invalidates a choice on manual edits inside the block; marking manual is explicit", () => {
    let d = applyConflictBlock(
      reconstructConflictDraft(document()),
      "one",
      "current",
    );
    d = edit(d, d.blocks[0].from + 1, d.blocks[0].from + 2, "EDIT");
    expect(d.blocks[0].choice).toBe(null);
    expect(d.blocks[0].mapped).toBe(true);
    expect(resolveConflictBlockManually(d, "one").blocks[0].choice).toBe(
      "manual",
    );
  });
  it("tracks a full block replacement as manual text without silently marking it resolved", () => {
    let d = reconstructConflictDraft(document());
    d = edit(d, 7, 12, "HAND");
    expect(d.text.slice(d.blocks[0].from, d.blocks[0].to)).toBe("HAND");
    expect(d.blocks[0].choice).toBe(null);
    d = applyConflictBlock(d, "one", "incoming");
    expect(d.text).toBe("prefix\ntheirs\nmiddle\nbase\nsuffix\n");
  });
  it("disables block application after a cross-boundary edit rather than guessing", () => {
    const d = edit(reconstructConflictDraft(document()), 6, 20, "HAND");
    expect(d.text).toBe("prefixHANDase\nsuffix\n");
    expect(d.blocks.every((b) => !b.mapped && b.choice === null)).toBe(true);
    expect(() => applyConflictBlock(d, "one", "current")).toThrow();
    expect(() => applyConflictBlock(d, "two", "incoming")).toThrow();
    expect(() => resolveConflictBlockManually(d, "one")).toThrow();
  });
  it("composes simultaneous edits without re-matching duplicated payload", () => {
    let d = reconstructConflictDraft(document());
    d = editConflictDraft(
      d,
      ChangeSet.of(
        [
          { from: 0, to: 0, insert: "A" },
          { from: 12, to: 18, insert: "B" },
          { from: 29, to: 29, insert: "C" },
        ],
        d.text.length,
        "\n",
      ),
    );
    d = applyConflictBlock(d, "two", "current");
    expect(d.text).toBe("Aprefix\nbase\nB\nours\nsuffiCx\n");
  });
  it("rejects unavailable generation/working content, unknown block and wrong change length", () => {
    const doc = document();
    expect(() =>
      openConflictDraft({ ...doc, working: { kind: "binary" } }),
    ).toThrow();
    expect(() =>
      reconstructConflictDraft({
        ...doc,
        generated: { kind: "unavailable", reason: "binary" },
      }),
    ).toThrow();
    const d = reconstructConflictDraft(doc);
    expect(() => applyConflictBlock(d, "missing", "current")).toThrow();
    expect(() => editConflictDraft(d, ChangeSet.empty(1))).toThrow();
  });
  it("rejects malformed, overlapping, duplicate or out of bounds host ranges", () => {
    for (const blocks of [
      [block("one", -1, 2)],
      [block("one", 1, 80)],
      [block("one", 5, 1)],
      [block("one", 1, 4), block("two", 3, 5)],
      [block("one", 1, 2), block("one", 4, 5)],
    ]) {
      expect(() =>
        reconstructConflictDraft(document(undefined, blocks)),
      ).toThrow();
    }
  });
});
it("keeps order of adjacent empty blocks regardless of application order", () => {
  for (const order of [
    ["two", "one"],
    ["one", "two"],
  ]) {
    let d = reconstructConflictDraft(
      document("ab", [
        block("one", 1, 1, "X", ""),
        block("two", 1, 1, "Y", ""),
      ]),
    );
    for (const id of order) d = applyConflictBlock(d, id, "current");
    expect(d.text).toBe("aXYb");
  }
});
it("preserves independent range and choice after an undo transaction", () => {
  let d = reconstructConflictDraft(document());
  const changes = ChangeSet.of(
    { from: 0, insert: "manual\r\n" },
    d.text.length,
    "\n",
  );
  const original = d.text;
  d = editConflictDraft(d, changes);
  d = applyConflictBlock(d, "two", "incoming");
  // Undo the independent prefix edit in the current document.
  d = edit(d, 0, "manual\r\n".length, "");
  expect(d.blocks[1].choice).toBe("incoming");
  expect(d.text).toBe(original.replace(/base\nsuffix/, "theirs\nsuffix"));
});
it.each(["before", "after", "both"] as const)(
  "preserves %s boundary insertion in the same transaction as a block replacement",
  (side) => {
    let d = reconstructConflictDraft(
      document("prefix\nbase\nsuffix\n", [block("one", 7, 12)]),
    );
    const before = side === "before" || side === "both",
      after = side === "after" || side === "both";
    const changes = ChangeSet.of(
      [
        ...(before ? [{ from: 7, insert: "BEFORE" }] : []),
        { from: 7, to: 12, insert: "HAND" },
        ...(after ? [{ from: 12, insert: "AFTER" }] : []),
      ],
      d.text.length,
      "\n",
    );
    d = editConflictDraft(d, changes);
    expect(d.text.slice(d.blocks[0].from, d.blocks[0].to)).toBe("HAND");
    d = applyConflictBlock(d, "one", "current");
    expect(d.text).toBe(
      `prefix\n${before ? "BEFORE" : ""}ours\n${after ? "AFTER" : ""}suffix\n`,
    );
  },
);

function markedDocument(
  options: {
    width?: number;
    diff3?: boolean;
    eol?: string;
    prefix?: string;
    suffix?: string;
  } = {},
) {
  const {
    width = 7,
    diff3 = false,
    eol = "\n",
    prefix = "prefix\n",
    suffix = "suffix\n",
  } = options;
  const section = (size: number, base: boolean, label: string) =>
    `${"<".repeat(size)} ${label}${eol}ours${eol}` +
    (base ? `${"|".repeat(size)} ancestor${eol}base${eol}` : "") +
    `${"=".repeat(size)}${eol}theirs${eol}${">".repeat(size)} ${label}${suffix ? eol : ""}`;
  const generatedBlock = section(31, true, "random-host-label");
  const workingBlock = section(width, diff3, "HEAD");
  const source = {
    ...block(
      "one",
      prefix.length,
      prefix.length + generatedBlock.length,
      `ours${eol}`,
      `theirs${eol}`,
    ),
    base: { text: `base${eol}`, range: null },
  };
  const doc: GitConflictDocument = {
    ...document(prefix + generatedBlock + suffix, [source]),
    working: { kind: "text", text: prefix + workingBlock + suffix },
  };
  return { doc, source, workingBlock };
}
describe("safe initial conflict mapping", () => {
  it.each([false, true])(
    "maps untouched merge/diff3 working markers (diff3=%s) without changing text",
    (diff3) => {
      const { doc, source, workingBlock } = markedDocument({ diff3 });
      const draft = openConflictDraft(doc);
      expect(draft.text).toBe(doc.working.text);
      expect(draft.blocks).toEqual([
        {
          source,
          id: "one",
          from: 7,
          to: 7 + workingBlock.length,
          mapped: true,
          choice: null,
        },
      ]);
      expect(applyConflictBlock(draft, "one", "incoming").text).toBe(
        "prefix\ntheirs\nsuffix\n",
      );
    },
  );
  it("maps identical generated text", () => {
    const { doc } = markedDocument();
    if (doc.generated.kind !== "text") throw Error();
    expect(
      openConflictDraft({
        ...doc,
        working: { kind: "text", text: doc.generated.text },
      }).blocks,
    ).toHaveLength(1);
  });
  it("preserves BOM, CRLF, custom marker width and absent final newline", () => {
    const { doc } = markedDocument({
      width: 12,
      diff3: true,
      eol: "\r\n",
      prefix: "\ufeff",
      suffix: "",
    });
    const draft = openConflictDraft(doc);
    expect(draft.text).toBe(doc.working.text);
    expect(draft.blocks).toHaveLength(1);
    expect(applyConflictBlock(draft, "one", "current").text).toBe(
      "\ufeffours\r\n",
    );
  });
  it.each(["prefix", "ours", "theirs", "base", "suffix"])(
    "refuses manual changes to %s",
    (part) => {
      const { doc } = markedDocument({ diff3: true });
      const text = doc.working.text!.replace(part, "MANUAL");
      expect(
        openConflictDraft({ ...doc, working: { kind: "text", text } }),
      ).toMatchObject({ text, blocks: [] });
    },
  );
  it.each([
    "<<<<<<< nested\n",
    "=======\n",
    ">>>>>>> literal\n",
    "||||||| literal\n",
  ])("refuses literal or nested marker ambiguity: %s", (literal) => {
    const { doc } = markedDocument();
    const text = doc.working.text!.replace("ours\n", literal + "ours\n");
    expect(
      openConflictDraft({ ...doc, working: { kind: "text", text } }).blocks,
    ).toEqual([]);
  });
  it("refuses malformed marker widths and missing closing marker", () => {
    for (const replacement of [">>>>>> HEAD\n", "", ">>>>>>>HEAD\n"]) {
      const { doc } = markedDocument();
      const text = doc.working.text!.replace(">>>>>>> HEAD\n", replacement);
      expect(
        openConflictDraft({ ...doc, working: { kind: "text", text } }).blocks,
      ).toEqual([]);
    }
  });
  it("requires generated ranges, sections and unique IDs to agree with parsed blocks", () => {
    for (const mutate of [
      (source: GitConflictBlock) => ({
        ...source,
        resultRange: {
          ...source.resultRange,
          from: source.resultRange.from + 1,
        },
      }),
      (source: GitConflictBlock) => ({
        ...source,
        resultRange: { ...source.resultRange, to: source.resultRange.to - 1 },
      }),
      (source: GitConflictBlock) => ({
        ...source,
        current: { ...source.current, text: "different\n" },
      }),
      (source: GitConflictBlock) => ({ ...source, id: "" }),
    ]) {
      const { doc, source } = markedDocument();
      if (doc.generated.kind !== "text") throw Error();
      expect(
        openConflictDraft({
          ...doc,
          generated: { ...doc.generated, blocks: [mutate(source)] },
        }).blocks,
      ).toEqual([]);
    }
  });
});

it("maps repeated sections by complete ordered document, never by payload search", () => {
  const { doc, workingBlock } = markedDocument({
    prefix: "",
    suffix: "tail\n",
  });
  if (doc.generated.kind !== "text") throw Error();
  const generatedBlock = doc.generated.text.slice(
    0,
    doc.generated.blocks[0].resultRange.to,
  );
  const source = doc.generated.blocks[0];
  const duplicate: GitConflictDocument = {
    ...doc,
    working: {
      kind: "text",
      text: workingBlock + "between\n" + workingBlock + "tail\n",
    },
    generated: {
      ...doc.generated,
      text: generatedBlock + "between\n" + generatedBlock + "tail\n",
      blocks: [
        source,
        {
          ...source,
          id: "two",
          resultRange: {
            from: generatedBlock.length + 8,
            to: generatedBlock.length * 2 + 8,
          },
        },
      ],
    },
  };
  const draft = openConflictDraft(duplicate);
  expect(draft.blocks.map((b) => b.id)).toEqual(["one", "two"]);
  expect(applyConflictBlock(draft, "two", "incoming").text).toBe(
    workingBlock + "between\ntheirs\ntail\n",
  );
  expect(
    openConflictDraft({
      ...duplicate,
      working: { kind: "text", text: workingBlock + "tail\n" },
    }).blocks,
  ).toEqual([]);
  if (duplicate.generated.kind !== "text") throw Error();
  expect(
    openConflictDraft({
      ...duplicate,
      generated: {
        ...duplicate.generated,
        blocks: duplicate.generated.blocks.map((b) => ({ ...b, id: "one" })),
      },
    }).blocks,
  ).toEqual([]);
});
it("refuses literal markers even when both generated and working text contain them", () => {
  const { doc } = markedDocument({ prefix: "=======\n" });
  expect(openConflictDraft(doc).blocks).toEqual([]);
});
it("refuses a changed diff3 base marker line ending", () => {
  const { doc } = markedDocument({ diff3: true });
  const text = doc.working.text!.replace(
    "||||||| ancestor\n",
    "||||||| ancestor\r\n",
  );
  expect(
    openConflictDraft({ ...doc, working: { kind: "text", text } }).blocks,
  ).toEqual([]);
});

it.each(["\n", "\r\n"])(
  "maps proven native-inserted %j before markers without adding a final newline on apply",
  (eol) => {
    const { doc } = markedDocument({ eol, prefix: "", suffix: "" });
    if (doc.generated.kind !== "text") throw Error();
    const source = doc.generated.blocks[0];
    const nativeSource = (text: string) => ({
      text,
      range: { from: 0, to: text.length },
    });
    const native: GitConflictDocument = {
      ...doc,
      base: { ...doc.base, text: "base" },
      current: { ...doc.current, text: "ours" },
      incoming: { ...doc.incoming, text: "theirs" },
      generated: {
        ...doc.generated,
        blocks: [
          {
            ...source,
            base: nativeSource("base"),
            current: nativeSource("ours"),
            incoming: nativeSource("theirs"),
          },
        ],
      },
    };
    const draft = openConflictDraft(native);
    expect(draft.text).toBe(native.working.text);
    expect(draft.blocks).toHaveLength(1);
    expect(applyConflictBlock(draft, "one", "incoming").text).toBe("theirs");
    expect(applyConflictBlock(draft, "one", "current").text).toBe("ours");
    for (const invalid of [
      { ...native, current: { ...native.current, text: "ours\n" } },
      { ...native, current: { ...native.current, text: "ours extra" } },
      {
        ...native,
        generated: {
          ...native.generated,
          kind: "text" as const,
          text: doc.generated.text,
          requiresExplicitReconstruction: true as const,
          blocks: [
            {
              ...source,
              base: nativeSource("base"),
              current: { text: "ours", range: null },
              incoming: nativeSource("theirs"),
            },
          ],
        },
      },
    ])
      expect(openConflictDraft(invalid).blocks).toEqual([]);
  },
);
