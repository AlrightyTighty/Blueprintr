import { LogMailer, type Mailer } from '../lib/mailer.js';
import { S3AudioStorage, type AudioStorage } from './audioStorage.js';
import { HttpElevenLabsClient, type ElevenLabsClient } from './elevenlabs.js';
import { HttpGeminiClient, type GeminiClient } from './gemini.js';
import { HttpGithubClient, type GithubClient } from './github.js';
import { InProcessDispatcher, LambdaSelfDispatcher, type RunDispatcher } from './runDispatcher.js';

/** Everything the services reach out to. Tests (and future deployments) replace these. */
export interface Integrations {
  mailer: Mailer;
  github: GithubClient;
  gemini: GeminiClient;
  elevenlabs: ElevenLabsClient;
  audio: AudioStorage;
  dispatcher: RunDispatcher;
}

let current: Integrations | undefined;

export function integrations(): Integrations {
  if (!current) throw new Error('Integrations are not initialised; call setIntegrations() (buildApp does this).');
  return current;
}

export function setIntegrations(value: Integrations): void {
  current = value;
}

export type DefaultIntegrationsInput = { executeRun: (runId: string) => Promise<void>; log?: (message: string) => void };

export function createDefaultIntegrations({ executeRun, log }: DefaultIntegrationsInput): Integrations {
  return {
    mailer: new LogMailer(log),
    github: new HttpGithubClient(),
    gemini: new HttpGeminiClient(),
    elevenlabs: new HttpElevenLabsClient(),
    audio: new S3AudioStorage(),
    dispatcher: process.env.AWS_LAMBDA_FUNCTION_NAME ? new LambdaSelfDispatcher() : new InProcessDispatcher(executeRun),
  };
}
