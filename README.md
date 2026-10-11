# Ripplemap

A guided tour of your cloud, including the outage before it happens. Ripplemap reads a repo's infrastructure code (Terraform, or CloudFormation including `cdk synth` output) alongside its Python and JavaScript/TypeScript code, links them into one graph, and walks you through how requests really flow. You can pull the plug on a resource to watch what breaks, preview a Terraform plan, or "call" an endpoint such as `GET /orders/123` and follow that one request to the data. It only reads files; it never runs `terraform apply`, `cdk synth` or any code from the repo.

Live at https://ripplemap.wiki. The `/demo` route runs on bundled data, so it needs no backend or account. `claude.md` is the project brief (what it is, what is built, what is not).

```
.
├── backend/    Fastify API (runs locally as a server, deployed as a Lambda); analysis engine
├── frontend/   React + Vite single-page app
├── database/   Postgres schema as numbered SQL files, plus migrate.sh
├── iac/        AWS CDK app that deploys backend + frontend
├── scripts/    check:tours, snapshot:demo, narrate:demo (see below)
├── claude.md   project brief and status
├── package.json        npm workspaces root (backend, frontend, iac)
└── tsconfig.base.json  shared compiler options
```

See each folder's README for details. The API contract is `backend/openapi.yaml`.

## Prerequisites

- Node.js 22+ (developed on Node 26)
- PostgreSQL, for the backend (anything recent; tested on 16). The demo at `/demo` works without it.
- `psql`, to run `database/migrate.sh`
- AWS CLI credentials configured (only needed to deploy)

## Quick start

```bash
npm install                              # installs all workspaces
cp backend/.env.example backend/.env     # then set DATABASE_URL, JWT_SECRET, TOKEN_ENCRYPTION_KEY (see the file)
DATABASE_URL=postgres://... database/migrate.sh
npm run dev                              # backend on :3000, frontend on :5173
```

Open http://localhost:5173. GitHub sign-in, Gemini, ElevenLabs and audio storage are optional; the features that need one say so until it is configured (see `backend/.env.example`). Local Postgres usually has no TLS: add `DATABASE_SSL=disable` to the backend `.env`, and `PGSSLMODE=disable` when running `migrate.sh` (it otherwise requires TLS whenever `database/certs/global-bundle.pem` exists).

## Root scripts

| Script                  | What it does                                                              |
| ----------------------- | ------------------------------------------------------------------------- |
| `npm run dev`           | Runs backend and frontend dev servers together                            |
| `npm run build`         | Builds every workspace                                                    |
| `npm run typecheck`     | Type-checks every workspace                                               |
| `npm run deploy`        | Builds the frontend, then `cdk deploy --all`                              |
| `npm run check:tours`   | Builds every tour for the demo repo and checks it against what we planted |
| `npm run snapshot:demo` | Re-runs the real analysis on the demo repo and saves it for `/demo`       |
| `npm run narrate:demo`  | Pre-records the guide's voice for the demo tours with ElevenLabs          |

Run a script in one workspace with `npm run <script> --workspace <backend|frontend|iac>`. Re-run `snapshot:demo`, then `narrate:demo`, whenever the demo repo (`backend/test/fixtures/demo`) or the analysis changes.

## Tests

```bash
npm test --workspace backend                 # unit tests and the OpenAPI conformance test
TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/postgres npm test --workspace backend
                                             # also runs the end-to-end suite (creates and drops a scratch database)
```

## Adding dependencies

Install into a specific workspace from the repo root:

```bash
npm install zod --workspace backend
```

## Deployed architecture

```
Browser ──> CloudFront ──> S3 (frontend build + config.json)         ripplemap.wiki, www.ripplemap.wiki
   │
   └──────> API Gateway (HTTP API) ──> Lambda (Fastify) ──> Postgres (RDS)         api.ripplemap.wiki
                                          ├──> S3 (briefing audio)
                                          └──> GitHub, Gemini, ElevenLabs
```

The browser calls API Gateway directly; there is no proxy in between. The frontend learns the API URL at runtime from `/config.json`, which CDK writes to the bucket (currently `https://api.ripplemap.wiki`). Starting an analysis returns at once; the Lambda then invokes itself asynchronously to do the work.

Deploying (see `iac/README.md`):

- `cdk deploy` does not read `.env` files. The backend's settings (`DATABASE_URL`, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `FRONTEND_URL`, `CORS_ORIGIN`, GitHub, Gemini and ElevenLabs values) must be exported in the shell you deploy from.
- `CORS_ORIGIN` takes one origin or a comma-separated list, e.g. `https://ripplemap.wiki,https://www.ripplemap.wiki`. When unset, a deployed API allows only `FRONTEND_URL`.
- Put the RDS CA bundle at `database/certs/global-bundle.pem` (see `database/README.md`) and it is packaged into the Lambda for verified TLS.
- The custom domain and certificate for `api.ripplemap.wiki` were added by hand in API Gateway, outside CDK. Don't let a CDK change replace the API or its `$default` stage, or the domain mapping breaks.
- Apply new migrations (`database/migrate.sh`) to the production database before deploying code that needs them.
