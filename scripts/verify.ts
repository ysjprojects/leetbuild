/**
 * Checks every /leetbuild problem: the shape of the problem (steps, diagram, sequences, hints,
 * widgets), for every step in every language that the starter fails at least one static check
 * while the reference solution passes them all, and for every step with a Python or TypeScript
 * harness that the solution passes every runtime check while the starter does not (the harnesses
 * run in the browser runtimes, here in Node). Run after editing problems:
 *
 *   yarn verify                               # everything
 *   yarn verify --problem image-cache         # one problem (by id or NN- prefix)
 *   yarn verify --file src/data/problems/00-image-cache/index.ts   # one problem file, not via the index
 *   yarn verify --verbose                     # list every check result
 *   yarn verify --no-runtime                  # static checks only (no Pyodide boot)
 *   yarn verify --runtime typescript          # execute only the TypeScript harnesses (no Pyodide boot)
 */
import {resolve} from 'node:path';

import {malformedBlocksOf, widgetsOf} from '../src/components/Markdown';
import {describePattern, judge, matches, stripComments} from '../src/lib/judge';
import {type NodeRuntime, createNodePythonRuntime, createNodeTypeScriptRuntime} from '../src/lib/runtime/node';
import {type RunJob, type RunResult} from '../src/lib/runtime/types';
import {STEP_POINTS} from '../src/lib/scoring';
import {type Language, type Problem, type Step, CONCEPTS, fileName, LANGUAGES} from '../src/lib/types';
import {WIDGETS} from '../src/lib/widgets';

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

