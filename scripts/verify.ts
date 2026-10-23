/**
 * Checks every /leetbuild problem: the shape of the problem (steps, diagram, sequences, hints,
 * widgets), for every step in every language that the starter fails at least one static check
 * while the reference solution passes them all, and for every step with a Python, TypeScript or Go
 * harness that the solution passes every runtime check while the starter does not (the harnesses
 * run in the browser runtimes, here in Node). Run after editing problems:
 *
 *   yarn verify                               # everything
 *   yarn verify --problem image-cache         # one problem (by id or NN- prefix)
 *   yarn verify --file src/data/problems/00-image-cache/index.ts   # one problem file, not via the index
 *   yarn verify --verbose                     # list every check result
 *   yarn verify --no-runtime                  # static checks only (no Pyodide boot)
 *   yarn verify --runtime go                  # execute only the Go harnesses (no Pyodide boot)
 */
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

import {architectureProblems} from '../src/lib/architecture';
import {gpuProblems} from '../src/lib/gpuFigure';
import {describePattern, judge, matches, stripComments} from '../src/lib/judge';
import {malformedBlocksOf, widgetsOf} from '../src/lib/markdown';
import {
  type NodeRuntime,
  createNodeGoRuntime,
  createNodePythonRuntime,
  createNodeTypeScriptRuntime,
} from '../src/lib/runtime/node';
import {type RunJob, type RunResult} from '../src/lib/runtime/types';
import {STEP_POINTS} from '../src/lib/scoring';
import {
  type Language,
  type Problem,
  type Step,
  codeFor,
  figureIds,
  fileName,
  isArchitectureFigure,
  problemLanguages,
  SYSTEMS_CONCEPTS,
} from '../src/lib/types';
import {WIDGETS} from '../src/lib/widgets';
import {GO_RUNTIME_MANIFEST, goRuntimeHash} from './go-runtime';

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const onlyProblem = flag('--problem');
const onlyFile = flag('--file');
const verbose = args.includes('--verbose');
const withRuntime = !args.includes('--no-runtime');
/** `--runtime typescript`: run only that language's harnesses (static checks still cover every language). */
const onlyRuntime = flag('--runtime');

const MIN_STEPS = 4;
const MIN_CHECKS = 3;
const HINTS = {min: 2, max: 3};

/**
 * Invariants of the judge itself, checked before any content: comment blanking per language, the
 * `all` / `none` / `order` semantics, and the readable rendering of patterns.
 */
