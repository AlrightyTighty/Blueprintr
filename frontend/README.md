# Frontend

React 19 single-page app built with Vite 8 and TypeScript.

## Layout

```
index.html        Vite HTML entry
.env.development  VITE_API_URL for local dev (points at localhost:3000)
vite.config.ts    Vite config
src/
├── main.tsx      Mounts <App /> into #root
├── App.tsx       Root component
├── api.ts        Fetch helper: resolves the API URL, then calls the backend
└── index.css     Global styles
```

## Scripts

| Script              | What it does                                     |
| ------------------- | ------------------------------------------------ |
| `npm run dev`       | Vite dev server on http://localhost:5173         |
| `npm run build`     | Type-checks, then builds to `dist/`              |
| `npm run preview`   | Serves the production build locally              |
| `npm run typecheck` | Type-checks without building                     |

## Talking to the backend

The app calls the API directly (no proxy). Use `apiGet('/hello')` from `src/api.ts`;
it prefixes the API base URL, which comes from:

- **Dev:** `VITE_API_URL` in `.env.development` (`http://localhost:3000`). Start the
  backend too; `npm run dev` from the repo root runs both. To point at a deployed
  API instead, override it in `frontend/.env.local`.
- **Prod:** `VITE_API_URL` is unset, so it fetches `/config.json`, which `iac/`
  writes into the bucket with the API Gateway URL. Swapping the API won't
  need a frontend rebuild.

Only variables prefixed with `VITE_` are exposed to client code.

## Deployment

`iac/` uploads `dist/` to S3 and serves it through CloudFront, so **build before
deploying** (`npm run deploy` from the repo root does this for you). Unknown paths
fall back to `index.html`, so client-side routing works if you add a router.

## Pages

| Route                   | Page                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| `/login`, `/register`   | Email/username + password, or GitHub                                   |
| `/auth/github/callback` | OAuth redirect target; finishes sign-in, sign-up or account linking    |
| `/projects`             | Dashboard of your projects (needs sign-in)                             |
| `/projects/new`         | Create a project: pick a GitHub repo, branch and subfolder             |
| `/projects/:id`         | The graph workspace; shows analysis progress while a run is going      |
| `/invites/:token`       | What an invitation is for; sign in (or sign up) and join the project   |
| `/shared/:shareToken`   | A project opened through its read-only share link. No account needed   |
| `/demo`                 | The workspace on bundled data. No account or backend needed            |

The session (JWT) is kept in localStorage (`src/session.ts`); a 401 from the API signs you out.
GitHub must be configured to redirect to `<site>/auth/github/callback`.

All backend calls live in `src/services/`. The offline stand-ins for Gemini and ElevenLabs
(used by `/demo`, or when a plan couldn't be sent to the backend) are in `src/services/mockAi.ts`.

## Tours

The workspace is a guided tour of the repo (see `claude.md`). Everything below runs in the browser from
the graph; nothing here needs a journey endpoint on the backend.

| Piece                       | Where                                                                   |
| --------------------------- | ----------------------------------------------------------------------- |
| Journey extraction          | `src/core/journeys/extractJourneys.ts` (first day, follow a request)    |
| Disaster and change tours   | `src/core/journeys/impactJourneys.ts`, using `core/graph/cascade.ts`    |
| Stop scripts                | `src/core/journeys/narration.ts`, `stops.ts` (offline, graph-grounded)  |
| Tour player + code panel    | `src/features/tour-player/` (`TourDock`, `TourPanel`, `useTourStore`)   |
| Voice and personalities     | `src/features/voice/` (browser speech today; see `narrator.ts`)         |

Swap points for the backend: scripts come from `narration.ts` (replace with Gemini-written `Stop`s) and
narration audio comes from `narrator.ts` (replace with ElevenLabs audio per persona). The `Stop` and
`Journey` shapes in `src/core/journeys/types.ts` follow the contract in `claude.md`.

## Sharing and deleting projects

The **Share** button in a project's header opens a dialog with three parts:

- **People with access**: everyone on the project and their role. The owner can change a role, remove someone, or
  make someone else the owner. Anyone who isn't the owner can leave.
- **Invite someone** (owner): makes an invitation for an email address as an editor or viewer. Ripplemap doesn't send
  email: copy the link and send it. The link is shown once, when the invitation is made.
- **Anyone with the link can view** (owner): a read-only link that needs no account. Viewers and link visitors can
  explore the graph, findings and tours; uploading a plan and the AI features need an editor. "Reset link" replaces
  the link so the old one stops working.

**Delete** (owner) moves a project to the trash. The dashboard has Active, Archived and Trash tabs: archive and
restore happen straight away; delete and delete-forever ask first. Members can leave a project from its card.

Service calls live in `src/services/sharingService.ts` and `projectService.ts`; the link visitor's token is sent as
`X-Share-Token` (see `setShareToken` in `src/api.ts`).

