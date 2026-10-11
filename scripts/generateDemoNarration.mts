// Generates the guide's voice for the demo tours with ElevenLabs and saves the clips under
// frontend/public/narration, so the site plays them with no key in the browser and no network at
// show time. Reads the key from backend/.env (never printed, never committed).
//
//   npm run narrate:demo -- --dry-run     list what would be generated and what it would cost
//   npm run narrate:demo                  generate any clips that don't exist yet
//   npm run narrate:demo -- --force       regenerate every clip
//
// Run `npm run snapshot:demo` first if the demo repo changed. Clips are named after the exact words,
// so changing a script just means running this again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePlanChanges } from '../frontend/src/core/graph/planImpact.ts';
import { extractJourneys } from '../frontend/src/core/journeys/extractJourneys.ts';
import { buildChangeJourney, buildDisasterJourney } from '../frontend/src/core/journeys/impactJourneys.ts';
import type { Journey } from '../frontend/src/core/journeys/types.ts';
import { parsePlan } from '../frontend/src/core/terraform/parsePlan.ts';
import { SAMPLE_PLAN_JSON } from '../frontend/src/features/plan-overlay/samplePlan.ts';
import { narrationKey } from '../frontend/src/features/voice/narrationKey.ts';
import { PERSONAS, type PersonaId } from '../frontend/src/features/voice/personas.ts';
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
  personaId: PersonaId;
  text: string;
}
const clips = new Map<string, Clip>();
for (const personaId of Object.keys(PERSONAS) as PersonaId[]) {
  for (const journey of journeys) {
    journey.stops.forEach((_stop, stopIndex) => {
      const text = spokenTextFor(journey, stopIndex, PERSONAS[personaId]);
      clips.set(narrationKey(personaId, text), { key: narrationKey(personaId, text), personaId, text });
    });
  }
}

// ---- Voices ----
// Defaults are premade voices that fit each personality; override with ELEVENLABS_VOICE_ID_CALM and
// ELEVENLABS_VOICE_ID_EXCITED in backend/.env. (ELEVENLABS_VOICE_ID is the backend's own voice for plan
// briefings and is left alone.)
const DEFAULT_VOICE_NAMES: Record<PersonaId, string> = {
  calm_docent: 'Daniel',
  overexcited_guide: 'Laura',
};

async function listVoices(): Promise<{ voice_id: string; name: string }[]> {
  const response = await fetch(`${API}/voices`, { headers: { 'xi-api-key': apiKey } });
  if (!response.ok) throw new Error(`Could not list voices (${response.status}).`);
  return ((await response.json()) as { voices: { voice_id: string; name: string }[] }).voices;
}

async function chooseVoices(): Promise<Record<PersonaId, { id: string; name: string }>> {
  const voices = await listVoices();
  const overrides: Record<PersonaId, string | undefined> = {
    calm_docent: env.ELEVENLABS_VOICE_ID_CALM,
    overexcited_guide: env.ELEVENLABS_VOICE_ID_EXCITED,
  };

  const choose = (personaId: PersonaId) => {
    const overrideId = overrides[personaId];
    const match = overrideId
      ? voices.find((voice) => voice.voice_id === overrideId)
      : voices.find((voice) => voice.name.startsWith(DEFAULT_VOICE_NAMES[personaId]));
    if (overrideId) return { id: overrideId, name: match?.name ?? '(custom voice)' };
    if (!match) throw new Error(`No voice named "${DEFAULT_VOICE_NAMES[personaId]}" in this account. Set the voice id in backend/.env.`);
    return { id: match.voice_id, name: match.name };
  };
  return { calm_docent: choose('calm_docent'), overexcited_guide: choose('overexcited_guide') };
}

// Calm: steady and a touch slower. Excited: looser, more expressive, a touch faster.
const VOICE_SETTINGS: Record<PersonaId, object> = {
  calm_docent: { stability: 0.75, similarity_boost: 0.75, speed: 0.95 },
  overexcited_guide: { stability: 0.3, similarity_boost: 0.75, style: 0.6, use_speaker_boost: true, speed: 1.1 },
};

async function synthesize(voiceId: string, personaId: PersonaId, text: string): Promise<Buffer> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(`${API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: modelId, voice_settings: VOICE_SETTINGS[personaId] }),
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
const voices = await chooseVoices();
const needed = [...clips.values()].filter((clip) => shouldForce || !existsSync(join(outputDirectory, `${clip.key}.mp3`)));
const characterCount = needed.reduce((total, clip) => total + clip.text.length, 0);

console.log(`Tours to voice: ${journeys.length}  |  distinct clips: ${clips.size}  |  to generate: ${needed.length}`);
console.log(`Characters to send: ${characterCount}`);
for (const personaId of Object.keys(PERSONAS) as PersonaId[]) {
  console.log(`  ${PERSONAS[personaId].name}: voice "${voices[personaId].name}"`);
}
if (isDryRun) {
  console.log('Dry run: nothing generated.');
  process.exit(0);
}

mkdirSync(outputDirectory, { recursive: true });
let done = 0;
for (const clip of needed) {
  const audio = await synthesize(voices[clip.personaId].id, clip.personaId, clip.text);
  writeFileSync(join(outputDirectory, `${clip.key}.mp3`), audio);
  done += 1;
  console.log(`  [${done}/${needed.length}] ${clip.key}`);
}

writeFileSync(
  join(outputDirectory, 'index.json'),
  `${JSON.stringify({ clips: [...clips.keys()].filter((key) => existsSync(join(outputDirectory, `${key}.mp3`))).sort() }, null, 2)}\n`,
);
console.log(`Saved ${done} clips and the index to ${outputDirectory}`);
