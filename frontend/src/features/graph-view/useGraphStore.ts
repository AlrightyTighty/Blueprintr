import { create } from 'zustand';
import { mockGraph } from '../../core/graph/mockGraph';
import type { Direction } from '../../core/graph/blastRadius';
import type { Graph, PlanAction } from '../../core/graph/types';
import { parsePlan } from '../../core/terraform/parsePlan';

interface GraphStoreState {
  graph: Graph;
  selectedNodeId: string | null;
  direction: Direction;
  /** Plan changes that matched a node in the graph, keyed by node id. Empty when no plan is loaded. */
  planActionsByNodeId: Map<string, PlanAction>;
  /** Plan addresses that matched no node (e.g. resource types the graph doesn't model). */
  unmatchedPlanAddresses: string[];
  selectNode: (nodeId: string | null) => void;
  setDirection: (direction: Direction) => void;
  /** Returns an error message, or null on success. */
  applyPlan: (planJsonText: string) => string | null;
  clearPlan: () => void;
}

export const useGraphStore = create<GraphStoreState>((set, get) => ({
  graph: mockGraph,
  selectedNodeId: null,
  direction: 'dependents',
  planActionsByNodeId: new Map(),
  unmatchedPlanAddresses: [],
  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),
  setDirection: (direction) => set({ direction }),
  applyPlan: (planJsonText) => {
    try {
      const actionsByAddress = parsePlan(planJsonText);
      const nodeIdsByLabel = new Map(get().graph.nodes.map((node) => [node.label, node.id]));
      const planActionsByNodeId = new Map<string, PlanAction>();
      const unmatchedPlanAddresses: string[] = [];
      for (const [address, action] of actionsByAddress) {
        const nodeId = nodeIdsByLabel.get(address);
        if (nodeId) planActionsByNodeId.set(nodeId, action);
        else unmatchedPlanAddresses.push(address);
      }
      set({ planActionsByNodeId, unmatchedPlanAddresses });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Could not read the plan.';
    }
  },
  clearPlan: () => set({ planActionsByNodeId: new Map(), unmatchedPlanAddresses: [] }),
}));
