import { useEffect, useState } from 'react';
import { getNodeDisplayName } from '../../core/graph/nodeDisplay';
import type { CodeRef } from '../../core/journeys/types';
import SoftBreak from '../../components/SoftBreak';
import { secondaryButtonClass } from '../../components/ui';
import NodeIcon from '../graph-view/NodeIcon';
import { useGraphStore } from '../graph-view/useGraphStore';
import { prefetchNarration, speak, stopSpeaking, type VoiceSource } from '../voice/narrator';
import { spokenTextFor } from '../voice/spokenText';
import { useVoiceStore } from '../voice/useVoiceStore';
import { findBlockEndLine, getSourceLines, getSourceUrl } from './sourceSnippets';
import { useTourStore } from './useTourStore';

/** Pause between one stop finishing and the next beginning, so the camera can arrive first. */
const PAUSE_BETWEEN_STOPS_MS = 900;

const iconButtonClass =
  'rounded bg-indigo-950 px-3 py-1 text-sm text-indigo-200 transition-colors hover:bg-indigo-900 disabled:opacity-40';

function SourceView({ projectId, label, reference, sourceBaseUrl }: {
  projectId: string;
  label: string;
  reference: CodeRef;
  sourceBaseUrl?: string;
}) {
  const lines = getSourceLines(projectId, reference);
  const url = getSourceUrl(sourceBaseUrl, reference);
  const lineRange =
    reference.startLine === reference.endLine ? `${reference.startLine}` : `${reference.startLine}-${reference.endLine}`;

  return (
    <div className="mb-3 min-w-0">
      <p className="mb-1 text-xs text-slate-400 wrap:anywhere">
        {label}: <SoftBreak text={reference.file} />:{lineRange}
      </p>
      {lines ? (
        <pre className="overflow-x-auto rounded border border-indigo-900 bg-slate-900 py-1 font-mono text-xs leading-5">
          {lines.map((line) => (
            <div key={line.number} className={line.isHighlighted ? 'bg-violet-900/60' : undefined}>
              <span className="inline-block w-8 select-none pr-2 text-right text-slate-600">{line.number}</span>
              <span className={line.isHighlighted ? 'text-slate-100' : 'text-slate-400'}>{line.text || ' '}</span>
            </div>
          ))}
        </pre>
      ) : (
        <p className="text-xs text-slate-500">Ripplemap never stores your source, so only the location is shown here.</p>
      )}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block rounded bg-indigo-950 px-2.5 py-1 text-xs text-indigo-200 transition-colors hover:bg-indigo-900"
        >
          Open on GitHub
        </a>
      )}
    </div>
  );
}

interface TourDockProps {
  projectId: string;
  /** e.g. https://github.com/acme/app/blob/main, for "Open on GitHub" links. */
  sourceBaseUrl?: string;
}

