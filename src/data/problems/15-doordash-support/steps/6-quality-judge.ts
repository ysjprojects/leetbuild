import type {Step} from '@/lib/types';

// ---- 6. The quality pipeline: judge every turn offline, exactly once -----------------------------
export const qualityJudgeStep: Step = {
  id: 'quality-judge',
  title: 'Judge every turn offline, score it once',
  concept: 'kafka',
  file: 'quality_pipeline',
  focus: ['kafka', 'worker', 'judge', 'pg'],
  task: `## Task

Every answered turn leaves the API as one record on \`support-conversations\`, keyed by session:

\`\`\`json
{"session_id": "s-41", "turn": 2, "dasher_id": "d-9", "question": "When do I get paid?",
 "answer": "Based on [kb:pay-0][kb:pay-1]: Dasher earnings for a week are paid out every Monday.",
 "sources": ["pay-0", "pay-1"], "escalated": false, "model": "large", "tokens": 17}
\`\`\`

The Dasher already has their answer; nobody is waiting. The quality pipeline is the consumer that
scores those turns after the fact, so a prompt change that starts inventing policies shows up in a
table instead of in a complaint. \`assistant.db\` is provided (\`await db.execute(sql, params)\`) and so is
the table:

\`\`\`sql
quality_scores (session_id text, turn int, groundedness real, coherence real, compliance real, pass boolean,
                primary key (session_id, turn))
\`\`\`

Implement \`evaluate\`, \`record_scores\` and the loop \`run()\` in group **\`config.GROUP\`** on
**\`config.TOPIC\`**, reading from the earliest offset:

- Disable auto-commit; the offset is committed by you, **after** the row is written.
- An **escalated** turn carries the handoff text, not an answer: write nothing, call nobody, commit its
  offset and move on.
- Otherwise \`Judge.Evaluate(question, answer, context_ids=sources)\` on \`config.JUDGE\` — the
  \`sources\` are the chunk ids the answer was allowed to draw on, so a citation outside them costs
  groundedness. \`pass\` is a Python keyword: read it with \`getattr(scores, "pass")\`.
- \`INSERT INTO quality_scores (session_id, turn, groundedness, coherence, compliance, pass) …
  ON CONFLICT (session_id, turn) DO UPDATE\` — a record delivered twice overwrites its own row instead
  of adding a second — **then** commit this record's offset.
- The judge answering \`UNAVAILABLE\` is not a verdict: do **not** commit. Seek the consumer back to
  the record's offset, wait \`RETRY_DELAY_S\`, and let the next poll deliver it again; it is scored once
  the judge is back. Any other status propagates.

:::widget delivery-semantics {}

> The guardrail of step 4 decided what the Dasher saw; this consumer decides what the team sees. It
> runs off the request path on purpose: a slow or absent judge here costs nothing but lag, while on
> the request path it would cost the Dasher their answer.`,
  sequence: {
    participants: ['Kafka', 'quality-judge', 'Judge', 'Postgres'],
    messages: [
      {from: 'Kafka', to: 'quality-judge', label: 's-41 turn 2 · answered · sources [pay-0, pay-1]', kind: 'async'},
      {from: 'quality-judge', to: 'Judge', label: 'Evaluate(question, answer, context_ids=sources)', kind: 'sync'},
      {
        from: 'Judge',
        to: 'quality-judge',
        label: 'groundedness 1.0 · coherence 1.0 · compliance 1.0 · pass',
        kind: 'reply',
      },
      {
        from: 'quality-judge',
        to: 'Postgres',
        label: 'INSERT INTO quality_scores … ON CONFLICT (session_id, turn) DO UPDATE',
        kind: 'sync',
      },
      {from: 'quality-judge', to: 'Kafka', label: 'commit offset', kind: 'sync'},
      {from: 'Kafka', to: 'quality-judge', label: 's-41 turn 3 · escalated', kind: 'async'},
      {from: 'quality-judge', to: 'Kafka', label: 'commit offset (nothing to judge)', kind: 'sync'},
      {from: 'Kafka', to: 'quality-judge', label: 's-7 turn 1 · answered', kind: 'async'},
      {from: 'quality-judge', to: 'Judge', label: 'Evaluate(…)', kind: 'sync'},
      {from: 'Judge', to: 'quality-judge', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'quality-judge', to: 'Kafka', label: 'seek back · no commit · next poll redelivers', kind: 'sync'},
    ],
  },
  hints: [
    'Three outcomes per record, two of them ending in a commit: escalated → commit and move on; judged and written → commit; judge UNAVAILABLE → neither. The committed offset is the only thing that says "done", so it must move last.',
    'Write first, then `consumer.commit(message=msg, asynchronous=False)`: `db.execute` autocommits, so the row is in Postgres before the broker hears about the offset. A crash between the two replays the record and the `ON CONFLICT (session_id, turn) DO UPDATE` overwrites the row — one row however many deliveries.',
    'For UNAVAILABLE: `consumer.seek(TopicPartition(msg.topic(), msg.partition(), msg.offset()))`, sleep `RETRY_DELAY_S`, `continue` — the next poll hands you the same record. `grpc.RpcError` carries the status in `e.code()`; only UNAVAILABLE is retried, anything else is re-raised.',
  ],
  checks: [
    {
      id: 'group-manual-commit',
      title: 'Joins group quality-judge on support-conversations with auto-commit disabled',
      detail:
        'The consumer uses `group.id` `config.GROUP`, subscribes to `config.TOPIC` from the earliest offset and commits offsets itself; auto-commit acknowledges on a timer, before the row exists.',
      match: {
        python: {
          all: [
            /"group\.id"\s*:\s*(config\.GROUP|GROUP|"quality-judge")/,
            /"enable\.auto\.commit"\s*:\s*False/,
            /consumer\.commit\(/,
          ],
        },
        typescript: {
          all: [/groupId:\s*((config\.)?GROUP\b|['"]quality-judge['"])/, /autoCommit:\s*false/, /\.commitOffsets\(/],
        },
        go: {
          all: [/GroupID:\s*(config\.Group|"quality-judge")/, /reader\.FetchMessage\(/, /reader\.CommitMessages\(/],
          none: [/ReadMessage\(/],
        },
        scala: {
          all: [
            /"group\.id"\s*,\s*(Config\.Group|"quality-judge")/,
            /"enable\.auto\.commit"\s*,\s*"false"/,
            /commitSync\(/,
          ],
        },
        cpp: {
          all: [
            /"group\.id"\s*,\s*(config::kGroup|"quality-judge")/,
            /"enable\.auto\.commit"\s*,\s*"false"/,
            /commitSync\(/,
          ],
        },
      },
    },
    {
      id: 'scores-per-turn',
      title: 'Judges each answered turn against its sources and upserts one row of scores',
      detail:
        "Every non-escalated record becomes one `Judge.Evaluate` call with `context_ids` = the record's `sources`, and one row of `quality_scores` written with `ON CONFLICT (session_id, turn) DO UPDATE` — a grounded answer passes, a hallucinated one does not, and a redelivered record ends up as the same single row.",
      match: {
        python: {
          all: [
            /\.Evaluate\(/,
            /context_ids\s*=/,
            /INSERT INTO quality_scores/,
            /ON CONFLICT \(session_id, turn\) DO UPDATE/,
          ],
        },
        typescript: {
          all: [
            /\.Evaluate\(/,
            /context_ids/,
            /INSERT INTO quality_scores/,
            /ON CONFLICT \(session_id, turn\) DO UPDATE/,
          ],
        },
        go: {
          all: [
            /\.Evaluate\(/,
            /ContextIds:/,
            /INSERT INTO quality_scores/,
            /ON CONFLICT \(session_id, turn\) DO UPDATE/,
          ],
        },
        scala: {
          all: [
            /\.evaluate\(/,
            /contextIds\s*=/,
            /INSERT INTO quality_scores/,
            /ON CONFLICT \(session_id, turn\) DO UPDATE/,
          ],
        },
        cpp: {
          all: [
            /->Evaluate\(/,
            /add_context_ids\(/,
            /INSERT INTO quality_scores/,
            /ON CONFLICT \(session_id, turn\) DO UPDATE/,
          ],
        },
      },
    },
    {
      id: 'escalated-committed',
      title: 'Skips escalated turns without calling the judge, but commits their offsets',
      detail:
        'A handoff has no answer to score: no `Evaluate` call and no row — yet its offset is committed like any other, or it is redelivered forever and the partition never drains.',
      match: {
        python: {order: [/escalated/, /consumer\.commit\(/, /continue/, /(?<!def )\bevaluate\(/]},
        typescript: {order: [/escalated/, /await commit\(\)|\.commitOffsets\(/, /return/, /await evaluate\(/]},
        go: {order: [/Escalated/, /reader\.CommitMessages\(/, /continue/, /(?<!func )\bevaluate\(/]},
        scala: {order: [/escalated/, /commit\(\s*record\s*\)/, /(?<!def )\bevaluate\(/]},
        cpp: {order: [/escalated/, /consumer->commitSync\(/, /continue/, /= evaluate\(/]},
      },
    },
    {
      id: 'commit-after-write',
      title: 'Commits only after the row is in Postgres',
      detail:
        'At the instant the broker records the offset, the row for that (session, turn) already exists; a write that fails leaves the offset where it was, so the record comes back after a restart and is written once.',
      match: {
        python: {order: [/await record_scores\(/, /consumer\.commit\(/]},
        typescript: {order: [/await recordScores\(/, /await commit\(\)|\.commitOffsets\(/]},
        go: {order: [/(?<!func )\brecordScores\(/, /reader\.CommitMessages\(/]},
        scala: {order: [/(?<!def )\brecordScores\(/, /commit\(\s*record\s*\)/]},
        cpp: {order: [/(?<!void )\brecord_scores\(/, /consumer->commitSync\(/]},
      },
    },
    {
      id: 'judge-down-retries',
      title: 'A judge answering UNAVAILABLE leaves the offset uncommitted and the record is scored later',
      detail:
        'UNAVAILABLE is not a verdict: nothing is written, nothing is committed, the consumer seeks back and the next poll delivers the record again; once the judge answers it is written exactly once.',
      match: {
        python: {all: [/StatusCode\.UNAVAILABLE/, /consumer\.seek\(/]},
        typescript: {all: [/status\.UNAVAILABLE/, /consumer\.seek\(/]},
        go: {all: [/codes\.Unavailable/, /time\.Sleep\(/]},
        scala: {all: [/Status\.Code\.UNAVAILABLE/, /consumer\.seek\(/]},
        cpp: {all: [/StatusCode::UNAVAILABLE/, /consumer->seek\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio
import json
import logging

import grpc
from confluent_kafka import Consumer, TopicPartition

import support_pb2
import support_pb2_grpc
from assistant import config
from assistant.db import db  # await db.execute(sql, params): one autocommitted statement, %s placeholders

log = logging.getLogger("quality-judge")

# How long to wait before the next poll redelivers a record the judge could not score.
RETRY_DELAY_S = 1.0

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": config.GROUP,
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
consumer.subscribe([config.TOPIC])

channel = grpc.insecure_channel(config.JUDGE)
judge = support_pb2_grpc.JudgeStub(channel)


def evaluate(question: str, answer: str, sources: list[str]) -> dict:
    """The judge's verdict on one answered turn: {groundedness, coherence, compliance, pass}."""
    # TODO: judge.Evaluate(support_pb2.EvaluateRequest(question=…, answer=…, context_ids=sources)) → dict
    # TODO: \`pass\` is a keyword — getattr(scores, "pass")
    raise NotImplementedError


async def record_scores(session_id: str, turn: int, scores: dict) -> None:
    """One row per (session, turn): a redelivered record overwrites its own row instead of adding a second."""
    # TODO: INSERT INTO quality_scores (session_id, turn, groundedness, coherence, compliance, pass) VALUES (…)
    # TODO: ON CONFLICT (session_id, turn) DO UPDATE SET … = EXCLUDED.…
    raise NotImplementedError


async def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        turn = json.loads(msg.value())
        # TODO: escalated → commit this message's offset, continue
        # TODO: evaluate(question, answer, sources); UNAVAILABLE → seek back to msg.offset(), sleep RETRY_DELAY_S, continue (no commit)
        # TODO: await record_scores(session_id, turn, scores), then commit
        raise NotImplementedError
`,
      solution: `import asyncio
import json
import logging

import grpc
from confluent_kafka import Consumer, TopicPartition

import support_pb2
import support_pb2_grpc
from assistant import config
from assistant.db import db  # await db.execute(sql, params): one autocommitted statement, %s placeholders

log = logging.getLogger("quality-judge")

# How long to wait before the next poll redelivers a record the judge could not score.
RETRY_DELAY_S = 1.0

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": config.GROUP,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe([config.TOPIC])

channel = grpc.insecure_channel(config.JUDGE)
judge = support_pb2_grpc.JudgeStub(channel)


def evaluate(question: str, answer: str, sources: list[str]) -> dict:
    """The judge's verdict on one answered turn: {groundedness, coherence, compliance, pass}."""
    scores = judge.Evaluate(support_pb2.EvaluateRequest(question=question, answer=answer, context_ids=sources))
    return {
        "groundedness": scores.groundedness,
        "coherence": scores.coherence,
        "compliance": scores.compliance,
        "pass": getattr(scores, "pass"),  # \`pass\` is a keyword: the generated field is reached by name
    }


async def record_scores(session_id: str, turn: int, scores: dict) -> None:
    """One row per (session, turn): a redelivered record overwrites its own row instead of adding a second."""
    await db.execute(
        "INSERT INTO quality_scores (session_id, turn, groundedness, coherence, compliance, pass)"
        " VALUES (%s, %s, %s, %s, %s, %s)"
        " ON CONFLICT (session_id, turn) DO UPDATE SET groundedness = EXCLUDED.groundedness,"
        " coherence = EXCLUDED.coherence, compliance = EXCLUDED.compliance, pass = EXCLUDED.pass",
        (session_id, turn, scores["groundedness"], scores["coherence"], scores["compliance"], scores["pass"]),
    )


async def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        turn = json.loads(msg.value())
        if turn.get("escalated"):
            consumer.commit(message=msg, asynchronous=False)  # a handoff has no answer to judge
            continue
        try:
            scores = evaluate(turn["question"], turn["answer"], list(turn.get("sources") or []))
        except grpc.RpcError as e:
            if e.code() != grpc.StatusCode.UNAVAILABLE:
                raise
            # Not committed: rewind to this record so the next poll delivers it again, once the judge is back.
            consumer.seek(TopicPartition(msg.topic(), msg.partition(), msg.offset()))
            await asyncio.sleep(RETRY_DELAY_S)
            continue
        await record_scores(turn["session_id"], int(turn["turn"]), scores)
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {type EachMessagePayload, Kafka} from 'kafkajs';

import {GROUP, JUDGE, TOPIC} from 'assistant/config';
import {pool} from 'assistant/db'; // await pool.query(sql, [params]): one autocommitted statement, $n placeholders

/** How long to wait before the next poll redelivers a record the judge could not score. */
export const RETRY_DELAY_MS = 1000;

/** One record of support-conversations: an answered (or escalated) turn of a session. */
export interface Turn {
  session_id: string;
  turn: number;
  dasher_id: string;
  question: string;
  answer: string;
  sources: string[];
  escalated: boolean;
  model: string;
  tokens: number;
}

export interface Scores {
  groundedness: number;
  coherence: number;
  compliance: number;
  pass: boolean;
}

interface JudgeClient {
  Evaluate(request: {question: string; answer: string; context_ids: string[]}): Promise<Scores>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('support.proto')) as unknown as {
  support: {Judge: new (target: string, credentials: grpc.ChannelCredentials) => JudgeClient};
};
const judge = new pkg.support.Judge(JUDGE, grpc.credentials.createInsecure());

const kafka = new Kafka({clientId: 'quality-judge', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: GROUP});

/** The judge's verdict on one answered turn. */
export async function evaluate(question: string, answer: string, sources: string[]): Promise<Scores> {
  // TODO: judge.Evaluate({question, answer, context_ids: sources}) → {groundedness, coherence, compliance, pass}
  throw new Error('not implemented');
}

/** One row per (session, turn): a redelivered record overwrites its own row instead of adding a second. */
export async function recordScores(sessionId: string, turn: number, scores: Scores): Promise<void> {
  // TODO: INSERT INTO quality_scores (session_id, turn, groundedness, coherence, compliance, pass) VALUES (…)
  // TODO: ON CONFLICT (session_id, turn) DO UPDATE SET … = EXCLUDED.…
  throw new Error('not implemented');
}

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    // TODO: disable auto-commit
    eachMessage: async ({topic, partition, message}: EachMessagePayload) => {
      const turn = JSON.parse(message.value?.toString() ?? '{}') as Turn;
      // TODO: escalated → commit this message's offset (offset + 1), return
      // TODO: evaluate(question, answer, sources); UNAVAILABLE → consumer.seek back to message.offset, sleep RETRY_DELAY_MS, return (no commit)
      // TODO: await recordScores(session_id, turn, scores), then commit
      throw new Error('not implemented');
    },
  });
}
`,
      solution: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {type EachMessagePayload, Kafka} from 'kafkajs';

import {GROUP, JUDGE, TOPIC} from 'assistant/config';
import {pool} from 'assistant/db'; // await pool.query(sql, [params]): one autocommitted statement, $n placeholders

/** How long to wait before the next poll redelivers a record the judge could not score. */
export const RETRY_DELAY_MS = 1000;

/** One record of support-conversations: an answered (or escalated) turn of a session. */
export interface Turn {
  session_id: string;
  turn: number;
  dasher_id: string;
  question: string;
  answer: string;
  sources: string[];
  escalated: boolean;
  model: string;
  tokens: number;
}

export interface Scores {
  groundedness: number;
  coherence: number;
  compliance: number;
  pass: boolean;
}

interface JudgeClient {
  Evaluate(request: {question: string; answer: string; context_ids: string[]}): Promise<Scores>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('support.proto')) as unknown as {
  support: {Judge: new (target: string, credentials: grpc.ChannelCredentials) => JudgeClient};
};
const judge = new pkg.support.Judge(JUDGE, grpc.credentials.createInsecure());

const kafka = new Kafka({clientId: 'quality-judge', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: GROUP});

/** The judge's verdict on one answered turn. */
export async function evaluate(question: string, answer: string, sources: string[]): Promise<Scores> {
  const scores = await judge.Evaluate({question, answer, context_ids: sources});
  return {groundedness: scores.groundedness, coherence: scores.coherence, compliance: scores.compliance, pass: scores.pass};
}

/** One row per (session, turn): a redelivered record overwrites its own row instead of adding a second. */
export async function recordScores(sessionId: string, turn: number, scores: Scores): Promise<void> {
  await pool.query(
    'INSERT INTO quality_scores (session_id, turn, groundedness, coherence, compliance, pass) VALUES ($1, $2, $3, $4, $5, $6)' +
      ' ON CONFLICT (session_id, turn) DO UPDATE SET groundedness = EXCLUDED.groundedness, coherence = EXCLUDED.coherence,' +
      ' compliance = EXCLUDED.compliance, pass = EXCLUDED.pass',
    [sessionId, turn, scores.groundedness, scores.coherence, scores.compliance, scores.pass],
  );
}

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}: EachMessagePayload) => {
      const commit = (): Promise<void> =>
        consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const turn = JSON.parse(message.value?.toString() ?? '{}') as Turn;
      if (turn.escalated) {
        await commit(); // a handoff has no answer to judge
        return;
      }
      let scores: Scores;
      try {
        scores = await evaluate(turn.question, turn.answer, turn.sources ?? []);
      } catch (e) {
        if ((e as grpc.ServiceError).code !== grpc.status.UNAVAILABLE) throw e;
        // Not committed: rewind to this record so the next poll delivers it again, once the judge is back.
        consumer.seek({topic, partition, offset: message.offset});
        await sleep(RETRY_DELAY_MS);
        return;
      }
      await recordScores(turn.session_id, turn.turn, scores);
      await commit();
    },
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"assistant/config"
	"assistant/db" // db.Pool: the assistant's pgxpool.Pool; db.Pool.Exec(ctx, sql, args...) autocommits one statement
	pb "assistant/gen/support"
)

// How long to wait before asking the judge again about a record it could not score.
const retryDelay = time.Second

// Turn is one record of support-conversations: an answered (or escalated) turn of a session.
type Turn struct {
	SessionID string   \`json:"session_id"\`
	Turn      int      \`json:"turn"\`
	DasherID  string   \`json:"dasher_id"\`
	Question  string   \`json:"question"\`
	Answer    string   \`json:"answer"\`
	Sources   []string \`json:"sources"\`
	Escalated bool     \`json:"escalated"\`
	Model     string   \`json:"model"\`
	Tokens    int      \`json:"tokens"\`
}

type Scores struct {
	Groundedness float32
	Coherence    float32
	Compliance   float32
	Pass         bool
}

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers:     []string{"kafka:9092"},
	GroupID:     config.Group,
	Topic:       config.Topic,
	StartOffset: kafka.FirstOffset,
})

var conn, _ = grpc.NewClient(config.Judge, grpc.WithTransportCredentials(insecure.NewCredentials()))
var judge = pb.NewJudgeClient(conn)

// evaluate is the judge's verdict on one answered turn.
func evaluate(ctx context.Context, question, answer string, sources []string) (Scores, error) {
	// TODO: judge.Evaluate(ctx, &pb.EvaluateRequest{Question, Answer, ContextIds: sources}) → Scores
	return Scores{}, errors.New("not implemented")
}

// recordScores writes one row per (session, turn): a redelivered record overwrites its own row instead of adding a second.
func recordScores(ctx context.Context, sessionID string, turn int, s Scores) error {
	// TODO: INSERT INTO quality_scores (session_id, turn, groundedness, coherence, compliance, pass) VALUES (…)
	// TODO: ON CONFLICT (session_id, turn) DO UPDATE SET … = EXCLUDED.…
	return errors.New("not implemented")
}

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want)
		// TODO: Escalated → CommitMessages, continue
		// TODO: evaluate; codes.Unavailable → time.Sleep(retryDelay) and ask again, without committing
		// TODO: recordScores, then CommitMessages
		log.Println("not implemented")
		return nil
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"assistant/config"
	"assistant/db" // db.Pool: the assistant's pgxpool.Pool; db.Pool.Exec(ctx, sql, args...) autocommits one statement
	pb "assistant/gen/support"
)

// How long to wait before asking the judge again about a record it could not score.
const retryDelay = time.Second

// Turn is one record of support-conversations: an answered (or escalated) turn of a session.
type Turn struct {
	SessionID string   \`json:"session_id"\`
	Turn      int      \`json:"turn"\`
	DasherID  string   \`json:"dasher_id"\`
	Question  string   \`json:"question"\`
	Answer    string   \`json:"answer"\`
	Sources   []string \`json:"sources"\`
	Escalated bool     \`json:"escalated"\`
	Model     string   \`json:"model"\`
	Tokens    int      \`json:"tokens"\`
}

type Scores struct {
	Groundedness float32
	Coherence    float32
	Compliance   float32
	Pass         bool
}

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers:     []string{"kafka:9092"},
	GroupID:     config.Group,
	Topic:       config.Topic,
	StartOffset: kafka.FirstOffset,
})

var conn, _ = grpc.NewClient(config.Judge, grpc.WithTransportCredentials(insecure.NewCredentials()))
var judge = pb.NewJudgeClient(conn)

// evaluate is the judge's verdict on one answered turn.
func evaluate(ctx context.Context, question, answer string, sources []string) (Scores, error) {
	reply, err := judge.Evaluate(ctx, &pb.EvaluateRequest{Question: question, Answer: answer, ContextIds: sources})
	if err != nil {
		return Scores{}, err
	}
	return Scores{Groundedness: reply.GetGroundedness(), Coherence: reply.GetCoherence(), Compliance: reply.GetCompliance(), Pass: reply.GetPass()}, nil
}

// recordScores writes one row per (session, turn): a redelivered record overwrites its own row instead of adding a second.
func recordScores(ctx context.Context, sessionID string, turn int, s Scores) error {
	_, err := db.Pool.Exec(ctx,
		"INSERT INTO quality_scores (session_id, turn, groundedness, coherence, compliance, pass) VALUES ($1, $2, $3, $4, $5, $6)"+
			" ON CONFLICT (session_id, turn) DO UPDATE SET groundedness = EXCLUDED.groundedness, coherence = EXCLUDED.coherence,"+
			" compliance = EXCLUDED.compliance, pass = EXCLUDED.pass",
		sessionID, turn, s.Groundedness, s.Coherence, s.Compliance, s.Pass)
	return err
}

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var turn Turn
		if err := json.Unmarshal(msg.Value, &turn); err != nil {
			log.Printf("malformed record at %s[%d]@%d: %v", msg.Topic, msg.Partition, msg.Offset, err)
			if err := reader.CommitMessages(ctx, msg); err != nil {
				return err
			}
			continue
		}
		if turn.Escalated {
			if err := reader.CommitMessages(ctx, msg); err != nil { // a handoff has no answer to judge
				return err
			}
			continue
		}
		scores, err := evaluate(ctx, turn.Question, turn.Answer, turn.Sources)
		for status.Code(err) == codes.Unavailable {
			// Not committed: the record stays ours; ask again once the judge is back.
			time.Sleep(retryDelay)
			scores, err = evaluate(ctx, turn.Question, turn.Answer, turn.Sources)
		}
		if err != nil {
			return err
		}
		if err := recordScores(ctx, turn.SessionID, turn.Turn, scores); err != nil {
			return err // not committed: the record comes back
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import spray.json._
import scala.jdk.CollectionConverters._

import assistant.{Config, Db} // Db.connection: the assistant's JDBC connection (autocommit)
import support.support.{EvaluateRequest, JudgeGrpc}

final case class Turn(sessionId: String, turn: Int, dasherId: String, question: String, answer: String,
                      sources: Seq[String], escalated: Boolean, model: String, tokens: Int)
final case class Scores(groundedness: Float, coherence: Float, compliance: Float, pass: Boolean)

object QualityPipeline {
  /** How long to wait before the next poll redelivers a record the judge could not score. */
  val RetryDelayMillis = 1000L

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", Config.Group)
  props.put("auto.offset.reset", "earliest")
  props.put("max.poll.records", "1") // one record per poll, so a seek back retries exactly that record
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Config.Topic).asJava)

  private val channel = ManagedChannelBuilder.forTarget(Config.Judge).usePlaintext().build()
  private val judge = JudgeGrpc.blockingStub(channel)

  def parse(raw: String): Turn = {
    val f = raw.parseJson.asJsObject.fields
    Turn(f("session_id").convertTo[String], f("turn").convertTo[Int], f("dasher_id").convertTo[String],
         f("question").convertTo[String], f("answer").convertTo[String], f("sources").convertTo[Seq[String]],
         f("escalated").convertTo[Boolean], f("model").convertTo[String], f("tokens").convertTo[Int])
  }

  /** The judge's verdict on one answered turn. */
  def evaluate(question: String, answer: String, sources: Seq[String]): Scores =
    // TODO: judge.evaluate(EvaluateRequest(question = …, answer = …, contextIds = sources)) → Scores
    ???

  /** One row per (session, turn): a redelivered record overwrites its own row instead of adding a second. */
  def recordScores(sessionId: String, turn: Int, s: Scores): Unit =
    // TODO: INSERT INTO quality_scores (session_id, turn, groundedness, coherence, compliance, pass) VALUES (?, ?, ?, ?, ?, ?)
    // TODO: ON CONFLICT (session_id, turn) DO UPDATE SET … = EXCLUDED.…
    ???

  /** Commits this record's offset synchronously. */
  private def commit(record: ConsumerRecord[String, String]): Unit =
    consumer.commitSync(
      Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)

  def run(): Unit =
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val turn = parse(record.value)
        // TODO: escalated → commit(record)
        // TODO: evaluate; UNAVAILABLE → consumer.seek back to record.offset, Thread.sleep(RetryDelayMillis), no commit
        // TODO: recordScores, then commit(record)
        ???
      }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import spray.json._
import scala.jdk.CollectionConverters._

import assistant.{Config, Db} // Db.connection: the assistant's JDBC connection (autocommit)
import support.support.{EvaluateRequest, JudgeGrpc}

final case class Turn(sessionId: String, turn: Int, dasherId: String, question: String, answer: String,
                      sources: Seq[String], escalated: Boolean, model: String, tokens: Int)
final case class Scores(groundedness: Float, coherence: Float, compliance: Float, pass: Boolean)

object QualityPipeline {
  /** How long to wait before the next poll redelivers a record the judge could not score. */
  val RetryDelayMillis = 1000L

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", Config.Group)
  props.put("auto.offset.reset", "earliest")
  props.put("max.poll.records", "1") // one record per poll, so a seek back retries exactly that record
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Config.Topic).asJava)

  private val channel = ManagedChannelBuilder.forTarget(Config.Judge).usePlaintext().build()
  private val judge = JudgeGrpc.blockingStub(channel)

  def parse(raw: String): Turn = {
    val f = raw.parseJson.asJsObject.fields
    Turn(f("session_id").convertTo[String], f("turn").convertTo[Int], f("dasher_id").convertTo[String],
         f("question").convertTo[String], f("answer").convertTo[String], f("sources").convertTo[Seq[String]],
         f("escalated").convertTo[Boolean], f("model").convertTo[String], f("tokens").convertTo[Int])
  }

  /** The judge's verdict on one answered turn. */
  def evaluate(question: String, answer: String, sources: Seq[String]): Scores = {
    val reply = judge.evaluate(EvaluateRequest(question = question, answer = answer, contextIds = sources))
    Scores(reply.groundedness, reply.coherence, reply.compliance, reply.pass)
  }

  /** One row per (session, turn): a redelivered record overwrites its own row instead of adding a second. */
  def recordScores(sessionId: String, turn: Int, s: Scores): Unit = {
    val st = Db.connection.prepareStatement(
      "INSERT INTO quality_scores (session_id, turn, groundedness, coherence, compliance, pass) VALUES (?, ?, ?, ?, ?, ?)" +
        " ON CONFLICT (session_id, turn) DO UPDATE SET groundedness = EXCLUDED.groundedness, coherence = EXCLUDED.coherence," +
        " compliance = EXCLUDED.compliance, pass = EXCLUDED.pass")
    st.setString(1, sessionId); st.setInt(2, turn); st.setFloat(3, s.groundedness)
    st.setFloat(4, s.coherence); st.setFloat(5, s.compliance); st.setBoolean(6, s.pass)
    st.executeUpdate()
  }

  /** Commits this record's offset synchronously. */
  private def commit(record: ConsumerRecord[String, String]): Unit =
    consumer.commitSync(
      Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)

  def run(): Unit =
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val turn = parse(record.value)
        if (turn.escalated) commit(record) // a handoff has no answer to judge
        else {
          // The judge's verdict, or None when it answered UNAVAILABLE; any other status propagates.
          val verdict =
            try Some(evaluate(turn.question, turn.answer, turn.sources))
            catch { case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.UNAVAILABLE => None }
          verdict match {
            case None =>
              // Not committed: rewind to this record so the next poll delivers it again, once the judge is back.
              consumer.seek(new TopicPartition(record.topic, record.partition), record.offset)
              Thread.sleep(RetryDelayMillis)
            case Some(scores) =>
              recordScores(turn.sessionId, turn.turn, scores)
              commit(record)
          }
        }
      }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <pqxx/pqxx>

#include <chrono>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "assistant/config.h"  // config::kGroup, config::kTopic, config::kJudge
#include "assistant/db.h"      // db::connection(): the assistant's pqxx::connection
#include "support.grpc.pb.h"

using json = nlohmann::json;

// How long to wait before the next poll redelivers a record the judge could not score.
constexpr std::chrono::milliseconds kRetryDelay{1000};

// One record of support-conversations: an answered (or escalated) turn of a session.
struct Turn {
  std::string session_id;
  int turn;
  std::string question;
  std::string answer;
  std::vector<std::string> sources;
  bool escalated;
};

struct Scores {
  float groundedness;
  float coherence;
  float compliance;
  bool pass;
};

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", config::kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kTopic});
  return consumer;
}

auto consumer = make_consumer();
auto channel = grpc::CreateChannel(config::kJudge, grpc::InsecureChannelCredentials());
auto judge = support::Judge::NewStub(channel);

Turn parse(const std::string& raw) {
  const json j = json::parse(raw);
  return Turn{j["session_id"].get<std::string>(), j["turn"].get<int>(), j["question"].get<std::string>(),
              j["answer"].get<std::string>(), j.value("sources", std::vector<std::string>{}), j.value("escalated", false)};
}

// The judge's verdict on one answered turn, or nullopt when it answered UNAVAILABLE; any other status throws.
std::optional<Scores> evaluate(const std::string& question, const std::string& answer, const std::vector<std::string>& sources) {
  // TODO: support::EvaluateRequest with question, answer and add_context_ids(...) for every source; judge->Evaluate
  // TODO: UNAVAILABLE → nullopt; other errors → throw; ok → Scores
  throw std::runtime_error("not implemented");
}

// One row per (session, turn): a redelivered record overwrites its own row instead of adding a second.
void record_scores(const std::string& session_id, int turn, const Scores& s) {
  // TODO: INSERT INTO quality_scores (session_id, turn, groundedness, coherence, compliance, pass) VALUES ($1, …, $6)
  // TODO: ON CONFLICT (session_id, turn) DO UPDATE SET … = EXCLUDED.…
  throw std::runtime_error("not implemented");
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const Turn turn = parse(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    // TODO: escalated → commitSync this message, continue
    // TODO: evaluate; nullopt → consumer->seek back to msg->offset(), sleep kRetryDelay, continue (no commit)
    // TODO: record_scores, then commitSync this message
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <pqxx/pqxx>

#include <chrono>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "assistant/config.h"  // config::kGroup, config::kTopic, config::kJudge
#include "assistant/db.h"      // db::connection(): the assistant's pqxx::connection
#include "support.grpc.pb.h"

using json = nlohmann::json;

// How long to wait before the next poll redelivers a record the judge could not score.
constexpr std::chrono::milliseconds kRetryDelay{1000};

// One record of support-conversations: an answered (or escalated) turn of a session.
struct Turn {
  std::string session_id;
  int turn;
  std::string question;
  std::string answer;
  std::vector<std::string> sources;
  bool escalated;
};

struct Scores {
  float groundedness;
  float coherence;
  float compliance;
  bool pass;
};

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", config::kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({config::kTopic});
  return consumer;
}

auto consumer = make_consumer();
auto channel = grpc::CreateChannel(config::kJudge, grpc::InsecureChannelCredentials());
auto judge = support::Judge::NewStub(channel);

Turn parse(const std::string& raw) {
  const json j = json::parse(raw);
  return Turn{j["session_id"].get<std::string>(), j["turn"].get<int>(), j["question"].get<std::string>(),
              j["answer"].get<std::string>(), j.value("sources", std::vector<std::string>{}), j.value("escalated", false)};
}

// The judge's verdict on one answered turn, or nullopt when it answered UNAVAILABLE; any other status throws.
std::optional<Scores> evaluate(const std::string& question, const std::string& answer, const std::vector<std::string>& sources) {
  support::EvaluateRequest request;
  request.set_question(question);
  request.set_answer(answer);
  for (const auto& id : sources) request.add_context_ids(id);
  grpc::ClientContext ctx;
  support::Scores reply;
  const grpc::Status status = judge->Evaluate(&ctx, request, &reply);
  if (status.error_code() == grpc::StatusCode::UNAVAILABLE) return std::nullopt;
  if (!status.ok()) throw std::runtime_error("judge: " + status.error_message());
  return Scores{reply.groundedness(), reply.coherence(), reply.compliance(), reply.pass()};
}

// One row per (session, turn): a redelivered record overwrites its own row instead of adding a second.
void record_scores(const std::string& session_id, int turn, const Scores& s) {
  pqxx::work tx(db::connection());
  tx.exec_params(
      "INSERT INTO quality_scores (session_id, turn, groundedness, coherence, compliance, pass) VALUES ($1, $2, $3, $4, $5, $6)"
      " ON CONFLICT (session_id, turn) DO UPDATE SET groundedness = EXCLUDED.groundedness, coherence = EXCLUDED.coherence,"
      " compliance = EXCLUDED.compliance, pass = EXCLUDED.pass",
      session_id, turn, s.groundedness, s.coherence, s.compliance, s.pass);
  tx.commit();
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const Turn turn = parse(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    if (turn.escalated) {
      consumer->commitSync(msg.get());  // a handoff has no answer to judge
      continue;
    }
    const auto scores = evaluate(turn.question, turn.answer, turn.sources);
    if (!scores) {
      // Not committed: rewind to this record so the next poll delivers it again, once the judge is back.
      std::unique_ptr<RdKafka::TopicPartition> tp(RdKafka::TopicPartition::create(msg->topic_name(), msg->partition(), msg->offset()));
      consumer->seek(*tp, 1000);
      std::this_thread::sleep_for(kRetryDelay);
      continue;
    }
    record_scores(turn.session_id, turn.turn, *scores);  // throws → not committed, the record comes back
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json

import grpc

import support_pb2
import support_pb2_grpc
from assistant import config, model
from assistant.db import SCHEMA

TOPIC = config.TOPIC
GROUP = config.GROUP

# Three answers as the API would have produced them: grounded (cites only retrieved chunks), hallucinated
# (invents a policy and a chunk) and half-grounded (one citation outside its sources).
GROUNDED = {"question": "When do I get paid?", "answer": "Based on [kb:pay-0][kb:pay-1]: Dasher earnings for a week are paid out every Monday by direct deposit.", "sources": ["pay-0", "pay-1"]}
HALLUCINATED = {"question": "The order was cancelled at the restaurant, do I still get paid?", "answer": "Your issue will be resolved within 7 days, guaranteed [kb:policy-404].", "sources": ["red-card-1"]}
HALF = {"question": "Do my tips come with Fast Pay?", "answer": "Based on [kb:tips-0][kb:pay-3]: Tips are included in the weekly payout and in Fast Pay.", "sources": ["tips-0"]}


def _turn(session_id, turn, kind=GROUNDED, escalated=False):
    if escalated:
        return {"session_id": session_id, "turn": turn, "dasher_id": "d-" + session_id, "question": kind["question"], "answer": config.HANDOFF_TEXT, "sources": [], "escalated": True, "model": "large", "tokens": len(config.HANDOFF_TEXT.split())}
    return {"session_id": session_id, "turn": turn, "dasher_id": "d-" + session_id, "question": kind["question"], "answer": kind["answer"], "sources": list(kind["sources"]), "escalated": False, "model": "large", "tokens": len(kind["answer"].split())}


def _seed(ctx, *turns):
    return [ctx.kafka.seed(TOPIC, key=t["session_id"], value=json.dumps(t)) for t in turns]


def _expected(kind):
    return model.evaluate(kind["question"], kind["answer"], kind["sources"])


class JudgeServicer(support_pb2_grpc.JudgeServicer):
    """The LLM judge at judge:50051: the deterministic rubric of assistant.model, plus what it was asked."""

    def __init__(self):
        self.calls = []

    def Evaluate(self, request, context):
        context_ids = list(request.context_ids)
        self.calls.append((request.question, request.answer, context_ids))
        return support_pb2.Scores(**model.evaluate(request.question, request.answer, context_ids))


async def _worker(ctx):
    """The learner's consumer in front of the judge and an empty quality_scores table."""
    await ctx.db.reset(SCHEMA)
    judge = JudgeServicer()
    ctx.grpc.serve(support_pb2_grpc.add_JudgeServicer_to_server, judge, config.JUDGE)
    return ctx.load("quality_pipeline"), judge


async def _run(ctx, m):
    await ctx.drain_async(m.run())


async def _rows(ctx):
    """{(session_id, turn): row} as the table holds it."""
    rows = await ctx.db.execute("SELECT * FROM quality_scores ORDER BY session_id, turn")
    return {(r["session_id"], r["turn"]): r for r in rows}


def _same_scores(row, expected):
    return all(abs(float(row[k]) - float(expected[k])) < 1e-3 for k in ("groundedness", "coherence", "compliance")) and bool(row["pass"]) == bool(expected["pass"])


def _watch_commits(ctx):
    """Every commit as the broker saw it, with the database's query log at that instant."""
    seen = []
    ctx.kafka.on_commit(lambda group, offsets: seen.append((group, dict(offsets), list(ctx.db.queries))))
    return seen


def _row_written(queries, session_id, turn):
    """Whether an INSERT into quality_scores for (session_id, turn) had run by the end of this query log."""
    return any("insert into quality_scores" in sql.lower() and session_id in params and turn in params for sql, params in queries)


def _newly_committed(ctx, commits):
    """(record, query log) for each record of the topic as its offset was first committed by the group."""
    out = []
    done = {}
    for group, offsets, queries in commits:
        if group != GROUP:
            continue
        for (topic, partition), offset in offsets.items():
            if topic != TOPIC:
                continue
            for record in ctx.kafka.records(TOPIC):
                if record.partition == partition and done.get(partition, 0) <= record.offset < offset:
                    out.append((record, queries))
            done[partition] = max(done.get(partition, 0), offset)
    return out


def _fully_committed(ctx):
    lag = ctx.kafka.lag(GROUP, TOPIC)
    assert lag == 0, f"{lag} record(s) of {TOPIC} are not committed for group {GROUP} after the consumer handled them"


async def check_group_manual_commit(ctx):
    _seed(ctx, _turn("s1", 1), _turn("s2", 1, HALLUCINATED), _turn("s1", 2, HALF))
    m, judge = await _worker(ctx)
    await _run(ctx, m)
    subscriptions = [e for e in ctx.kafka.events if e[0] == "subscribe"]
    assert subscriptions, "the consumer never subscribed to a topic"
    group, topics = subscriptions[-1][1], subscriptions[-1][2]
    assert group == GROUP, f"group.id must be config.GROUP ({GROUP!r}), got {group!r}"
    assert TOPIC in topics, f"the consumer must subscribe to config.TOPIC ({TOPIC!r}), got {topics}"
    members = [c for c in ctx.kafka.consumers if c.group == GROUP]
    assert members and all(c.auto_commit is False for c in members), "enable.auto.commit is on: offsets would be acknowledged on a timer, before the row is written — set it to False and commit after record_scores"
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "offsets were auto-committed"
    assert any(e[0] == "manual-commit" and e[1] == GROUP for e in ctx.kafka.events), f"no explicit commit happened for group {GROUP}"
    rows = await _rows(ctx)
    assert len(rows) == 3, f"three answered turns were on {TOPIC}, quality_scores holds {len(rows)} row(s): the consumer must read from the earliest offset (auto.offset.reset) and score every record"
    _fully_committed(ctx)


async def check_scores_per_turn(ctx):
    _seed(ctx, _turn("s1", 1, GROUNDED), _turn("s2", 1, HALLUCINATED), _turn("s1", 2, HALF))
    m, judge = await _worker(ctx)
    await _run(ctx, m)
    calls = ctx.grpc.calls_to("Evaluate", config.JUDGE)
    assert calls, f"no Judge.Evaluate reached {config.JUDGE}: every answered turn is judged"
    assert len(judge.calls) == 3, f"three answered turns must mean three Evaluate calls, the judge saw {len(judge.calls)}"
    for kind in (GROUNDED, HALLUCINATED, HALF):
        asked = [c for c in judge.calls if c[1] == kind["answer"]]
        assert asked, f"the judge was never asked about {kind['answer'][:40]!r}…"
        assert asked[0][0] == kind["question"], f"Evaluate must carry the record's question, got {asked[0][0]!r}"
        assert asked[0][2] == kind["sources"], f"context_ids must be the record's sources {kind['sources']}, the judge received {asked[0][2]}"
    rows = await _rows(ctx)
    assert sorted(rows) == [("s1", 1), ("s1", 2), ("s2", 1)], f"one row per (session_id, turn) was expected, quality_scores holds {sorted(rows)}"
    for key, kind in ((("s1", 1), GROUNDED), (("s2", 1), HALLUCINATED), (("s1", 2), HALF)):
        expected = _expected(kind)
        got = {k: rows[key][k] for k in ("groundedness", "coherence", "compliance", "pass")}
        assert _same_scores(rows[key], expected), f"{key}: the row holds {got}, the judge said {expected}: store the judge's scores as they came"
    assert rows[("s1", 1)]["pass"] is True, "the grounded answer cites only its sources: the judge passes it, and the row must say so"
    assert rows[("s2", 1)]["pass"] is False, "the hallucinated answer cites [kb:policy-404], which was never retrieved, and promises an outcome: it must be stored as a failure"
    assert rows[("s1", 2)]["pass"] is False, "an answer with one citation outside its sources scores 0.5 on groundedness: stored as a failure"


async def check_escalated_committed(ctx):
    _seed(ctx, _turn("s1", 1, GROUNDED), _turn("s1", 2, escalated=True), _turn("s3", 1, escalated=True), _turn("s2", 1, HALLUCINATED))
    m, judge = await _worker(ctx)
    try:
        await _run(ctx, m)
    except Exception as exc:
        raise AssertionError(f"an escalated turn must not stop the consumer, but run() raised {type(exc).__name__}: {exc}")
    assert len(judge.calls) == 2, f"two answered turns and two handoffs: the judge must be asked twice, it was asked {len(judge.calls)} time(s)"
    assert not any(c[1] == config.HANDOFF_TEXT for c in judge.calls), "the handoff text is not an answer: an escalated turn must not be sent to the judge"
    rows = await _rows(ctx)
    assert sorted(rows) == [("s1", 1), ("s2", 1)], f"escalated turns produce no row, quality_scores holds {sorted(rows)}"
    lag = ctx.kafka.lag(GROUP, TOPIC)
    assert lag == 0, f"{lag} record(s) not committed: an escalated turn's offset must be committed too, or it is redelivered forever"


async def check_commit_after_write(ctx):
    _seed(ctx, _turn("s1", 1, GROUNDED), _turn("s2", 1, HALF))
    m, judge = await _worker(ctx)
    commits = _watch_commits(ctx)
    await _run(ctx, m)
    committed = _newly_committed(ctx, commits)
    assert committed, f"the offsets of s1 and s2 were never committed by group {GROUP}"
    for record, queries in committed:
        turn = json.loads(record.value)
        assert _row_written(queries, turn["session_id"], turn["turn"]), f"the offset of ({turn['session_id']}, {turn['turn']}) was committed before its row was in quality_scores: commit only after record_scores returned"
    # Postgres starts refusing: turn 99 now violates a constraint, so the write fails.
    await ctx.db.execute("ALTER TABLE quality_scores ADD CONSTRAINT scores_down CHECK (turn <> 99) NOT VALID")
    _seed(ctx, _turn("s1", 99, GROUNDED))
    try:
        await _run(ctx, m)
    except Exception:
        pass  # the failed write surfaces here; what matters is what was committed
    assert ("s1", 99) not in await _rows(ctx), "the write of turn 99 failed and must have left no row"
    assert ctx.kafka.lag(GROUP, TOPIC) == 1, "a record whose write failed must not be committed: it has to come back"
    await ctx.db.execute("ALTER TABLE quality_scores DROP CONSTRAINT scores_down")
    restarted = ctx.load("quality_pipeline")
    await _run(ctx, restarted)
    rows = await _rows(ctx)
    assert ("s1", 99) in rows, f"after a restart turn 99 must be redelivered and written, quality_scores holds {sorted(rows)}"
    assert len(rows) == 3, f"three answered turns, {len(rows)} rows: each (session, turn) is written once"
    _fully_committed(ctx)


async def check_judge_down_retries(ctx):
    _seed(ctx, _turn("s1", 1, GROUNDED), _turn("s2", 1, HALF), _turn("s1", 1, GROUNDED))  # the last one: the producer retried, a duplicate
    m, judge = await _worker(ctx)
    commits = _watch_commits(ctx)
    # The judge's first answer is UNAVAILABLE (a deploy, a restart); it is back for every call after that.
    ctx.grpc.fail("Evaluate", grpc.StatusCode.UNAVAILABLE, "", 1, config.JUDGE)
    try:
        await _run(ctx, m)
    except grpc.RpcError:
        pass  # a consumer that stops on the failure instead of retrying in place: it restarts below
    if ctx.kafka.lag(GROUP, TOPIC) > 0:
        # Acceptable only if nothing was committed for the failed record (checked below), and the restart scores it.
        restarted = ctx.load("quality_pipeline")
        await _run(ctx, restarted)
    calls = ctx.grpc.calls_to("Evaluate", config.JUDGE)
    assert len(calls) >= 4, f"three records (one a duplicate) and one UNAVAILABLE answer mean at least four Evaluate calls — the failed one and a retry — the judge saw {len(calls)}: an UNAVAILABLE judge means ask again later, not skip"
    failed = [c for c in calls if c.code == grpc.StatusCode.UNAVAILABLE]
    assert failed, "the UNAVAILABLE call never happened"
    for record, queries in _newly_committed(ctx, commits):
        turn = json.loads(record.value)
        assert _row_written(queries, turn["session_id"], turn["turn"]), f"the offset of ({turn['session_id']}, {turn['turn']}) was committed while no row existed for it: a judge answering UNAVAILABLE must leave the offset uncommitted"
    rows = await _rows(ctx)
    assert sorted(rows) == [("s1", 1), ("s2", 1)], f"two distinct (session, turn) pairs were delivered three times: quality_scores must hold exactly those two rows, it holds {sorted(rows)}"
    assert _same_scores(rows[("s1", 1)], _expected(GROUNDED)) and _same_scores(rows[("s2", 1)], _expected(HALF)), "the retried record must end up with the judge's scores, as if it had never failed"
    _fully_committed(ctx)
`,
    typescript: `// Three answers as the API would have produced them: grounded (cites only retrieved chunks), hallucinated
// (invents a policy and a chunk) and half-grounded (one citation outside its sources).
const GROUNDED = {question: 'When do I get paid?', answer: 'Based on [kb:pay-0][kb:pay-1]: Dasher earnings for a week are paid out every Monday by direct deposit.', sources: ['pay-0', 'pay-1']};
const HALLUCINATED = {question: 'The order was cancelled at the restaurant, do I still get paid?', answer: 'Your issue will be resolved within 7 days, guaranteed [kb:policy-404].', sources: ['red-card-1']};
const HALF = {question: 'Do my tips come with Fast Pay?', answer: 'Based on [kb:tips-0][kb:pay-3]: Tips are included in the weekly payout and in Fast Pay.', sources: ['tips-0']};

type Kind = typeof GROUNDED;

/** The assistant package as the harness sees it: config, the judge's rubric and the schema. */
function assistant(ctx) {
  const config = ctx.load('/support/assistant/config.ts');
  const {evaluate} = ctx.load('/support/assistant/model.ts');
  const {SCHEMA} = ctx.load('/support/assistant/db.ts');
  return {config, evaluate, SCHEMA, TOPIC: config.TOPIC as string, GROUP: config.GROUP as string, JUDGE: config.JUDGE as string};
}

function turn(ctx, sessionId: string, n: number, kind: Kind = GROUNDED, escalated = false) {
  const {config} = assistant(ctx);
  if (escalated)
    return {session_id: sessionId, turn: n, dasher_id: 'd-' + sessionId, question: kind.question, answer: config.HANDOFF_TEXT, sources: [], escalated: true, model: 'large', tokens: String(config.HANDOFF_TEXT).split(' ').length};
  return {session_id: sessionId, turn: n, dasher_id: 'd-' + sessionId, question: kind.question, answer: kind.answer, sources: [...kind.sources], escalated: false, model: 'large', tokens: kind.answer.split(' ').length};
}

function seed(ctx, ...turns: Record<string, unknown>[]) {
  const {TOPIC} = assistant(ctx);
  return turns.map(t => ctx.kafka.seed(TOPIC, {key: t.session_id, value: JSON.stringify(t)}));
}

/** The learner's consumer in front of the judge at judge:50051 (the deterministic rubric of assistant/model) and an empty quality_scores table. */
async function worker(ctx) {
  const {evaluate, SCHEMA, JUDGE} = assistant(ctx);
  await ctx.db.reset(SCHEMA);
  const {support} = ctx.proto('support.proto');
  const judge = {calls: [] as [string, string, string[]][]};
  ctx.grpc.serve(
    support.Judge.service,
    {
      Evaluate: (call, callback) => {
        const {question, answer, context_ids} = call.request;
        judge.calls.push([question, answer, [...context_ids]]);
        callback(null, evaluate(question, answer, [...context_ids]));
      },
    },
    JUDGE,
  );
  return {m: ctx.load('quality_pipeline'), judge};
}

/** {'session|turn': row} as the table holds it. */
async function rows(ctx) {
  const out: Record<string, {groundedness: number; coherence: number; compliance: number; pass: boolean}> = {};
  for (const r of await ctx.db.execute('SELECT * FROM quality_scores ORDER BY session_id, turn')) out[\`\${r.session_id}|\${r.turn}\`] = r;
  return out;
}

function sameScores(row, expected): boolean {
  return (['groundedness', 'coherence', 'compliance'] as const).every(k => Math.abs(Number(row[k]) - Number(expected[k])) < 1e-3) && Boolean(row.pass) === Boolean(expected.pass);
}

interface CommitSeen {
  group: string;
  offsets: Map<string, number>;
  queries: [string, unknown[]][];
}

/** Every commit as the broker saw it, with the database's query log at that instant. */
function watchCommits(ctx): CommitSeen[] {
  const seen: CommitSeen[] = [];
  ctx.kafka.onCommit((group, offsets) => seen.push({group, offsets: new Map(offsets), queries: [...ctx.db.queries]}));
  return seen;
}

/** Whether an INSERT into quality_scores for (sessionId, turn) had run by the end of this query log. */
function rowWritten(queries: [string, unknown[]][], sessionId: string, n: number): boolean {
  return queries.some(([sql, params]) => sql.toLowerCase().includes('insert into quality_scores') && params.includes(sessionId) && params.includes(n));
}

/** [record, query log] for each record of the topic as its offset was first committed by the group. */
function newlyCommitted(ctx, commits: CommitSeen[]) {
  const {TOPIC, GROUP} = assistant(ctx);
  const out: {record; queries: [string, unknown[]][]}[] = [];
  const done: Record<number, number> = {};
  for (const {group, offsets, queries} of commits) {
    if (group !== GROUP) continue;
    for (const [tp, offset] of offsets) {
      const [topic, partition] = tp.split('|');
      if (topic !== TOPIC) continue;
      const p = Number(partition);
      for (const record of ctx.kafka.records(TOPIC)) {
        if (record.partition === p && (done[p] ?? 0) <= record.offset && record.offset < offset) out.push({record, queries});
      }
      done[p] = Math.max(done[p] ?? 0, offset);
    }
  }
  return out;
}

function fullyCommitted(ctx) {
  const {TOPIC, GROUP} = assistant(ctx);
  const lag = ctx.kafka.lag(GROUP, TOPIC);
  assert.equal(lag, 0, \`\${lag} record(s) of \${TOPIC} are not committed for group \${GROUP} after the consumer handled them\`);
}

const parse = (record): {session_id: string; turn: number} => JSON.parse(record.value.toString());

export async function check_group_manual_commit(ctx) {
  const {TOPIC, GROUP} = assistant(ctx);
  seed(ctx, turn(ctx, 's1', 1), turn(ctx, 's2', 1, HALLUCINATED), turn(ctx, 's1', 2, HALF));
  const {m} = await worker(ctx);
  await ctx.drain(m.run());
  const subscriptions = ctx.kafka.events.filter(e => e[0] === 'subscribe');
  assert(subscriptions.length > 0, 'the consumer never subscribed to a topic');
  const [, group, topics] = subscriptions[subscriptions.length - 1];
  assert.equal(group, GROUP, \`groupId must be GROUP (\${JSON.stringify(GROUP)}), got \${JSON.stringify(group)}\`);
  assert(topics.includes(TOPIC), \`the consumer must subscribe to TOPIC (\${JSON.stringify(TOPIC)}), got \${JSON.stringify(topics)}\`);
  const members = ctx.kafka.consumers.filter(c => c.groupId === GROUP);
  assert(members.length > 0 && members.every(c => c.autoCommit === false), 'the consumer runs with autoCommit on: offsets would be acknowledged on a timer, before the row is written — set autoCommit: false and commit after recordScores');
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'offsets were auto-committed');
  assert(ctx.kafka.events.some(e => e[0] === 'manual-commit' && e[1] === GROUP), \`no explicit commit happened for group \${GROUP}\`);
  const held = await rows(ctx);
  assert.equal(Object.keys(held).length, 3, \`three answered turns were on \${TOPIC}, quality_scores holds \${Object.keys(held).length} row(s): the consumer must read from the beginning (fromBeginning: true) and score every record\`);
  fullyCommitted(ctx);
}

export async function check_scores_per_turn(ctx) {
  const {evaluate, JUDGE} = assistant(ctx);
  seed(ctx, turn(ctx, 's1', 1, GROUNDED), turn(ctx, 's2', 1, HALLUCINATED), turn(ctx, 's1', 2, HALF));
  const {m, judge} = await worker(ctx);
  await ctx.drain(m.run());
  const calls = ctx.grpc.callsTo('Evaluate', JUDGE);
  assert(calls.length > 0, \`no Judge.Evaluate reached \${JUDGE}: every answered turn is judged\`);
  assert.equal(judge.calls.length, 3, \`three answered turns must mean three Evaluate calls, the judge saw \${judge.calls.length}\`);
  for (const kind of [GROUNDED, HALLUCINATED, HALF]) {
    const asked = judge.calls.filter(c => c[1] === kind.answer);
    assert(asked.length > 0, \`the judge was never asked about \${JSON.stringify(kind.answer.slice(0, 40))}…\`);
    assert.equal(asked[0][0], kind.question, \`Evaluate must carry the record's question, got \${JSON.stringify(asked[0][0])}\`);
    assert.deepEqual(asked[0][2], kind.sources, \`context_ids must be the record's sources \${JSON.stringify(kind.sources)}, the judge received \${JSON.stringify(asked[0][2])}\`);
  }
  const held = await rows(ctx);
  assert.deepEqual(Object.keys(held).sort(), ['s1|1', 's1|2', 's2|1'], \`one row per (session_id, turn) was expected, quality_scores holds \${JSON.stringify(Object.keys(held).sort())}\`);
  for (const [key, kind] of [['s1|1', GROUNDED], ['s2|1', HALLUCINATED], ['s1|2', HALF]] as const) {
    const expected = evaluate(kind.question, kind.answer, kind.sources);
    const got = {groundedness: held[key].groundedness, coherence: held[key].coherence, compliance: held[key].compliance, pass: held[key].pass};
    assert(sameScores(held[key], expected), \`\${key}: the row holds \${JSON.stringify(got)}, the judge said \${JSON.stringify(expected)}: store the judge's scores as they came\`);
  }
  assert.equal(held['s1|1'].pass, true, 'the grounded answer cites only its sources: the judge passes it, and the row must say so');
  assert.equal(held['s2|1'].pass, false, 'the hallucinated answer cites [kb:policy-404], which was never retrieved, and promises an outcome: it must be stored as a failure');
  assert.equal(held['s1|2'].pass, false, 'an answer with one citation outside its sources scores 0.5 on groundedness: stored as a failure');
}

export async function check_escalated_committed(ctx) {
  const {config, TOPIC, GROUP} = assistant(ctx);
  seed(ctx, turn(ctx, 's1', 1, GROUNDED), turn(ctx, 's1', 2, GROUNDED, true), turn(ctx, 's3', 1, GROUNDED, true), turn(ctx, 's2', 1, HALLUCINATED));
  const {m, judge} = await worker(ctx);
  try {
    await ctx.drain(m.run());
  } catch (e) {
    assert.fail(\`an escalated turn must not stop the consumer, but run() rejected with \${e instanceof Error ? e.name : typeof e}: \${e instanceof Error ? e.message : String(e)}\`);
  }
  assert.equal(judge.calls.length, 2, \`two answered turns and two handoffs: the judge must be asked twice, it was asked \${judge.calls.length} time(s)\`);
  assert(!judge.calls.some(c => c[1] === config.HANDOFF_TEXT), 'the handoff text is not an answer: an escalated turn must not be sent to the judge');
  const held = await rows(ctx);
  assert.deepEqual(Object.keys(held).sort(), ['s1|1', 's2|1'], \`escalated turns produce no row, quality_scores holds \${JSON.stringify(Object.keys(held).sort())}\`);
  const lag = ctx.kafka.lag(GROUP, TOPIC);
  assert.equal(lag, 0, \`\${lag} record(s) not committed: an escalated turn's offset must be committed too, or it is redelivered forever\`);
}

export async function check_commit_after_write(ctx) {
  const {TOPIC, GROUP} = assistant(ctx);
  seed(ctx, turn(ctx, 's1', 1, GROUNDED), turn(ctx, 's2', 1, HALF));
  const {m} = await worker(ctx);
  const commits = watchCommits(ctx);
  await ctx.drain(m.run());
  const committed = newlyCommitted(ctx, commits);
  assert(committed.length > 0, \`the offsets of s1 and s2 were never committed by group \${GROUP}\`);
  for (const {record, queries} of committed) {
    const t = parse(record);
    assert(rowWritten(queries, t.session_id, t.turn), \`the offset of (\${t.session_id}, \${t.turn}) was committed before its row was in quality_scores: commit only after recordScores resolved\`);
  }
  // Postgres starts refusing: turn 99 now violates a constraint, so the write fails.
  await ctx.db.execute('ALTER TABLE quality_scores ADD CONSTRAINT scores_down CHECK (turn <> 99) NOT VALID');
  seed(ctx, turn(ctx, 's1', 99, GROUNDED));
  try {
    await ctx.drain(m.run());
  } catch {
    // the failed write surfaces here; what matters is what was committed
  }
  assert(!('s1|99' in (await rows(ctx))), 'the write of turn 99 failed and must have left no row');
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 1, 'a record whose write failed must not be committed: it has to come back');
  await ctx.db.execute('ALTER TABLE quality_scores DROP CONSTRAINT scores_down');
  const restarted = ctx.reload('quality_pipeline');
  await ctx.drain(restarted.run());
  const held = await rows(ctx);
  assert('s1|99' in held, \`after a restart turn 99 must be redelivered and written, quality_scores holds \${JSON.stringify(Object.keys(held).sort())}\`);
  assert.equal(Object.keys(held).length, 3, \`three answered turns, \${Object.keys(held).length} rows: each (session, turn) is written once\`);
  fullyCommitted(ctx);
}

export async function check_judge_down_retries(ctx) {
  const {evaluate, TOPIC, GROUP, JUDGE} = assistant(ctx);
  seed(ctx, turn(ctx, 's1', 1, GROUNDED), turn(ctx, 's2', 1, HALF), turn(ctx, 's1', 1, GROUNDED)); // the last one: the producer retried, a duplicate
  const {m} = await worker(ctx);
  const commits = watchCommits(ctx);
  // The judge's first answer is UNAVAILABLE (a deploy, a restart); it is back for every call after that.
  ctx.grpc.fail('Evaluate', ctx.grpc.status.UNAVAILABLE, '', 1, JUDGE);
  try {
    await ctx.drain(m.run());
  } catch (e) {
    if ((e as {code?: number}).code !== ctx.grpc.status.UNAVAILABLE) throw e;
  }
  if (ctx.kafka.lag(GROUP, TOPIC) > 0) {
    // The consumer stopped on the failure instead of retrying in place: acceptable only if nothing was committed for it.
    const restarted = ctx.reload('quality_pipeline');
    await ctx.drain(restarted.run());
  }
  const calls = ctx.grpc.callsTo('Evaluate', JUDGE);
  assert(calls.length >= 4, \`three records (one a duplicate) and one UNAVAILABLE answer mean at least four Evaluate calls — the failed one and a retry — the judge saw \${calls.length}: an UNAVAILABLE judge means ask again later, not skip\`);
  assert(calls.some(c => c.code === ctx.grpc.status.UNAVAILABLE), 'the UNAVAILABLE call never happened');
  for (const {record, queries} of newlyCommitted(ctx, commits)) {
    const t = parse(record);
    assert(rowWritten(queries, t.session_id, t.turn), \`the offset of (\${t.session_id}, \${t.turn}) was committed while no row existed for it: a judge answering UNAVAILABLE must leave the offset uncommitted\`);
  }
  const held = await rows(ctx);
  assert.deepEqual(Object.keys(held).sort(), ['s1|1', 's2|1'], \`two distinct (session, turn) pairs were delivered three times: quality_scores must hold exactly those two rows, it holds \${JSON.stringify(Object.keys(held).sort())}\`);
  assert(sameScores(held['s1|1'], evaluate(GROUNDED.question, GROUNDED.answer, GROUNDED.sources)) && sameScores(held['s2|1'], evaluate(HALF.question, HALF.answer, HALF.sources)), "the retried record must end up with the judge's scores, as if it had never failed");
  fullyCommitted(ctx);
}
`,
  },
  debrief: `The judge runs off the request path because its failure modes are different from the answer's: a Dasher cannot wait for a second model call, but a table can. Putting a Kafka topic between the two turns every answered turn into a record the pipeline can replay, pause and reprocess without touching the API. The consumer's only real decision is the order of its three steps — judge, write, commit — and the upsert is what makes that order safe: a crash after the write and before the commit redelivers the record, the second INSERT hits the primary key and overwrites rather than duplicates, so "at least once" from the broker becomes "exactly one row" in Postgres. UNAVAILABLE is handled by not moving: the offset is the consumer's memory, and leaving it where it is costs lag, not data. DoorDash's post is explicit that the offline judge is only useful once it agrees with people — its five quality dimensions were calibrated against human reviewers before the scores were trusted — and that the same scores gate every prompt change through a regression suite, so a new prompt that invents policies fails a build instead of a Dasher. Production adds a judge version on every row (a rubric change re-scores history), sampling when the topic outgrows the judge's budget, and the human-review loop that keeps the calibration from drifting.`,
};
