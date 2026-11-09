import {
  HighlightStyle,
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { NavigationLanguage } from "./navigation/types";
import { tags } from "@lezer/highlight";

// Descriptions contain local dynamic imports. Choosing a filename never reads
// source text or loads its grammar; LanguageDescription caches a requested mode.
const kotlin = LanguageDescription.of({
  name: "Kotlin",
  extensions: ["kt", "kts"],
  load: () =>
    import("@codincod/codemirror-lang-kotlin").then(({ kotlin }) => kotlin()),
});
const swift = LanguageDescription.of({
  name: "Swift",
  extensions: ["swift"],
  load: () =>
    import("@codincod/codemirror-lang-swift").then(({ swift }) => swift()),
});
// Stable descriptions override only the legacy Kotlin/Swift token streams.
const supportedLanguages = [
  kotlin,
  swift,
  ...languages.filter(
    (item) => item.name !== "Kotlin" && item.name !== "Swift",
  ),
];
const jsonc = LanguageDescription.of({
  name: "JSONC",
  extensions: ["jsonc"],
  // This ready-made JSON mode accepts comments, unlike the strict JSON grammar.
  load: () =>
    import("@codemirror/legacy-modes/mode/javascript").then(
      ({ json }) => new LanguageSupport(StreamLanguage.define(json)),
    ),
});
const languageNamed = (name: string) =>
  supportedLanguages.find((item) => item.name === name) ?? null;

export function resolveOverviewLanguage(
  path: string,
): LanguageDescription | null {
  const basename = path.split(/[\\/]/).at(-1) ?? "";
  if (basename === "CODEMANIFEST") return languageNamed("YAML");
  if (/^Dockerfile(?:\..+)?$/i.test(basename))
    return languageNamed("Dockerfile");
  if (
    /^(?:\.(?:bashrc|bash_profile|bash_login|profile|zshrc|zprofile|zshenv)|.+\.zsh)$/i.test(
      basename,
    )
  ) {
    return languageNamed("Shell");
  }
  return (
    LanguageDescription.matchFilename(
      [jsonc, ...supportedLanguages],
      basename,
    ) ??
    LanguageDescription.matchFilename(
      [jsonc, ...supportedLanguages],
      basename.toLowerCase(),
    )
  );
}

const navigationLanguages: Readonly<Record<string, NavigationLanguage>> = {
  Python: "python",
  JavaScript: "javascript",
  TypeScript: "typescript",
  Go: "go",
  Kotlin: "kotlin",
  Swift: "swift",
};

export function resolveNavigationLanguage(
  path: string,
): NavigationLanguage | null {
  const description = resolveOverviewLanguage(path);
  // JSX and TSX keep their existing highlighting, but are not V1 navigation modes.
  return description ? (navigationLanguages[description.name] ?? null) : null;
}

export async function loadOverviewLanguage(
  path: string,
): Promise<LanguageSupport | null> {
  return resolveOverviewLanguage(path)?.load() ?? null;
}

// Named classes keep semantic categories consistent between ready-made parsers
// and provide colors through the editor's existing ShadowRoot stylesheet host.
export const overviewHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, class: "overview-comment" },
  { tag: tags.keyword, class: "overview-keyword" },
  { tag: [tags.string, tags.content], class: "overview-string" },
  { tag: tags.number, class: "overview-number" },
  { tag: [tags.bool, tags.null, tags.atom], class: "overview-atom" },
  { tag: tags.regexp, class: "overview-regexp" },
  { tag: [tags.typeName, tags.className], class: "overview-type" },
  { tag: tags.variableName, class: "overview-variable" },
  { tag: [tags.propertyName, tags.attributeName], class: "overview-property" },
  { tag: tags.tagName, class: "overview-tag" },
  { tag: tags.function(tags.variableName), class: "overview-function" },
  { tag: [tags.operator, tags.punctuation], class: "overview-punctuation" },
  { tag: [tags.meta, tags.processingInstruction], class: "overview-meta" },
  { tag: tags.heading, class: "overview-heading" },
  { tag: tags.emphasis, class: "overview-emphasis" },
  { tag: tags.strong, class: "overview-strong" },
  { tag: [tags.link, tags.url], class: "overview-link" },
  { tag: tags.invalid, class: "overview-invalid" },
]);
