/**
 * Compiles the Scala of every course that has runtime harnesses, with the real Scala 2.13 compiler
 * and the real libraries the code is written against (Pekko HTTP, ScalaPB + grpc-java,
 * kafka-clients, Jedis, …). Scala is judged statically in the browser, so this is what keeps its
 * code compiling: a course's reference solutions compile together (with the course's Scala support
 * modules and the code ScalaPB generates from its .proto files), and so does each starter with the
 * other steps' solutions. scala-cli, pinned and fetched into node_modules/.cache, brings the JVM,
 * the compiler and the libraries; a JDK need not be installed.
 *
 *   yarn check:scala                          # every course
 *   yarn check:scala --problem stripe-ledger  # one course
 *   yarn check:scala --verbose                # every compiler error in full
 */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {cpus} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';

import {problems} from '../src/data/problems';
import {type Problem, type Step, codeFor, fileName} from '../src/lib/types';

const SCALA_CLI_VERSION = '1.18.0';
/** scala-cli's native launchers, by `${process.platform}-${process.arch}`; the release publishes no digests, these were taken from it. */
const SCALA_CLI: Record<string, {asset: string; sha256: string}> = {
  'darwin-arm64': {
    asset: 'scala-cli-aarch64-apple-darwin.gz',
    sha256: '11230200a8778e465053cbcb8564cd8d84c486fc6af7a6021287f6ab158359b4',
  },
  'darwin-x64': {
    asset: 'scala-cli-x86_64-apple-darwin.gz',
    sha256: '4e410ff357489d7cf3a08c58ea5aac17943c7f04749e54448466493d0e3b7e13',
  },
  'linux-x64': {
    asset: 'scala-cli-x86_64-pc-linux.gz',
    sha256: 'eb41442f870bcae75aa5d6622ac96a173dae14fed59f71c97125eb21536bb060',
  },
  'linux-arm64': {
    asset: 'scala-cli-aarch64-pc-linux.gz',
    sha256: 'a9e5d10b4bb623839d1697518102d5b6a81d8f9ed8031b10b97f87f35a63ae68',
  },
};
const SCALA = '2.13.18';
const JVM = '21';
const SCALAPB = '0.11.21';
/** The libraries the courses' Scala is written against (README: the stacks the reference solutions use). */
const DEPENDENCIES = [
  'org.apache.pekko::pekko-actor:1.7.1',
  'org.apache.pekko::pekko-stream:1.7.1',
  'org.apache.pekko::pekko-http:1.4.2',
  'org.apache.pekko::pekko-http-spray-json:1.4.2',
  'io.spray::spray-json:1.3.6',
  'io.grpc:grpc-netty-shaded:1.85.1',
  `com.thesamet.scalapb::scalapb-runtime-grpc:${SCALAPB}`,
  'com.thesamet.scalapb::scalapb-json4s:0.12.3',
  'org.apache.kafka:kafka-clients:4.4.0',
  // The last line with JedisPooled, which the courses use (Jedis 8 replaced it with RedisClient).
  'redis.clients:jedis:7.5.3',
  'org.postgresql:postgresql:42.7.14',
  'org.playframework::play-json:3.0.6',
  'com.lihaoyi::ujson:4.4.3',
];
const CACHE = resolve('node_modules/.cache/leetbuild-scala');

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const onlyProblem = flag('--problem');
const verbose = args.includes('--verbose');

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The pinned scala-cli launcher, fetched once. */
async function fetchScalaCli(): Promise<string> {
  const platform = `${process.platform}-${process.arch}`;
  const release = SCALA_CLI[platform];
  if (release === undefined) throw new Error(`scala-cli ${SCALA_CLI_VERSION} has no launcher for ${platform}`);
  const path = join(CACHE, `scala-cli-${SCALA_CLI_VERSION}`);
  if (existsSync(path)) return path;
  const url = `https://github.com/VirtusLab/scala-cli/releases/download/v${SCALA_CLI_VERSION}/${release.asset}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const gzipped = new Uint8Array(await response.arrayBuffer());
  const digest = createHash('sha256').update(gzipped).digest('hex');
  if (digest !== release.sha256) throw new Error(`${url}: sha256 ${digest}, expected ${release.sha256}`);
  mkdirSync(CACHE, {recursive: true});
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, gunzipSync(gzipped));
  chmodSync(tmp, 0o755);
  renameSync(tmp, path);
  console.log(`scala-cli ${SCALA_CLI_VERSION} fetched`);
  return path;
}

/** Run scala-cli: its exit code and everything it printed. */
function scalaCli(cli: string, cliArgs: string[], cwd: string): Promise<{code: number; output: string}> {
  return new Promise((done, fail) => {
    const child = spawn(cli, cliArgs, {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', fail);
    child.on('close', code => done({code: code ?? 1, output}));
  });
}

/** Write `files` under `dir`, rewriting only what changed (so the compile server recompiles only that) and removing the rest. */
function syncTree(dir: string, files: Record<string, string>): void {
  const keep = new Set(Object.keys(files));
  const walk = (at: string): void => {
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, {withFileTypes: true})) {
      const path = join(at, entry.name);
      const rel = relative(dir, path);
      if (entry.isDirectory()) {
        if (!rel.startsWith('.')) walk(path);
      } else if (!keep.has(rel)) rmSync(path);
    }
  };
  walk(dir);
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel);
    if (existsSync(path) && readFileSync(path, 'utf8') === text) continue;
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, text);
  }
}

const readTree = (dir: string, root = dir): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
      const path = join(dir, entry.name);
      return entry.isDirectory()
        ? Object.entries(readTree(path, root))
        : [[relative(root, path), readFileSync(path, 'utf8')] as const];
    }),
  );

/**
 * ScalaPB's generator: ScalaPBC with ScalaPB's own options (scalapb/scalapb.proto) and what they
 * import on protoc's include path, taken from its classpath as sbt-protoc does, so a course can
 * ship package-scoped options (`option (scalapb.options) = {scope: PACKAGE, package_name: …}`).
 */
const GENERATE = `import java.nio.file.{Files, StandardCopyOption}

object Generate {
  def main(args: Array[String]): Unit = {
    val includes = Files.createTempDirectory("scalapb-includes")
    for (name <- Seq("scalapb/scalapb.proto", "google/protobuf/descriptor.proto")) {
      val target = includes.resolve(name)
      Files.createDirectories(target.getParent)
      Files.copy(getClass.getClassLoader.getResourceAsStream(name), target, StandardCopyOption.REPLACE_EXISTING)
    }
    scalapb.ScalaPBC.main(("--proto_path=" + includes) +: args)
  }
}
`;

/** The Scala ScalaPB generates (messages and gRPC services) for a course's .proto files, cached by their contents. */
async function generateProtos(cli: string, protos: Record<string, string>): Promise<Record<string, string>> {
  if (Object.keys(protos).length === 0) return {};
  const key = sha256(JSON.stringify({protos, SCALAPB, GENERATE}));
  const out = join(CACHE, 'protos', key, 'out');
  if (existsSync(out)) return readTree(out);
  const work = join(CACHE, 'protos', key, 'work');
  rmSync(work, {recursive: true, force: true});
  syncTree(work, {
    ...Object.fromEntries(Object.entries(protos).map(([path, text]) => [`proto/${path}`, text])),
    'Generate.scala': GENERATE,
  });
  mkdirSync(join(work, 'gen'), {recursive: true});
  const {code, output} = await scalaCli(
    cli,
    [
      'run',
      'Generate.scala',
      '--scala',
      SCALA,
      '--jvm',
      JVM,
      '--dependency',
      `com.thesamet.scalapb::scalapbc:${SCALAPB}`,
      '-q',
      '--',
      `--scala_out=grpc:${join(work, 'gen')}`,
      `--proto_path=${join(work, 'proto')}`,
      ...Object.keys(protos).map(path => join(work, 'proto', path)),
    ],
    work,
  );
  if (code !== 0) throw new Error(`ScalaPB could not generate the course's .proto code:\n${output}`);
  mkdirSync(dirname(out), {recursive: true});
  renameSync(join(work, 'gen'), out);
  rmSync(work, {recursive: true, force: true});
  return readTree(out);
}

