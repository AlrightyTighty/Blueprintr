# Backend

Fastify 5 API written in TypeScript (ESM).

## Layout

```
src/
├── app.ts      Builds the Fastify instance: plugins + routes. Add new routes here.
├── server.ts   Local entrypoint: calls app.listen() (used by `npm run dev`)
└── lambda.ts   AWS Lambda entrypoint: wraps the app with @fastify/aws-lambda
```

`app.ts` is shared by both entrypoints, so whatever you register there works locally
and on Lambda without changes.

## Scripts

| Script              | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | Runs `src/server.ts` with `tsx watch` (hot reload) |
| `npm run build`     | Compiles to `dist/` with `tsc`                  |
| `npm start`         | Runs the compiled server from `dist/`           |
| `npm run typecheck` | Type-checks without emitting                    |

## Environment variables

| Name          | Default | Purpose                                  |
| ------------- | ------- | ---------------------------------------- |
| `PORT`        | `3000`  | Local server port                        |
| `CORS_ORIGIN` | any     | Allowed CORS origin(s); the browser calls the API cross-origin |

## Routes

| Method | Path         | Description         |
| ------ | ------------ | ------------------- |
| GET    | `/health`    | Health check        |
| GET    | `/hello`     | Example API route   |

## Adding a route

For a handful of routes, add them directly in `app.ts`. When it grows, split into
Fastify plugins (e.g. `src/routes/users.ts` exporting an async plugin) and
`app.register()` them in `app.ts` with `{ prefix: '/users' }`.

## Deployment

Deployed by `iac/` as a single Lambda (`NodejsFunction`, bundled with esbuild from
`src/lambda.ts`) behind an API Gateway HTTP API. You don't need to build this
package before deploying — CDK bundles straight from source.
