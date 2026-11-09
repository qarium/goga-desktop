import type {
  BindingFlags,
  DeclaredBinding,
  NavigationAdapter,
  NavigationModel,
  NavigationNode,
  NavigationScope,
  NavigationBinding,
  SymbolBinding,
} from "./types";
import {
  adapters,
  conditionalNodes,
  child,
  descendants,
  definitionToken,
} from "./adapters";
const key = (n: { name: string; from: number; to: number }) =>
  `${n.name}:${n.from}:${n.to}`;
const is = (
  n: NavigationNode | null | undefined,
  names: readonly string[],
): boolean => !!n && names.includes(n.name);
const text = (model: NavigationModel, n: NavigationNode) =>
  model.source.slice(n.from, n.to);
const objectMethod = (node: NavigationNode, adapter: NavigationAdapter) =>
  adapter === adapters.javascript &&
  node.name === "Property" &&
  !!child(node, ["ParamList"]) &&
  !!child(node, ["Block"]);
export const functionNode = (
  node: NavigationNode,
  adapter: NavigationAdapter,
) => is(node, adapter.functions) || objectMethod(node, adapter);
const bindingContainers = new Set([
  "ParenthesizedExpression",
  "ParenthesizedExpr",
  "TupleExpression",
  "ArrayExpression",
  "ArrayPattern",
  "ObjectPattern",
  "PatternProperty",
]);
function bindingTargets(
  node: NavigationNode | null | undefined,
  names: readonly string[],
): NavigationNode[] {
  if (!node) return [];
  if (names.includes(node.name)) return [node];
  if (!bindingContainers.has(node.name)) return [];
  return node.children.flatMap((child) => bindingTargets(child, names));
}

