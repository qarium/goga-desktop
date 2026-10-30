// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ContractPane } from "../src/renderer/overview/ContractPane";
import type { CellContract } from "../src/shared/project-architecture";

afterEach(cleanup);

function showContract(data: CellContract) {
  return render(
    <ContractPane
      cell={{
        cell: "src/example",
        description: "",
        types: ["Example"],
        usages: [],
        dependencies: {},
        children: [],
      }}
      data={data}
      busy={false}
      error=""
      onRetry={vi.fn()}
      onClose={vi.fn()}
      onGo={vi.fn()}
      onSource={vi.fn()}
      onBack={vi.fn()}
      onForward={vi.fn()}
      canBack={false}
      canForward={false}
      navigable={() => false}
    />,
  );
}

it("shows properties and methods as separately named groups at the same time with headings, icons and counts", () => {
  showContract({
    Example: {
      properties: {
        title: { codemanifest: "string", implementation: "string" },
        size: { codemanifest: "number", implementation: "number" },
      },
      methods: {
        execute: { codemanifest: "() -> void", implementation: "() => void" },
      },
    },
  });

  const properties = screen.getByRole("group", { name: "Свойства" });
  const methods = screen.getByRole("group", { name: "Методы" });
  for (const [group, label, count] of [
    [properties, "Свойства", "2"],
    [methods, "Методы", "1"],
  ] as const) {
    const heading = within(group).getByRole("heading", {
      name: `${label} ${count}`,
    });
    expect(heading.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(within(heading).getByText(count)).not.toBeNull();
    expect(group.closest("[hidden], details:not([open])")).toBeNull();
  }
  expect(within(properties).getByText("title")).not.toBeNull();
  expect(within(properties).getByText("size")).not.toBeNull();
  expect(within(properties).queryByText("execute")).toBeNull();
  expect(within(methods).getByText("execute")).not.toBeNull();
  expect(within(methods).queryByText("title")).toBeNull();
  expect(screen.queryByRole("tab")).toBeNull();
});

it.each([
  ["empty JSON groups", { properties: {}, methods: {} }],
  ["only the empty properties key", { properties: {} }],
  ["only the empty methods key", { methods: {} }],
])(
  "keeps both %s visible with zero counters and explicit empty states",
  (_, details) => {
    showContract({ Example: details });
    const properties = screen.getByRole("group", { name: "Свойства" });
    const methods = screen.getByRole("group", { name: "Методы" });
    expect(
      within(properties).getByRole("heading", { name: "Свойства 0" }),
    ).not.toBeNull();
    expect(within(properties).getByText("Нет свойств.")).not.toBeNull();
    expect(
      within(methods).getByRole("heading", { name: "Методы 0" }),
    ).not.toBeNull();
    expect(within(methods).getByText("Нет методов.")).not.toBeNull();
  },
);

it.each([
  ["absent JSON groups", {}],
  [
    "a signature-only routine",
    {
      signature: {
        codemanifest:
          "properties:\n  title: string\nmethods:\n  execute(): void",
        implementation: null,
      },
    },
  ],
])("does not add member groups for %s", (_, details) => {
  const { container } = showContract({ Example: details });
  expect(screen.queryByRole("group", { name: "Свойства" })).toBeNull();
  expect(screen.queryByRole("group", { name: "Методы" })).toBeNull();
  expect(container.querySelector(".ov-member-groups")).toBeNull();
  if ("signature" in details && details.signature) {
    expect(
      [...container.querySelectorAll("pre")].map((pre) => pre.textContent),
    ).toEqual([details.signature.codemanifest, "null"]);
  }
});

it("keeps an empty group visible next to a populated group", () => {
  showContract({
    Example: {
      properties: { title: { codemanifest: "string", implementation: null } },
    },
  });
  const properties = screen.getByRole("group", { name: "Свойства" });
  const methods = screen.getByRole("group", { name: "Методы" });
  expect(
    within(properties).getByRole("heading", { name: "Свойства 1" }),
  ).not.toBeNull();
  expect(within(methods).getByText("Нет методов.")).not.toBeNull();
});

it("uses only JSON group keys and preserves raw strings and null without inferring members", () => {
  const propertyRaw =
    "  methods: execute(a: T) -> U\n\t<script>raw & text</script>  ";
  const methodRaw = " properties: title: string\n  value = 'unchanged' ";
  const signatureRaw =
    "properties:\n  inferred: string\nmethods:\n  inferred(): void";
  showContract({
    Example: {
      signature: { codemanifest: signatureRaw, implementation: null },
      properties: {
        shared: { codemanifest: propertyRaw, implementation: null },
      },
      methods: {
        shared: { codemanifest: null, implementation: methodRaw },
      },
    },
  });

  const properties = screen.getByRole("group", { name: "Свойства" });
  const methods = screen.getByRole("group", { name: "Методы" });
  expect(
    [...properties.querySelectorAll("pre")].map((pre) => pre.textContent),
  ).toEqual([propertyRaw, "null"]);
  expect(
    [...methods.querySelectorAll("pre")].map((pre) => pre.textContent),
  ).toEqual(["null", methodRaw]);
  expect(properties.querySelector("script")).toBeNull();
  expect(within(properties).getByText("shared")).not.toBeNull();
  expect(within(methods).getByText("shared")).not.toBeNull();
  expect(properties.querySelectorAll("code")).toHaveLength(1);
  expect(methods.querySelectorAll("code")).toHaveLength(1);
  const signature = screen.getByText(
    (_, element) =>
      element?.tagName === "PRE" && element.textContent === signatureRaw,
  );
  expect(signature.closest('[role="group"]')).toBeNull();
});

it("does not truncate verbose member names or multiline contract values", () => {
  const name = "очень_подробное_имя_свойства_".repeat(25);
  const raw =
    "  Подробное описание параметра, без сокращений и потери пробелов.\n\t".repeat(
      100,
    );
  showContract({
    Example: {
      properties: {
        [name]: { codemanifest: raw, implementation: raw + "конец" },
      },
      methods: { [name]: { codemanifest: raw + "метод", implementation: "" } },
    },
  });
  const properties = screen.getByRole("group", { name: "Свойства" });
  const methods = screen.getByRole("group", { name: "Методы" });
  expect(within(properties).getByText(name).textContent).toBe(name);
  expect(within(methods).getByText(name).textContent).toBe(name);
  expect(
    [...properties.querySelectorAll("pre")].map((pre) => pre.textContent),
  ).toEqual([raw, raw + "конец"]);
  expect(
    [...methods.querySelectorAll("pre")].map((pre) => pre.textContent),
  ).toEqual([raw + "метод", ""]);
});
