import { useEffect, useMemo, useRef } from 'react';
import { Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { blastRadius } from '../../core/graph/blastRadius';
import { getNodeCategory, getNodeDisplayName, type NodeCategory } from '../../core/graph/nodeDisplay';
import type { PlanChange } from '../../core/graph/types';
import { useTourStore } from '../tour-player/useTourStore';
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
// Plan and failure colors: red = replaced, destroyed or down; amber = downstream or modified.
const PLAN_COLORS = {
  dangerBorder: '#f43f5e',
  dangerBackground: '#4c0519',
  warningBorder: '#f59e0b',
  warningBackground: '#451a03',
};
const EDGE_COLOR = '#475a85';
const EDGE_COLOR_ON_PATH = '#a78bfa';
const EDGE_COLOR_FAILING = '#f43f5e';

interface NodeLook {
  borderColor: string;
  background: string;
  opacity: number;
  glow: boolean;
  suffix: string;
}

function GraphCanvas() {
  const { graph, selectedNodeId, direction, selectNode, planChanges } = useGraphStore();
  const { activeJourney, stopIndex } = useTourStore();
  const { fitView } = useReactFlow();

  const positions = useMemo(() => layoutGraph(graph), [graph]);
  const highlightedIds = useMemo(
    () => (selectedNodeId ? blastRadius(graph, selectedNodeId, direction) : new Map<string, number>()),
    [graph, selectedNodeId, direction],
  );
  const planChangeByNodeId = useMemo(
    () => new Map<string, PlanChange>(planChanges.flatMap((change) => (change.nodeId ? [[change.nodeId, change]] : []))),
    [planChanges],
  );

  const tourKind = activeJourney?.kind ?? null;
  const currentStopNodeId = activeJourney?.stops[stopIndex]?.nodeId ?? null;
  const stopNodeIds = useMemo(() => new Set(activeJourney?.stops.map((stop) => stop.nodeId)), [activeJourney]);
  const revealedNodeIds = useMemo(
    () => new Set(activeJourney?.stops.slice(0, stopIndex + 1).map((stop) => stop.nodeId)),
    [activeJourney, stopIndex],
  );

  // Glide the camera to each stop, and back out to the whole graph when the tour ends.
  const wasTouringRef = useRef(false);
  useEffect(() => {
    if (currentStopNodeId) {
      wasTouringRef.current = true;
      void fitView({ nodes: [{ id: currentStopNodeId }], duration: 700, padding: 1.4, maxZoom: 1.2 });
    } else if (wasTouringRef.current) {
      wasTouringRef.current = false;
      void fitView({ duration: 600 });
    }
  }, [currentStopNodeId, fitView]);

  function lookDuringTour(nodeId: string, defaultBorder: string): NodeLook {
    const isCurrent = nodeId === currentStopNodeId;
    const isRevealed = revealedNodeIds.has(nodeId);
    const isStop = stopNodeIds.has(nodeId);
    const currentBorder = '#ddd6fe';

    if (tourKind === 'disaster') {
      if (!isRevealed) return { borderColor: defaultBorder, background: NODE_BACKGROUND, opacity: isStop ? 0.8 : 0.35, glow: false, suffix: '' };
      return {
        borderColor: isCurrent ? currentBorder : PLAN_COLORS.dangerBorder,
        background: PLAN_COLORS.dangerBackground,
        opacity: 1,
        glow: true,
        suffix: ' (down)',
      };
    }

    if (tourKind === 'change') {
      const change = planChangeByNodeId.get(nodeId);
      if (!isRevealed || !change) return { borderColor: defaultBorder, background: NODE_BACKGROUND, opacity: isStop ? 0.8 : 0.35, glow: false, suffix: '' };
      const isDestructive = change.impact === 'direct' && (change.action === 'replace' || change.action === 'destroy');
      return {
        borderColor: isCurrent ? currentBorder : isDestructive ? PLAN_COLORS.dangerBorder : PLAN_COLORS.warningBorder,
        background: isDestructive ? PLAN_COLORS.dangerBackground : change.impact === 'downstream' ? PLAN_COLORS.warningBackground : NODE_BACKGROUND,
        opacity: 1,
        glow: true,
        suffix: change.impact === 'direct' ? ` (${change.action})` : '',
      };
    }

    // A walk through the system: the current stop shines, where we've been stays lit, the rest recedes.
    if (isCurrent) return { borderColor: currentBorder, background: NODE_BACKGROUND_SELECTED, opacity: 1, glow: true, suffix: '' };
    if (isRevealed) return { borderColor: defaultBorder, background: NODE_BACKGROUND_HIGHLIGHTED, opacity: 1, glow: true, suffix: '' };
    return { borderColor: defaultBorder, background: NODE_BACKGROUND, opacity: isStop ? 0.7 : 0.3, glow: false, suffix: '' };
  }

  function lookOutsideTour(nodeId: string, defaultBorder: string): NodeLook {
    const isSelected = nodeId === selectedNodeId;
    const isHighlighted = highlightedIds.has(nodeId);
    const planChange = planChangeByNodeId.get(nodeId);
    const isPlanActive = planChangeByNodeId.size > 0;

    // With a plan loaded, plan colors take over; otherwise show the click-to-highlight view.
    let borderColor = isSelected ? '#ddd6fe' : defaultBorder;
    let background = isSelected ? NODE_BACKGROUND_SELECTED : isHighlighted ? NODE_BACKGROUND_HIGHLIGHTED : NODE_BACKGROUND;
    let suffix = '';
    if (planChange?.impact === 'direct' && (planChange.action === 'replace' || planChange.action === 'destroy')) {
      borderColor = PLAN_COLORS.dangerBorder;
      background = PLAN_COLORS.dangerBackground;
    } else if (planChange?.impact === 'direct') {
      borderColor = PLAN_COLORS.warningBorder;
      background = NODE_BACKGROUND;
    } else if (planChange?.impact === 'downstream') {
      borderColor = PLAN_COLORS.warningBorder;
      background = PLAN_COLORS.warningBackground;
    }
    if (planChange?.impact === 'direct') suffix = ` (${planChange.action})`;

    const isDimmed = isPlanActive ? !planChange : selectedNodeId !== null && !isSelected && !isHighlighted;
    return { borderColor, background, opacity: isDimmed ? 0.3 : 1, glow: isSelected || isHighlighted || Boolean(planChange), suffix };
  }

  const flowNodes: Node[] = graph.nodes.map((node) => {
    const defaultBorder = CATEGORY_COLORS[getNodeCategory(node)];
    const look = activeJourney ? lookDuringTour(node.id, defaultBorder) : lookOutsideTour(node.id, defaultBorder);
    return {
      id: node.id,
      position: positions.get(node.id)!,
      data: { label: `${getNodeDisplayName(node)}${look.suffix}` },
      style: {
        width: NODE_WIDTH,
        fontSize: 12,
        color: '#f1f5f9',
        border: `2px solid ${look.borderColor}`,
        background: look.background,
        boxShadow: look.glow ? `0 0 12px ${look.borderColor}88` : undefined,
        opacity: look.opacity,
        transition: 'opacity 300ms, background 300ms, border-color 300ms',
      },
    };
  });

  const flowEdges: Edge[] = graph.edges.map((edge) => {
    let isOnPath: boolean;
    if (activeJourney) {
      isOnPath = revealedNodeIds.has(edge.source) && revealedNodeIds.has(edge.target);
    } else {
      isOnPath =
        selectedNodeId !== null &&
        (edge.source === selectedNodeId || highlightedIds.has(edge.source)) &&
        (edge.target === selectedNodeId || highlightedIds.has(edge.target));
    }
    const isFocusMode = activeJourney !== null || selectedNodeId !== null;
    const pathColor = tourKind === 'disaster' ? EDGE_COLOR_FAILING : EDGE_COLOR_ON_PATH;
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
        stroke: isOnPath ? pathColor : EDGE_COLOR,
        strokeWidth: isOnPath ? 2.5 : 1.5,
        opacity: isFocusMode && !isOnPath ? 0.25 : 1,
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

export default function GraphView() {
  return (
    <ReactFlowProvider>
      <GraphCanvas />
    </ReactFlowProvider>
  );
}