function nearest(
  scope: NavigationScope,
  kind: NavigationScope["kind"],
): NavigationScope {
  while (scope && scope.kind !== kind && scope.kind !== "root")
    scope = scope.parent!;
  return scope;
}
function ownerName(
  model: NavigationModel,
  node: NavigationNode,
): string | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (functionNode(p, model.adapter)) break;
    if (is(p, model.adapter.classes)) {
      const n = child(p, model.adapter.className);
      return n ? text(model, n) : p.name;
    }
    if (p.name === "ObjectExpression") {
      const name = child(p.parent || { children: [] }, ["VariableDefinition"]);
      return name ? text(model, name) : undefined;
    }
  }
  if (node.name === "MethodDecl") {
    const receiver = child(node, ["Parameters"]);
    return receiver ? text(model, receiver) : undefined;
  }
  return undefined;
}
function isConditional(node: NavigationNode, scope: NavigationScope): boolean {
  for (let p = node.parent; p && p !== scope.node; p = p.parent)
    if (conditionalNodes.has(p.name)) return true;
  // A declaration's immediate block may itself be a conditional branch.
  return conditionalNodes.has(scope.node?.parent?.name ?? "");
}
function add(
  model: NavigationModel,
  scope: NavigationScope,
  node: NavigationNode | null | undefined,
  decl: NavigationNode,
  callable = false,
  extra: BindingFlags = {},
): DeclaredBinding | undefined {
  node = definitionToken(node);
  if (
    !node ||
    node.from === node.to ||
    (model.lang === "go" && text(model, node) === "_")
  )
    return;
  const name = text(model, node),
    binding = scope.bindings.get(name) || {
      declarations: [],
      writes: [],
      barriers: [],
    };
  const entry: DeclaredBinding = {
    name,
    node,
    decl,
    callable,
    scope,
    kind: callable ? (extra.method ? "method" : "function") : undefined,
    ...extra,
  };
  // `this.x` / `self.x` create members, not lexical variables in the method.
  // They share the declaration index but must not shadow a local/outer `x`.
  if (!extra.creation) {
    if (callable || extra.kind) {
      binding.barriers = binding.barriers.filter(
        (b) =>
          !("node" in b && b.node.from === node.from && b.node.to === node.to),
      );
      binding.declarations.push(entry);
    } else if (extra.assignment) binding.writes.push(entry);
    else binding.barriers.push(entry);
    scope.bindings.set(name, binding);
  }
  model.collected.add(key(node));
  if (!extra.assignment) model.used.add(key(node));
  if (
    (callable || extra.kind) &&
    !extra.broken &&
    !(
      extra.kind &&
      !callable &&
      (extra.parameter ? !decl.validHeader && decl.hasError : decl.hasError)
    )
  ) {
    const body = child(decl, model.adapter.bodies);
    const end = Math.min(body?.from ?? decl.to, decl.from + 180);
    entry.target = {
      name,
      signature: model.source.slice(decl.from, end).trim() || name,
      ...(extra.owner ? { owner: extra.owner } : {}),
      from: node.from,
      to: node.to,
      line: model.state.doc.lineAt(node.from).number,
    };
  }
  if (callable || extra.kind) {
    const defs = model.byName.get(name) || [];
    defs.push(entry);
    model.byName.set(name, defs);
  }
  return entry;
}
function headerValid(node: NavigationNode, model: NavigationModel): boolean {
  const body = child(node, model.adapter.bodies);
  if (body)
    return (
      !node.children.some((n) => n !== body && n.hasError) &&
      !node.children.some((n) => n.error)
    );
  if (model.adapter.lambdas.includes(node.name)) return !node.hasError;
  // Explicit no-body declarations are valid candidates, not inferred implementations.
  return (
    !node.hasError &&
    (node.name === "FunctionDeclarationNoBody" ||
      node.children.some((n) => n.name === ";"))
  );
}
function parameterTokens(
  container: NavigationNode,
  model: NavigationModel,
): NavigationNode[] {
  const a = model.adapter;
  if (model.lang === "python") {
    const names: NavigationNode[] = [];
    let first = true;
    for (const item of container.children) {
      if (item.name === ",") first = true;
      else if (item.name === "AssignOp") first = false;
      else if (item.name === "VariableName" && first) {
        names.push(item);
        first = false;
      }
    }
    return names;
  }
  return descendants(
    container,
    (n) => a.parameterNames.includes(n.name),
    (n) =>
      [
        "TypeAnnotation",
        "TypeName",
        "FunctionType",
        "FunctionSignature",
        "TypeDef",
      ].includes(n.name) ||
      a.parameterNames.includes(n.name) ||
      functionNode(n, a),
  );
}
function variable(model: NavigationModel, node: NavigationNode): void {
  const a = model.adapter;
  let names: NavigationNode[] = [],
    rhs: NavigationNode | null | undefined;
  if (model.lang === "python") {
    const operators = node.children.filter((n) => n.name === "AssignOp");
    const last = operators.at(-1),
      left = last
        ? node.children.filter((n) => n.to <= last.from)
        : node.children.slice(0, 1);
    names = left.flatMap((n) => bindingTargets(n, ["VariableName"]));
    rhs =
      operators.length === 1
        ? node.children[node.children.indexOf(last!) + 1]
        : null;
  } else if (model.lang === "kotlin") {
    names = node.children.filter((n) => n.name === "Definition");
    const multi = child(node, ["MultiVariable"]);
    if (multi)
      names.push(...descendants(multi, (n) => n.name === "Definition"));
    const init = child(node, ["PropertyInit"]);
    rhs = init?.children[1];
  } else if (model.lang === "swift") {
    names = bindingTargets(node.children[0], [
      "VariableDefinition",
      "Identifier",
    ]);
    const eq = node.children.findIndex((n) => n.name === "AssignOp");
    rhs = node.children[eq + 1];
  } else if (model.lang === "go") {
    names = node.children.filter((n) => n.name === "DefName");
    const eq = node.children.findIndex((n) => [":=", "="].includes(n.name));
    rhs = node.children[eq + 1];
  } else {
    // Split direct declarators at grammar comma tokens (not textual commas in defaults).
    let segment: NavigationNode[] = [];
    for (const item of [...node.children, null]) {
      if (item && item.name !== ",") {
        segment.push(item);
        continue;
      }
      const ns = segment.flatMap((n) =>
        n.name === "VariableDefinition"
          ? [n]
          : ["ObjectPattern", "ArrayPattern"].includes(n.name)
            ? descendants(
                n,
                (c) => c.name === "VariableDefinition",
                (c) => functionNode(c, a),
              )
            : [],
      );
      const eq = segment.findIndex((n) => n.name === "Equals");
      const value = eq < 0 ? null : segment[eq + 1];
      for (const n of ns) addVariable(model, node, n, value, ns.length);
      segment = [];
    }
    return;
  }
  for (const n of names) addVariable(model, node, n, rhs, names.length);
}
function addVariable(
  model: NavigationModel,
  node: NavigationNode,
  name: NavigationNode,
  rhs: NavigationNode | null | undefined,
  count: number,
): void {
  let scope = node.scope!;
  if (
    ["javascript", "typescript"].includes(model.lang) &&
    node.children.some((n) => n.name === "var")
  )
    scope = nearest(scope, "function");
  const callable =
    count === 1 && !!rhs && is(rhs, model.adapter.lambdas) && !rhs.hasError;
  if (model.lang === "swift") {
    const declaration =
      node.parent?.name === "VariableDeclaration" ? node.parent : node;
    const owner =
      declaration.parent?.name === "MemberBlock"
        ? containingOwner(model, node)
        : undefined;
    const stat = declaration.children.some(
      (n) =>
        n.name === "Modifier" && ["static", "class"].includes(text(model, n)),
    );
    add(model, scope, name, node, callable, {
      kind: owner
        ? "field"
        : declaration.children.some((n) => n.name === "let")
          ? "constant"
          : "variable",
      privateName: privateModifier(model, declaration),
      broken: !!child(declaration, ["Attribute"]),
      ...(owner
        ? {
            ownerId: owner.id,
            owner: owner.name,
            access: stat ? ("static" as const) : ("instance" as const),
          }
        : {}),
    });
    return;
  }
  if (model.lang === "kotlin") {
    const owner =
      node.parent?.name === "ClassBody"
        ? containingOwner(model, node)
        : undefined;
    const stat =
      owner &&
      (owner.node.name === "ObjectDeclaration" ||
        owner.node.name === "CompanionObject");
    add(model, scope, name, node, callable, {
      kind: owner
        ? "field"
        : node.children.some((n) => n.name === "val")
          ? "constant"
          : "variable",
      privateName: privateModifier(model, node),
      broken: !!child(node, ["PropertyDelegate"]),
      ...(owner
        ? {
            ownerId: owner.id,
            owner: owner.name,
            access: stat ? ("static" as const) : ("instance" as const),
          }
        : {}),
    });
    return;
  }
  if (model.lang === "go") {
    const short = node.children.some((n) => n.name === ":="),
      rangeWrite = node.name === "RangeClause" && !short;
    let existing = scope.bindings.get(text(model, name));
    let existingScope = scope;
    if (
      !existing &&
      short &&
      scope.node.name === "Block" &&
      scope.parent?.kind === "function"
    ) {
      existing = scope.parent.bindings.get(text(model, name));
      if (existing?.declarations.some((d) => d.parameter))
        existingScope = scope.parent;
      else existing = undefined;
    }
    if (
      (short &&
        existing?.declarations.some(
          (d) => d.visibleFrom === undefined || d.visibleFrom <= node.from,
        )) ||
      rangeWrite
    ) {
      if (rangeWrite) {
        for (let p: NavigationScope | null = scope; p; p = p.parent)
          if (p.bindings.has(text(model, name))) {
            existingScope = p;
            break;
          }
      }
      add(model, existingScope, name, node, false, { assignment: true });
      return;
    }
    const constant = node.name === "ConstDecl" || node.name === "ConstSpec";
    add(model, scope, name, node, callable, {
      kind: constant ? "constant" : "variable",
      visibleFrom: scope.kind === "root" ? 0 : node.to,
    });
    return;
  }
  if (model.lang === "python") {
    if (
      scope.bindings
        .get(text(model, name))
        ?.declarations.some((d) => d.parameter)
    ) {
      add(model, scope, name, node, false, { assignment: true });
      return;
    }
    const owner =
      scope.kind === "class" ? model.owners.get(key(scope.node)) : undefined;
    add(model, scope, name, node, callable, {
      kind: owner ? "field" : "variable",
      conditional: isConditional(node, scope),
      ...(owner
        ? { owner: owner.name, ownerId: owner.id, access: "static" as const }
        : {}),
    });
    return;
  }
  add(model, scope, name, node, callable, {
    conditional: ["javascript", "typescript"].includes(model.lang)
      ? false
      : isConditional(node, scope),
    ...(["javascript", "typescript"].includes(model.lang)
      ? {
          kind: node.children.some((n) => n.name === "const")
            ? ("constant" as const)
            : ("variable" as const),
        }
      : {}),
  });
}
function imports(model: NavigationModel, node: NavigationNode): void {
  let names: NavigationNode[] = [];
  if (model.lang === "python") {
    // Import bindings are barriers; aliases/modules are never function targets.
    const i = node.children.findIndex((n) => n.name === "import");
    names = node.children.slice(i + 1).filter((n) => n.name === "VariableName");
  } else if (["javascript", "typescript"].includes(model.lang))
    names = descendants(node, (n) => n.name === "VariableDefinition");
  else if (model.lang === "go")
    names = descendants(node, (n) => n.name === "DefName");
  else if (model.lang === "kotlin")
    names =
      child(node, ["ImportAlias"])?.children.filter(
        (n) => n.name === "Definition",
      ) || node.children.filter((n) => n.name === "PackageName").slice(-1);
  else names = descendants(node, (n) => n.name === "Identifier");
  for (const n of names)
    add(model, node.scope!, n, node, false, { import: true });
  // Wildcard imports cannot be mapped to a stable local declaration without a project graph.
  if (descendants(node, (n) => n.name === "*").length)
    node.scope!.wildcardImport = true;
}
export function collectSymbols(
  model: NavigationModel,
  started: number,
  indexMs: number,
): boolean {
  const { nodes, rootScope, lang, adapter } = model;
  for (let i = nodes.length - 1; i > 0; i--) {
    if (performance.now() - started > indexMs) return false;
    if (nodes[i].hasError) nodes[i].parent!.hasError = true;
  }
  for (const node of nodes) {
    if (performance.now() - started > indexMs) return false;
    const outer = node.parent?.scope || rootScope;
    node.outerScope = outer;
    const kind = functionNode(node, adapter)
      ? "function"
      : is(node, adapter.classes)
        ? "class"
        : is(node, adapter.blocks)
          ? "block"
          : null;
    node.scope = kind
      ? { kind, node, parent: outer, bindings: new Map() }
      : outer;
    if (functionNode(node, adapter))
      node.validHeader = headerValid(node, model);
  }
  for (const node of nodes) {
    if (performance.now() - started > indexMs) return false;
    if (
      (is(node, adapter.named) &&
        !(
          ["javascript", "typescript"].includes(lang) &&
          node.name === "MethodDeclaration" &&
          child(node, ["get", "set"])
        )) ||
      objectMethod(node, adapter) ||
      node.name === "FunctionExpression"
    ) {
      const name = child(node, adapter.name),
        scope =
          node.name === "FunctionExpression"
            ? node.scope!
            : objectMethod(node, adapter)
              ? { node, parent: null, bindings: new Map() }
              : node.outerScope!;
      if (name) {
        const owner = ownerName(model, node),
          method =
            !!owner ||
            objectMethod(node, adapter) ||
            node.name === "MethodDeclaration" ||
            node.name === "MethodDecl" ||
            !!child(node, ["ExtensionReceiver"]);
        add(
          model,
          scope,
          name,
          node,
          !!node.validHeader && node.parent?.name !== "DecoratedStatement",
          {
            method,
            owner,
            ...(method && containingOwner(model, node)
              ? {
                  ownerId: containingOwner(model, node)!.id,
                  access:
                    (lang === "kotlin" &&
                      ["ObjectDeclaration", "CompanionObject"].includes(
                        containingOwner(model, node)!.node.name,
                      )) ||
                    node.children.some(
                      (n) =>
                        n.name === "static" ||
                        (n.name === "Modifier" &&
                          ["static", "class"].includes(text(model, n))),
                    )
                      ? ("static" as const)
                      : ("instance" as const),
                }
              : {}),
            conditional: isConditional(node, scope),
            broken: !node.validHeader,
          },
        );
      }
    }
    if (functionNode(node, adapter))
      for (const p of node.children.filter((n) => is(n, adapter.parameters)))
        for (const name of parameterTokens(p, model))
          add(model, node.scope!, name, node, false, {
            parameter: true,
            ...([
              "javascript",
              "typescript",
              "python",
              "go",
              "kotlin",
              "swift",
            ].includes(lang)
              ? { kind: "parameter" as const }
              : {}),
          });
    if (
      lang === "kotlin" &&
      node.name === "Lambda" &&
      !child(node, ["LambdaParameters", "->"])
    )
      node.scope!.bindings.set("it", {
        declarations: [],
        writes: [],
        barriers: [{ callable: false, implicitParameter: true }],
      });
    if (lang === "kotlin" && ["Getter", "Setter"].includes(node.name))
      node.scope!.bindings.set("field", {
        declarations: [],
        writes: [],
        barriers: [{ callable: false, implicitParameter: true }],
      });
    if (is(node, adapter.classes)) {
      const name = child(node, adapter.className);
      if (
        !name &&
        lang === "kotlin" &&
        ["ObjectDeclaration", "CompanionObject"].includes(node.name)
      )
        model.owners.set(key(node), { id: key(node), name: "Companion", node });
      if (name) {
        add(model, node.outerScope!, name, node, false);
        if (lang !== "go" || child(node, ["StructType"]))
          model.owners.set(key(node), {
            id: key(node),
            name: text(model, name),
            node,
          });
      }
    }
    if (is(node, adapter.variables)) variable(model, node);
    if (is(node, adapter.imports)) imports(model, node);
  }
  // All remaining explicit definition nodes are conservative barriers (loops, catch, types, destructuring).
  for (const node of nodes) {
    if (performance.now() - started > indexMs) return false;
    if (
      is(node, adapter.definitions) &&
      !model.collected.has(key(definitionToken(node)))
    ) {
      let typeOnly = false;
      for (let p = node.parent; p; p = p.parent) {
        if (
          [
            "PackageClause",
            "TypeAliasDeclaration",
            "TypeAnnotation",
            "FunctionSignature",
            "InterfaceDeclaration",
            "TypeParameterList",
            "TypeDef",
          ].includes(p.name)
        ) {
          typeOnly = true;
          break;
        }
        if (functionNode(p, adapter) || is(p, adapter.classes)) break;
      }
      if (!typeOnly)
        add(
          model,
          node.scope!,
          node,
          node,
          false,
          ["javascript", "typescript", "kotlin"].includes(lang) &&
            ["ForStatement", "CatchClause", "CatchBlock"].includes(
              node.scope!.node.name,
            )
            ? { kind: "variable" }
            : {},
        );
    }
    if (lang === "python") {
      if (["CapturePattern", "DeleteStatement"].includes(node.name))
        for (const item of node.children)
          for (const name of bindingTargets(item, ["VariableName"]))
            add(model, node.scope!, name, node, false);
      if (node.name === "ForStatement" || adapter.blocks.includes(node.name)) {
        for (let i = 0; i < node.children.length; i++)
          if (node.children[i].name === "for") {
            const end = node.children.findIndex(
              (n, j) => j > i && n.name === "in",
            );
            for (const item of node.children.slice(i + 1, end)) {
              const names = bindingTargets(item, ["VariableName"]);
              for (const name of names)
                add(model, node.scope!, name, node, false, {
                  kind: "variable",
                  conditional: true,
                });
            }
          }
      }
      if (["WithStatement", "TryStatement"].includes(node.name))
        for (let i = 1; i < node.children.length; i++) {
          if (node.children[i - 1].name !== "as") continue;
          const handler =
            node.name === "TryStatement"
              ? node.children.slice(i + 1).find((n) => n.name === "Body")
              : undefined;
          for (const name of bindingTargets(node.children[i], ["VariableName"]))
            add(model, node.scope!, name, node, false, {
              kind: "variable",
              conditional: true,
              ...(handler
                ? { visibleFrom: name.to, visibleTo: handler.to, expires: true }
                : {}),
            });
        }
      if (
        ["GlobalStatement", "NonlocalStatement", "ScopeStatement"].includes(
          node.name,
        )
      )
        for (const n of node.children.filter((n) => n.name === "VariableName"))
          add(model, node.scope!, n, node, false);
    }
    if (lang === "swift" && node.name === "BindingPattern") {
      const expression = child(node, ["BinaryExpression"]),
        name = expression?.children[0] || child(node, ["Identifier"]);
      if (name?.name === "Identifier") {
        const guard = node.parent?.name === "GuardStatement";
        add(model, node.scope!, name, node, false, {
          kind: "variable",
          visibleFrom: guard ? node.parent!.to : node.to,
          ...(!guard
            ? {
                visibleTo: child(node.parent || { children: [] }, ["Block"])
                  ?.to,
              }
            : {}),
        });
      }
    }
    if (lang === "swift" && node.name === "ForStatement") {
      const end = node.children.findIndex((n) => n.name === "in");
      for (const n of node.children
        .slice(0, end)
        .filter((n) => n.name === "Identifier"))
        add(model, node.scope!, n, node, false, {
          kind: "variable",
          visibleFrom: child(node, ["Block"])?.from,
        });
    }
  }
  // Reassignment is a barrier, never a data-flow analysis. Mark the nearest declared binding.
  for (const node of nodes) {
    if (performance.now() - started > indexMs) return false;
    if (!is(node, adapter.assignment)) continue;
    if (lang === "swift" && !node.children.some((n) => n.name === "AssignOp"))
      continue;
    let leftNodes = node.children.slice(0, 1);
    if (
      ["javascript", "typescript"].includes(lang) &&
      ["UnaryExpression", "PostfixExpression"].includes(node.name)
    ) {
      const operator = child(node, ["ArithOp"]);
      if (!operator || !["++", "--"].includes(text(model, operator))) continue;
      leftNodes = node.children.filter((n) => n !== operator);
    } else if (lang === "go") {
      const equals = node.children.findIndex((n) => n.name === "=");
      if (equals >= 0) leftNodes = node.children.slice(0, equals);
    }
    for (const left of leftNodes.flatMap((n) =>
      bindingTargets(n, adapter.tokens),
    )) {
      const name = text(model, left);
      let scope: NavigationScope | null = node.scope!;
      while (scope && !scope.bindings.has(name)) scope = scope.parent;
      add(model, scope || node.scope!, left, node, false, { assignment: true });
    }
  }
  const withinBudget = () => performance.now() - started <= indexMs;
  if (
    ["javascript", "typescript"].includes(lang) &&
    !collectJsMembers(model, withinBudget)
  )
    return false;
  if (lang === "python" && !collectPythonMembers(model, withinBudget))
    return false;
  if (lang === "go" && !collectGoMembers(model, withinBudget)) return false;
  if (lang === "kotlin" && !collectKotlinMembers(model, withinBudget))
    return false;
  if (lang === "swift" && !collectSwiftAccessors(model, withinBudget))
    return false;
  for (const defs of model.byName.values()) {
    if (performance.now() - started > indexMs) return false;
    defs.sort((a, b) => a.node.from - b.node.from);
  }
  return performance.now() - started <= indexMs;
}

