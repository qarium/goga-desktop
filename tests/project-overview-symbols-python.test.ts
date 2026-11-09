import { test } from "vitest";
import { checkSymbol } from "./helpers/overview-symbol-fixtures";
test("python: parameter remains declaration after write", () =>
  checkSymbol("python", "def f(⟦value⟧):\n value=2\n return ⟨value⟩"));
test("python: repeated bindings require choice", () =>
  checkSymbol(
    "python",
    "⟦value⟧=1\n⟦value⟧=2\nconsume(⟨value⟩)",
    "candidates",
  ));
test("python: conditional singleton still requires choice", () =>
  checkSymbol(
    "python",
    "if flag:\n ⟦value⟧=1\nconsume(⟨value⟩)",
    "candidates",
  ));
test("python: annotation-only declaration", () =>
  checkSymbol("python", "def f():\n ⟦value⟧:int\n return ⟨value⟩"));
test("python: function-wide local does not fall through", () =>
  checkSymbol("python", "value=1\ndef f():\n consume(⟨value⟩)\n ⟦value⟧=2"));
test("python: unpacked binding", () =>
  checkSymbol("python", "⟦left⟧,right=pair\nconsume(⟨left⟩)"));
test("python: instance receiver need not be named self", () =>
  checkSymbol(
    "python",
    "class Box:\n def __init__(me):\n  me.⟦value⟧=1\n def read(me):\n  return me.⟨value⟩",
  ));
test("python: repeated field assignments are candidates", () =>
  checkSymbol(
    "python",
    "class Box:\n def __init__(self):\n  self.⟦value⟧=1\n def change(self):\n  self.⟦value⟧=2\n def read(self):\n  return self.⟨value⟩",
    "candidates",
  ));
test("python: property pair has one declaration", () =>
  checkSymbol(
    "python",
    "class Box:\n @property\n def ⟦value⟧(self):\n  return 1\n @value.setter\n def value(self,new):\n  pass\n def read(self):\n  return self.⟨value⟩",
  ));
test("python: class lexical namespace does not leak into method", () =>
  checkSymbol(
    "python",
    "⟦value⟧=1\nclass Box:\n value=2\n def read(self):\n  return ⟨value⟩",
  ));
test("python: global directive is a barrier, not guessed target", () =>
  checkSymbol(
    "python",
    "value=1\ndef f():\n global value\n return ⟨value⟩",
    "unavailable",
  ));
test("python: loop conditional binding", () =>
  checkSymbol(
    "python",
    "for ⟦value⟧ in values:\n consume(⟨value⟩)",
    "candidates",
  ));
test("python: with binding", () =>
  checkSymbol(
    "python",
    "with resource() as ⟦value⟧:\n consume(⟨value⟩)",
    "candidates",
  ));
test("python: except binding", () =>
  checkSymbol(
    "python",
    "try:\n work()\nexcept Exception as ⟦error⟧:\n consume(⟨error⟩)",
    "candidates",
  ));
test("python: receiver reassignment loses exact owner", () =>
  checkSymbol(
    "python",
    "class A:\n def __init__(self):\n  self.⟦value⟧=1\n def read(self,other):\n  self=other\n  return self.⟨value⟩",
    "candidates",
  ));
test("python: staticmethod is not an instance receiver", () =>
  checkSymbol(
    "python",
    "class A:\n ⟦value⟧=1\n @staticmethod\n def read(self):\n  return self.⟨value⟩",
    "candidates",
  ));
test("python: imported receiver", () =>
  checkSymbol(
    "python",
    "import obj\nclass A:\n value=1\nconsume(obj.⟨value⟩)",
    "unavailable",
  ));
test("python: default value is not a parameter", () =>
  checkSymbol(
    "python",
    "⟦fallback⟧=1\ndef f(value=fallback):\n return ⟨fallback⟩",
  ));
test("python: class and instance declarations are ambiguous", () =>
  checkSymbol(
    "python",
    "class A:\n ⟦value⟧=0\n def __init__(self):\n  self.⟦value⟧=1\n def read(self):\n  return self.⟨value⟩",
    "candidates",
  ));
