import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  Background,
  useReactFlow,
  type NodeProps,
  type Node,
} from "@xyflow/react";
import { Braces, Boxes, ChevronRight, Minus, Plus, Focus } from "lucide-react";
import type { SchemaCell } from "../../shared/project-architecture";
import { makeOverviewGraph, type GraphData } from "./graph";
import "@xyflow/react/dist/style.css";
export function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="ov-icon"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function Cell({ data }: NodeProps<Node<GraphData>>) {
  return (
    <div
      className={
        "ov-card " +
        (data.external ? "ov-external " : "") +
        (data.selected ? "ov-selected" : "")
      }
    >
      <Handle type="target" position={Position.Left} />
      <div className="ov-node-title">
        <Boxes size={19} />
        <strong>{data.name}</strong>
        <ChevronRight size={13} />
      </div>
      {data.external && <small className="ov-node-path">{data.cell}</small>}
      <div className="ov-node-actions">
        <button
          className="nodrag"
          disabled={!data.navigable}
          aria-label={"Показать контракт " + data.cell}
          onClick={(e) => {
            e.stopPropagation();
            data.onContract?.(data.cell);
          }}
        >
          <Braces size={12} />
          Контракт
        </button>
        <small>
          {data.external
            ? data.direction
            : data.children
              ? `${data.children} влож.`
              : "Файлы ↗"}
        </small>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
function Scope({ data }: NodeProps<Node<GraphData>>) {
  return (
    <div className={"ov-scope " + (data.selected ? "ov-selected" : "")}>
      <Handle type="target" position={Position.Left} />
      <header>
        <Boxes size={17} />
        <strong>{data.name}</strong>
        <small>ТЕКУЩАЯ ОБЛАСТЬ</small>
        <button
          className="nodrag"
          aria-label={"Показать контракт " + data.cell}
          onClick={() => data.onContract?.(data.cell)}
        >
          <Braces size={15} />
        </button>
      </header>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { cell: Cell, scope: Scope };
function Graph({
  schema,
  scope,
  selection,
  onDrill,
  onContract,
}: {
  schema: SchemaCell[];
  scope: string;
  selection: string | null;
  onDrill: (id: string) => void;
  onContract: (id: string) => void;
}) {
  const flow = useReactFlow(),
    host = useRef<HTMLDivElement>(null),
    [zoom, setZoom] = useState(1);
  const model = useMemo(
    () => makeOverviewGraph(schema, scope, selection),
    [schema, scope, selection],
  );
  const contractAction = useRef(onContract);
  contractAction.current = onContract;
  const openContract = useCallback(
    (cell: string) => contractAction.current(cell),
    [],
  );
  // Controlled React Flow nodes own measured geometry. Rebuilding every node
  // for a new parent callback discards it and re-enters synchronous measurement.
  const nodes = useMemo(
    () =>
      model.nodes.map((n) => ({
        ...n,
        data: { ...n.data, onContract: openContract },
      })),
    [model, openContract],
  );
  const wasHidden = useRef(false),
    needsFit = useRef(true),
    fitFrame = useRef(0);
  const scheduleFit = useCallback(() => {
    cancelAnimationFrame(fitFrame.current);
    fitFrame.current = requestAnimationFrame(() => {
      const size = host.current?.getBoundingClientRect();
      if (!size?.width || !size.height) {
        wasHidden.current = true;
        return;
      }
      wasHidden.current = false;
      needsFit.current = false;
      void flow.fitView({ padding: 0.13, maxZoom: 1.1 });
    });
  }, [flow]);
  useEffect(() => {
    if (!host.current) return;
    const r = new ResizeObserver(() => {
      cancelAnimationFrame(fitFrame.current);
      const size = host.current?.getBoundingClientRect();
      if (!size?.width || !size.height) {
        wasHidden.current = true;
        return;
      }
      const restored = wasHidden.current;
      wasHidden.current = false;
      // Hiding the mounted canvas must not reset the user's viewport. A new
      // model still needs fitting once it becomes visible; ordinary resizing
      // keeps the existing automatic fit behavior.
      if (!restored || needsFit.current) scheduleFit();
    });
    r.observe(host.current);
    return () => {
      r.disconnect();
      cancelAnimationFrame(fitFrame.current);
    };
  }, [scheduleFit]);
  useEffect(() => {
    needsFit.current = true;
    scheduleFit();
    return () => cancelAnimationFrame(fitFrame.current);
  }, [scheduleFit, model]);
  if (model.tooLarge)
    return (
      <div className="ov-empty">
        Слишком много элементов для одного графа. Выберите вложенную папку в
        дереве.
      </div>
    );
  return (
    <div className="ov-canvas" ref={host}>
      <ReactFlow
        nodes={nodes}
        edges={model.edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, n) => {
          if (n.type !== "scope" && n.data.navigable) onDrill(n.id);
        }}
        fitView
        fitViewOptions={{ padding: 0.13, maxZoom: 1.1 }}
        minZoom={0.2}
        maxZoom={1.8}
        nodesDraggable={false}
        nodesConnectable={false}
        deleteKeyCode={null}
        zoomOnDoubleClick={false}
        onMove={(_, v) => setZoom(v.zoom)}
        colorMode="dark"
      >
        <Background color="#244963" gap={24} />
      </ReactFlow>
      <div className="ov-graph-controls">
        <IconButton label="Уменьшить граф" onClick={() => void flow.zoomOut()}>
          <Minus size={15} />
        </IconButton>
        <span>{Math.round(zoom * 100)}%</span>
        <IconButton label="Увеличить граф" onClick={() => void flow.zoomIn()}>
          <Plus size={15} />
        </IconButton>
        <IconButton
          label="Показать весь граф"
          onClick={() => void flow.fitView({ padding: 0.13, maxZoom: 1.1 })}
        >
          <Focus size={15} />
        </IconButton>
      </div>
    </div>
  );
}
export function SchemaGraph(props: Parameters<typeof Graph>[0]) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}
