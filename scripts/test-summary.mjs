import { readFile, appendFile } from "node:fs/promises";
// A missing JSON report is an error, never evidence of zero skipped tests.
const report = JSON.parse(await readFile(process.argv[2], "utf8"));
const escape = (text) =>
  String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("\n", " ");
const skipped = report.testResults.flatMap((file) =>
  file.assertionResults
    .filter((t) =>
      ["pending", "skipped", "todo", "disabled"].includes(t.status),
    )
    .map(
      (t) =>
        `${file.name}: ${t.fullName ?? [...(t.ancestorTitles ?? []), t.title].join(" > ")} (${t.status})`,
    ),
);
const summary = `## Test report\n\nPassed: ${report.numPassedTests}; failed: ${report.numFailedTests}; skipped/todo: ${skipped.length}.\n\nNative Goga CLI tests are explicitly disabled with GOGA_TOPIC_READONLY_CLI=/nonexistent/disabled; no real Goga or Docker pipelines run.\n\n${skipped.length ? skipped.map((s) => `- ${escape(s)}`).join("\n") : "No skipped tests."}\n`;
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
else process.stdout.write(summary);