function verifyStep(problem: Problem, step: Step, index: number): string[] {
  const errors: string[] = [];
  const tag = `${problem.id}/${step.id}`;
  const nodeIds = new Set(problem.diagram.nodes.map(n => n.id));
  if (!/^[a-z0-9-]+$/.test(step.id)) errors.push(`${tag}: step id must be kebab-case`);
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
    for (const language of LANGUAGES) {
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
  for (const language of LANGUAGES) {
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
  if (problem.steps.length < MIN_STEPS) errors.push(`${problem.id}: needs at least ${MIN_STEPS} steps`);
  if (problem.statement.trim() === '') errors.push(`${problem.id}: empty statement`);
  for (const w of widgetsOf(problem.statement))
    if (WIDGETS[w] === undefined) errors.push(`${problem.id}: unknown widget '${w}'`);
  if (problem.learn !== undefined) {
    if (!/^#\s+\S/m.test(problem.learn)) errors.push(`${problem.id}: the learning guide has no '#' section`);
    for (const w of widgetsOf(problem.learn))
      if (WIDGETS[w] === undefined) errors.push(`${problem.id}: learning guide: unknown widget '${w}'`);
    for (const what of malformedBlocksOf(problem.learn)) errors.push(`${problem.id}: learning guide: ${what}`);
  }
  const nodeIds = new Set<string>();
  for (const node of problem.diagram.nodes) {
    if (nodeIds.has(node.id)) errors.push(`${problem.id}: duplicate diagram node '${node.id}'`);
    nodeIds.add(node.id);
    if (node.x < 0 || node.x > 100 || node.y < 0 || node.y > 100)
      errors.push(`${problem.id}: node '${node.id}' is off the canvas (x/y are percentages)`);
  }
  for (const edge of problem.diagram.edges) {
    if (!nodeIds.has(edge.from)) errors.push(`${problem.id}: edge from unknown node '${edge.from}'`);
    if (!nodeIds.has(edge.to)) errors.push(`${problem.id}: edge to unknown node '${edge.to}'`);
  }
  const covered = new Set(problem.steps.map(s => s.concept));
  for (const concept of CONCEPTS) if (!covered.has(concept)) errors.push(`${problem.id}: no step exercises ${concept}`);
  for (const concept of problem.concepts)
    if (!covered.has(concept)) errors.push(`${problem.id}: lists concept ${concept} but no step exercises it`);
  // The playground shows a course as one filesystem per language: two steps may not own one file.
  for (const language of LANGUAGES) {
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
  // Company tagged: the company and at least one source, each a real https link with a dated, explained take.
  if (problem.company !== undefined || problem.sources !== undefined) {
    if (problem.company === undefined) errors.push(`${problem.id}: lists sources but names no company`);
    if (problem.sources === undefined || problem.sources.length === 0)
      errors.push(`${problem.id}: company tagged but lists no source`);
    if (!/^## From the source\b/m.test(problem.statement))
      errors.push(`${problem.id}: company tagged but the statement has no "## From the source" section`);
    for (const s of problem.sources ?? []) {
      if (!/^https:\/\/\S+$/.test(s.url)) errors.push(`${problem.id}: source '${s.title}' needs an https URL`);
      if (!/^\d{4}-\d{2}(-\d{2})?$/.test(s.date))
        errors.push(`${problem.id}: source '${s.title}' date must be YYYY-MM-DD or YYYY-MM (got '${s.date}')`);
      if (s.title.trim() === '' || s.takes.trim() === '')
        errors.push(`${problem.id}: a source needs a title and what the course takes from it`);
    }
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
      (v): v is Problem => typeof v === 'object' && v !== null && 'steps' in v && 'diagram' in v,
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
  for (const s of problem.steps) files[fileName(s.file, language)] = s === step ? code : s.code[language].solution;
  return {
    files,
    support: problem.support?.[language] ?? {},
    harness: step.harness?.[language] ?? '',
    checks: step.checks.map(c => c.id),
  };
}

const describeRun = (run: RunResult): string =>
  run.error !== undefined
    ? `error: ${run.error}`
    : run.checks
        .filter(c => !c.passed)
        .map(c => `${c.id}${c.message ? ` (${c.message})` : ''}`)
        .join(', ');

/** Languages graded by execution, each with how a harness declares `check_<id>` and how its Node runtime boots. */
const EXECUTING: {
  language: Language;
  declares: (harness: string, name: string) => boolean;
  boot: () => Promise<NodeRuntime>;
}[] = [
  {
    language: 'python',
    declares: (harness, name) => new RegExp(`^(async )?def ${name}\\(`, 'm').test(harness),
    boot: createNodePythonRuntime,
  },
  {
    language: 'typescript',
    declares: (harness, name) =>
      new RegExp(`^export (async function ${name}\\b|const ${name}\\s*=)`, 'm').test(harness),
    boot: async () => createNodeTypeScriptRuntime(),
  },
];

/** Runtime checks of one problem in one language: harness shape, solution passes, starter does not. */
async function verifyRuntime(
  problem: Problem,
  language: Language,
  declares: (harness: string, name: string) => boolean,
  runtime: NodeRuntime,
): Promise<string[]> {
  const errors: string[] = [];
  for (const step of problem.steps) {
    const harness = step.harness?.[language];
    if (harness === undefined) continue;
    const tag = `${problem.id}/${step.id} [${language} runtime]`;
    for (const check of step.checks) {
      const name = `check_${check.id.replace(/-/g, '_')}`;
      if (!declares(harness, name)) errors.push(`${tag}: harness defines no ${name}`);
    }
    const solution = await runtime.run(runJob(problem, step, language, step.code[language].solution));
    if (solution.error !== undefined || !solution.checks.every(c => c.passed))
      errors.push(`${tag}: solution fails — ${describeRun(solution)}`);
    const starter = await runtime.run(runJob(problem, step, language, step.code[language].starter));
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
  const errors: string[] = judgeSelfTest();
  console.log(`${errors.length === 0 ? '✓' : '✗'} judge self-tests`);
  const problems = await loadProblems();
  const ids = new Set<string>();
  let steps = 0;
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
    for (const {language, declares} of EXECUTING) {
      const runtime = runtimes[language];
      if (runtime !== undefined) e.push(...(await verifyRuntime(problem, language, declares, runtime)));
      harnesses[language] =
        (harnesses[language] ?? 0) + problem.steps.filter(s => s.harness?.[language] !== undefined).length;
    }
    steps += problem.steps.length;
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
  const languages: Language[] = [...LANGUAGES];
  const ran = EXECUTING.filter(({language}) => !withRuntime || runtimes[language] !== undefined)
    .map(({language}) => `${harnesses[language] ?? 0} ${language}`)
    .join(' + ');
  console.log(
    `\n${steps} step(s) × ${languages.length} languages checked, ${ran} harness(es)${
      withRuntime ? ' run' : ' skipped'
    }, ${errors.length} problem(s)`,
  );
  for (const e of errors) console.log(`  - ${e}`);
  process.exitCode = errors.length === 0 ? 0 : 1;
}

void main();
