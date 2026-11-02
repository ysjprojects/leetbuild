import type {Step} from '@/lib/types';

export const triageStateStep: Step = {
  id: 'state',
  title: 'Redis dedupe and per-queue admission counters',
  concept: 'redis',
  file: 'state',
  focus: ['triage', 'redis'],
  task: `## Task

**Starting point.** The starter hashes the ticket, calls the classifier, checks
\`triage:dedupe:{tenant}:{ticket_hash}\` with \`EXISTS\`, \`HINCRBY\`s the admission counter from the
client, raises a bare 429 past the cap and finally \`SET\`s the dedupe key. It serves the demo and
hides five flaws.

**Failure mode the checks target.** \`EXISTS\`-then-\`SET\` is a check-then-act race, so both copies
of a duplicate webhook classify; a counter with no expiry means a queue that had one bad minute
stays at capacity for good; and claiming after classification means a duplicate is only noticed
once it has been paid for.

- **Dedupe key per \`(tenant, ticket hash)\`**: \`triage:dedupe:{tenant}:{ticket_hash}\`. Two
  concurrent identical tickets classify **once**; the second sees the claim fail.
- **Admission counter per queue per minute**: \`admit:{tenant}:{queue}:{window}\` where \`window\`
  is the UTC minute bucket (\`floor(unix_seconds / 60)\`), capped at **240 tickets per queue per
  minute**.
- The claim (\`SET … NX … EX\`) and the admission increment (\`HINCRBY\`) happen inside **one atomic
  Lua \`EVAL\`**.
- The admission key **expires with its window**: \`EXPIRE\` inside the script on the first write.
- At capacity answer **429** with \`Retry-After\` (seconds, the key's TTL) and \`X-Queue-Remaining\`
  (slots left in this window), and do not call the classifier.
- **Claim before classifying**: admission first, classifier second.`,
  sequence: {
    participants: ['triage-api', 'Redis', 'Classifier'],
    messages: [
      {
        from: 'triage-api',
        to: 'Redis',
        label: 'EVAL admit · KEYS[triage:dedupe:acme:9f1c…, admit:acme:billing:29162240]',
        kind: 'sync',
      },
      {from: 'Redis', to: 'triage-api', label: '{1, 41, 239}', kind: 'reply'},
      {from: 'triage-api', to: 'Classifier', label: 'Classify(text), only after the claim', kind: 'sync'},
      {from: 'Classifier', to: 'triage-api', label: 'ClassifyReply{queue, priority, confidence}', kind: 'reply'},
      {
        from: 'triage-api',
        to: 'triage-api',
        label: '429 {Retry-After, X-Queue-Remaining} when the cap is hit, classifier untouched',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'atomic-claim',
      title: 'Claims and admits in one atomic Lua script',
      detail:
        'The dedupe claim (`SET … NX … EX`) and the queue admission (`HINCRBY`) happen inside one `EVAL`/`NewScript` call. Client-side check-then-act races: two concurrent duplicates both observe an unclaimed ticket.',
      match: {
        python: {all: [/ADMIT_LUA/, /\.eval\(/, /HINCRBY/, /NX/]},
        typescript: {all: [/ADMIT_LUA/, /\.eval\(/, /HINCRBY/, /NX/]},
        go: {all: [/admitScript/, /\.Run\(/, /HINCRBY/, /NX/]},
        scala: {all: [/AdmitLua/, /\.eval\(/, /HINCRBY/, /NX/]},
        cpp: {all: [/kAdmitLua/, /\.eval</, /HINCRBY/, /NX/]},
      },
    },
    {
      id: 'dedupe-nx',
      title: 'Claims the dedupe key with SET NX, not EXISTS',
      detail:
        'The dedupe key is `triage:dedupe:{tenant}:{ticket_hash}` and is claimed with `SET … NX`, so exactly one of two concurrent identical tickets wins. The starter checks it with `EXISTS` and writes it later, which is a race by construction.',
      match: {
        python: {all: [/triage:dedupe:\{tenant\}:\{ticket_hash\}/, /SET/, /NX/], none: [/\bEXISTS\b/]},
        typescript: {all: [/triage:dedupe:\$\{tenant\}:\$\{ticketHash\}/, /SET/, /NX/], none: [/\bEXISTS\b/]},
        go: {all: [/triage:dedupe:%s:%s/, /SET/, /NX/], none: [/\bEXISTS\b/]},
        scala: {all: [/triage:dedupe:\$tenant:\$hash/, /SET/, /NX/], none: [/\bEXISTS\b/]},
        cpp: {all: [/"triage:dedupe:"/, /SET/, /NX/], none: [/\bEXISTS\b/]},
      },
    },
    {
      id: 'window-expiry',
      title: 'Admission window key expires on first write',
      detail:
        'The admission key is `admit:{tenant}:{queue}:{window}` in the 60-second bucket and the script sets `EXPIRE` on the first write and reports the remaining `TTL`. Without it the cap never resets and a queue that had one busy minute stays jammed.',
      match: {
        python: {all: [/EXPIRE/, /TTL/, /admit:\{tenant\}:\{queue\}:\{window\}/, /WINDOW_S\s*=\s*60/]},
        typescript: {all: [/EXPIRE/, /TTL/, /admit:\$\{tenant\}:\$\{queue\}:\$\{window\}/, /WINDOW_S\s*=\s*60/]},
        go: {all: [/EXPIRE/, /TTL/, /admit:%s:%s:%d/, /windowSeconds\s*=\s*60/]},
        scala: {all: [/EXPIRE/, /TTL/, /admit:\$tenant:\$queue:\$window/, /WindowSeconds\s*=\s*60/]},
        cpp: {all: [/EXPIRE/, /TTL/, /"admit:"/, /kWindowSeconds\s*=\s*60/]},
      },
    },
    {
      id: 'admission-429',
      title: 'Answers 429 with Retry-After and slots remaining',
      detail:
        'A queue at its cap answers `429 Too Many Requests` with `Retry-After` in seconds and `X-Queue-Remaining`, both built from the script’s return value, not a hardcoded constant and not a bare 429 with no headers.',
      match: {
        python: {all: [/Retry-After/, /X-Queue-Remaining/, /status_code\s*=\s*429/]},
        typescript: {all: [/Retry-After/, /X-Queue-Remaining/, /\.code\(\s*429\s*\)/]},
        go: {all: [/Retry-After/, /X-Queue-Remaining/, /StatusTooManyRequests/]},
        scala: {all: [/Retry-After/, /X-Queue-Remaining/, /StatusCodes\.TooManyRequests/]},
        cpp: {all: [/Retry-After/, /X-Queue-Remaining/, /status\s*=\s*429/]},
      },
    },
    {
      id: 'claim-before-classify',
      title: 'Claims before it classifies',
      detail:
        'The claim and the admission run before the classifier call, so a rejected or duplicate ticket does not reach the model. The starter classifies first and claims afterwards.',
      match: {
        python: {order: [/admit\(/, /classify\(/]},
        typescript: {order: [/admit\(/, /classify\(/]},
        go: {order: [/admit\(/, /Classify\(/]},
        scala: {order: [/admit\(/, /classify\(/]},
        cpp: {order: [/admit\(/, /classify\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import time

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from client import classify, rule_queue

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 60
QUEUE_CAP = 240
DEDUPE_TTL_S = 24 * 3600


class TriageRequest(BaseModel):
    text: str


@app.post("/v1/tickets/triage")
def triage(body: TriageRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    ticket_hash = hashlib.sha256(body.text.encode("utf-8")).hexdigest()[:32]
    decision = classify(body.text)
    dedupe_key = f"triage:dedupe:{tenant}:{ticket_hash}"
    if r.exists(dedupe_key):
        return decision
    window = int(time.time()) // WINDOW_S
    admit_key = f"admit:{tenant}:{rule_queue(body.text)}:{window}"
    used = r.hincrby(admit_key, "n", 1)
    if used > QUEUE_CAP:
        raise HTTPException(status_code=429, detail="queue at capacity")
    r.set(dedupe_key, "1")
    return decision
`,
      solution: `import hashlib
import time
from typing import NamedTuple

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from client import classify, rule_queue

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 60
QUEUE_CAP = 240
DEDUPE_TTL_S = 24 * 3600

ADMIT_LUA = """
local claimed = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if not claimed then
  return {0, redis.call('TTL', KEYS[1]), 0}
end
local used = redis.call('HINCRBY', KEYS[2], 'n', 1)
if redis.call('TTL', KEYS[2]) < 0 then
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
if used > tonumber(ARGV[4]) then
  redis.call('HINCRBY', KEYS[2], 'n', -1)
  return {0, redis.call('TTL', KEYS[2]), 0}
end
return {1, redis.call('TTL', KEYS[2]), tonumber(ARGV[4]) - used}
"""


class Admission(NamedTuple):
    claimed: bool
    retry_after: int
    remaining: int


class TriageRequest(BaseModel):
    text: str


def admit(tenant: str, ticket_hash: str, queue: str) -> Admission:
    """Claim the ticket once and reserve one admission slot for its queue's current minute."""
    window = int(time.time()) // WINDOW_S
    dedupe_key = f"triage:dedupe:{tenant}:{ticket_hash}"
    admit_key = f"admit:{tenant}:{queue}:{window}"
    claimed, ttl, remaining = r.eval(
        ADMIT_LUA, 2, dedupe_key, admit_key, "1", DEDUPE_TTL_S, WINDOW_S, QUEUE_CAP
    )
    return Admission(claimed == 1, max(int(ttl), 1), int(remaining))


@app.post("/v1/tickets/triage")
def triage(body: TriageRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    ticket_hash = hashlib.sha256(body.text.encode("utf-8")).hexdigest()[:32]
    queue = rule_queue(body.text)
    admission = admit(tenant, ticket_hash, queue)
    if not admission.claimed:
        raise HTTPException(
            status_code=429,
            detail="queue at capacity",
            headers={
                "Retry-After": str(admission.retry_after),
                "X-Queue-Remaining": str(admission.remaining),
            },
        )
    return classify(body.text)
`,
    },
    typescript: {
      starter: `/** Triage state: flawed code that races on the dedupe key. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {classify, ruleQueue} from './client';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const WINDOW_S = 60;
const QUEUE_CAP = 240;
const DEDUPE_TTL_S = 24 * 3600;

app.post('/v1/tickets/triage', async (request, reply) => {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as {text: string};
  const ticketHash = createHash('sha256').update(body.text, 'utf8').digest('hex').slice(0, 32);
  const decision = await classify(body.text);
  const dedupeKey = \`triage:dedupe:\${tenant}:\${ticketHash}\`;
  if ((await r.exists(dedupeKey)) === 1) return reply.code(200).send(decision);
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const admitKey = \`admit:\${tenant}:\${ruleQueue(body.text)}:\${window}\`;
  const used = await r.hincrby(admitKey, 'n', 1);
  if (used > QUEUE_CAP) return reply.code(429).send({error: 'queue at capacity'});
  await r.set(dedupeKey, '1');
  return reply.code(200).send(decision);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Triage state: one atomic claim per ticket and a per-queue minute admission cap. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {classify, ruleQueue} from './client';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const WINDOW_S = 60;
const QUEUE_CAP = 240;
const DEDUPE_TTL_S = 24 * 3600;

const ADMIT_LUA = \`
local claimed = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if not claimed then
  return {0, redis.call('TTL', KEYS[1]), 0}
end
local used = redis.call('HINCRBY', KEYS[2], 'n', 1)
if redis.call('TTL', KEYS[2]) < 0 then
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
if used > tonumber(ARGV[4]) then
  redis.call('HINCRBY', KEYS[2], 'n', -1)
  return {0, redis.call('TTL', KEYS[2]), 0}
end
return {1, redis.call('TTL', KEYS[2]), tonumber(ARGV[4]) - used}
\`;

interface Admission {
  claimed: boolean;
  retry_after: number;
  remaining: number;
}

async function admit(tenant: string, ticketHash: string, queue: string): Promise<Admission> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const dedupeKey = \`triage:dedupe:\${tenant}:\${ticketHash}\`;
  const admitKey = \`admit:\${tenant}:\${queue}:\${window}\`;
  const [claimed, ttl, remaining] = (await r.eval(
    ADMIT_LUA,
    2,
    dedupeKey,
    admitKey,
    '1',
    String(DEDUPE_TTL_S),
    String(WINDOW_S),
    String(QUEUE_CAP),
  )) as [number, number, number];
  return {claimed: claimed === 1, retry_after: Math.max(ttl, 1), remaining};
}

app.post('/v1/tickets/triage', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as {text: string};
  const ticketHash = createHash('sha256').update(body.text, 'utf8').digest('hex').slice(0, 32);
  const admission = await admit(tenant, ticketHash, ruleQueue(body.text));
  if (!admission.claimed)
    return reply
      .code(429)
      .header('Retry-After', String(admission.retry_after))
      .header('X-Queue-Remaining', String(admission.remaining))
      .send({error: 'queue at capacity'});
  return reply.code(200).send(await classify(body.text));
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"triage/client"
)

const (
	windowSeconds = 60
	queueCap      = 240
	dedupeTTL     = 24 * 3600
)

var rdb *redis.Client

func triage(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body struct {
		Text string \`json:"text"\`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	sum := sha256.Sum256([]byte(body.Text))
	ticketHash := hex.EncodeToString(sum[:])[:32]
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	decision, err := client.Classify(r.Context(), body.Text)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	dedupeKey := fmt.Sprintf("triage:dedupe:%s:%s", tenant, ticketHash)
	if seen, _ := rdb.Exists(r.Context(), dedupeKey).Result(); seen == 1 {
		writeJSON(rw, http.StatusOK, decision)
		return
	}
	window := time.Now().Unix() / windowSeconds
	admitKey := fmt.Sprintf("admit:%s:%s:%d", tenant, client.RuleQueue(body.Text), window)
	used, _ := rdb.HIncrBy(r.Context(), admitKey, "n", 1).Result()
	if used > queueCap {
		writeJSON(rw, http.StatusTooManyRequests, map[string]string{"error": "queue at capacity"})
		return
	}
	rdb.Set(r.Context(), dedupeKey, "1", dedupeTTL)
	writeJSON(rw, http.StatusOK, decision)
}

func main() {}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"triage/client"
)

const (
	windowSeconds = 60
	queueCap      = 240
	dedupeTTL     = 24 * 3600
)

var rdb *redis.Client

var admitScript = redis.NewScript(\`
local claimed = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if not claimed then
  return {0, redis.call('TTL', KEYS[1]), 0}
end
local used = redis.call('HINCRBY', KEYS[2], 'n', 1)
if redis.call('TTL', KEYS[2]) < 0 then
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
if used > tonumber(ARGV[4]) then
  redis.call('HINCRBY', KEYS[2], 'n', -1)
  return {0, redis.call('TTL', KEYS[2]), 0}
end
return {1, redis.call('TTL', KEYS[2]), tonumber(ARGV[4]) - used}
\`)

// Admission is one ticket's verdict from the dedupe and admission script.
type Admission struct {
	Claimed    bool
	RetryAfter int64
	Remaining  int64
}

func admit(ctx context.Context, tenant, ticketHash, queue string) (Admission, error) {
	window := time.Now().Unix() / windowSeconds
	dedupeKey := fmt.Sprintf("triage:dedupe:%s:%s", tenant, ticketHash)
	admitKey := fmt.Sprintf("admit:%s:%s:%d", tenant, queue, window)
	values, err := admitScript.Run(
		ctx,
		rdb,
		[]string{dedupeKey, admitKey},
		"1",
		strconv.Itoa(dedupeTTL),
		strconv.Itoa(windowSeconds),
		strconv.Itoa(queueCap),
	).Int64Slice()
	if err != nil {
		return Admission{}, err
	}
	return Admission{Claimed: values[0] == 1, RetryAfter: max(values[1], 1), Remaining: values[2]}, nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func triage(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body struct {
		Text string \`json:"text"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	sum := sha256.Sum256([]byte(body.Text))
	ticketHash := hex.EncodeToString(sum[:])[:32]
	admission, err := admit(r.Context(), tenant, ticketHash, client.RuleQueue(body.Text))
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if !admission.Claimed {
		rw.Header().Set("Retry-After", strconv.FormatInt(admission.RetryAfter, 10))
		rw.Header().Set("X-Queue-Remaining", strconv.FormatInt(admission.Remaining, 10))
		writeJSON(rw, http.StatusTooManyRequests, map[string]string{"error": "queue at capacity"})
		return
	}
	decision, err := client.Classify(r.Context(), body.Text)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, decision)
}

func main() {}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest
import java.time.Instant
import java.util.logging.Logger

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TriageRequest(text: String)
final case class Decision(ticket_id: String, queue: String, priority: String, confidence: Double)

object TriageState {
  implicit val system: ActorSystem = ActorSystem("ticket-triage")
  implicit val requestFormat: RootJsonFormat[TriageRequest] = jsonFormat1(TriageRequest)
  val log = Logger.getLogger("triage")

  val WindowSeconds = 60L
  val QueueCap = 240L
  val DedupeTtlSeconds = 24L * 3600

  val jedis = new Jedis("redis", 6379)

  def ticketHash(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8")).take(16).map("%02x".format(_)).mkString

  val route: Route =
    path("v1" / "tickets" / "triage") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[TriageRequest]) { body =>
            // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
            val hash = ticketHash(body.text)
            val decision = Classifier.classify(body.text)
            val dedupeKey = s"triage:dedupe:$tenant:$hash"
            if (jedis.exists(dedupeKey)) {
              complete(StatusCodes.OK, decision)
            } else {
              val window = Instant.now().getEpochSecond / WindowSeconds
              val admitKey = s"admit:$tenant:\${Classifier.ruleQueue(body.text)}:$window"
              val used = jedis.hincrBy(admitKey, "n", 1L)
              if (used > QueueCap) {
                complete(StatusCodes.TooManyRequests, """{"error":"queue at capacity"}""")
              } else {
                jedis.set(dedupeKey, "1")
                complete(StatusCodes.OK, decision)
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.security.MessageDigest
import java.time.Instant
import java.util.logging.Logger

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TriageRequest(text: String)
final case class Decision(ticket_id: String, queue: String, priority: String, confidence: Double)
final case class Admission(claimed: Boolean, retryAfter: Long, remaining: Long)

object TriageState {
  implicit val system: ActorSystem = ActorSystem("ticket-triage")
  implicit val requestFormat: RootJsonFormat[TriageRequest] = jsonFormat1(TriageRequest)
  val log = Logger.getLogger("triage")

  val WindowSeconds = 60L
  val QueueCap = 240L
  val DedupeTtlSeconds = 24L * 3600

  val jedis = new Jedis("redis", 6379)

  val AdmitLua =
    """
      |local claimed = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
      |if not claimed then
      |  return {0, redis.call('TTL', KEYS[1]), 0}
      |end
      |local used = redis.call('HINCRBY', KEYS[2], 'n', 1)
      |if redis.call('TTL', KEYS[2]) < 0 then
      |  redis.call('EXPIRE', KEYS[2], ARGV[3])
      |end
      |if used > tonumber(ARGV[4]) then
      |  redis.call('HINCRBY', KEYS[2], 'n', -1)
      |  return {0, redis.call('TTL', KEYS[2]), 0}
      |end
      |return {1, redis.call('TTL', KEYS[2]), tonumber(ARGV[4]) - used}
      |""".stripMargin

  def ticketHash(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8")).take(16).map("%02x".format(_)).mkString

  def admit(tenant: String, hash: String, queue: String): Admission = {
    val window = Instant.now().getEpochSecond / WindowSeconds
    val dedupeKey = s"triage:dedupe:$tenant:$hash"
    val admitKey = s"admit:$tenant:$queue:$window"
    val result = jedis
      .eval(
        AdmitLua,
        2,
        dedupeKey,
        admitKey,
        "1",
        DedupeTtlSeconds.toString,
        WindowSeconds.toString,
        QueueCap.toString
      )
      .asInstanceOf[java.util.List[Long]]
    Admission(result.get(0) == 1L, math.max(result.get(1), 1L), result.get(2))
  }

  val route: Route =
    path("v1" / "tickets" / "triage") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[TriageRequest]) { body =>
            val hash = ticketHash(body.text)
            val admission = admit(tenant, hash, Classifier.ruleQueue(body.text))
            if (!admission.claimed) {
              complete(
                HttpResponse(
                  StatusCodes.TooManyRequests,
                  headers = List(
                    RawHeader("Retry-After", admission.retryAfter.toString),
                    RawHeader("X-Queue-Remaining", admission.remaining.toString)
                  ),
                  entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"queue at capacity"}""")
                )
              )
            } else {
              complete(StatusCodes.OK, Classifier.classify(body.text))
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <chrono>
#include <iostream>
#include <string>

#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include "client.hpp"

using json = nlohmann::json;

constexpr long long kWindowSeconds = 60;
constexpr long long kQueueCap = 240;
constexpr long long kDedupeTtlSeconds = 24 * 3600;

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/tickets/triage", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto text = body.value("text", std::string());
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    const std::string ticketHash = hashTicket(text);
    const auto decision = classify(text);
    const std::string dedupeKey = "triage:dedupe:" + tenant + ":" + ticketHash;
    if (redis.exists(dedupeKey) == 1) {
      res.status = 200;
      res.set_content(decision.dump(), "application/json");
      return;
    }
    const auto window = std::chrono::duration_cast<std::chrono::seconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                            .count() /
                        kWindowSeconds;
    const std::string admitKey =
        "admit:" + tenant + ":" + ruleQueue(text) + ":" + std::to_string(window);
    const long long used = redis.hincrby(admitKey, "n", 1);
    if (used > kQueueCap) {
      res.status = 429;
      res.set_content(R"({"error":"queue at capacity"})", "application/json");
      return;
    }
    redis.set(dedupeKey, "1");
    res.status = 200;
    res.set_content(decision.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <algorithm>
#include <chrono>
#include <cstdio>
#include <string>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include "client.hpp"

using json = nlohmann::json;

constexpr long long kWindowSeconds = 60;
constexpr long long kQueueCap = 240;
constexpr long long kDedupeTtlSeconds = 24 * 3600;

static const char* kAdmitLua = R"(
local claimed = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if not claimed then
  return '0:' .. tostring(redis.call('TTL', KEYS[1])) .. ':0'
end
local used = redis.call('HINCRBY', KEYS[2], 'n', 1)
if redis.call('TTL', KEYS[2]) < 0 then
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
if used > tonumber(ARGV[4]) then
  redis.call('HINCRBY', KEYS[2], 'n', -1)
  return '0:' .. tostring(redis.call('TTL', KEYS[2])) .. ':0'
end
return '1:' .. tostring(redis.call('TTL', KEYS[2])) .. ':' .. tostring(tonumber(ARGV[4]) - used)
)";

struct Admission {
  bool claimed;
  long long retry_after;
  long long remaining;
};

Admission admit(sw::redis::Redis& redis, const std::string& tenant, const std::string& ticketHash,
                const std::string& queue) {
  const auto window = std::chrono::duration_cast<std::chrono::seconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count() /
                      kWindowSeconds;
  const std::string dedupeKey = "triage:dedupe:" + tenant + ":" + ticketHash;
  const std::string admitKey = "admit:" + tenant + ":" + queue + ":" + std::to_string(window);
  const auto raw = redis.eval<std::string>(
      kAdmitLua, {dedupeKey, admitKey},
      {std::to_string(kDedupeTtlSeconds), std::to_string(kWindowSeconds), std::to_string(kQueueCap)});
  int claimed = 0;
  long long ttl = 0;
  long long remaining = 0;
  std::sscanf(raw.c_str(), "%d:%lld:%lld", &claimed, &ttl, &remaining);
  return {claimed == 1, std::max(ttl, 1LL), remaining};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/tickets/triage", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto text = body.value("text", std::string());
    const std::string ticketHash = hashTicket(text);
    const auto admission = admit(redis, tenant, ticketHash, ruleQueue(text));
    if (!admission.claimed) {
      res.status = 429;
      res.set_header("Retry-After", std::to_string(admission.retry_after));
      res.set_header("X-Queue-Remaining", std::to_string(admission.remaining));
      res.set_content(R"({"error":"queue at capacity"})", "application/json");
      return;
    }
    const auto decision = classify(text);
    res.status = 200;
    res.set_content(decision.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Fire the same ticket twice at once: both requests return a classification and the model is billed twice. A queue that hit 240 in one minute keeps answering 429 an hour later.',
    'The handler calls `classify` before it looks at Redis, checks the dedupe key with `EXISTS` and writes it last, and `HINCRBY`s a key nothing ever expires. Every step is a separate round trip.',
    'Put `SET dedupe NX EX`, `HINCRBY admit n 1`, `EXPIRE` on first write and `TTL` in one `ADMIT_LUA` script, run it before `classify`, and build `Retry-After`/`X-Queue-Remaining` from its reply.',
  ],
  debrief: `The fix is one script because the two keys only stay consistent if they move together: \`SET NX EX\` decides the winner, \`HINCRBY\` reserves the slot, and \`EXPIRE\` on the first write turns the counter into a window instead of a monotone lock. Running it before the classifier means a duplicate or a rejected ticket costs one Redis round trip and no model call, and returning the TTL and the remaining slots lets the caller back off for the right amount of time instead of guessing. Production services layer a per-tenant admission budget alongside the per-queue one, and run a sweep that reconciles Redis counters against the routing records when the two drift apart.`,
};