const PROJECT = [
  `//> using scala ${SCALA}`,
  `//> using jvm ${JVM}`,
  '//> using options -nowarn',
  ...DEPENDENCIES.map(dep => `//> using dep ${dep}`),
  '',
].join('\n');

/** A course's Scala support files that are not .proto (the support modules), and its .proto files from whichever language ships them. */
function supportOf(problem: Problem): {modules: Record<string, string>; protos: Record<string, string>} {
  const protos: Record<string, string> = {};
  for (const files of Object.values(problem.support ?? {})) {
    for (const [path, text] of Object.entries(files ?? {})) if (path.endsWith('.proto')) protos[path] = text;
  }
  const modules = Object.fromEntries(
    Object.entries(problem.support?.scala ?? {}).filter(([path]) => !path.endsWith('.proto')),
  );
  return {modules, protos};
}

const stepPath = (step: Step): string => `steps/${fileName(step.file, 'scala')}`;

/** A course's project: every step's solution, its Scala support modules and the code generated from its .proto files. */
async function projectOf(cli: string, problem: Problem): Promise<Record<string, string>> {
  const {modules, protos} = supportOf(problem);
  const files: Record<string, string> = {'project.scala': PROJECT};
  for (const [path, text] of Object.entries(modules)) files[`support/${path}`] = text;
  for (const [path, text] of Object.entries(await generateProtos(cli, protos))) files[`gen/${path}`] = text;
  for (const step of problem.steps) {
    if (step.code.scala !== undefined) files[stepPath(step)] = codeFor(step, 'scala').solution;
  }
  return files;
}

