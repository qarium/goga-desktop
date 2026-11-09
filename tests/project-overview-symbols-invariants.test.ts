import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { loadNavigationSupports } from "./helpers/overview-navigation-fixtures";
import { checkSymbol, markSymbol } from "./helpers/overview-symbol-fixtures";
import {
  resolveLocal,
  limits,
} from "../src/renderer/overview/navigation/resolver";
const supports = await loadNavigationSupports();
for (const count of [100, 101])
  test(`symbol candidates: ${count}`, () => {
    const source =
      Array.from({ length: count }, (_, i) => `class C${i}{value=${i};}`).join(
        "\n",
      ) + "\nobj.value;";
    const state = EditorState.create({
      doc: source,
      extensions: [supports.javascript],
    });
    const result = resolveLocal(
      state,
      "javascript",
      source.lastIndexOf("value") + 1,
    );
    assert.equal(result.kind, count === 100 ? "candidates" : "unavailable");
    if (count === 101) {
      assert.equal(result.reason, "candidate-limit");
      assert.deepEqual(result.targets, []);
    } else {
      assert.equal(result.targets.length, 100);
      assert.deepEqual(
        [...result.targets].sort((a, b) => a.from - b.from),
        result.targets,
      );
    }
  });
test("symbol index has no lifetime and shares immutable Text", () => {
  const source = "let value=1; consume(value);",
    state = EditorState.create({
      doc: source,
      extensions: [supports.javascript],
    });
  const pos = source.lastIndexOf("value") + 1,
    first = resolveLocal(state, "javascript", pos);
  assert.equal(first.kind, "resolved");
  const spy = vi.spyOn(performance, "now").mockReturnValue(1e12);
  try {
    const next = state.update({ selection: { anchor: 0 } }).state;
    assert.equal(next.doc, state.doc);
    assert.equal(resolveLocal(next, "javascript", pos), first);
    assert.equal(resolveLocal(next, "javascript", pos + 1).kind, "resolved");
  } finally {
    spy.mockRestore();
  }
});
test("symbols honor document limit", () => {
  const source = "let value=1;\n" + " ".repeat(limits.characters) + "value;";
  const state = EditorState.create({
    doc: source,
    extensions: [supports.javascript],
  });
  assert.equal(
    resolveLocal(state, "javascript", source.lastIndexOf("value")).reason,
    "document-limit",
  );
});
test("new parameter signature is bounded", () => {
  const names = Array.from({ length: 100 }, (_, i) => `p${i}`).join(",");
  const source = `function f(${names}){return p99;}`;
  const state = EditorState.create({
    doc: source,
    extensions: [supports.javascript],
  });
  const result = resolveLocal(
    state,
    "javascript",
    source.lastIndexOf("p99") + 1,
  );
  assert.equal(result.kind, "resolved");
  assert.ok(result.targets[0].signature.length <= 180);
});
test("symbol offsets follow the unsaved document", () => {
  const f = markSymbol("\uFEFF// 😀\r\nlet ⟦value⟧=1;\nconsume(⟨value⟩);\r\n");
  let state = EditorState.create({
    doc: f.source,
    extensions: [EditorState.lineSeparator.of("\n"), supports.javascript],
  });
  const first = resolveLocal(state, "javascript", f.query.from + 1);
  assert.equal(first.kind, "resolved");
  assert.equal(first.targets[0].from, f.targets[0].from);
  state = state.update({ changes: { from: 0, insert: "// unsaved\n" } }).state;
  const next = resolveLocal(state, "javascript", f.query.from + 12);
  assert.equal(next.targets[0].from, f.targets[0].from + 11);
  assert.equal(
    next.targets[0].line,
    state.doc.lineAt(next.targets[0].from).number,
  );
});
test("incomplete new declaration is not a target", () =>
  checkSymbol("javascript", "let value=; consume(⟨value⟩);", "unavailable"));
test("damaged property is not replaced by foreign field", () =>
  checkSymbol(
    "typescript",
    "class A {value: =; read(){return this.⟨value⟩;}} class B {value=1;}",
    "unavailable",
  ));
