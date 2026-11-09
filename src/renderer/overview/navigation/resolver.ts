import {
  collectSymbols,
  functionNode,
  bindingEntries,
  memberEntries,
  implicitMemberUncertain,
  implicitAccessMismatch,
  constructorReferenceAllowed,
  implicitCompanionEntries,
} from "./symbols";
import type { EditorState, Text } from "@codemirror/state";
import type { Language } from "@codemirror/language";
import type { Tree } from "@lezer/common";
import type {
  NavigationBinding,
  NavigationLanguage,
  NavigationModel,
  NavigationNode,
  NavigationResult,
  NavigationScope,
} from "./types";

interface CacheEntry {
  model: NavigationModel | NavigationResult;
  snapshot: Tree;
}
import {
  ensureSyntaxTree,
  language,
  syntaxTree,
  syntaxTreeAvailable,
} from "@codemirror/language";
import { adapters } from "./adapters";

// Deliberately finite local analysis budgets; a refusal is preferable to blocking the editor.
export const limits = Object.freeze({
  characters: 250_000,
  nodes: 30_000,
  depth: 256,
  parseMs: 50,
  indexMs: 50,
  candidates: 100,
});
const cache = new WeakMap<EditorState, Map<NavigationLanguage, CacheEntry>>(),
  documents = new WeakMap<Text, Map<Language, CacheEntry>>();
const no = (
  reason: string,
  token?: { from: number; to: number },
): NavigationResult => ({
  kind: "unavailable",
  ...(token ? { token } : {}),
  targets: [],
  reason,
});
const key = (n: { name: string; from: number; to: number }) =>
  `${n.name}:${n.from}:${n.to}`;
const is = (
  n: NavigationNode | null | undefined,
  names: readonly string[],
): boolean => !!n && names.includes(n.name);
const text = (model: NavigationModel, n: NavigationNode) =>
  model.source.slice(n.from, n.to);
function build(
  state: EditorState,
  lang: NavigationLanguage,
): NavigationModel | NavigationResult {
  const adapter = adapters[lang];
  if (!adapter) return no("unsupported-language");
  if (state.facet(language)?.name !== lang)
    return no("parser-mismatch-or-missing");
  if (state.doc.length > limits.characters) return no("document-limit");
  const tree = ensureSyntaxTree(state, state.doc.length, limits.parseMs);
  if (!tree || tree.length !== state.doc.length)
    return no("parse-budget-exceeded");
  const started = performance.now(),
    nodes: NavigationNode[] = [],
    byKey = new Map<string, NavigationNode>(),
    stack: NavigationNode[] = [];
  let failed = false;
  const cursor = tree.cursor();
  let parent: NavigationNode | null = null,
    depth = 0;
  do {
    if (
      nodes.length >= limits.nodes ||
      depth > limits.depth ||
      performance.now() - started > limits.indexMs
    ) {
      failed = true;
      break;
    }
    const node: NavigationNode = {
      name: cursor.name,
      from: cursor.from,
      to: cursor.to,
      error: cursor.type.isError,
      hasError: cursor.type.isError,
      parent,
      children: [],
    }; // Scope metadata is assigned in the complete second pass below.
    if (parent) parent.children.push(node);
    nodes.push(node);
    byKey.set(key(node), node);
    if (cursor.firstChild()) {
      stack.push(node);
      parent = node;
      depth++;
      continue;
    }
    while (!cursor.nextSibling()) {
      if (!cursor.parent()) {
        parent = null;
        break;
      }
      stack.pop();
      parent = stack.at(-1) || null;
      depth--;
    }
  } while (
    parent ||
    cursor.from !== 0 ||
    (nodes.length === 1 && cursor.name !== nodes[0].name)
  );
  // Cursor end is detected by returning to the root; no recursive walk or unbounded recursion.
  if (failed) return no("index-budget-exceeded");
  const root = nodes[0],
    rootScope: NavigationScope = {
      kind: "root",
      node: root,
      parent: null,
      bindings: new Map(),
    };
  const model: NavigationModel = {
    state,
    lang,
    adapter,
    source: state.doc.toString(),
    tree,
    nodes,
    byKey,
    byName: new Map(),
    owners: new Map(),
    used: new Set(),
    collected: new Set(),
    rootScope,
    queries: new Map(),
  };
  if (!collectSymbols(model, started, limits.indexMs))
    return no("index-budget-exceeded");
  return model;
}

