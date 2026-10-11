import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

/** Payload the Lambda entrypoint recognises as "run this analysis". */
export interface AnalysisJobEvent {
  analysisRunId: string;
}

export function isAnalysisJobEvent(event: unknown): event is AnalysisJobEvent {
  return typeof event === 'object' && event !== null && typeof (event as AnalysisJobEvent).analysisRunId === 'string';
}

/**
 * Starts an analysis run in the background. Locally that is just the same process; on Lambda the
 * function invokes itself asynchronously, because a Lambda is frozen as soon as it responds.
 */
export interface RunDispatcher {
  dispatch(runId: string): Promise<void>;
}

export class InProcessDispatcher implements RunDispatcher {
  constructor(private readonly execute: (runId: string) => Promise<void>) {}

  async dispatch(runId: string): Promise<void> {
    setImmediate(() => {
      this.execute(runId).catch((err) => console.error(`analysis run ${runId} crashed`, err));
    });
  }
}

export class LambdaSelfDispatcher implements RunDispatcher {
  private readonly client = new LambdaClient({});

  async dispatch(runId: string): Promise<void> {
    const event: AnalysisJobEvent = { analysisRunId: runId };
    await this.client.send(
      new InvokeCommand({
        FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(event)),
      }),
    );
  }
}
