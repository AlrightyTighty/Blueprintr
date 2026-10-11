import { CATEGORY_LABELS, getNodeCategory, getNodeDisplayName } from '../../core/graph/nodeDisplay';
import type { FindingKind, FindingSeverity, GraphEdge } from '../../core/graph/types';
import { useGraphStore } from '../graph-view/useGraphStore';

const FINDING_KIND_TITLES: Record<FindingKind, string> = {
  permission_gap: 'Permission gap',
  over_broad_iam: 'Over-broad IAM',
  unmanaged_resource: 'Unmanaged resource',
  unresolved_reference: 'Unresolved reference',
};

const SEVERITY_BADGE_CLASSES: Record<FindingSeverity, string> = {
  info: 'bg-slate-800 text-slate-300',
  low: 'bg-blue-950 text-blue-300',
  medium: 'bg-violet-950 text-violet-300',
  high: 'bg-rose-950 text-rose-300',
  critical: 'bg-rose-900 text-rose-200',
};

const CONFIDENCE_CLASSES: Record<GraphEdge['confidence'], string> = {
  certain: 'text-blue-300',
  high: 'text-indigo-300',
  inferred: 'text-violet-300',
};

export default function FindingsPanel() {
  const { graph, findings, selectedNodeId, selectNode } = useGraphStore();

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const displayNameOf = (nodeId: string) => {
    const node = nodeById.get(nodeId);
    return node ? getNodeDisplayName(node) : nodeId;
  };
  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) : undefined;
  const openFindings = findings.filter((finding) => !finding.dismissedAt);
  const selectedNodeFindings = openFindings.filter((finding) => finding.nodeId === selectedNodeId);
  const outgoingEdges = graph.edges.filter((edge) => edge.source === selectedNodeId);
  const incomingEdges = graph.edges.filter((edge) => edge.target === selectedNodeId);

  function renderFindingBadges(kind: FindingKind, severity: FindingSeverity) {
    return (
      <span className="flex gap-1">
        <span className="rounded bg-indigo-900 px-1.5 py-0.5 text-xs text-indigo-200">{FINDING_KIND_TITLES[kind]}</span>
        <span className={`rounded px-1.5 py-0.5 text-xs ${SEVERITY_BADGE_CLASSES[severity]}`}>{severity}</span>
      </span>
    );
  }

  function renderConnection(edge: GraphEdge, connectedNodeId: string) {
    const evidenceText = edge.explanation ?? (edge.evidence ? JSON.stringify(edge.evidence) : undefined);
    return (
      <li key={edge.id}>
        <button
          className="w-full rounded px-2 py-1 text-left hover:bg-indigo-950"
          onClick={() => selectNode(connectedNodeId)}
          title={evidenceText}
        >
          <span className="break-all text-slate-200">{displayNameOf(connectedNodeId)}</span>
          <span className="ml-2 text-xs text-slate-400">{edge.relation.replace('_', ' ')}</span>
          <span className={`ml-2 text-xs ${CONFIDENCE_CLASSES[edge.confidence]}`}>{edge.confidence}</span>
        </button>
      </li>
    );
  }

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-4 text-sm">
      {selectedNode ? (
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="break-all font-semibold text-indigo-200">{getNodeDisplayName(selectedNode)}</h2>
            <p className="text-xs text-slate-400">
              {CATEGORY_LABELS[getNodeCategory(selectedNode)]}
              {selectedNode.terraformType && ` · ${selectedNode.terraformType}`}
            </p>
          </div>

          {selectedNodeFindings.map((finding) => (
            <div key={finding.id} className="rounded border border-indigo-900 bg-indigo-950 p-2">
              {renderFindingBadges(finding.kind, finding.severity)}
              <p className="mt-1 text-slate-200">{finding.detail ?? finding.title}</p>
            </div>
          ))}

          <div>
            <h3 className="mb-1 font-medium text-blue-300">Uses</h3>
            <ul>
              {outgoingEdges.map((edge) => renderConnection(edge, edge.target))}
              {outgoingEdges.length === 0 && <li className="px-2 text-slate-500">Nothing</li>}
            </ul>
          </div>
          <div>
            <h3 className="mb-1 font-medium text-violet-300">Used by</h3>
            <ul>
              {incomingEdges.map((edge) => renderConnection(edge, edge.source))}
              {incomingEdges.length === 0 && <li className="px-2 text-slate-500">Nothing</li>}
            </ul>
          </div>
        </section>
      ) : (
        <p className="text-slate-400">Click a node to see what it uses and what depends on it.</p>
      )}

      <section>
        <h2 className="mb-2 font-semibold text-indigo-200">Findings ({openFindings.length})</h2>
        <ul className="space-y-2">
          {openFindings.map((finding) => (
            <li key={finding.id}>
              <button
                className="w-full rounded border border-indigo-900 bg-indigo-950 p-2 text-left hover:border-violet-500 disabled:cursor-default disabled:hover:border-indigo-900"
                disabled={!finding.nodeId}
                onClick={() => finding.nodeId && selectNode(finding.nodeId)}
              >
                {renderFindingBadges(finding.kind, finding.severity)}
                {finding.nodeId && <p className="mt-1 break-all text-xs text-slate-400">{displayNameOf(finding.nodeId)}</p>}
                <p className="text-slate-200">{finding.title}</p>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
