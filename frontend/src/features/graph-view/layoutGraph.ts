import dagre from '@dagrejs/dagre';
import type { Graph } from '../../core/graph/types';
import { NODE_HEIGHT, NODE_WIDTH } from './ResourceNode';

/** Returns a top-left position per node id, laid out left-to-right by dependency. */
export function layoutGraph(graph: Graph): Map<string, { x: number; y: number }> {
  const layout = new dagre.graphlib.Graph();
  layout.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 110 });
  layout.setDefaultEdgeLabel(() => ({}));

  for (const node of graph.nodes) {
    layout.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of graph.edges) {
    layout.setEdge(edge.source, edge.target);
  }
  dagre.layout(layout);

  const positions = new Map<string, { x: number; y: number }>();
  for (const node of graph.nodes) {
    const placed = layout.node(node.id);
    positions.set(node.id, { x: placed.x - NODE_WIDTH / 2, y: placed.y - NODE_HEIGHT / 2 });
  }
  return positions;
}
