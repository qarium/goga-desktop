import { test } from "vitest";
import { checkSymbol } from "./helpers/overview-symbol-fixtures";
test("js: lexical shadow owns the name", () =>
  checkSymbol(
    "javascript",
    "const value=0; function f(⟦value⟧){return ⟨value⟩;}",
  ));
test("js: write does not become a declaration", () =>
  checkSymbol("javascript", "let ⟦value⟧=1; value=2; consume(⟨value⟩);"));
test("js: block shadow does not leak", () =>
  checkSymbol("javascript", "let ⟦value⟧=1; {let value=2;} consume(⟨value⟩);"));
test("js: TDZ cannot fall through to outer name", () =>
  checkSymbol("javascript", "let value=1; {consume(⟨value⟩); let ⟦value⟧=2;}"));
test("js: destructured alias is the binding", () =>
  checkSymbol(
    "javascript",
    "const {key:⟦local⟧,...rest}=source; consume(⟨local⟩);",
  ));
test("js: instance field has the current owner", () =>
  checkSymbol(
    "javascript",
    "class A {⟦value⟧=1; read(){return this.⟨value⟩;}} class B {value=2;}",
  ));
test("js: explicit field is not duplicated by constructor writes", () =>
  checkSymbol(
    "javascript",
    "class A {⟦value⟧=0; constructor(){this.value=1;} read(){return this.⟨value⟩;}}",
  ));
test("js: constructor creation without declared field", () =>
  checkSymbol(
    "javascript",
    "class A {constructor(){this.⟦value⟧=1;} read(){return this.⟨value⟩;}}",
  ));
test("js: repeated constructor creation is not guessed", () =>
  checkSymbol(
    "javascript",
    "class A {constructor(){this.⟦value⟧=1; this.⟦value⟧=2;} read(){return this.⟨value⟩;}}",
    "candidates",
  ));
test("js: unknown receiver remains a choice", () =>
  checkSymbol(
    "javascript",
    "class A {⟦value⟧=1;} function f(obj){return obj.⟨value⟩;}",
    "candidates",
  ));
test("js: arrow retains owner", () =>
  checkSymbol(
    "javascript",
    "class A {⟦value⟧=1; read(){return (()=>this.⟨value⟩)();}}",
  ));
test("js: ordinary nested function does not retain owner", () =>
  checkSymbol(
    "javascript",
    "class A {⟦value⟧=1; read(){function inner(){return this.⟨value⟩;} return inner();}}",
    "candidates",
  ));
test("js: imported receiver is not a local class", () =>
  checkSymbol(
    "javascript",
    "import obj from 'lib'; class A {value=1;} consume(obj.⟨value⟩);",
    "unavailable",
  ));
test("js: getter and setter share a target", () =>
  checkSymbol(
    "javascript",
    "class A { get ⟦value⟧(){return 1;} set value(next){} read(){return this.⟨value⟩;} }",
  ));
test("js: static member", () =>
  checkSymbol(
    "javascript",
    "class A { static ⟦value⟧=1; } consume(A.⟨value⟩);",
  ));
test("js: static does not select instance member", () =>
  checkSymbol(
    "javascript",
    "class A {value=1; static read(){return this.⟨value⟩;}}",
    "unavailable",
  ));
test("js: private field", () =>
  checkSymbol(
    "javascript",
    "class A {⟦#value⟧=1; read(){return this.⟨#value⟩;}}",
  ));
test("js: loop binding", () =>
  checkSymbol("javascript", "for(const ⟦value⟧ of items){consume(⟨value⟩);}"));
test("js: catch binding", () =>
  checkSymbol("javascript", "try {work();} catch(⟦error⟧){consume(⟨error⟩);}"));
test("js: pattern key is not a reference", () =>
  checkSymbol(
    "javascript",
    "const key=1; const {⟨key⟩:local}=obj;",
    "unavailable",
  ));
test("js: shorthand value reference", () =>
  checkSymbol("javascript", "const ⟦value⟧=1; consume({⟨value⟩});"));
test("js: var is function scoped", () =>
  checkSymbol("javascript", "function f(){ {var ⟦value⟧=1;} return ⟨value⟩;}"));