test("TS private field outside owner is unavailable", () =>
  checkSymbol(
    "typescript",
    "class A {private value=1;} function f(obj){return obj.⟨value⟩;}",
    "unavailable",
  ));
test("TS private static cannot be selected from outside", () =>
  checkSymbol(
    "typescript",
    "class A {private static value=1;} consume(A.⟨value⟩);",
    "unavailable",
  ));
test("private field inside owner is available", () =>
  checkSymbol(
    "typescript",
    "class A {private ⟦value⟧=1; read(){return this.⟨value⟩;}}",
  ));
test("same-name nested owners are distinct", () =>
  checkSymbol(
    "javascript",
    "class A {value=1; f(){class A {⟦value⟧=2; f(){return this.⟨value⟩;}}}}",
  ));
test("unknown receiver does not collect locals", () =>
  checkSymbol(
    "javascript",
    "let value=1; class A{⟦value⟧=2;} obj.⟨value⟩;",
    "candidates",
  ));
test("write lhs navigates to binding", () =>
  checkSymbol("javascript", "let ⟦value⟧=1; ⟨value⟩=2;"));
test("Go redeclaration lhs is a reference to existing binding", () =>
  checkSymbol("go", "package p\nfunc f(){⟦x⟧:=1; ⟨x⟩,y:=2,3; consume(y)}"));
test("Python parser-unsupported tuple with binding refuses", () =>
  checkSymbol(
    "python",
    "with resource() as (left,right):\n consume(⟨left⟩)",
    "unavailable",
  ));
test("Python deleted except name cannot navigate outside handler", () =>
  checkSymbol(
    "python",
    "try:\n work()\nexcept Exception as error:\n pass\nconsume(⟨error⟩)",
    "unavailable",
  ));
test("Python property decorator can be shadowed", () =>
  checkSymbol(
    "python",
    "property=lambda fn:fn\nclass A:\n @property\n def value(self):\n  return 1\n def f(self):\n  return self.⟨value⟩",
    "unavailable",
  ));
test("Python receiver nested parameter not exact", () =>
  checkSymbol(
    "python",
    "class A:\n ⟦value⟧=1\n def f(self):\n  def inner(self):\n   return self.⟨value⟩",
    "candidates",
  ));
test("Kotlin private property outside owner", () =>
  checkSymbol(
    "kotlin",
    "class Box {private val value=1}\nfun f(obj:Any)=obj.⟨value⟩",
    "unavailable",
  ));
test("Kotlin nested type cannot assume outer field", () =>
  checkSymbol(
    "kotlin",
    "class A {val ⟦value⟧=1; class B {fun f()=⟨value⟩}}",
    "candidates",
  ));
test("Kotlin companion implicit constant", () =>
  checkSymbol(
    "kotlin",
    "class A {companion object {const val ⟦LIMIT⟧=1}; fun f()=⟨LIMIT⟩}",
  ));
test("Kotlin delegated property is not a guessed definition", () =>
  checkSymbol(
    "kotlin",
    "class A {val value by lazy {1}; fun f()=this.⟨value⟩}",
    "unavailable",
  ));
test("Swift optional binding is not visible in its else", () =>
  checkSymbol(
    "swift",
    "let ⟦value⟧=1\nfunc f(_ x:Int?)->Int{if let value=x{return value}else{return ⟨value⟩}}",
  ));
test("Swift optional initializer sees outer binding", () =>
  checkSymbol(
    "swift",
    "let ⟦value⟧: Int? = 1\nif let value=⟨value⟩{print(value)}",
  ));
test("Swift constructor parameter", () =>
  checkSymbol(
    "swift",
    "struct Box {var value:Int; init(⟦input⟧:Int){self.value=⟨input⟩}}",
  ));
test("Swift guard binding after guard", () =>
  checkSymbol(
    "swift",
    "func f(_ input:Int?)->Int{guard let ⟦value⟧=input else{return 0}; return ⟨value⟩}",
  ));
test("Swift private field outside owner", () =>
  checkSymbol(
    "swift",
    "struct Box {private var value=1}\nfunc f(_ obj:Box)->Int{return obj.⟨value⟩}",
    "unavailable",
  ));
