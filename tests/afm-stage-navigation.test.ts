// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { selectAFMStage } from "../src/main/afm-stage-navigation";
afterEach(() => {
  document.body.innerHTML = "";
});
it("uses only the exact stage row and acknowledges actual selected state", async () => {
  document.body.innerHTML =
    '<li class="stage-item" data-stage-id="a"><button class="stage-row">A</button></li><li class="stage-item" data-stage-id="b"><button class="stage-row">B</button></li>';
  document
    .querySelectorAll(".stage-row")
    .forEach((e) =>
      e.addEventListener("click", () =>
        e.parentElement!.classList.add("active"),
      ),
    );
  expect(await selectAFMStage(document, "b")).toBe(true);
  expect(
    document.querySelector('[data-stage-id="a"]')!.classList.contains("active"),
  ).toBe(false);
});
it("never acknowledges a missing/duplicate/non-selected row or clicks another action", async () => {
  document.body.innerHTML =
    '<li class="stage-item" data-stage-id="a"><button class="stage-row">A</button><button class="danger">Delete</button></li>';
  expect(await selectAFMStage(document, "missing", 5)).toBe(false);
  expect(await selectAFMStage(document, "a", 5)).toBe(false);
  document.body.innerHTML +=
    '<li data-stage-id="a"><button class="stage-row">A2</button></li>';
  expect(await selectAFMStage(document, "a", 5)).toBe(false);
});
it("aborts a pending selector before a late stage DOM can steal the selection", async () => {
  const c = new AbortController();
  const pending = selectAFMStage(document, "late", 2000, c.signal);
  c.abort();
  expect(await pending).toBe(false);
  let clicked = false;
  document.body.innerHTML =
    '<li class="stage-item" data-stage-id="late"><button class="stage-row">Late</button></li>';
  document.querySelector("button")!.addEventListener("click", () => {
    clicked = true;
  });
  await Promise.resolve();
  expect(clicked).toBe(false);
});
