import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../../src/", import.meta.url));
// Brand, CLI syntax and sample identifiers are intentionally the same in every language.
// Key these exceptions by their actual surface, not by a general word exemption.
const examples = {
  "App.tsx": ["Go", "ga", "DESKTOP", "© Goga 2026"],
  "AttachedPanels.tsx": ["dashboard:", "http://localhost:52456"],
  "DemoSettings.tsx": ["http://127.0.0.1:", "http://host.docker.internal:"],
  "GitDiscard.tsx": ["HEAD"],
  "GitMergeOperation.tsx": ["HEAD"],
  "GitRebaseOperation.tsx": ["HEAD", "rebase --"],
  "GitSequencerOperation.tsx": ["HEAD"],
  "LaunchForm.tsx": ["feature/export-report"],
  "ProjectCreation.tsx": ["https://example.com/team/project.git", "my-project"],
  "ProjectDocuments.tsx": [".goga/tools/"],
  "ProjectHistory.tsx": [".goga/history/"],
  "ProjectSettings.tsx": ["Goga"],
  "ProjectSpecifications.tsx": [".goga/usages/"],
  "TerminalPresetSettings.tsx": ["npm run dev", "PORT"],
  "TopicsWorkspace.tsx": ["feature/my-topic"],
  "WorkflowNameInput.tsx": [".yml"],
};

test("new Desktop captions and accessible labels go into the language packs", () => {
  const problems = [];
  for (const file of readdirSync(root, { recursive: true }).filter(
    (p) => /\.(tsx?|cjs|html)$/.test(p) && !p.endsWith(".generated.ts"),
  )) {
    const src = readFileSync(join(root, file), "utf8");
    if (/\p{Script=Cyrillic}/u.test(src))
      problems.push(file + ": inline Cyrillic text");
    if (!file.endsWith(".tsx")) continue;
    const ast = ts.createSourceFile(
      file,
      src,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const allowed = examples[file.replace(/^renderer\//, "")] ?? [];
    function visit(node) {
      const value = ts.isJsxText(node)
        ? node.text.trim()
        : ts.isJsxAttribute(node) &&
            [
              "aria-label",
              "placeholder",
              "title",
              "label",
              "alt",
              "description",
            ].includes(node.name.getText(ast)) &&
            node.initializer &&
            ts.isStringLiteral(node.initializer)
          ? node.initializer.text
          : "";
      if (/[a-z]{2}/i.test(value) && !allowed.includes(value))
        problems.push(file + ": " + value);
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  assert.deepEqual(problems, []);
});

test("Desktop messages are formatted after the language is loaded", () => {
  const problems = [];
  for (const file of readdirSync(root, { recursive: true }).filter(
    (file) => /\.tsx?$/.test(file) && !file.endsWith(".generated.ts"),
  )) {
    const source = ts.createSourceFile(
      file,
      readFileSync(join(root, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const names = new Set();
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text.endsWith("/i18n")
      ) {
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          for (const entry of bindings.elements)
            if ((entry.propertyName ?? entry.name).text === "t")
              names.add(entry.name.text);
      }
    }
    if (!names.size) continue;
    function visit(node) {
      if (ts.isFunctionLike(node)) return;
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        names.has(node.expression.text)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        problems.push(file + ":" + (line + 1));
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(problems, [], "Keep message keys at module scope; format on use");
});
