/**
 * The TypeScript runtime, shared by the browser worker and `yarn verify` (Node): the learner's
 * files, the course's support files and the step's harness are transpiled with esbuild and run as
 * modules against in-process services — Redis, Kafka, gRPC and Fastify-shaped HTTP modelled by the
 * runtime under `./ts`, Postgres by PGlite — on a virtual clock. The host supplies the transpiler
 * (esbuild-wasm in the browser, esbuild in Node), the database bridge and the Lua VM.
 */
import type {DbBridge} from './db';
import {type Bytes, Buffer} from './ts/buffer';
import * as grpc from './ts/grpc';
import {runChecks} from './ts/harness';
import * as http from './ts/http';
import * as kafka from './ts/kafka';
import {type Transformer, HARNESS, ModuleSystem, SUPPORT, WORK} from './ts/loader';
import * as node from './ts/node';
import * as pg from './ts/pg';
import * as redis from './ts/redis';
import type {RunJob, RunResult} from './types';

export type TsBootPhase = 'esbuild' | 'runtime';

export interface TsHost {
  transform: Transformer;
  db: DbBridge;
  luaEval: redis.LuaEval;
}

export interface TypeScriptRuntime {
  run(job: RunJob): Promise<RunResult>;
}

/** A module object as esbuild's `__toESM` expects it: named exports plus `default`. */
const esm = (exports: Record<string, unknown>, defaultExport?: unknown): Record<string, unknown> => ({
  __esModule: true,
  ...exports,
  default: defaultExport ?? exports,
});

export function createTypeScriptRuntime(host: TsHost): TypeScriptRuntime {
  const modules = new ModuleSystem(host.transform);
  redis.SERVER.lua = host.luaEval;
  pg.DB.bridge = host.db;
  modules.registerPackage('ioredis', () =>
    esm({Redis: redis.Redis, Pipeline: redis.Pipeline, ReplyError: redis.ReplyError}, redis.Redis),
  );
  modules.registerPackage('kafkajs', () =>
    esm({
      Kafka: kafka.Kafka,
      Producer: kafka.Producer,
      Consumer: kafka.Consumer,
      Admin: kafka.Admin,
      KafkaJSError: kafka.KafkaJSError,
      KafkaJSNonRetriableError: kafka.KafkaJSError,
      CompressionTypes: {None: 0, GZIP: 1, Snappy: 2, LZ4: 3, ZSTD: 4},
      logLevel: {NOTHING: 0, ERROR: 1, WARN: 2, INFO: 4, DEBUG: 5},
      Partitioners: {DefaultPartitioner: (): null => null, LegacyPartitioner: (): null => null},
    }),
  );
  modules.registerPackage('@grpc/grpc-js', () =>
    esm({
      status: grpc.status,
      Metadata: grpc.Metadata,
      Server: grpc.Server,
      ServerCredentials: grpc.ServerCredentials,
      credentials: grpc.credentials,
      loadPackageDefinition: grpc.loadPackageDefinition,
      StatusError: grpc.StatusError,
    }),
  );
  modules.registerPackage('@grpc/proto-loader', () => esm({loadSync: grpc.loadSync, load: grpc.load}));
  modules.registerPackage('fastify', () =>
    esm(
      {
        fastify: http.fastify,
        FastifyInstance: http.FastifyInstance,
        FastifyReply: http.FastifyReply,
        httpErrors: http.httpErrors,
        HttpError: http.HttpError,
      },
      http.fastify,
    ),
  );
  modules.registerPackage('@fastify/sensible', () =>
    esm({httpErrors: http.httpErrors}, (_instance: http.FastifyInstance, _options: unknown, done: () => void): void =>
      done(),
    ),
  );
  modules.registerPackage('pg', () =>
    esm({Pool: pg.Pool, Client: pg.Client, types: pg.types, DatabaseError: pg.DatabaseError}),
  );
  modules.registerPackage('crypto', () => esm({...node.crypto}, node.crypto));
  modules.registerPackage('assert', () =>
    esm({...node.assert, strict: node.assert, AssertionError: node.AssertionError}, node.assert),
  );
  modules.registerPackage('assert/strict', () =>
    esm({...node.assert, AssertionError: node.AssertionError}, node.assert),
  );
  modules.registerPackage('events', () => esm({EventEmitter: node.EventEmitter, once: node.once}, node.EventEmitter));
  modules.registerPackage('util', () => esm({...node.util}, node.util));
  modules.registerPackage('timers/promises', () => esm({...node.timersPromises}));
  modules.registerPackage('buffer', () => esm({Buffer}));
  modules.registerPackage('os', () => esm({...node.os}, node.os));
  modules.registerPackage('process', () => esm({}, node.PROCESS));
  modules.moduleGlobals = {process: node.PROCESS};
  // A read-only file system over the course's files: `readFileSync('gateway/cert.pem')` finds the support file.
  const resolveFile = (path: string): string | null => {
    const candidates = path.startsWith('/') ? [path] : [`${SUPPORT}/${path}`, `${WORK}/${path}`, `/${path}`];
    for (const c of candidates) {
      const source = modules.read(c);
      if (source !== null) return source;
    }
    return null;
  };
  const readFileSync = (path: string, options?: string | {encoding?: string | null}): string | Bytes => {
    const source = resolveFile(path);
    if (source === null)
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {code: 'ENOENT'});
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? source : Buffer.from(source);
  };
  const existsSync = (path: string): boolean => resolveFile(path) !== null;
  const fs = {
    readFileSync,
    existsSync,
    promises: {
      readFile: async (path: string, options?: string | {encoding?: string | null}): Promise<string | Bytes> =>
        readFileSync(path, options),
      access: async (path: string): Promise<void> => {
        if (!existsSync(path))
          throw Object.assign(new Error(`ENOENT: no such file or directory, access '${path}'`), {code: 'ENOENT'});
      },
    },
  };
  modules.registerPackage('fs', () => esm({...fs}, fs));
  modules.registerPackage('fs/promises', () => esm({...fs.promises}, fs.promises));

  return {
    async run(job) {
      const started = Date.now();
      const stdout: string[] = [];
      const stderr: string[] = [];
      try {
        const files: Record<string, string> = {};
        grpc.PROTO_FILES.clear();
        for (const [name, source] of Object.entries(job.support)) {
          if (name.endsWith('.proto')) grpc.PROTO_FILES.set(name.split('/').pop() ?? name, source);
          else files[`${SUPPORT}/${name}`] = source;
        }
        for (const [name, source] of Object.entries(job.files)) files[`${WORK}/${name}`] = source;
        files[HARNESS] = job.harness;
        await modules.prepare(files);
        const checks = await runChecks(modules, job.checks, {stdout, stderr});
        return {checks, stdout: stdout.join('\n'), stderr: stderr.join('\n'), ms: Date.now() - started};
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          checks: [],
          stdout: stdout.join('\n'),
          stderr: stderr.join('\n'),
          error: message,
          ms: Date.now() - started,
        };
      }
    },
  };
}
