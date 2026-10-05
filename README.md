# LeetBuild — build systems, step by step

LeetCode for systems. Each course is a real system cut down to the parts that transfer — a URL shortener, a rate-limited API gateway, an image cache microservice, live chat fan-out, a notification service, a match engine, an online merchant transaction system, flash-sale inventory, a news feed, ride dispatch — built one file at a time in Python, Go, Scala or C++. Every step exercises one of four concepts: **HTTPS servers, gRPC, Kafka, Redis**.

A step gives you a task, a sequence diagram of the interaction, interactive infographics (TLS/HTTP lifecycle, status codes, idempotency keys, gRPC call types, deadlines and retries, Kafka partitions, consumer groups, delivery semantics, cache-aside and stampedes, token buckets, the transactional outbox, a limit order book), three progressive hints, and a revealable reference solution (plain or as a diff against your code). The architecture diagram highlights the components the step builds; click one to jump to its step.

## Run it

```sh
yarn install --ignore-engines   # node 22.10 is a hair below what one transitive eslint dependency declares
yarn dev                        # http://localhost:3000
yarn build && yarn start        # production
yarn verify                     # checks every course (see below); run after editing content
yarn lint                       # prettier + eslint
yarn compile                    # tsc --noEmit
```

Set `NEXT_PUBLIC_SITE_URL` (see `.env.example`) to the public origin when deploying: it is used for the canonical link and for the URLs inside shared result cards and exported Markdown. Without it, share links use the page's own origin.

## How it works

- **The judge is static** (`src/lib/judge.ts`). Every step lists named checks — properties a correct implementation has (the route, the TTL, the `NX` on the lock, the commit *after* the side effect) — as per-language patterns evaluated on comment-stripped code with `all` / `none` / `order` semantics. Nothing is compiled or executed and no broker is contacted, which is what lets every language and every concept be judged uniformly in a static site. From the second wrong submission on a step, each failing check also shows the shape the judge expects (`describeMatcher`); every step keeps a Submissions history.
- **Scoring** (`src/lib/scoring.ts`) is contest-like: 11 / 21 / 30 points per step by difficulty — the ten courses (56 steps) are worth exactly 1337 and `yarn verify` enforces it — −20% per hint, −5% per wrong submission (floor 25%), 0 for a revealed step. Totals roll up into a guild rank (Novice → Apprentice → Journeyman → Artificer → Master Artificer → Archmage, by share of all points), solved counts by difficulty and per-concept mastery. Steps unlock in order; a course can be started over.
- **Game layer** (`src/lib/gamify.ts`): 17 badges computed from the attempt record (never revoked), announced with toasts; a daily streak; progress to the next rank; confetti on every fresh accept; a Wordle-style result card copied to the clipboard with `⇪ share`.
- **Markdown export** (`src/lib/export.ts`): `⤓ download .md` on a course page saves its tutorial in the current language — statement, Mermaid architecture and sequence diagrams, tasks, checks, starters, hints and solutions behind `<details>` spoilers.
- **Persistence** (`src/lib/storage.ts`): attempts, language and per-step workspaces live in IndexedDB (localStorage fallback) — per browser, no server. `/?p=<course>&s=<step>` addresses a step directly.
- **Diagrams** (`src/lib/layout.ts`): architecture diagrams are laid out automatically from the call graph (layered left to right, boxes sized to text, labels in the column gaps, long edges detoured around boxes; wide diagrams keep a readable size and scroll sideways). Sequence diagrams are drawn from each step's `sequence`.
- **UI** (`src/components/`): the playground shell with LeetCode-style drag gutters (`SplitGutter`), the problem list and profile card, the problem/step pane, the verdict pane, the CodeMirror step editor (`src/lib/editor.ts`), the diagrams, the Markdown dialect (`Markdown.tsx`: headings, callouts, lists, fenced code, tables, `:::widget name {json}`, `:::details`, pop quizzes), and `widgets/` (one component per infographic, registered in `widgets/index.tsx`).

## Content

Courses live in `src/data/problems/<NN>-<id>/`: `index.ts` holds the metadata, statement, architecture diagram (nodes, kinds and edges — placement is automatic) and step order; `steps/<k>-<step-id>.ts` holds one step: task, sequence diagram, hints, checks and starter/solution code in all four languages. Courses are ordered in `src/data/problems/index.ts`; the content model is `src/lib/types.ts` and the widget catalog `src/lib/widgets.ts`.

`yarn verify` (or `--problem <id>` / `--file <path>` / `--verbose`) runs the judge's self-tests, checks every course's shape, and for every step in every language asserts that the starter fails at least one check (and at most one passes already) while the reference solution passes them all, then that the course total is 1337.

Stacks the reference solutions use: Python — FastAPI, grpcio, confluent-kafka, redis-py · Go — net/http, google.golang.org/grpc, segmentio/kafka-go, go-redis v9 · Scala — Pekko HTTP, ScalaPB + grpc-java, kafka-clients, Jedis · C++ — cpp-httplib, grpc++, librdkafka, redis-plus-plus.

## Deploy

A plain Next.js 14 (pages router) app with no server-side state: deploy to Vercel or any Node host, or `next build` with static export. Set `NEXT_PUBLIC_SITE_URL` in the environment.
