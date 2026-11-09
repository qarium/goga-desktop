import { test } from "vitest";
import { checkSymbol } from "./helpers/overview-symbol-fixtures";
test("kotlin: const val", () =>
  checkSymbol("kotlin", "const val ⟦LIMIT⟧=3\nfun f()=⟨LIMIT⟩"));
test("kotlin: lexical value wins over field", () =>
  checkSymbol(
    "kotlin",
    "class Box(val value:Int){fun f(⟦value⟧:Int)=⟨value⟩}",
  ));
test("kotlin: primary constructor property", () =>
  checkSymbol("kotlin", "class Box(val ⟦value⟧:Int){fun f()=this.⟨value⟩}"));
test("kotlin: ordinary constructor parameter is not property", () =>
  checkSymbol(
    "kotlin",
    "class Box(value:Int){fun f()=this.⟨value⟩}",
    "unavailable",
  ));
test("kotlin: computed property targets its header", () =>
  checkSymbol(
    "kotlin",
    "class Box {val ⟦value⟧:Int get()=1\nfun f()=this.⟨value⟩}",
  ));
test("kotlin: implicit member after lexical lookup", () =>
  checkSymbol("kotlin", "class Box(val ⟦value⟧:Int){fun f()=⟨value⟩}"));
test("kotlin: destructuring", () =>
  checkSymbol(
    "kotlin",
    "fun f(pair:Pair<Int,Int>):Int{val (⟦left⟧,right)=pair; return ⟨left⟩}",
  ));
test("kotlin: setter parameter", () =>
  checkSymbol(
    "kotlin",
    "class Box {var value:Int=0\n set(⟦next⟧){field=⟨next⟩}\n}",
  ));
test("kotlin: implicit field cannot select an outer declaration", () =>
  checkSymbol(
    "kotlin",
    "val field=99\nclass Box {var value:Int=0\n get()=⟨field⟩\n}",
    "unavailable",
  ));
test("kotlin: companion property", () =>
  checkSymbol(
    "kotlin",
    "class Box {companion object {const val ⟦LIMIT⟧=3}}\nfun f()=Box.⟨LIMIT⟩",
  ));
test("kotlin: object property", () =>
  checkSymbol("kotlin", "object Box {val ⟦value⟧=3}\nfun f()=Box.⟨value⟩"));
test("kotlin: ordinary constructor parameter in initializer", () =>
  checkSymbol("kotlin", "class Box(⟦input⟧:Int){val value=⟨input⟩}"));
test("kotlin: constructor parameter cannot leak into method", () =>
  checkSymbol(
    "kotlin",
    "class Box(input:Int){fun f()=⟨input⟩}",
    "unavailable",
  ));
test("kotlin: receiver lambda not exact", () =>
  checkSymbol(
    "kotlin",
    "class Box(val ⟦value⟧:Int){fun f(other:Any)=with(other){this.⟨value⟩}}",
    "candidates",
  ));
test("kotlin: unknown implicit receiver not exact", () =>
  checkSymbol(
    "kotlin",
    "class Box(val ⟦value⟧:Int){fun f(other:Any)=with(other){⟨value⟩}}",
    "candidates",
  ));
test("kotlin: write targets declaration", () =>
  checkSymbol("kotlin", "fun f():Int{var ⟦value⟧=1; value=2; return ⟨value⟩}"));
test("kotlin: loop binding", () =>
  checkSymbol(
    "kotlin",
    "fun f(items:List<Int>){for(⟦item⟧ in items){consume(⟨item⟩)}}",
  ));
