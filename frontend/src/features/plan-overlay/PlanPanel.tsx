import { useState } from 'react';
import { computePlanImpact } from '../../core/graph/planImpact';
import { useGraphStore } from '../graph-view/useGraphStore';
import { SAMPLE_PLAN_JSON } from './samplePlan';

export default function PlanPanel() {
  const { graph, planActionsByNodeId, unmatchedPlanAddresses, applyPlan, clearPlan } = useGraphStore();
  const [planText, setPlanText] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isPlanLoaded = planActionsByNodeId.size > 0;
  const impact = computePlanImpact(graph, planActionsByNodeId);
  const labelOf = (nodeId: string) => graph.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;

  function handleApply(text: string) {
    setErrorMessage(applyPlan(text));
  }

  function handleLoadSample() {
    setPlanText(SAMPLE_PLAN_JSON);
    handleApply(SAMPLE_PLAN_JSON);
  }

  function handleClear() {
    clearPlan();
    setPlanText('');
    setErrorMessage(null);
  }

  const buttonClass = 'rounded px-3 py-1 text-sm transition-colors';

  return (
    <aside className="flex w-80 flex-col gap-3 overflow-y-auto border-l border-indigo-900 bg-slate-950 p-4">
      <h2 className="font-semibold text-indigo-200">Plan blast radius</h2>
      <p className="text-xs text-slate-400">
        Paste <code className="text-violet-300">terraform show -json plan.out</code>. The plan is only read, never
        applied.
      </p>

      <textarea
        value={planText}
        onChange={(event) => setPlanText(event.target.value)}
        placeholder='{"resource_changes": [...]}'
        className="h-40 resize-none rounded border border-indigo-900 bg-indigo-950 p-2 font-mono text-xs text-slate-100 placeholder:text-slate-500"
      />

      <div className="flex flex-wrap gap-2">
        <button className={`${buttonClass} bg-violet-600 text-white hover:bg-violet-500`} onClick={() => handleApply(planText)}>
          Apply plan
        </button>
        <button className={`${buttonClass} bg-indigo-950 text-indigo-200 hover:bg-indigo-900`} onClick={handleLoadSample}>
          Load sample
        </button>
        {(isPlanLoaded || planText) && (
          <button className={`${buttonClass} bg-indigo-950 text-indigo-200 hover:bg-indigo-900`} onClick={handleClear}>
            Clear
          </button>
        )}
      </div>

      {errorMessage && <p className="text-sm text-rose-300">{errorMessage}</p>}

      {isPlanLoaded && (
        <div className="flex flex-col gap-3 text-sm">
          <section>
            <h3 className="mb-1 font-medium text-rose-300">Changed directly</h3>
            <ul className="space-y-1">
              {[...impact.changedNodeIds].map(([nodeId, action]) => (
                <li key={nodeId} className="text-slate-200">
                  <span className="mr-2 rounded bg-rose-950 px-1.5 py-0.5 text-xs uppercase text-rose-300">{action}</span>
                  {labelOf(nodeId)}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3 className="mb-1 font-medium text-amber-300">Affected downstream ({impact.downstreamNodeIds.size})</h3>
            <ul className="space-y-1 text-slate-300">
              {[...impact.downstreamNodeIds].map((nodeId) => (
                <li key={nodeId}>{labelOf(nodeId)}</li>
              ))}
              {impact.downstreamNodeIds.size === 0 && <li className="text-slate-500">Nothing depends on these.</li>}
            </ul>
          </section>
          {unmatchedPlanAddresses.length > 0 && (
            <p className="text-xs text-slate-500">Not in graph: {unmatchedPlanAddresses.join(', ')}</p>
          )}
        </div>
      )}
    </aside>
  );
}
