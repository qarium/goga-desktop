import assert from "node:assert/strict";
import { LRLanguage, type LanguageSupport } from "@codemirror/language";
import { loadOverviewLanguage } from "../../src/renderer/overview/languages";
import type {
  NavigationLanguage,
  NavigationResult,
} from "../../src/renderer/overview/navigation/types";

export const navigationPaths: Record<NavigationLanguage, string> = {
  python: "main.py",
  javascript: "main.js",
  typescript: "main.ts",
  go: "main.go",
  kotlin: "Main.kt",
  swift: "Main.swift",
};
type StructuralSupport = LanguageSupport & { language: LRLanguage };
export async function loadNavigationSupports(): Promise<
  Record<NavigationLanguage, StructuralSupport>
> {
  const entries = await Promise.all(
    Object.entries(navigationPaths).map(async ([language, path]) => {
      const support = await loadOverviewLanguage(path);
      assert.ok(support);
      assert.ok(support.language instanceof LRLanguage);
      return [language, support] as const;
    }),
  );
  // Every key above is loaded and checked through the product's lazy loader.
  return Object.fromEntries(entries) as Record<
    NavigationLanguage,
    StructuralSupport
  >;
}
interface NavigationFixture {
  id: string;
  label: string;
  tag: string;
  description: string;
  source: string;
  needle: string;
  expected: NavigationResult["kind"];
}
const exact = {
  python: `# Локальные переходы по текущему, несохранённому тексту\ndef format_title(name: str) -> str:\n    return f"Hello, {name}"\n\ndef render_card(name: str) -> str:\n    return format_title(name)\n\nmessage = render_card("Goga")\nprint(message)\n`,
  javascript: `// Локальные переходы по текущему, несохранённому тексту\nfunction formatTitle(name) {\n  return \`Hello, \${name}\`;\n}\n\nfunction renderCard(name) {\n  return formatTitle(name);\n}\n\nconst message = renderCard("Goga");\nconsole.log(message);\n`,
  typescript: `// Локальные переходы по текущему, несохранённому тексту\nfunction formatTitle(name: string): string {\n  return \`Hello, \${name}\`;\n}\n\nfunction renderCard(name: string): string {\n  return formatTitle(name);\n}\n\nconst message: string = renderCard("Goga");\nconsole.log(message);\n`,
  go: `package preview\n\n// Локальные переходы по текущему, несохранённому тексту\nfunc formatTitle(name string) string {\n    return "Hello, " + name\n}\n\nfunc renderCard(name string) string {\n    return formatTitle(name)\n}\n\nfunc preview() string {\n    return renderCard("Goga")\n}\n`,
  kotlin: `// Локальные переходы по текущему, несохранённому тексту\nfun formatTitle(name: String): String {\n    return "Hello, $name"\n}\n\nfun renderCard(name: String): String {\n    return formatTitle(name)\n}\n\nfun preview(): String {\n    return renderCard("Goga")\n}\n`,
  swift: `// Локальные переходы по текущему, несохранённому тексту\nfunc formatTitle(_ name: String) -> String {\n    return "Hello, " + name\n}\n\nfunc renderCard(_ name: String) -> String {\n    return formatTitle(name)\n}\n\nlet message = renderCard("Goga")\nprint(message)\n`,
};
const candidates = {
  python: `class TextCard:\n    def render(self, title: str) -> str:\n        return title\n\nclass IconCard:\n    def render(self, title: str) -> str:\n        return "• " + title\n\ndef preview(card):\n    # Тип card не выводится — покажем локальных кандидатов.\n    return card.render("Goga")\n`,
  javascript: `class TextCard {\n  render(title) { return title; }\n}\n\nclass IconCard {\n  render(title) { return "• " + title; }\n}\n\nfunction preview(card) {\n  // Тип card не выводится — покажем локальных кандидатов.\n  return card.render("Goga");\n}\n`,
  typescript: `interface Card { render(title: string): string; }\n\nclass TextCard implements Card {\n  render(title: string): string { return title; }\n}\n\nclass IconCard implements Card {\n  render(title: string): string { return "• " + title; }\n}\n\nfunction preview(card: Card): string {\n  // Интерфейс не доказывает, какая реализация будет вызвана.\n  return card.render("Goga");\n}\n`,
  go: `package preview\n\ntype TextCard struct {}\nfunc (card TextCard) render(title string) string {\n    return title\n}\n\ntype IconCard struct {}\nfunc (card IconCard) render(title string) string {\n    return "• " + title\n}\n\nfunc preview(card interface { render(string) string }) string {\n    return card.render("Goga")\n}\n`,
  kotlin: `interface Card { fun render(title: String): String }\n\nclass TextCard : Card {\n    override fun render(title: String): String { return title }\n}\n\nclass IconCard : Card {\n    override fun render(title: String): String { return "• " + title }\n}\n\nfun preview(card: Card): String {\n    return card.render("Goga")\n}\n`,
  swift: `protocol Card { func render(_ title: String) -> String }\n\nstruct TextCard: Card {\n    func render(_ title: String) -> String { return title }\n}\n\nstruct IconCard: Card {\n    func render(_ title: String) -> String { return "• " + title }\n}\n\nfunc preview(_ card: any Card) -> String {\n    return card.render("Goga")\n}\n`,
};
const shadow = {
  python: `def render() -> str:\n    return "outer"\n\ndef preview(render):\n    # Параметр скрывает внешнюю функцию.\n    # Её определение — неверная цель для этого вызова.\n    return render()\n`,
  javascript: `function render() { return "outer"; }\n\nfunction preview(render) {\n  // Параметр скрывает внешнюю функцию.\n  // Её определение — неверная цель для этого вызова.\n  return render();\n}\n`,
  typescript: `function render(): string { return "outer"; }\n\nfunction preview(render: () => string): string {\n  // Параметр скрывает внешнюю функцию.\n  // Её определение — неверная цель для этого вызова.\n  return render();\n}\n`,
  go: `package preview\n\nfunc render() string { return "outer" }\n\nfunc preview(render func() string) string {\n    // Параметр скрывает внешнюю функцию.\n    // Её определение — неверная цель для этого вызова.\n    return render()\n}\n`,
  kotlin: `fun render(): String { return "outer" }\n\nfun preview(render: () -> String): String {\n    // Параметр скрывает внешнюю функцию.\n    // Её определение — неверная цель для этого вызова.\n    return render()\n}\n`,
  swift: `func render() -> String { return "outer" }\n\nfunc preview(_ render: () -> String) -> String {\n    // Параметр скрывает внешнюю функцию.\n    // Её определение — неверная цель для этого вызова.\n    return render()\n}\n`,
};
const comment = {
  python: "#",
  javascript: "//",
  typescript: "//",
  go: "//",
  kotlin: "//",
  swift: "//",
};
const snippets = {
  python: "def item_0():\n    return 0\n",
  javascript: "function item_0() { return 0; }\n",
  typescript: "function item_0(): number { return 0; }\n",
  go: "func item_0() int { return 0 }\n",
  kotlin: "fun item_0(): Int { return 0 }\n",
  swift: "func item_0() -> Int { return 0 }\n",
};
export function getFixtures(language: NavigationLanguage): NavigationFixture[] {
  const snake = language === "python";
  const primary = snake ? "render_card" : "renderCard";
  const prefix = language === "go" ? "package preview\n\n" : "";
  const large =
    prefix +
    Array.from({ length: 1000 }, (_, i) =>
      snippets[language].replaceAll("item_0", `item_${i}`),
    ).join("\n") +
    (language === "go"
      ? "\nfunc preview() int { return item_999() }\n"
      : language === "python"
        ? "\nresult = item_999()\n"
        : language === "kotlin"
          ? "\nval result = item_999()\n"
          : language === "swift"
            ? "\nlet result = item_999()\n"
            : "\nconst result = item_999();\n");
  const items: NavigationFixture[] = [
    {
      id: "exact",
      label: "Прямой переход",
      tag: "01",
      description:
        "Перейдите из вызова в объявление функции. Затем вернитесь назад. Можно изменить код — навигация работает по тексту редактора.",
      source: exact[language],
      needle: `${primary}("Goga")`,
      expected: "resolved",
    },
    {
      id: "candidates",
      label: "Несколько кандидатов",
      tag: "02",
      description:
        "У методов одинаковое имя. Без вывода типов нельзя доказать, какой из них вызывается: выберите цель в списке.",
      source: candidates[language],
      needle: 'render("Goga")',
      expected: "candidates",
    },
    {
      id: "shadow",
      label: "Затенение имени",
      tag: "03",
      description:
        "Здесь render — параметр, а не внешняя функция. Навигация ведёт к объявлению параметра, не к его значению.",
      source: shadow[language],
      needle: "render()",
      expected: "resolved",
    },
    {
      id: "strings",
      label: "Комментарии и строки",
      tag: "04",
      description:
        "Имя в комментарии — обычный текст, а не вызов. Переход не должен появляться, даже если в файле есть такая функция.",
      source:
        exact[language] +
        `\n${comment[language]} ${primary}("Goga") — текст, не код\n`,
      needle: `${primary}("Goga")`,
      expected: "unavailable",
    },
    {
      id: "broken",
      label: "Недописанный код",
      tag: "05",
      description:
        "Незаконченная функция ниже не должна мешать переходу в корректном участке выше. В недостоверном фрагменте переход недоступен.",
      source:
        exact[language] +
        (language === "python"
          ? "\ndef unfinished(\n"
          : language === "go"
            ? "\nfunc unfinished(\n"
            : language === "kotlin"
              ? "\nfun unfinished(\n"
              : language === "swift"
                ? "\nfunc unfinished(\n"
                : "\nfunction unfinished(\n"),
      needle: `${primary}("Goga")`,
      expected: "resolved",
    },
    {
      id: "large",
      label: "Большой файл",
      tag: "06",
      description:
        "1000 локальных функций. Первый разбор и повторный переход измеряются отдельно. Ограничение времени анализа не блокирует редактирование.",
      source: large,
      needle: "item_999()",
      expected: "resolved",
    },
  ];
  if (language === "kotlin")
    items.push({
      id: "limit",
      label: "Ограничение Kotlin",
      tag: "!",
      description:
        "Грамматика пока не поддерживает when с guard. Прототип не обещает переход в недостоверно разобранном участке.",
      source:
        "fun positive(x: Int): Boolean { return x > 0 }\n\nfun choose(x: Any): Int = when (x) {\n    is Int if positive(x) -> x\n    else -> 0\n}\n",
      needle: "positive(x)",
      expected: "unavailable",
    });
  if (language === "swift")
    items.push({
      id: "limit",
      label: "Ограничение Swift",
      tag: "!",
      description:
        "В raw/extended строке этот парсер не выделяет вызов интерполяции. Текст редактируется, но переход внутри него недоступен.",
      source: String.raw`func render() -> String { return "Goga" }

let message = #"Value: \#(render())"#
`,
      needle: "render()",
      expected: "unavailable",
    });
  return items;
}
