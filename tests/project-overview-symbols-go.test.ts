import { test } from "vitest";
import { checkSymbol } from "./helpers/overview-symbol-fixtures";
test("go: const declaration", () =>
  checkSymbol("go", "package p\nconst ⟦Limit⟧=3\nfunc f()int{return ⟨Limit⟩}"));
test("go: mixed short declaration keeps existing x", () =>
  checkSymbol("go", "package p\nfunc f(){⟦x⟧:=1; x,y:=2,3; consume(⟨x⟩,y)}"));
test("go: mixed short declaration introduces y", () =>
  checkSymbol("go", "package p\nfunc f(){x:=1; x,⟦y⟧:=2,3; consume(x,⟨y⟩)}"));
test("go: initializer sees outer binding", () =>
  checkSymbol("go", "package p\nfunc f(){⟦x⟧:=1; {x:=⟨x⟩+1; consume(x)}}"));
test("go: nested binding shadows after initializer", () =>
  checkSymbol("go", "package p\nfunc f(){x:=1; {⟦x⟧:=x+1; consume(⟨x⟩)}}"));
test("go: named result", () =>
  checkSymbol(
    "go",
    "package p\nfunc f()(⟦result⟧ int){result=1; return ⟨result⟩}",
  ));
test("go: pointer receiver owns a direct field", () =>
  checkSymbol(
    "go",
    "package p\ntype Box struct{⟦Value⟧ int}\nfunc(b *Box) Read()int{return b.⟨Value⟩}",
  ));
test("go: typed parameter is not inferred receiver", () =>
  checkSymbol(
    "go",
    "package p\ntype Box struct{⟦Value⟧ int}\nfunc f(b Box)int{return b.⟨Value⟩}",
    "candidates",
  ));
test("go: blank identifier has no declaration", () =>
  checkSymbol(
    "go",
    "package p\nfunc f(){_,x:=1,2; consume(⟨_⟩,x)}",
    "unavailable",
  ));
test("go: const group implicit RHS", () =>
  checkSymbol("go", "package p\nconst (A=iota; ⟦B⟧)\nfunc f()int{return ⟨B⟩}"));
test("go: range declares locals", () =>
  checkSymbol(
    "go",
    "package p\nfunc f(items []int){for _,⟦value⟧:=range items{consume(⟨value⟩)}}",
  ));
test("go: range variables do not leak", () =>
  checkSymbol(
    "go",
    "package p\nfunc f(items []int){for _,value:=range items{}; consume(⟨value⟩)}",
    "unavailable",
  ));
test("go: parameter redeclaration", () =>
  checkSymbol("go", "package p\nfunc f(⟦x⟧ int){x,y:=1,2; consume(⟨x⟩,y)}"));
test("go: embedded field is not promoted exactly", () =>
  checkSymbol(
    "go",
    "package p\ntype Inner struct{Value int}\ntype Outer struct{Inner}\nfunc(o Outer) F()int{return o.⟨Value⟩}",
    "unavailable",
  ));
