import type { FindingKind, GraphEdge } from '../../core/graph/types';
import { useGraphStore } from '../graph-view/useGraphStore';

const FINDING_LABELS: Record<FindingKind, { title: string; badgeClass: string }> = {
  permission_gap: { title: 'Permission gap', badgeClass: 'bg-rose-950 text-rose-300' },
  over_broad_iam: { title: 'Over-broad IAM', badgeClass: 'bg-amber-950 text-amber-300' },
  unmanaged_resource: { title: 'Unmanaged resource', badgeClass: 'bg-violet-950 text-violet-300' },
};

const CONFIDENCE_CLASSES: Record<GraphEdge['confidence'], string> = {
  certain: 'text-blue-300',
  high: 'text-indigo-300',
  inferred: 'text-violet-300',
};

export default function FindingsPanel() {
  const { graph, selectedNodeId, selectNode } = useGraphStore();

  const labelOf = (nodeId: string) => graph.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);
  const nodesWithFindings = graph.nodes.filter((node) => node.findings.length > 0);

  function renderConnection(edge: GraphEdge, connectedNodeId: string) {
    return (
      <li key={edge.id}>
        <button
          className="w-full rounded px-2 py-1 text-left hover:bg-indigo-950"
          onClick={() => selectNode(connectedNodeId)}
        >
          <span className="text-slate-200">{labelOf(connectedNodeId)}</span>
          <span className="ml-2 text-xs text-slate-400">{edge.kind}</span>
          <span className={`ml-2 text-xs ${CONFIDENCE_CLASSES[edge.confidence]}`}>{edge.confidence}</span>
        </button>
      </li>
    );
  }

  return (
    <aside className="flex w-80 flex-col gap-4 overflow-y-auto border-r border-indigo-900 bg-slate-950 p-4 text-sm">
      {selectedNode ? (
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="break-all font-semibold text-indigo-200">{selectedNode.label}</h2>
            <p className="text-xs text-slate-400">
              {selectedNode.type.replace('_', ' ')}
              {selectedNode.resourceType && ` · ${selectedNode.resourceType}`}
            </p>
          </div>

          {selectedNode.findings.map((finding) => (
            <div key={finding.message} className="rounded border border-indigo-900 bg-indigo-950 p-2">
              <span className={`rounded px-1.5 py-0.5 text-xs ${FINDING_LABELS[finding.kind].badgeClass}`}>
                {FINDING_LABELS[finding.kind].title}
              </span>
              <p className="mt-1 text-slate-200">{finding.message}</p>
            </div>
          ))}

          <div>
            <h3 className="mb-1 font-medium text-blue-300">Uses</h3>
            <ul>
              {graph.edges.filter((edge) => edge.source === selectedNode.id).map((edge) => renderConnection(edge, edge.target))}
              {!graph.edges.some((edge) => edge.source === selectedNode.id) && (
                <li className="px-2 text-slate-500">Nothing</li>
              )}
            </ul>
          </div>
          <div>
            <h3 className="mb-1 font-medium text-violet-300">Used by</h3>
            <ul>
              {graph.edges.filter((edge) => edge.target === selectedNode.id).map((edge) => renderConnection(edge, edge.source))}
              {!graph.edges.some((edge) => edge.target === selectedNode.id) && (
                <li className="px-2 text-slate-500">Nothing</li>
              )}
            </ul>
          </div>
        </section>
      ) : (
        <p className="text-slate-400">Click a node to see what it uses and what depends on it.</p>
      )}

      <section>
        <h2 className="mb-2 font-semibold text-indigo-200">Findings ({nodesWithFindings.length})</h2>
        <ul className="space-y-2">
          {nodesWithFindings.flatMap((node) =>
            node.findings.map((finding) => (
              <li key={`${node.id}-${finding.message}`}>
                <button
                  className="w-full rounded border border-indigo-900 bg-indigo-950 p-2 text-left hover:border-violet-500"
                  onClick={() => selectNode(node.id)}
                >
                  <span className={`rounded px-1.5 py-0.5 text-xs ${FINDING_LABELS[finding.kind].badgeClass}`}>
                    {FINDING_LABELS[finding.kind].title}
                  </span>
                  <p className="mt-1 break-all text-xs text-slate-400">{node.label}</p>
                  <p className="text-slate-200">{finding.message}</p>
                </button>
              </li>
            )),
          )}
        </ul>
      </section>
    </aside>
  );
}
