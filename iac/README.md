# IaC

AWS CDK v2 app (TypeScript) that deploys the whole project. It lives at the top level
because it reaches into every other package: it bundles `backend/` source into a
Lambda and uploads `frontend/dist` to S3.

## Layout

```
cdk.json                 CDK config: how to run the app (`tsx bin/app.ts`) + context
bin/app.ts               Entry: instantiates every stack
lib/
├── paths.ts             Absolute paths to the other packages in the repo
└── stacks/
    ├── backend-stack.ts   Lambda (Fastify) + API Gateway HTTP API
    └── frontend-stack.ts  S3 bucket + CloudFront, plus config.json with the API URL
```

## Stacks

| Stack            | Resources                                                     | Outputs   |
| ---------------- | ------------------------------------------------------------- | --------- |
| `ripplemap-backend`  | `NodejsFunction` (Node latest, arm64) behind an HTTP API, plus a private S3 bucket for voice briefing audio | `ApiUrl`  |
| `ripplemap-frontend` | Private S3 bucket, CloudFront distribution, `BucketDeployment` | `SiteUrl` |

The frontend stack takes the backend's API URL as a prop and writes it to
`config.json` in the bucket. Because of that dependency, CDK deploys the backend first automatically.

## Scripts

| Script              | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run synth`     | Synthesizes CloudFormation into `cdk.out/`    |
| `npm run diff`      | Shows changes vs. what's deployed             |
| `npm run deploy`    | Deploys all stacks                            |
| `npm run destroy`   | Tears down all stacks                         |
| `npm run cdk -- …`  | Any other CDK CLI command                     |

## First-time setup

```bash
aws configure                 # or export AWS_PROFILE=...
npx cdk bootstrap             # once per account/region
```

## Deploying

From the repo root (builds the frontend first):

```bash
npm run deploy
```

Or from `iac/` if `frontend/dist` is already built: `npm run deploy`.

The `SiteUrl` output is the app; `ApiUrl` is the API Gateway endpoint.

## Custom domain (not wired up yet)

When the domain is ready, the usual setup is:

1. Look up (or create) the Route 53 hosted zone: `HostedZone.fromLookup(...)`.
2. Issue ACM certificates with `Certificate` + `CertificateValidation.fromDns(zone)`:
   - API (e.g. `api.example.com`): certificate in the **stack's region**.
   - Site (e.g. `example.com`): certificate in **us-east-1** (CloudFront requirement).
3. API: create an `apigatewayv2.DomainName` and pass it to `HttpApi` via
   `defaultDomainMapping: { domainName }`. Then add a Route 53 `ARecord` targeting
   `new ApiGatewayv2DomainProperties(...)`.
4. Site: set `domainNames` + `certificate` on the `Distribution`, then add an `ARecord`
   targeting `new CloudFrontTarget(distribution)`.
5. Change the `apiUrl` passed to `FrontendStack` to `https://api.example.com`, and set
   the backend's `CORS_ORIGIN` to the site's domain. List every address the site is served from, separated by
   commas, e.g. `https://example.com,https://www.example.com`; each must be a full origin (with `https://`).

## Notes

- The stack name prefix comes from the `projectName` context value in `cdk.json`.
- Account/region come from your AWS CLI profile (`CDK_DEFAULT_ACCOUNT/REGION`).
- The S3 bucket uses `RemovalPolicy.DESTROY` + `autoDeleteObjects` so `destroy`
  cleans up fully — fine for a hackathon, change it for anything long-lived.
- Backend bundling uses the local `esbuild` dev dependency (no Docker needed).
- Adding infra (DynamoDB, Cognito, etc.): create a new stack in `lib/stacks/` or add
  constructs to an existing one, then wire it up in `bin/app.ts`. Pass resource
  names/ARNs to the Lambda via `environment` and grant access with `table.grantReadWriteData(fn)`-style calls.

## Backend configuration

`cdk deploy` passes these variables from your shell into the Lambda (any that are unset are skipped):
`DATABASE_URL`, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `FRONTEND_URL`, `CORS_ORIGIN`, `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URI`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `ELEVENLABS_API_KEY`,
`ELEVENLABS_VOICE_ID`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_MODEL_ID`, `GITHUB_API_TOKEN`, `JWT_TTL_SECONDS`,
`MAIL_FROM`, `MAX_PLAN_BYTES`, `MAX_REPOSITORY_KB`, `NARRATION_DAILY_CHARACTER_BUDGET`, `NARRATION_MAX_CHARACTERS`,
`ANALYSIS_STALE_MINUTES`, `TRUST_PROXY`. See `backend/.env.example` for what each means (a test fails if the backend
gains a setting this list lacks). `NODE_ENV=production` and `AUDIO_BUCKET` are set by the stack. When `MAIL_FROM` is set the
function may send through SES, and that address must be verified in SES (new SES accounts start in sandbox mode, which
only delivers to verified recipients; request production access before inviting real people). Failed analyses are not
retried by Lambda, and the API is throttled to 50 requests/second (burst 100). If `database/certs/global-bundle.pem` exists (see `database/README.md`), it is
bundled into the Lambda and used to verify the RDS certificate.

The function runs analyses by invoking itself asynchronously, so its role may invoke itself, and its timeout is
5 minutes. Plain environment variables are fine for a hackathon; move the secrets to Secrets Manager for anything real.
