import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis checkpoint state per step with atomic advance',
  concept: 'redis',
  file: 'state',
  focus: ['engine', 'redis', 'worker'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the worker reads the run's
cursor, runs the step, writes the checkpoint back, and the single-worker demo advances run after
run. It hides a lost update, a value that grows with the payload and a key that never dies. Review
it like the engine owner, fix it, and prove the fix with the checks below.

Implement the run's checkpoint in Redis.

- The run state is one hash, \`run:{run_id}:checkpoint\`, holding \`current_step\`, \`output_ref\`,
  \`completed\` (the ordered list of finished step names) and \`updated_at\`.
- \`advance(run_id, from_step, to_step, output_ref, now) -> bool\` is **one Lua \`EVAL\`**: it reads
  \`current_step\`, writes the new step, the reference, the extended \`completed\` trail and the time,
  refreshes the expiry, and returns **1 only when the stored value still equals \`from_step\`**;
  otherwise it returns **0 and writes nothing at all**.
- The step's output is stored by the blob store (\`blobs.put(output) -> ref\`) and only
  \`output_ref\` reaches Redis. The checkpoint is a pointer, never the payload.
- \`CHECKPOINT_TTL_S\` is seven days and the advance refreshes it, so a run that stops moving
  releases its key instead of leaving one behind per abandoned run.

**Failure mode the checks target.** Two workers — the original and a duplicate the scheduler started
after a lost heartbeat — both read \`current_step\`, both run the step's effect, and both write the
checkpoint, so the run advances past a step whose effect never ran, and a retried step's replacement
re-advances a run that already moved on. The value also grows with every payload the draft serializes
into it, and an abandoned run keeps its key forever.`,
  sequence: {
    participants: ['Worker', 'Run checkpoint (Redis)', 'blob store'],
    messages: [
      {
        from: 'Worker',
        to: 'Run checkpoint (Redis)',
        label: 'HGET run:{id}:checkpoint · current_step',
        kind: 'sync',
      },
      {from: 'Worker', to: 'Worker', label: 'run the step effect · create_account', kind: 'sync'},
      {from: 'Worker', to: 'blob store', label: 'put(output) · returns the reference', kind: 'async'},
      {from: 'blob store', to: 'Worker', label: 'output_ref', kind: 'reply'},
      {
        from: 'Worker',
        to: 'Run checkpoint (Redis)',
        label: 'EVAL · current_step == "create_account" → HSET · EXPIRE 604800',
        kind: 'sync',
      },
      {from: 'Run checkpoint (Redis)', to: 'Worker', label: '1 advanced · 0 someone else won', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'cas',
      title: 'Advance is a compare-and-swap',
      detail:
        'Unless the stored `current_step` still matches what the worker advanced from, nothing is written. The draft reads the step on the client and then overwrites the checkpoint, so a duplicate worker that read the same value writes it too.',
      match: {
        python: {all: [/\.eval\(/, /HGET/, /HSET/]},
        typescript: {all: [/\.eval\(/, /HGET/, /HSET/]},
        go: {all: [/NewScript\(/, /HGET/, /HSET/]},
        scala: {all: [/\.eval\(/, /HGET/, /HSET/]},
        cpp: {all: [/\.eval</, /HGET/, /HSET/]},
      },
    },
    {
      id: 'noop',
      title: 'A duplicate advance writes nothing',
      detail:
        'The script returns `0` instead of overwriting, so the worker that lost the race learns it lost. The draft returns success to both workers, so one of the two effects is missing from the record.',
      match: {
        python: {all: [/if current == ARGV\[1\]/, /return 0/]},
        typescript: {all: [/if current == ARGV\[1\]/, /return 0/]},
        go: {all: [/if current == ARGV\[1\]/, /return 0/]},
        scala: {all: [/if current == ARGV\[1\]/, /return 0/]},
        cpp: {all: [/if current == ARGV\[1\]/, /return 0/]},
      },
    },
    {
      id: 'ref',
      title: 'The checkpoint holds a reference, not the payload',
      detail:
        'The step output goes to the blob store and only its reference reaches Redis, so the checkpoint value stays the same size whatever the step produced. The draft serializes the whole output into the hash value.',
      match: {
        python: {all: [/output_ref/, /blobs\.put\(/], none: [/"output":\s*output\}/]},
        typescript: {all: [/output_ref/, /blobs\.put\(/], none: [/"output":\s*output\}/]},
        go: {all: [/outputRef/, /blobs\.Put\(/], none: [/"output":\s*output\}/]},
        scala: {all: [/outputRef/, /blobs\.put\(/], none: [/"output":\s*output\}/]},
        cpp: {all: [/output_ref/, /blobs\.put\(/], none: [/"output":\s*output\}/]},
      },
    },
    {
      id: 'trail',
      title: 'The checkpoint records the completed steps',
      detail:
        'The hash carries `completed`, the ordered list of finished step names, written by the same script that moves the run. The draft keeps a bare cursor, so nothing can say which steps actually ran.',
      match: {
        python: {all: [/completed/, /HSET/]},
        typescript: {all: [/completed/, /HSET/]},
        go: {all: [/completed/, /HSET/]},
        scala: {all: [/completed/, /HSET/]},
        cpp: {all: [/completed/, /HSET/]},
      },
    },
    {
      id: 'ttl',
      title: 'The checkpoint expires and the advance refreshes it',
      detail:
        '`CHECKPOINT_TTL_S` is seven days and every advance refreshes it inside the script, so the key dies when the run stops moving. The draft writes the key with no expiry at all.',
      match: {
        python: {all: [/CHECKPOINT_TTL_S/, /EXPIRE/]},
        typescript: {all: [/CHECKPOINT_TTL_S/, /EXPIRE/]},
        go: {all: [/checkpointTTLSeconds/, /EXPIRE/]},
        scala: {all: [/CheckpointTtlSeconds/, /EXPIRE/]},
        cpp: {all: [/kCheckpointTtlSeconds/, /EXPIRE/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from fastapi import FastAPI

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)
logger = logging.getLogger("workflow")


class BlobStore:
    def put(self, output: dict) -> str:
        """Store one step output and return the reference that goes into the checkpoint."""
        raise NotImplementedError


class EffectRunner:
    def run(self, step: str, input_doc: dict) -> dict:
        """Run the step's effect: send the welcome email, charge the card, reserve the stock."""
        raise NotImplementedError


blobs = BlobStore()
effects = EffectRunner()


def checkpoint_key(run_id: str) -> str:
    return f"run:{run_id}:checkpoint"


def advance(run_id: str, to_step: str, output: dict, cursor: int) -> bool:
    # TODO: this draft reads the cursor on the client and then writes the checkpoint back with a
    # plain write, serializes the whole step output into the value instead of a reference, keeps
    # only a cursor with no completed list, and never expires the key. A duplicate worker therefore
    # advances the run twice and one effect is lost from the record.
    stored = r.get(checkpoint_key(run_id))
    current = json.loads(stored)["cursor"] if stored else 0
    if current >= cursor:
        return False
    r.set(checkpoint_key(run_id), json.dumps({"cursor": cursor, "output": output}))
    return True


def work(run_id: str, from_step: str, to_step: str, input_doc: dict) -> bool:
    output = effects.run(from_step, input_doc)
    if not advance(run_id, to_step, output, 1):
        logger.info("advance skipped run=%s step=%s", run_id, from_step)
        return False
    return True


@app.get("/v1/runs/{run_id}/checkpoint")
def checkpoint(run_id: str) -> dict:
    stored = r.get(checkpoint_key(run_id))
    return json.loads(stored) if stored else {}
`,
      solution: `import json
import logging
import time

import redis
from fastapi import FastAPI

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)
logger = logging.getLogger("workflow")

CHECKPOINT_TTL_S = 7 * 24 * 3600

ADVANCE_LUA = """
local current = redis.call('HGET', KEYS[1], 'current_step')
if current == ARGV[1] then
  redis.call('HSET', KEYS[1], 'current_step', ARGV[2], 'output_ref', ARGV[3], 'completed', ARGV[4], 'updated_at', ARGV[5])
  redis.call('EXPIRE', KEYS[1], ARGV[6])
  return 1
end
return 0
"""


class BlobStore:
    def put(self, output: dict) -> str:
        """Store one step output and return the reference that goes into the checkpoint."""
        raise NotImplementedError


class EffectRunner:
    def run(self, step: str, input_doc: dict) -> dict:
        """Run the step's effect: send the welcome email, charge the card, reserve the stock."""
        raise NotImplementedError


blobs = BlobStore()
effects = EffectRunner()


def checkpoint_key(run_id: str) -> str:
    return f"run:{run_id}:checkpoint"


def advance(
    run_id: str,
    from_step: str,
    to_step: str,
    output_ref: str,
    completed: list[str],
    now: float,
) -> bool:
    # One EVAL holds the whole decision: the stored current_step must still be the step the worker
    # advanced from, and only then does the hash move, the trail grow and the TTL refresh. The loser
    # of the race gets 0 and has written nothing.
    advanced = r.eval(
        ADVANCE_LUA,
        1,
        checkpoint_key(run_id),
        from_step,
        to_step,
        output_ref,
        json.dumps(completed),
        str(now),
        CHECKPOINT_TTL_S,
    )
    return bool(advanced)


def work(run_id: str, from_step: str, to_step: str, completed: list[str], input_doc: dict) -> bool:
    output = effects.run(from_step, input_doc)
    output_ref = blobs.put(output)
    advanced = advance(run_id, from_step, to_step, output_ref, completed + [from_step], time.time())
    if not advanced:
        logger.info("advance lost the race run=%s step=%s", run_id, from_step)
    return advanced


@app.get("/v1/runs/{run_id}/checkpoint")
def checkpoint(run_id: str) -> dict:
    return r.hgetall(checkpoint_key(run_id)) or {}
`,
    },
    typescript: {
      starter: `/** Run checkpoint: a model-generated draft that overwrites the run state from client memory. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

export interface BlobStore {
  put(output: Record<string, unknown>): Promise<string>;
}

export interface EffectRunner {
  run(step: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export const blobs: BlobStore = {
  put: async () => {
    throw new Error('not implemented');
  },
};

export const effects: EffectRunner = {
  run: async () => {
    throw new Error('not implemented');
  },
};

export const checkpointKey = (runId: string): string => \`run:\${runId}:checkpoint\`;

export async function advance(
  runId: string,
  toStep: string,
  output: Record<string, unknown>,
  cursor: number,
): Promise<boolean> {
  // TODO: this draft reads the cursor on the client and then writes the checkpoint back with a
  // plain write, serializes the whole step output into the value instead of a reference, keeps
  // only a cursor with no completed list, and never expires the key. A duplicate worker therefore
  // advances the run twice and one effect is lost from the record.
  const stored = await r.get(checkpointKey(runId));
  const current = stored === null ? 0 : (JSON.parse(stored) as {cursor: number}).cursor;
  if (current >= cursor) return false;
  await r.set(checkpointKey(runId), JSON.stringify({cursor: cursor, "output": output}));
  return true;
}

export async function work(
  runId: string,
  fromStep: string,
  toStep: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  const output = await effects.run(fromStep, input);
  return advance(runId, toStep, output, 1);
}

app.get('/v1/runs/:runId/checkpoint', async (request, reply) => {
  const stored = await r.get(checkpointKey((request.params as {runId: string}).runId));
  return reply.code(200).send(stored === null ? {} : JSON.parse(stored));
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Run checkpoint: one compare-and-swap advance that keeps a reference, never the payload. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const CHECKPOINT_TTL_S = 7 * 24 * 3600;

const ADVANCE_LUA = \`
local current = redis.call('HGET', KEYS[1], 'current_step')
if current == ARGV[1] then
  redis.call('HSET', KEYS[1], 'current_step', ARGV[2], 'output_ref', ARGV[3], 'completed', ARGV[4], 'updated_at', ARGV[5])
  redis.call('EXPIRE', KEYS[1], ARGV[6])
  return 1
end
return 0
\`;

export interface BlobStore {
  put(output: Record<string, unknown>): Promise<string>;
}

export interface EffectRunner {
  run(step: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export const blobs: BlobStore = {
  put: async () => {
    throw new Error('not implemented');
  },
};

export const effects: EffectRunner = {
  run: async () => {
    throw new Error('not implemented');
  },
};

export const checkpointKey = (runId: string): string => \`run:\${runId}:checkpoint\`;

export async function advance(
  runId: string,
  fromStep: string,
  toStep: string,
  outputRef: string,
  completed: string[],
  now: number,
): Promise<boolean> {
  // One EVAL holds the whole decision: the stored current_step must still be the step the worker
  // advanced from, and only then does the hash move, the trail grow and the TTL refresh. The
  // worker that loses the race gets 0 and has written nothing.
  const advanced = await r.eval(
    ADVANCE_LUA,
    1,
    checkpointKey(runId),
    fromStep,
    toStep,
    outputRef,
    JSON.stringify(completed),
    String(now),
    String(CHECKPOINT_TTL_S),
  );
  return Number(advanced) === 1;
}

export async function work(
  runId: string,
  fromStep: string,
  toStep: string,
  completed: string[],
  input: Record<string, unknown>,
): Promise<boolean> {
  const output = await effects.run(fromStep, input);
  const outputRef = await blobs.put(output);
  const advanced = await advance(
    runId,
    fromStep,
    toStep,
    outputRef,
    [...completed, fromStep],
    Math.floor(Date.now() / 1000),
  );
  if (!advanced) app.log.info(\`advance lost the race \${runId} \${fromStep}\`);
  return advanced;
}

app.get('/v1/runs/:runId/checkpoint', async (request, reply) => {
  const checkpoint = await r.hgetall(checkpointKey((request.params as {runId: string}).runId));
  return reply.code(200).send(checkpoint);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

type BlobStore struct{}

func (b *BlobStore) Put(ctx context.Context, output map[string]any) (string, error) {
	panic("blob store is wired up by the platform")
}

type EffectRunner struct{}

func (e *EffectRunner) Run(ctx context.Context, step string, input map[string]any) (map[string]any, error) {
	panic("effect runner is wired up by the platform")
}

var (
	blobs   = &BlobStore{}
	effects = &EffectRunner{}
)

func checkpointKey(runID string) string {
	return fmt.Sprintf("run:%s:checkpoint", runID)
}

// advance moves the run forward: read the cursor, compare it with the one the worker believes it
// holds, then write the new value back.
func advance(ctx context.Context, runID string, toStep string, output map[string]any, cursor int) bool {
	// TODO: this draft reads the cursor on the client and then writes the checkpoint back with a
	// plain write, serializes the whole step output into the value instead of a reference, keeps
	// only a cursor with no completed list, and never expires the key. A duplicate worker therefore
	// advances the run twice and one effect is lost from the record.
	key := checkpointKey(runID)
	raw, _ := rdb.Get(ctx, key).Result()
	current := 0
	if raw != "" {
		var stored map[string]any
		if err := json.Unmarshal([]byte(raw), &stored); err == nil {
			if value, ok := stored["cursor"].(float64); ok {
				current = int(value)
			}
		}
	}
	if current >= cursor {
		return false
	}
	payload, err := json.Marshal(map[string]any{"cursor": cursor, "output": output})
	if err != nil {
		return false
	}
	rdb.Set(ctx, key, payload, 0)
	return true
}

func work(ctx context.Context, runID, fromStep, toStep string, input map[string]any) bool {
	output, err := effects.Run(ctx, fromStep, input)
	if err != nil {
		log.Printf("effect failed run=%s step=%s", runID, fromStep)
		return false
	}
	return advance(ctx, runID, toStep, output, 1)
}

func checkpointHandler(rw http.ResponseWriter, r *http.Request) {
	raw, _ := rdb.Get(r.Context(), checkpointKey(r.PathValue("run_id"))).Result()
	if raw == "" {
		raw = "{}"
	}
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(raw))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/runs/{run_id}/checkpoint", checkpointHandler)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const checkpointTTLSeconds = 7 * 24 * 60 * 60

var rdb *redis.Client

// The whole advance is one script: compare the stored step, then move the run, extend the trail
// and refresh the TTL, or refuse and write nothing.
var advanceScript = redis.NewScript(\`
local current = redis.call('HGET', KEYS[1], 'current_step')
if current == ARGV[1] then
  redis.call('HSET', KEYS[1], 'current_step', ARGV[2], 'output_ref', ARGV[3], 'completed', ARGV[4], 'updated_at', ARGV[5])
  redis.call('EXPIRE', KEYS[1], ARGV[6])
  return 1
end
return 0
\`)

type BlobStore struct{}

func (b *BlobStore) Put(ctx context.Context, output map[string]any) (string, error) {
	panic("blob store is wired up by the platform")
}

type EffectRunner struct{}

func (e *EffectRunner) Run(ctx context.Context, step string, input map[string]any) (map[string]any, error) {
	panic("effect runner is wired up by the platform")
}

var (
	blobs   = &BlobStore{}
	effects = &EffectRunner{}
)

func checkpointKey(runID string) string {
	return fmt.Sprintf("run:%s:checkpoint", runID)
}

// advance is the only writer of the checkpoint. The script compares first, so a duplicate worker
// that still believes it holds fromStep loses and writes nothing at all.
func advance(ctx context.Context, runID, fromStep, toStep, outputRef string, completed []string, now time.Time) (bool, error) {
	trail, err := json.Marshal(completed)
	if err != nil {
		return false, err
	}
	moved, err := advanceScript.Run(
		ctx,
		rdb,
		[]string{checkpointKey(runID)},
		fromStep,
		toStep,
		outputRef,
		string(trail),
		now.UTC().Format(time.RFC3339),
		checkpointTTLSeconds,
	).Int()
	if err != nil {
		return false, err
	}
	return moved == 1, nil
}

func work(ctx context.Context, runID, fromStep, toStep string, completed []string, input map[string]any) (bool, error) {
	output, err := effects.Run(ctx, fromStep, input)
	if err != nil {
		return false, err
	}
	outputRef, err := blobs.Put(ctx, output)
	if err != nil {
		return false, err
	}
	advanced, err := advance(ctx, runID, fromStep, toStep, outputRef, append(completed, fromStep), time.Now())
	if err != nil {
		return false, err
	}
	if !advanced {
		log.Printf("advance lost the race run=%s step=%s", runID, fromStep)
	}
	return advanced, nil
}

func checkpointHandler(rw http.ResponseWriter, r *http.Request) {
	fields, err := rdb.HGetAll(r.Context(), checkpointKey(r.PathValue("run_id"))).Result()
	if err != nil {
		http.Error(rw, "checkpoint unavailable", http.StatusServiceUnavailable)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(rw).Encode(fields)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/runs/{run_id}/checkpoint", checkpointHandler)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis

trait BlobStore {
  def put(output: String): String
}

object BlobStore {
  def open(): BlobStore = new BlobStore {
    def put(output: String): String = throw new NotImplementedError("blob store")
  }
}

trait EffectRunner {
  def run(step: String, input: String): String
}

object EffectRunner {
  def open(): EffectRunner = new EffectRunner {
    def run(step: String, input: String): String = throw new NotImplementedError("effect runner")
  }
}

object Checkpoint {
  val jedis = new Jedis("redis", 6379)
  val blobs: BlobStore = BlobStore.open()
  val effects: EffectRunner = EffectRunner.open()

  def key(runId: String): String = s"run:$runId:checkpoint"

  // TODO: this draft reads the cursor on the client and then writes the checkpoint back with a
  // plain write, serializes the whole step output into the value instead of a reference, keeps
  // only a cursor with no completed list, and never expires the key. A duplicate worker therefore
  // advances the run twice and one effect is lost from the record.
  def advance(runId: String, toStep: String, output: String, cursor: Int): Boolean = {
    val stored = Option(jedis.get(key(runId))).flatMap(_.toIntOption).getOrElse(0)
    if (stored >= cursor) {
      false
    } else {
      jedis.set(key(runId), s"""{"cursor":$cursor,"output":$output}""")
      true
    }
  }

  def work(runId: String, fromStep: String, toStep: String, input: String): Boolean = {
    val output = effects.run(fromStep, input)
    advance(runId, toStep, output, 1)
  }

  def checkpointJson(runId: String): String = Option(jedis.get(key(runId))).getOrElse("{}")

  val route: Route =
    path("v1" / "runs" / Segment / "checkpoint") { runId =>
      get {
        complete(StatusCodes.OK, checkpointJson(runId))
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("workflow")
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis

trait BlobStore {
  def put(output: String): String
}

object BlobStore {
  def open(): BlobStore = new BlobStore {
    def put(output: String): String = throw new NotImplementedError("blob store")
  }
}

trait EffectRunner {
  def run(step: String, input: String): String
}

object EffectRunner {
  def open(): EffectRunner = new EffectRunner {
    def run(step: String, input: String): String = throw new NotImplementedError("effect runner")
  }
}

object Checkpoint {
  val CheckpointTtlSeconds = 7L * 24L * 60L * 60L

  val jedis = new Jedis("redis", 6379)
  val blobs: BlobStore = BlobStore.open()
  val effects: EffectRunner = EffectRunner.open()

  // The whole advance is one script: compare the stored step, then move the run, extend the trail
  // and refresh the TTL, or refuse and write nothing.
  val AdvanceLua =
    """
      |local current = redis.call('HGET', KEYS[1], 'current_step')
      |if current == ARGV[1] then
      |  redis.call('HSET', KEYS[1], 'current_step', ARGV[2], 'output_ref', ARGV[3], 'completed', ARGV[4], 'updated_at', ARGV[5])
      |  redis.call('EXPIRE', KEYS[1], ARGV[6])
      |  return 1
      |end
      |return 0
      |""".stripMargin

  def key(runId: String): String = s"run:$runId:checkpoint"

  def advance(
      runId: String,
      fromStep: String,
      toStep: String,
      outputRef: String,
      completed: List[String],
      now: Long
  ): Boolean = {
    val advanced = jedis.eval(
      AdvanceLua,
      1,
      key(runId),
      fromStep,
      toStep,
      outputRef,
      completed.mkString("[", ",", "]"),
      now.toString,
      CheckpointTtlSeconds.toString
    )
    advanced == 1L
  }

  def work(runId: String, fromStep: String, toStep: String, completed: List[String], input: String): Boolean = {
    val output = effects.run(fromStep, input)
    val outputRef = blobs.put(output)
    advance(runId, fromStep, toStep, outputRef, completed :+ fromStep, System.currentTimeMillis() / 1000)
  }

  def checkpointJson(runId: String): String = {
    val fields = jedis.hgetAll(key(runId))
    val step = Option(fields.get("current_step")).getOrElse("")
    val ref = Option(fields.get("output_ref")).getOrElse("")
    val trail = Option(fields.get("completed")).getOrElse("[]")
    val updated = Option(fields.get("updated_at")).getOrElse("")
    s"""{"current_step":"$step","output_ref":"$ref","completed":$trail,"updated_at":"$updated"}"""
  }

  val route: Route =
    path("v1" / "runs" / Segment / "checkpoint") { runId =>
      get {
        complete(StatusCodes.OK, checkpointJson(runId))
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("workflow")
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;
using Redis = sw::redis::Redis;

struct BlobStore {
  std::string put(const std::string& output);
};

struct EffectRunner {
  std::string run(const std::string& step, const std::string& input);
};

BlobStore blobs;
EffectRunner effects;

std::string checkpointKey(const std::string& runId) {
  return "run:" + runId + ":checkpoint";
}

// advance moves the run forward: read the cursor, compare it with the one the worker believes it
// holds, then write the new value back.
bool advance(Redis& redis, const std::string& runId, const std::string& toStep, const std::string& output,
             long long cursor) {
  // TODO: this draft reads the cursor on the client and then writes the checkpoint back with a
  // plain write, serializes the whole step output into the value instead of a reference, keeps only
  // a cursor with no completed list, and never expires the key. A duplicate worker therefore
  // advances the run twice and one effect is lost from the record.
  const auto stored = redis.get(checkpointKey(runId));
  long long current = 0;
  if (stored) {
    const json parsed = json::parse(*stored, nullptr, false);
    if (parsed.is_object()) current = parsed.value("cursor", 0LL);
  }
  if (current >= cursor) return false;
  redis.set(checkpointKey(runId), json{{"cursor", cursor}, {"output", output}}.dump());
  return true;
}

bool work(Redis& redis, const std::string& runId, const std::string& fromStep, const std::string& toStep,
          const std::string& input) {
  const auto output = effects.run(fromStep, input);
  return advance(redis, runId, toStep, output, 1);
}

int main() {
  Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get(R"(/v1/runs/(.*)/checkpoint)", [&redis](const httplib::Request& req, httplib::Response& res) {
    res.set_content(redis.get(checkpointKey(req.matches[1].str())).value_or("{}"), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

using json = nlohmann::json;
using Redis = sw::redis::Redis;

constexpr long long kCheckpointTtlSeconds = 7 * 24 * 60 * 60;

// The whole advance is one script: compare the stored step, then move the run, extend the trail and
// refresh the TTL, or refuse and write nothing.
const char* kAdvanceLua = R"LUA(
local current = redis.call('HGET', KEYS[1], 'current_step')
if current == ARGV[1] then
  redis.call('HSET', KEYS[1], 'current_step', ARGV[2], 'output_ref', ARGV[3], 'completed', ARGV[4], 'updated_at', ARGV[5])
  redis.call('EXPIRE', KEYS[1], ARGV[6])
  return 1
end
return 0
)LUA";

struct BlobStore {
  std::string put(const std::string& output);
};

struct EffectRunner {
  std::string run(const std::string& step, const std::string& input);
};

BlobStore blobs;
EffectRunner effects;

std::string checkpointKey(const std::string& runId) {
  return "run:" + runId + ":checkpoint";
}

long long nowSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch())
      .count();
}

// advance is the only writer of the checkpoint. The script compares first, so a duplicate worker
// that still believes it holds fromStep loses and writes nothing at all.
bool advance(Redis& redis, const std::string& runId, const std::string& fromStep, const std::string& toStep,
             const std::string& outputRef, const std::vector<std::string>& completed) {
  const json trail = completed;
  const auto advanced = redis.eval<long long>(
      kAdvanceLua, {checkpointKey(runId)},
      {fromStep, toStep, outputRef, trail.dump(), std::to_string(nowSeconds()),
       std::to_string(kCheckpointTtlSeconds)});
  return advanced == 1;
}

bool work(Redis& redis, const std::string& runId, const std::string& fromStep, const std::string& toStep,
          std::vector<std::string> completed, const std::string& input) {
  const auto output = effects.run(fromStep, input);
  const auto outputRef = blobs.put(output);
  completed.push_back(fromStep);
  return advance(redis, runId, fromStep, toStep, outputRef, completed);
}

int main() {
  Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get(R"(/v1/runs/(.*)/checkpoint)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto fields = redis.hgetall(checkpointKey(req.matches[1].str()));
    json body = json::object();
    for (const auto& [field, value] : fields) body[field] = value;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The whole decision belongs on the server. One script reads `current_step`, compares it with the step the worker advanced from, and only then writes the new step, the reference and the trail. A read in the client followed by a write in the client is a lost update the moment a second worker holds the same idea.',
    'The script returns an integer verdict: `1` when it moved the run, `0` when someone else already did. That verdict is what the worker records — the loser learns it lost instead of silently overwriting the winner, and the run keeps one entry per step rather than one per worker.',
    'Two things must stay out of the value: the payload (store it with `blobs.put` and keep only the reference) and immortality (set the expiry from `CHECKPOINT_TTL_S` inside the same script, so the key dies with a run that stopped moving).',
  ],
  debrief: `The interview question behind this step is whether you can tell "I wrote the checkpoint" from "I was the worker that owned the checkpoint". Every advance is a compare-and-swap on the step the worker advanced from, and one Lua script makes the read, the compare and the write a single server-side step, so a duplicate worker that read the same value loses instead of advancing a run past an effect that never ran. Putting the effect *before* the swap is what makes the ordering safe: the output is already in the blob store when the script decides, so a worker that loses leaves a harmless orphan blob rather than a missing effect. The value holds a reference, not the payload, because Redis is a coordination layer with a memory budget and step outputs are unbounded; the completed trail is the cheap audit that says which steps really ran, and the TTL — refreshed on every advance, not only at creation — is what keeps abandoned runs from leaking a key each. In production the same shape carries a lease (owner and expiry) so a stalled run can be taken over, a monotonic attempt counter so an old worker cannot advance a newer attempt, the definition version pinned beside the step, and a checkpoint write that is published as an event so the read model does not have to poll the hash.`,
};
