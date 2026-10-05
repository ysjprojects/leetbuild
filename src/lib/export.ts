/**
 * Markdown export of one course (a problem's step-by-step tutorial) in one language: the
 * statement, the architecture as a Mermaid flowchart, and per step the sequence diagram, the task,
 * the checks, the starter, hints and the reference solution behind `<details>` spoilers, and the
 * debrief. Interactive widgets become a note with a link back to the live step.
 */
import {night} from '@/styles/palette';

import {
  type Diagram,
  type Language,
  type Problem,
  type Sequence,
  type Step,
  CONCEPT_LABEL,
  fileName,
  LANGUAGE_LABEL,
  LANGUAGE_STACK,
  stepPath,
} from './types';
import {WIDGETS} from './widgets';

/** Where this app is served: `NEXT_PUBLIC_SITE_URL` when deployed, otherwise the page's own origin. */
export const siteUrl = (): string =>
  process.env.NEXT_PUBLIC_SITE_URL ?? (typeof window === 'undefined' ? '' : window.location.origin);

const FENCE_LANGUAGE: Record<Language, string> = {python: 'python', go: 'go', scala: 'scala', cpp: 'cpp'};

/** Mermaid node shape per component kind: `open` and `close` wrap the quoted label. */
const SHAPE: Record<Diagram['nodes'][number]['kind'], [string, string]> = {
  client: ['([', '])'],
  service: ['[', ']'],
  http: ['[', ']'],
  grpc: ['[', ']'],
  kafka: ['[[', ']]'],
  redis: ['[(', ')]'],
  db: ['[(', ')]'],
  external: ['{{', '}}'],
};

const mermaidLabel = (text: string): string => text.replace(/"/g, '#quot;');

/** Node ids must be identifiers; dashes are allowed by Mermaid but keep it plain. */
const nodeId = (id: string): string => `n_${id.replace(/[^a-zA-Z0-9]/g, '_')}`;

export function diagramToMermaid(diagram: Diagram): string {
  const lines = ['flowchart LR'];
  for (const node of diagram.nodes) {
    const [open, close] = SHAPE[node.kind];
    const label = node.sub === undefined ? node.label : `${node.label}<br/>${node.sub}`;
    lines.push(`  ${nodeId(node.id)}${open}"${mermaidLabel(label)}"${close}`);
  }
  for (const edge of diagram.edges) {
    const arrow = edge.kind === 'kafka' ? '-.->' : '-->';
    const label = edge.label === undefined ? '' : `|"${mermaidLabel(edge.label.replace(/\|/g, '/'))}"|`;
    lines.push(`  ${nodeId(edge.from)} ${arrow}${label} ${nodeId(edge.to)}`);
  }
  // Literal hex: the file is rendered by GitHub or Obsidian in the reader's own theme, so the
  // diagrams always wear Night's pastel fills with dark text, which read on light and dark alike.
  const kinds = Array.from(new Set(diagram.nodes.map(n => n.kind)));
  for (const kind of kinds) {
    lines.push(`  classDef ${kind} fill:${night.node[kind]},stroke:${night.ink[700]},color:${night.ink[950]}`);
    lines.push(
      `  class ${diagram.nodes
        .filter(n => n.kind === kind)
        .map(n => nodeId(n.id))
        .join(',')} ${kind}`,
    );
  }
  return lines.join('\n');
}

export function sequenceToMermaid(sequence: Sequence): string {
  const alias: Record<string, string> = {};
  const lines = ['sequenceDiagram'];
  sequence.participants.forEach((p, i) => {
    alias[p] = `P${i}`;
    lines.push(`  participant P${i} as ${p.replace(/[;#]/g, ' ')}`);
  });
  for (const m of sequence.messages) {
    const arrow = m.kind === 'reply' ? '-->>' : m.kind === 'async' ? '-)' : '->>';
    lines.push(`  ${alias[m.from]}${arrow}${alias[m.to]}: ${m.label.replace(/[;#]/g, ' ')}`);
  }
  return lines.join('\n');
}

/** Demote every ATX heading by `by` levels (capped at h6) so a document can nest the course text. */
export function shiftHeadings(markdown: string, by: number): string {
  return markdown.replace(/^(#{1,6})(\s)/gm, (_, hashes: string, space: string) => {
    return `${'#'.repeat(Math.min(6, hashes.length + by))}${space}`;
  });
}

/** Replace `:::widget name {json}` lines with a note and a link to the interactive version. */
export function widgetsToNotes(markdown: string, stepUrl: string): string {
  return markdown.replace(/^:::widget\s+([\w-]+)[^\n]*$/gm, (_, name: string) => {
    const about = WIDGETS[name]?.about ?? name;
    return `> **Interactive (${name}):** ${about} [Open it in LeetBuild.](${stepUrl})`;
  });
}

/** GitHub's heading anchor: lower-case, drop everything but letters/digits/spaces/hyphens, spaces → hyphens. */
export function githubSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .replace(/ /g, '-');
}

