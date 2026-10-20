/** Local embedding-only override, verified against the live AFM header and Goga skin.
 * The wordmark owns the Go/ga pseudo-elements. The separator is gh-flow's left border.
 * Never hide gh-left itself: it also contains the actual flow name/description.
 */
export const AFM_EMBEDDED_STYLE = `
#header.global-header > .gh-left > .gh-mark,
#header.global-header > .gh-left > .gh-wordmark { display: none !important; }
#header.global-header > .gh-left > .gh-flow {
  border-left: 0 !important;
  padding-left: 0 !important;
  margin-left: 0 !important;
}
#header.global-header > .gh-right.header-actions > .gh-theme-seg[role="group"][aria-label="Theme mode"] {
  display: none !important;
}
`;
