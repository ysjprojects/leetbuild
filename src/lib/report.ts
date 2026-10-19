/**
 * "Something wrong with this step?" — a GitHub issue prefilled with what a maintainer cannot see
 * from here: the step, the language, the browser and the last verdict. The learner's code is not
 * attached; the template asks for it only when the verdict itself is in question.
 */
import type {Verdict} from './judge';
import {type Language, type Problem, type Step, fileName, LANGUAGE_LABEL} from './types';

export const REPO_URL = 'https://github.com/ysjprojects/leetbuild';

/** GitHub refuses very long URLs; the body is cut well under the limit. */
const BODY_LIMIT = 3500;
const MESSAGE_LIMIT = 240;

const trim = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);

const describeVerdict = (verdict: Verdict | null): string => {
  if (verdict === null) return 'none yet';
  if (verdict.run?.error !== undefined) return `could not run — ${trim(verdict.run.error, MESSAGE_LIMIT)}`;
  const head = `${verdict.trial === true ? 'Run (example only)' : verdict.accepted ? 'Accepted' : 'Wrong Answer'} ${
    verdict.passed
  }/${verdict.total}`;
  const failing = verdict.results
    .filter(r => !r.passed)
    .map(r => `- ${r.title}${r.message !== undefined ? ` — ${trim(r.message, MESSAGE_LIMIT)}` : ''}`);
  return failing.length === 0 ? head : `${head}\n${failing.join('\n')}`;
};

export function stepIssueUrl(input: {
  problem: Problem;
  step: Step;
  /** Position of the step in its problem. */
  index: number;
  language: Language;
  /** The step's public address. */
  url: string;
  verdict: Verdict | null;
  userAgent: string;
}): string {
  const {problem, step, index, language, url, verdict, userAgent} = input;
  const title = `step: ${problem.title} › ${index + 1}. ${step.title}`;
  const body = trim(
    [
      `**Step**: ${problem.title} › ${index + 1}. ${step.title}`,
      `**URL**: ${url}`,
      `**Language**: ${LANGUAGE_LABEL[language]}`,
      `**Browser**: ${userAgent}`,
      `**Last verdict**: ${describeVerdict(verdict)}`,
      '',
      '## What is wrong',
      '',
      '<!-- The task, a hint, the debrief, a check that is unfair, a verdict you believe is wrong. If the verdict is',
      `     in question, paste the ${fileName(step.file, language)} you submitted below so it can be run. -->`,
      '',
    ].join('\n'),
    BODY_LIMIT,
  );
  const params = new URLSearchParams({title, body});
  return `${REPO_URL}/issues/new?${params.toString()}`;
}
