import type { Tree } from "@lezer/common";
import type { EditorState, Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export type NavigationLanguage =
  "python" | "javascript" | "typescript" | "go" | "kotlin" | "swift";
export interface NavigationTarget {
  name: string;
  signature: string;
  owner?: string;
  from: number;
  to: number;
  line: number;
}
export interface NavigationResult {
  kind: "resolved" | "candidates" | "unavailable";
  token?: { from: number; to: number };
  targets: NavigationTarget[];
  reason?: string;
}
export interface NavigationPresentation {
  supported: boolean;
  ready: boolean;
  canBack: boolean;
  message: string;
}
export interface NavigationConfiguration {
  languageId?: NavigationLanguage | null;
  ready?: boolean;
  active?: boolean;
}
export interface NavigationController {
  extensions: Extension;
  go(view: EditorView): boolean;
  back(view: EditorView): boolean;
  close(view: EditorView): void;
  canBack(view: EditorView): boolean;
  configure(view: EditorView, configuration: NavigationConfiguration): void;
}
export type LocalResolver = (
  state: EditorState,
  language: NavigationLanguage,
  position: number,
) => NavigationResult;

// Internal index types. The structural walk precedes scope assignment; scope fields
// are populated for every node before binding collection or queries can run.
export interface NavigationNode {
  name: string;
  from: number;
  to: number;
  error: boolean;
  hasError: boolean;
  parent: NavigationNode | null;
  children: NavigationNode[];
  scope?: NavigationScope;
  outerScope?: NavigationScope;
  validHeader?: boolean;
}
export interface NavigationScope {
  kind?: "root" | "function" | "class" | "block";
  node: NavigationNode;
  parent: NavigationScope | null;
  bindings: Map<string, SymbolBinding>;
  wildcardImport?: boolean;
}
export type DeclarationKind =
  | "function"
  | "method"
  | "variable"
  | "constant"
  | "parameter"
  | "field"
  | "property";
export interface SymbolBinding {
  declarations: DeclaredBinding[];
  writes: DeclaredBinding[];
  barriers: NavigationBinding[];
}
export interface NavigationOwner {
  id: string;
  name: string;
  node: NavigationNode;
}
export interface BindingFlags {
  kind?: DeclarationKind;
  ownerId?: string;
  access?: "static" | "instance";
  privateName?: boolean;
  creation?: boolean;
  constructorParameter?: boolean;
  accessor?: "get" | "set";
  visibleFrom?: number;
  visibleTo?: number;
  expires?: boolean;
  owner?: string;
  method?: boolean;
  conditional?: boolean;
  broken?: boolean;
  parameter?: boolean;
  import?: boolean;
  assignment?: boolean;
}
export interface DeclaredBinding extends BindingFlags {
  name: string;
  node: NavigationNode;
  decl: NavigationNode;
  callable: boolean;
  scope: NavigationScope;
  target?: NavigationTarget;
}
export interface ImplicitParameterBinding {
  callable: false;
  implicitParameter: true;
  target?: never;
  conditional?: never;
  method?: never;
}
export type NavigationBinding = DeclaredBinding | ImplicitParameterBinding;
export interface NavigationAdapter {
  functions: string[];
  named: string[];
  classes: string[];
  name: string[];
  className: string[];
  parameters: string[];
  parameterNames: string[];
  bodies: string[];
  lambdas: string[];
  calls: string[];
  members: string[];
  tokens: string[];
  definitions: string[];
  blocks: string[];
  variables: string[];
  assignment: string[];
  imports: string[];
}

export interface NavigationModel {
  state: EditorState;
  lang: NavigationLanguage;
  adapter: NavigationAdapter;
  source: string;
  tree: Tree;
  nodes: NavigationNode[];
  byKey: Map<string, NavigationNode>;
  byName: Map<string, DeclaredBinding[]>;
  owners: Map<string, NavigationOwner>;
  used: Set<string>;
  collected: Set<string>;
  rootScope: NavigationScope;
  queries: Map<number, NavigationResult>;
}