test("Swift property wrapper not guessed", () =>
  checkSymbol(
    "swift",
    "struct Box {@Wrapped var value:Int; func f()->Int{return self.⟨value⟩}}",
    "unavailable",
  ));
test("mixed method and property candidates retain both", () =>
  checkSymbol(
    "javascript",
    "class A{⟦value⟧(){return 1}} class B{⟦value⟧=2} unknown.⟨value⟩();",
    "candidates",
  ));
test("known owner never takes another type's field", () =>
  checkSymbol(
    "typescript",
    "class A {read(){return this.⟨value⟩}} class B {value=1}",
    "unavailable",
  ));
test("Swift guard else does not see guarded binding", () =>
  checkSymbol(
    "swift",
    "let ⟦value⟧=1\nfunc f(_ input:Int?)->Int{guard let value=input else{return ⟨value⟩}; return value}",
  ));
test("TS private parameter property is accessible inside owner", () =>
  checkSymbol(
    "typescript",
    "class A{constructor(private ⟦value⟧:number){} read(){return this.⟨value⟩}}",
  ));
test("Kotlin private constructor property is hidden outside", () =>
  checkSymbol(
    "kotlin",
    "class A(private val value:Int)\nfun f(obj:A)=obj.⟨value⟩",
    "unavailable",
  ));
test("Swift incomplete optional type is not a target", () =>
  checkSymbol("swift", "let value:Int?=1\nprint(⟨value⟩)", "unavailable"));
test("Swift static method cannot assume instance field implicitly", () =>
  checkSymbol(
    "swift",
    "struct Box {var value=1; static func f()->Int{return ⟨value⟩}}",
    "unavailable",
  ));
test("known JS owner retains conflicting method and field", () =>
  checkSymbol(
    "javascript",
    "class A{⟦value⟧=1; ⟦value⟧(){} f(){return this.⟨value⟩}}",
    "candidates",
  ));
test("JS constructor field creation is not a lexical binding", () =>
  checkSymbol(
    "javascript",
    "const ⟦value⟧=0; class A {constructor(){this.value=1; consume(⟨value⟩)}}",
  ));
test("Python instance field creation is not a lexical binding", () =>
  checkSymbol(
    "python",
    "⟦value⟧=0\nclass A:\n def __init__(self):\n  self.value=1\n  consume(⟨value⟩)",
  ));
test("Python instance field cannot obscure a parameter", () =>
  checkSymbol(
    "python",
    "class A:\n def __init__(self,⟦value⟧):\n  self.value=1\n  consume(⟨value⟩)",
  ));

for (const size of [limits.characters, limits.characters + 1])
  test(`symbol document boundary ${size}`, () => {
    const base = "let value=1; value;",
      source = base + " ".repeat(size - base.length);
    const state = EditorState.create({
      doc: source,
      extensions: [supports.javascript],
    });
    ensureSyntaxTree(state, state.doc.length, 1000);
    const result = resolveLocal(
      state,
      "javascript",
      base.lastIndexOf("value") + 1,
    );
    assert.equal(
      result.kind,
      size === limits.characters ? "resolved" : "unavailable",
    );
    if (size > limits.characters) assert.equal(result.reason, "document-limit");
  });
for (const levels of [254, 255])
  test(`symbol depth boundary ${levels + 2}`, () => {
    const source =
      "let value=1;" + "(".repeat(levels) + "value" + ")".repeat(levels) + ";";
    const state = EditorState.create({
      doc: source,
      extensions: [supports.javascript],
    });
    const tree = ensureSyntaxTree(state, state.doc.length, 1000)!;
    let depth = 0,
      max = 0;
    tree.iterate({
      enter() {
        max = Math.max(max, depth++);
      },
      leave() {
        depth--;
      },
    });
    assert.equal(max, levels + 2);
    const result = resolveLocal(
      state,
      "javascript",
      source.lastIndexOf("value") + 1,
    );
    assert.equal(result.kind, max <= limits.depth ? "resolved" : "unavailable");
    if (max > limits.depth)
      assert.equal(result.reason, "index-budget-exceeded");
  });
