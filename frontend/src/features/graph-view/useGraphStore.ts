import { create } from 'zustand';
import type { Direction } from '../../core/graph/blastRadius';
import { computePlanChanges } from '../../core/graph/planImpact';
import type { Finding, Graph, PlanChange } from '../../core/graph/types';
import { extractJourneys } from '../../core/journeys/extractJourneys';
import { parsePlan } from '../../core/terraform/parsePlan';
import { useTourStore } from '../tour-player/useTourStore';
import { isDemoProject } from '../../config';
import { fetchFindings, fetchGraph, uploadPlan } from '../../services/analysisService';

export type LoadStatus = 'loading' | 'ready' | 'error';

const EMPTY_GRAPH: Graph = { runId: '', nodes: [], edges: [] };

interface GraphStoreState {
  /** The project whose graph is loaded; the demo project id means bundled demo data. */
  projectId: string;
  graph: Graph;
  findings: Finding[];
  status: LoadStatus;
  errorMessage: string | null;
  selectedNodeId: string | null;
  direction: Direction;
  /** Empty when no plan is loaded. */
  planChanges: PlanChange[];
  /** Set when the backend analysed the plan; null for a plan analysed locally. */
  planId: string | null;
  /** Shown under the plan when the backend couldn't be used. */
  planNotice: string | null;
  loadGraph: (projectId: string) => Promise<void>;
  selectNode: (nodeId: string | null) => void;
  setDirection: (direction: Direction) => void;
  /** Returns an error message, or null on success. */
  applyPlan: (planJsonText: string) => Promise<string | null>;
  clearPlan: () => void;
}

export const useGraphStore = create<GraphStoreState>((set, get) => ({
  projectId: '',
  graph: EMPTY_GRAPH,
  findings: [],
  status: 'loading',
  errorMessage: null,
  selectedNodeId: null,
  direction: 'dependents',
  planChanges: [],
  planId: null,
  planNotice: null,

  loadGraph: async (projectId) => {
    // Start clean so a previous project's selection, plan and tour never show on this one.
    useTourStore.getState().endTour();
    useTourStore.getState().setJourneys([]);
    set({
      projectId,
      status: 'loading',
      errorMessage: null,
      selectedNodeId: null,
      planChanges: [],
      planId: null,
      planNotice: null,
    });
    try {
      const graph = await fetchGraph(projectId);
      const findings = await fetchFindings(projectId, graph.runId);
      // Ignore a slow response for a project the user has already navigated away from.
      if (get().projectId !== projectId) return;
      set({ graph, findings, status: 'ready' });
      useTourStore.getState().setJourneys(extractJourneys(graph, findings));
    } catch (error) {
      if (get().projectId !== projectId) return;
      set({ status: 'error', errorMessage: error instanceof Error ? error.message : 'Could not load the graph.' });
    }
  },

  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),
  setDirection: (direction) => set({ direction }),

  applyPlan: async (planJsonText) => {
    let localChanges: PlanChange[];
    try {
      localChanges = computePlanChanges(get().graph, parsePlan(planJsonText));
    } catch (error) {
      return error instanceof Error ? error.message : 'Could not read the plan.';
    }

    const { projectId } = get();
    if (isDemoProject(projectId)) {
      set({ planChanges: localChanges, planId: null, planNotice: null });
      return null;
    }

    try {
      const analysis = await uploadPlan(projectId, planJsonText);
      set({ planChanges: analysis.changes, planId: analysis.id, planNotice: null });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      set({
        planChanges: localChanges,
        planId: null,
        planNotice: `Backend unavailable (${reason}). Showing the analysis from this browser instead.`,
      });
    }
    return null;
  },

  clearPlan: () => set({ planChanges: [], planId: null, planNotice: null }),
}));
