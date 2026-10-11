import { existsSync } from 'node:fs';
import path from 'node:path';
import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { BACKEND_DIR, REPO_ROOT } from '../paths.js';

/**
 * Settings the backend reads (see backend/src/config.ts), passed through from the shell that runs
 * `cdk deploy`. They end up as plain Lambda environment variables, which is fine for a hackathon;
 * move the secrets to Secrets Manager before this holds real customer data.
 */
const PASSTHROUGH_ENV = [
  'DATABASE_URL',
  'JWT_SECRET',
  'TOKEN_ENCRYPTION_KEY',
  'FRONTEND_URL',
  'CORS_ORIGIN',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_REDIRECT_URI',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'ELEVENLABS_AGENT_ID',
] as const;

/** Where the RDS CA bundle is expected (see database/README.md, "TLS"). Bundled into the Lambda if present. */
const RDS_CA_BUNDLE = path.join(REPO_ROOT, 'database/certs/global-bundle.pem');

export class BackendStack extends Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Cached voice briefings. Private; objects expire so nothing piles up.
    const audioBucket = new Bucket(this, 'AudioBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const environment: Record<string, string> = {
      AUDIO_BUCKET: audioBucket.bucketName,
      // One pooled connection per Lambda instance keeps a burst of requests from exhausting RDS.
      DB_POOL_MAX: '1',
    };
    for (const name of PASSTHROUGH_ENV) {
      const value = process.env[name];
      if (value) environment[name] = value;
    }
    const hasCaBundle = existsSync(RDS_CA_BUNDLE);
    if (hasCaBundle) environment.DATABASE_CA_PATH = '/var/task/global-bundle.pem';

    const functionName = `${this.stackName}-api`;
    const fn = new NodejsFunction(this, 'ApiFunction', {
      functionName,
      entry: path.join(BACKEND_DIR, 'src/lambda.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_LATEST,
      architecture: Architecture.ARM_64,
      // Analyses run inside this function too (see "self-invoke" below), so give them room.
      memorySize: 1024,
      timeout: Duration.minutes(5),
      environment,
      depsLockFilePath: path.join(BACKEND_DIR, '../package-lock.json'),
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        // ESM bundles need a require shim for any CJS deps.
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        // The HCL parser loads a WASM file that sits next to its own sources, so it is installed
        // into the bundle's node_modules instead of being inlined.
        nodeModules: ['@cdktf/hcl2json'],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) =>
            hasCaBundle ? [`cp "${inputDir}/database/certs/global-bundle.pem" "${outputDir}/global-bundle.pem"`] : [],
        },
      },
    });

    audioBucket.grantReadWrite(fn);

    // Self-invoke: starting an analysis returns 202 straight away, then the function invokes itself
    // asynchronously to do the work (a Lambda is frozen once it responds). The ARN is built from the
    // fixed function name, because referencing `fn` from its own role policy would be a cycle.
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [this.formatArn({ service: 'lambda', resource: 'function', resourceName: functionName, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      }),
    );

    // HTTP API proxies every route to Fastify. CORS is handled by Fastify, so
    // corsPreflight is intentionally not set here (doing both duplicates the headers).
    const api = new HttpApi(this, 'HttpApi', {
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', fn),
    });

    this.apiUrl = api.apiEndpoint;

    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
  }
}
