import { useState } from 'react';
import { useGraphStore } from '../graph-view/useGraphStore';
import { SAMPLE_PLAN_JSON } from './samplePlan';

export default function PlanPanel() {
  const { planChanges, planNotice, applyPlan, clearPlan } = useGraphStore();
  const [planText, setPlanText] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const directChanges = planChanges.filter((change) => change.impact === 'direct' && change.nodeId);
  const downstreamChanges = planChanges
    .filter((change) => change.impact === 'downstream')
    .sort((first, second) => first.distance - second.distance);
  const unmatchedAddresses = planChanges.filter((change) => !change.nodeId).map((change) => change.address);
  const isPlanLoaded = planChanges.length > 0;

  async function handleApply(text: string) {
    setIsApplying(true);
    setErrorMessage(await applyPlan(text));
    setIsApplying(false);
  }

  function handleLoadSample() {
    setPlanText(SAMPLE_PLAN_JSON);
    void handleApply(SAMPLE_PLAN_JSON);
  }

  function handleClear() {
    clearPlan();
    setPlanText('');
    setErrorMessage(null);
  }

  const buttonClass = 'rounded px-3 py-1 text-sm transition-colors';

  return (
    <section className="flex flex-col gap-3 p-4">
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
        <button
          className={`${buttonClass} bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50`}
          disabled={isApplying}
          onClick={() => void handleApply(planText)}
        >
          {isApplying ? 'Analysing…' : 'Apply plan'}
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
      {planNotice && <p className="text-xs text-amber-300">{planNotice}</p>}

      {isPlanLoaded && (
        <div className="flex flex-col gap-3 text-sm">
          <section>
            <h3 className="mb-1 font-medium text-rose-300">Changed directly</h3>
            <ul className="space-y-1">
              {directChanges.map((change) => (
                <li key={change.id} className="text-slate-200">
                  <span className="mr-2 rounded bg-rose-950 px-1.5 py-0.5 text-xs uppercase text-rose-300">
                    {change.action}
                  </span>
                  {change.address}
                </li>
              ))}
              {directChanges.length === 0 && <li className="text-slate-500">None of these are in the graph.</li>}
            </ul>
          </section>
          <section>
            <h3 className="mb-1 font-medium text-amber-300">Affected downstream ({downstreamChanges.length})</h3>
            <ul className="space-y-1 text-slate-300">
              {downstreamChanges.map((change) => (
                <li key={change.id}>
                  {change.address}
                  <span className="ml-2 text-xs text-slate-500">{change.distance} hop{change.distance === 1 ? '' : 's'}</span>
                </li>
              ))}
              {downstreamChanges.length === 0 && <li className="text-slate-500">Nothing depends on these.</li>}
            </ul>
          </section>
          {unmatchedAddresses.length > 0 && (
            <p className="text-xs text-slate-500">Not in graph: {unmatchedAddresses.join(', ')}</p>
          )}
        </div>
      )}
    </section>
  );
}
