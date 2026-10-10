import path from 'node:path';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import { BACKEND_DIR } from '../paths.js';

export class BackendStack extends Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const fn = new NodejsFunction(this, 'ApiFunction', {
      entry: path.join(BACKEND_DIR, 'src/lambda.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_LATEST,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      depsLockFilePath: path.join(BACKEND_DIR, '../package-lock.json'),
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        // ESM bundles need a require shim for any CJS deps.
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });

    // HTTP API proxies every route to Fastify. CORS is handled by Fastify, so
    // corsPreflight is intentionally not set here (doing both duplicates the headers).
    const api = new HttpApi(this, 'HttpApi', {
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', fn),
    });

    this.apiUrl = api.apiEndpoint;

    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
  }
}
