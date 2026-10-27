import { readFile, appendFile } from "node:fs/promises";
const escape = (text) =>
  String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("\n", " ");
const write = async (text) => {
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
  else process.stdout.write(text);
};
const outcome = process.env.TEST_OUTCOME;
const shard = process.env.TEST_SHARD;
const heading = `## Test report${shard ? ` — shard ${escape(shard)}` : ""}`;
let report;
try {
  report = JSON.parse(await readFile(process.argv[2], "utf8"));
  if (
    !Number.isSafeInteger(report.numPassedTests) ||
    report.numPassedTests < 0 ||
    !Number.isSafeInteger(report.numFailedTests) ||
    report.numFailedTests < 0 ||
    !Array.isArray(report.testResults) ||
    report.testResults.length === 0 ||
    !report.testResults.every(
      (file) =>
        typeof file.name === "string" &&
        Array.isArray(file.assertionResults) &&
        file.assertionResults.every((t) => t && typeof t.status === "string"),
    )
  )
    throw Error("invalid report");
  if (outcome && !["success", "failure"].includes(outcome))
    throw Error("test step did not complete");
} catch {
  // An interrupted run writes no final JSON. Never turn absence into zero failures.
  const message = `${heading}\n\n**Test verification incomplete.**\n\nTest step outcome: ${escape(outcome || "unknown")}. The final report is missing, unreadable or incomplete. Check the Tests step and job annotations for a timeout, cancellation or startup failure. This is not a successful test run; passed/failed/skipped totals are unavailable.\n`;
  await write(message);
  process.stderr.write(
    "Test verification incomplete; inspect the Tests step and job annotations.\n",
  );
  process.exit(1);
}
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
await write(
  `${heading}\n\nPassed: ${report.numPassedTests}; failed: ${report.numFailedTests}; skipped/todo: ${skipped.length}.\n\nNative Goga CLI tests are explicitly disabled with GOGA_TOPIC_READONLY_CLI=/nonexistent/disabled; no real Goga or Docker pipelines run.\n\n${skipped.length ? skipped.map((s) => `- ${escape(s)}`).join("\n") : "No skipped tests."}\n`,
);
if (
  outcome === "failure" ||
  report.numFailedTests > 0 ||
  report.success === false
)
  process.exitCode = 1;
