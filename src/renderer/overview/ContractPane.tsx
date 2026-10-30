import { useRef, useLayoutEffect } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  RefreshCw,
  X,
  FileCode2,
  Folder,
  ArrowUpRight,
  GitBranch,
  List,
  SquareFunction,
} from "lucide-react";
import type {
  CellContract,
  SchemaCell,
  ContractPair,
} from "../../shared/project-architecture";
import { IconButton } from "./SchemaGraph";
import { basename } from "./graph";
import "./ContractMembers.css";
function Pair({ pair }: { pair: ContractPair }) {
  return (
    <div className="ov-pair">
      {(["codemanifest", "implementation"] as const).map((k) => (
        <div key={k}>
          <h5>{k}</h5>
          <pre>{pair[k] === null ? "null" : pair[k]}</pre>
        </div>
      ))}
    </div>
  );
}
export function ContractPane({
  cell,
  data,
  busy,
  error,
  onRetry,
  onClose,
  onGo,
  onSource,
  onBack,
  onForward,
  canBack,
  canForward,
  navigable,
  inline = false,
  positions,
}: {
  cell: SchemaCell;
  data: CellContract | null;
  busy: boolean;
  error: string;
  onRetry: () => void;
  onClose: () => void;
  onGo: (p: string) => void;
  onSource: (p: string) => void;
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canForward: boolean;
  inline?: boolean;
  positions?: Record<string, number>;
  navigable: (p: string) => boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = positions?.[cell.cell] ?? 0;
  }, [cell.cell]);
  const types = [...new Set([...cell.types, ...Object.keys(data ?? {})])];
  return (
    <aside className="ov-contract" aria-label="Контракт">
      <header className="ov-heading" hidden={inline}>
        <Braces size={16} />
        <strong>Контракт</strong>
        <IconButton label="Закрыть контракт" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <div className="ov-contract-toolbar">
        <IconButton
          label="Предыдущий контракт"
          disabled={!canBack}
          onClick={onBack}
        >
          <ArrowLeft size={15} />
        </IconButton>
        <IconButton
          label="Следующий контракт"
          disabled={!canForward}
          onClick={onForward}
        >
          <ArrowRight size={15} />
        </IconButton>
        <code title={cell.cell}>{cell.cell}</code>
        <IconButton label="Обновить контракт" disabled={busy} onClick={onRetry}>
          <RefreshCw size={15} />
        </IconButton>
        <IconButton
          label="Открыть CODEMANIFEST в редакторе"
          onClick={() =>
            onSource(
              (cell.cell === "." ? "" : cell.cell + "/") + "CODEMANIFEST",
            )
          }
        >
          <FileCode2 size={16} />
        </IconButton>
      </div>
      {error && (
        <div className="ov-notice" role="alert">
          {error}
          <button onClick={onRetry}>Повторить</button>
        </div>
      )}
      <nav className="ov-contract-jumps" aria-label="Разделы контракта">
        <button
          onClick={() =>
            scroll.current
              ?.querySelector(".ov-contract-types")
              ?.scrollIntoView({ block: "start", behavior: "smooth" })
          }
        >
          Контракт <span>{types.length}</span>
        </button>
        <button
          onClick={() =>
            scroll.current
              ?.querySelector(".ov-contract-deps")
              ?.scrollIntoView({ block: "start", behavior: "smooth" })
          }
        >
          Зависимости <span>{Object.keys(cell.dependencies).length}</span>
        </button>
      </nav>
      <div
        className="ov-contract-scroll"
        ref={scroll}
        onScroll={(e) => {
          if (positions) positions[cell.cell] = e.currentTarget.scrollTop;
        }}
      >
        <div className="ov-contract-hero">
          <Braces size={24} />
          <div>
            <small>ТОЛЬКО ПРОСМОТР</small>
            <h2>Контракт</h2>
          </div>
        </div>
        {cell.description && (
          <p className="ov-description">{cell.description}</p>
        )}
        <section className="ov-contract-types">
          <h3>
            <Braces size={16} />
            Типы и функции <span>{types.length}</span>
          </h3>
          <p className="ov-hint">
            Типы и функции, описанные в контракте, и их объявления в коде.
          </p>
          {types.map((t) => {
            const details = data?.[t];
            return (
              <article className="ov-type" key={t}>
                <h4>
                  <code>{t}</code>
                </h4>
                {busy ? (
                  <p role="status">Загрузка…</p>
                ) : details ? (
                  <>
                    {details.signature && <Pair pair={details.signature} />}
                    {(Object.hasOwn(details, "properties") ||
                      Object.hasOwn(details, "methods")) && (
                      <div className="ov-member-groups">
                        {(["properties", "methods"] as const).map((group) => {
                          const entries = Object.entries(details[group] ?? {});
                          const isProperties = group === "properties";
                          const label = isProperties ? "Свойства" : "Методы";
                          const Icon = isProperties ? List : SquareFunction;
                          return (
                            <section
                              key={group}
                              role="group"
                              aria-label={label}
                              className={`ov-members ov-member-group ov-member-group-${group}`}
                            >
                              <h5 className="ov-member-group-heading">
                                <Icon size={15} aria-hidden="true" />
                                {label}{" "}
                                <span className="ov-member-count">
                                  {entries.length}
                                </span>
                              </h5>
                              {entries.map(([name, pair]) => (
                                <div className="ov-member" key={name}>
                                  <code className="ov-member-name">{name}</code>
                                  <Pair pair={pair} />
                                </div>
                              ))}
                              {!entries.length && (
                                <p className="ov-member-empty">
                                  {isProperties
                                    ? "Нет свойств."
                                    : "Нет методов."}
                                </p>
                              )}
                            </section>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="ov-hint">Подробности недоступны.</p>
                )}
              </article>
            );
          })}
          {!types.length && (
            <p className="ov-hint">В контракте нет типов и функций.</p>
          )}
        </section>
        <section className="ov-contract-deps">
          <h3>
            <GitBranch size={16} />
            Зависимости <span>{Object.keys(cell.dependencies).length}</span>
          </h3>
          {Object.entries(cell.dependencies).map(([p, dep]) => (
            <article className="ov-dependency" key={p}>
              <button disabled={!navigable(p)} onClick={() => onGo(p)}>
                <Folder size={17} />
                <span>
                  <strong>{basename(p)}</strong>
                  <code>{p}</code>
                </span>
                <ArrowUpRight size={14} />
              </button>
              <div>
                {dep.types.map((t) => (
                  <button
                    key={t}
                    disabled={!navigable(p)}
                    onClick={() => onGo(p)}
                  >
                    {t}
                    <ArrowUpRight size={11} />
                  </button>
                ))}
              </div>
              {!navigable(p) && (
                <p className="ov-hint">
                  Внешняя зависимость — переход недоступен
                </p>
              )}
            </article>
          ))}
          {!Object.keys(cell.dependencies).length && (
            <p className="ov-hint">Нет прямых зависимостей.</p>
          )}
        </section>
      </div>
    </aside>
  );
}
