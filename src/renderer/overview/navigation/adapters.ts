import type {
  NavigationAdapter,
  NavigationLanguage,
  NavigationNode,
} from "./types";

// Structural adapters for the exact parser versions pinned in package-lock.json.
// These descriptors inspect syntax nodes, never declaration-shaped source text.
const js: NavigationAdapter = {
  functions: [
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunction",
    "MethodDeclaration",
  ],
  named: ["FunctionDeclaration", "MethodDeclaration"],
  classes: ["ClassDeclaration", "ClassExpression"],
  name: ["VariableDefinition", "PropertyDefinition"],
  className: ["VariableDefinition"],
  parameters: ["ParamList"],
  parameterNames: ["VariableDefinition"],
  bodies: ["Block"],
  lambdas: ["ArrowFunction", "FunctionExpression"],
  calls: ["CallExpression"],
  members: ["MemberExpression"],
  tokens: [
    "VariableName",
    "PropertyName",
    "VariableDefinition",
    "PropertyDefinition",
    "PrivatePropertyName",
    "PrivatePropertyDefinition",
  ],
  definitions: ["VariableDefinition"],
  blocks: [
    "Block",
    "ClassBody",
    "ForStatement",
    "ForInStatement",
    "ForOfStatement",
    "CatchClause",
  ],
  variables: ["VariableDeclaration"],
  assignment: [
    "AssignmentExpression",
    "UpdateExpression",
    "UnaryExpression",
    "PostfixExpression",
  ],
  imports: ["ImportDeclaration"],
};
export const adapters: Record<NavigationLanguage, NavigationAdapter> = {
  python: {
    functions: ["FunctionDefinition", "LambdaExpression"],
    named: ["FunctionDefinition"],
    classes: ["ClassDefinition"],
    name: ["VariableName"],
    className: ["VariableName"],
    parameters: ["ParamList"],
    parameterNames: ["VariableName"],
    bodies: ["Body"],
    lambdas: ["LambdaExpression"],
    calls: ["CallExpression"],
    members: ["MemberExpression"],
    tokens: ["VariableName", "PropertyName"],
    definitions: [],
    blocks: [
      "ArrayComprehensionExpression",
      "SetComprehensionExpression",
      "DictionaryComprehensionExpression",
      "ComprehensionExpression",
    ],
    variables: ["AssignStatement", "NamedExpression"],
    assignment: ["UpdateStatement"],
    imports: ["ImportStatement"],
  },
  javascript: js,
  typescript: js,
  go: {
    functions: ["FunctionDecl", "MethodDecl", "FunctionLiteral"],
    named: ["FunctionDecl", "MethodDecl"],
    classes: ["TypeSpec"],
    name: ["DefName", "FieldName"],
    className: ["DefName"],
    parameters: ["Parameters"],
    parameterNames: ["DefName"],
    bodies: ["Block"],
    lambdas: ["FunctionLiteral"],
    calls: ["CallExpr"],
    members: ["SelectorExpr"],
    tokens: ["VariableName", "FieldName", "DefName"],
    definitions: ["DefName"],
    blocks: [
      "Block",
      "ForStatement",
      "IfStatement",
      "SwitchStatement",
      "SelectStatement",
    ],
    variables: ["VarDecl", "VarSpec", "ConstDecl", "ConstSpec", "RangeClause"],
    assignment: ["Assignment"],
    imports: ["ImportDecl"],
  },
  kotlin: {
    functions: [
      "FunctionDeclaration",
      "Lambda",
      "AnonymousFunction",
      "Getter",
      "Setter",
    ],
    named: ["FunctionDeclaration"],
    classes: ["ClassDeclaration", "ObjectDeclaration", "CompanionObject"],
    name: ["Definition"],
    className: ["Definition"],
    parameters: [
      "FunctionParameters",
      "LambdaParameters",
      "AccessorParameters",
    ],
    parameterNames: ["Definition"],
    bodies: ["Block", "FunctionBody"],
    lambdas: ["Lambda", "AnonymousFunction"],
    calls: ["Call"],
    members: ["MemberAccess"],
    tokens: ["Identifier", "PropertyName", "Definition", "ConstantName"],
    definitions: ["Definition"],
    blocks: ["Block", "ClassBody", "ForStatement", "CatchBlock"],
    variables: ["PropertyDeclaration"],
    assignment: ["Assignment", "AssignmentExpression"],
    imports: ["ImportHeader"],
  },
  swift: {
    functions: [
      "FunctionDeclaration",
      "FunctionDeclarationNoBody",
      "InitializerDeclaration",
      "ClosureExpression",
    ],
    named: ["FunctionDeclaration", "FunctionDeclarationNoBody"],
    classes: [
      "ClassDeclaration",
      "StructDeclaration",
      "EnumDeclaration",
      "ActorDeclaration",
      "ProtocolDeclaration",
      "ExtensionDeclaration",
    ],
    name: ["FunctionName"],
    className: ["TypeDefinition", "TypeName"],
    parameters: ["ParameterClause", "ClosureSignature"],
    parameterNames: ["ParameterName", "ClosureParameter"],
    bodies: ["Block"],
    lambdas: ["ClosureExpression"],
    calls: ["CallExpression"],
    members: ["MemberExpression"],
    tokens: [
      "Identifier",
      "FunctionName",
      "PropertyName",
      "VariableDefinition",
    ],
    definitions: ["VariableDefinition"],
    blocks: [
      "Block",
      "MemberBlock",
      "ForStatement",
      "IfStatement",
      "WhileStatement",
      "CatchClause",
    ],
    variables: ["Binding"],
    assignment: ["BinaryExpression"],
    imports: ["ImportDeclaration"],
  },
};
export const conditionalNodes = new Set([
  "IfStatement",
  "IfExpression",
  "WhenExpression",
  "WhenEntry",
  "SwitchStatement",
  "SwitchCase",
  "TryStatement",
  "TryExpression",
  "CatchClause",
  "CatchBlock",
  "ForStatement",
  "WhileStatement",
  "RepeatWhileStatement",
  "ConditionalCompilationBlock",
  "ConditionalCompilation",
  "CompilerControl",
]);
export function child(
  node: Pick<NavigationNode, "children">,
  names: readonly string[],
): NavigationNode | undefined {
  return node.children.find((n) => names.includes(n.name));
}
export function descendants(
  node: NavigationNode,
  predicate: (node: NavigationNode) => boolean,
  stop: (node: NavigationNode) => boolean = () => false,
): NavigationNode[] {
  const found: NavigationNode[] = [],
    stack = [...node.children].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (predicate(n)) found.push(n);
    if (!stop(n))
      for (let i = n.children.length - 1; i >= 0; i--)
        stack.push(n.children[i]);
  }
  return found;
}
export function definitionToken(n: NavigationNode): NavigationNode;
export function definitionToken(
  n: NavigationNode | null | undefined,
): NavigationNode | null | undefined;
export function definitionToken(
  n: NavigationNode | null | undefined,
): NavigationNode | null | undefined {
  while (
    n?.children.length === 1 &&
    n.children[0].from === n.from &&
    n.children[0].to === n.to
  )
    n = n.children[0];
  return n;
}
