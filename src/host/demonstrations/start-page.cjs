const startPage =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Демонстрация</title><style>html{color-scheme:light dark;font:16px system-ui}body{margin:0;min-height:100vh;display:grid;align-content:center;justify-items:center}h1{font-size:1.5em;margin:.3em}p{margin:.4em;text-align:center}</style><h1>Демонстрация</h1><p>Введите адрес страницы в панели показа.</p></html>`,
  );
module.exports = { startPage };
