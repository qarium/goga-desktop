const escape = text => text.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const startPage = (tag, title, hint) =>
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<!doctype html><html lang="${escape(tag)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escape(title)}</title><style>html{color-scheme:light dark;font:16px system-ui}body{margin:0;min-height:100vh;display:grid;align-content:center;justify-items:center}h1{font-size:1.5em;margin:.3em}p{margin:.4em;text-align:center}</style><h1>${escape(title)}</h1><p>${escape(hint)}</p></html>`,
  );
module.exports = { startPage };
