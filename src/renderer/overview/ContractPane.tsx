import { t as msg } from "../../shared/i18n";
import { useLocale } from "../useLocale";
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
import { IconButton } from "./OverviewIconButton";
import { basename } from "./graph";
import "./ContractMembers.css";
function Pair({ pair }: { pair: ContractPair }) {
  useLocale();
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
  useLocale();
  const scroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = positions?.[cell.cell] ?? 0;
  }, [cell.cell]);
  const types = [...new Set([...cell.types, ...Object.keys(data ?? {})])];
  return (
    <aside className="ov-contract" aria-label={msg("overview.contract")}>
      <header className="ov-heading" hidden={inline}>
        <Braces size={16} />
        <strong>{msg("overview.contract")}</strong>
        <IconButton label={msg("overview.closeContract")} onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <div className="ov-contract-toolbar">
        <IconButton
          label={msg("overview.previousContract")}
          disabled={!canBack}
          onClick={onBack}
        >
          <ArrowLeft size={15} />
        </IconButton>
        <IconButton
          label={msg("overview.nextContract")}
          disabled={!canForward}
          onClick={onForward}
        >
          <ArrowRight size={15} />
        </IconButton>
        <code title={cell.cell}>{cell.cell}</code>
        <IconButton label={msg("overview.refreshContract")} disabled={busy} onClick={onRetry}>
          <RefreshCw size={15} />
        </IconButton>
        <IconButton
          label={msg("overview.openCODEMANIFESTInEditor")}
          onClick={() =>
            onSource(
              (cell.cell === "." ? "" : cell.cell + "/") + "CODEMANIFEST",
            )
          }
        >
          <FileCode2 size={16} />
        </IconButton>
      </div>
      {busy && data !== null && (
        <p className="ov-hint" role="status">{msg("overview.refreshingContract")}</p>
      )}
      {error && (
        <div className="ov-notice" role="alert">
          {error}
          <button onClick={onRetry}>{msg("overview.retry")}</button>
        </div>
      )}
      <nav className="ov-contract-jumps" aria-label={msg("overview.contractSections")}>
        <button
          onClick={() =>
            scroll.current
              ?.querySelector(".ov-contract-types")
              ?.scrollIntoView({ block: "start", behavior: "smooth" })
          }
        >{msg("overview.contract2")}<span>{types.length}</span>
        </button>
        <button
          onClick={() =>
            scroll.current
              ?.querySelector(".ov-contract-deps")
              ?.scrollIntoView({ block: "start", behavior: "smooth" })
          }
        >{msg("overview.dependencies")}<span>{Object.keys(cell.dependencies).length}</span>
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
            <small>{msg("overview.readONLY")}</small>
            <h2>{msg("overview.contract")}</h2>
          </div>
        </div>
        {cell.description && (
          <p className="ov-description">{cell.description}</p>
        )}
        <section className="ov-contract-types">
          <h3>
            <Braces size={16} />{msg("overview.typesAndFunctions")}<span>{types.length}</span>
          </h3>
          <p className="ov-hint">{msg("overview.typesAndFunctionsInTheContractAndTheirDeclarationsIn")}</p>
          {types.map((t) => {
            const details = data?.[t];
            return (
              <article className="ov-type" key={t}>
                <h4>
                  <code>{t}</code>
                </h4>
                {busy && data === null ? (
                  <p role="status">{msg("overview.loading")}</p>
                ) : details ? (
                  <>
                    {details.signature && <Pair pair={details.signature} />}
                    {(Object.hasOwn(details, "properties") ||
                      Object.hasOwn(details, "methods")) && (
                      <div className="ov-member-groups">
                        {(["properties", "methods"] as const).map((group) => {
                          const entries = Object.entries(details[group] ?? {});
                          const isProperties = group === "properties";
                          const label = isProperties ? msg("overview.properties") : msg("overview.methods");
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
                                    ? msg("overview.noProperties")
                                    : msg("overview.noMethods")}
                                </p>
                              )}
                            </section>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="ov-hint">{msg("overview.detailsUnavailable")}</p>
                )}
              </article>
            );
          })}
          {!types.length && (
            <p className="ov-hint">{msg("overview.thisContractHasNoTypesOrFunctions")}</p>
          )}
        </section>
        <section className="ov-contract-deps">
          <h3>
            <GitBranch size={16} />{msg("overview.dependencies")}<span>{Object.keys(cell.dependencies).length}</span>
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
                <p className="ov-hint">{msg("overview.externalDependencyNavigationUnavailable")}</p>
              )}
            </article>
          ))}
          {!Object.keys(cell.dependencies).length && (
            <p className="ov-hint">{msg("overview.noDirectDependencies")}</p>
          )}
        </section>
      </div>
    </aside>
  );
}
