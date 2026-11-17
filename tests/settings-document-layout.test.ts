// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const css = readFileSync("src/renderer/style.css", "utf8");
it("spaces the rename label, nested input and hint without doubling the action separator gap", () => {
  const sheet = document.createElement("style");
  sheet.textContent = css + readFileSync("src/renderer/ProjectDocumentExpansion.css", "utf8");
  const dialog = document.createElement("dialog");
  dialog.className = "task-reload-dialog document-rename-dialog";
  dialog.innerHTML = '<form><div class="document-rename-heading"><h2>Переименовать файл</h2><button type="button">×</button></div><label>Новое имя<span class="document-rename-name"><input value="generate"><code>.yml</code></span></label><p class="hint">Ссылки на прежнее имя нужно обновить вручную.</p><p class="error">Имя уже занято.</p><div class="form-actions"><button>Отмена</button><button>Переименовать</button></div></form>';
  document.head.append(sheet);
  document.body.append(dialog);
  const style = (s: string) => getComputedStyle(dialog.querySelector(s)!);
  try {
    expect(style("form").display).toBe("grid");
    expect(style("form").gap).toBe("16px");
    expect(style("label").display).toBe("grid");
    expect(style("label").gap).toBe("8px");
    expect(style(".hint").marginTop).toBe("0px");
    expect(style(".error").marginTop).toBe("0px");
    expect(style(".form-actions").marginTop).toBe("0px");
    expect(style(".document-rename-heading").marginBottom).toBe("0px");
    expect(style("input").minWidth).toBe("0");
    expect(style("code").flexShrink).toBe("0");
  } finally {
    dialog.remove();
    sheet.remove();
  }
});
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
};
it("wraps settings tabs rather than clipping their labels", () => {
  expect(rule(".section-tabs")).toMatch(/flex-wrap: wrap/);
});
it("allows document headings and long paths to shrink and wrap", () => {
  expect(rule(".editor-heading")).toMatch(/flex-wrap: wrap/);
  expect(rule(".editor-heading > div")).toMatch(/min-width: 0/);
  expect(rule(".context-path")).toMatch(/overflow-wrap: anywhere/);
});
it("keeps Tool Delete/Cancel/Save on one 412px row without changing shared settings action spacing", () => {
  expect(rule(".tool-files-detail .document-save-actions")).toMatch(
    /gap:\s*8px/,
  );
  expect(rule(".tool-files-detail .document-save-primary-actions")).toMatch(
    /gap:\s*12px/,
  );
  expect(rule(".document-save-actions")).toMatch(/gap:\s*16px 28px/);
  expect(rule(".document-save-primary-actions")).toMatch(/gap:\s*12px/);
});

it("reserves feedback width and preserves the leading icon when space is tight", () => {
  const css = readFileSync("src/renderer/ProjectDocumentExpansion.css", "utf8");
  const sheet = document.createElement("style");
  sheet.textContent = css;
  const badge = document.createElement("span");
  badge.className = "document-save-feedback";
  badge.innerHTML = "<svg></svg><span>Файл: есть изменения</span>";
  document.head.append(sheet);
  document.body.append(badge);
  try {
    const style = getComputedStyle(badge);
    expect(style.width).toBe("174px");
    expect(style.justifyContent).toBe("flex-end");
    expect(style.whiteSpace).toBe("nowrap");
    expect(style.height).toBe("20px");
    expect(getComputedStyle(badge.lastElementChild!).textOverflow).toBe(
      "ellipsis",
    );
    const icon = badge.firstElementChild!;
    expect(getComputedStyle(icon).flexShrink).toBe("0");
    expect(getComputedStyle(icon).width).toBe("13px");
    icon.outerHTML = '<span class="loading-spinner"></span>';
    expect(getComputedStyle(badge.firstElementChild!).width).toBe("13px");
  } finally {
    badge.remove();
    sheet.remove();
  }
});

it("does not repaint temporarily guarded actions, without disguising real unavailability", () => {
  const sheet = document.createElement("style");
  sheet.textContent = css;
  document.head.append(sheet);
  const button = document.createElement("button");
  document.body.append(button);
  const paint = () => {
    const { opacity, backgroundColor, borderColor, color } =
      getComputedStyle(button);
    return [opacity || "1", backgroundColor, borderColor, color];
  };
  try {
    for (const type of ["", "primary", "danger"]) {
      button.className = type;
      button.disabled = false;
      const before = paint();
      button.disabled = true;
      for (const marker of [
        "data-project-save-guard",
        "data-post-save-refresh",
      ]) {
        button.setAttribute(marker, "");
        expect(paint()).toEqual(before);
        button.removeAttribute(marker);
      }
      expect(paint()).not.toEqual(before);
    }
  } finally {
    button.remove();
    sheet.remove();
  }
});