export function bindingEntries(
  binding: SymbolBinding | undefined,
  position: number,
): NavigationBinding[] | undefined {
  if (!binding) return;
  const declarations = binding.declarations.filter(
    (d) =>
      (d.visibleFrom === undefined || position >= d.visibleFrom) &&
      (d.visibleTo === undefined || position <= d.visibleTo),
  );
  if (
    binding.declarations.some(
      (d) => d.expires && d.visibleTo !== undefined && position > d.visibleTo,
    )
  )
    return [{ callable: false, implicitParameter: true }];
  if (
    !declarations.length &&
    binding.declarations.length &&
    !binding.barriers.length
  )
    return;
  const writesMatter =
    !declarations.length ||
    declarations.some((d) => d.kind === "function" || d.kind === "method");
  const result = [
    ...declarations,
    ...binding.barriers,
    ...(writesMatter ? binding.writes : []),
  ];
  return result.length ? result : undefined;
}
function containingOwner(model: NavigationModel, node: NavigationNode) {
  for (let p: NavigationNode | null = node; p; p = p.parent) {
    const owner = model.owners.get(key(p));
    if (owner) return owner;
  }
}
function privateModifier(
  model: NavigationModel,
  node: NavigationNode,
): boolean {
  return node.children.some(
    (n) =>
      (["Privacy", "Modifier"].includes(n.name) &&
        text(model, n) === "private") ||
      (n.name === "Modifiers" &&
        descendants(n, (c) => c.name === "private").length > 0),
  );
}
function memberFlags(
  model: NavigationModel,
  node: NavigationNode,
  name: NavigationNode,
): BindingFlags {
  const owner = containingOwner(model, node);
  return {
    kind: "field",
    ownerId: owner?.id,
    owner: owner?.name,
    access: node.children.some((n) => n.name === "static")
      ? "static"
      : "instance",
    privateName:
      text(model, name).startsWith("#") || privateModifier(model, node),
  };
}
function collectJsMembers(
  model: NavigationModel,
  withinBudget: () => boolean,
): boolean {
  const creations: {
    node: NavigationNode;
    name: NavigationNode;
    ownerId: string;
    owner: string;
  }[] = [];
  for (const node of model.nodes) {
    if (!withinBudget()) return false;
    if (
      model.lang === "typescript" &&
      node.name === "MethodDeclaration" &&
      child(node, ["PropertyDefinition"]) &&
      text(model, child(node, ["PropertyDefinition"])!) === "constructor"
    ) {
      const parameters = child(node, ["ParamList"]),
        owner = containingOwner(model, node);
      let segment: NavigationNode[] = [];
      for (const item of [...(parameters?.children || []), null]) {
        if (item && ![",", ")"].includes(item.name)) {
          segment.push(item);
          continue;
        }
        const name = segment.find((n) =>
          ["VariableDefinition", "PropertyDefinition"].includes(n.name),
        );
        if (
          name &&
          owner &&
          segment.some((n) => ["Privacy", "readonly"].includes(n.name))
        ) {
          if (
            !node
              .scope!.bindings.get(text(model, name))
              ?.declarations.some((d) => d.node.from === name.from)
          )
            add(model, node.scope!, name, node, false, {
              kind: "parameter",
              parameter: true,
            });
          add(model, node.outerScope!, name, node, false, {
            kind: "field",
            owner: owner.name,
            ownerId: owner.id,
            access: "instance",
            privateName: segment.some(
              (n) => n.name === "Privacy" && text(model, n) === "private",
            ),
          });
        }
        segment = [];
      }
    }
    const name = child(node, [
      "PropertyDefinition",
      "PrivatePropertyDefinition",
    ]);
    if (
      name &&
      node.parent?.name === "ClassBody" &&
      (node.name === "PropertyDeclaration" || child(node, ["get", "set"]))
    ) {
      const flags = memberFlags(model, node, name);
      const accessor = child(node, ["get", "set"]);
      add(model, node.outerScope!, name, node, false, {
        ...flags,
        kind: accessor ? "property" : "field",
        ...(accessor ? { accessor: accessor.name as "get" | "set" } : {}),
      });
    }
    if (
      node.name !== "AssignmentExpression" ||
      node.children[1]?.name !== "Equals"
    )
      continue;
    const left = node.children[0];
    if (left?.name !== "MemberExpression" || left.children[0]?.name !== "this")
      continue;
    const field = left.children.at(-1);
    if (field?.name !== "PropertyName") continue;
    let fn = node.parent;
    while (fn && !functionNode(fn, model.adapter)) fn = fn.parent;
    if (
      fn?.name !== "MethodDeclaration" ||
      !child(fn, ["PropertyDefinition"]) ||
      text(model, child(fn, ["PropertyDefinition"])!) !== "constructor"
    )
      continue;
    const owner = containingOwner(model, fn);
    if (owner)
      creations.push({
        node,
        name: field,
        ownerId: owner.id,
        owner: owner.name,
      });
  }
  for (const item of creations) {
    if (!withinBudget()) return false;
    const exists = (model.byName.get(text(model, item.name)) || []).some(
      (d) => d.ownerId === item.ownerId && !d.creation,
    );
    if (exists) continue;
    add(model, item.node.scope!, item.name, item.node, false, {
      kind: "field",
      ownerId: item.ownerId,
      owner: item.owner,
      access: "instance",
      creation: true,
      conditional: isConditional(item.node, item.node.scope!),
    });
  }
  // A single accessor pair denotes one property, unlike duplicate independent getters.
  for (const list of model.byName.values()) {
    const setters = list.filter((d) => d.accessor === "set");
    for (const setter of setters) {
      if (!withinBudget()) return false;
      const peers = list.filter(
        (d) => d.ownerId === setter.ownerId && d.access === setter.access,
      );
      if (
        peers.filter((d) => d.accessor === "get").length === 1 &&
        peers.filter((d) => d.accessor === "set").length === 1
      ) {
        list.splice(list.indexOf(setter), 1);
        const b = setter.scope.bindings.get(setter.name)!;
        b.declarations = b.declarations.filter((d) => d !== setter);
      }
    }
  }
  return withinBudget();
}
export function memberEntries(
  model: NavigationModel,
  token: NavigationNode,
): { entries: DeclaredBinding[]; exact: boolean; blocked?: boolean } {
  const result = resolveMemberEntries(model, token),
    contextOwner = containingOwner(model, token);
  return {
    ...result,
    entries: result.entries.filter(
      (d) => !d.privateName || d.ownerId === contextOwner?.id,
    ),
  };
}
function resolveMemberEntries(
  model: NavigationModel,
  token: NavigationNode,
): { entries: DeclaredBinding[]; exact: boolean; blocked?: boolean } {
  const name = text(model, token),
    all = (model.byName.get(name) || []).filter(
      (d) => d.method || d.kind === "field" || d.kind === "property",
    );
  if (model.lang === "python") return pythonMemberEntries(model, token, all);
  if (model.lang === "go") return goMemberEntries(model, token, all);
  if (model.lang === "kotlin") return kotlinMemberEntries(model, token, all);
  if (model.lang === "swift") return swiftMemberEntries(model, token, all);
  if (!["javascript", "typescript"].includes(model.lang))
    return { entries: all.filter((d) => d.method), exact: false };
  const member = token.parent!,
    receiver = member.children[0];
  let ownerId: string | undefined,
    access: "static" | "instance" = "instance";
  if (receiver.name === "this") {
    for (let p = member.parent; p; p = p.parent) {
      if (["FunctionDeclaration", "FunctionExpression"].includes(p.name)) break;
      if (p.name === "MethodDeclaration" || p.name === "PropertyDeclaration") {
        ownerId = containingOwner(model, p)?.id;
        access = p.children.some((n) => n.name === "static")
          ? "static"
          : "instance";
        break;
      }
    }
  } else if (receiver.name === "VariableName") {
    const value = text(model, receiver);
    for (
      let scope: NavigationScope | null = receiver.scope!;
      scope;
      scope = scope.parent
    ) {
      const binding = scope.bindings.get(value);
      if (!binding) continue;
      if (binding.barriers.some((b) => "import" in b && b.import))
        return { entries: [], exact: false, blocked: true };
      const type =
        binding.barriers.length === 1 && "decl" in binding.barriers[0]
          ? model.owners.get(key(binding.barriers[0].decl))
          : undefined;
      if (type && !binding.declarations.length && !binding.writes.length) {
        ownerId = type.id;
        access = "static";
      }
      break;
    }
  }
  const fields = all.filter((d) => d.kind === "field" || d.kind === "property");
  if (ownerId && fields.length)
    return {
      entries: all.filter((d) => d.ownerId === ownerId && d.access === access),
      exact: true,
    };
  if (name.startsWith("#")) return { entries: [], exact: false, blocked: true };
  return { entries: all.filter((d) => !d.privateName), exact: false };
}

