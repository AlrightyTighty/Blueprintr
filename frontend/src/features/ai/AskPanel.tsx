import { useState, type FormEvent } from 'react';
import type { AskResult } from '../../core/graph/types';
import { getNodeDisplayName } from '../../core/graph/nodeDisplay';
import { askQuestion, type AiResult } from '../../services/analysisService';
import { useGraphStore } from '../graph-view/useGraphStore';
import { useTourStore } from '../tour-player/useTourStore';
import { speak } from '../voice/narrator';
import { PERSONAS } from '../voice/personas';

const EXAMPLE_QUESTION = 'What touches the orders table?';

export default function AskPanel() {
  const { projectId, graph, planChanges, planId, selectNode } = useGraphStore();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AiResult<AskResult> | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!question.trim()) return;
    setIsAsking(true);
    setErrorMessage(null);
    // Interrupting a tour: the guide stops talking and waits while the question is answered.
    const { activeJourney, personaId, pause } = useTourStore.getState();
    if (activeJourney) pause();
    try {
      const result = await askQuestion(question.trim(), { projectId, graph, planChanges, planId });
      setAnswer(result);
      // Mid-tour, the guide answers out loud in their own voice; the tour stays paused until Play.
      if (activeJourney) speak(result.data.answer, PERSONAS[personaId], () => undefined);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not get an answer.');
    } finally {
      setIsAsking(false);
    }
  }

  const citedNodes = (answer?.data.citedNodeIds ?? []).flatMap((nodeId) => {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    return node ? [node] : [];
  });

  return (
    <section className="flex flex-col gap-3 border-t border-indigo-900 p-4 text-sm">
      <h2 className="font-semibold text-indigo-200">Ask the graph</h2>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={EXAMPLE_QUESTION}
          className="min-w-0 flex-1 rounded border border-indigo-900 bg-indigo-950 px-2 py-1 text-slate-100 placeholder:text-slate-500"
        />
        <button
          type="submit"
          disabled={isAsking || !question.trim()}
          className="rounded bg-violet-600 px-3 py-1 text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
        >
          {isAsking ? '…' : 'Ask'}
        </button>
      </form>

      {errorMessage && <p className="text-rose-300">{errorMessage}</p>}

      {answer && (
        <div className="flex flex-col gap-2">
          <p className="text-slate-200">{answer.data.answer}</p>
          {citedNodes.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {citedNodes.map((node) => (
                <li key={node.id}>
                  <button
                    className="rounded bg-indigo-950 px-2 py-0.5 text-xs text-indigo-200 hover:bg-indigo-900"
                    onClick={() => selectNode(node.id)}
                  >
                    {getNodeDisplayName(node)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {answer.data.toolCalls.length > 0 && (
            <p className="text-xs text-slate-500">
              Graph queries: {answer.data.toolCalls.map((call) => `${call.op}(${call.node})`).join(', ')}
            </p>
          )}
          {answer.isOffline && (
            <p className="text-xs text-slate-500">Offline answer from keyword matching, not Gemini.</p>
          )}
        </div>
      )}
    </section>
  );
}
