import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  Background,
  useReactFlow,
  useStore,
  type ReactFlowState,
  type NodeProps,
  type Node,
} from "@xyflow/react";
import { Braces, Boxes, ChevronRight, Minus, Plus, Focus } from "lucide-react";
import type { SchemaCell } from "../../shared/project-architecture";
import { prepareOverviewGraph, type GraphData } from "./graph";
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
const fitOptions = { padding: 0.13, maxZoom: 1.1 };
const zoomPercent = (state: ReactFlowState) =>
  Math.round(state.transform[2] * 100);
function ZoomIndicator() {
  const percent = useStore(zoomPercent);
  return <span>{percent}%</span>;
}

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
  const flow = useReactFlow<Node<GraphData>>(),
    host = useRef<HTMLDivElement>(null);
  const contractAction = useRef(onContract);
  contractAction.current = onContract;
  const drillAction = useRef(onDrill);
  drillAction.current = onDrill;
  const openContract = useCallback(
    (cell: string) => contractAction.current(cell),
    [],
  );
  const nodeClick = useCallback((_: React.MouseEvent, n: Node<GraphData>) => {
    if (n.type !== "scope" && n.data.navigable) drillAction.current(n.id);
  }, []);
  const geometry = useMemo(
    () => prepareOverviewGraph(schema, scope, openContract),
    [schema, scope, openContract],
  );
  const model = useMemo(
    () => geometry.select(selection),
    [geometry, selection],
  );
  const wasHidden = useRef(false),
    needsFit = useRef(true),
    fitFrame = useRef(0);
  const pendingTarget = useRef<string | null>(null);
  const reveal = useCallback(() => {
    const id = pendingTarget.current;
    if (!id || needsFit.current) return;
    const size = host.current?.getBoundingClientRect();
    if (!size?.width || !size.height) return;
    const rect = flow.getNodesBounds([id]);
    if (!rect.width || !rect.height) return;
    const { x, y, zoom } = flow.getViewport();
    const left = rect.x * zoom + x,
      top = rect.y * zoom + y;
    pendingTarget.current = null;
    // If the node cannot fit at this scale, leave its visible portion alone.
    // Otherwise pan just when needed, keeping the user's scale.
    const visible = (start: number, length: number, viewport: number) =>
      length > viewport
        ? start < viewport && start + length > 0
        : start >= 0 && start + length <= viewport;
    if (
      !visible(left, rect.width * zoom, size.width) ||
      !visible(top, rect.height * zoom, size.height)
    ) {
      void flow.setCenter(rect.x + rect.width / 2, rect.y + rect.height / 2, {
        zoom,
      });
    }
  }, [flow]);
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
      pendingTarget.current = null;
      void flow.fitView(fitOptions);
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
      else reveal();
    });
    r.observe(host.current);
    return () => {
      r.disconnect();
      cancelAnimationFrame(fitFrame.current);
    };
  }, [scheduleFit, reveal, geometry.tooLarge]);
  useEffect(() => {
    needsFit.current = true;
    scheduleFit();
    return () => cancelAnimationFrame(fitFrame.current);
  }, [scheduleFit, geometry]);
  useEffect(() => {
    pendingTarget.current = geometry.visibleOwnerId(selection);
    if (!pendingTarget.current || needsFit.current) return;
    const frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [geometry, selection, reveal]);
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
        nodes={model.nodes}
        edges={model.edges}
        nodeTypes={nodeTypes}
        onNodeClick={nodeClick}
        fitView
        fitViewOptions={fitOptions}
        minZoom={0.2}
        maxZoom={1.8}
        nodesDraggable={false}
        nodesConnectable={false}
        deleteKeyCode={null}
        zoomOnDoubleClick={false}
        colorMode="dark"
      >
        <Background color="#244963" gap={24} />
      </ReactFlow>
      <div className="ov-graph-controls">
        <IconButton label="Уменьшить граф" onClick={() => void flow.zoomOut()}>
          <Minus size={15} />
        </IconButton>
        <ZoomIndicator />
        <IconButton label="Увеличить граф" onClick={() => void flow.zoomIn()}>
          <Plus size={15} />
        </IconButton>
        <IconButton
          label="Показать весь граф"
          onClick={() => void flow.fitView(fitOptions)}
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
