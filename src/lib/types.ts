/**
 * Content model for /leetbuild: problems are systems (a match engine, an image cache…) that the
 * learner builds step by step in one of four languages. Every step is a self-contained file with a
 * starter and a reference solution per language, a task statement, progressive hints, and a list
 * of checks the judge runs against the learner's code (see judge.ts).
 *
 * The systems are deliberately simplified abstractions of their real-world versions: each problem
 * statement says what was left out so the learner practises the implementation skills that carry
 * over (idempotency, deadlines, partition keys, TTLs…) instead of framework trivia.
 */

export type Language = 'python' | 'go' | 'scala' | 'cpp';

export const LANGUAGES: readonly Language[] = ['python', 'go', 'scala', 'cpp'];

export const LANGUAGE_LABEL: Record<Language, string> = {python: 'Python', go: 'Go', scala: 'Scala', cpp: 'C++'};

/** Libraries the reference solutions use; shown next to the editor so the learner knows the target API. */
export const LANGUAGE_STACK: Record<Language, Record<Concept, string>> = {
  python: {http: 'FastAPI + uvicorn', grpc: 'grpcio (grpc.aio)', kafka: 'confluent-kafka', redis: 'redis-py'},
  go: {http: 'net/http', grpc: 'google.golang.org/grpc', kafka: 'segmentio/kafka-go', redis: 'go-redis v9'},
  scala: {http: 'Pekko HTTP', grpc: 'ScalaPB + grpc-java', kafka: 'kafka-clients (Java)', redis: 'Jedis'},
  cpp: {http: 'cpp-httplib', grpc: 'grpc++', kafka: 'librdkafka (C++ API)', redis: 'redis-plus-plus'},
};

const FILE_EXTENSION: Record<Language, string> = {python: 'py', go: 'go', scala: 'scala', cpp: 'cpp'};

/** File name shown on the editor tab: `order_gateway` → `order_gateway.py` / `OrderGateway.scala`. */
export function fileName(stem: string, language: Language): string {
  if (language === 'scala') {
    const pascal = stem
      .split('_')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
    return `${pascal}.scala`;
  }
  return `${stem}.${FILE_EXTENSION[language]}`;
}

export type Concept = 'http' | 'grpc' | 'kafka' | 'redis';

export const CONCEPTS: readonly Concept[] = ['http', 'grpc', 'kafka', 'redis'];

export const CONCEPT_LABEL: Record<Concept, string> = {http: 'HTTPS', grpc: 'gRPC', kafka: 'Kafka', redis: 'Redis'};

export type Difficulty = 'easy' | 'medium' | 'hard';

/**
 * What a check looks for in the learner's code once comments are stripped. Every `all` pattern
 * must match, no `none` pattern may match, and the `order` patterns must each match with their
 * first matches in increasing position (used for "validate before you enqueue", "commit after you
 * process"…). An empty matcher always passes.
 */
export interface Matcher {
  all?: RegExp[];
  none?: RegExp[];
  order?: RegExp[];
}

/** One named test case of a step, like one LeetCode test case: pass/fail with a reason. */
export interface StepCheck {
  /** Stable id within the step, e.g. `ttl`. */
  id: string;
  /** Shown in the verdict table: "Cache entries expire". */
  title: string;
  /** Shown when the check fails: what it looks for and why it matters. Markdown inline. */
  detail: string;
  match: Record<Language, Matcher>;
}

export interface StepCode {
  /** Starting file with `TODO` markers where the learner works; must fail at least one check. */
  starter: string;
  /** Reference solution; must pass every check. Revealable at the cost of the step's points. */
  solution: string;
}

export type NodeKind = 'client' | 'service' | 'http' | 'grpc' | 'kafka' | 'redis' | 'db' | 'external';

/**
 * A box of the architecture diagram. Placement is automatic (leetbuild/layout.ts lays the call
 * graph out left to right); `x`/`y` (0–100) only order nodes that the graph leaves tied — `y` is
 * the preferred vertical order within a column.
 */
export interface DiagramNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Second line: a topic name, a port, a cache key… */
  sub?: string;
  x: number;
  y: number;
}

export type EdgeKind = 'http' | 'grpc' | 'kafka' | 'redis' | 'plain';

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  kind?: EdgeKind;
}

export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface SequenceMessage {
  from: string;
  to: string;
  label: string;
  /** `sync` = request (solid), `reply` = response (dashed), `async` = fire-and-forget (open arrowhead). */
  kind?: 'sync' | 'reply' | 'async';
}

/** Runtime interaction the step implements, drawn as a sequence diagram above the task. */
export interface Sequence {
  participants: string[];
  messages: SequenceMessage[];
}

export interface Step {
  id: string;
  title: string;
  /** The concept this step exercises; problems cover all four across their steps. */
  concept: Concept;
  /** snake_case stem of the file the learner edits (see `fileName`). */
  file: string;
  /** Task statement in the course markdown dialect (components/Kernels/Markdown.tsx); may embed `:::widget`. */
  task: string;
  /** Diagram node ids this step builds; they light up while the step is open. */
  focus: string[];
  sequence?: Sequence;
  /** Progressive hints, cheapest first (2–3). Each one revealed costs part of the step's points. */
  hints: string[];
  checks: StepCheck[];
  code: Record<Language, StepCode>;
  /** Shown once the step is accepted or revealed: why the solution is shaped this way, what real systems add. */
  debrief: string;
}

export interface Problem {
  id: string;
  title: string;
  /** One line for the problem list. */
  tagline: string;
  difficulty: Difficulty;
  /** Concepts exercised, in the order the steps meet them. */
  concepts: Concept[];
  /** Estimated time for all steps, in minutes. */
  minutes: number;
  /** Problem statement: the real system, the simplified abstraction built here, what is out of scope. */
  statement: string;
  diagram: Diagram;
  steps: Step[];
}

/** `problemId/stepId`: the key attempts and workspaces are stored under. */
export function stepKey(problemId: string, stepId: string): string {
  return `${problemId}/${stepId}`;
}

/** URL segment of a step, numbered like its source file: step 2 `cache-aside` → `2-cache-aside`. */
export function stepSlug(problem: Problem, step: Step): string {
  return `${problem.steps.indexOf(step) + 1}-${step.id}`;
}

/** The step whose slug this is, if any. */
export function stepBySlug(problem: Problem, slug: string): Step | undefined {
  return problem.steps.find((step, i) => slug === `${i + 1}-${step.id}`);
}

/** Site-relative address of a step: `/image-cache/2-cache-aside`. */
export function stepPath(problem: Problem, step: Step): string {
  return `/${problem.id}/${stepSlug(problem, step)}`;
}
