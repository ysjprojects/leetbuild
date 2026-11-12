import {type Language, type Problem, type Step, codeFor, fileName} from '../types';
import type {RunJob} from './types';

/**
 * The job that runs `step` of `problem` with `code` as the step's file, every check of its harness,
 * inside the course's system: every other step's file is its reference solution, so the code under
 * test talks to working neighbours instead of TODO stubs. `yarn verify` runs starters and solutions
 * this way, and the mock interview a submission. (The playground mounts the learner's own accepted
 * steps instead, where it has them.)
 */
export function stepJob(problem: Problem, step: Step, language: Language, code: string): RunJob {
  const files: Record<string, string> = {};
  for (const s of problem.steps)
    files[fileName(s.file, language)] = s.id === step.id ? code : codeFor(s, language).solution;
  return {
    files,
    support: problem.support?.[language] ?? {},
    harness: step.harness?.[language] ?? '',
    checks: step.checks.map(c => c.id),
    entry: fileName(step.file, language),
  };
}
