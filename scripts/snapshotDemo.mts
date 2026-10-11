// Runs the backend's real analysis on its demo repo and saves the result for the frontend's /demo
// route, so the demo shows the true graph, findings and source with no backend or network.
//
//   npm run snapshot:demo
//
// Re-run it whenever the demo repo (backend/test/fixtures/demo) or the analysis changes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../backend/src/core/analysis/pipeline.ts';
import { loadFixture } from '../backend/test/helpers.ts';

const BACKSLASH = String.fromCharCode(92);
const RUN_ID = 'demo-run';

// The fixture loader returns Windows paths on Windows; GitHub downloads (and so real runs) use "/".
const files = loadFixture('demo').map((file) => ({ ...file, path: file.path.split(BACKSLASH).join('/') }));
const analysis = await analyze({ files });

const snapshot = {
  graph: { runId: RUN_ID, commitSha: null, nodes: analysis.nodes, edges: analysis.edges },
  findings: analysis.findings.map((finding, index) => ({
    ...finding,
    id: `demo-finding-${index}`,
    runId: RUN_ID,
    fingerprint: `demo-finding-${index}`,
  })),
  sourceFiles: Object.fromEntries(files.map((file) => [file.path, file.content])),
};

const outputPath = join(dirname(fileURLToPath(import.meta.url)), '../frontend/src/demo/demoSnapshot.json');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);

console.log(`Saved ${analysis.nodes.length} nodes, ${analysis.edges.length} edges, ${analysis.findings.length} findings and ${files.length} source files.`);
console.log(`  -> ${outputPath}`);
