"use strict";
const { text: t } = require("./messages.cjs");

// Fixed host-owned read, executed in an isolated world of this page. Neither a
// renderer-supplied expression nor a remote page's copy handler is evaluated.
const inspectSelection = `(() => {
  let active = document.activeElement;
  for (let i = 0; i < 16 && active && active.shadowRoot && active.shadowRoot.activeElement; i++)
    active = active.shadowRoot.activeElement;
  const focused = document.hasFocus();
  const limit=1024*1024;
  const textResult=text=>text.length>limit?{kind:"oversized",focused}:{kind:"text",focused,text};
  if (active && (active.tagName === "IFRAME" || active.tagName === "FRAME"))
    return {kind:"frame", focused};
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    if (active instanceof HTMLInputElement && active.type === "password")
      return {kind:"text", focused, text:""};
    const start=active.selectionStart, end=active.selectionEnd;
    if (Number.isInteger(start) && Number.isInteger(end)) {
      if(end-start>limit)return {kind:"oversized",focused};
      return textResult(active.value.slice(start,end));
    }
    return textResult("");
  }
  const selection = globalThis.getSelection();
  return textResult(selection ? selection.toString() : "");
})()`;
const unavailable = () =>
  Error(t("hostTerminal.pageChanged"));

async function readSelection(command, live) {
  await command("Page.enable");
  if (!live()) throw unavailable();
  const { frameTree } = await command("Page.getFrameTree");
  if (!frameTree?.frame?.id) throw unavailable();
  const root = frameTree.frame;
  const visited = [];
  let inspected = 0;
  async function inspect(tree) {
    if (!live() || ++inspected > 32) throw unavailable();
    const frameId = tree.frame?.id;
    if (!frameId) throw unavailable();
    const { executionContextId } = await command("Page.createIsolatedWorld", {
      frameId,
      worldName: "goga-manual-copy-selection",
    });
    if (!live() || !Number.isInteger(executionContextId)) throw unavailable();
    const result = await command("Runtime.evaluate", {
      expression: inspectSelection,
      contextId: executionContextId,
      returnByValue: true,
      awaitPromise: false,
      silent: true,
      timeout: 750,
    });
    if (!live() || result.exceptionDetails) throw unavailable();
    const value = result.result?.value;
    if (value?.kind === "oversized")
      throw Error(t("hostTerminal.selectionTooLarge"));
    if (
      !value ||
      !["text", "frame"].includes(value.kind) ||
      typeof value.focused !== "boolean"
    )
      throw unavailable();
    visited.push({ id: frameId, loaderId: tree.frame.loaderId });
    return value;
  }
  let tree = frameTree,
    value = await inspect(tree),
    depth = 0;
  while (value.kind === "frame") {
    if (++depth > 8) throw unavailable();
    let focused;
    // Creating worlds for OOPIFs may fail. Never copy a parent's unrelated
    // selection when the actual focused embedded document is inaccessible.
    for (const child of tree.childFrames || []) {
      let next;
      try {
        next = await inspect(child);
      } catch {
        continue;
      }
      if (next.focused) {
        if (focused) throw unavailable();
        focused = { tree: child, value: next };
      }
    }
    if (!focused)
      throw Error(t("hostTerminal.subframeSelectionFailed"));
    tree = focused.tree;
    value = focused.value;
  }
  if (
    typeof value.text !== "string" ||
    Buffer.byteLength(value.text, "utf8") > 1024 * 1024
  )
    throw Error(t("hostTerminal.selectionTooLarge"));
  const after = (await command("Page.getFrameTree")).frameTree;
  const frames = new Map();
  function collect(t) {
    if (!t?.frame) return;
    frames.set(t.frame.id, t.frame);
    for (const c of t.childFrames || []) collect(c);
  }
  collect(after);
  if (
    !live() ||
    !after?.frame ||
    after.frame.id !== root.id ||
    visited.some(
      (f) => !frames.has(f.id) || frames.get(f.id).loaderId !== f.loaderId,
    )
  )
    throw unavailable();
  return value.text.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    "",
  );
}
module.exports = { readSelection };
