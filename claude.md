# HACKATHON PROJECT BRIEF: "Blueprint" (working name)

## Context
- MLH-style hackathon, team of 2, 24 hours, started Sat Oct 10, 2026. We use Claude to write most of the code, so the limiting factors are ideas, demo quality, and debugging time, not learning SDKs.
- One teammate is frontend-focused (React, Next.js, Tailwind); the other handles backend, parsing and API integrations.
- Goal: impress hackathon judges (developers and sponsor reps), personally and technically.

## Tracks we are targeting
1. **Best Use of Gemini API**
2. **Best Use of ElevenLabs**
3. **Best Domain Name from GoDaddy Registry**
Best Pitch/Demo and Best Overall are opportunistic, not the focus.

Deliberately skipped (no honest fit): Tiger Data, Backboard, Vultr, Solana, Best Environment Hack. Principle: don't bolt on sponsor tools, because judges and sponsor reps notice.

## The idea in one sentence
Blueprint reads a repo's Terraform (IaC) alongside its app code, links them into one graph, and answers "what breaks if I change this?" with blast-radius analysis across both code and cloud infrastructure.

## Core features
**Three main views**
1. **Code to resource:** open a code file, see which cloud resources it reads, writes or publishes to.
2. **Resource to code:** click a resource, see every function that touches it and the IAM roles granting access.
3. **Plan blast radius (headline feature):** paste `terraform show -json plan.out`. Resources marked replace/destroy turn red, everything downstream turns amber, including the exact code that depends on them.

**Bonus findings from the same graph (nearly free)**
- Permission gaps: code calls an action the role doesn't allow (e.g. dynamodb:DeleteItem).
- Over-broad IAM: role allows s3:* but code only reads one bucket.
- Unmanaged resources: a bucket name hardcoded in code that isn't in Terraform (drift).

**Domains as a node type** (Route 53 records, CDN aliases) so the demo can end on "this site's domain traces to its CDN, which traces to its bucket."

## How code gets linked to resources (every edge carries a confidence label shown in the UI)
| # | Method | Example | Confidence |
|---|---|---|---|
| 1 | Declared references in IaC | aws_lambda_function.api references aws_iam_role.api_role and aws_dynamodb_table.orders | Certain |
| 2 | Env var join | Terraform sets TABLE_NAME = aws_dynamodb_table.orders.name on a Lambda; code reads process.env.TABLE_NAME | High |
| 3 | Code-to-compute mapping | Lambda handler/source_dir, Dockerfile build context, compose build: path maps a code folder to the resource that runs it | High |
| 4 | Gemini inference | SDK call like s3.putObject with a config-built bucket name; Gemini reads context and picks the likely resource | Labeled "inferred" |

The env var is the bridge between the IaC world and the code world. Being upfront about inferred links is a credibility point.

## How each target track does a real job
**Gemini**
- Structured-output extraction to resolve resources static parsing can't (method 4)
- Plain-English risk explanation of plan changes ("replacing this table drops its data unless you migrate first")
- Safer alternatives (create_before_destroy, staged migration)
- Function calling for graph questions ("what touches the users table?" runs a real graph query instead of guessing)

**ElevenLabs**
- Pre-flight briefing before applying a change, e.g. "This plan replaces one resource and modifies three. The replaced table is read by two functions and written by one. I'd stop here."
- Voice Q&A via ElevenLabs conversational agent wired to the graph query tool
- Persona: one steady, unhurried voice, like an on-call engineer who isn't panicking

**GoDaddy**
- Registration prize, so the work is picking a memorable name that fits the product (whatbreaks / blastmap / tracemap style) and checking availability on the offered TLDs
- Domains-as-graph-nodes makes the domain part of the story

## Scope (keep it narrow and working)
- Terraform + AWS only, a small set of resource types: Lambda, S3, DynamoDB, SQS, IAM roles/policies, API Gateway, Route 53/CloudFront
- App code: Python and JavaScript/TypeScript only
- Static analysis only. Never run terraform apply or any repo code. Reading plan JSON is safe; say so on stage.
- Build a demo repo we control with planted traps: an unmanaged hardcoded bucket, an over-permissive role, a function missing a permission it needs. Then every finding in the demo is real and predictable.
- Modules, count and for_each are out of scope (say "future work"). Simple var/local references resolved from defaults in variables.tf; the rest shown as labeled unresolved nodes.

