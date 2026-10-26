import { ChangeSet, Text } from "@codemirror/state";
import type {
  GitConflictBlock,
  GitConflictBlockSource,
  GitConflictSource,
  GitConflictDocument,
} from "../shared/git-conflicts";

export type ConflictBlockChoice = "current" | "incoming" | "both";
export interface ConflictDraftBlock {
  readonly source: GitConflictBlock;
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly mapped: boolean;
  readonly choice: ConflictBlockChoice | "manual" | null;
}
/** In-memory only; fingerprint is provenance, never permission to save. */
export interface ConflictDraft {
  readonly fingerprint: string;
  readonly text: string;
  readonly blocks: readonly ConflictDraftBlock[];
}
const unmapped = () =>
  Error(
    "Позиция блока изменилась. Сохраните ручные правки; автоматическое применение этого блока недоступно.",
  );

interface ParsedConflict {
  from: number;
  to: number;
  current: string;
  base?: string;
  baseMarkerEnding?: string;
  incoming: string;
  markerEndings: string[];
}
/** Deliberately fail closed on nested, stray or malformed marker-like lines. */
function parseInitialConflicts(text: string): ParsedConflict[] | null {
  const blocks: ParsedConflict[] = [];
  let offset = text.startsWith("\ufeff") ? 1 : 0;
  let active: ParsedConflict | undefined;
  let state: "current" | "base" | "incoming" = "current";
  let width = 0,
    sectionStart = 0;
  for (const line of text.slice(offset).match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const ending = line.endsWith("\r\n")
      ? "\r\n"
      : line.endsWith("\n")
        ? "\n"
        : "";
    const body = line.slice(0, line.length - ending.length);
    const marker = /^(<+|\|+|=+|>+)(?: (.*))?$/.exec(body);
    if (!marker) {
      if (/^(<{7,}|\|{7,}|={7,}|>{7,})/.test(body)) return null;
      offset += line.length;
      continue;
    }
    const token = marker[1],
      kind = token[0];
    if (kind === "=" && marker[2] !== undefined) return null;
    if (kind === "<") {
      if (active || !ending) return null;
      width = token.length;
      active = {
        from: offset,
        to: 0,
        current: "",
        incoming: "",
        markerEndings: [ending],
      };
      state = "current";
    } else {
      if (!active || token.length !== width) return null;
      if (kind === "|" && state === "current" && ending) {
        active.current = text.slice(sectionStart, offset);
        active.baseMarkerEnding = ending;
        state = "base";
      } else if (kind === "=" && state !== "incoming" && ending) {
        active[state] = text.slice(sectionStart, offset);
        active.markerEndings.push(ending);
        state = "incoming";
      } else if (kind === ">" && state === "incoming") {
        active.incoming = text.slice(sectionStart, offset);
        active.markerEndings.push(ending);
        active.to = offset + line.length;
        blocks.push(active);
        active = undefined;
      } else return null;
    }
    offset += line.length;
    sectionStart = offset;
  }
  return active ? null : blocks;
}
/** Git may add one delimiter newline after an unterminated source EOF. */
function matchesGeneratedSection(
  parsed: string,
  section: GitConflictBlockSource,
  source: GitConflictSource,
): boolean {
  if (parsed === section.text) return true;
  const range = section.range;
  const text = source.text;
  return (
    source.kind === "text" &&
    text !== undefined &&
    !text.endsWith("\n") &&
    section.text.length > 0 &&
    range !== null &&
    Number.isSafeInteger(range.from) &&
    range.from >= 0 &&
    range.to === text.length &&
    range.from < range.to &&
    (range.from === 0 || text[range.from - 1] === "\n") &&
    text.slice(range.from, range.to) === section.text &&
    (parsed === section.text + "\n" || parsed === section.text + "\r\n")
  );
}

/** Match the complete ordered document, never search for repeated section text. */
function initialConflictBlocks(
  document: GitConflictDocument,
  text: string,
): ConflictDraftBlock[] {
  const generated = document.generated;
  if (generated.kind !== "text") return [];
  const expected = parseInitialConflicts(generated.text);
  const actual = parseInitialConflicts(text);
  if (
    !expected ||
    !actual ||
    expected.length !== actual.length ||
    expected.length !== generated.blocks.length
  )
    return [];
  let expectedEnd = 0,
    actualEnd = 0;
  const ids = new Set<string>();
  const blocks: ConflictDraftBlock[] = [];
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i],
      e = expected[i],
      source = generated.blocks[i];
    if (
      !source.id ||
      ids.has(source.id) ||
      source.resultRange.from !== e.from ||
      source.resultRange.to !== e.to ||
      e.base === undefined ||
      !matchesGeneratedSection(e.base, source.base, document.base) ||
      !matchesGeneratedSection(e.current, source.current, document.current) ||
      !matchesGeneratedSection(
        e.incoming,
        source.incoming,
        document.incoming,
      ) ||
      a.current !== e.current ||
      a.incoming !== e.incoming ||
      (a.base !== undefined &&
        (a.base !== e.base || a.baseMarkerEnding !== e.baseMarkerEnding)) ||
      a.markerEndings.join("|") !== e.markerEndings.join("|") ||
      text.slice(actualEnd, a.from) !==
        generated.text.slice(expectedEnd, e.from)
    )
      return [];
    ids.add(source.id);
    blocks.push({
      source,
      id: source.id,
      from: a.from,
      to: a.to,
      mapped: true,
      choice: null,
    });
    actualEnd = a.to;
    expectedEnd = e.to;
  }
  return text.slice(actualEnd) === generated.text.slice(expectedEnd)
    ? blocks
    : [];
}