for (const extra of [false, true])
  test(`symbol node boundary ${extra ? 30001 : 30000}`, () => {
    const source =
      "let value=1;" +
      "x;".repeat(9996) +
      ";;value;" +
      (extra ? "// tail" : "");
    const state = EditorState.create({
      doc: source,
      extensions: [supports.javascript],
    });
    const tree = ensureSyntaxTree(state, state.doc.length, 1000)!;
    let nodes = 0;
    tree.iterate({
      enter() {
        nodes++;
      },
    });
    assert.equal(nodes, extra ? 30001 : 30000);
    // Remove wall-clock variance to isolate the independent structural node bound.
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const result = resolveLocal(
        state,
        "javascript",
        source.lastIndexOf("value") + 1,
      );
      assert.equal(result.kind, extra ? "unavailable" : "resolved");
      if (extra) assert.equal(result.reason, "index-budget-exceeded");
    } finally {
      clock.mockRestore();
    }
  });
test("symbol index deadline refuses, edited document remains usable", () => {
  const source = "let value=1; value;",
    state = EditorState.create({
      doc: source,
      extensions: [supports.javascript],
    });
  ensureSyntaxTree(state, state.doc.length, 1000);
  let ticks = 0;
  const clock = vi
    .spyOn(performance, "now")
    .mockImplementation(() => ticks++ * 100);
  try {
    assert.equal(
      resolveLocal(state, "javascript", source.lastIndexOf("value") + 1).reason,
      "index-budget-exceeded",
    );
  } finally {
    clock.mockRestore();
  }
  const edited = state.update({ changes: { from: 0, insert: " " } }).state;
  assert.equal(
    resolveLocal(edited, "javascript", source.lastIndexOf("value") + 2).kind,
    "resolved",
  );
});
test("hidden private field never falls back to foreign method", () =>
  checkSymbol(
    "typescript",
    "class A{private static value=1} class B{value(){}} A.⟨value⟩;",
    "unavailable",
  ));
test("Kotlin companion field and method remain separate candidates", () =>
  checkSymbol(
    "kotlin",
    "class A{companion object{val ⟦value⟧=1; fun ⟦value⟧()=2}}\nfun f()=A.⟨value⟩()",
    "candidates",
  ));
test("many Kotlin companion owners do not mix their implicit members", () => {
  const source =
    Array.from(
      { length: 300 },
      (_, i) => `class C${i}{companion object{const val LIMIT=${i}}}`,
    ).join("\n") +
    "\nclass A{companion object{const val LIMIT=1};fun f()=LIMIT}";
  const state = EditorState.create({
    doc: source,
    extensions: [supports.kotlin],
  });
  assert(ensureSyntaxTree(state, state.doc.length, 1000));
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  try {
    const result = resolveLocal(
      state,
      "kotlin",
      source.lastIndexOf("LIMIT") + 1,
    );
    assert.equal(result.kind, "resolved");
    assert.equal(result.targets.length, 1);
    assert.equal(result.targets[0].from, source.lastIndexOf("LIMIT=1"));
  } finally {
    clock.mockRestore();
  }
});
for (const lang of ["javascript", "typescript"] as const)
  test(`${lang} default lambda parameters do not leak`, () =>
    checkSymbol(
      lang,
      "const ⟦inner⟧=1; function f(value=(inner)=>inner){return ⟨inner⟩;}",
    ));
test("Kotlin default lambda parameters do not leak", () =>
  checkSymbol(
    "kotlin",
    "val ⟦inner⟧=1\nfun f(value:(Int)->Int={inner->inner})=⟨inner⟩",
  ));
test("Swift default closure parameters do not leak", () =>
  checkSymbol(
    "swift",
    "let ⟦inner⟧=1\nfunc f(value:(Int)->Int = {inner in inner})->Int{return ⟨inner⟩}",
  ));
for (const lang of ["javascript", "typescript"] as const)
  test(`${lang} default destructuring lambda parameters do not leak`, () =>
    checkSymbol(
      lang,
      "const ⟦inner⟧=1; const {value=(inner)=>inner}=source; consume(⟨inner⟩);",
    ));
