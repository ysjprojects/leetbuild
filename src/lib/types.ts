/**
 * Content model for /leetbuild: problems are systems (a match engine, an image cache…) that the
 * learner builds step by step in one of five languages. Every step is a self-contained file with a
 * starter and a reference solution per language, a task statement, progressive hints, and a list
 * of checks the judge runs against the learner's code (see judge.ts).
 *
 * The systems are deliberately simplified abstractions of their real-world versions: each problem
 * statement says what was left out so the learner practises the implementation skills that carry
 * over (idempotency, deadlines, partition keys, TTLs…) instead of framework trivia.
 */

/**
 * The languages a step's file can be in. The five a learner picks from in the header are
 * `LANGUAGES`; `cuda` only appears in the deep-learning track, whose problems fix their language
 * (`Problem.language`) — nobody switches a kernel to Scala.
 */
import {type Architecture, architectureIds} from './architecture';
import {type GpuFigure, gpuIds} from './gpuFigure';

/** A model as a layer stack read bottom to top (lib/architecture.ts). */
export interface ArchitectureFigure {
  title: string;
  architecture: Architecture;
}

/** A kernel as GPU references draw it: scopes, memory levels, data moving between them (lib/gpuFigure.ts). */
export interface GpuFigureEntry {
  title: string;
  gpu: GpuFigure;
}

/** One of a deep-learning problem's figures; the pane shows one at a time, titled. */
export type ProblemFigure = ArchitectureFigure | GpuFigureEntry;

export const isArchitectureFigure = (f: ProblemFigure): f is ArchitectureFigure => 'architecture' in f;

/** The ids a step's `focus` may name in one figure: blocks and ops, or boxes, arrays and threads. */
export const figureIds = (f: ProblemFigure): Set<string> =>
  isArchitectureFigure(f) ? architectureIds(f.architecture) : gpuIds(f.gpu);

export type Language = 'python' | 'typescript' | 'go' | 'scala' | 'cpp' | 'cuda';

/** The languages every course is written in, and the header lets the learner choose between. */
export const LANGUAGES: readonly Language[] = ['python', 'typescript', 'go', 'scala', 'cpp'];

/** Every language a step can be in — what an attempt, a timed session or a certificate may record. */
export const ALL_LANGUAGES: readonly Language[] = [...LANGUAGES, 'cuda'];

export const LANGUAGE_LABEL: Record<Language, string> = {
  python: 'Python',
  typescript: 'TypeScript',
  go: 'Go',
  scala: 'Scala',
  cpp: 'C++',
  cuda: 'CUDA',
};

/** Libraries the reference solutions use; shown next to the editor so the learner knows the target API. */
export const LANGUAGE_STACK: Record<Language, Partial<Record<Concept, string>>> = {
  python: {
    http: 'FastAPI + uvicorn',
    grpc: 'grpcio (grpc.aio)',
    kafka: 'confluent-kafka',
    redis: 'redis-py',
    pytorch: 'PyTorch 2',
  },
  typescript: {http: 'Fastify', grpc: '@grpc/grpc-js + proto-loader', kafka: 'kafkajs', redis: 'ioredis'},
  go: {http: 'net/http', grpc: 'google.golang.org/grpc', kafka: 'segmentio/kafka-go', redis: 'go-redis v9'},
  scala: {http: 'Pekko HTTP', grpc: 'ScalaPB + grpc-java', kafka: 'kafka-clients (Java)', redis: 'Jedis'},
  cpp: {http: 'cpp-httplib', grpc: 'grpc++', kafka: 'librdkafka (C++ API)', redis: 'redis-plus-plus'},
  cuda: {cuda: 'CUDA C++ · nvcc'},
};

const FILE_EXTENSION: Record<Language, string> = {
  python: 'py',
  typescript: 'ts',
  go: 'go',
  scala: 'scala',
  cpp: 'cpp',
  cuda: 'cu',
};

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