/** Start with the user's actual file, not a reconstruction that could lose edits. */
export function openConflictDraft(
  document: GitConflictDocument,
): ConflictDraft {
  if (document.working.kind !== "text" || document.working.text === undefined)
    throw Error("Рабочий файл недоступен как текст.");
  return {
    fingerprint: document.fingerprint,
    text: document.working.text,
    blocks: initialConflictBlocks(document, document.working.text),
  };
}
/** Call only after an explicit reconstruction decision; no worktree write. */
export function reconstructConflictDraft(
  document: GitConflictDocument,
): ConflictDraft {
  const generated = document.generated;
  if (generated.kind !== "text") throw Error(generated.reason);
  let end = 0;
  const ids = new Set<string>();
  const blocks = generated.blocks.map((source) => {
    const { from, to } = source.resultRange;
    if (
      !source.id ||
      ids.has(source.id) ||
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < end ||
      to < from ||
      to > generated.text.length
    )
      throw Error("Некорректные позиции блоков конфликта.");
    ids.add(source.id);
    end = to;
    return { source, id: source.id, from, to, mapped: true, choice: null };
  });
  return { fingerprint: document.fingerprint, text: generated.text, blocks };
}
/** Use the real editor transaction, never a string search or inferred whole-file diff. */
export function editConflictDraft(
  draft: ConflictDraft,
  changes: ChangeSet,
): ConflictDraft {
  if (changes.length !== draft.text.length)
    throw Error("Изменение относится к другой версии документа.");
  if (changes.empty) return draft;
  const text = changes.apply(Text.of(draft.text.split("\n"))).toString();
  const blocks = draft.blocks.map((block) => {
    let mapped = block.mapped,
      touched = false,
      replacementStart: number | undefined,
      replacementEnd: number | undefined;
    changes.iterChanges((from, to, fromB, toB) => {
      if (from === to) {
        if (from > block.from && from < block.to) touched = true;
        return; // Boundary insertions are outside this block and must survive application.
      }
      if (
        (from < block.from && to > block.from) ||
        (from < block.to && to > block.to)
      )
        mapped = false;
      if (from < block.to && to > block.from) {
        touched = true;
        // Exact per-change output coordinates exclude separate insertions at the
        // same boundary in this transaction. mapPos alone would absorb them.
        if (from === block.from) replacementStart = fromB;
        if (to === block.to) replacementEnd = toB;
      }
    }, true);
    const from = replacementStart ?? changes.mapPos(block.from, 1);
    // A zero-width slot stays a slot even when text is inserted at its anchor.
    const to =
      block.from === block.to
        ? from
        : (replacementEnd ?? changes.mapPos(block.to, -1));
    mapped = mapped && from <= to;
    return {
      ...block,
      from,
      to,
      mapped,
      choice: !mapped || touched ? null : block.choice,
    };
  });
  return { ...draft, text, blocks };
}
function requireBlock(draft: ConflictDraft, id: string) {
  const block = draft.blocks.find((block) => block.id === id);
  if (!block?.mapped) throw unmapped();
  return block;
}
/** Applying another side intentionally replaces only this mapped block. */
export function applyConflictBlock(
  draft: ConflictDraft,
  id: string,
  choice: ConflictBlockChoice,
): ConflictDraft {
  const block = requireBlock(draft, id);
  const insert =
    choice === "both"
      ? block.source.current.text + block.source.incoming.text
      : block.source[choice].text;
  const changes = ChangeSet.of(
    { from: block.from, to: block.to, insert },
    draft.text.length,
    "\n",
  );
  const next = editConflictDraft(draft, changes);
  const targetIndex = draft.blocks.indexOf(block);
  return {
    ...next,
    blocks: next.blocks.map((item, index) => {
      if (item.id === id)
        return {
          ...item,
          from: block.from,
          to: block.from + insert.length,
          mapped: true,
          choice,
        };
      const prior = draft.blocks[index];
      // Several absent base sections can occupy the same slot. Native block order,
      // not application order, determines where a preceding empty block belongs.
      if (
        index < targetIndex &&
        prior.from === prior.to &&
        prior.to === block.from
      )
        return { ...item, from: block.from, to: block.from };
      return item;
    }),
  };
}
export function resolveConflictBlockManually(
  draft: ConflictDraft,
  id: string,
): ConflictDraft {
  requireBlock(draft, id);
  return {
    ...draft,
    blocks: draft.blocks.map((block) =>
      block.id === id ? { ...block, choice: "manual" } : block,
    ),
  };
}
