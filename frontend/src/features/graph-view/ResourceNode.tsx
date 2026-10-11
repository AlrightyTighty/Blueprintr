import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { getNodeCategory, getNodeDisplayName, getShortName, getTypeCaption } from '../../core/graph/nodeDisplay';
import type { GraphNode } from '../../core/graph/types';
import NodeIcon from './NodeIcon';

/** How a node looks right now: set by the graph from selection, tour and plan state. */
export interface NodeLook {
  borderColor: string;
  background: string;
  opacity: number;
  glow: boolean;
  /** A small tag under the name, e.g. "replace" or "down". */
  badge: string | null;
}

export interface ResourceNodeData extends Record<string, unknown> {
  node: GraphNode;
  look: NodeLook;
  /** Open findings on this node (permission gap, drift...), shown as a warning count. */
  findingCount: number;
}

export type ResourceFlowNode = Node<ResourceNodeData, 'resource'>;

export const NODE_WIDTH = 150;
/** Used for layout spacing; the card itself grows a little taller when it carries a badge. */
export const NODE_HEIGHT = 132;

const ICON_SIZE = 52;
// Edges attach at the sides; the handles are only anchors, so they stay invisible.
const hiddenHandle = { opacity: 0, width: 1, height: 1, border: 'none', background: 'transparent' };

/** An architecture-diagram style node: the icon leads, the name and type sit quietly underneath. */
export default function ResourceNode({ data }: NodeProps<ResourceFlowNode>) {
  const { node, look, findingCount } = data;
  const accentColor = node.resourceType?.color;
  const isUnmanaged = getNodeCategory(node) === 'unmanaged';

  return (
    <div
      title={getNodeDisplayName(node)}
      className="relative flex flex-col items-center rounded-lg px-2 pb-2 pt-3 text-center"
      style={{
        width: NODE_WIDTH,
        minHeight: NODE_HEIGHT - 20,
        border: `2px ${isUnmanaged ? 'dashed' : 'solid'} ${look.borderColor}`,
        background: look.background,
        boxShadow: look.glow ? `0 0 14px ${look.borderColor}88` : undefined,
        opacity: look.opacity,
        transition: 'opacity 300ms, background 300ms, border-color 300ms',
      }}
    >
      {accentColor && (
        <span aria-hidden="true" className="absolute inset-x-3 top-0 h-[3px] rounded-b" style={{ background: accentColor }} />
      )}
      {findingCount > 0 && (
        <span
          aria-label={`${findingCount} finding${findingCount === 1 ? '' : 's'}`}
          className="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-[11px] font-bold text-slate-950"
        >
          {findingCount}
        </span>
      )}

      <NodeIcon node={node} size={ICON_SIZE} />
      <span className="mt-1.5 w-full truncate text-[13px] font-medium leading-tight text-slate-100">{getShortName(node)}</span>
      <span className="w-full truncate text-[10px] leading-tight text-slate-400">{getTypeCaption(node)}</span>
      {look.badge && (
        <span
          className="mt-1 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-slate-100"
          style={{ border: `1px solid ${look.borderColor}` }}
        >
          {look.badge}
        </span>
      )}

      <Handle type="target" position={Position.Left} style={hiddenHandle} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={hiddenHandle} isConnectable={false} />
    </div>
  );
}
