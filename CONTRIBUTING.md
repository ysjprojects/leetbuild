# Contributing to LeetBuild

LeetBuild is LeetCode for systems: courses that build a real system one file at a time, graded by running the learner's code against real infrastructure in the browser. This guide is deliberately short; the README's [How it works](README.md#how-it-works) and [Content](README.md#content) sections are the reference it leans on, and `yarn verify` is the authority on what a course must satisfy.

By opening a pull request you agree that your contribution is released under the project's license ([LICENSE](LICENSE)).

## Ways to contribute

- **Bugs**: a wrong verdict, a harness that rejects a correct solution, a task or hint that misleads, a UI fault. Open an issue, then a PR if you want to fix it. Issues labelled `good first issue` are scoped for a first PR.
- **Courses**: a new system, or a better step in an existing one. New courses start as an issue titled `course: <system>` naming the system, its steps (which concept each exercises, what the learner's file does), the difficulty, and — for a company-tagged course — the public posts it is derived from. Agree on the outline before writing 4 steps × 5 languages.
- **Runtime fidelity**: behaviour of the in-browser Redis, Kafka, gRPC, HTTP and Postgres (`src/lib/runtime/`, `public/py/runtime/`). Fixes that bring a model closer to the real library need no discussion; a new resource or a new language does.
- **Playground**: widgets, editor, diagrams, game layer. Features start as an issue stating the problem they solve.

Not accepted: grading by heuristics (a harness that reads the learner's source, pattern-matches it, or spies on client calls instead of observing outcomes); a course that cannot be graded by execution in Python and TypeScript; content copied from its sources rather than paraphrased and linked; company marks from anywhere but the brand's official logo (Simple Icons path data, brand-guideline colours); new dependencies, dependency bumps or wide formatting-only changes without an issue explaining why.

## Setup

```sh
git clone https://github.com/ysjprojects/leetbuild.git && cd leetbuild
yarn install --ignore-engines   # Node 22, Yarn 1; 22.10 is a hair below what one transitive eslint dependency declares
yarn dev                        # http://localhost:3000 — builds public/{py,ts}/worker.js first (predev)
```

Pyodide (~10 MB) and esbuild-wasm (~14 MB) are fetched from jsDelivr on first use and cached, as is PGlite. Regenerating a course's protobuf modules (`yarn protogen <course dir>`) needs `python3 -m pip install grpcio-tools==1.81.0`; its gencode matches the protobuf runtime Pyodide ships.

## The gate

Every PR passes all four locally before review; CI (`.github/workflows/ci.yml`) runs the same four on every push to a PR, in parallel, and the `CI` check must be green to merge. `yarn format` rewrites what Prettier and `eslint --fix` can repair; `yarn lint` only checks, which is what CI runs. CI installs with `yarn install --frozen-lockfile`, so a `yarn.lock` that disagrees with `package.json` fails before anything else does.

| Command        | Enforces                                                                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yarn lint`    | Prettier (120 columns, single quotes, no bracket spacing) and ESLint with `--max-warnings=0`: sorted imports and JSX props, `react-hooks/exhaustive-deps`, `react-memo/require-memo`, and the type-aware `no-floating-promises`, `await-thenable` and `switch-exhaustiveness-check`                                 |
| `yarn compile` | `tsc --noEmit`, strict                                                                                                                                                                                                                                                                                              |
| `yarn verify`  | the judge's self-tests, every course's shape, every starter failing and every solution passing in all five languages, every Python and TypeScript harness executed in Node against both, and the catalogue's point total (details below). `--problem <id>` scopes it; `--runtime typescript` skips the Pyodide boot |
| `yarn build`   | the production build; it also rebuilds the worker bundles                                                                                                                                                                                                                                                           |

## Writing a course

A course is a directory `src/data/problems/<NN>-<id>/`: `index.ts` (metadata, statement, architecture diagram, support modules, step order), `steps/<k>-<step-id>.ts` (one step each), `proto/*.proto` and the `proto.ts` that `yarn protogen` generates from them, `support.ts` for hand-written helpers. It is registered in `src/data/problems/index.ts`. Copy the nearest existing course — `14-dropbox-gates` is the smallest — rather than starting blank.

What `yarn verify` holds every course to:

- `id`s kebab-case, file stems snake_case; at least 4 steps and every one of the four concepts (HTTPS, gRPC, Kafka, Redis) exercised by some step — unless the problem is a **single-topic drill** (`concepts` lists exactly one concept): then one step is enough and every step exercises that concept; `concepts[0]` is the first step's concept; no two steps own the same file in any language.
- Per step: a task and a debrief, 2–3 progressive hints, at least 3 checks, each check with a non-empty matcher for all five languages, `focus` naming real diagram nodes (or architecture blocks), every `:::widget` registered in `src/lib/widgets.ts`, every `:::` block well-formed.
- A deep-learning problem (`track: 'dl'`) fixes its language (`language: 'python' | 'cuda'`), lists its one concept (`pytorch` or `cuda`), carries code and matchers for that language only and no harness; its reference solution is a complete, self-testing program. It is drawn as a model or kernel: an `architecture` (a layer stack read bottom to top, see `src/lib/architecture.ts` and `162-pt-gpt2` for the reference) instead of a system diagram, no step `sequence`, no `:::diagram` / `:::sequence` in its Markdown, and a learning guide with at least one `:::architecture` figure and one widget.
- Per language: the starter carries a `TODO`, differs from the solution, fails at least one static check and pre-passes at most one; the solution passes them all.
- Every step ships a Python **and** a TypeScript harness: one `check_<id>(ctx)` per check (`-` → `_`), the solution passes every runtime check, the starter does not. `ctx` is documented in `public/py/runtime/leetbuild/harness.py` and `src/lib/runtime/ts/harness.ts`.
- Company-tagged courses: `company` ⇔ `sources`, every source with an https URL, a `YYYY-MM-DD` (or `YYYY-MM`) date, a title and what the course takes from it; the statement has a `## From the source` section.
- The catalogue's maximum is the sum over every problem (7 / 10 / 19 points per step by difficulty) and simply grows as content is added; issued certificates keep the maximum they were earned under.

What the checks cannot enforce, reviewers will:

- **Harnesses grade outcomes.** They drive the running system through its resources — send the HTTP request, call the RPC, consume the topic, read the key — and assert on what happened, including under failure (a stalled broker, an expired lock). A harness never reads the learner's source and never counts calls the client made. Static matchers describe the shape of a correct solution for Go, Scala and C++; they are advisory where a harness runs.
- **One idea per step**, in the step's own file: the task names the behaviour, the sequence diagram shows the interaction, the debrief says why the solution has that shape and what production systems add.
- **Write like the existing courses**: the statement explains the real system first, then what you build here, then what is left out on purpose; hints go from a nudge to the mechanism to the near-answer; no filler, no emojis.
- **Solutions are idiomatic in each stack** (FastAPI / Fastify / net/http / Pekko HTTP / cpp-httplib and the matching gRPC, Kafka and Redis clients — see the README) and would build: Go, Scala and C++ are graded statically, so a solution that does not compile is a bug the judge cannot catch.

## Changing the app

- Components are `memo(...)`; hooks and non-component helpers live in `src/lib`, not in `.tsx` files (the lint fails otherwise). Props are typed inline on the `FC`.
- Colours are palette tokens only — `ink-*`, `iris-*`, `success`/`warning`/`danger`, the concept colours — so both themes work; check Night and Day. Literal hex is for brand marks alone (the logo, LinkedIn's blue, company logos).
- The app is a function of persisted progress (`src/lib/storage.ts`) and course data; there is no server. Badges are never revoked, certificates never rewritten, persisted records are repaired rather than rejected.
- Runtime changes (`src/lib/runtime/`, `public/py/runtime/`) must leave both `yarn verify` harness suites green; the worker bundles are gitignored and rebuilt by `yarn dev`/`yarn build`.

## Pull requests

- Branch from `main`, one change per PR. Title it with the behaviour it changes, as the history does: `Timer lives in the header, not the problem pane`, not `fix timer`.
- The description says what and why, links the issue, and names what you did not do. UI changes include before/after screenshots in both themes; content changes paste the `yarn verify` summary line (`82 step(s) × 5 languages checked, …, 0 problem(s)`); runtime changes name the real-library behaviour they match.
- Update the README when behaviour it describes changes. No PR-only scaffolding, placeholders or `TODO`s left for a follow-up.
- Expect a first response within a week; after that, a ping on the thread is welcome. Review is for correctness and for whether the change will still read well in six months; expect requests to delete more than to add.

## Reporting bugs

All state is local to your browser, so include what we cannot see: the URL (`/<course>/<n>-<step>`), the language, the browser and OS, the console output, and — for a wrong verdict — the submission and the verdict text. The _report it ›_ link under a step's checks opens an issue with everything but the console output and your code filled in. Search existing issues first; one bug per issue.

## Conduct

Be direct and be kind: critique the code, not the person; assume competence; prefer evidence to opinion. Maintainers will remove comments or contributors that do not.
