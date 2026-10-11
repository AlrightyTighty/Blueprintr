import { App } from 'aws-cdk-lib';
import { BackendStack } from '../lib/stacks/backend-stack.js';
import { FrontendStack } from '../lib/stacks/frontend-stack.js';

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};
const prefix = app.node.tryGetContext('projectName') ?? 'ripplemap';

const backend = new BackendStack(app, `${prefix}-backend`, { env });

new FrontendStack(app, `${prefix}-frontend`, {
  env,
  apiUrl: "https://api.ripplemap.wiki",
});
