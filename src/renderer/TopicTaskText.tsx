import { HistoryMarkdown } from "./HistoryMarkdown";
import "./ProjectHistory.css";
import "./TopicTaskText.css";

/** Same safe GFM renderer as artifacts; task-only cards have no file navigator. */
export function TopicTaskText({ text }: { text: string }) {
  return (
    <div className="topic-task-markdown">
      <HistoryMarkdown text={text} path="todo.md" />
    </div>
  );
}
