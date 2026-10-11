import { create } from 'zustand';
import type { Direction } from '../../core/graph/blastRadius';
import { mockFindings, mockGraph } from '../../core/graph/mockGraph';
import { computePlanChanges } from '../../core/graph/planImpact';
import type { Finding, Graph, PlanChange } from '../../core/graph/types';
import { parsePlan } from '../../core/terraform/parsePlan';

interface GraphStoreState {
  graph: Graph;
  findings: Finding[];
  selectedNodeId: string | null;
  direction: Direction;
  /** Empty when no plan is loaded. */
  planChanges: PlanChange[];
  selectNode: (nodeId: string | null) => void;
  setDirection: (direction: Direction) => void;
  /** Returns an error message, or null on success. */
  applyPlan: (planJsonText: string) => string | null;
  clearPlan: () => void;
}

export const useGraphStore = create<GraphStoreState>((set, get) => ({
  graph: mockGraph,
  findings: mockFindings,
  selectedNodeId: null,
  direction: 'dependents',
  planChanges: [],
  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),
  setDirection: (direction) => set({ direction }),
  applyPlan: (planJsonText) => {
    try {
      const parsedChanges = parsePlan(planJsonText);
      set({ planChanges: computePlanChanges(get().graph, parsedChanges) });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Could not read the plan.';
    }
  },
  clearPlan: () => set({ planChanges: [] }),
}));
