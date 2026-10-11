import { useEffect, useState } from 'react';
import type { Briefing, FindingSeverity, PlanExplanation } from '../../core/graph/types';
import SoftBreak from '../../components/SoftBreak';
import { isDemoProject } from '../../config';
import { createBriefing, explainPlan, type AiResult } from '../../services/analysisService';
import { useGraphStore } from '../graph-view/useGraphStore';
import { speak, stopSpeaking } from '../voice/narrator';
import { useVoiceStore } from '../voice/useVoiceStore';

const SEVERITY_CLASSES: Record<FindingSeverity, string> = {
  info: 'bg-slate-800 text-slate-300',
  low: 'bg-blue-950 text-blue-300',
  medium: 'bg-violet-950 text-violet-300',
  high: 'bg-rose-950 text-rose-300',
  critical: 'bg-rose-900 text-rose-200',
};

const RECOMMENDATION_CLASSES: Record<Briefing['recommendation'], string> = {
  proceed: 'bg-blue-950 text-blue-300',
  caution: 'bg-amber-950 text-amber-300',
  stop: 'bg-rose-950 text-rose-300',
};

const buttonClass = 'rounded px-3 py-1 text-sm transition-colors disabled:opacity-50';

export default function PlanInsightsPanel() {
  const { projectId, graph, planChanges, planId } = useGraphStore();
  const [explanation, setExplanation] = useState<AiResult<PlanExplanation> | null>(null);
  const [briefing, setBriefing] = useState<AiResult<Briefing> | null>(null);
  const [busyAction, setBusyAction] = useState<'explain' | 'briefing' | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const voiceMode = useVoiceStore((state) => state.mode);

  // A new or cleared plan makes any earlier answer stale.
  useEffect(() => {
    setExplanation(null);
    setBriefing(null);
    setErrorMessage(null);
    stopSpeaking();
  }, [planChanges]);

  if (planChanges.length === 0) return null;

  const context = { projectId, graph, planChanges, planId };
  // On a real project the briefing is voiced by the server with ElevenLabs, which uses credits. The
  // offline briefing (the demo, or a plan the server never saw) costs nothing.
  const briefingCostsCredits = !isDemoProject(projectId) && planId !== null;
  const isBriefingBlocked = briefingCostsCredits && voiceMode !== 'live';

  async function run<Data>(action: 'explain' | 'briefing', work: () => Promise<Data>): Promise<Data | null> {
    setBusyAction(action);
    setErrorMessage(null);
    try {
      return await work();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Something went wrong.');
      return null;
    } finally {
      setBusyAction(null);
    }
  }

  async function handleExplain() {
    const result = await run('explain', () => explainPlan(context));
    if (result) setExplanation(result);
  }

  async function handleBriefing() {
    const result = await run('briefing', () => createBriefing(context));
    if (!result) return;
    setBriefing(result);
    // The server's audio plays by itself; an offline briefing goes through the guide's voice like any other line.
    if (!result.data.audioUrl) speak(result.data.script, () => undefined);
  }

  return (
    <section className="flex flex-col gap-3 border-t border-indigo-900 p-4 text-sm">
      <h2 className="font-semibold text-indigo-200">Risk and briefing</h2>
      <div className="flex gap-2">
        <button
          className={`${buttonClass} bg-violet-600 text-white hover:bg-violet-500`}
          disabled={busyAction !== null}
          onClick={handleExplain}
        >
          {busyAction === 'explain' ? 'Explaining…' : 'Explain risk'}
        </button>
        <button
          className={`${buttonClass} bg-indigo-950 text-indigo-200 hover:bg-indigo-900`}
          disabled={busyAction !== null || isBriefingBlocked}
          title={isBriefingBlocked ? 'Set Voice to Live to hear a briefing (it uses ElevenLabs credits).' : undefined}
          onClick={handleBriefing}
        >
          {busyAction === 'briefing' ? 'Preparing…' : 'Brief me'}
        </button>
      </div>

      {isBriefingBlocked && (
        <p className="text-xs text-slate-500">
          Brief me is spoken by ElevenLabs, which uses voice credits. Set Voice to Live (top bar) to use it.
        </p>
      )}
      {errorMessage && <p className="text-rose-300">{errorMessage}</p>}

      {explanation && (
        <div className="flex flex-col gap-2">
          <p className="text-slate-200">{explanation.data.explanation}</p>
          {explanation.data.risks.map((risk) => (
            <div key={risk.address} className="rounded border border-indigo-900 bg-indigo-950 p-2">
              <span className={`rounded px-1.5 py-0.5 text-xs ${SEVERITY_CLASSES[risk.severity]}`}>{risk.severity}</span>
              <p className="mt-1 text-xs text-slate-400 wrap:anywhere">
                <SoftBreak text={risk.address} />
              </p>
              <p className="text-slate-200">{risk.summary}</p>
            </div>
          ))}
          {explanation.data.saferAlternatives.length > 0 && (
            <div>
              <h3 className="mb-1 font-medium text-blue-300">Safer alternatives</h3>
              <ul className="space-y-1 text-slate-300">
                {explanation.data.saferAlternatives.map((alternative) => (
                  <li key={alternative.address}>
                    <span className="text-xs text-slate-500 wrap:anywhere">
                      <SoftBreak text={alternative.address} />
                    </span>
                    <br />
                    {alternative.suggestion}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-slate-500">
            {explanation.isOffline
              ? 'Offline summary from the local graph, not AI-generated.'
              : `Generated by ${explanation.data.model}. Review before acting.`}
          </p>
        </div>
      )}

      {briefing && (
        <div className="flex flex-col gap-2 rounded border border-indigo-900 bg-indigo-950 p-2">
          <span className={`self-start rounded px-1.5 py-0.5 text-xs uppercase ${RECOMMENDATION_CLASSES[briefing.data.recommendation]}`}>
            {briefing.data.recommendation}
          </span>
          <p className="text-slate-200">{briefing.data.script}</p>
          {briefing.data.audioUrl ? (
            <audio src={briefing.data.audioUrl} controls autoPlay className="w-full" />
          ) : (
            <button
              className={`${buttonClass} self-start bg-indigo-900 text-indigo-200 hover:bg-indigo-800`}
              onClick={() => speak(briefing.data.script, () => undefined)}
            >
              Play again
            </button>
          )}
          {briefing.isOffline && (
            <p className="text-xs text-slate-500">Offline briefing from the local graph. It is spoken only if the Voice setting allows.</p>
          )}
        </div>
      )}
    </section>
  );
}
