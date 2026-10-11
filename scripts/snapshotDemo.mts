// Runs the backend's real analysis on its demo repo and saves the result for the frontend's /demo
// route, so the demo shows the true graph, findings and source with no backend or network.
//
//   npm run snapshot:demo
//
// Re-run it whenever the demo repo (backend/test/fixtures/demo) or the analysis changes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../backend/src/core/analysis/pipeline.ts';
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
  const sql = readFileSync(join(here, '../database/003_resource_types.sql'), 'utf8');
  const row = /\('([^']+)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'(#[0-9A-Fa-f]{6})',\s*\d+\)/g;
  const catalog = new Map<string, ResourceTypeRow>();
  for (const [, terraformType, service, displayName, category, iconKey, color] of sql.matchAll(row)) {
    catalog.set(terraformType, { terraformType, provider: 'aws', service, displayName, category, iconKey, color });
  }
  return catalog;
}
const catalog = readResourceTypeCatalog();
if (catalog.size === 0) throw new Error('Found no resource types in database/003_resource_types.sql.');
const nodes = analysis.nodes.map((node) => ({
  ...node,
  resourceType: (node.terraformType && catalog.get(node.terraformType)) || node.resourceType || null,
}));

const snapshot = {
  graph: { runId: RUN_ID, commitSha: null, nodes, edges: analysis.edges },
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

console.log(`Saved ${nodes.length} nodes (${nodes.filter((node) => node.resourceType).length} with catalog icons), ${analysis.edges.length} edges, ${analysis.findings.length} findings and ${files.length} source files.`);
console.log(`  -> ${outputPath}`);
