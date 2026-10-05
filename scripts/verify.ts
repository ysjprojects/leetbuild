/**
 * Checks every /leetbuild problem: the shape of the problem (steps, diagram, sequences, hints,
 * widgets), and for every step in every language that the starter fails at least one check while
 * the reference solution passes them all. Run after editing problems:
 *
 *   yarn verify                               # everything
 *   yarn verify --problem image-cache         # one problem (by id or NN- prefix)
 *   yarn verify --file src/data/problems/00-image-cache/index.ts   # one problem file, not via the index
 *   yarn verify --verbose                     # list every check result
 */
import {resolve} from 'node:path';

import {widgetsOf} from '../src/components/Markdown';
import {describePattern, judge, matches, stripComments} from '../src/lib/judge';
import {COURSE_POINTS, STEP_POINTS} from '../src/lib/scoring';
import {type Language, type Problem, type Step, CONCEPTS, LANGUAGES} from '../src/lib/types';
import {WIDGETS} from '../src/lib/widgets';

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const onlyProblem = flag('--problem');
const onlyFile = flag('--file');
const verbose = args.includes('--verbose');

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
  const stepIds = new Set<string>();
  for (const [i, step] of problem.steps.entries()) {
    if (stepIds.has(step.id)) errors.push(`${problem.id}: duplicate step id '${step.id}'`);
    stepIds.add(step.id);
    errors.push(...verifyStep(problem, step, i));
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

async function main(): Promise<void> {
  const errors: string[] = judgeSelfTest();
  console.log(`${errors.length === 0 ? '✓' : '✗'} judge self-tests`);
  const problems = await loadProblems();
  const ids = new Set<string>();
  let steps = 0;
  for (const problem of problems) {
    if (ids.has(problem.id)) errors.push(`duplicate problem id '${problem.id}'`);
    ids.add(problem.id);
    if (onlyProblem !== null && problem.id !== onlyProblem && !onlyProblem.endsWith(problem.id)) continue;
    const started = Date.now();
    const e = verifyProblem(problem);
    steps += problem.steps.length;
    console.log(
      `${e.length === 0 ? '✓' : '✗'} ${problem.title} — ${problem.steps.length} steps (${Date.now() - started} ms)`,
    );
    errors.push(...e);
  }
  // The course total is a fixed number; only meaningful when every problem was loaded.
  if (onlyFile === null && onlyProblem === null) {
    const total = problems.reduce((sum, p) => sum + STEP_POINTS[p.difficulty] * p.steps.length, 0);
    if (total !== COURSE_POINTS) {
      const counts = problems.reduce<Record<string, number>>((acc, p) => {
        acc[p.difficulty] = (acc[p.difficulty] ?? 0) + p.steps.length;
        return acc;
      }, {});
      errors.push(
        `course totals ${total} points, not ${COURSE_POINTS}: re-balance STEP_POINTS in src/lib/scoring.ts for ${JSON.stringify(
          counts,
        )} steps`,
      );
    } else console.log(`✓ course totals ${COURSE_POINTS} points`);
  }
  const languages: Language[] = [...LANGUAGES];
  console.log(`\n${steps} step(s) × ${languages.length} languages checked, ${errors.length} problem(s)`);
  for (const e of errors) console.log(`  - ${e}`);
  process.exitCode = errors.length === 0 ? 0 : 1;
}

void main();