function lookupBinding(
  node: NavigationNode,
  name: string,
): SymbolBinding | undefined {
  for (
    let scope: NavigationScope | null = node.scope!;
    scope;
    scope = scope.parent
  ) {
    const found = scope.bindings.get(name);
    if (found) return found;
  }
}
function propertyAccessor(
  model: NavigationModel,
  fn: NavigationNode,
): "get" | "set" | undefined {
  if (fn.parent?.name !== "DecoratedStatement") return;
  const decorators = fn.parent.children.filter((n) => n.name === "Decorator");
  if (decorators.length !== 1) return;
  const tokens = decorators[0].children,
    name = child(fn, ["VariableName"]);
  if (tokens.length === 2 && text(model, tokens[1]) === "property") {
    if (lookupBinding(decorators[0], "property")) return;
    return "get";
  }
  if (
    tokens.length === 4 &&
    name &&
    text(model, tokens[1]) === text(model, name) &&
    tokens[2].name === "." &&
    text(model, tokens[3]) === "setter"
  )
    return "set";
}
function pythonReceiverOwner(model: NavigationModel, receiver: NavigationNode) {
  if (receiver.name !== "VariableName") return;
  const binding = lookupBinding(receiver, text(model, receiver));
  if (
    !binding ||
    binding.barriers.length ||
    binding.writes.length ||
    binding.declarations.length !== 1
  )
    return;
  const entry = binding.declarations[0],
    fn = entry.decl;
  if (!entry.parameter || fn.name !== "FunctionDefinition") return;
  const params = child(fn, ["ParamList"]);
  if (!params || parameterTokens(params, model)[0]?.from !== entry.node.from)
    return;
  const statement = fn.parent?.name === "DecoratedStatement" ? fn.parent : fn;
  if (
    statement.parent?.name !== "Body" ||
    statement.parent.parent?.name !== "ClassDefinition"
  )
    return;
  if (fn.parent?.name === "DecoratedStatement" && !propertyAccessor(model, fn))
    return;
  return model.owners.get(key(statement.parent.parent));
}
function collectPythonMembers(
  model: NavigationModel,
  withinBudget: () => boolean,
): boolean {
  for (const node of model.nodes) {
    if (!withinBudget()) return false;
    if (node.name === "FunctionDefinition") {
      const accessor = propertyAccessor(model, node),
        name = child(node, ["VariableName"]),
        owner = containingOwner(model, node);
      if (accessor && name && owner) {
        const binding = node.outerScope!.bindings.get(text(model, name));
        if (binding)
          binding.barriers = binding.barriers.filter(
            (b) => !("decl" in b && b.decl === node),
          );
        add(model, node.outerScope!, name, node, false, {
          kind: "property",
          ownerId: owner.id,
          owner: owner.name,
          access: "instance",
          accessor,
        });
      }
    }
    if (node.name !== "AssignStatement") continue;
    const eq = node.children.findIndex((n) => n.name === "AssignOp");
    for (const left of node.children.slice(0, eq)) {
      if (left.name !== "MemberExpression" || left.children[1]?.name !== ".")
        continue;
      const receiver = left.children[0],
        name = left.children.at(-1)!;
      if (name.name !== "PropertyName") continue;
      const owner = pythonReceiverOwner(model, receiver);
      if (owner)
        add(model, node.scope!, name, node, false, {
          kind: "field",
          ownerId: owner.id,
          owner: owner.name,
          access: "instance",
          creation: true,
          conditional: isConditional(node, node.scope!),
        });
    }
  }
  for (const entries of model.byName.values())
    for (const setter of [...entries].filter((d) => d.accessor === "set")) {
      if (!withinBudget()) return false;
      const peers = entries.filter((d) => d.ownerId === setter.ownerId);
      if (
        peers.filter((d) => d.accessor === "get").length === 1 &&
        peers.filter((d) => d.accessor === "set").length === 1
      ) {
        entries.splice(entries.indexOf(setter), 1);
        const binding = setter.scope.bindings.get(setter.name)!;
        binding.declarations = binding.declarations.filter((d) => d !== setter);
      }
    }
  return withinBudget();
}
function pythonMemberEntries(
  model: NavigationModel,
  token: NavigationNode,
  all: DeclaredBinding[],
) {
  const receiver = token.parent!.children[0];
  const binding =
    receiver.name === "VariableName"
      ? lookupBinding(receiver, text(model, receiver))
      : undefined;
  if (binding?.barriers.some((b) => "import" in b && b.import))
    return { entries: [], exact: false, blocked: true };
  const owner = pythonReceiverOwner(model, receiver);
  const fields = all.filter((d) => d.kind === "field" || d.kind === "property");
  if (owner && fields.length)
    return { entries: all.filter((d) => d.ownerId === owner.id), exact: true };
  const type =
    binding &&
    !binding.declarations.length &&
    !binding.writes.length &&
    binding.barriers.length === 1 &&
    "decl" in binding.barriers[0]
      ? model.owners.get(key(binding.barriers[0].decl))
      : undefined;
  if (type && fields.length)
    return {
      entries: all.filter(
        (d) => d.ownerId === type.id && d.access === "static",
      ),
      exact: true,
    };
  return { entries: all, exact: false };
}

