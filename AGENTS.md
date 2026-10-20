# AGENTS.md

## What this repo is

LeetBuild is a **candidate practice site** for coding interviews in the AI era. It is not an
employer assessment product. The core loop is: read a realistic brief, work in an editor, submit,
and get checks plus a debrief. There is no login, billing, proctoring, employer dashboard or
server-side progress; do not add those unless the user explicitly asks.

Two modes share one app:

| Address           | Mode              | What it is                                                                                       |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `/`               | Practice          | The course catalogue: classic systems courses plus the AI-era courses.                           |
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
npx eslint './src/**/*.{ts,tsx}' './scripts/**/*.ts' --max-warnings=0
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

- Every course has `Problem.track?: 'systems' | 'ai'`; omitted means the systems track.
- The AI-era courses are `src/data/problems/16-ai-gateway/` and `17-rag-service/`. Their starters
  are plausible model-generated drafts with a real flaw; their solutions are the review fix.
- All five languages are mandatory in every step, and `scripts/verify.ts` enforces the course
  total of 1337 points (`STEP_POINTS` in `src/lib/scoring.ts`).
- The AI-era courses currently use static review checks only. The classic courses have Python and
  TypeScript harnesses that execute in the browser runtime. If you add AI-era harnesses, keep the
  checks outcome-based and update the README.