/** The live page of a problem; the share card and the exported Markdown link back to it. */
export const problemUrl = (problem: Problem): string => `${siteUrl()}/${problem.id}`;
const stepUrl = (problem: Problem, step: Step): string => `${siteUrl()}${stepPath(problem, step)}`;

function stepToMarkdown(problem: Problem, step: Step, index: number, language: Language): string {
  const code = step.code[language];
  const fence = FENCE_LANGUAGE[language];
  const url = stepUrl(problem, step);
  const parts: string[] = [];
  parts.push(`## Step ${index + 1} — ${step.title}`);
  parts.push('');
  parts.push(
    `*${CONCEPT_LABEL[step.concept]} · file \`${fileName(step.file, language)}\` · ${
      LANGUAGE_STACK[language][step.concept]
    } · [open in LeetBuild](${url})*`,
  );
  parts.push('');
  if (step.sequence !== undefined) {
    parts.push('### What happens at runtime');
    parts.push('');
    parts.push('```mermaid');
    parts.push(sequenceToMermaid(step.sequence));
    parts.push('```');
    parts.push('');
  }
  parts.push(widgetsToNotes(shiftHeadings(step.task, 1), url).trim());
  parts.push('');
  parts.push('### Checks');
  parts.push('');
  parts.push('The judge accepts the step when every check passes:');
  parts.push('');
  step.checks.forEach((check, i) => {
    parts.push(`${i + 1}. **${check.title}** — ${check.detail}`);
  });
  parts.push('');
  parts.push('### Starter');
  parts.push('');
  parts.push('```' + fence);
  parts.push(code.starter.trimEnd());
  parts.push('```');
  parts.push('');
  step.hints.forEach((hint, i) => {
    parts.push('<details>');
    parts.push(`<summary>Hint ${i + 1} of ${step.hints.length}</summary>`);
    parts.push('');
    parts.push(hint);
    parts.push('');
    parts.push('</details>');
    parts.push('');
  });
  parts.push('<details>');
  parts.push('<summary>Reference solution</summary>');
  parts.push('');
  parts.push('```' + fence);
  parts.push(code.solution.trimEnd());
  parts.push('```');
  parts.push('');
  parts.push('</details>');
  parts.push('');
  parts.push('### Debrief');
  parts.push('');
  parts.push(step.debrief.trim());
  parts.push('');
  return parts.join('\n');
}

export function problemToMarkdown(problem: Problem, language: Language): string {
  const parts: string[] = [];
  parts.push(`# ${problem.title}`);
  parts.push('');
  parts.push(
    `*LeetBuild · ${problem.difficulty} · ${problem.concepts.map(c => CONCEPT_LABEL[c]).join(', ')} · ~${
      problem.minutes
    } min · ${LANGUAGE_LABEL[language]} edition · [live version](${problemUrl(problem)})*`,
  );
  parts.push('');
  parts.push(problem.tagline);
  parts.push('');
  // The statement already starts with its own `# Title`; drop it and demote the rest under ours.
  const statement = problem.statement.replace(/^#\s+[^\n]*\n/, '');
  parts.push(widgetsToNotes(shiftHeadings(statement, 1), problemUrl(problem)).trim());
  parts.push('');
  parts.push('## Architecture');
  parts.push('');
  parts.push('```mermaid');
  parts.push(diagramToMermaid(problem.diagram));
  parts.push('```');
  parts.push('');
  parts.push('## Steps');
  parts.push('');
  problem.steps.forEach((step, i) => {
    parts.push(
      `${i + 1}. [${step.title}](#${githubSlug(`Step ${i + 1} — ${step.title}`)}) — ${CONCEPT_LABEL[step.concept]}`,
    );
  });
  parts.push('');
  problem.steps.forEach((step, i) => {
    parts.push(stepToMarkdown(problem, step, i, language));
  });
  return parts.join('\n');
}

/** File name for a course download: `leetbuild-image-cache-go.md`. */
export function exportFileName(problemId: string, language: Language): string {
  return `leetbuild-${problemId}-${language}.md`;
}

/** Trigger a browser download of `text` as a Markdown file. */
export function downloadMarkdown(name: string, text: string): void {
  const blob = new Blob([text], {type: 'text/markdown;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
