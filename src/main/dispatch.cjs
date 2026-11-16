// esbuild keeps these require branches lazy. In helper mode no Desktop imports,
// project services, process recovery or single-instance lock may ever run.
if (process.argv.includes("--goga-demonstration-helper")) {
  // A malformed helper invocation must fail closed, never fall through to
  // the Desktop or open Electron's default native error dialog.
  try {
    require("./demonstration-helper.cjs");
  } catch {
    require("electron").app.exit(1);
  }
} else {
  require("./index.ts");
}
