// Generates the guide's voice for the demo tours and example answers with ElevenLabs, in the ONE voice
// set as ELEVENLABS_VOICE_ID in backend/.env, and saves the clips under
// frontend/public/narration, so the site plays them with no key in the browser and no network at
// show time. Reads the key from backend/.env (never printed, never committed).
//
//   npm run narrate:demo -- --dry-run     list what would be generated and what it would cost
//   npm run narrate:demo                  generate any clips that don't exist yet
//   npm run narrate:demo -- --force       regenerate every clip
//
// Run `npm run snapshot:demo` first if the demo repo changed. Clips are named after the exact words,
// so changing a script just means running this again.
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePlanChanges } from '../frontend/src/core/graph/planImpact.ts';
import { extractJourneys } from '../frontend/src/core/journeys/extractJourneys.ts';
import { buildChangeJourney, buildDisasterJourney } from '../frontend/src/core/journeys/impactJourneys.ts';
import type { Journey } from '../frontend/src/core/journeys/types.ts';
import { parsePlan } from '../frontend/src/core/terraform/parsePlan.ts';
import { SAMPLE_PLAN_JSON } from '../frontend/src/features/plan-overlay/samplePlan.ts';
import { narrationKey } from '../frontend/src/features/voice/narrationKey.ts';
import { GUIDE } from '../frontend/src/features/voice/personas.ts';
import { DEMO_EXAMPLE_QUESTIONS } from '../frontend/src/demo/exampleQuestions.ts';
import { answerOffline } from '../frontend/src/services/mockAi.ts';
import { spokenTextFor } from '../frontend/src/features/voice/spokenText.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outputDirectory = join(here, '../frontend/public/narration');
const isDryRun = process.argv.includes('--dry-run');
const shouldForce = process.argv.includes('--force');
const API = 'https://api.elevenlabs.io/v1';

// ---- Settings from backend/.env (values are never logged) ----
function readEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return values;
}
const env = readEnvFile(join(here, '../backend/.env'));
const apiKey = env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error('ELEVENLABS_API_KEY is not set in backend/.env.');
  process.exit(1);
}
const modelId = env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';

// ---- The tours to voice: every demo tour, plus the disaster and change tours ----
const snapshot = JSON.parse(readFileSync(join(here, '../frontend/src/demo/demoSnapshot.json'), 'utf8'));
const { graph, findings } = snapshot;

const journeys: Journey[] = extractJourneys(graph, findings);
const orders = graph.nodes.find((node: { address: string }) => node.address === 'aws_dynamodb_table.orders');
if (orders) journeys.push(buildDisasterJourney(graph, findings, orders.id));
const changeJourney = buildChangeJourney(graph, findings, computePlanChanges(graph, parsePlan(SAMPLE_PLAN_JSON)));
if (changeJourney) journeys.push(changeJourney);

interface Clip {
  key: string;
  text: string;
}
const clips = new Map<string, Clip>();
function addClip(text: string) {
  const key = narrationKey(GUIDE.id, text);
  clips.set(key, { key, text });
}
for (const journey of journeys) {
  journey.stops.forEach((_stop, stopIndex) => addClip(spokenTextFor(journey, stopIndex, GUIDE)));
}
// Answers to the example questions offered on the demo.
for (const question of DEMO_EXAMPLE_QUESTIONS) addClip(answerOffline(graph, question).answer);

// ---- The voice: always the one chosen in backend/.env ----
const voiceId = env.ELEVENLABS_VOICE_ID;
if (!voiceId) {
  console.error('ELEVENLABS_VOICE_ID is not set in backend/.env.');
  process.exit(1);
}

async function describeVoice(): Promise<string> {
  const response = await fetch(`${API}/voices/${voiceId}`, { headers: { 'xi-api-key': apiKey } });
  return response.ok ? ((await response.json()) as { name: string }).name : '(name unavailable)';
}

// Steady and a touch slower: the unhurried on-call engineer from the brief.
const VOICE_SETTINGS = { stability: 0.75, similarity_boost: 0.75, speed: 0.95 };

async function synthesize(text: string): Promise<Buffer> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(`${API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: modelId, voice_settings: VOICE_SETTINGS }),
    });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    if (response.status === 429 || response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      continue;
    }
    throw new Error(`ElevenLabs responded with ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  throw new Error('ElevenLabs kept failing; try again in a minute.');
}

// ---- Run ----
const voiceName = await describeVoice();
const wantedFiles = new Set([...clips.keys()].map((key) => `${key}.mp3`));
const staleFiles = existsSync(outputDirectory)
  ? readdirSync(outputDirectory).filter((file) => file.endsWith('.mp3') && !wantedFiles.has(file))
  : [];
const needed = [...clips.values()].filter((clip) => shouldForce || !existsSync(join(outputDirectory, `${clip.key}.mp3`)));
const characterCount = needed.reduce((total, clip) => total + clip.text.length, 0);

console.log(`Voice: "${voiceName}" (from ELEVENLABS_VOICE_ID), model ${modelId}`);
console.log(`Tours: ${journeys.length}  |  clips wanted: ${clips.size}  |  to generate: ${needed.length}  |  stale to delete: ${staleFiles.length}`);
console.log(`Characters to send: ${characterCount}`);
if (isDryRun) {
  console.log('Dry run: nothing generated or deleted.');
  process.exit(0);
}

mkdirSync(outputDirectory, { recursive: true });
let done = 0;
for (const clip of needed) {
  writeFileSync(join(outputDirectory, `${clip.key}.mp3`), await synthesize(clip.text));
  done += 1;
  console.log(`  [${done}/${needed.length}] ${clip.key}`);
}
for (const file of staleFiles) unlinkSync(join(outputDirectory, file));

writeFileSync(
  join(outputDirectory, 'index.json'),
  `${JSON.stringify({ clips: [...clips.keys()].filter((key) => existsSync(join(outputDirectory, `${key}.mp3`))).sort() }, null, 2)}
`,
);
console.log(`Saved ${done} clips, removed ${staleFiles.length} stale ones, wrote the index.`);
