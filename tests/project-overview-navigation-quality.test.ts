// Independent quality review: parse synthetic text only, never execute the samples.
import { test } from "vitest";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { loadNavigationSupports } from "./helpers/overview-navigation-fixtures";
import type { NavigationLanguage } from "../src/renderer/overview/navigation/types";
const supports = await loadNavigationSupports();
import { resolveLocal } from "../src/renderer/overview/navigation/resolver";

function result(language: NavigationLanguage, source: string) {
  const state = EditorState.create({
    doc: source,
    extensions: [supports[language]],
  });
  return resolveLocal(state, language, source.lastIndexOf("greet") + 1);
}

for (const [language, source] of [
  ["python", "def greet():pass\nconsume(greet=1)"],
  ["swift", "func greet(){}\nconsume(greet: 1)"],
] as const) {
  test(`${language}: argument label is not a lexical function reference`, () => {
    const actual = result(language, source);
    assert.equal(actual.kind, "unavailable", JSON.stringify(actual));
    assert.deepEqual(actual.targets, []);
  });
}

for (const [language, source] of [
  ["python", "def greet():pass\nconsume(callback=greet)"],
  ["swift", "func greet(){}\nconsume(callback: greet)"],
] as const) {
  test(`${language}: argument value still supports a lexical reference`, () => {
    const actual = result(language, source);
    assert.equal(actual.kind, "resolved", JSON.stringify(actual));
    assert.equal(actual.targets[0].from, source.indexOf("greet"));
  });
}

test("swift: tuple declaration shadows an outer function", () => {
  const actual = result(
    "swift",
    "func greet(){}\nfunc use(_ values: (() -> Void, Int)){ let (greet,other) = values; greet() }",
  );
  assert.equal(actual.kind, "resolved", JSON.stringify(actual));
  assert.deepEqual(actual.targets.map(t=>({name:t.name,from:t.from,to:t.to})),[{name:"greet",from:59,to:64}]);
});

test("go: parallel writes keep declaration address, not the assigned callable", () => {
  const actual = result(
    "go",
    "package p\nfunc use(external func()){ first := func(){}; greet := func(){}; first, greet = external, external; greet() }",
  );
  assert.equal(actual.kind, "resolved", JSON.stringify(actual));
  assert.deepEqual(actual.targets.map(t => ({name:t.name,from:t.from,to:t.to})), [{name:"greet",from:56,to:61}]);
});

for (const language of ["javascript", "typescript"] as const) {
  for (const update of ["++greet", "greet++"] as const) {
    test(`${language}: ${update} invalidates a previously callable binding`, () => {
      const actual = result(language, `function greet(){}\n${update}; greet()`);
      assert.equal(actual.kind, "unavailable", JSON.stringify(actual));
      assert.deepEqual(actual.targets, []);
    });
  }
}
