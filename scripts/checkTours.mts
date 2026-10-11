// Accuracy check for the tours. Runs the backend's real analysis on its demo repo, builds the tours
// the frontend would show, then checks them against the repo and against what we planted in it.
//
//   npm run check:tours            checks and lists each tour's stops
//   npm run check:tours -- --say   also prints the script the guide speaks at every stop
//
// Nothing here runs the demo repo's code or touches the network; it only reads files.
import { analyze } from '../backend/src/core/analysis/pipeline.ts';
import { loadFixture } from '../backend/test/helpers.ts';
import { extractJourneys } from '../frontend/src/core/journeys/extractJourneys.ts';
import { buildDisasterJourney } from '../frontend/src/core/journeys/impactJourneys.ts';

const shouldPrintScripts = process.argv.includes('--say');
const BACKSLASH = String.fromCharCode(92);

// The fixture loader returns Windows paths (src\api\app.js) on Windows, which the analysis can't map to
// Terraform. Real GitHub downloads always use forward slashes, so normalise to match.
const files = loadFixture('demo').map((file) => ({ ...file, path: file.path.split(BACKSLASH).join('/') }));
const analysis = await analyze({ files });

const nodeById = new Map(analysis.nodes.map((node) => [node.id, node]));
const addressOf = (nodeId: string) => nodeById.get(nodeId)!.address;
const graph = { runId: 'check', commitSha: null, nodes: analysis.nodes, edges: analysis.edges } as never;
const findings = analysis.findings.map((finding, index) => ({
  ...finding,
  id: `finding-${index}`,
  runId: 'check',
  fingerprint: `finding-${index}`,
})) as never;

const journeys = extractJourneys(graph, findings);
const table = analysis.nodes.find((node) => node.address === 'aws_dynamodb_table.orders');
const disaster = table ? buildDisasterJourney(graph, findings, table.id) : null;

let failures = 0;
function check(description: string, passed: boolean, detail = '') {
  if (!passed) failures += 1;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${description}${passed || !detail ? '' : `\n        ${detail}`}`);
}

console.log('\nTours built from the demo repo');
for (const journey of [...journeys, ...(disaster ? [disaster] : [])]) {
  console.log(`\n  [${journey.kind}] ${journey.title}`);
  journey.stops.forEach((stop, index) => {
    console.log(`    ${index + 1}. ${addressOf(stop.nodeId)}${stop.inferred ? '  (inferred)' : ''}`);
    if (shouldPrintScripts) console.log(`       "${stop.script}"`);
  });
}

console.log('\nChecks');

// 1. The orders flow is the one a person reading the Terraform would trace by hand.
const wantedOrderFlow = [
  'aws_apigatewayv2_api.http',
  'aws_lambda_function.api',
  'aws_sqs_queue.jobs',
  'aws_lambda_function.worker',
  'aws_dynamodb_table.orders',
];
const workerJourney = journeys.find((journey) => journey.id.endsWith(`:${analysis.nodes.find((n) => n.address === 'aws_lambda_function.worker')?.id}`));
const workerFlow = workerJourney?.stops.map((stop) => addressOf(stop.nodeId)) ?? [];
check('A request enters the API, reaches the queue, and the worker writes the orders table', JSON.stringify(workerFlow) === JSON.stringify(wantedOrderFlow), `got ${JSON.stringify(workerFlow)}`);

const siteJourney = journeys.find((journey) => journey.kind === 'first_day' && addressOf(journey.stops[0].nodeId) === 'aws_route53_record.site');
const siteFlow = siteJourney?.stops.map((stop) => addressOf(stop.nodeId)) ?? [];
check(
  'The domain tour goes domain, CDN, bucket',
  JSON.stringify(siteFlow) === JSON.stringify(['aws_route53_record.site', 'aws_cloudfront_distribution.site', 'aws_s3_bucket.site']),
  `got ${JSON.stringify(siteFlow)}`,
);

// 2. The three planted traps show up as warnings on the right stops.
const warningsOn = (address: string) =>
  journeys.flatMap((journey) => journey.stops).filter((stop) => addressOf(stop.nodeId) === address).flatMap((stop) => stop.warnings);
const apiWarnings = warningsOn('aws_lambda_function.api').join(' | ');
check('The permission gap (cancelOrder / DeleteItem) is a warning on the api function', /cancelOrder/.test(apiWarnings) && /DeleteItem/.test(apiWarnings), apiWarnings);
check('The over-broad role (s3:*) is a warning on the api function', /s3:\*/.test(apiWarnings), apiWarnings);
check('The unmanaged bucket (legacy-reports) is a warning on the api function', /legacy-reports/.test(apiWarnings), apiWarnings);
check('The worker function has no false warnings', warningsOn('aws_lambda_function.worker').length === 0, warningsOn('aws_lambda_function.worker').join(' | '));

// 3. Every code citation points at a real file and a line that exists.
const lineCountByFile = new Map(files.map((file) => [file.path, file.content.split('\n').length]));
const badReferences: string[] = [];
for (const journey of journeys) {
  for (const stop of journey.stops) {
    for (const ref of stop.codeRefs) {
      const lineCount = lineCountByFile.get(ref.file);
      if (lineCount === undefined) badReferences.push(`${ref.file} does not exist`);
      else if (ref.startLine < 1 || ref.endLine > lineCount || ref.startLine > ref.endLine) badReferences.push(`${ref.file}:${ref.startLine}-${ref.endLine} is outside the file (${lineCount} lines)`);
    }
  }
}
check('Every file and line the guide cites exists in the repo', badReferences.length === 0, [...new Set(badReferences)].join('; '));

// 4. The guide only talks about things in the graph.
const unknownStops = journeys.flatMap((journey) => journey.stops).filter((stop) => !nodeById.has(stop.nodeId));
check('Every stop is a real node in the graph', unknownStops.length === 0);

// 5. Inferred links are labelled, and only inferred links.
const inferredEdgeCount = analysis.edges.filter((edge) => edge.confidence === 'inferred').length;
const inferredStopCount = journeys.flatMap((journey) => journey.stops).filter((stop) => stop.inferred).length;
check(
  'Stops are marked inferred only when the graph has inferred links',
  inferredEdgeCount > 0 || inferredStopCount === 0,
  `${inferredStopCount} inferred stops but ${inferredEdgeCount} inferred edges`,
);

// 6. The disaster tour reaches the things that really depend on the table.
const disasterAddresses = new Set(disaster?.stops.map((stop) => addressOf(stop.nodeId)));
for (const wanted of ['aws_lambda_function.api', 'aws_lambda_function.worker', 'src/api/app.js::getOrder', 'src/worker/main.py::process']) {
  check(`Losing the orders table takes down ${wanted}`, disasterAddresses.has(wanted));
}
check('Losing the orders table does not touch the unrelated site bucket', !disasterAddresses.has('aws_s3_bucket.site'));

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check${failures === 1 ? '' : 's'} failed.`);
process.exit(failures === 0 ? 0 : 1);
