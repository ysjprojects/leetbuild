import type {Step} from '@/lib/types';

export const sqlStateStep: Step = {
  id: 'state',
  title: 'Redis schema cache and per-user generation budget',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the generate handler resolves a
schema summary, asks the model, and returns SQL. It compiles, it serves the demo, and it hides three
production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/queries/generate\` with body \`{"schema_handle": "…", "question": "…"}\`.

The schema summary — tables, columns and types — is built from the schema-metadata store in \`db\`,
so resolving it on every request is an avoidable round trip. Cache it in Redis:

- The summary lives under \`schema:{tenant}:{handle}\`, built by \`schema_key(tenant, handle)\`, with a
  **900-second** TTL (\`SCHEMA_TTL_S = 900\`). The handle identifies which schema of the tenant is
  meant; keying by tenant alone makes two schemas of one tenant overwrite each other.
- A refresh — a summary just rebuilt from \`db\` — replaces the whole entry in **one atomic \`SET\`**
  carrying the expiry: \`redis.set(key, data, ex=SCHEMA_TTL_S)\`. Writing fields one at a time with
  \`HSET\` leaves a window where a concurrent reader — and the model — sees a summary that is missing
  half its tables, so the generated SQL references columns that no longer exist.
- A miss reads from \`db\`, stores the summary under the same key with the same TTL, and only then
  proceeds to the model.

The model is expensive, so every user gets a budget:

- \`BUDGET_LIMIT = 100\` generations per user per **hour**. The key is
  \`budget:{user}:{floor(unix_seconds / 3600)}\` with \`BUDGET_WINDOW_S = 3600\`.
- The counter is incremented **atomically before** the model is asked anything: \`incr\` first, compare
  against 100, and only a request that fits the budget may call \`models.Generate\`.
- On the first write the key gets \`expire(key, BUDGET_WINDOW_S)\`, so the counter dies with its
  window. A key without a TTL never resets, so one busy hour locks a user out forever.
- The 101st request is refused with **429** and a \`Retry-After\` header — seconds left in the window —
  and never reaches the model.

**Failure mode the checks target.** The draft writes schema fields with \`HSET\` as it learns them, so
a half-refreshed summary drops tables and the model writes SQL against columns that no longer exist;
its budget counter has no expiry, so a user who had one busy hour is refused forever; and it charges
after the model call, so every rejected request has already been paid for.`,
  sequence: {
    participants: ['SQL Copilot', 'Redis', 'Model'],
    messages: [
      {from: 'SQL Copilot', to: 'Redis', label: 'get(schema_key(tenant, handle))', kind: 'sync'},
      {from: 'Redis', to: 'SQL Copilot', label: 'summary / miss', kind: 'reply'},
      {from: 'SQL Copilot', to: 'Redis', label: 'set(schema_key, summary, EX 900) after a rebuild', kind: 'async'},
      {from: 'SQL Copilot', to: 'Redis', label: 'incr(budget:{user}:{window}) then expire 3600', kind: 'sync'},
      {from: 'Redis', to: 'SQL Copilot', label: '{count, ttl}', kind: 'reply'},
      {
        from: 'SQL Copilot',
        to: 'SQL Copilot',
        label: '429 Retry-After when count > 100, model untouched',
        kind: 'sync',
      },
      {from: 'SQL Copilot', to: 'Model', label: 'Generate(question, summary) only after the reservation', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'schema-cache',
      title: 'Caches the schema summary per (tenant, handle) for 15 minutes',
      detail:
        'The summary lives under `schema:{tenant}:{handle}` with a 900-second TTL (`SCHEMA_TTL_S = 900`) built by `schema_key()`. The draft keys the entry by tenant alone, so two schemas of one tenant overwrite each other.',
      match: {
        python: {all: [/def schema_key\(/, /SCHEMA_TTL_S\s*=\s*900/]},
        typescript: {all: [/function schemaKey\(/, /SCHEMA_TTL_S\s*=\s*900/]},
        go: {all: [/func schemaKey\(/, /schemaTTLSeconds\s*=\s*900/]},
        scala: {all: [/def schemaKey\(/, /SchemaTtlSeconds\s*=\s*900/]},
        cpp: {all: [/schemaKey\(/, /kSchemaTtlSeconds\s*=\s*900/]},
      },
    },
    {
      id: 'atomic-refresh',
      title: 'Refreshes the cached schema with one atomic replacement',
      detail:
        'A learned summary replaces the entry in a single `SET` carrying the 15-minute expiry (`redis.set(key, data, ex=SCHEMA_TTL_S)`) and never with `HSET`. Writing fields as they are discovered exposes a half-refreshed schema — missing tables — to the model.',
      match: {
        python: {all: [/\.set\(\s*key\s*,\s*data/, /ex\s*=\s*SCHEMA_TTL_S/], none: [/\.hset\(/]},
        typescript: {all: [/\.set\(\s*key\s*,\s*data/, /'EX'/, /SCHEMA_TTL_S/], none: [/\.hset\(/]},
        go: {all: [/\.Set\(\s*ctx\s*,\s*key\s*,\s*data/, /schemaTTLSeconds/], none: [/\.HSet\(/]},
        scala: {all: [/\.setex\(\s*key\s*,\s*SchemaTtlSeconds\s*,\s*data\s*\)/], none: [/\.hset\(/]},
        cpp: {all: [/\.set\(\s*key\s*,\s*data/, /kSchemaTtlSeconds/], none: [/\.hset\(/]},
      },
    },
    {
      id: 'budget-window',
      title: 'The generation counter dies with its window',
      detail:
        'The budget key is 100 generations per **hour**: `BUDGET_WINDOW_S = 3600` and an `EXPIRE` on the key at first write. The draft has no expiry, so a user who had one busy hour is refused forever.',
      match: {
        python: {all: [/BUDGET_WINDOW_S\s*=\s*3600/, /expire\(/]},
        typescript: {all: [/BUDGET_WINDOW_S\s*=\s*3600/, /\.expire\(/]},
        go: {all: [/budgetWindowSeconds\s*=\s*3600/, /\.Expire\(/]},
        scala: {all: [/BudgetWindowSeconds\s*=\s*3600/, /\.expire\(/]},
        cpp: {all: [/kBudgetWindowSeconds\s*=\s*3600/, /\.expire\(/]},
      },
    },
    {
      id: 'budget-refusal',
      title: 'The 101st generation is refused with Retry-After',
      detail:
        '`BUDGET_LIMIT = 100` per user per hour; the request over the limit gets **429** with a `Retry-After` header and never reaches the model. The draft logs the overage and calls the model anyway.',
      match: {
        python: {all: [/BUDGET_LIMIT\s*=\s*100/, /"Retry-After"/, /status_code\s*=\s*429/]},
        typescript: {all: [/BUDGET_LIMIT\s*=\s*100/, /'Retry-After'/, /code\(\s*429\s*\)/]},
        go: {all: [/budgetLimit\s*=\s*100/, /"Retry-After"/, /StatusTooManyRequests/]},
        scala: {all: [/BudgetLimit\s*=\s*100/, /"Retry-After"/, /StatusCodes\.TooManyRequests/]},
        cpp: {all: [/kBudgetLimit\s*=\s*100/, /"Retry-After"/, /\b429\b/]},
      },
    },
    {
      id: 'budget-first',
      title: 'Reserves the budget before the model is called',
      detail:
        'The counter is incremented (`incr`) before `Generate` is called, so a rejected request is never paid for. The draft calls the model first and writes the counter afterwards.',
      match: {
        python: {order: [/\.incr\(/, /\.Generate\(/]},
        typescript: {order: [/\.incr\(/, /\.Generate\(/]},
        go: {order: [/\.Incr\(/, /\.Generate\(/]},
        scala: {order: [/\.incr\(/, /\.generate\(/]},
        cpp: {order: [/\.incr\(/, /\.Generate\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class GenerateRequest(BaseModel):
    schema_handle: str
    question: str


class ModelClient:
    def Generate(self, question: str, summary: str) -> str:
        return f"SELECT * FROM -- {question} against {summary}"


models = ModelClient()


def cache_key(tenant: str) -> str:
    return f"schemas:{tenant}"


def get_schema(tenant: str, handle: str) -> str:
    # TODO: key the summary by (tenant, handle) and refresh it with one atomic SET carrying a
    # 900-second TTL; the draft HSETs fields as they are learned, so a half-refreshed summary
    # loses tables. The budget below has no expiry and is charged after the model call.
    key = cache_key(tenant)
    cached = r.hgetall(key)
    if cached:
        return cached.get("summary", "")
    summary = load_schema(tenant, handle)
    r.hset(key, mapping={"summary": summary})
    return summary


def load_schema(tenant: str, handle: str) -> str:
    return f"CREATE TABLE {handle}_events (...);"


@app.post("/v1/queries/generate")
def generate(body: GenerateRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    summary = get_schema(tenant, body.schema_handle)
    sql = models.Generate(body.question, summary)
    budget_key = f"budget:{tenant}"
    used = int(r.get(budget_key) or 0)
    if used >= 100:
        print("over budget, calling the model anyway")
    r.set(budget_key, used + 1)
    return {"sql": sql, "used": used + 1}
`,
      solution: `import time

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

SCHEMA_TTL_S = 900
BUDGET_WINDOW_S = 3600
BUDGET_LIMIT = 100


class GenerateRequest(BaseModel):
    schema_handle: str
    question: str


class ModelClient:
    def Generate(self, question: str, summary: str) -> str:
        return f"SELECT * FROM -- {question} against {summary}"


models = ModelClient()


def schema_key(tenant: str, handle: str) -> str:
    return f"schema:{tenant}:{handle}"


def get_schema(tenant: str, handle: str) -> str:
    key = schema_key(tenant, handle)
    cached = r.get(key)
    if cached:
        return cached
    data = load_schema(tenant, handle)
    r.set(key, data, ex=SCHEMA_TTL_S)
    return data


def load_schema(tenant: str, handle: str) -> str:
    return f"CREATE TABLE {handle}_events (...);"


def reserve_budget(tenant: str, user: str) -> int:
    window = int(time.time()) // BUDGET_WINDOW_S
    budget_key = f"budget:{user}:{window}"
    used = r.incr(budget_key)
    if used == 1:
        r.expire(budget_key, BUDGET_WINDOW_S)
    ttl = r.ttl(budget_key)
    return used, max(ttl, 0)


@app.post("/v1/queries/generate")
def generate(body: GenerateRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    summary = get_schema(tenant, body.schema_handle)
    used, ttl = reserve_budget(tenant, tenant)
    if used > BUDGET_LIMIT:
        raise HTTPException(
            status_code=429,
            headers={"Retry-After": str(BUDGET_WINDOW_S - ttl)},
        )
    sql = models.Generate(body.question, summary)
    return {"sql": sql, "used": used}
`,
    },
    typescript: {
      starter: `/** POST /v1/queries/generate: a model-generated draft with no TTL and a charge-after-call budget. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const redis = new Redis('redis://redis:6379');

interface GenerateBody {
  schema_handle: string;
  question: string;
}

const models = {
  async Generate(question: string, summary: string): Promise<string> {
    return \`SELECT * FROM -- \${question} against \${summary}\`;
  },
};

function cacheKey(tenant: string): string {
  return \`schemas:\${tenant}\`;
}

async function getSchema(tenant: string, handle: string): Promise<string> {
  // TODO: key the summary by (tenant, handle) and refresh it with one atomic SET carrying a
  // 900-second TTL; the draft HSETs fields as they are learned, so a half-refreshed summary
  // loses tables. The budget below has no expiry and is charged after the model call.
  const key = cacheKey(tenant);
  const cached = await redis.hgetall(key);
  if (Object.keys(cached).length > 0) return cached.summary ?? '';
  const summary = await loadSchema(tenant, handle);
  await redis.hset(key, {summary});
  return summary;
}

async function loadSchema(tenant: string, handle: string): Promise<string> {
  return \`CREATE TABLE \${handle}_events (...);\`;
}

app.post('/v1/queries/generate', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as GenerateBody;
  const summary = await getSchema(tenant, body.schema_handle);
  const sql = await models.Generate(body.question, summary);
  const budgetKey = \`budget:\${tenant}\`;
  const used = Number((await redis.get(budgetKey)) ?? 0);
  if (used >= 100) request.log.warn('over budget, calling the model anyway');
  await redis.set(budgetKey, used + 1);
  return reply.code(200).send({sql, used: used + 1});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/queries/generate: cache the schema for 15 minutes, reserve the hour budget first. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const redis = new Redis('redis://redis:6379');

const SCHEMA_TTL_S = 900;
const BUDGET_WINDOW_S = 3600;
const BUDGET_LIMIT = 100;

interface GenerateBody {
  schema_handle: string;
  question: string;
}

const models = {
  async Generate(question: string, summary: string): Promise<string> {
    return \`SELECT * FROM -- \${question} against \${summary}\`;
  },
};

function schemaKey(tenant: string, handle: string): string {
  return \`schema:\${tenant}:\${handle}\`;
}

async function getSchema(tenant: string, handle: string): Promise<string> {
  const key = schemaKey(tenant, handle);
  const cached = await redis.get(key);
  if (cached) return cached;
  const data = await loadSchema(tenant, handle);
  await redis.set(key, data, 'EX', SCHEMA_TTL_S);
  return data;
}

async function loadSchema(tenant: string, handle: string): Promise<string> {
  return \`CREATE TABLE \${handle}_events (...);\`;
}

async function reserveBudget(user: string): Promise<[number, number]> {
  const window = Math.floor(Date.now() / 1000 / BUDGET_WINDOW_S);
  const budgetKey = \`budget:\${user}:\${window}\`;
  const used = await redis.incr(budgetKey);
  if (used === 1) await redis.expire(budgetKey, BUDGET_WINDOW_S);
  const ttl = await redis.ttl(budgetKey);
  return [used, Math.max(ttl, 0)];
}

app.post('/v1/queries/generate', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as GenerateBody;
  const summary = await getSchema(tenant, body.schema_handle);
  const [used, ttl] = await reserveBudget(tenant);
  if (used > BUDGET_LIMIT) {
    return reply
      .code(429)
      .header('Retry-After', String(BUDGET_WINDOW_S - ttl))
      .send({error: 'generation budget exhausted'});
  }
  const sql = await models.Generate(body.question, summary);
  return reply.code(200).send({sql, used});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `// POST /v1/queries/generate: a model-generated draft with no TTL and a charge-after-call budget.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var ctx = context.Background()

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type generateRequest struct {
	SchemaHandle string \`json:"schema_handle"\`
	Question     string \`json:"question"\`
}

type modelClient struct{}

func (modelClient) Generate(ctx context.Context, question, summary string) (string, error) {
	return "SELECT * FROM -- " + question + " against " + summary, nil
}

var models = modelClient{}

func cacheKey(tenant string) string {
	return "schemas:" + tenant
}

func getSchema(ctx context.Context, tenant, handle string) (string, error) {
	// TODO: key the summary by (tenant, handle) and refresh it with one atomic SET carrying a
	// 900-second TTL; the draft HSETs fields as they are learned, so a half-refreshed summary
	// loses tables. The budget below has no expiry and is charged after the model call.
	key := cacheKey(tenant)
	fields, err := rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return "", err
	}
	if len(fields) > 0 {
		return fields["summary"], nil
	}
	summary := loadSchema(tenant, handle)
	if err := rdb.HSet(ctx, key, "summary", summary).Err(); err != nil {
		return "", err
	}
	return summary, nil
}

func loadSchema(tenant, handle string) string {
	return "CREATE TABLE " + handle + "_events (...);"
}

func generateHandler(rw http.ResponseWriter, req *http.Request) {
	tenant := req.Header.Get("X-Tenant-Id")
	var body generateRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(rw, "bad request", http.StatusBadRequest)
		return
	}
	summary, err := getSchema(ctx, tenant, body.SchemaHandle)
	if err != nil {
		http.Error(rw, "schema lookup failed", http.StatusInternalServerError)
		return
	}
	sql, err := models.Generate(ctx, body.Question, summary)
	if err != nil {
		http.Error(rw, "generation failed", http.StatusInternalServerError)
		return
	}
	budgetKey := "budget:" + tenant
	used, _ := rdb.Get(ctx, budgetKey).Int()
	if used >= 100 {
		log.Printf("over budget, calling the model anyway")
	}
	rdb.Set(ctx, budgetKey, used+1, 0)
	writeJSON(rw, http.StatusOK, map[string]any{"sql": sql, "used": used + 1})
}

func writeJSON(rw http.ResponseWriter, status int, payload any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(payload)
}

func main() {
	http.HandleFunc("POST /v1/queries/generate", generateHandler)
	log.Fatal(http.ListenAndServe(":8443", nil))
}
`,
      solution: `// POST /v1/queries/generate: cache the schema for 15 minutes, reserve the hour budget first.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

var ctx = context.Background()

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	schemaTTLSeconds   = 900
	budgetWindowSeconds = 3600
	budgetLimit        = 100
)

type generateRequest struct {
	SchemaHandle string \`json:"schema_handle"\`
	Question     string \`json:"question"\`
}

type modelClient struct{}

func (modelClient) Generate(ctx context.Context, question, summary string) (string, error) {
	return "SELECT * FROM -- " + question + " against " + summary, nil
}

var models = modelClient{}

func schemaKey(tenant, handle string) string {
	return "schema:" + tenant + ":" + handle
}

func getSchema(ctx context.Context, tenant, handle string) (string, error) {
	key := schemaKey(tenant, handle)
	if cached, err := rdb.Get(ctx, key).Result(); err == nil {
		return cached, nil
	}
	data := loadSchema(tenant, handle)
	if err := rdb.Set(ctx, key, data, time.Duration(schemaTTLSeconds)*time.Second).Err(); err != nil {
		return "", err
	}
	return data, nil
}

func loadSchema(tenant, handle string) string {
	return "CREATE TABLE " + handle + "_events (...);"
}

func reserveBudget(ctx context.Context, user string) (int64, time.Duration, error) {
	window := time.Now().Unix() / budgetWindowSeconds
	budgetKey := "budget:" + user + ":" + strconv.FormatInt(window, 10)
	used, err := rdb.Incr(ctx, budgetKey).Result()
	if err != nil {
		return 0, 0, err
	}
	if used == 1 {
		if err := rdb.Expire(ctx, budgetKey, time.Duration(budgetWindowSeconds)*time.Second).Err(); err != nil {
			return 0, 0, err
		}
	}
	ttl, err := rdb.TTL(ctx, budgetKey).Result()
	if err != nil {
		return 0, 0, err
	}
	return used, ttl, nil
}

func generateHandler(rw http.ResponseWriter, req *http.Request) {
	tenant := req.Header.Get("X-Tenant-Id")
	var body generateRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(rw, "bad request", http.StatusBadRequest)
		return
	}
	summary, err := getSchema(ctx, tenant, body.SchemaHandle)
	if err != nil {
		http.Error(rw, "schema lookup failed", http.StatusInternalServerError)
		return
	}
	used, ttl, err := reserveBudget(ctx, tenant)
	if err != nil {
		http.Error(rw, "budget lookup failed", http.StatusInternalServerError)
		return
	}
	if used > budgetLimit {
		rw.Header().Set("Retry-After", strconv.FormatInt(int64(ttl/time.Second), 10))
		writeJSON(rw, http.StatusTooManyRequests, map[string]any{"error": "generation budget exhausted"})
		return
	}
	sql, err := models.Generate(ctx, body.Question, summary)
	if err != nil {
		http.Error(rw, "generation failed", http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"sql": sql, "used": used})
}

func writeJSON(rw http.ResponseWriter, status int, payload any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(payload)
}

func main() {
	http.HandleFunc("POST /v1/queries/generate", generateHandler)
	log.Fatal(http.ListenAndServe(":8443", nil))
}
`,
    },
    scala: {
      starter: `// POST /v1/queries/generate: a model-generated draft with no TTL and a charge-after-call budget.
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import redis.clients.jedis.Jedis
import spray.json._

object SqlCopilot {
  val jedis = new Jedis("redis", 6379)

  object models {
    def generate(question: String, summary: String): String =
      s"SELECT * FROM -- $question against $summary"
  }

  def cacheKey(tenant: String): String = s"schemas:$tenant"

  def getSchema(tenant: String, handle: String): String = {
    // TODO: key the summary by (tenant, handle) and refresh it with one atomic SET carrying a
    // 900-second TTL; the draft HSETs fields as they are learned, so a half-refreshed summary
    // loses tables. The budget below has no expiry and is charged after the model call.
    val key = cacheKey(tenant)
    val cached = jedis.hgetAll(key)
    if (!cached.isEmpty) cached.get("summary").getOrElse("")
    else {
      val summary = loadSchema(tenant, handle)
      jedis.hset(key, "summary", summary)
      summary
    }
  }

  def loadSchema(tenant: String, handle: String): String = s"CREATE TABLE \${handle}_events (...);"

  val route =
    path("v1" / "queries" / "generate") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject
            val handle = body.fields("schema_handle").convertTo[String]
            val question = body.fields("question").convertTo[String]
            val summary = getSchema(tenant, handle)
            val sql = models.generate(question, summary)
            val budgetKey = s"budget:$tenant"
            val used = jedis.get(budgetKey).toInt
            if (used >= 100) println("over budget, calling the model anyway")
            jedis.set(budgetKey, (used + 1).toString)
            complete(StatusCodes.OK, HttpEntity(ContentTypes.\`application/json\`, s"""{"sql": "$sql"}"""))
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem[Nothing] = ActorSystem(Behaviors.empty, "sql-copilot")
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `// POST /v1/queries/generate: cache the schema for 15 minutes, reserve the hour budget first.
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import redis.clients.jedis.Jedis
import spray.json._

object SqlCopilot {
  val jedis = new Jedis("redis", 6379)

  val SchemaTtlSeconds = 900
  val BudgetWindowSeconds = 3600
  val BudgetLimit = 100

  object models {
    def generate(question: String, summary: String): String =
      s"SELECT * FROM -- $question against $summary"
  }

  def schemaKey(tenant: String, handle: String): String = s"schema:$tenant:$handle"

  def getSchema(tenant: String, handle: String): String = {
    val key = schemaKey(tenant, handle)
    val cached = jedis.get(key)
    if (cached != null) cached
    else {
      val data = loadSchema(tenant, handle)
      jedis.setex(key, SchemaTtlSeconds, data)
      data
    }
  }

  def loadSchema(tenant: String, handle: String): String = s"CREATE TABLE \${handle}_events (...);"

  def reserveBudget(user: String): (Long, Long) = {
    val window = System.currentTimeMillis() / 1000 / BudgetWindowSeconds
    val budgetKey = s"budget:$user:$window"
    val used = jedis.incr(budgetKey)
    if (used == 1) jedis.expire(budgetKey, BudgetWindowSeconds)
    val ttl = jedis.ttl(budgetKey)
    (used, math.max(ttl, 0))
  }

  val route =
    path("v1" / "queries" / "generate") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject
            val handle = body.fields("schema_handle").convertTo[String]
            val question = body.fields("question").convertTo[String]
            val summary = getSchema(tenant, handle)
            val (used, ttl) = reserveBudget(tenant)
            if (used > BudgetLimit) {
              respondWithHeaders(RawHeader("Retry-After", (BudgetWindowSeconds - ttl).toString)) {
                complete(StatusCodes.TooManyRequests, HttpEntity(ContentTypes.\`application/json\`, """{"error": "generation budget exhausted"}"""))
              }
            } else {
              val sql = models.generate(question, summary)
              complete(StatusCodes.OK, HttpEntity(ContentTypes.\`application/json\`, s"""{"sql": "$sql"}"""))
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem[Nothing] = ActorSystem(Behaviors.empty, "sql-copilot")
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `// POST /v1/queries/generate: a model-generated draft with no TTL and a charge-after-call budget.
#include <chrono>
#include <iostream>
#include <string>

#include <httplib.h>
#include <sw/redis++/redis++.h>

using namespace sw::redis;

static const char *kSchemaTtlSeconds = "900";

std::string cacheKey(const std::string &tenant) { return "schemas:" + tenant; }

std::string loadSchema(const std::string &tenant, const std::string &handle) {
  return "CREATE TABLE " + handle + "_events (...);";
}

struct ModelClient {
  std::string Generate(const std::string &question, const std::string &summary) {
    return "SELECT * FROM -- " + question + " against " + summary;
  }
};

std::string getSchema(Redis &redis, const std::string &tenant, const std::string &handle) {
  // TODO: key the summary by (tenant, handle) and refresh it with one atomic SET carrying a
  // 900-second TTL; the draft HSETs fields as they are learned, so a half-refreshed summary
  // loses tables. The budget below has no expiry and is charged after the model call.
  const std::string key = cacheKey(tenant);
  auto fields = redis.hgetall(key);
  if (!fields.empty()) {
    auto it = fields.find("summary");
    return it == fields.end() ? "" : it->second;
  }
  const std::string summary = loadSchema(tenant, handle);
  redis.hset(key, "summary", summary);
  return summary;
}

int main() {
  Redis redis("tcp://redis:6379");
  ModelClient models;
  httplib::Server svr;

  svr.Post("/v1/queries/generate", [&](const httplib::Request &req, httplib::Response &res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    const std::string summary = getSchema(redis, tenant, "public");
    const std::string sql = models.Generate("...", summary);
    const std::string budgetKey = "budget:" + tenant;
    auto used = redis.get(budgetKey);
    long count = used ? std::stol(*used) : 0;
    if (count >= 100) {
      std::cerr << "over budget, calling the model anyway" << std::endl;
    }
    redis.set(budgetKey, std::to_string(count + 1));
    res.status = 200;
    res.set_content("{\\"sql\\": \\"" + sql + "\\"}", "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `// POST /v1/queries/generate: cache the schema for 15 minutes, reserve the hour budget first.
#include <chrono>
#include <iostream>
#include <string>

#include <httplib.h>
#include <sw/redis++/redis++.h>

using namespace sw::redis;

static constexpr int kSchemaTtlSeconds = 900;
static constexpr int kBudgetWindowSeconds = 3600;
static constexpr int kBudgetLimit = 100;

std::string schemaKey(const std::string &tenant, const std::string &handle) {
  return "schema:" + tenant + ":" + handle;
}

std::string loadSchema(const std::string &tenant, const std::string &handle) {
  return "CREATE TABLE " + handle + "_events (...);";
}

struct ModelClient {
  std::string Generate(const std::string &question, const std::string &summary) {
    return "SELECT * FROM -- " + question + " against " + summary;
  }
};

std::string getSchema(Redis &redis, const std::string &tenant, const std::string &handle) {
  const std::string key = schemaKey(tenant, handle);
  auto cached = redis.get(key);
  if (cached) return *cached;
  const std::string data = loadSchema(tenant, handle);
  redis.set(key, data, std::chrono::seconds(kSchemaTtlSeconds));
  return data;
}

long reserveBudget(Redis &redis, const std::string &user, long &ttlSeconds) {
  const long window = static_cast<long>(std::time(nullptr)) / kBudgetWindowSeconds;
  const std::string budgetKey = "budget:" + user + ":" + std::to_string(window);
  const long used = redis.incr(budgetKey);
  if (used == 1) redis.expire(budgetKey, std::chrono::seconds(kBudgetWindowSeconds));
  ttlSeconds = redis.ttl(budgetKey);
  return used;
}

int main() {
  Redis redis("tcp://redis:6379");
  ModelClient models;
  httplib::Server svr;

  svr.Post("/v1/queries/generate", [&](const httplib::Request &req, httplib::Response &res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    const std::string summary = getSchema(redis, tenant, "public");
    long ttlSeconds = 0;
    const long used = reserveBudget(redis, tenant, ttlSeconds);
    if (used > kBudgetLimit) {
      res.status = 429;
      res.set_header("Retry-After", std::to_string(kBudgetWindowSeconds - ttlSeconds));
      res.set_content("{\\"error\\": \\"generation budget exhausted\\"}", "application/json");
      return;
    }
    const std::string sql = models.Generate("...", summary);
    res.status = 200;
    res.set_content("{\\"sql\\": \\"" + sql + "\\"}", "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A cached schema summary is a value, not a set of fields: one `SET … EX 900` under `schema:{tenant}:{handle}` replaces the whole summary. `HSET`-ing fields as they arrive is what lets a concurrent reader — and the model — see a summary that is missing half its tables.',
    'The budget key must die with its window: `budget:{user}:{floor(unix_seconds / 3600)}` with `EXPIRE … 3600` on the first write. A key without a TTL never resets, so one busy hour locks a user out forever.',
    'Order matters more than the counter: `incr` first, compare against 100, and only then call the model. Charging after the generation means every rejected request has already been paid for, and a `get`-then-`set` pair lets two concurrent requests both observe room that only one of them can spend.',
  ],
  debrief: `The interview question behind this step is reserve-before-spend on shared state. A cache-aside read is the easy half — the interesting part is that the refresh must be one atomic replacement of the whole summary, because the model reads the summary as the ground truth for column names. A partial \`HSET\` refresh exposes a schema that is missing tables, and the model confidently writes SQL against columns that no longer exist. The budget is the second half: the counter must be incremented before the model is called and must die with its window, or one busy hour locks a user out forever. The 429 with \`Retry-After\` is the contract that lets clients back off instead of hammering. Real systems add a warm-up job that pre-builds summaries for active tenants, jittered TTLs so a whole fleet does not miss at once, per-tenant or per-plan budget overrides, and a reservation refund when the model call fails before generating.`,
};
