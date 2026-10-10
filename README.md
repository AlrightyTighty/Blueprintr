# Orion
```
.
├── backend/    Fastify API (runs locally as a server, deployed as a Lambda)
├── frontend/   React + Vite single-page app
├── iac/        AWS CDK app that deploys backend + frontend
├── package.json        npm workspaces root
└── tsconfig.base.json  shared compiler options
```

See each folder's README for details.

## Prerequisites

- Node.js 22+ (developed on Node 26)
- AWS CLI credentials configured (only needed to deploy)

## Quick start

```bash
npm install          # installs all workspaces
npm run dev          # backend on :3000, frontend on :5173
```

Open http://localhost:5173.

## Root scripts

| Script              | What it does                                         |
| ------------------- | ---------------------------------------------------- |
| `npm run dev`       | Runs backend and frontend dev servers together       |
| `npm run build`     | Builds every workspace                               |
| `npm run typecheck` | Type-checks every workspace                          |
| `npm run deploy`    | Builds the frontend, then `cdk deploy --all`         |

Run a script in one workspace with `npm run <script> --workspace <backend|frontend|iac>`.

## Adding dependencies

Install into a specific workspace from the repo root:

```bash
npm install zod --workspace backend
```

## Deployed architecture

```
Browser ──> CloudFront ──> S3 (frontend build + config.json)
   │
   └──────> API Gateway (HTTP API) ──> Lambda (Fastify)
```

The browser calls API Gateway directly; there is no proxy in between. The frontend
learns the API URL at runtime from `/config.json`, which CDK writes to the bucket.
The backend allows cross-origin requests (see `CORS_ORIGIN` in `backend/`).