/** The tour player: caption, controls, and the real code beside the Terraform block for the current stop. */
export default function TourDock({ projectId, sourceBaseUrl }: TourDockProps) {
  const { activeJourney, stopIndex, status, next, previous, play, pause, endTour } = useTourStore();
  const graph = useGraphStore((state) => state.graph);
  const [voiceSource, setVoiceSource] = useState<VoiceSource | null>(null);
  const voiceMode = useVoiceStore((state) => state.mode);

  // Narrate the current stop while playing, then move on. Anything that changes the stop, persona
  // or voice mode restarts this, which also cancels the old speech (so switching to Off is instant).
  useEffect(() => {
    if (!activeJourney || status !== 'playing') {
      stopSpeaking();
      return;
    }
    const text = spokenTextFor(activeJourney, stopIndex);
    // Get the next line ready while this one plays, so a live line doesn't leave a gap.
    if (stopIndex + 1 < activeJourney.stops.length) prefetchNarration(spokenTextFor(activeJourney, stopIndex + 1));

    let advanceTimer: ReturnType<typeof setTimeout> | undefined;
    speak(
      text,
      () => {
        advanceTimer = setTimeout(() => useTourStore.getState().next(), PAUSE_BETWEEN_STOPS_MS);
      },
      setVoiceSource,
    );
    return () => {
      clearTimeout(advanceTimer);
      stopSpeaking();
    };
  }, [activeJourney, stopIndex, status, voiceMode]);

  if (!activeJourney) return null;

  const stop = activeJourney.stops[stopIndex];
  const node = graph.nodes.find((candidate) => candidate.id === stop.nodeId);
  const terraformRef: CodeRef | null =
    node?.filePath && node.lineStart
      ? {
          file: node.filePath,
          startLine: node.lineStart,
          endLine: node.lineEnd ?? findBlockEndLine(projectId, node.filePath, node.lineStart) ?? node.lineStart,
        }
      : null;
  const isCodeNode = node?.kind === 'code_file' || node?.kind === 'code_function';
  const codeRefs = stop.codeRefs.filter((reference) => !terraformRef || reference.file !== terraformRef.file);

  return (
    <section className="flex h-80 shrink-0 flex-col border-t border-indigo-900 bg-slate-950">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-indigo-900 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          {node && <NodeIcon node={node} size={36} className="shrink-0" />}
          <div className="min-w-0">
          <p className="truncate font-medium text-indigo-200">{activeJourney.title}</p>
          <p className="text-xs text-slate-400 wrap-anywhere">
            Stop {stopIndex + 1} of {activeJourney.stops.length}
            {node && (
              <>
                {' · '}
                <SoftBreak text={getNodeDisplayName(node)} />
              </>
            )}
            {status === 'finished' && ' · Tour finished'}
            {status === 'playing' && voiceSource && ` · Voice: ${{ elevenlabs: 'ElevenLabs', captions: 'no recording, captions only', off: 'off' }[voiceSource]}`}
          </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className={iconButtonClass} onClick={previous} disabled={stopIndex === 0} aria-label="Previous stop">
            Back
          </button>
          {status === 'playing' ? (
            <button className={iconButtonClass} onClick={pause}>
              Pause
            </button>
          ) : (
            <button className="rounded bg-violet-600 px-3 py-1 text-sm text-white hover:bg-violet-500" onClick={play}>
              {status === 'finished' ? 'Replay' : 'Play'}
            </button>
          )}
          <button
            className={iconButtonClass}
            onClick={next}
            disabled={stopIndex >= activeJourney.stops.length - 1}
            aria-label="Next stop"
          >
            Next
          </button>
          <button className={`${secondaryButtonClass} px-3! py-1!`} onClick={endTour}>
            End tour
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto px-4 py-3 md:grid-cols-3 md:overflow-hidden">
        <div className="min-w-0 text-sm wrap-anywhere md:overflow-y-auto md:pr-1">
          <p className="text-slate-100">
            <SoftBreak text={stop.script} />
          </p>
          {stop.inferred && (
            <span className="mt-2 inline-block rounded bg-violet-950 px-1.5 py-0.5 text-xs text-violet-300">inferred link</span>
          )}
          {stop.warnings.length > 0 && (
            <ul className="mt-2 space-y-1">
              {stop.warnings.map((warning) => (
                <li key={warning} className="rounded border border-amber-900 bg-amber-950/40 px-2 py-1 text-xs text-amber-200">
                  <SoftBreak text={warning} />
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500">Ask a question on the right and the tour will wait for you.</p>
        </div>
        <div className="min-w-0 md:overflow-y-auto md:pr-1">
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-blue-300">Application code</h3>
          {isCodeNode && terraformRef ? (
            <SourceView projectId={projectId} label="File" reference={terraformRef} sourceBaseUrl={sourceBaseUrl} />
          ) : codeRefs.length > 0 ? (
            codeRefs.map((reference) => (
              <SourceView
                key={`${reference.file}:${reference.startLine}`}
                projectId={projectId}
                label="Code"
                reference={reference}
                sourceBaseUrl={sourceBaseUrl}
              />
            ))
          ) : (
            <p className="text-xs text-slate-500">No application code touches this directly.</p>
          )}
        </div>
        <div className="min-w-0 md:overflow-y-auto md:pr-1">
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-violet-300">Terraform</h3>
          {terraformRef && !isCodeNode ? (
            <SourceView projectId={projectId} label="Block" reference={terraformRef} sourceBaseUrl={sourceBaseUrl} />
          ) : (
            <p className="text-xs text-slate-500">
              {isCodeNode ? 'This stop is application code.' : 'No Terraform location is known for this stop.'}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