function collectGoMembers(
  model: NavigationModel,
  withinBudget: () => boolean,
): boolean {
  for (const node of model.nodes) {
    if (!withinBudget()) return false;
    if (node.name !== "FieldDecl") continue;
    const owner = containingOwner(model, node);
    if (!owner || node.parent?.parent !== child(owner.node, ["StructType"]))
      continue;
    for (const name of node.children.filter((n) => n.name === "FieldName"))
      add(model, owner.node.scope!, name, node, false, {
        kind: "field",
        ownerId: owner.id,
        owner: owner.name,
        access: "instance",
      });
  }
  return withinBudget();
}
function goMemberEntries(
  model: NavigationModel,
  token: NavigationNode,
  all: DeclaredBinding[],
) {
  const receiver = token.parent!.children[0];
  if (receiver.name !== "VariableName") return { entries: all, exact: false };
  const binding = lookupBinding(receiver, text(model, receiver));
  if (binding?.barriers.some((b) => "import" in b && b.import))
    return { entries: [], exact: false, blocked: true };
  if (
    binding &&
    !binding.barriers.length &&
    !binding.writes.length &&
    binding.declarations.length === 1
  ) {
    const entry = binding.declarations[0],
      fn = entry.decl;
    if (entry.parameter && fn.name === "MethodDecl") {
      const params = child(fn, ["Parameters"]),
        param = params && child(params, ["Parameter"]);
      const name = param && child(param, ["DefName"]),
        type =
          param &&
          (child(param, ["TypeName"]) ||
            child(child(param, ["PointerType"]) || { children: [] }, [
              "TypeName",
            ]));
      if (
        name?.from === entry.node.from &&
        type &&
        type.children.length === 0
      ) {
        const typeBinding = lookupBinding(fn, text(model, type));
        const owner =
          typeBinding?.barriers.length === 1 &&
          "decl" in typeBinding.barriers[0]
            ? model.owners.get(key(typeBinding.barriers[0].decl))
            : undefined;
        if (owner && all.some((d) => d.kind === "field"))
          return {
            entries: all.filter((d) => d.ownerId === owner.id),
            exact: true,
          };
      }
    }
  }
  return { entries: all, exact: false };
}