it("only wraps the expanded document heading in narrow panes", () => {
  const css = readFileSync("src/renderer/ProjectDocumentExpansion.css", "utf8");
  expect(css).toMatch(
    /\.editor-heading\.project-document-heading\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/s,
  );
  expect(css).toMatch(
    /@container[^{}]+\{\s*\.project-document-expanded \.editor-heading\.project-document-heading\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
  );
});

it("shows distinct success and dirty colors, with neutral progress", () => {
  const css = readFileSync("src/renderer/ProjectDocumentExpansion.css", "utf8");
  expect(css).toMatch(
    /\.document-save-feedback\[data-tone="success"\]\s*\{[^}]*color:\s*#46d8bd/s,
  );
  expect(css).toMatch(
    /\.document-save-feedback[^{}]*\[data-tone="dirty"\][^{}]*\{[^}]*color:\s*#edbd79/s,
  );
  expect(css).toMatch(
    /\.document-save-feedback\s*\{[^}]*color:\s*var\(--muted\)/s,
  );
});

it("uses stable action rows in narrow panes regardless of the new-file deletion label", () => {
  const css = readFileSync("src/renderer/ProjectDocumentExpansion.css", "utf8");
  expect(css).toMatch(
    /@container[^]*\.document-save-actions:has\(> \.danger\)\s*\{[^}]*display:\s*grid/s,
  );
  expect(css).toMatch(
    /\.document-save-actions > \.document-save-primary-actions\s*\{[^}]*grid-row:\s*2/s,
  );
});

it("does not pin the ordinary project footer over a short editor or its header", () => {
  const css = readFileSync("src/renderer/ProjectDocumentExpansion.css", "utf8");
  expect(css).toMatch(
    /\.project-document-pane:not\(\.project-document-expanded\) \.document-editor-footer\s*\{[^}]*position:\s*static/s,
  );
});

it("matches the overview icon button and separates active feedback from the expanded header tools", () => {
  const sheet = document.createElement("style");
  sheet.textContent = [
    css,
    readFileSync("src/renderer/overview/overview.css", "utf8"),
    readFileSync("src/renderer/ProjectDocumentExpansion.css", "utf8"),
  ].join("\n");
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="project-overview"><button class="ov-icon"></button></div><div class="project-document-expanded"><div class="editor-heading project-document-heading"><div class="document-heading-tools"><span class="document-save-feedback">Файл: сохранен</span><small class="format">YAML</small><button class="document-size-toggle document-heading-icon"></button></div></div></div>';
  document.head.append(sheet);
  document.body.append(host);
  try {
    const style = (selector: string) =>
      getComputedStyle(host.querySelector(selector)!);
    const overview = style(".ov-icon"),
      expand = style(".document-size-toggle");
    for (const key of [
      "width",
      "height",
      "backgroundColor",
      "borderTopColor",
      "borderRadius",
      "color",
    ] as const)
      expect(expand[key], key).toBe(overview[key]);
    const group = style(".document-heading-tools");
    expect(group.display).toBe("flex");
    expect(group.alignItems).toBe("center");
    expect(group.justifySelf).toBe("end");
    expect(parseFloat(group.gap)).toBeGreaterThanOrEqual(10);
    expect(parseFloat(group.gap)).toBeLessThanOrEqual(12);
    expect(sheet.textContent).toMatch(
      /\.document-heading-tools > \.document-save-feedback\s*\{[^}]*border-right:\s*1px solid var\(--line\)/s,
    );
    expect(style(".format").paddingTop).toBe("0px");
  } finally {
    sheet.remove();
    host.remove();
  }
});

it("keeps the file status panel the same width for clean, editing, saving and saved states", () => {
  const sheet = document.createElement("style");
  sheet.textContent = readFileSync(
    "src/renderer/ProjectDocumentExpansion.css",
    "utf8",
  );
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="document-heading-tools"><span class="document-save-feedback"><span></span></span><small class="format">YAML</small></div>';
  document.head.append(sheet);
  document.body.append(host);
  try {
    const badge = host.querySelector<HTMLElement>(".document-save-feedback")!;
    for (const [tone, text] of [
      ["neutral", "Файл: нет изменений"],
      ["dirty", "Файл: есть изменения"],
      ["saving", "Сохраняем…"],
      ["success", "Файл: сохранен"],
    ]) {
      badge.dataset.tone = tone;
      badge.firstElementChild!.textContent = text;
      const css = getComputedStyle(badge);
      expect(css.display).toBe("inline-flex");
      expect(css.width).toBe("174px");
      // Reserve the panel, not a trailing hole: all labels end at its divider.
      expect(css.justifyContent).toBe("flex-end");
      expect(css.flexShrink).toBe("0");
      // jsdom does not resolve var() in border shorthands. The declared
      // divider is exercised with every real state in the Electron check.
      expect(sheet.textContent).toMatch(
        /\.document-heading-tools > \.document-save-feedback\s*\{[^}]*border-right:\s*1px solid var\(--line\)/s,
      );
    }
  } finally {
    host.remove();
    sheet.remove();
  }
});
