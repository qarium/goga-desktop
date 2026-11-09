import { test } from "vitest";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import {
  getFixtures,
  loadNavigationSupports,
} from "./helpers/overview-navigation-fixtures";
import type {
  NavigationLanguage,
  NavigationResult,
} from "../src/renderer/overview/navigation/types";
const supports = await loadNavigationSupports();
import { resolveLocal } from "../src/renderer/overview/navigation/resolver";

function marked(input: string) {
  let source = "",
    query: { name: string; from: number; to: number } | undefined,
    targets: { name: string; from: number; to: number }[] = [];
  for (let i = 0; i < input.length;) {
    const open = input[i],
      close = open === "⟦" ? "⟧" : open === "⟨" ? "⟩" : null;
    if (!close) {
      source += input[i++];
      continue;
    }
    const end = input.indexOf(close, i + 1);
    assert.notEqual(end, -1);
    const name = input.slice(i + 1, end),
      span = { name, from: source.length, to: source.length + name.length };
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
function check(
  lang: NavigationLanguage,
  input: string,
  kind: NavigationResult["kind"] = "resolved",
) {
  const f = marked(input),
    state = EditorState.create({ doc: f.source, extensions: [supports[lang]] });
  const result = resolveLocal(
    state,
    lang,
    f.query.from + Math.min(1, f.query.to - f.query.from - 1),
  );
  assert.equal(result.kind, kind, JSON.stringify(result));
  assert.deepEqual(
    result.targets.map(({ name, from, to }) => ({ name, from, to })),
    f.targets,
  );
  if (kind !== "unavailable") {
    assert.deepEqual(result.token, { from: f.query.from, to: f.query.to });
    for (const target of result.targets) {
      assert.equal(target.line, state.doc.lineAt(target.from).number);
      assert.ok(target.signature.length > 0);
      assert.ok(f.source.includes(target.signature), target.signature);
    }
  } else assert.equal(typeof result.reason, "string");
  return { f, state, result };
}
const cases = {
  python: {
    direct: "def ⟦greet⟧():\n return 1\n⟨greet⟩()",
    parameter: "def greet():\n return 1\ndef use(⟦greet⟧):\n return ⟨greet⟩()",
    local:
      "def greet():\n return 1\ndef use():\n ⟦greet⟧ = 42\n return ⟨greet⟩()",
    nested:
      "def greet():\n return 1\ndef use():\n def ⟦greet⟧():\n  return 2\n return ⟨greet⟩()",
    lambda:
      "def greet():\n return 1\ndef use():\n ⟦greet⟧ = lambda: 2\n return ⟨greet⟩()",
    method: "class A:\n def ⟦greet⟧(self):\n  return 1\nobj.⟨greet⟩()",
    string: 'def greet():\n return 1\ns = "⟨greet⟩()"',
    comment: "def greet():\n return 1\n# ⟨greet⟩()",
    unicode: "def ⟦привет⟧():\n return 1\n⟨привет⟩()",
    broken: "def ⟦greet⟧():\n return 1\n⟨greet⟩()\ndef broken(",
    brokenDecl: "def greet(:\n pass\n⟨greet⟩()",
    sibling:
      "def outer():\n def greet():\n  return 1\ndef other():\n return ⟨greet⟩()",
    import: "def greet():\n return 1\nfrom lib import greet\n⟨greet⟩()",
    alias: "def greet():\n return 1\n⟦other⟧ = greet\n⟨other⟩()",
  },
  javascript: {
    direct: "function ⟦greet⟧(){return 1;} ⟨greet⟩();",
    parameter: "function greet(){} function use(⟦greet⟧){⟨greet⟩();}",
    local: "function greet(){} function use(){let ⟦greet⟧=42;⟨greet⟩();}",
    nested:
      "function greet(){} function use(){function ⟦greet⟧(){} ⟨greet⟩();}",
    lambda: "function greet(){} function use(){const ⟦greet⟧=()=>2;⟨greet⟩();}",
    method: "class A { ⟦greet⟧(){} } obj.⟨greet⟩();",
    string: 'function greet(){} const s="⟨greet⟩()";',
    comment: "function greet(){} // ⟨greet⟩()",
    unicode: "function ⟦привет⟧(){} ⟨привет⟩();",
    broken: "function ⟦greet⟧(){} ⟨greet⟩(); function broken(",
    brokenDecl: "function greet( {\n⟨greet⟩();",
    sibling:
      "function outer(){function greet(){}} function other(){⟨greet⟩();}",
    import: 'function greet(){} import {greet} from "lib"; ⟨greet⟩();',
    alias: "function greet(){} const ⟦other⟧ = greet; ⟨other⟩();",
  },
  typescript: {
    direct: "function ⟦greet⟧(): number {return 1;} ⟨greet⟩();",
    parameter: "function greet(){} function use(⟦greet⟧:()=>void){⟨greet⟩();}",
    local: "function greet(){} function use(){let ⟦greet⟧:unknown=42;⟨greet⟩();}",
    nested:
      "function greet(){} function use(){function ⟦greet⟧(){} ⟨greet⟩();}",
    lambda:
      "function greet(){} function use(){const ⟦greet⟧=():number=>2;⟨greet⟩();}",
    method: "class A { ⟦greet⟧():void{} } obj.⟨greet⟩();",
    string: 'function greet(){} const s="⟨greet⟩()";',
    comment: "function greet(){} // ⟨greet⟩()",
    unicode: "function ⟦привет⟧(){} ⟨привет⟩();",
    broken: "function ⟦greet⟧(){} ⟨greet⟩(); function broken(",
    brokenDecl: "function greet( {\n⟨greet⟩();",
    sibling:
      "function outer(){function greet(){}} function other(){⟨greet⟩();}",
    import: 'function greet(){} import {greet} from "lib"; ⟨greet⟩();',
    alias: "function greet(){} const ⟦other⟧ = greet; ⟨other⟩();",
  },
  go: {
    direct: "package p\nfunc ⟦greet⟧() int {return 1}\nfunc main(){⟨greet⟩()}",
    parameter: "package p\nfunc greet(){}\nfunc use(⟦greet⟧ func()){⟨greet⟩()}",
    local: "package p\nfunc greet(){}\nfunc use(){⟦greet⟧ := 42; ⟨greet⟩()}",
    nested:
      "package p\nfunc greet(){}\nfunc use(){ ⟦greet⟧ := func(){}; func(){⟨greet⟩()}() }",
    lambda:
      "package p\nfunc greet(){}\nfunc use(){⟦greet⟧ := func(){}; ⟨greet⟩()}",
    method:
      "package p\ntype A struct{}\nfunc (a A) ⟦greet⟧(){}\nfunc use(obj A){obj.⟨greet⟩()}",
    string: 'package p\nfunc greet(){}\nvar s="⟨greet⟩()"',
    comment: "package p\nfunc greet(){}\n// ⟨greet⟩()",
    unicode: "package p\nfunc ⟦привет⟧(){}\nfunc main(){⟨привет⟩()}",
    broken: "package p\nfunc ⟦greet⟧(){}\nfunc main(){⟨greet⟩()}\nfunc broken(",
    brokenDecl: "package p\nfunc greet( {\nfunc use(){⟨greet⟩()}",
    sibling:
      "package p\nfunc outer(){greet:=func(){}}\nfunc other(){⟨greet⟩()}",
    import: 'package p\nimport greet "lib"\nfunc use(){⟨greet⟩()}',
    alias: "package p\nfunc greet(){}\nfunc use(){⟦other⟧:=greet;⟨other⟩()}",
  },
  kotlin: {
    direct: "fun ⟦greet⟧(): Int = 1\nfun use() = ⟨greet⟩()",
    parameter: "fun greet()=1\nfun use(⟦greet⟧:()->Int) = ⟨greet⟩()",
    local: "fun greet()=1\nfun use(){val ⟦greet⟧=42; ⟨greet⟩()}",
    nested: "fun greet()=1\nfun use(){fun ⟦greet⟧()=2; ⟨greet⟩()}",
    lambda: "fun greet()=1\nfun use(){val ⟦greet⟧ = { 2 }; ⟨greet⟩()}",
    method: "class A { fun ⟦greet⟧()=1 }\nfun use(obj:A)=obj.⟨greet⟩()",
    string: 'fun greet()=1\nval s="⟨greet⟩()"',
    comment: "fun greet()=1\n// ⟨greet⟩()",
    unicode: "fun ⟦привет⟧()=1\nfun use()=⟨привет⟩()",
    broken: "fun ⟦greet⟧()=1\nfun use()=⟨greet⟩()\nfun broken(",
    brokenDecl: "fun greet( {\nfun use(){⟨greet⟩()}",
    sibling: "fun outer(){fun greet()=1}\nfun other()=⟨greet⟩()",
    import: "import lib.greet\nfun use()=⟨greet⟩()",
    alias: "fun greet()=1\nval ⟦other⟧=::greet\nfun use()=⟨other⟩()",
  },
  swift: {
    direct: "func ⟦greet⟧() -> Int {1}\n⟨greet⟩()",
    parameter:
      "func greet() -> Int {1}\nfunc use(_ ⟦greet⟧:()->Int) -> Int {⟨greet⟩()}",
    local: "func greet(){}\nfunc use(){let ⟦greet⟧=42; ⟨greet⟩()}",
    nested: "func greet(){}\nfunc use(){func ⟦greet⟧(){}; ⟨greet⟩()}",
    lambda: "func greet(){}\nfunc use(){let ⟦greet⟧ = { 2 }; ⟨greet⟩()}",
    method: "struct A {func ⟦greet⟧(){}}\nfunc use(_ obj:A){obj.⟨greet⟩()}",
    string: 'func greet(){}\nlet s="⟨greet⟩()"',
    comment: "func greet(){}\n// ⟨greet⟩()",
    unicode: "func ⟦привет⟧(){}\n⟨привет⟩()",
    broken: "func ⟦greet⟧(){}\n⟨greet⟩()\nfunc broken(",
    brokenDecl: "func greet( {\n⟨greet⟩()",
    sibling: "func outer(){func greet(){}}\nfunc other(){⟨greet⟩()}",
    import: "import func Lib.greet\n⟨greet⟩()",
    alias: "func greet(){}\nlet ⟦other⟧=greet\n⟨other⟩()",
  },
};
for (const [lang, fixtures] of Object.entries(cases) as [
  NavigationLanguage,
  typeof cases.python,
][]) {
  for (const [id, input] of Object.entries(fixtures))
    test(`${lang}: ${id}`, () =>
      check(
        lang,
        input,
        (["parameter", "local", "alias"].includes(id)) ? "resolved" : [
          "parameter",
          "local",
          "string",
          "comment",
          "brokenDecl",
          "sibling",
          "import",
          "alias",
        ].includes(id)
          ? "unavailable"
          : id === "method"
            ? "candidates"
            : "resolved",
      ));
  test(`${lang}: unsaved transaction changes name and UTF16 offsets`, () => {
    const { f, state } = check(lang, fixtures.direct);
    const name = "изменено",
      prefix = lang === "python" ? "# 😀 edit\r\n" : "// 😀 edit\r\n";
    const changes = [
      { from: 0, insert: prefix },
      ...f.targets
        .concat(f.query)
        .map((s) => ({ from: s.from, to: s.to, insert: name })),
    ];
    const next = state.update({ changes }).state;
    const prefixLength = EditorState.create({ doc: prefix }).doc.length; // EditorState normalizes CRLF to LF.
    const from = prefixLength + f.targets[0].from;
    const query =
      prefixLength + f.query.from + name.length - f.targets[0].name.length;
    const result = resolveLocal(next, lang, query + 1);
    assert.equal(result.kind, "resolved", JSON.stringify(result));
    assert.deepEqual(result.token, { from: query, to: query + name.length });
    assert.deepEqual(
      result.targets.map(({ name, from, to }) => ({ name, from, to })),
      [{ name, from, to: from + name.length }],
    );
    assert.equal(result.targets[0].line, next.doc.lineAt(from).number);
    assert.equal(
      resolveLocal(state, lang, f.query.from + 1).targets[0].name,
      "greet",
    );
  });
}
test("typescript: overloads stay candidates in source order", () =>
  check(
    "typescript",
    "function ⟦greet⟧(x:string):string;\nfunction ⟦greet⟧(x:any){return x;}\n⟨greet⟩(1)",
    "candidates",
  ));
test("kotlin: overloads stay candidates in source order", () =>
  check(
    "kotlin",
    "fun ⟦greet⟧(x:String)=x\nfun ⟦greet⟧(x:Int)=x\nfun use()=⟨greet⟩(1)",
    "candidates",
  ));
test("swift: overloads stay candidates in source order", () =>
  check(
    "swift",
    "func ⟦greet⟧(_ x:String)->String{x}\nfunc ⟦greet⟧(_ x:Int)->Int{x}\n⟨greet⟩(1)",
    "candidates",
  ));
test("python: conditional singleton is not a definite binding", () =>
  check(
    "python",
    "if flag:\n def ⟦greet⟧():\n  return 1\n⟨greet⟩()",
    "candidates",
  ));
test("javascript: block scope cannot leak", () =>
  check("javascript", "{function greet(){}}\n⟨greet⟩()", "unavailable"));
test("javascript: source value is not followed through assignment", () =>
  check(
    "javascript",
    "function greet(){}\ngreet=external;\n⟨greet⟩()",
    "unavailable",
  ));
test("python: assignment after call still shadows the function", () =>
  check(
    "python",
    "def greet():\n return 1\ndef use():\n ⟨greet⟩()\n ⟦greet⟧=42",
    "resolved",
  ));
test("kotlin: ordinary interpolation is structurally navigable", () =>
  check("kotlin", 'fun ⟦greet⟧()=1\nval s="${⟨greet⟩()}"'));
test("swift: ordinary interpolation is structurally navigable", () =>
  check("swift", 'func ⟦greet⟧()->Int{1}\nlet s="\\(⟨greet⟩())"'));
test("swift: raw string interpolation stays opaque", () =>
  check(
    "swift",
    'func greet()->Int{1}\nlet s=#"\\#(⟨greet⟩())"#',
    "unavailable",
  ));
test("kotlin: unsupported when guard region is unavailable", () =>
  check(
    "kotlin",
    "fun greet()=1\nfun choose(x:Any)=when(x){is Int if ⟨greet⟩()>0 -> x\nelse -> 0}",
    "unavailable",
  ));
test("unsupported language and missing parser are unavailable", () => {
  const state = EditorState.create({ doc: "greet()" });
  assert.equal(resolveLocal(state, "python", 1).kind, "unavailable");
  // @ts-expect-error Verify the runtime boundary also refuses unsupported callers.
  assert.equal(resolveLocal(state, "rust", 1).kind, "unavailable");
});
test("out of range input is unavailable", () => {
  const state = EditorState.create({
    doc: "greet()",
    extensions: [supports.javascript],
  });
  for (const p of [-1, 100, NaN, 1.5])
    assert.equal(resolveLocal(state, "javascript", p).kind, "unavailable");
});
test("bounded traversal refuses oversized files", () => {
  const state = EditorState.create({
    doc: " ".repeat(250_001),
    extensions: [supports.javascript],
  });
  assert.equal(resolveLocal(state, "javascript", 1).kind, "unavailable");
});

// Self-review regressions: keep syntax boundaries conservative rather than inferring values.
test("python: nested function in a method remains a lexical function", () =>
  check(
    "python",
    "class A:\n def use(self):\n  def ⟦greet⟧():\n   return 1\n  return ⟨greet⟩()",
  ));
test("javascript: nested function in a method remains lexical", () =>
  check("javascript", "class A { use(){function ⟦greet⟧(){} ⟨greet⟩()} }"));
test("kotlin: nested function in a method remains lexical", () =>
  check("kotlin", "class A { fun use(){fun ⟦greet⟧()=1; ⟨greet⟩()} }"));
test("swift: nested function in a method remains lexical", () =>
  check("swift", "struct A {func use(){func ⟦greet⟧(){}; ⟨greet⟩()} }"));
test("python: augmented assignment blocks a stale function target", () =>
  check(
    "python",
    "def greet():\n pass\ngreet += other\n⟨greet⟩()",
    "unavailable",
  ));
test("kotlin: assignment blocks a stale function target", () =>
  check(
    "kotlin",
    "fun greet()=1\nfun use(){greet=external; ⟨greet⟩()}",
    "unavailable",
  ));
test("swift: assignment blocks a stale function target", () =>
  check(
    "swift",
    "func greet(){}\nfunc use(){greet=external; ⟨greet⟩()}",
    "unavailable",
  ));
test("python: decorators are dynamic binding transformations", () =>
  check("python", "@decorate\ndef greet():\n pass\n⟨greet⟩()", "unavailable"));
test("python: global declaration is not mistaken for nearest local function", () =>
  check(
    "python",
    "def greet():\n return 1\ndef outer():\n def greet():\n  return 2\n def inner():\n  global greet\n  ⟨greet⟩()",
    "unavailable",
  ));
test("go: package name is not a function shadow", () =>
  check("go", "package main\nfunc ⟦main⟧(){⟨main⟩()}"));
test("typescript: names in function types do not introduce runtime bindings", () =>
  check(
    "typescript",
    "type Handler = (greet: string) => void;\nfunction ⟦greet⟧(){}\n⟨greet⟩()",
  ));
test("javascript: destructured parameter blocks outer function", () =>
  check(
    "javascript",
    "function greet(){}\nfunction use({⟦greet⟧}){⟨greet⟩()}",
  ));
test("kotlin: destructured binding blocks outer function", () =>
  check(
    "kotlin",
    "fun greet()=1\nfun use(){val (⟦greet⟧,other)=pair; ⟨greet⟩()}",
    "resolved",
  ));
test("swift: closure parameter blocks outer function", () =>
  check(
    "swift",
    "func greet(){}\nlet f = { ⟦greet⟧ in ⟨greet⟩() }",
    "resolved",
  ));
test("python: parsed interpolation is navigable", () =>
  check("python", 'def ⟦greet⟧():\n return 1\ns=f"{⟨greet⟩()}"'));
test("javascript: parsed template interpolation is navigable", () =>
  check("javascript", "function ⟦greet⟧(){}\nconst s=`${⟨greet⟩()}`"));
test("kotlin: lambda parameter blocks outer function", () =>
  check(
    "kotlin",
    "fun greet()=1\nval f={⟦greet⟧:()->Int -> ⟨greet⟩()}",
    "resolved",
  ));
test("python: lexical lookup in a method skips class attribute functions", () =>
  check(
    "python",
    "def ⟦greet⟧():\n return 1\nclass A:\n def greet(self):\n  return 2\n def use(self):\n  return ⟨greet⟩()",
  ));
test("javascript: lexical lookup in a method skips same-name method", () =>
  check(
    "javascript",
    "function ⟦greet⟧(){}\nclass A {greet(){} use(){⟨greet⟩()}}",
  ));
test("python: empty/incomplete call arguments do not cause jumps", () =>
  check("python", "def greet():\n pass\n⟨greet⟩(", "unavailable"));
test("javascript: direct function-expression binding is supported", () =>
  check("javascript", "const ⟦greet⟧ = function other(){}; ⟨greet⟩()"));
test("javascript: named function expression supports its internal lexical name", () =>
  check("javascript", "const bound=function ⟦greet⟧(){⟨greet⟩()};"));
test("javascript: named function expression name cannot leak", () =>
  check(
    "javascript",
    "const bound=function greet(){};⟨greet⟩()",
    "unavailable",
  ));
test("javascript: object-literal method is a candidate, not receiver inference", () =>
  check("javascript", "const obj={⟦greet⟧(){}}; obj.⟨greet⟩()", "candidates"));
test("javascript: value expressions in objects retain outer lexical scope", () =>
  check("javascript", "function ⟦greet⟧(){}; const obj={value:⟨greet⟩()};"));

for (const lang of Object.keys(cases) as NavigationLanguage[])
  for (const f of getFixtures(lang))
    test(`${lang}: showcase ${f.id}`, () => {
      const state = EditorState.create({
        doc: f.source,
        extensions: [supports[lang]],
      });
      const position = state.doc.toString().lastIndexOf(f.needle) + 1;
      const result = resolveLocal(state, lang, position);
      assert.equal(result.kind, f.expected, JSON.stringify(result));
      if (f.id === "shadow" && f.expected === "resolved") {
        const parameter = f.source.indexOf("render", f.source.indexOf("preview("));
        assert.deepEqual(result.targets.map(t => t.from), [parameter]);
        assert.notEqual(parameter, f.source.indexOf("render"));
      }
      if (result.kind !== "unavailable") {
        assert.ok(result.token);
        assert.ok(position >= result.token.from && position < result.token.to);
        for (const target of result.targets) {
          assert.equal(
            state.doc.sliceString(target.from, target.to),
            target.name,
          );
          assert.equal(target.line, state.doc.lineAt(target.from).number);
        }
      }
    });

test("swift: conditional singleton remains a candidate", () =>
  check(
    "swift",
    "#if DEBUG\nfunc ⟦greet⟧(){}\n#endif\n⟨greet⟩()",
    "candidates",
  ));
test("kotlin: function declared in conditional branch is a candidate", () =>
  check(
    "kotlin",
    "fun use(){if(flag){fun ⟦greet⟧()=1;⟨greet⟩()}}",
    "candidates",
  ));
test("javascript: conditional singleton remains a candidate", () =>
  check(
    "javascript",
    "if(flag){function ⟦greet⟧(){} ⟨greet⟩()}",
    "candidates",
  ));
test("python: annotation-only local shadows a function", () =>
  check(
    "python",
    "def greet():\n pass\ndef use():\n ⟦greet⟧: int\n ⟨greet⟩()",
    "resolved",
  ));
test("python: chained assignment creates each local binding", () =>
  check(
    "python",
    "def greet():\n pass\ndef use():\n a = ⟦greet⟧ = other\n ⟨greet⟩()",
    "resolved",
  ));
test("python: destructured loop bindings shadow functions", () =>
  check(
    "python",
    "def ⟦greet⟧():\n pass\nfor (⟦greet⟧,other) in values:\n ⟨greet⟩()",
    "candidates",
  ));
test("python: comprehension binding shadows only inside comprehension", () =>
  check(
    "python",
    "def greet():\n pass\nitems=[⟨greet⟩() for ⟦greet⟧ in values]",
    "candidates",
  ));
test("python: comprehension binding cannot leak out", () =>
  check(
    "python",
    "def ⟦greet⟧():\n pass\nitems=[greet() for greet in values]\n⟨greet⟩()",
  ));
test("python: assignment expression shadows outer function", () =>
  check(
    "python",
    "def greet():\n pass\ndef use():\n (⟦greet⟧ := other)\n ⟨greet⟩()",
    "resolved",
  ));
test("swift: catch binding shadows outer function", () =>
  check(
    "swift",
    "func greet(){}\ndo {} catch let ⟦greet⟧ {⟨greet⟩()}",
    "resolved",
  ));
test("javascript: destructuring assignment does not follow values", () =>
  check(
    "javascript",
    "function greet(){}\n({greet}=external);⟨greet⟩()",
    "unavailable",
  ));
test("candidate count limit refuses a huge ambiguous set", () => {
  const source =
    Array.from({ length: 101 }, (_, i) => `class A${i}{greet(){}}`).join("\n") +
    "\nobj.greet()";
  const state = EditorState.create({
    doc: source,
    extensions: [supports.javascript],
  });
  const result = resolveLocal(
    state,
    "javascript",
    source.lastIndexOf("greet") + 1,
  );
  assert.equal(result.kind, "unavailable");
  assert.equal(result.reason, "candidate-limit");
});
test("deeply nested syntax is refused without recursive traversal", () => {
  const source = "(".repeat(300) + "greet()" + ")".repeat(300);
  const state = EditorState.create({
    doc: source,
    extensions: [supports.javascript],
  });
  const result = resolveLocal(state, "javascript", 301);
  assert.equal(result.kind, "unavailable");
  assert.equal(result.reason, "index-budget-exceeded");
});
test("immutable state and position reuse the memoized result", () => {
  const { state, f, result } = check("javascript", cases.javascript.direct);
  assert.equal(resolveLocal(state, "javascript", f.query.from + 1), result);
});

test("selection-only states reuse the immutable-document structural index", () => {
  const { state, f, result } = check("javascript", cases.javascript.direct);
  const next = state.update({ selection: { anchor: 2 } }).state;
  assert.equal(next.doc, state.doc);
  assert.equal(resolveLocal(next, "javascript", f.query.from + 1), result);
});
test("same document with a different actual parser does not reuse old index", () => {
  const { state, f, result } = check("javascript", cases.javascript.direct);
  const different = EditorState.create({
    doc: state.doc,
    extensions: [supports.javascript.language.configure({})],
  });
  assert.equal(different.doc, state.doc);
  const fresh = resolveLocal(different, "javascript", f.query.from + 1);
  assert.notEqual(fresh, result);
  assert.deepEqual(fresh, result);
});
test("temporary parse-budget refusal recovers after real parser completes", async () => {
  const { ensureSyntaxTree } = await import("@codemirror/language");
  // A finite scheduling wrapper delays one real parser advance after initial viewport parse. No mocked tree/targets.
  let delays = 0,
    advances = 0;
  const delayed = supports.javascript.language.configure({
    wrap: (inner) => ({
      advance() {
        advances++;
        if (delays > 0) {
          delays--;
          const until = performance.now() + 65;
          while (performance.now() < until) {}
          return null;
        }
        return inner.advance();
      },
      stopAt(position) {
        inner.stopAt(position);
      },
      get parsedPos() {
        return inner.parsedPos;
      },
      get stoppedAt() {
        return inner.stoppedAt;
      },
    }),
  });
  const source =
    "function greet(){};\n" +
    Array.from({ length: 400 }, (_, i) => `const filler${i}=0;`).join("\n") +
    "\ngreet()";
  const state = EditorState.create({ doc: source, extensions: [delayed] });
  delays = 1;
  const first = resolveLocal(
    state,
    "javascript",
    source.lastIndexOf("greet") + 1,
  );
  assert.equal(first.kind, "unavailable");
  assert.equal(first.reason, "parse-budget-exceeded");
  const before = advances;
  assert.equal(
    resolveLocal(state, "javascript", source.lastIndexOf("greet") + 1),
    first,
  );
  assert.equal(
    advances,
    before,
    "unchanged hover must not start another expensive parse",
  );
  assert.ok(ensureSyntaxTree(state, state.doc.length, 1000));
  const result = resolveLocal(
    state,
    "javascript",
    source.lastIndexOf("greet") + 1,
  );
  assert.equal(result.kind, "resolved");
  assert.deepEqual(
    result.targets.map(({ name, from, to }) => ({ name, from, to })),
    [{ name: "greet", from: 9, to: 14 }],
  );
});

test("python: match capture shadows outer function", () =>
  check(
    "python",
    'def greet(): pass\nmatch item:\n case {"greet": greet}:\n  ⟨greet⟩()',
    "unavailable",
  ));
test("kotlin: implicit it lambda parameter blocks outer function", () =>
  check(
    "kotlin",
    "fun it()=1; fun use(values:List<()->Int>) { values.forEach { ⟨it⟩() } }",
    "unavailable",
  ));
test("kotlin: explicit zero-parameter lambda can access an outer it function", () =>
  check("kotlin", "fun ⟦it⟧()=1; val f = { -> ⟨it⟩() }"));
test("python: parenthesized assignment target shadows outer function", () =>
  check(
    "python",
    "def greet():pass\ndef use():\n (⟦greet⟧) = other\n ⟨greet⟩()",
    "resolved",
  ));
test("python: del introduces a local binding barrier", () =>
  check(
    "python",
    "def greet():pass\ndef use():\n del greet\n ⟨greet⟩()",
    "unavailable",
  ));
test("javascript: with uses dynamic scope, not the outer lexical function", () =>
  check(
    "javascript",
    "function greet(){}\nwith(other){⟨greet⟩();}",
    "unavailable",
  ));
test("go: parenthesized reassignment does not resolve stale lambda", () =>
  check(
    "go",
    "package p\nfunc use(external func()){ ⟦greet⟧ := func(){}; (greet) = external; ⟨greet⟩() }",
    "resolved",
  ));
test("swift: parenthesized reassignment does not resolve stale lambda", () =>
  check(
    "swift",
    "func use(_ external: () -> Int){ var ⟦greet⟧ = { 1 }; (greet) = external; ⟨greet⟩() }",
    "resolved",
  ));
test("kotlin: parenthesized reassignment does not resolve stale lambda", () =>
  check(
    "kotlin",
    "fun use(external: () -> Int){ var ⟦greet⟧ = { 1 }; (greet) = external; ⟨greet⟩() }",
    "resolved",
  ));

const references = {
  python: "def ⟦greet⟧(): pass\nuse(⟨greet⟩)",
  javascript: "function ⟦greet⟧(){}; const cb=⟨greet⟩;",
  typescript: "function ⟦greet⟧():void{}; const cb=⟨greet⟩;",
  go: "package p\nfunc ⟦greet⟧(){}\nfunc use(){consume(⟨greet⟩)}",
  kotlin: "fun ⟦greet⟧()=1\nval cb=::⟨greet⟩",
  swift: "func ⟦greet⟧(){}\nlet cb=⟨greet⟩",
};
for (const [lang, source] of Object.entries(references) as [
  NavigationLanguage,
  string,
][])
  test(`${lang}: direct expression function reference is navigable without alias tracing`, () =>
    check(lang, source));
test("javascript: callback argument is a lexical reference", () =>
  check("javascript", "function ⟦greet⟧(){}; consume(⟨greet⟩);"));
test("javascript: object method reference remains a candidate", () =>
  check(
    "javascript",
    "const obj={⟦greet⟧(){}}; const cb=obj.⟨greet⟩;",
    "candidates",
  ));
test("kotlin: receiver callable reference remains a candidate", () =>
  check(
    "kotlin",
    "class A {fun ⟦greet⟧()=1}\nval cb=A::⟨greet⟩",
    "candidates",
  ));
test("javascript: object property label is not a reference", () =>
  check(
    "javascript",
    "function greet(){}; const obj={⟨greet⟩:1};",
    "unavailable",
  ));
test("python: type annotation is not an expression reference", () =>
  check("python", "def greet():pass\ndef use(x:⟨greet⟩):pass", "unavailable"));
test("swift: type name is not an expression reference", () =>
  check("swift", "func greet(){}\nlet value: ⟨greet⟩", "unavailable"));
test("javascript: declaration name is not a consumer reference", () =>
  check("javascript", "function ⟨greet⟩(){}", "unavailable"));

// Quality review: expression references must exclude labels and observe every binding target.
test("python: keyword argument label is not an expression reference", () =>
  check("python", "def greet():pass\nconsume(⟨greet⟩=1)", "unavailable"));
test("python: keyword argument value remains an expression reference", () =>
  check("python", "def ⟦greet⟧():pass\nconsume(greet=⟨greet⟩)"));
test("swift: argument label is not an expression reference", () =>
  check("swift", "func greet(){}\nconsume(⟨greet⟩: 1)", "unavailable"));
test("swift: labeled argument value remains an expression reference", () =>
  check("swift", "func ⟦greet⟧(){}\nconsume(greet: ⟨greet⟩)"));
test("swift: local tuple binding shadows the outer function", () =>
  check(
    "swift",
    "func greet(){}\nfunc use(_ values: (() -> Void, () -> Void)){let (⟦greet⟧,other) = values; ⟨greet⟩()}",
    "resolved",
  ));
test("swift: nested tuple binding shadows the outer function", () =>
  check(
    "swift",
    "func greet(){}\nfunc use(_ values: ((() -> Void, () -> Void), () -> Void)){let ((⟦greet⟧,other),third) = values; ⟨greet⟩()}",
    "resolved",
  ));
for (const lang of ["javascript", "typescript"] as const) {
  for (const expression of ["++greet", "--greet", "greet++", "greet--"])
    test(`${lang}: ${expression} blocks the stale function target`, () =>
      check(
        lang,
        `function greet(){}\n${expression}; ⟨greet⟩();`,
        "unavailable",
      ));
  test(`${lang}: unary plus is a reference, not an assignment barrier`, () =>
    check(lang, "function ⟦greet⟧(){}\n+greet; ⟨greet⟩();"));
}
test("go: second assignment target blocks its previous lambda", () =>
  check(
    "go",
    "package p\nfunc use(external func()){ other := func(){}; ⟦greet⟧ := func(){}; other, greet = external, external; ⟨greet⟩() }",
    "resolved",
  ));
test("go: parenthesized second assignment target blocks the outer function", () =>
  check(
    "go",
    "package p\nfunc greet(){}\nfunc use(external func()){ var other func(); other, (greet) = external, external; ⟨greet⟩() }",
    "unavailable",
  ));

for (const lang of Object.keys(cases) as NavigationLanguage[]) {
  test(`${lang}: product line separator preserves BOM, emoji UTF16 and CRLF offsets`, () => {
    const prefix = "\uFEFF" + (lang === "python" ? "# 😀\r\n" : "// 😀\r\n");
    const f = marked(prefix + cases[lang].direct.replaceAll("\n", "\r\n"));
    const state = EditorState.create({
      doc: f.source,
      extensions: [EditorState.lineSeparator.of("\n"), supports[lang]],
    });
    assert.equal(state.doc.toString(), f.source);
    assert.equal(state.doc.length, f.source.length);
    const actual = resolveLocal(state, lang, f.query.from + 1);
    assert.equal(actual.kind, "resolved", JSON.stringify(actual));
    assert.deepEqual(actual.token, { from: f.query.from, to: f.query.to });
    assert.deepEqual(
      actual.targets.map(({ name, from, to }) => ({ name, from, to })),
      f.targets,
    );
    assert.equal(
      actual.targets[0].line,
      state.doc.lineAt(f.targets[0].from).number,
    );
    // One emoji is two UTF-16 code units; source offsets must not become code-point offsets.
    assert.equal(
      f.targets[0].from - [...f.source.slice(0, f.targets[0].from)].length,
      1,
    );
    assert.equal(
      state.doc.sliceString(actual.targets[0].from, actual.targets[0].to),
      "greet",
    );
  });
}

const mixedLineEndingCases: Record<NavigationLanguage, string> = {
  python: "\uFEFF# 😀\r\ndef ⟦greet⟧():\n return 1\r\n⟨greet⟩()",
  javascript: "\uFEFF// 😀\r\nfunction ⟦greet⟧(){return 1;}\n⟨greet⟩();",
  typescript:
    "\uFEFF// 😀\r\nfunction ⟦greet⟧(): number {return 1;}\n⟨greet⟩();",
  go: "\uFEFF// 😀\r\npackage p\nfunc ⟦greet⟧() int {return 1}\r\nfunc main(){⟨greet⟩()}",
  kotlin: "\uFEFF// 😀\r\nfun ⟦greet⟧(): Int = 1\nfun use() = ⟨greet⟩()",
  swift: "\uFEFF// 😀\r\nfunc ⟦greet⟧() -> Int {1}\n⟨greet⟩()",
};

for (const lang of Object.keys(mixedLineEndingCases) as NavigationLanguage[]) {
  test(`${lang}: product line separator preserves mixed CRLF/LF with BOM and emoji UTF16 offsets`, () => {
    const f = marked(mixedLineEndingCases[lang]);
    assert.ok(f.source.startsWith("\uFEFF"));
    assert.ok(f.source.includes("\r\n"));
    assert.ok(f.source.replaceAll("\r\n", "").includes("\n"));
    const state = EditorState.create({
      doc: f.source,
      extensions: [EditorState.lineSeparator.of("\n"), supports[lang]],
    });
    assert.equal(state.doc.toString(), f.source);
    assert.equal(state.doc.length, f.source.length);
    const actual = resolveLocal(state, lang, f.query.from + 1);
    assert.equal(actual.kind, "resolved", JSON.stringify(actual));
    assert.deepEqual(actual.token, { from: f.query.from, to: f.query.to });
    assert.deepEqual(
      actual.targets.map(({ name, from, to }) => ({ name, from, to })),
      f.targets,
    );
    assert.equal(actual.targets[0].line, lang === "go" ? 3 : 2);
    assert.equal(
      state.doc.lineAt(f.query.from).number,
      lang === "python" || lang === "go" ? 4 : 3,
    );
    assert.equal(
      f.targets[0].from - [...f.source.slice(0, f.targets[0].from)].length,
      1,
    );
    assert.equal(
      state.doc.sliceString(actual.targets[0].from, actual.targets[0].to),
      "greet",
    );
    assert.equal(
      state.doc.sliceString(actual.token!.from, actual.token!.to),
      "greet",
    );
  });
}