function bindingScopes(
  model: NavigationModel,
  scope: NavigationScope | null,
): NavigationScope[] {
  const scopes: NavigationScope[] = [];
  let insideFunction = false;
  while (scope) {
    const skip =
      ["python", "javascript", "typescript"].includes(model.lang) &&
      insideFunction &&
      (scope.kind === "class" || scope.node?.name === "ClassBody");
    if (!skip) scopes.push(scope);
    if (scope.kind === "function") insideFunction = true;
    scope = scope.parent;
  }
  return scopes;
}
function query(model: NavigationModel, position: number): NavigationResult {
  const syntax = model.tree.resolveInner(position, 1);
  let node = model.byKey.get(key(syntax));
  if (!node || !is(node, model.adapter.tokens))
    return no("not-a-supported-identifier");
  const token = { from: node.from, to: node.to };
  if (position < token.from || position >= token.to)
    return no("outside-identifier");
  // Wrapper identifiers (Swift) have identical ranges; climb only transparent token wrappers.
  let callee = node;
  while (
    callee.parent &&
    is(callee.parent, model.adapter.tokens) &&
    callee.parent.from === callee.from &&
    callee.parent.to === callee.to
  )
    callee = callee.parent;
  let member = false,
    callableReference = false;
  if (
    callee.parent &&
    is(callee.parent, model.adapter.members) &&
    callee === callee.parent.children.at(-1)
  ) {
    member = true;
    callee = callee.parent;
  } else if (
    model.lang === "kotlin" &&
    callee.parent?.name === "CallableReference" &&
    callee === callee.parent.children.at(-1)
  ) {
    callableReference = true;
    member = callee.parent.children[0].name !== "::";
    callee = callee.parent;
  }
  const expressions =
    model.lang === "python" ||
    ["javascript", "typescript", "go"].includes(model.lang)
      ? ["VariableName"]
      : model.lang === "kotlin"
        ? ["Identifier", "ConstantName"]
        : ["Identifier"];
  const shorthand =
    ["javascript", "typescript"].includes(model.lang) &&
    node.parent?.name === "Property" &&
    node.parent.children.length === 1 &&
    node.parent.parent?.name === "ObjectExpression";
  if (
    !member &&
    !callableReference &&
    !shorthand &&
    !(model.collected.has(key(node)) && !model.used.has(key(node))) &&
    !expressions.includes(node.name)
  )
    return no("not-an-expression-reference", token);
  if (model.used.has(key(node)))
    return no("binding-position-not-reference", token);
  if (
    node.parent?.name === "ArgumentLabel" ||
    (model.lang === "python" &&
      node.parent?.name === "ArgList" &&
      node.parent.children[node.parent.children.indexOf(node) + 1]?.name ===
        "AssignOp")
  )
    return no("argument-label-not-reference", token);
  let interpolation = false;
  for (let p: NavigationNode | null = node; p; p = p.parent) {
    if (p.error || (functionNode(p, model.adapter) && !p.validHeader))
      return no("untrustworthy-scope", token);
    if (is(p, model.adapter.calls) && p.hasError)
      return no("incomplete-call", token);
    if (
      is(p, model.adapter.imports) ||
      [
        "TypeDef",
        "TypeAnnotation",
        "TypeName",
        "TypeIdentifier",
        "TypeDefinition",
        "TypeReference",
        "GenericType",
        "FunctionType",
        "TypeParameterList",
        "PackageClause",
        "PackageHeader",
      ].includes(p.name)
    )
      return no("non-expression-position", token);
    if (
      ["javascript", "typescript"].includes(model.lang) &&
      p.name === "WithStatement"
    )
      return no("dynamic-with-scope", token);
    if (p.name === "ExtendedString") return no("opaque-raw-string", token);
    if (["Template", "Interpolation", "FormatReplacement"].includes(p.name))
      interpolation = true;
    if (
      ["String", "RawString", "FormatString", "TemplateString"].includes(
        p.name,
      ) &&
      !interpolation
    )
      return no("string-content", token);
    if (p.name === "WhenExpression" && p.hasError)
      return no("unsupported-syntax-region", token);
  }
  const name = text(model, node);
  let entries: NavigationBinding[] | undefined;
  if (member) {
    const lookup = memberEntries(model, node);
    if (lookup.blocked) return no("shadowed-or-dynamic-binding", token);
    entries = lookup.entries;
    if (lookup.exact) member = false;
    if (!entries.length)
      return no("unknown-receiver-no-local-candidates", token);
  } else {
    for (const scope of bindingScopes(model, node.scope!)) {
      if (scope.wildcardImport) return no("wildcard-import", token);
      const found = bindingEntries(scope.bindings.get(name), position);
      if (found?.length) {
        entries = found;
        break;
      }
    }
    if (!entries?.length) entries = implicitCompanionEntries(model, node);
    if (!entries?.length) return no("no-local-function-binding", token);
    if (entries.some((d) => !d.target))
      return no("shadowed-or-dynamic-binding", token);
    if (
      entries.some(
        (d) => "constructorParameter" in d && d.constructorParameter,
      ) &&
      !constructorReferenceAllowed(node)
    )
      return no("shadowed-or-dynamic-binding", token);
    if (implicitAccessMismatch(model, node, entries))
      return no("shadowed-or-dynamic-binding", token);
    if (
      entries.some(
        (d) => "kind" in d && ["field", "property"].includes(d.kind || ""),
      ) &&
      implicitMemberUncertain(model, node, entries)
    )
      member = true;
  }
  if (entries.some((d) => !d.target))
    return no("shadowed-or-dynamic-binding", token);
  if (entries.length > limits.candidates) return no("candidate-limit", token);
  const targets = entries.map((d) => d.target!).sort((a, b) => a.from - b.from);
  const ambiguous =
    member ||
    entries.length !== 1 ||
    entries.some(
      (d) =>
        d.conditional ||
        (d.method && d.kind !== "field" && d.kind !== "property"),
    );
  return {
    kind: ambiguous ? "candidates" : "resolved",
    token,
    targets,
    ...(ambiguous
      ? {
          reason: member
            ? "receiver-not-inferred"
            : "multiple-or-conditional-declarations",
        }
      : {}),
  };
}
/** Local syntax-only navigation. Input/output offsets are UTF-16 in this immutable EditorState. */
export function resolveLocal(
  state: EditorState,
  languageId: NavigationLanguage,
  position: number,
): NavigationResult {
  if (
    !Number.isInteger(position) ||
    position < 0 ||
    position >= state.doc.length
  )
    return no("invalid-position");
  const parser = state.facet(language);
  if (!adapters[languageId]) return no("unsupported-language");
  if (!parser || parser.name !== languageId)
    return no("parser-mismatch-or-missing");
  let languages = cache.get(state);
  if (!languages) {
    languages = new Map();
    cache.set(state, languages);
  }
  // Selection/hover-effect transactions preserve Text identity. Never rescan that document.
  let shared = documents.get(state.doc);
  if (!shared) {
    shared = new Map();
    documents.set(state.doc, shared);
  }
  let entry = shared.get(parser) || languages.get(languageId);
  // A failed parse is transient. Retry only after observable progress/completion, not every hover.
  const progressed =
    entry &&
    "kind" in entry.model &&
    entry.model.reason === "parse-budget-exceeded" &&
    (syntaxTreeAvailable(state, state.doc.length) ||
      syntaxTree(state) !== entry.snapshot);
  if (!entry || progressed) {
    entry = { model: build(state, languageId), snapshot: syntaxTree(state) };
    shared.set(parser, entry);
  }
  languages.set(languageId, entry);
  const model = entry.model;
  if ("kind" in model) return model;
  if (model.queries.has(position)) return model.queries.get(position)!;
  const result = query(model, position);
  // Bounded query memoization; the structural index remains per immutable state/language.
  if (model.queries.size < 2048) model.queries.set(position, result);
  return result;
}
