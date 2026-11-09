import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import {
  loadOverviewLanguage,
  overviewHighlightStyle,
  resolveOverviewLanguage,
  resolveNavigationLanguage,
} from "../src/renderer/overview/languages";

const examples = [
  ["config.json", "JSON", '{"answer": 42}', "42"],
  ["config.jsonc", "JSONC", '{\n// note\n"answer": 42\n}', "// note"],
  ["layout.xml", "XML", '<widget name="hello"/>', "widget"],
  ["image.svg", "XML", '<svg><path d="M0 0"/></svg>', "svg"],
  ["index.html", "HTML", '<main class="hello">text</main>', "main"],
  ["style.css", "CSS", "body { color: red; }", "color"],
  ["style.scss", "SCSS", "$shade: red; body { color: $shade; }", "color"],
  ["config.yaml", "YAML", 'name: "hello"\n', "name"],
  ["src/CODEMANIFEST", "YAML", 'name: "hello"\n', "name"],
  ["config.toml", "TOML", 'name = "hello"\n', "hello"],
  ["config.ini", "Properties files", "[section]\nname=hello\n", "name"],
  ["query.sql", "SQL", "SELECT name FROM people;", "SELECT"],
  ["run.sh", "Shell", 'export NAME="hello"\n', "export"],
  ["Dockerfile", "Dockerfile", "FROM alpine\n", "FROM"],
  ["README.md", "Markdown", "# Heading\n\n**hello**\n", "Heading"],
  ["main.go", "Go", "package main\nfunc main() {}\n", "package"],
  ["main.js", "JavaScript", 'const name = "hello";', "const"],
  ["view.jsx", "JSX", "const view = <Widget/>;", "Widget"],
  ["main.ts", "TypeScript", "interface Person { name: string }", "interface"],
  ["view.tsx", "TSX", "const view: unknown = <Widget/>;", "Widget"],
  ["main.py", "Python", 'def hello():\n    return "hello"\n', "def"],
  ["Main.kt", "Kotlin", 'val name = "hello"\n', "val"],
  ["build.kts", "Kotlin", 'val name = "hello"\n', "val"],
  ["Main.swift", "Swift", 'let name = "hello"\n', "let"],
  ["lib.rs", "Rust", "pub fn hello() {}", "pub"],
] as const;

describe("overview ready-made languages", () => {
  it.each(examples)(
    "loads and really highlights %s as %s",
    async (path, name, source, token) => {
      expect(resolveOverviewLanguage(path)?.name).toBe(name);
      const support = await loadOverviewLanguage(path);
      expect(support).not.toBeNull();
      const state = EditorState.create({
        doc: source,
        extensions: [EditorState.lineSeparator.of("\n"), support!],
      });
      const tree = ensureSyntaxTree(state, source.length, 1000);
      expect(tree).not.toBeNull();
      const highlighted: string[] = [];
      highlightTree(tree!, overviewHighlightStyle, (from, to, classes) => {
        expect(classes).toMatch(/overview-/);
        highlighted.push(source.slice(from, to));
      });
      expect(highlighted.some((text) => text.includes(token))).toBe(true);
      expect(state.doc.toString()).toBe(source);
    },
  );

  it.each([
    ["nested/CODEMANIFEST", "YAML"],
    ["nested\\CODEMANIFEST", "YAML"],
    ["config.YML", "YAML"],
    [".bashrc", "Shell"],
    [".zshrc", "Shell"],
    ["run.zsh", "Shell"],
    ["Dockerfile.dev", "Dockerfile"],
    ["docker/Dockerfile", "Dockerfile"],
    ["main.mjs", "JavaScript"],
    ["main.cts", "TypeScript"],
  ])("matches filenames without inspecting content: %s", (path, name) => {
    expect(resolveOverviewLanguage(path)?.name).toBe(name);
  });

  it.each([
    "notes.unknown-format",
    "README",
    "CODEMANIFEST.txt",
    "config.yaml.txt",
  ])("leaves an unknown format as plain text: %s", async (path) => {
    expect(resolveOverviewLanguage(path)).toBeNull();
    expect(await loadOverviewLanguage(path)).toBeNull();
  });
});

describe("overview structural navigation grammars", () => {
  it.each([
    [
      "Main.kt",
      "fun greet() = 1\nfun use() = greet()",
      "FunctionDeclaration",
      "Call",
      "Identifier",
    ],
    [
      "build.kts",
      "fun greet() = 1\ngreet()",
      "FunctionDeclaration",
      "Call",
      "Identifier",
    ],
    [
      "Main.swift",
      "func greet() {}\ngreet()",
      "FunctionDeclaration",
      "CallExpression",
      "Identifier",
    ],
  ])(
    "loads structural nodes instead of legacy highlighting for %s",
    async (path, source, declaration, call, identifier) => {
      const support = await loadOverviewLanguage(path);
      expect(support).not.toBeNull();
      const state = EditorState.create({ doc: source, extensions: [support!] });
      const tree = ensureSyntaxTree(state, state.doc.length, 1000);
      expect(tree).not.toBeNull();
      const names: string[] = [];
      tree!.iterate({
        enter: (node) => {
          names.push(node.name);
        },
      });
      expect(names).toContain(declaration);
      expect(names).toContain(call);
      expect(names).toContain(identifier);
    },
  );

  it.each(["Main.kt", "BUILD.KTS", "Main.SWIFT"])(
    "keeps stable lazy descriptions and support for %s",
    async (path) => {
      expect(resolveOverviewLanguage(path)).toBe(resolveOverviewLanguage(path));
      expect(await loadOverviewLanguage(path)).toBe(
        await loadOverviewLanguage(path),
      );
    },
  );
});

describe("overview navigation language admission", () => {
  it.each([
    ["main.py", "python"],
    ["main.PY", "python"],
    ["main.js", "javascript"],
    ["main.mjs", "javascript"],
    ["main.cjs", "javascript"],
    ["main.ts", "typescript"],
    ["main.mts", "typescript"],
    ["main.cts", "typescript"],
    ["main.go", "go"],
    ["Main.kt", "kotlin"],
    ["BUILD.KTS", "kotlin"],
    ["nested\\Main.SWIFT", "swift"],
  ])("admits %s as %s", (path, language) => {
    expect(resolveNavigationLanguage(path)).toBe(language);
  });
  it.each([
    "view.jsx",
    "view.JSX",
    "view.tsx",
    "view.TSX",
    "main.rs",
    "config.json",
    "README",
    "main.kt.txt",
  ])("excludes %s from V1 navigation without changing highlighting", (path) => {
    expect(resolveNavigationLanguage(path)).toBeNull();
  });
});
