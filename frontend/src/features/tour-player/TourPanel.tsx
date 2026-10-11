import { useState } from 'react';
import { getNodeDisplayName } from '../../core/graph/nodeDisplay';
import type { Journey } from '../../core/journeys/types';
import { primaryButtonClass, secondaryButtonClass } from '../../components/ui';
import FindingsPanel from '../findings/FindingsPanel';
import { useGraphStore } from '../graph-view/useGraphStore';
import PersonaSelect from '../voice/PersonaSelect';
import { useTourStore } from './useTourStore';

type Tab = 'tours' | 'details';

function JourneyList({ title, journeys }: { title: string; journeys: Journey[] }) {
  const { activeJourney, startJourney } = useTourStore();
  if (journeys.length === 0) return null;

  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">{title}</h3>
      <ul className="space-y-2">
        {journeys.map((journey) => {
          const warningCount = journey.stops.filter((stop) => stop.warnings.length > 0).length;
          return (
            <li key={journey.id}>
              <button
                className={`w-full rounded border p-2 text-left transition-colors hover:border-violet-500 ${
                  activeJourney?.id === journey.id ? 'border-violet-500 bg-indigo-900' : 'border-indigo-900 bg-indigo-950'
                }`}
                onClick={() => startJourney(journey)}
              >
                <span className="block text-slate-100">{journey.title}</span>
                <span className="text-xs text-slate-400">
                  {journey.stops.length} stops
                  {warningCount > 0 && <span className="text-amber-300"> · {warningCount} warning{warningCount === 1 ? '' : 's'}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Left sidebar: pick a tour, or look at a node and its findings. */
export default function TourPanel() {
  const [tab, setTab] = useState<Tab>('tours');
  const { graph, findings, selectedNodeId, planChanges } = useGraphStore();
  const { journeys, startDisaster, startChange } = useTourStore();
  const [changeTourMessage, setChangeTourMessage] = useState<string | null>(null);

  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);
  const tabClass = (isActive: boolean) =>
    `flex-1 border-b-2 px-3 py-2 text-sm transition-colors ${
      isActive ? 'border-violet-500 text-indigo-100' : 'border-transparent text-slate-400 hover:text-slate-200'
    }`;

  function handleChangeTour() {
    const started = startChange(graph, findings, planChanges);
    setChangeTourMessage(started ? null : "This plan doesn't change anything that is in the graph.");
  }

  return (
    <aside className="flex w-80 flex-col border-r border-indigo-900 bg-slate-950">
      <div className="flex border-b border-indigo-900">
        <button className={tabClass(tab === 'tours')} onClick={() => setTab('tours')}>
          Tours
        </button>
        <button className={tabClass(tab === 'details')} onClick={() => setTab('details')}>
          Details & findings
        </button>
      </div>

      {tab === 'details' && <FindingsPanel />}

      {tab === 'tours' && (
        <div className="flex flex-col gap-5 overflow-y-auto p-4 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Your guide</span>
            <PersonaSelect />
          </div>

          <JourneyList title="First day" journeys={journeys.filter((journey) => journey.kind === 'first_day')} />
          <JourneyList title="Follow a request" journeys={journeys.filter((journey) => journey.kind === 'request')} />
          {journeys.length === 0 && (
            <p className="text-slate-500">
              No tours yet: the graph has no domain, API gateway or function to start from.
            </p>
          )}

          <section className="flex flex-col gap-2 rounded border border-indigo-900 p-3">
            <h3 className="font-medium text-rose-300">Disaster tour</h3>
            {selectedNode ? (
              <>
                <p className="break-all text-slate-300">Lose {getNodeDisplayName(selectedNode)}?</p>
                <button className={primaryButtonClass} onClick={() => startDisaster(graph, findings, selectedNode.id)}>
                  Pull the plug
                </button>
              </>
            ) : (
              <p className="text-slate-500">Click a resource in the graph, then pull the plug on it.</p>
            )}
          </section>

          <section className="flex flex-col gap-2 rounded border border-indigo-900 p-3">
            <h3 className="font-medium text-amber-300">Change tour</h3>
            {planChanges.length > 0 ? (
              <>
                <p className="text-slate-300">Walk through what the loaded plan touches.</p>
                <button className={secondaryButtonClass} onClick={handleChangeTour}>
                  Tour this plan
                </button>
                {changeTourMessage && <p className="text-xs text-slate-400">{changeTourMessage}</p>}
              </>
            ) : (
              <p className="text-slate-500">Paste a Terraform plan on the right to tour what it would change.</p>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}
