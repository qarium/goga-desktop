import { test } from "vitest";
import { checkSymbol } from "./helpers/overview-symbol-fixtures";
test("swift: let binding", () =>
  checkSymbol("swift", "let ⟦limit⟧=3\nprint(⟨limit⟩)"));
test("swift: parameter not argument label", () =>
  checkSymbol("swift", "func f(label ⟦value⟧:Int)->Int{return ⟨value⟩}"));
test("swift: tuple binding", () =>
  checkSymbol("swift", "let (⟦left⟧,right)=(1,2)\nprint(⟨left⟩)"));
test("swift: optional binding scope", () =>
  checkSymbol(
    "swift",
    "func f(_ input:Int?)->Int{if let ⟦value⟧=input{return ⟨value⟩}; return 0}",
  ));
test("swift: optional binding does not leak", () =>
  checkSymbol(
    "swift",
    "func f(_ input:Int?)->Int{if let value=input{print(value)}; return ⟨value⟩}",
    "unavailable",
  ));
test("swift: self owns stored property", () =>
  checkSymbol(
    "swift",
    "struct Box {var ⟦value⟧:Int; func f()->Int{return self.⟨value⟩}}",
  ));
test("swift: computed property header", () =>
  checkSymbol(
    "swift",
    "struct Box {var ⟦value⟧:Int {return 1}; func f()->Int{return self.⟨value⟩}}",
  ));
test("swift: explicit setter parameter", () =>
  checkSymbol(
    "swift",
    "struct Box {var value:Int {get{return 1} set(⟦next⟧){print(⟨next⟩)}}}",
  ));
test("swift: implicit newValue is not outer binding", () =>
  checkSymbol(
    "swift",
    "let newValue=99\nstruct Box {var value:Int {get{return 1} set{print(⟨newValue⟩)}}}",
    "unavailable",
  ));
test("swift: static property", () =>
  checkSymbol(
    "swift",
    "struct Box {static let ⟦limit⟧=3}\nprint(Box.⟨limit⟩)",
  ));
test("swift: implicit property", () =>
  checkSymbol(
    "swift",
    "struct Box {var ⟦value⟧=1; func f()->Int{return ⟨value⟩}}",
  ));
test("swift: local shadows property", () =>
  checkSymbol(
    "swift",
    "struct Box {var value=1; func f(_ ⟦value⟧:Int)->Int{return ⟨value⟩}}",
  ));
test("swift: observer does not duplicate property", () =>
  checkSymbol(
    "swift",
    "class Box {var ⟦value⟧=1 {didSet{print(value)}}; func f()->Int{return self.⟨value⟩}}",
  ));
test("swift: observer implicit oldValue is not global", () =>
  checkSymbol(
    "swift",
    "let oldValue=99\nclass Box {var value=1 {didSet{print(⟨oldValue⟩)}}}",
    "unavailable",
  ));
test("swift: weak self capture is not exact", () =>
  checkSymbol(
    "swift",
    "class Box {var ⟦value⟧=1; func f(){let action={ [weak self] in print(self?.⟨value⟩) }; _=action}}",
    "candidates",
  ));
test("swift: loop binding", () =>
  checkSymbol(
    "swift",
    "func f(_ items:[Int]){for ⟦item⟧ in items{print(⟨item⟩)}}",
  ));
test("swift: write keeps variable declaration", () =>
  checkSymbol("swift", "var ⟦value⟧=1\nvalue=2\nprint(⟨value⟩)"));
