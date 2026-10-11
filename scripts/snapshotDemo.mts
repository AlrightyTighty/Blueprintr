// Runs the backend's real analysis on its demo repo and saves the result for the frontend's /demo
// route, so the demo shows the true graph, findings and source with no backend or network.
//
//   npm run snapshot:demo
//
// Re-run it whenever the demo repo (backend/test/fixtures/demo) or the analysis changes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../backend/src/core/analysis/pipeline.ts';
import { listEndpoints } from '../backend/src/core/endpoints/list.ts';
import { traceRequest } from '../backend/src/core/endpoints/trace.ts';
import { loadFixture } from '../backend/test/helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const BACKSLASH = String.fromCharCode(92);
const RUN_ID = 'demo-run';

// The fixture loader returns Windows paths on Windows; GitHub downloads (and so real runs) use "/".
const files = loadFixture('demo').map((file) => ({ ...file, path: file.path.split(BACKSLASH).join('/') }));
const analysis = await analyze({ files });

// The display catalog (icon, name, colour per Terraform type) lives in the database seed. Read it from
// the same SQL file so the demo shows exactly what a real run does, without a database.
interface ResourceTypeRow {
  terraformType: string;
  provider: string;
  service: string;
  displayName: string;
  category: string;
  iconKey: string;
  color: string;
}
function readResourceTypeCatalog(): Map<string, ResourceTypeRow> {
  // The catalog is seeded by one migration and extended by later ones, so read every migration's rows.
  const row = /\('([^']+)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'(#[0-9A-Fa-f]{6})',\s*\d+\)/g;
  const catalog = new Map<string, ResourceTypeRow>();
  const databaseDir = join(here, '../database');
  for (const file of readdirSync(databaseDir).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort()) {
    const sql = readFileSync(join(databaseDir, file), 'utf8');
    for (const [, terraformType, service, displayName, category, iconKey, color] of sql.matchAll(row)) {
      catalog.set(terraformType, { terraformType, provider: 'aws', service, displayName, category, iconKey, color });
    }
  }
  return catalog;
}
const catalog = readResourceTypeCatalog();
if (catalog.size === 0) throw new Error('Found no resource types in the database migrations.');
const nodes = analysis.nodes.map((node) => ({
  ...node,
  resourceType: (node.terraformType && catalog.get(node.terraformType)) || node.resourceType || null,
}));

const graph = { runId: RUN_ID, commitSha: null, nodes, edges: analysis.edges };

// Every endpoint, and the trace of a request to it, so the demo's endpoint tours need no backend. The path
// is a sample ({id} becomes 123), because the demo can only follow requests it has already traced.
const sampleValue = (name: string) => (name === 'id' ? '123' : name.endsWith('+') ? 'a/b' : `sample-${name}`);
const samplePath = (template: string) => template.replace(/\{([^}]+)\}/g, (_match, name: string) => sampleValue(name));
const endpoints = listEndpoints(graph as never);
const traces = Object.fromEntries(
  endpoints.flatMap((endpoint) => {
    const outcome = traceRequest(graph as never, {
      method: endpoint.method === 'ANY' ? 'GET' : endpoint.method,
      path: samplePath(endpoint.path),
      endpointId: endpoint.id,
    });
    return outcome.found ? [[endpoint.id, outcome.trace]] : [];
  }),
);

const snapshot = {
  graph,
  endpoints,
  traces,
  findings: analysis.findings.map((finding, index) => ({
    ...finding,
    id: `demo-finding-${index}`,
    runId: RUN_ID,
    fingerprint: `demo-finding-${index}`,
  })),
  sourceFiles: Object.fromEntries(files.map((file) => [file.path, file.content])),
};

const outputPath = join(here, '../frontend/src/demo/demoSnapshot.json');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);

console.log(`Saved ${endpoints.length} endpoints with ${Object.keys(traces).length} traces.`);
console.log(`Saved ${nodes.length} nodes (${nodes.filter((node) => node.resourceType).length} with catalog icons), ${analysis.edges.length} edges, ${analysis.findings.length} findings and ${files.length} source files.`);
console.log(`  -> ${outputPath}`);
