import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { loadNavigationSupports } from "./overview-navigation-fixtures";
import { resolveLocal } from "../../src/renderer/overview/navigation/resolver";
import type {
  NavigationLanguage,
  NavigationResult,
} from "../../src/renderer/overview/navigation/types";

const supports = await loadNavigationSupports();
export function markSymbol(input: string) {
  let source = "";
  let query: { name: string; from: number; to: number } | undefined;
  const targets: { name: string; from: number; to: number }[] = [];
  for (let i = 0; i < input.length;) {
    const open = input[i];
    const close = open === "⟦" ? "⟧" : open === "⟨" ? "⟩" : null;
    if (!close) {
      source += input[i++];
      continue;
    }
    const end = input.indexOf(close, i + 1);
    assert.notEqual(end, -1, "Unclosed fixture marker");
    const name = input.slice(i + 1, end);
    assert.ok(name.length);
    const span = { name, from: source.length, to: source.length + name.length };
    if (open === "⟦") targets.push(span);
    else {
      assert.equal(query, undefined);
      query = span;
    }
    source += name;
    i = end + 1;
  }
  assert.ok(query);
  return { source, query, targets };
}
export function checkSymbol(
  lang: NavigationLanguage,
  input: string,
  kind: NavigationResult["kind"] = "resolved",
) {
  const f = markSymbol(input);
  const state = EditorState.create({
    doc: f.source,
    extensions: [supports[lang]],
  });
  const position = f.query.from + Math.min(1, f.query.to - f.query.from - 1);
  const actual = resolveLocal(state, lang, position);
  assert.equal(actual.kind, kind, JSON.stringify(actual));
  assert.deepEqual(
    actual.targets.map(({ name, from, to }) => ({ name, from, to })),
    f.targets,
  );
  if (kind === "unavailable") assert.equal(typeof actual.reason, "string");
  else {
    assert.deepEqual(actual.token, { from: f.query.from, to: f.query.to });
    for (const target of actual.targets) {
      assert.equal(target.line, state.doc.lineAt(target.from).number);
      assert.equal(state.doc.sliceString(target.from, target.to), target.name);
      assert.ok(target.signature.length > 0);
    }
  }
  return { actual, state, fixture: f };
}
