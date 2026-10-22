# AGENTS.md

## What this repo is

LeetBuild is a **candidate practice site** for coding interviews in the AI era. It is not an
employer assessment product. The core loop is: read a realistic brief, work in an editor, submit,
and get checks plus a debrief. There is no login, billing, proctoring, employer dashboard or
server-side progress; do not add those unless the user explicitly asks.

Two modes share one app:

| Address           | Mode              | What it is                                                                                       |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `/`               | Practice          | The catalogue: the systems courses and drills, the deep-learning problems, the AI-era courses.   |
| `/mock-interview` | AI mock interview | Timed scenarios that start from a flawed AI draft, with an offline AI pair, checks and a report. |

The switch between them is `src/components/ModeSwitch.tsx`. The mock scenarios are
`src/data/mock.ts`; the experience is `src/components/MockInterview.tsx`.

## Commands

Dependencies are local to this repo. Yarn may not be installed; npm works too.

```sh
npm install --no-package-lock     # or: yarn install --ignore-engines
npx next dev                      # or: yarn dev
npx next build                    # or: yarn build
npx tsx scripts/verify.ts         # all content + Python harnesses
npx tsx scripts/verify.ts --no-runtime
npx tsc --noEmit
npm run lint                      # prettier --check + eslint, what CI runs
npm run format                    # prettier --write + eslint --fix
```

`npx tsx scripts/build-runtime.ts` regenerates `public/py/worker.js` and `public/ts/worker.js`;
`next dev`/`next build` normally do this through the package scripts.

## Generated artifacts and how to delete them

These are **build/dependency output, not source**. They are gitignored and safe to remove:

| Path                   | Created by                                        | Delete with                  |
| ---------------------- | ------------------------------------------------- | ---------------------------- |
| `node_modules/`        | `npm install` / `yarn install`                    | `rm -rf node_modules`        |
| `.next/`, `.next-*/`   | `next dev` / `next build`                         | `rm -rf .next .next-*`       |
| `out/`                 | static export, if used                            | `rm -rf out`                 |
| `public/py/worker.js`  | `scripts/build-runtime.ts` (also predev/prebuild) | `rm -f public/py/worker.js`  |
| `public/ts/worker.js`  | `scripts/build-runtime.ts` (also predev/prebuild) | `rm -f public/ts/worker.js`  |
| `tsconfig.tsbuildinfo` | `tsc`                                             | `rm -f tsconfig.tsbuildinfo` |

If the user says **“delete it”**, **“clean up the install”**, or **“remove the generated stuff”**,
this is what they mean. Run exactly:

```sh
rm -rf node_modules .next .next-* out tsconfig.tsbuildinfo
rm -f public/py/worker.js public/ts/worker.js
git status --short
```

Then confirm that only intentional source changes remain. **Do not delete** source files,
course content, `AGENTS.md`, or the mock-interview feature unless the user names them.

## Content rules

- Every problem has `Problem.track?: 'systems' | 'dl' | 'ai'`; omitted means the systems track.
- The AI-era courses are `src/data/problems/16-ai-gateway/` and `17-rag-service/`. Their starters
  are plausible model-generated drafts with a real flaw; their solutions are the review fix.
- All five languages are mandatory in every step of a course. A deep-learning problem (`track: 'dl'`)
  fixes one language instead — `language: 'python'` (PyTorch) or `'cuda'` — and its steps carry code
  and matchers for that language only; it has no harness, and its reference solution is a complete
  program ending in a self-test the learner runs on their own machine. The catalogue maximum is the
  live sum over every problem (`STEP_POINTS` in `src/lib/scoring.ts`); adding content never re-balances it.
- A deep-learning problem is drawn as a model or kernel, never as a system: `architecture` (a layer
  stack read bottom to top, `src/lib/architecture.ts`) instead of `diagram`, step `focus` naming its
  block ids, no step `sequence`, and no `:::diagram` / `:::sequence` anywhere in its Markdown. Its
  guide carries at least one `:::architecture` figure and one widget. `yarn verify` enforces all of it.
- The AI-era courses currently use static review checks only. The classic courses have Python and
  TypeScript harnesses that execute in the browser runtime. If you add AI-era harnesses, keep the
  checks outcome-based and update the README.

## Pull requests

[CONTRIBUTING.md › Pull requests](CONTRIBUTING.md#pull-requests) is the contract; this is how an agent
meets it. Humans merge: never commit to or push to `main`, never merge a PR, never change branch
protection or the workflow to get a PR through.

**Before opening.** Branch from a current `main`; one change per PR — one course, one fix, one
feature. Run the whole gate and open the PR only when it is green: `npm run lint`,
`npx tsc --noEmit`, `npx tsx scripts/verify.ts` (the full run, harnesses included — not only
`--file … --no-runtime`) and `npx next build`. CI runs the same four on every push and the `CI`
check is required, so a red PR cannot be merged. Formatting failures: `npm run format`, commit.
Never make the gate pass by weakening it — no `eslint-disable`, `@ts-ignore`,
`@ts-expect-error`, no edits to `.eslintrc`, `.prettierrc`, `tsconfig.json` or
`.github/workflows/` inside a content or feature PR; a rule that is wrong is its own PR with the
reason. Read your own diff first (`git diff origin/main...HEAD`): only the files the change needs;
no stray files, debug output, generated artifacts (table above), screenshots or scratch scripts;
no reformatting of files you did not otherwise change; no new or bumped dependencies (those need
an issue first).

**Title and description.** The title is the behaviour the PR changes, as the history reads
(`Timer lives in the header, not the problem pane`); a new course is titled by the course
(`Resumable Upload (course + mock scenario)`). The body says what and why, closes its issue
(`Closes #N`), names what you deliberately did not do, and pastes the verify summary line verbatim.
Runtime changes name the real-library behaviour they match; UI changes carry before/after
screenshots in both themes. If the README states something the PR changes, update it in the same
PR.

```markdown
<what and why, one paragraph>

Closes #N. Not done: <what you left out, and why>.

## Verification

- `npm run lint`, `npx tsc --noEmit`, `npx next build`: clean
- `npx tsx scripts/verify.ts`: `103 step(s) × 5 languages checked, 88 python + 88 typescript harness(es) run, 0 problem(s)`
- <screenshot of /<course-id>, or "no browser available; not screenshotted">
```

**A new course.** The PR carries exactly one of the labels `easy`, `medium`, `hard`, matching the
course's `difficulty` (`gh pr create --label hard …`, or `gh pr edit <n> --add-label hard`); the
labels exist, do not create others. If you have computer use — a browser you can drive — start
`npm run dev`, open `/<course-id>` on the origin it prints (`http://localhost:3000/<course-id>`
unless the port was taken; the course's home page: statement, diagram, step list) and attach a
screenshot to the PR description (drag it into the editor on github.com; never commit it). Without
a browser, write "no browser available; not screenshotted" in the description rather than leaving
it out silently. Other PRs take `bug`, `enhancement` or `documentation` when one fits.

**After opening.** Address review with new commits on the same branch; do not force-push over
commits a reviewer has read. When GitHub reports the branch is behind `main` (the required check
is strict), merge `origin/main` in or rebase, say which, and let CI rerun. CI red after a push:
read the failing job (`gh run view --log-failed`), fix, push — do not close and reopen, and do not
retrigger with empty commits. One PR per change: do not open a second for the same change, and
do not reopen a closed one without saying what is different.
