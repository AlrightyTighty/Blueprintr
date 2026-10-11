# Backend

Fastify 5 API written in TypeScript (ESM), backed by Postgres (`pg`). The contract is
[`openapi.yaml`](openapi.yaml); a test fails if a route and the spec drift apart.

## Layout

```
src/
├── app.ts            Builds the Fastify instance: CORS, auth hook, error handler, route modules
├── server.ts         Local entrypoint (npm run dev)
├── lambda.ts         Lambda entrypoint: API Gateway requests + async analysis jobs
├── config.ts         Environment, validated with zod
├── routes/           HTTP handlers, one folder per API area (auth, projects, graph, ...)
├── services/         Business rules and app logic (permissions, transactions, activity log)
├── repositories/     Database access, one function per query pattern (SQL lives only here)
├── core/             Pure analysis logic with no HTTP or database: Terraform + code scanning,
│                     linking, findings, graph traversal, plan overlay
├── integrations/     GitHub, Gemini, ElevenLabs, S3, job dispatch (swappable, see registry.ts)
├── db/               Connection pool, transactions, cursor pagination helpers
├── http/             Errors (RFC 9457), request context, zod validation helpers
└── lib/              Crypto (scrypt, AES-GCM), JWT, mailer
test/                 Unit tests, an OpenAPI conformance test, and an end-to-end test against Postgres
```

**Layering.** Routes parse input (zod) and call one service function. Services decide who may do
what (`services/access.ts` is the single place project permissions live), open transactions, write the
activity log row in the same transaction as the change, and call repositories. Repositories take a
`Db` (the pool or a transaction client) as their first argument and return plain typed objects.
`core/` never imports from routes, services or repositories (it only reuses their types), so the
analysis can be tested without a server.

## Running locally

```bash
cp .env.example .env            # fill in JWT_SECRET and TOKEN_ENCRYPTION_KEY at least
DATABASE_URL=postgres://... ../database/migrate.sh
npm run dev                     # http://localhost:3000
```

Only the database and the two secrets are required. GitHub OAuth, Gemini, ElevenLabs and audio
storage are optional; the features that need one answer `503 integration_not_configured` until it is
set. Plan explanations still work without Gemini (rule-based text).

## Scripts

| Script              | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | `tsx watch`, loads `.env` if present            |
| `npm run build`     | Compiles to `dist/` with `tsc`                  |
| `npm start`         | Runs the compiled server from `dist/`           |
| `npm run typecheck` | Type-checks without emitting                    |
| `npm test`          | Runs the test suite (see below)                 |

## Tests

```bash
npm test                                                                 # unit + OpenAPI conformance
TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/postgres npm test   # also runs the end-to-end suite
```

The end-to-end suite creates a scratch database on the server you point it at, applies the real
migrations from `../database`, drives the whole API through `app.inject` with fake GitHub, Gemini,
ElevenLabs and S3, and drops the database afterwards. A throwaway server:

```bash
docker run -d --name ripplemap-pg -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:16
```

`test/fixtures/demo` is a small repo (Terraform + a Node Lambda + a Python Lambda) with planted
traps: a permission gap, an over-broad role and an unmanaged bucket. The analysis tests assert each is found.

## How analysis works

`POST /projects/{id}/runs` resolves the commit, records a run, and returns `202`. A dispatcher then
runs it: in-process locally, or by the Lambda invoking itself asynchronously when deployed (a Lambda
is frozen once it responds). The job downloads the commit's tarball from GitHub (never cloning or
executing anything), and `core/analysis/pipeline.ts` does the rest:

1. Read the infrastructure code into one model:
   - Terraform: `.tf` files, parsed with HashiCorp's HCL parser (`@cdktf/hcl2json`, WASM).
   - CloudFormation: YAML or JSON templates, hand-written or the output of `cdk synth` (`cdk.out/*.template.json`).
     Intrinsics (`Ref`, `GetAtt`, `Sub`, `Join`, `ImportValue`, ...) are rewritten into the same reference form
     Terraform uses, so one linker, IAM analysis and set of findings serve both. Resource types are mapped to
     Terraform-style names (`AWS::SQS::Queue` becomes `aws_sqs_queue`), and CDK nodes are named after the
     construct (`Api/ServiceRole`) instead of the hashed logical id.
2. Scan JavaScript/TypeScript and Python for env var reads and AWS SDK calls (regexes plus bracket matching).
3. Link: declared references (certain) → Lambda handler/source folder to code (high) → env var bridge (high) → literal names (high).
4. Gemini resolves calls static analysis could not (labelled `inferred`); skipped when not configured.
5. Findings: permission gaps, over-broad IAM, unmanaged resources, unresolved references.

CDK: Blueprint never runs `cdk synth` or any CDK code, so a CDK app is analysable only when its synthesized
templates are in the repository (commit `cdk.out/*.template.json`, or point at a folder of templates). Code to
Lambda mapping works from `aws:asset:path` when assets are un-staged (`cdk synth --no-staging`) and otherwise
from the handler, but only when exactly one file matches. Terraform plan overlays are Terraform-only for now.

Limits: Terraform modules, `count`/`for_each` expansion, SAM (`AWS::Serverless::*`), nested stacks and Docker/compose mapping are out of scope; unresolved
references show up as labelled nodes and findings instead of being guessed. Source file contents are
never stored; only Gemini inference sees the few functions it is asked about.

## Endpoint tours: "calling" an endpoint

`POST /projects/{id}/runs/{runId}/endpoints/trace` takes a method and path (`GET /orders/123`) and follows that
request through the stored graph without sending anything: the endpoint API Gateway would pick, then domain or CDN,
API, route, integration, Lambda, handler, the functions it calls, and the resources they use. `GET .../endpoints`
lists what can be called. The same trace backs the graph query op `endpoint`, so the Ask and voice agents can answer
"what happens on POST /orders". The frontend turns the trace into a tour (`frontend/src/core/journeys/endpointJourney.ts`).

- **Where endpoints come from** (`core/endpoints/extract.ts`, at analysis time): HTTP API routes (`route_key`),
  REST API methods (the path is assembled from `aws_api_gateway_resource` parents), and Lambda function URLs, from
  Terraform and CloudFormation/CDK alike. Runs analysed before this existed have none; analyse again.
- **The call graph** (`core/code/scan.ts`): a `calls` edge for a bare call to a function in the same file, or to a
  name imported from another analysed file. Method calls (`obj.fn()`) are not followed. Only calls on a path from a
  handler to a function that touches a resource are kept.
- **Matching** (`core/endpoints/match.ts`) follows API Gateway: literal beats `{id}` beats `{proxy+}` beats `$default`,
  and an exact method beats `ANY`. Stage prefixes are ignored; authorizers are named, not simulated.
- **Honest about what it can't know.** When several endpoints share one Lambda handler the trace sets
  `codeScope: shared_handler`: the infrastructure can't say which branch a route takes inside the handler, so the code
  shown is everything the handler can reach. Reading routes declared in code (Express, Fastify, Flask) would narrow
  this and is not built. A trace never invents a hop; what it can't follow is listed in `gaps`.
- **Background work:** when a function publishes to a queue that triggers another Lambda, the trace continues into
  that Lambda, marked `async`.

## Deployment

`iac/` bundles `src/lambda.ts` with esbuild into one Lambda behind an API Gateway HTTP API. The
HCL parser's WASM file is installed next to the bundle rather than inlined. Settings are passed
through from the shell running `cdk deploy` (see `iac/lib/stacks/backend-stack.ts`).
