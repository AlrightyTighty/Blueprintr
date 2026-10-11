import { useMemo } from 'react';
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { blastRadius } from '../../core/graph/blastRadius';
import { getNodeCategory, getNodeDisplayName, type NodeCategory } from '../../core/graph/nodeDisplay';
import type { PlanChange } from '../../core/graph/types';
import { layoutGraph, NODE_WIDTH } from './layoutGraph';
import { useGraphStore } from './useGraphStore';

// Dark surface with blue/purple accents; text is always light so it stays readable.
const CATEGORY_COLORS: Record<NodeCategory, string> = {
  code: '#818cf8',
  resource: '#60a5fa',
  iam_role: '#c084fc',
  domain: '#a5b4fc',
  unmanaged: '#64748b',
  unresolved: '#64748b',
};

const NODE_BACKGROUND = '#1e1b4b';
const NODE_BACKGROUND_HIGHLIGHTED = '#312e81';
const NODE_BACKGROUND_SELECTED = '#6d28d9';
// Plan overlay: red = replaced/destroyed, amber = downstream or modified.
const PLAN_COLORS = {
  dangerBorder: '#f43f5e',
  dangerBackground: '#4c0519',
  warningBorder: '#f59e0b',
  warningBackground: '#451a03',
};
const EDGE_COLOR = '#475a85';
const EDGE_COLOR_ON_PATH = '#a78bfa';

export default function GraphView() {
  const { graph, selectedNodeId, direction, selectNode, planChanges } = useGraphStore();

  const positions = useMemo(() => layoutGraph(graph), [graph]);
  const highlightedIds = useMemo(
    () => (selectedNodeId ? blastRadius(graph, selectedNodeId, direction) : new Map<string, number>()),
    [graph, selectedNodeId, direction],
  );
  const planChangeByNodeId = useMemo(
    () => new Map<string, PlanChange>(planChanges.flatMap((change) => (change.nodeId ? [[change.nodeId, change]] : []))),
    [planChanges],
  );
  const isPlanActive = planChangeByNodeId.size > 0;

  const flowNodes: Node[] = graph.nodes.map((node) => {
    const isSelected = node.id === selectedNodeId;
    const isHighlighted = highlightedIds.has(node.id);
    const planChange = planChangeByNodeId.get(node.id);
    const isDirectlyChanged = planChange?.impact === 'direct';
    const isDownstream = planChange?.impact === 'downstream';

    // With a plan loaded, plan colors take over; otherwise show the click-to-highlight view.
    const isPlanDimmed = isPlanActive && !planChange;
    const isSelectionDimmed = !isPlanActive && selectedNodeId !== null && !isSelected && !isHighlighted;

    const categoryColor = CATEGORY_COLORS[getNodeCategory(node)];
    let borderColor = isSelected ? '#ddd6fe' : categoryColor;
    let background = isSelected
      ? NODE_BACKGROUND_SELECTED
      : isHighlighted
        ? NODE_BACKGROUND_HIGHLIGHTED
        : NODE_BACKGROUND;
    if (isDirectlyChanged && (planChange.action === 'replace' || planChange.action === 'destroy')) {
      borderColor = PLAN_COLORS.dangerBorder;
      background = PLAN_COLORS.dangerBackground;
    } else if (isDirectlyChanged) {
      borderColor = PLAN_COLORS.warningBorder;
      background = NODE_BACKGROUND;
    } else if (isDownstream) {
      borderColor = PLAN_COLORS.warningBorder;
      background = PLAN_COLORS.warningBackground;
    }

    const displayName = getNodeDisplayName(node);
    return {
      id: node.id,
      position: positions.get(node.id)!,
      data: { label: isDirectlyChanged ? `${displayName} (${planChange.action})` : displayName },
      style: {
        width: NODE_WIDTH,
        fontSize: 12,
        color: '#f1f5f9',
        border: `2px solid ${borderColor}`,
        background,
        boxShadow: isHighlighted || isSelected || planChange ? `0 0 12px ${borderColor}88` : undefined,
        opacity: isPlanDimmed || isSelectionDimmed ? 0.3 : 1,
      },
    };
  });

  const flowEdges: Edge[] = graph.edges.map((edge) => {
    const isOnPath =
      selectedNodeId !== null &&
      (edge.source === selectedNodeId || highlightedIds.has(edge.source)) &&
      (edge.target === selectedNodeId || highlightedIds.has(edge.target));
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.confidence === 'certain' ? undefined : edge.confidence,
      labelStyle: { fill: '#cbd5e1', fontSize: 11 },
      labelBgStyle: { fill: '#0f172a' },
      animated: isOnPath,
      style: {
        strokeDasharray: edge.confidence === 'inferred' ? '6 4' : undefined,
        stroke: isOnPath ? EDGE_COLOR_ON_PATH : EDGE_COLOR,
        strokeWidth: isOnPath ? 2.5 : 1.5,
        opacity: selectedNodeId !== null && !isOnPath ? 0.25 : 1,
      },
    };
  });

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      onNodeClick={(_event, node) => selectNode(node.id)}
      onPaneClick={() => selectNode(null)}
      nodesDraggable={false}
      colorMode="dark"
      fitView
    >
      <Background color="#312e81" gap={24} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