/**
 * Whether a step runs as a program in the browser — Run executes the step's file as
 * `python file.py` would, its self-test included, on PyTorch for Pyodide (CPU, single-threaded):
 * the deep-learning track's PyTorch steps, unless they are `localOnly`.
 */
export const runsAsProgram = (problem: Problem, step: Step, language: Language): boolean =>
  problem.track === 'dllm' && problem.language === 'python' && language === 'python' && step.localOnly === undefined;

export type Concept = 'http' | 'grpc' | 'kafka' | 'redis' | 'pytorch' | 'cuda';

/** The four every systems course covers over its steps. */
export const SYSTEMS_CONCEPTS: readonly Concept[] = ['http', 'grpc', 'kafka', 'redis'];

/** Every concept the catalogue grades, mastery bars and badges included. */
export const CONCEPTS: readonly Concept[] = ['http', 'grpc', 'kafka', 'redis', 'pytorch', 'cuda'];

export const CONCEPT_LABEL: Record<Concept, string> = {
  http: 'HTTPS',
  grpc: 'gRPC',
  kafka: 'Kafka',
  redis: 'Redis',
  pytorch: 'PyTorch',
  cuda: 'CUDA',
};

export type Difficulty = 'easy' | 'medium' | 'hard';
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];

/**
 * Which track a problem belongs to. `systems` is the classic build-a-system track (the default
 * when omitted); `ai` is the AI-era track, where every starter is a plausible model-generated
 * draft that the learner has to review, fix and verify; `dllm` is the deep-learning track — PyTorch
 * and CUDA problems in a fixed language, judged by static checks. A PyTorch step's file also runs
 * in the browser as a program (Run executes its self-test, see `runsAsProgram`); CUDA runs only on
 * the learner's own GPU.
 */
export type Track = 'systems' | 'ai' | 'dllm';

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
  /** One matcher per language the step is written in (every language of `LANGUAGES` for a course; the fixed one for a deep-learning problem). */
  match: Partial<Record<Language, Matcher>>;
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
  /** Starter and solution per language the step is written in (see `StepCheck.match`). */
  code: Partial<Record<Language, StepCode>>;
  /** Shown once the step is accepted or revealed: why the solution is shaped this way, what real systems add. */
  debrief: string;
  /**
   * Runtime harness per language, run against the learner's files in the browser runtime; its
   * results decide acceptance and the static matchers become advisory. Python: a module with one
   * `check_<id>(ctx)` per entry of `checks` (`-` in the id becomes `_`), see
   * public/py/runtime/leetbuild/harness.py for `ctx`. TypeScript: a module exporting one
   * `check_<id>(ctx)` the same way, see src/lib/runtime/ts/harness.ts. Go: a file of the learner's
   * package (compiled beside the step's file as harness_test.go) with one
   * `func Check<Id>(ctx *harness.Ctx)` per check (`release-atomic` → `CheckReleaseAtomic`), see
   * goruntime/harness/ctx.go. C++: a file compiled in one translation unit after the step's file
   * (so it sees the file's declarations) with one `void Check<Id>(harness::Ctx& ctx)` per check,
   * see cppruntime/include/leetbuild/harness.h. Scala has none.
   */
  harness?: Partial<Record<Language, string>>;
  /**
   * A PyTorch step whose program the browser runtime cannot run: why (its self-test needs
   * `torch.distributed` processes, or trains for minutes on one CPU thread). Run stays off for it,
   * and the self-test is for the learner's own machine.
   */
  localOnly?: string;
}

/**
 * A company's logo as its tag draws it: the official mark's path data in a 24 × 24 box, in the
 * colours its brand guidelines use (see `src/data/companies.ts`).
 */
export interface CompanyLogo {
  /** SVG path data, 24 × 24. */
  path: string;
  /** The mark's colour. */
  fill: string;
  /** Drawn inset on a rounded tile of this colour, as the company's own icon is (Stripe's white S). */
  tile?: string;
  /** Colour showing through the mark's cut-outs instead of the page behind (Reddit's white Snoo). */
  cutout?: string;
}

