import type { TopicBoardSnapshot } from "../../src/shared/topics";
export function topicsBoardV4(year = "2026"): TopicBoardSnapshot {
  const data: Array<[string, string | null, string[], string[]?]> =
    year === "2025"
      ? [
          ["desktop-launch", "desktop-launch", ["done"], ["main"]],
          ["legacy-import", "legacy-import", ["backlog"]],
        ]
      : [
          ["history-search", "history-search", ["empty"]],
          ["report-export", "report-export", ["todo"]],
          ["llm-backoff", "llm-backoff", ["planned"]],
          [
            "contract-editor",
            "contract-editor",
            ["designed", "security-review"],
          ],
          ["topic-sync", "topic-sync", ["prototyped"]],
          [
            "project-overview",
            "project-overview",
            ["done"],
            ["main", "release/2.1"],
          ],
          ["pipeline-no-topic", "pipeline-no-topic", ["done"], ["main"]],
          ["cli-update", "cli-update", ["awaiting-release"], ["main"]],
          ["dependency-audit", "dependency-audit", ["backlog"]],
          ["log-structure", null, []],
          ["offline-cache", "offline-cache", ["defined"]],
          ["workspace-search", "workspace-search", ["discovered"]],
        ];
  const entries = data.map(([topic, branch, statuses, hosts = []]) => ({
    topic,
    branch: branch ?? "main",
    statuses,
    remote: false,
    current: false,
    todo: null,
    divergence: null,
    hosts: [...(branch ? [branch] : ["main"]), ...hosts],
  }));
  return {
    projectId: "p",
    year,
    revision: "a".repeat(64),
    currentBranch: "main",
    currentTopic: null,
    baseRef: "main",
    branches: ["main", ...data.flatMap((r) => (r[1] ? [r[1]] : []))],
    dirty: false,
    active: false,
    entries,
    records: entries,
    remoteEntries: [],
    remoteRecords: [],
  };
}
