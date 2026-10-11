import awsLambdaFastify from '@fastify/aws-lambda';
import { buildApp } from './app.js';
import { isAnalysisJobEvent } from './integrations/runDispatcher.js';
import { executeRun } from './services/analysis.js';

const app = buildApp();
// /narrate returns MP3 bytes, which API Gateway must be told to pass through as base64.
const http = awsLambdaFastify(app, { binaryMimeTypes: ['audio/mpeg'] });

await app.ready();

/**
 * One function serves two kinds of invocation: API Gateway requests, and the asynchronous
 * self-invocation that runs an analysis (a Lambda is frozen once it responds, so the job
 * can't just carry on in the background).
 */
export const handler = async (event: unknown, context: unknown) => {
  if (isAnalysisJobEvent(event)) {
    await executeRun(event.analysisRunId);
    return;
  }
  return (http as (event: unknown, context: unknown) => Promise<unknown>)(event, context);
};
