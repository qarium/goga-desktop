"use strict";
const { text: t } = require("./messages.cjs");

// Keep exactly the address of the host's displayed top-level document. Neither
// an editable input nor a CDP agent's most recently opened tab is authoritative.
function snapshotURL(raw) {
  if (typeof raw !== "string" || !/^https?:\/\//i.test(raw)) return null;
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    return u.href;
  } catch {
    return null;
  }
}
function typedURL(raw) {
  if (
    typeof raw !== "string" ||
    raw.length > 8192 ||
    /[\x00-\x1f\x7f\\]/.test(raw)
  )
    throw Error(t("hostTerminal.fullURL"));
  const text = raw.trim();
  if (!/^https?:\/\/[^/\\?#\s]/i.test(text))
    throw Error(t("hostTerminal.fullURL"));
  let u;
  try {
    u = new URL(text);
  } catch {
    throw Error(t("hostTerminal.invalidURL"));
  }
  if (u.username || u.password)
    throw Error(t("hostTerminal.credentialsInURL"));
  return u.href;
}
async function trackPage(target, pageId, onPageLost) {
  const session = await target.attachHostPage(pageId);
  let root = null,
    url = null,
    lost = false,
    revision = 0;
  function committed(frame) {
    if (!frame || frame.parentId) return;
    root = frame.id;
    url = snapshotURL(frame.url + (frame.urlFragment || ""));
    revision++;
  }
  try {
    session.onNavigation((method, params) => {
      if (method === "lost") {
        if (lost) return;
        lost = true;
        url = null;
        onPageLost();
        return;
      }
      if (lost) return;
      if (method === "Page.frameNavigated") committed(params.frame);
      if (
        method === "Page.navigatedWithinDocument" &&
        root === params.frameId
      ) {
        url = snapshotURL(params.url);
        revision++;
      }
    });
    await session.command("Page.enable");
    const rev = revision,
      { frameTree } = await session.command("Page.getFrameTree");
    if (!lost && revision === rev) committed(frameTree.frame);
    if (lost) throw Error(t("hostTerminal.pageClosed"));
    return {
      get url() {
        return url;
      },
      async navigate(raw) {
        if (lost) throw Error(t("hostTerminal.pageClosed"));
        const address = typedURL(raw);
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error(
                  t("hostTerminal.navigationTimedOut"),
                ),
              ),
            10000,
          );
          timer.unref();
        });
        // Chromium, not the host's HTTP client, performs the navigation in this
        // page's browser session. Only committed events above update the address.
        const sent = session
          .command("Page.navigate", { url: address, transitionType: "typed" })
          .catch(() => {
            throw Error(t("hostTerminal.navigationFailed"));
          });
        try {
          const { errorText, isDownload } = await Promise.race([sent, timeout]);
          if (errorText || isDownload)
            throw Error(t("hostTerminal.pageOpenFailed"));
        } finally {
          clearTimeout(timer);
        }
      },
      close: () => session.close(),
    };
  } catch (e) {
    await session.close();
    throw e;
  }
}
module.exports = { trackPage };
