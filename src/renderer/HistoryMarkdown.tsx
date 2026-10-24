import {
  Fragment,
  createElement,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { MarkedToken, Token } from "marked";
import { lexHistoryMarkdown } from "./history-markdown-worker-client";
import { LoadingBoundary } from "./LoadingBoundary";

/** Only entry-relative file navigation is supported. URLs never reach the browser. */
export function artifactLink(current: string, href: string): string | null {
  let value: string;
  try {
    value = decodeURIComponent(href.split(/[?#]/, 1)[0]!);
  } catch {
    return null;
  }
  if (!value || /^[\/\\]/.test(value) || /[:\\\x00-\x1f\x7f]/.test(value))
    return null;
  const parts = current.split("/").slice(0, -1);
  for (const part of value.split("/")) {
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}
function entities(text: string) {
  // Decode references as text, never as HTML. Escaping angle brackets ensures
  // even untrusted tags cannot become elements in this detached textarea.
  const el = document.createElement("textarea");
  el.innerHTML = text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return el.value;
}
function renderMarkdown(
  tokens: Token[],
  text: string,
  path: string,
  onFile: ((path: string) => void) | undefined,
): ReactNode {
  if (text.length > 200000) return <pre className="history-plain">{text}</pre>;
  try {
    let remaining = 20000;
    function nodes(tokens: Token[], depth = 0): ReactNode {
      if (depth > 40) throw Error("Markdown nesting limit");
      return tokens.map((generic, index) => {
        if (--remaining < 0) throw Error("Markdown token limit");
        // No plugins/extensions are enabled: the lexer only returns built-in tokens.
        const token = generic as MarkedToken;
        const children = () =>
          nodes("tokens" in token ? (token.tokens ?? []) : [], depth + 1);
        let content: ReactNode;
        switch (token.type) {
          case "space":
          case "def":
            return null;
          case "heading":
            content = createElement(
              `h${Math.min(6, Math.max(1, token.depth))}`,
              null,
              children(),
            );
            break;
          case "paragraph":
            content = <p>{children()}</p>;
            break;
          case "text":
            content = token.tokens ? children() : entities(token.text);
            break;
          case "escape":
            content = token.text;
            break;
          case "strong":
            content = <strong>{children()}</strong>;
            break;
          case "em":
            content = <em>{children()}</em>;
            break;
          case "del":
            content = <del>{children()}</del>;
            break;
          case "code":
            content = (
              <pre>
                <code>{token.text}</code>
              </pre>
            );
            break;
          case "codespan":
            content = <code>{token.text}</code>;
            break;
          case "blockquote":
            content = <blockquote>{children()}</blockquote>;
            break;
          case "br":
            content = <br />;
            break;
          case "hr":
            content = <hr />;
            break;
          case "html":
            content = <span className="history-raw-html">{token.text}</span>;
            break;
          case "image":
            content = (
              <span className="history-image-note">
                [Изображение: {entities(token.text) || "без подписи"}]
              </span>
            );
            break;
          case "link": {
            const destination = artifactLink(path, entities(token.href));
            content =
              destination && onFile ? (
                <button
                  type="button"
                  className="history-file-link"
                  onClick={() => onFile(destination)}
                >
                  {children()}
                </button>
              ) : (
                <span
                  title={
                    destination
                      ? "Переход к файлам недоступен в этом просмотре"
                      : "Внешние ссылки не открываются в просмотрщике"
                  }
                >
                  {children()}
                </span>
              );
            break;
          }
          case "checkbox":
            content = (
              <input
                type="checkbox"
                disabled
                checked={token.checked}
                aria-label={token.checked ? "Выполнено" : "Не выполнено"}
              />
            );
            break;
          case "list":
            content = token.ordered ? (
              <ol start={Number(token.start) || 1}>
                {nodes(token.items, depth + 1)}
              </ol>
            ) : (
              <ul>{nodes(token.items, depth + 1)}</ul>
            );
            break;
          case "list_item":
            content = <li>{children()}</li>;
            break;
          case "table":
            content = (
              <div className="history-table-scroll">
                <table>
                  <thead>
                    <tr>
                      {token.header.map((cell, i) => (
                        <th
                          key={i}
                          style={{ textAlign: cell.align ?? undefined }}
                        >
                          {nodes(cell.tokens, depth + 1)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {token.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td
                            key={c}
                            style={{ textAlign: cell.align ?? undefined }}
                          >
                            {nodes(cell.tokens, depth + 1)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
            break;
          default:
            content = generic.raw;
        }
        return <Fragment key={index}>{content}</Fragment>;
      });
    }
    return nodes(tokens);
  } catch {
    return <pre className="history-plain">{text}</pre>;
  }
}
/** React nodes only: scripts, HTML, external images and embedded resources stay inert. */
export function HistoryMarkdown({
  text,
  path,
  onFile,
}: {
  text: string;
  path: string;
  onFile?: (path: string) => void;
}) {
  const request = useMemo(() => ({ text, path }), [text, path]);
  const [result, setResult] = useState<{
    request: typeof request;
    tokens?: Token[];
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lexHistoryMarkdown(text, controller.signal).then(
      (tokens) => {
        if (!controller.signal.aborted) setResult({ request, tokens });
      },
      () => {
        if (!controller.signal.aborted) setResult({ request });
      },
    );
    return () => controller.abort();
  }, [request]);
  const current = result?.request === request ? result : null;
  const body = useMemo(
    () =>
      current?.tokens
        ? renderMarkdown(current.tokens, text, path, onFile)
        : null,
    [current, text, path, onFile],
  );
  return (
    <LoadingBoundary pending={!current} label="Форматируем Markdown…">
      {current && (
        <article className="history-markdown">
          {current.tokens ? (
            body
          ) : (
            <>
              <p className="history-image-note">
                Предпросмотр Markdown недоступен. Содержимое показано как текст.
              </p>
              <pre className="history-plain">{text}</pre>
            </>
          )}
        </article>
      )}
    </LoadingBoundary>
  );
}