function collectKotlinMembers(
  model: NavigationModel,
  withinBudget: () => boolean,
): boolean {
  for (const node of model.nodes) {
    if (!withinBudget()) return false;
    if (node.name !== "ClassParameter") continue;
    const name = child(node, ["Definition"]),
      owner = containingOwner(model, node);
    if (!name || !owner) continue;
    const property = !!child(node, ["val", "var"]);
    add(
      model,
      node.scope!,
      name,
      node,
      false,
      property
        ? {
            kind: "field",
            ownerId: owner.id,
            owner: owner.name,
            access: "instance",
            privateName: privateModifier(model, node),
          }
        : { kind: "parameter", parameter: true, constructorParameter: true },
    );
  }
  return withinBudget();
}
export function constructorReferenceAllowed(node: NavigationNode) {
  for (let p = node.parent; p; p = p.parent) {
    if (
      [
        "PropertyInit",
        "AnonymousInitializer",
        "InitBlock",
        "PrimaryConstructor",
      ].includes(p.name)
    )
      return true;
    if (
      [
        "FunctionDeclaration",
        "Getter",
        "Setter",
        "Lambda",
        "ClassBody",
      ].includes(p.name)
    )
      return false;
  }
  return false;
}
function kotlinContextOwner(model: NavigationModel, node: NavigationNode) {
  for (let p = node.parent; p; p = p.parent) {
    if (
      ["Lambda", "AnonymousFunction"].includes(p.name) ||
      child(p, ["ExtensionReceiver"])
    )
      return;
    const owner = model.owners.get(key(p));
    if (owner) return owner;
  }
}
function companionOf(
  model: NavigationModel,
  candidate: NavigationNode,
  ownerId: string,
): boolean {
  return (
    candidate.name === "ObjectDeclaration" &&
    !!child(candidate, ["Modifiers"]) &&
    descendants(child(candidate, ["Modifiers"])!, (n) => n.name === "companion")
      .length > 0 &&
    containingOwner(model, candidate.parent!)?.id === ownerId
  );
}
function companionMember(
  model: NavigationModel,
  memberOwnerId: string | undefined,
  ownerId: string,
): boolean {
  // Owner identity is already the map key: no all-owner scan per candidate.
  const candidate = memberOwnerId ? model.owners.get(memberOwnerId) : undefined;
  return !!candidate && companionOf(model, candidate.node, ownerId);
}
export function implicitCompanionEntries(
  model: NavigationModel,
  node: NavigationNode,
): DeclaredBinding[] {
  if (model.lang !== "kotlin") return [];
  const owner = kotlinContextOwner(model, node);
  if (!owner) return [];
  return (model.byName.get(text(model, node)) || []).filter(
    (d) =>
      d.access === "static" &&
      !!d.ownerId &&
      companionMember(model, d.ownerId, owner.id),
  );
}
export function implicitMemberUncertain(
  model: NavigationModel,
  node: NavigationNode,
  entries: NavigationBinding[],
) {
  if (!["kotlin", "swift"].includes(model.lang)) return false;
  const owner =
    model.lang === "kotlin"
      ? kotlinContextOwner(model, node)
      : swiftContextOwner(model, node);
  return (
    !owner ||
    entries.some(
      (d) =>
        "ownerId" in d &&
        d.ownerId !== owner.id &&
        !(
          model.lang === "kotlin" && companionMember(model, d.ownerId, owner.id)
        ),
    )
  );
}
function kotlinMemberEntries(
  model: NavigationModel,
  token: NavigationNode,
  all: DeclaredBinding[],
) {
  const receiver = token.parent!.children[0],
    fields = all.filter((d) => d.kind === "field" || d.kind === "property");
  if (receiver.name === "this") {
    const owner = kotlinContextOwner(model, token);
    if (owner && fields.length)
      return {
        entries: all.filter((d) => d.ownerId === owner.id),
        exact: true,
      };
  } else if (["Identifier", "TypeName"].includes(receiver.name)) {
    const binding = lookupBinding(receiver, text(model, receiver));
    if (binding?.barriers.some((b) => "import" in b && b.import))
      return { entries: [], exact: false, blocked: true };
    const owner =
      binding &&
      !binding.declarations.length &&
      !binding.writes.length &&
      binding.barriers.length === 1 &&
      "decl" in binding.barriers[0]
        ? model.owners.get(key(binding.barriers[0].decl))
        : undefined;
    if (owner && fields.length) {
      const allowed = new Set([owner.id]);
      for (const item of model.owners.values())
        if (
          item.node.name === "ObjectDeclaration" &&
          descendants(item.node, (n) => n.name === "companion").length &&
          containingOwner(model, item.node.parent!)?.id === owner.id
        )
          allowed.add(item.id);
      return {
        entries: all.filter(
          (d) => allowed.has(d.ownerId || "") && d.access === "static",
        ),
        exact: true,
      };
    }
  }
  return { entries: all, exact: false };
}

