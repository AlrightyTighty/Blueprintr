import { create } from 'zustand';
import type { Finding, Graph, PlanChange } from '../../core/graph/types';
import { buildChangeJourney, buildDisasterJourney } from '../../core/journeys/impactJourneys';
import type { Journey } from '../../core/journeys/types';
import { stopSpeaking } from '../voice/narrator';
import { DEFAULT_PERSONA_ID, type PersonaId } from '../voice/personas';

export type TourStatus = 'idle' | 'playing' | 'paused' | 'finished';

interface TourStoreState {
  /** Tours that can be told from the graph alone. Disaster and change tours are built on demand. */
  journeys: Journey[];
  activeJourney: Journey | null;
  stopIndex: number;
  status: TourStatus;
  personaId: PersonaId;
  setJourneys: (journeys: Journey[]) => void;
  startJourney: (journey: Journey) => void;
  startDisaster: (graph: Graph, findings: Finding[], failedNodeId: string) => void;
  /** Returns false when the plan changes nothing that is in the graph. */
  startChange: (graph: Graph, findings: Finding[], planChanges: PlanChange[]) => boolean;
  next: () => void;
  previous: () => void;
  play: () => void;
  pause: () => void;
  endTour: () => void;
  setPersona: (personaId: PersonaId) => void;
}

export const useTourStore = create<TourStoreState>((set, get) => ({
  journeys: [],
  activeJourney: null,
  stopIndex: 0,
  status: 'idle',
  personaId: DEFAULT_PERSONA_ID,

  setJourneys: (journeys) => set({ journeys }),

  startJourney: (journey) => set({ activeJourney: journey, stopIndex: 0, status: 'playing' }),

  startDisaster: (graph, findings, failedNodeId) =>
    get().startJourney(buildDisasterJourney(graph, findings, failedNodeId)),

  startChange: (graph, findings, planChanges) => {
    const journey = buildChangeJourney(graph, findings, planChanges);
    if (!journey) return false;
    get().startJourney(journey);
    return true;
  },

  next: () => {
    const { activeJourney, stopIndex } = get();
    if (!activeJourney) return;
    if (stopIndex >= activeJourney.stops.length - 1) set({ status: 'finished' });
    else set({ stopIndex: stopIndex + 1 });
  },

  previous: () => {
    const { activeJourney, stopIndex, status } = get();
    if (!activeJourney) return;
    set({ stopIndex: Math.max(0, stopIndex - 1), status: status === 'finished' ? 'paused' : status });
  },

  play: () => {
    const { activeJourney, status } = get();
    if (!activeJourney) return;
    // Playing a finished tour starts it over.
    set(status === 'finished' ? { stopIndex: 0, status: 'playing' } : { status: 'playing' });
  },

  pause: () => {
    stopSpeaking();
    if (get().status === 'playing') set({ status: 'paused' });
  },

  endTour: () => {
    stopSpeaking();
    set({ activeJourney: null, stopIndex: 0, status: 'idle' });
  },

  setPersona: (personaId) => set({ personaId }),
}));