## Tech stack (decided)
- **React SPA**: Vite + React + TypeScript, Tailwind, React Flow (graph), Zustand (state), React Router only if needed
- **Thin serverless proxy** (Vercel/Netlify /api functions) because API keys can't live in the browser. Jobs: call Gemini, call ElevenLabs (return audio, or give a signed URL for the conversational agent), keep keys secret. Alternative: small Express/FastAPI service if the backend teammate prefers Python.
- **HCL parsing:** use a library, don't write a parser. Recommended: @cdktf/hcl2json (HashiCorp's Go HCL parser compiled to WASM; call parse("main.tf", contents) and get JSON). Verify current maintenance status before depending on it. Python fallback: python-hcl2.
  - Preferred: run it in the proxy (Node) for reliability. In-browser WASM loading through Vite is the likeliest source of trouble, so test it in the first hour; if it fights us, parse in the serverless function (then adjust the pitch's privacy line, since repo contents pass through the proxy).
  - The plan overlay needs no HCL parser: terraform show -json is already structured JSON.
- Fetch repo files in the browser via GitHub REST API (public repos allow CORS) or a pasted/dropped folder.
- Code scanning (env var reads, SDK calls) with regex plus a lightweight parser (Babel or tree-sitter WASM).
- Graph building and blast-radius traversal: a pure TypeScript module in the browser.
- Deploy on whatever is fastest (Vercel).

## Suggested structure
```
src/
  core/
    graph/        types, builder, blastRadius
    terraform/    parseHcl, parsePlan
    code/         scanEnvVars, scanSdkCalls, linkers
  features/
    graph-view/
    plan-overlay/
    findings/
    voice/
  api/            client functions for the proxy
api/              serverless functions: gemini, speech
```
Keep core/ free of React so the blast radius logic can be built and tested before the UI exists.

## The part we still have to write (the actual core of the project)
The HCL parser returns structure, not relationships. References come back as interpolation strings like "${aws_dynamodb_table.orders.name}", so the linker must:
1. Walk every attribute value in each resource block.
2. Regex-extract references (aws_type.name.attribute) to create declared edges.
3. Find env var blocks (e.g. a Lambda's environment.variables) and record which resource each variable points to; this is the env var bridge to the code.
About 50-100 lines of TypeScript.

## Build order (steps 1-5 plus the voice briefing = a complete demo)
1. Parse Terraform into resource nodes with declared edges
2. Scan app code and link by env var and handler path
3. Graph UI with click-to-highlight blast radius, in both directions
4. Plan JSON overlay (replace / destroy / modify)
5. Gemini explanation and inference for ambiguous links
6. ElevenLabs briefing, then voice Q&A
7. Permission gap, over-broad IAM, unmanaged resource findings
8. Domain nodes, final name, polish

## Work split
- **Frontend teammate:** React UI, graph (React Flow), confidence-based edge styling, blast radius highlighting, plan view, voice controls, polish.
- **Backend teammate:** HCL and plan JSON parsing, code scanners for SDK calls and env var reads, graph builder, Gemini and ElevenLabs integration, proxy.

## Demo plan (~3 minutes)
1. Load the demo repo; the graph assembles with code nodes, resource nodes and a domain node, edges styled by confidence.
2. Click the orders table; blast radius lights up and the voice says what depends on it.
3. Paste a plan that replaces that table; red and amber spread; the briefing says to stop.
4. Show a permission gap and an unmanaged bucket the scan found.
5. Close on the live domain tracing to its own infrastructure.
Cache demo-repo results and keep a backup recording in case of Wi-Fi or API failure.

## Risks and honesty points
- HCL WASM in the browser (see above); mitigate with the proxy fallback.
- Integration sprawl: always keep a working end-to-end build; never leave main broken.
- Some links are inferred; label them as such and say humans review every conclusion.
- Never execute untrusted code; static analysis only.

## Ideas considered and dropped
Heat/Air Guardian, Hackathon Pulse, Mistake Museum, Keepsake, StudyPal, and the URL-based accessibility scanner. Earlier Blueprint variants (architecture map with voice tour, design-system extraction and wireframes, time-travel git slider, learning path, design drift detector, accessibility lens) are deprioritized. They lean on Tiger Data or Backboard, or dilute the focus on blast radius across code and IaC. Add them back only if time remains.

## Immediate next steps (not yet started)
1. Graph schema: node types, edge types, confidence field
2. Terraform reference-extraction function and env var bridge
3. Demo repo with planted traps
4. Choose the product name and check domain availability