function judgeSelfTest(): string[] {
  const failures: string[] = [];
  const expect = (name: string, ok: boolean): void => {
    if (!ok) failures.push(`judge self-test: ${name}`);
  };
  const py = stripComments('x = "#not a comment"  # SET NX\nkey = f"a:{b}"\n"""doc # keep"""\n', 'python');
  expect('python keeps # inside strings', py.includes('"#not a comment"'));
  expect('python blanks line comments', !py.includes('SET NX') && py.split('\n').length === 4);
  expect('python keeps triple-quoted text', py.includes('doc # keep'));
  const go = stripComments('s := "http://x" // GET\nr := `raw // keep`\n/* block\nSET */ y := 1\n', 'go');
  expect('c-like keeps // inside strings', go.includes('"http://x"') && go.includes('`raw // keep`'));
  expect('c-like blanks line and block comments', !go.includes('GET') && !go.includes('SET') && go.includes('y := 1'));
  expect('c-like blanking preserves line count', go.split('\n').length === 5);
  const scala = stripComments('val s = """a // b\n// c"""\n// d\n', 'scala');
  expect('scala keeps triple-quoted text across lines', scala.includes('// c"""') && !scala.includes('// d'));
  expect('all requires every pattern', matches({all: [/a/, /b/]}, 'ab') && !matches({all: [/a/, /c/]}, 'ab'));
  expect('none rejects any match', !matches({none: [/b/]}, 'ab') && matches({none: [/c/]}, 'ab'));
  expect('order is sequential', matches({order: [/a/, /b/]}, 'a b') && !matches({order: [/b/, /a/]}, 'a b'));
  expect(
    'order needs a later match, not an earlier one',
    !matches({order: [/incr\(/, /commit\(/]}, 'commit(); incr()'),
  );
  expect(
    'order finds the call after a declaration',
    matches({order: [/\bget\(key\)/, /render\(/]}, 'def render(id): ...\nv = get(key)\nrender(id)'),
  );
  expect('comments never satisfy a check', !matches({all: [/SET NX/]}, stripComments('x = 1  # SET NX', 'python')));
  expect(
    'describePattern reads like code',
    describePattern(/\.set\(\s*key\s*,\s*data\s*,\s*ex\s*=\s*TTL_S\s*\)/) === '.set(key, data, ex = TTL_S)' &&
      describePattern(/def shutdown(?:(?!\ndef )[\s\S])*?producer\.flush\(/) === 'def shutdown … producer.flush(',
  );
  return failures;
}

/** The ids a step's `focus` may name: the diagram's nodes, or the ids of every figure. */
const focusIds = (problem: Problem): Set<string> =>
  problem.figures !== undefined
    ? new Set(problem.figures.flatMap(f => [...figureIds(f)]))
    : new Set((problem.diagram?.nodes ?? []).map(n => n.id));

function verifyStep(problem: Problem, step: Step, index: number): string[] {
  const errors: string[] = [];
  const tag = `${problem.id}/${step.id}`;
  const nodeIds = focusIds(problem);
  if (!/^[a-z0-9-]+$/.test(step.id)) errors.push(`${tag}: step id must be kebab-case`);
  if (problem.track === 'dllm' && step.sequence !== undefined)
    errors.push(`${tag}: a deep-learning step has no request/reply sequence (use a figure or a widget)`);
  if (problem.track === 'dllm')
    for (const [where, text] of [
      ['task', step.task],
      ['debrief', step.debrief],
    ] as const)
      if (/^:::(sequence|diagram)\b/m.test(text))
        errors.push(`${tag}: ${where} uses a systems figure (:::sequence / :::diagram) in the deep-learning track`);
  for (const what of malformedBlocksOf(step.task)) errors.push(`${tag}: task: ${what}`);
  if (!/^[a-z][a-z0-9_]*$/.test(step.file)) errors.push(`${tag}: file stem must be snake_case`);
  if (step.task.trim() === '') errors.push(`${tag}: empty task`);
  if (step.debrief.trim() === '') errors.push(`${tag}: empty debrief`);
  if (step.focus.length === 0) errors.push(`${tag}: focus lists no diagram node`);
  for (const id of step.focus) if (!nodeIds.has(id)) errors.push(`${tag}: focus references unknown node '${id}'`);
  for (const w of widgetsOf(step.task)) if (WIDGETS[w] === undefined) errors.push(`${tag}: unknown widget '${w}'`);
  if (step.hints.length < HINTS.min || step.hints.length > HINTS.max)
    errors.push(`${tag}: needs ${HINTS.min}–${HINTS.max} hints (has ${step.hints.length})`);
  if (step.checks.length < MIN_CHECKS)
    errors.push(`${tag}: needs at least ${MIN_CHECKS} checks (has ${step.checks.length})`);
  const checkIds = new Set<string>();
  for (const check of step.checks) {
    if (checkIds.has(check.id)) errors.push(`${tag}: duplicate check id '${check.id}'`);
    checkIds.add(check.id);
    if (check.detail.trim() === '') errors.push(`${tag}/${check.id}: missing detail`);
    for (const language of problemLanguages(problem)) {
      const m = check.match[language];
      if (m === undefined) {
        errors.push(`${tag}/${check.id}: no matcher for ${language}`);
        continue;
      }
      if ((m.all?.length ?? 0) + (m.none?.length ?? 0) + (m.order?.length ?? 0) === 0)
        errors.push(`${tag}/${check.id}: empty matcher for ${language} (would always pass)`);
    }
  }
  if (step.sequence !== undefined) {
    const participants = new Set(step.sequence.participants);
    if (participants.size < 2) errors.push(`${tag}: sequence needs at least 2 participants`);
    for (const [i, m] of step.sequence.messages.entries()) {
      if (!participants.has(m.from))
        errors.push(`${tag}: sequence message ${i + 1} from unknown participant '${m.from}'`);
      if (!participants.has(m.to)) errors.push(`${tag}: sequence message ${i + 1} to unknown participant '${m.to}'`);
    }
  }
  for (const language of problemLanguages(problem)) {
    const code = step.code[language];
    if (code === undefined) {
      errors.push(`${tag}: no code for ${language}`);
      continue;
    }
    if (!/TODO/.test(code.starter)) errors.push(`${tag} [${language}]: starter has no TODO marker`);
    if (code.starter.trim() === code.solution.trim()) errors.push(`${tag} [${language}]: starter equals solution`);
    const start = judge(step, language, code.starter);
    const sol = judge(step, language, code.solution);
    if (verbose) {
      console.log(
        `    ${language.padEnd(6)} starter ${start.passed}/${start.total} · solution ${sol.passed}/${sol.total}`,
      );
      for (const r of sol.results) if (!r.passed) console.log(`      solution fails: ${r.id}`);
      for (const r of start.results) if (r.passed) console.log(`      starter passes: ${r.id}`);
    }
    if (start.accepted) errors.push(`${tag} [${language}]: the starter already passes every check`);
    // One pre-satisfied check (a route the starter registers) is tolerated; more means the checks are weak.
    if (start.passed > 1)
      errors.push(
        `${tag} [${language}]: the starter already passes ${start.passed} checks (${start.results
          .filter(r => r.passed)
          .map(r => r.id)
          .join(', ')})`,
      );
    for (const r of sol.results) if (!r.passed) errors.push(`${tag} [${language}]: solution fails check '${r.id}'`);
  }
  if (index === 0 && step.concept !== problem.concepts[0])
    errors.push(`${tag}: problem.concepts[0] should be the first step's concept (${step.concept})`);
  return errors;
}

function verifyProblem(problem: Problem): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9-]+$/.test(problem.id)) errors.push(`${problem.id}: problem id must be kebab-case`);
  // A single-topic problem (one concept listed) drills that concept alone and may be one step long;
  // a course covers all four concepts over at least MIN_STEPS steps.
  const single = problem.concepts.length === 1;
  if (problem.steps.length < (single ? 1 : MIN_STEPS))
    errors.push(`${problem.id}: needs at least ${single ? 1 : MIN_STEPS} steps`);
  if (problem.statement.trim() === '') errors.push(`${problem.id}: empty statement`);
  for (const w of widgetsOf(problem.statement))
    if (WIDGETS[w] === undefined) errors.push(`${problem.id}: unknown widget '${w}'`);
  if (problem.learn !== undefined) {
    if (!/^#\s+\S/m.test(problem.learn)) errors.push(`${problem.id}: the learning guide has no '#' section`);
    for (const w of widgetsOf(problem.learn))
      if (WIDGETS[w] === undefined) errors.push(`${problem.id}: learning guide: unknown widget '${w}'`);
    for (const what of malformedBlocksOf(problem.learn)) errors.push(`${problem.id}: learning guide: ${what}`);
  }
  for (const what of malformedBlocksOf(problem.statement)) errors.push(`${problem.id}: statement: ${what}`);
  // The systems track draws one system diagram; the deep-learning track draws titled figures, layer
  // stacks for PyTorch models and GPU figures for CUDA kernels, as many as the problem needs.
  if (problem.track === 'dllm') {
    const figures = problem.figures ?? [];
    const kernel = problem.language === 'cuda';
    if (figures.length === 0) errors.push(`${problem.id}: a deep-learning problem draws at least one figure`);
    else if (!figures.some(f => isArchitectureFigure(f) !== kernel))
      errors.push(
        `${problem.id}: ${
          kernel ? 'a CUDA problem draws a GPU figure' : 'a PyTorch problem draws an architecture figure'
        }`,
      );
    if (problem.diagram !== undefined) errors.push(`${problem.id}: a deep-learning problem has no system diagram`);
    const titles = new Set<string>();
    const seen = new Set<string>();
    for (const f of figures) {
      if (f.title.trim() === '') errors.push(`${problem.id}: a figure has no title`);
      else if (titles.has(f.title)) errors.push(`${problem.id}: two figures are titled '${f.title}'`);
      titles.add(f.title);
      for (const what of isArchitectureFigure(f) ? architectureProblems(f.architecture) : gpuProblems(f.gpu))
        errors.push(`${problem.id}: figure '${f.title}': ${what}`);
      for (const id of figureIds(f)) {
        if (seen.has(id)) errors.push(`${problem.id}: id '${id}' is in two figures, so a step's focus is ambiguous`);
        seen.add(id);
      }
    }
    for (const [where, text] of [
      ['statement', problem.statement],
      ['learning guide', problem.learn ?? ''],
    ] as const)
      if (/^:::(sequence|diagram)\b/m.test(text))
        errors.push(
          `${problem.id}: ${where} uses a systems figure (:::sequence / :::diagram) in the deep-learning track`,
        );
    if (problem.learn !== undefined) {
      const kind = kernel ? 'gpu' : 'architecture';
      if (!new RegExp(`^:::${kind}\\b`, 'm').test(problem.learn))
        errors.push(`${problem.id}: the learning guide draws no :::${kind} figure`);
      if (widgetsOf(problem.learn).length === 0)
        errors.push(`${problem.id}: the learning guide has no interactive widget`);
    }
  } else {
    if (problem.diagram === undefined) errors.push(`${problem.id}: draws no system diagram`);
    if (problem.figures !== undefined) errors.push(`${problem.id}: figures belong to the deep-learning track`);
  }
  const nodeIds = new Set<string>();
  for (const node of problem.diagram?.nodes ?? []) {
    if (nodeIds.has(node.id)) errors.push(`${problem.id}: duplicate diagram node '${node.id}'`);
    nodeIds.add(node.id);
    if (node.x < 0 || node.x > 100 || node.y < 0 || node.y > 100)
      errors.push(`${problem.id}: node '${node.id}' is off the canvas (x/y are percentages)`);
  }
  for (const edge of problem.diagram?.edges ?? []) {
    if (!nodeIds.has(edge.from)) errors.push(`${problem.id}: edge from unknown node '${edge.from}'`);
    if (!nodeIds.has(edge.to)) errors.push(`${problem.id}: edge to unknown node '${edge.to}'`);
  }
  const covered = new Set(problem.steps.map(s => s.concept));
  if (single) {
    for (const step of problem.steps)
      if (step.concept !== problem.concepts[0])
        errors.push(`${problem.id}/${step.id}: a single-topic problem's steps all exercise ${problem.concepts[0]}`);
  } else {
    for (const concept of SYSTEMS_CONCEPTS)
      if (!covered.has(concept)) errors.push(`${problem.id}: no step exercises ${concept}`);
  }
  // A fixed language is one of the deep-learning track's; a course has none.
  if (problem.language !== undefined && problem.track !== 'dllm')
    errors.push(`${problem.id}: only the deep-learning track fixes a language`);
  if (problem.track === 'dllm' && problem.language === undefined)
    errors.push(`${problem.id}: a deep-learning problem fixes its language`);
  if (problem.track === 'dllm' && !single)
    errors.push(`${problem.id}: a deep-learning problem lists its one concept (pytorch or cuda)`);
  for (const concept of problem.concepts)
    if (!covered.has(concept)) errors.push(`${problem.id}: lists concept ${concept} but no step exercises it`);
  // The playground shows a course as one filesystem per language: two steps may not own one file.
  for (const language of problemLanguages(problem)) {
    const names = new Set<string>();
    for (const step of problem.steps) {
      const name = fileName(step.file, language);
      if (names.has(name)) errors.push(`${problem.id}: two steps own the file ${name}`);
      names.add(name);
    }
  }
  const stepIds = new Set<string>();
  for (const [i, step] of problem.steps.entries()) {
    if (stepIds.has(step.id)) errors.push(`${problem.id}: duplicate step id '${step.id}'`);
    stepIds.add(step.id);
    errors.push(...verifyStep(problem, step, i));
  }
  // Sources. A company-tagged course is derived from the company's writing and says so in a "From the
  // source" section; a deep-learning problem cites the paper, code and posts behind its mechanism, each
  // with its kind and venue. Every source is a real https link, listed once, dated (only documentation
  // may go undated), with what the problem takes from it.
  const sources = problem.sources ?? [];
  const tagged = problem.company !== undefined;
  if (tagged) {
    if (sources.length === 0) errors.push(`${problem.id}: company tagged but lists no source`);
    if (!/^## From the source\b/m.test(problem.statement))
      errors.push(`${problem.id}: company tagged but the statement has no "## From the source" section`);
  } else if (problem.track === 'dllm') {
    if (sources.length === 0)
      errors.push(`${problem.id}: a deep-learning problem cites its sources (paper, code, posts)`);
  } else if (problem.sources !== undefined) errors.push(`${problem.id}: lists sources but names no company`);
  const urls = new Set<string>();
  for (const s of sources) {
    if (!/^https:\/\/\S+$/.test(s.url)) errors.push(`${problem.id}: source '${s.title}' needs an https URL`);
    if (urls.has(s.url)) errors.push(`${problem.id}: source ${s.url} is listed twice`);
    urls.add(s.url);
    if (s.date !== undefined ? !/^\d{4}-\d{2}(-\d{2})?$/.test(s.date) : tagged || s.kind !== 'docs')
      errors.push(
        `${problem.id}: source '${
          s.title
        }' needs a date, YYYY-MM-DD or YYYY-MM (only documentation may go undated; got '${s.date ?? ''}')`,
      );
    if (s.title.trim() === '' || s.takes.trim() === '')
      errors.push(`${problem.id}: a source needs a title and what the problem takes from it`);
    if (!tagged && (s.kind === undefined || (s.venue ?? '').trim() === ''))
      errors.push(`${problem.id}: source '${s.title}' names its kind and venue`);
  }
  return errors;
}

async function loadProblems(): Promise<Problem[]> {
  // Both imports are deliberately lazy: `--file` names a module only known at run time, and a
  // static import of the index would load every problem — one broken sibling file would then
  // prevent verifying the file being edited.
  if (onlyFile !== null) {
    const mod = (await import(resolve(onlyFile))) as Record<string, unknown>;
    const found = Object.values(mod).filter(
      (v): v is Problem => typeof v === 'object' && v !== null && 'steps' in v && 'statement' in v,
    );
    if (found.length === 0) throw new Error(`${onlyFile} exports no Problem`);
    return found;
  }
  const {problems} = await import('../src/data/problems');
  return problems;
}

/** The job that runs `step` of `problem` with `code` as its file: every other file is the reference solution. */
function runJob(problem: Problem, step: Step, language: Language, code: string): RunJob {
  const files: Record<string, string> = {};
  for (const s of problem.steps) files[fileName(s.file, language)] = s === step ? code : codeFor(s, language).solution;
  return {
    files,
    support: problem.support?.[language] ?? {},
    harness: step.harness?.[language] ?? '',
    checks: step.checks.map(c => c.id),
    entry: fileName(step.file, language),
  };
}

const describeRun = (run: RunResult): string =>
  run.error !== undefined
    ? `error: ${run.error}`
    : run.checks
        .filter(c => !c.passed)
        .map(c => `${c.id}${c.message ? ` (${c.message})` : ''}`)
        .join(', ');

/** `check_<id>`, the Python and TypeScript harness function for a check. */
const snakeCheckName = (id: string): string => `check_${id.replace(/-/g, '_')}`;

/** `Check<Id>`, the Go harness function for a check: `release-atomic` → `CheckReleaseAtomic` (goruntime/host). */
const goCheckName = (id: string): string =>
  `Check${id
    .split(/[-_ ]/)
    .filter(part => part !== '')
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('')}`;

/** Languages graded by execution, each with its harness's check names, how a harness declares one, and how its Node runtime boots. */
const EXECUTING: {
  language: Language;
  checkName: (id: string) => string;
  declares: (harness: string, name: string) => boolean;
  boot: () => Promise<NodeRuntime>;
}[] = [
  {
    language: 'python',
    checkName: snakeCheckName,
    declares: (harness, name) => new RegExp(`^(async )?def ${name}\\(`, 'm').test(harness),
    boot: createNodePythonRuntime,
  },
  {
    language: 'typescript',
    checkName: snakeCheckName,
    declares: (harness, name) =>
      new RegExp(`^export (async function ${name}\\b|const ${name}\\s*=)`, 'm').test(harness),
    boot: async () => createNodeTypeScriptRuntime(),
  },
  {
    language: 'go',
    checkName: goCheckName,
    declares: (harness, name) => new RegExp(`^func ${name}\\(\\w+ \\*harness\\.Ctx\\)`, 'm').test(harness),
    boot: createNodeGoRuntime,
  },
];

/** The Go runtime's WebAssembly must come from the committed goruntime/ sources (`yarn build:go` records their hash). */
function goRuntimeFreshness(): string[] {
  if (!existsSync(GO_RUNTIME_MANIFEST)) return [`${GO_RUNTIME_MANIFEST} is missing: run yarn build:go`];
  const built = (JSON.parse(readFileSync(GO_RUNTIME_MANIFEST, 'utf8')) as {hash?: string}).hash;
  return built === goRuntimeHash()
    ? []
    : ['public/go/runtime.wasm.gz was built from other goruntime/ sources than these: run yarn build:go'];
}

/** Runtime checks of one problem in one language: harness shape, solution passes, starter does not. */
async function verifyRuntime(
  problem: Problem,
  language: Language,
  checkName: (id: string) => string,
  declares: (harness: string, name: string) => boolean,
  runtime: NodeRuntime,
): Promise<string[]> {
  const errors: string[] = [];
  for (const step of problem.steps) {
    const harness = step.harness?.[language];
    if (harness === undefined) continue;
    const tag = `${problem.id}/${step.id} [${language} runtime]`;
    for (const check of step.checks) {
      const name = checkName(check.id);
      if (!declares(harness, name)) errors.push(`${tag}: harness defines no ${name}`);
    }
    const solution = await runtime.run(runJob(problem, step, language, codeFor(step, language).solution));
    if (solution.error !== undefined || !solution.checks.every(c => c.passed))
      errors.push(`${tag}: solution fails — ${describeRun(solution)}`);
    const starter = await runtime.run(runJob(problem, step, language, codeFor(step, language).starter));
    if (starter.error === undefined && starter.checks.every(c => c.passed))
      errors.push(`${tag}: the starter already passes every runtime check`);
    if (verbose) {
      console.log(
        `    ${language} runtime  solution ${solution.checks.filter(c => c.passed).length}/${solution.checks.length} (${
          solution.ms
        } ms) · starter ${starter.checks.filter(c => c.passed).length}/${starter.checks.length}`,
      );
      for (const c of starter.checks) if (!c.passed) console.log(`      starter fails ${c.id}: ${c.message ?? ''}`);
    }
  }
  return errors;
}

async function main(): Promise<void> {
  const errors: string[] = [...judgeSelfTest(), ...goRuntimeFreshness()];
  console.log(`${errors.length === 0 ? '✓' : '✗'} judge self-tests, Go runtime built from these sources`);
  const problems = await loadProblems();
  const ids = new Set<string>();
  let steps = 0;
  let checked = 0;
  const harnesses: Partial<Record<Language, number>> = {};
  const selected = problems.filter(p => onlyProblem === null || p.id === onlyProblem || onlyProblem.endsWith(p.id));
  const runtimes: Partial<Record<Language, NodeRuntime>> = {};
  if (withRuntime)
    for (const {language, boot} of EXECUTING) {
      if (onlyRuntime !== null && onlyRuntime !== language) continue;
      if (!selected.some(p => p.steps.some(s => s.harness?.[language] !== undefined))) continue;
      const started = Date.now();
      runtimes[language] = await boot();
      console.log(`✓ ${language} runtime booted (${Date.now() - started} ms)`);
    }
  for (const problem of problems) {
    if (ids.has(problem.id)) errors.push(`duplicate problem id '${problem.id}'`);
    ids.add(problem.id);
    if (!selected.includes(problem)) continue;
    const started = Date.now();
    const e = verifyProblem(problem);
    for (const {language, checkName, declares} of EXECUTING) {
      const runtime = runtimes[language];
      if (runtime !== undefined) e.push(...(await verifyRuntime(problem, language, checkName, declares, runtime)));
      harnesses[language] =
        (harnesses[language] ?? 0) + problem.steps.filter(s => s.harness?.[language] !== undefined).length;
    }
    steps += problem.steps.length;
    checked += problem.steps.length * problemLanguages(problem).length;
    console.log(
      `${e.length === 0 ? '✓' : '✗'} ${problem.title} — ${problem.steps.length} steps (${Date.now() - started} ms)`,
    );
    errors.push(...e);
  }
  // The live maximum is the sum over every course; it only grows as content is added.
  if (onlyFile === null && onlyProblem === null) {
    const total = problems.reduce((sum, p) => sum + STEP_POINTS[p.difficulty] * p.steps.length, 0);
    const counts = problems.reduce<Record<string, number>>((acc, p) => {
      acc[p.difficulty] = (acc[p.difficulty] ?? 0) + p.steps.length;
      return acc;
    }, {});
    if (total <= 0) errors.push('course totals are not positive');
    else console.log(`✓ course totals ${total} points (${JSON.stringify(counts)})`);
  }
  const ran = EXECUTING.filter(({language}) => !withRuntime || runtimes[language] !== undefined)
    .map(({language}) => `${harnesses[language] ?? 0} ${language}`)
    .join(' + ');
  console.log(
    `\n${steps} step(s), ${checked} step-language pairs checked, ${ran} harness(es)${
      withRuntime ? ' run' : ' skipped'
    }, ${errors.length} problem(s)`,
  );
  for (const e of errors) console.log(`  - ${e}`);
  process.exitCode = errors.length === 0 ? 0 : 1;
}

void main();