/** A company whose published engineering writing a course is derived from, shown as a tag: its logo beside its name. */
export interface Company {
  id: string;
  name: string;
  logo: CompanyLogo;
  /** Where the writing appears: "Netflix TechBlog". */
  publication: string;
  /** The publication's home. */
  url: string;
}

/** What a source is: the paper a mechanism comes from, the code that implements it, a post that explains it, documentation. */
export type SourceKind = 'paper' | 'code' | 'post' | 'docs';

/**
 * A piece a problem is built on. A company-tagged course is derived from the company's own posts and
 * papers, published where its `company` says; a deep-learning problem cites the paper behind its
 * mechanism, the code that implements it and the writing that explains it, each with a `kind` and
 * the `venue` it appeared in.
 */
export interface Source {
  title: string;
  url: string;
  /** Author(s), when the piece names them. */
  by?: string;
  /**
   * Publication date, `YYYY-MM-DD` (or `YYYY-MM` when the day is not published): a paper's first
   * version, a repository's creation, a post's publication. Only undated documentation omits it.
   */
  date?: string;
  /** One sentence: what the problem takes from this piece. */
  takes: string;
  /** What the piece is; every source of a problem not tagged with a company has one. */
  kind?: SourceKind;
  /** Where it appeared, for a problem not tagged with a company: `arXiv`, `SOSP 2023`, `GitHub`, `vLLM blog`. */
  venue?: string;
}

/**
 * A source's credit line: where it appeared (the tagged company's publication, else its venue), who
 * wrote it and when, joined by ` · `; `date` formats the date for the surface showing it.
 */
export const sourceCredit = (source: Source, publication?: string, date: (d: string) => string = d => d): string =>
  [publication ?? source.venue, source.by, source.date === undefined ? undefined : date(source.date)]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');

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
  /** Interview track; omitted means the classic systems track. */
  track?: Track;
  /**
   * A fixed language: the learner cannot switch, and every step carries code and matchers for
   * this language only (the deep-learning track: `python` for PyTorch, `cuda` for kernels).
   */
  language?: Language;
  /** Problem statement: the real system, the simplified abstraction built here, what is out of scope. */
  statement: string;
  /**
   * The learning guide: the concepts the course rests on, walked through in the course markdown
   * dialect (sections start at `#`; `:::widget`, `:::quiz` and `:::details` welcome). Its own page
   * at `/<problem>/learn`, linked from the description, downloadable as Markdown and printable.
   */
  learn?: string;
  /** The system's architecture: services, stores and the calls between them (systems and AI-era courses). */
  diagram?: Diagram;
  /**
   * The deep-learning track's figures, drawn in place of `diagram`: layer stacks for models, GPU
   * figures for kernels, as many as the problem needs (each one titled). Step `focus` names ids from
   * any of them, so ids are unique across a problem's figures.
   */
  figures?: ProblemFigure[];
  steps: Step[];
  /**
   * Modules every step of the course can import when it runs, per language: generated protobuf
   * code (`resizer_pb2.py`), provided helpers (`payments/db.py`). Path → source. Go: helper
   * packages keyed by import path (`payments/db/db.go`) and the `.proto` sources, from which the
   * runtime generates the packages the step files import (`chat/gen/chat`).
   */
  support?: Partial<Record<Language, Record<string, string>>>;
  /** Company-tagged courses: the company whose writing the course is derived from. */
  company?: Company;
  /**
   * The pieces the problem is built on: a company-tagged course's posts and papers, or a deep-learning
   * problem's papers, code, posts and docs (every one of those problems cites some).
   */
  sources?: Source[];
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

/** The languages a problem's steps are written in: the fixed one, or every language a course has. */
export const problemLanguages = (problem: Pick<Problem, 'language'>): readonly Language[] =>
  problem.language === undefined ? LANGUAGES : [problem.language];

/** A step's code in a language it is written in; a step is never shown in another. */
export function codeFor(step: Step, language: Language): StepCode {
  const code = step.code[language];
  if (code === undefined) throw new Error(`step ${step.id} has no ${language} code`);
  return code;
}