interface Outcome {
  problem: Problem;
  /** What compiled: the course's solutions, or one step's starter among them. */
  label: string;
  ok: boolean;
  /** The compiler's errors, each `file:line:col message` with its source lines. */
  errors: string[];
}

/** scala-cli's error blocks: a `[error] ./path:line:col` line, the message, the source and the caret. */
function errorsOf(output: string): string[] {
  const blocks: string[] = [];
  // Coloured even when piped: [\x1b[31merror\x1b[0m].
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  for (const line of output.replace(ansi, '').split('\n')) {
    const text = line.replace(/^\[error\] ?/, '');
    if (!line.startsWith('[error]')) continue;
    if (/^\.\/\S+:\d+:\d+/.test(text)) blocks.push(text.replace(/^\.\//, ''));
    else if (blocks.length > 0) blocks[blocks.length - 1] += `\n  ${text}`;
  }
  return blocks;
}

async function compileProject(cli: string, dir: string, problem: Problem, label: string): Promise<Outcome> {
  const {code, output} = await scalaCli(cli, ['compile', '.', '-q'], dir);
  const errors = errorsOf(output);
  if (code !== 0 && errors.length === 0) errors.push(output.trim() || `scala-cli exited with ${code}`);
  return {problem, label, ok: code === 0, errors};
}

/**
 * A course compiled the way it is built: every step's solution together, then each harnessed
 * step's starter in place of its solution. One project per course, so a starter recompiles only
 * what it changes (scala-cli's compile server is incremental).
 */
async function checkCourse(cli: string, problem: Problem, files: Record<string, string>): Promise<Outcome[]> {
  const dir = join(CACHE, 'courses', problem.id);
  syncTree(dir, files);
  const outcomes = [await compileProject(cli, dir, problem, 'the solutions')];
  for (const step of problem.steps) {
    if (step.harness === undefined || step.code.scala === undefined) continue;
    const path = join(dir, stepPath(step));
    writeFileSync(path, codeFor(step, 'scala').starter);
    try {
      outcomes.push(await compileProject(cli, dir, problem, `the ${step.id} starter`));
    } finally {
      writeFileSync(path, codeFor(step, 'scala').solution);
    }
  }
  return outcomes;
}

async function main(): Promise<void> {
  const cli = await fetchScalaCli();
  const courses = problems.filter(
    problem =>
      (onlyProblem === null || problem.id === onlyProblem) &&
      problem.steps.some(step => step.harness !== undefined && step.code.scala !== undefined),
  );
  if (courses.length === 0)
    throw new Error(`no course with Scala to compile${onlyProblem ? ` named ${onlyProblem}` : ''}`);
  const started = Date.now();
  // Generating a course's .proto code starts a JVM: one course at a time.
  const projects = new Map<Problem, Record<string, string>>();
  for (const problem of courses) projects.set(problem, await projectOf(cli, problem));
  const outcomes: Outcome[] = [];
  const queue = [...courses];
  const workers = Math.max(1, Math.min(4, cpus().length - 1));
  await Promise.all(
    Array.from({length: workers}, async () => {
      for (let problem = queue.shift(); problem !== undefined; problem = queue.shift()) {
        outcomes.push(...(await checkCourse(cli, problem, projects.get(problem) ?? {})));
      }
    }),
  );
  let failed = 0;
  for (const problem of courses) {
    const mine = outcomes.filter(o => o.problem === problem);
    const bad = mine.filter(o => !o.ok);
    failed += bad.length;
    console.log(
      `${bad.length === 0 ? '✓' : '✗'} ${problem.title} — the solutions and ${mine.length - 1} starter(s)${
        bad.length === 0 ? ' compile' : ''
      }`,
    );
    for (const outcome of bad) {
      console.log(`  - ${outcome.label}: ${outcome.errors.length} error(s)`);
      for (const error of verbose ? outcome.errors : outcome.errors.slice(0, 3)) {
        console.log(`      ${(verbose ? error : error.split('\n').slice(0, 2).join(' |')).replace(/\n/g, '\n      ')}`);
      }
    }
  }
  console.log(
    `\n${outcomes.length} Scala compile(s) of ${courses.length} course(s) in ${Math.round(
      (Date.now() - started) / 1000,
    )} s, ${failed} failed`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

main().then(
  () => process.stdout.write('', () => process.exit()),
  error => {
    console.error(error);
    process.stdout.write('', () => process.exit(1));
  },
);
