import { test } from "vitest";
import { checkSymbol } from "./helpers/overview-symbol-fixtures";
test("ts: lexical shadow owns the name", () =>
  checkSymbol(
    "typescript",
    "const value=0; function f(⟦value⟧){return ⟨value⟩;}",
  ));
test("ts: write does not become a declaration", () =>
  checkSymbol("typescript", "let ⟦value⟧=1; value=2; consume(⟨value⟩);"));
test("ts: block shadow does not leak", () =>
  checkSymbol("typescript", "let ⟦value⟧=1; {let value=2;} consume(⟨value⟩);"));
test("ts: TDZ cannot fall through to outer name", () =>
  checkSymbol("typescript", "let value=1; {consume(⟨value⟩); let ⟦value⟧=2;}"));
test("ts: destructured alias is the binding", () =>
  checkSymbol(
    "typescript",
    "const {key:⟦local⟧,...rest}=source; consume(⟨local⟩);",
  ));
test("ts: instance field has the current owner", () =>
  checkSymbol(
    "typescript",
    "class A {⟦value⟧=1; read(){return this.⟨value⟩;}} class B {value=2;}",
  ));
test("ts: explicit field is not duplicated by constructor writes", () =>
  checkSymbol(
    "typescript",
    "class A {⟦value⟧=0; constructor(){this.value=1;} read(){return this.⟨value⟩;}}",
  ));
test("ts: constructor creation without declared field", () =>
  checkSymbol(
    "typescript",
    "class A {constructor(){this.⟦value⟧=1;} read(){return this.⟨value⟩;}}",
  ));
test("ts: repeated constructor creation is not guessed", () =>
  checkSymbol(
    "typescript",
    "class A {constructor(){this.⟦value⟧=1; this.⟦value⟧=2;} read(){return this.⟨value⟩;}}",
    "candidates",
  ));
test("ts: unknown receiver remains a choice", () =>
  checkSymbol(
    "typescript",
    "class A {⟦value⟧=1;} function f(obj){return obj.⟨value⟩;}",
    "candidates",
  ));
test("ts: arrow retains owner", () =>
  checkSymbol(
    "typescript",
    "class A {⟦value⟧=1; read(){return (()=>this.⟨value⟩)();}}",
  ));
test("ts: ordinary nested function does not retain owner", () =>
  checkSymbol(
    "typescript",
    "class A {⟦value⟧=1; read(){function inner(){return this.⟨value⟩;} return inner();}}",
    "candidates",
  ));
test("ts: imported receiver is not a local class", () =>
  checkSymbol(
    "typescript",
    "import obj from 'lib'; class A {value=1;} consume(obj.⟨value⟩);",
    "unavailable",
  ));
test("ts: getter and setter share a target", () =>
  checkSymbol(
    "typescript",
    "class A { get ⟦value⟧(){return 1;} set value(next){} read(){return this.⟨value⟩;} }",
  ));
test("ts: static member", () =>
  checkSymbol(
    "typescript",
    "class A { static ⟦value⟧=1; } consume(A.⟨value⟩);",
  ));
test("ts: static does not select instance member", () =>
  checkSymbol(
    "typescript",
    "class A {value=1; static read(){return this.⟨value⟩;}}",
    "unavailable",
  ));
test("ts: private field", () =>
  checkSymbol(
    "typescript",
    "class A {⟦#value⟧=1; read(){return this.⟨#value⟩;}}",
  ));
test("ts: loop binding", () =>
  checkSymbol("typescript", "for(const ⟦value⟧ of items){consume(⟨value⟩);}"));
test("ts: catch binding", () =>
  checkSymbol("typescript", "try {work();} catch(⟦error⟧){consume(⟨error⟩);}"));
test("ts: pattern key is not a reference", () =>
  checkSymbol(
    "typescript",
    "const key=1; const {⟨key⟩:local}=obj;",
    "unavailable",
  ));
test("ts: shorthand value reference", () =>
  checkSymbol("typescript", "const ⟦value⟧=1; consume({⟨value⟩});"));
test("ts: var is function scoped", () =>
  checkSymbol("typescript", "function f(){ {var ⟦value⟧=1;} return ⟨value⟩;}"));

test("ts: constructor property member", () =>
  checkSymbol(
    "typescript",
    "class Box {constructor(public ⟦value⟧:number){} read(){return this.⟨value⟩;}}",
  ));
test("ts: constructor property parameter", () =>
  checkSymbol(
    "typescript",
    "class Box {constructor(public ⟦value⟧:number){consume(⟨value⟩);}}",
  ));
test("ts: ordinary constructor parameter is not a member", () =>
  checkSymbol(
    "typescript",
    "class Box {constructor(value:number){} read(){return this.⟨value⟩;}}",
    "unavailable",
  ));
test("ts: local value and property keep separate roles", () =>
  checkSymbol(
    "typescript",
    "class Box {constructor(public value:number){} read(){let ⟦value⟧=2; return ⟨value⟩;}}",
  ));
test("ts: local cannot replace this property", () =>
  checkSymbol(
    "typescript",
    "class Box {constructor(public ⟦value⟧:number){} read(){let value=2; return this.⟨value⟩;}}",
  ));
test("ts: type reference is not variable navigation", () =>
  checkSymbol("typescript", "const Value=1; let item:⟨Value⟩;", "unavailable"));
test("ts: private field uses source token range", () =>
  checkSymbol(
    "typescript",
    "class Box {⟦#value⟧=1; read(){return this.⟨#value⟩;}}",
  ));