function swiftMemberAccess(
  model: NavigationModel,
  node: NavigationNode,
): "instance" | "static" {
  for (let p = node.parent; p; p = p.parent) {
    if (
      [
        "FunctionDeclaration",
        "VariableDeclaration",
        "InitializerDeclaration",
      ].includes(p.name)
    )
      return p.children.some(
        (n) =>
          n.name === "Modifier" && ["static", "class"].includes(text(model, n)),
      )
        ? "static"
        : "instance";
  }
  return "instance";
}
export function implicitAccessMismatch(
  model: NavigationModel,
  node: NavigationNode,
  entries: NavigationBinding[],
): boolean {
  if (model.lang !== "swift") return false;
  const owner = swiftContextOwner(model, node);
  return (
    !!owner &&
    entries.some(
      (d) =>
        "ownerId" in d &&
        d.ownerId === owner.id &&
        d.access !== swiftMemberAccess(model, node),
    )
  );
}
function swiftContextOwner(model: NavigationModel, node: NavigationNode) {
  for (let p = node.parent; p; p = p.parent) {
    if (
      p.name === "ClosureExpression" &&
      descendants(
        child(p, ["ClosureSignature"]) || { ...p, children: [] },
        (n) => n.name === "CaptureList",
      ).length
    )
      return;
    const owner = model.owners.get(key(p));
    if (owner)
      return owner.node.name === "ExtensionDeclaration" ? undefined : owner;
  }
}
function collectSwiftAccessors(
  model: NavigationModel,
  withinBudget: () => boolean,
): boolean {
  for (const node of model.nodes) {
    if (!withinBudget()) return false;
    if (node.name !== "Binding" || node.parent?.parent?.name !== "MemberBlock")
      continue;
    let body = child(node, ["Block"]);
    if (!body) {
      const expression = child(node, ["TrailingClosureExpression"]);
      body =
        expression &&
        child(child(expression, ["TrailingClosure"]) || { children: [] }, [
          "ClosureExpression",
        ]);
    }
    if (!body) continue;
    for (const statement of body.children) {
      const expr = child(statement, ["TrailingClosureExpression"]);
      if (!expr) continue;
      const prefix = expr.children[0],
        call = prefix.name === "CallExpression" ? prefix : undefined;
      const name = call ? call.children[0] : prefix;
      if (name.name !== "Identifier") continue;
      const label = text(model, name);
      if (!["get", "set", "didSet", "willSet"].includes(label)) continue;
      const closure = child(
        child(expr, ["TrailingClosure"]) || { children: [] },
        ["ClosureExpression"],
      );
      if (!closure) continue;
      model.used.add(key(name));
      model.collected.add(key(name));
      const argumentsNode = call && child(call, ["Arguments"]);
      const parameter = argumentsNode?.children.find(
        (n) => n.name === "Identifier",
      );
      if (parameter)
        add(model, closure.scope!, parameter, expr, false, {
          kind: "parameter",
          parameter: true,
        });
      else {
        const implicit =
          label === "didSet"
            ? "oldValue"
            : ["set", "willSet"].includes(label)
              ? "newValue"
              : undefined;
        if (implicit)
          closure.scope!.bindings.set(implicit, {
            declarations: [],
            writes: [],
            barriers: [{ callable: false, implicitParameter: true }],
          });
      }
    }
  }
  return withinBudget();
}
function swiftMemberEntries(
  model: NavigationModel,
  token: NavigationNode,
  all: DeclaredBinding[],
) {
  // PropertyName and Identifier have transparent identical ranges in this grammar.
  let member = token.parent;
  while (member && member.name !== "MemberExpression") member = member.parent;
  if (!member) return { entries: all, exact: false };
  const receiver = member.children[0],
    fields = all.filter((d) => d.kind === "field" || d.kind === "property");
  if (receiver.name === "SelfExpression") {
    const owner = swiftContextOwner(model, token);
    const access = swiftMemberAccess(model, token);
    if (owner && fields.length)
      return {
        entries: all.filter(
          (d) => d.ownerId === owner.id && d.access === access,
        ),
        exact: true,
      };
  } else if (receiver.name === "Identifier") {
    const binding = lookupBinding(receiver, text(model, receiver));
    if (binding?.barriers.some((b) => "import" in b && b.import))
      return { entries: [], exact: false, blocked: true };
    const owner =
      binding &&
      !binding.declarations.length &&
      !binding.writes.length &&
      binding.barriers.length === 1 &&
      "decl" in binding.barriers[0]
        ? model.owners.get(key(binding.barriers[0].decl))
        : undefined;
    if (owner && fields.length)
      return {
        entries: all.filter(
          (d) => d.ownerId === owner.id && d.access === "static",
        ),
        exact: true,
      };
  }
  return { entries: all, exact: false };
}
