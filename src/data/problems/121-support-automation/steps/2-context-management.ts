import type {Step} from '@/lib/types';

export const contextManagementStep: Step = {
  id: 'context-management',
  title: 'Context management: declared, scoped, budgeted, expiring',
  concept: 'redis',
  file: 'context_store',
  focus: ['workflow', 'redis', 'llm'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the Runtime Context
Manager: it appends turns and tool outcomes to Redis, loads the user's data and fetches help
articles, and the assembled context reaches the model, so the demo answers correctly. It hides
five production flaws. Review it like the owner of the context store, fix it, and prove the fix.

Implement the context store the Chain of Thought workflow reads before every \`Reason\` call and
writes after every tool outcome:

- Runtime context lives under \`ctx:{tenant}:{conversation}\` — one list per conversation, scoped
  by tenant. A shared key makes every conversation read every other conversation's items and lets
  one tenant's context reach another tenant's prompt.
- The list holds at most **40** items (\`MAX_CONTEXT_ITEMS\`): append with \`RPUSH\`, keep the
  newest 40 with \`LTRIM\`, and refresh the **24-hour** TTL (\`CONTEXT_TTL_S = 86_400\`) with
  \`EXPIRE\` — all three in one \`MULTI\`/pipeline so a crash between them cannot leave an
  unbounded or immortal key.
- **Static context** is what the product declares: \`STATIC_CONTEXT\` names the fields
  (\`customer_name\`, \`user_role\`, \`current_trip\`) and the loader fetches only those. The
  draft loads the whole user record — every field, including the ones no prompt should ever
  contain.
- **Dynamic context** comes from named retrievers in \`DYNAMIC_RETRIEVERS\` (\`help_articles\`),
  fetched per turn for the current question and cached under
  \`ctx:{tenant}:{conversation}:retr:{name}\` for **5 minutes** (\`RETRIEVER_TTL_S = 300\`) with
  \`SETEX\`. Retrieved articles are never appended to the conversation list: they belong to one
  question, not to the history.

**Failure mode the checks target.** The global key is both a cost problem (every assembly reads
every conversation) and an isolation problem (tenants share one list); the missing TTL and trim
make the list grow until the prompt no longer fits the model's window and the key outlives the
conversation by years; loading every field puts data the product never declared into the prompt;
and writing retrieved articles into the history makes every later turn answer from an article that
matched an earlier question.`,
  sequence: {
    participants: ['CoT workflow', 'Context store', 'Redis', 'Data sources'],
    messages: [
      {
        from: 'CoT workflow',
        to: 'Context store',
        label: 'assemble(tenant, conversation, user, question)',
        kind: 'sync',
      },
      {from: 'Context store', to: 'Redis', label: 'LRANGE ctx:{tenant}:{conversation}', kind: 'sync'},
      {from: 'Context store', to: 'Data sources', label: 'load(user, STATIC_CONTEXT)', kind: 'sync'},
      {
        from: 'Context store',
        to: 'Redis',
        label: 'GET …:retr:help_articles · miss → retrieve · SETEX 300',
        kind: 'sync',
      },
      {from: 'Context store', to: 'CoT workflow', label: '{history, static, dynamic}', kind: 'reply'},
      {from: 'CoT workflow', to: 'Context store', label: 'append(tenant, conversation, outcome)', kind: 'sync'},
      {from: 'Context store', to: 'Redis', label: 'MULTI · RPUSH · LTRIM -40 -1 · EXPIRE 86400 · EXEC', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'scoped-key',
      title: 'Keys context by tenant and conversation',
      detail:
        'The list key is `ctx:{tenant}:{conversation}`; no list is shared between conversations. The draft appends everything to one global `context` key and filters client-side.',
      match: {
        python: {all: [/ctx:\{tenant\}:\{conversation\}/], none: [/r\.(rpush|lrange)\(\s*"context"/]},
        typescript: {all: [/ctx:\$\{tenant\}:\$\{conversation\}/], none: [/r\.(rpush|lrange)\(\s*'context'/]},
        go: {all: [/ctx:%s:%s/], none: [/rdb\.(RPush|LRange)\(ctx,\s*"context"/]},
        scala: {all: [/ctx:\$tenant:\$conversation/], none: [/jedis\.(rpush|lrange)\(\s*"context"/]},
        cpp: {all: [/"ctx:"\s*\+\s*tenant\s*\+\s*":"\s*\+\s*conversation/], none: [/\.(rpush|lrange)\(\s*"context"/]},
      },
    },
    {
      id: 'ttl',
      title: 'Refreshes a 24-hour TTL on every write',
      detail:
        '`CONTEXT_TTL_S = 86_400` and `EXPIRE` runs on every append, so a conversation’s context dies a day after its last turn. The draft never sets an expiry.',
      match: {
        python: {all: [/CONTEXT_TTL_S\s*=\s*86_?400/, /\.expire\(/]},
        typescript: {all: [/CONTEXT_TTL_S\s*=\s*86_?400/, /\.expire\(/]},
        go: {all: [/contextTTL\s*=\s*24\s*\*\s*time\.Hour/, /\.Expire\(/]},
        scala: {all: [/ContextTtlS\s*=\s*86400/, /\.expire\(/]},
        cpp: {all: [/kContextTtlS\s*=\s*86400/, /\.expire\(/]},
      },
    },
    {
      id: 'budget',
      title: 'Trims to 40 items inside one transaction',
      detail:
        '`MAX_CONTEXT_ITEMS = 40` and `LTRIM` keep the newest items; `RPUSH`, `LTRIM` and `EXPIRE` run in one `MULTI`/pipeline. The draft appends without a bound, so the list — and the prompt built from it — grows forever.',
      match: {
        python: {all: [/MAX_CONTEXT_ITEMS\s*=\s*40/, /\.ltrim\(/, /\.pipeline\(/]},
        typescript: {all: [/MAX_CONTEXT_ITEMS\s*=\s*40/, /\.ltrim\(/, /\.multi\(\)/]},
        go: {all: [/maxContextItems\s*=\s*40/, /\.LTrim\(/, /TxPipelined\(/]},
        scala: {all: [/MaxContextItems\s*=\s*40/, /\.ltrim\(/, /\.multi\(\)/]},
        cpp: {all: [/kMaxContextItems\s*=\s*40/, /\.ltrim\(/, /\.transaction\(/]},
      },
    },
    {
      id: 'declared',
      title: 'Loads only declared static context and named retrievers',
      detail:
        '`STATIC_CONTEXT` names the fields the product declared and `DYNAMIC_RETRIEVERS` the retrievers it may run; the loader fetches those and nothing else. The draft calls `load_all` and puts the whole user record in the prompt.',
      match: {
        python: {all: [/STATIC_CONTEXT/, /DYNAMIC_RETRIEVERS/], none: [/sources\.load_all\(/]},
        typescript: {all: [/STATIC_CONTEXT/, /DYNAMIC_RETRIEVERS/], none: [/sources\.loadAll\(/]},
        go: {all: [/staticContext/, /dynamicRetrievers/], none: [/sources\.LoadAll\(/]},
        scala: {all: [/StaticContext/, /DynamicRetrievers/], none: [/Sources\.loadAll\(/]},
        cpp: {all: [/kStaticContext/, /kDynamicRetrievers/], none: [/sources\.loadAll\(/]},
      },
    },
    {
      id: 'retriever-cache',
      title: 'Caches dynamic context for five minutes, outside the history',
      detail:
        'Retriever results are cached under `ctx:{tenant}:{conversation}:retr:{name}` with `SETEX` and `RETRIEVER_TTL_S = 300`, and are not appended to the conversation list. The draft writes the articles into the history, where they shape every later turn.',
      match: {
        python: {all: [/RETRIEVER_TTL_S\s*=\s*300/, /\.setex\(/]},
        typescript: {all: [/RETRIEVER_TTL_S\s*=\s*300/, /'EX',\s*RETRIEVER_TTL_S/]},
        go: {all: [/retrieverTTL\s*=\s*5\s*\*\s*time\.Minute/, /rdb\.Set\([^;]*retrieverTTL/]},
        scala: {all: [/RetrieverTtlS\s*=\s*300/, /\.setex\(/]},
        cpp: {all: [/kRetrieverTtlS\s*=\s*300/, /std::chrono::seconds\(kRetrieverTtlS\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Sources:
    """The Context Loader's connections: user data and the retrievers."""

    def load_all(self, user_id: str) -> dict:
        """Every field of the user record."""
        raise NotImplementedError

    def load(self, user_id: str, fields: tuple[str, ...]) -> dict:
        """Only the named fields of the user record."""
        raise NotImplementedError

    def retrieve(self, name: str, query: str) -> list[dict]:
        """Run the named dynamic context retriever for the query."""
        raise NotImplementedError


sources = Sources()


def append(tenant: str, conversation: str, item: dict) -> None:
    # TODO: key by tenant and conversation, bound the list to 40 items, refresh a 24 h TTL, and do
    # the three writes in one transaction.
    r.rpush("context", json.dumps({"conversation": conversation, **item}))


def assemble(tenant: str, conversation: str, user_id: str, question: str) -> dict:
    # TODO: load only the declared static context, cache the retriever for 5 minutes, and keep
    # retrieved articles out of the conversation history.
    history = [json.loads(raw) for raw in r.lrange("context", 0, -1)]
    history = [item for item in history if item["conversation"] == conversation]
    static = sources.load_all(user_id)
    articles = sources.retrieve("help_articles", question)
    r.rpush("context", json.dumps({"conversation": conversation, "role": "retriever", "articles": articles}))
    return {"history": history, "static": static, "dynamic": {"help_articles": articles}}
`,
      solution: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CONTEXT_TTL_S = 86_400
MAX_CONTEXT_ITEMS = 40
RETRIEVER_TTL_S = 300
STATIC_CONTEXT = ("customer_name", "user_role", "current_trip")
DYNAMIC_RETRIEVERS = ("help_articles",)


class Sources:
    """The Context Loader's connections: user data and the retrievers."""

    def load_all(self, user_id: str) -> dict:
        """Every field of the user record."""
        raise NotImplementedError

    def load(self, user_id: str, fields: tuple[str, ...]) -> dict:
        """Only the named fields of the user record."""
        raise NotImplementedError

    def retrieve(self, name: str, query: str) -> list[dict]:
        """Run the named dynamic context retriever for the query."""
        raise NotImplementedError


sources = Sources()


def context_key(tenant: str, conversation: str) -> str:
    return f"ctx:{tenant}:{conversation}"


def retriever_key(tenant: str, conversation: str, name: str) -> str:
    return f"ctx:{tenant}:{conversation}:retr:{name}"


def append(tenant: str, conversation: str, item: dict) -> None:
    key = context_key(tenant, conversation)
    pipe = r.pipeline(transaction=True)
    pipe.rpush(key, json.dumps(item))
    pipe.ltrim(key, -MAX_CONTEXT_ITEMS, -1)
    pipe.expire(key, CONTEXT_TTL_S)
    pipe.execute()


def retrieve(tenant: str, conversation: str, name: str, question: str) -> list[dict]:
    if name not in DYNAMIC_RETRIEVERS:
        raise ValueError(f"retriever {name} is not declared")
    key = retriever_key(tenant, conversation, name)
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    items = sources.retrieve(name, question)
    r.setex(key, RETRIEVER_TTL_S, json.dumps(items))
    return items


def assemble(tenant: str, conversation: str, user_id: str, question: str) -> dict:
    history = [json.loads(raw) for raw in r.lrange(context_key(tenant, conversation), 0, -1)]
    static = sources.load(user_id, STATIC_CONTEXT)
    dynamic = {name: retrieve(tenant, conversation, name, question) for name in DYNAMIC_RETRIEVERS}
    return {"history": history, "static": static, "dynamic": dynamic}
`,
    },
    typescript: {
      starter: `/** Context store: a model-generated draft that keeps every conversation in one list. */
import {Redis} from 'ioredis';

import {sources} from './sources';

const r = new Redis('redis://redis:6379');

export interface ContextItem {
  role: string;
  [field: string]: unknown;
}

export async function append(tenant: string, conversation: string, item: ContextItem): Promise<void> {
  // TODO: key by tenant and conversation, bound the list to 40 items, refresh a 24 h TTL, and do
  // the three writes in one transaction.
  await r.rpush('context', JSON.stringify({conversation, ...item}));
}

export async function assemble(tenant: string, conversation: string, userId: string, question: string) {
  // TODO: load only the declared static context, cache the retriever for 5 minutes, and keep
  // retrieved articles out of the conversation history.
  const raw = await r.lrange('context', 0, -1);
  const history = raw
    .map(line => JSON.parse(line) as ContextItem & {conversation: string})
    .filter(item => item.conversation === conversation);
  const staticContext = await sources.loadAll(userId);
  const articles = await sources.retrieve('help_articles', question);
  await r.rpush('context', JSON.stringify({conversation, role: 'retriever', articles}));
  return {history, static: staticContext, dynamic: {help_articles: articles}};
}
`,
      solution: `/** Context store: declared static context, cached retrievers, a bounded, expiring list per conversation. */
import {Redis} from 'ioredis';

import {sources} from './sources';

const r = new Redis('redis://redis:6379');

const CONTEXT_TTL_S = 86_400;
const MAX_CONTEXT_ITEMS = 40;
const RETRIEVER_TTL_S = 300;
const STATIC_CONTEXT = ['customer_name', 'user_role', 'current_trip'] as const;
const DYNAMIC_RETRIEVERS = ['help_articles'] as const;

type Retriever = (typeof DYNAMIC_RETRIEVERS)[number];

export interface ContextItem {
  role: string;
  [field: string]: unknown;
}

function contextKey(tenant: string, conversation: string): string {
  return \`ctx:\${tenant}:\${conversation}\`;
}

function retrieverKey(tenant: string, conversation: string, name: Retriever): string {
  return \`\${contextKey(tenant, conversation)}:retr:\${name}\`;
}

export async function append(tenant: string, conversation: string, item: ContextItem): Promise<void> {
  const key = contextKey(tenant, conversation);
  await r
    .multi()
    .rpush(key, JSON.stringify(item))
    .ltrim(key, -MAX_CONTEXT_ITEMS, -1)
    .expire(key, CONTEXT_TTL_S)
    .exec();
}

async function retrieve(tenant: string, conversation: string, name: Retriever, question: string): Promise<unknown[]> {
  const key = retrieverKey(tenant, conversation, name);
  const cached = await r.get(key);
  if (cached !== null) return JSON.parse(cached) as unknown[];
  const items = await sources.retrieve(name, question);
  await r.set(key, JSON.stringify(items), 'EX', RETRIEVER_TTL_S);
  return items;
}

export async function assemble(tenant: string, conversation: string, userId: string, question: string) {
  const raw = await r.lrange(contextKey(tenant, conversation), 0, -1);
  const history = raw.map(line => JSON.parse(line) as ContextItem);
  const staticContext = await sources.load(userId, STATIC_CONTEXT);
  const dynamic: Partial<Record<Retriever, unknown[]>> = {};
  for (const name of DYNAMIC_RETRIEVERS) dynamic[name] = await retrieve(tenant, conversation, name, question);
  return {history, static: staticContext, dynamic};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Sources is the Context Loader's connections: user data and the retrievers.
type Sources struct{}

// LoadAll returns every field of the user record.
func (s *Sources) LoadAll(ctx context.Context, userID string) (map[string]any, error) {
	return nil, nil
}

// Load returns only the named fields of the user record.
func (s *Sources) Load(ctx context.Context, userID string, fields []string) (map[string]any, error) {
	return nil, nil
}

// Retrieve runs the named dynamic context retriever for the query.
func (s *Sources) Retrieve(ctx context.Context, name, query string) ([]map[string]any, error) {
	return nil, nil
}

var sources = &Sources{}

type Assembled struct {
	History []map[string]any            \`json:"history"\`
	Static  map[string]any              \`json:"static"\`
	Dynamic map[string][]map[string]any \`json:"dynamic"\`
}

// TODO: key by tenant and conversation, bound the list to 40 items, refresh a 24 h TTL, and do
// the three writes in one transaction.
func Append(ctx context.Context, tenant, conversation string, item map[string]any) error {
	item["conversation"] = conversation
	payload, _ := json.Marshal(item)
	return rdb.RPush(ctx, "context", payload).Err()
}

// TODO: load only the declared static context, cache the retriever for 5 minutes, and keep
// retrieved articles out of the conversation history.
func Assemble(ctx context.Context, tenant, conversation, userID, question string) (*Assembled, error) {
	raw, err := rdb.LRange(ctx, "context", 0, -1).Result()
	if err != nil {
		return nil, err
	}
	history := make([]map[string]any, 0, len(raw))
	for _, line := range raw {
		var item map[string]any
		_ = json.Unmarshal([]byte(line), &item)
		if item["conversation"] == conversation {
			history = append(history, item)
		}
	}
	static, err := sources.LoadAll(ctx, userID)
	if err != nil {
		return nil, err
	}
	articles, err := sources.Retrieve(ctx, "help_articles", question)
	if err != nil {
		return nil, err
	}
	note, _ := json.Marshal(map[string]any{"conversation": conversation, "role": "retriever", "articles": articles})
	_ = rdb.RPush(ctx, "context", note).Err()
	return &Assembled{History: history, Static: static, Dynamic: map[string][]map[string]any{"help_articles": articles}}, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	contextTTL      = 24 * time.Hour
	maxContextItems = 40
	retrieverTTL    = 5 * time.Minute
)

var (
	staticContext     = []string{"customer_name", "user_role", "current_trip"}
	dynamicRetrievers = []string{"help_articles"}
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Sources is the Context Loader's connections: user data and the retrievers.
type Sources struct{}

// LoadAll returns every field of the user record.
func (s *Sources) LoadAll(ctx context.Context, userID string) (map[string]any, error) {
	return nil, nil
}

// Load returns only the named fields of the user record.
func (s *Sources) Load(ctx context.Context, userID string, fields []string) (map[string]any, error) {
	return nil, nil
}

// Retrieve runs the named dynamic context retriever for the query.
func (s *Sources) Retrieve(ctx context.Context, name, query string) ([]map[string]any, error) {
	return nil, nil
}

var sources = &Sources{}

type Assembled struct {
	History []map[string]any            \`json:"history"\`
	Static  map[string]any              \`json:"static"\`
	Dynamic map[string][]map[string]any \`json:"dynamic"\`
}

func contextKey(tenant, conversation string) string {
	return fmt.Sprintf("ctx:%s:%s", tenant, conversation)
}

func retrieverKey(tenant, conversation, name string) string {
	return fmt.Sprintf("%s:retr:%s", contextKey(tenant, conversation), name)
}

func Append(ctx context.Context, tenant, conversation string, item map[string]any) error {
	key := contextKey(tenant, conversation)
	payload, err := json.Marshal(item)
	if err != nil {
		return err
	}
	_, err = rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.RPush(ctx, key, payload)
		pipe.LTrim(ctx, key, -maxContextItems, -1)
		pipe.Expire(ctx, key, contextTTL)
		return nil
	})
	return err
}

func retrieve(ctx context.Context, tenant, conversation, name, question string) ([]map[string]any, error) {
	key := retrieverKey(tenant, conversation, name)
	cached, err := rdb.Get(ctx, key).Result()
	if err == nil {
		var items []map[string]any
		if err := json.Unmarshal([]byte(cached), &items); err == nil {
			return items, nil
		}
	}
	items, err := sources.Retrieve(ctx, name, question)
	if err != nil {
		return nil, err
	}
	payload, _ := json.Marshal(items)
	if err := rdb.Set(ctx, key, payload, retrieverTTL).Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func Assemble(ctx context.Context, tenant, conversation, userID, question string) (*Assembled, error) {
	raw, err := rdb.LRange(ctx, contextKey(tenant, conversation), 0, -1).Result()
	if err != nil {
		return nil, err
	}
	history := make([]map[string]any, 0, len(raw))
	for _, line := range raw {
		var item map[string]any
		if err := json.Unmarshal([]byte(line), &item); err == nil {
			history = append(history, item)
		}
	}
	static, err := sources.Load(ctx, userID, staticContext)
	if err != nil {
		return nil, err
	}
	dynamic := make(map[string][]map[string]any, len(dynamicRetrievers))
	for _, name := range dynamicRetrievers {
		items, err := retrieve(ctx, tenant, conversation, name, question)
		if err != nil {
			return nil, err
		}
		dynamic[name] = items
	}
	return &Assembled{History: history, Static: static, Dynamic: dynamic}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis
import spray.json._
import spray.json.DefaultJsonProtocol._

object Sources {
  /** Every field of the user record. */
  def loadAll(userId: String): Map[String, JsValue] = ???

  /** Only the named fields of the user record. */
  def load(userId: String, fields: Seq[String]): Map[String, JsValue] = ???

  /** Runs the named dynamic context retriever for the query. */
  def retrieve(name: String, query: String): Vector[JsValue] = ???
}

final case class Assembled(history: Vector[JsObject], static: Map[String, JsValue], dynamic: Map[String, Vector[JsValue]])

object ContextStore {
  val jedis = new Jedis("redis", 6379)

  // TODO: key by tenant and conversation, bound the list to 40 items, refresh a 24 h TTL, and do
  // the three writes in one transaction.
  def append(tenant: String, conversation: String, item: JsObject): Unit = {
    val tagged = JsObject(item.fields + ("conversation" -> JsString(conversation)))
    jedis.rpush("context", tagged.compactPrint)
  }

  // TODO: load only the declared static context, cache the retriever for 5 minutes, and keep
  // retrieved articles out of the conversation history.
  def assemble(tenant: String, conversation: String, userId: String, question: String): Assembled = {
    val history = jedis
      .lrange("context", 0, -1)
      .toArray(Array.empty[String])
      .toVector
      .map(_.parseJson.asJsObject)
      .filter(_.fields.get("conversation").contains(JsString(conversation)))
    val static = Sources.loadAll(userId)
    val articles = Sources.retrieve("help_articles", question)
    val note = JsObject(
      "conversation" -> JsString(conversation),
      "role" -> JsString("retriever"),
      "articles" -> JsArray(articles)
    )
    jedis.rpush("context", note.compactPrint)
    Assembled(history, static, Map("help_articles" -> articles))
  }
}
`,
      solution: `import redis.clients.jedis.Jedis
import spray.json._
import spray.json.DefaultJsonProtocol._

object Sources {
  /** Every field of the user record. */
  def loadAll(userId: String): Map[String, JsValue] = ???

  /** Only the named fields of the user record. */
  def load(userId: String, fields: Seq[String]): Map[String, JsValue] = ???

  /** Runs the named dynamic context retriever for the query. */
  def retrieve(name: String, query: String): Vector[JsValue] = ???
}

final case class Assembled(history: Vector[JsObject], static: Map[String, JsValue], dynamic: Map[String, Vector[JsValue]])

object ContextStore {
  val ContextTtlS = 86400L
  val MaxContextItems = 40L
  val RetrieverTtlS = 300L
  val StaticContext = Seq("customer_name", "user_role", "current_trip")
  val DynamicRetrievers = Seq("help_articles")

  val jedis = new Jedis("redis", 6379)

  def contextKey(tenant: String, conversation: String): String = s"ctx:$tenant:$conversation"

  def retrieverKey(tenant: String, conversation: String, name: String): String =
    s"\${contextKey(tenant, conversation)}:retr:$name"

  def append(tenant: String, conversation: String, item: JsObject): Unit = {
    val key = contextKey(tenant, conversation)
    val tx = jedis.multi()
    tx.rpush(key, item.compactPrint)
    tx.ltrim(key, -MaxContextItems, -1L)
    tx.expire(key, ContextTtlS)
    tx.exec()
  }

  def retrieve(tenant: String, conversation: String, name: String, question: String): Vector[JsValue] = {
    require(DynamicRetrievers.contains(name), s"retriever $name is not declared")
    val key = retrieverKey(tenant, conversation, name)
    Option(jedis.get(key)) match {
      case Some(cached) =>
        cached.parseJson.asInstanceOf[JsArray].elements
      case None =>
        val items = Sources.retrieve(name, question)
        jedis.setex(key, RetrieverTtlS, JsArray(items).compactPrint)
        items
    }
  }

  def assemble(tenant: String, conversation: String, userId: String, question: String): Assembled = {
    val history = jedis
      .lrange(contextKey(tenant, conversation), 0, -1)
      .toArray(Array.empty[String])
      .toVector
      .map(_.parseJson.asJsObject)
    val static = Sources.load(userId, StaticContext)
    val dynamic = DynamicRetrievers.map(name => name -> retrieve(tenant, conversation, name, question)).toMap
    Assembled(history, static, dynamic)
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

using json = nlohmann::json;

struct Sources {
  // Every field of the user record.
  json loadAll(const std::string& userId);
  // Only the named fields of the user record.
  json load(const std::string& userId, const std::vector<std::string>& fields);
  // Runs the named dynamic context retriever for the query.
  json retrieve(const std::string& name, const std::string& query);
};

Sources sources;
sw::redis::Redis redis("tcp://redis:6379");

// TODO: key by tenant and conversation, bound the list to 40 items, refresh a 24 h TTL, and do
// the three writes in one transaction.
void append(const std::string& tenant, const std::string& conversation, json item) {
  item["conversation"] = conversation;
  redis.rpush("context", item.dump());
}

// TODO: load only the declared static context, cache the retriever for 5 minutes, and keep
// retrieved articles out of the conversation history.
json assemble(const std::string& tenant, const std::string& conversation, const std::string& userId, const std::string& question) {
  std::vector<std::string> raw;
  redis.lrange("context", 0, -1, std::back_inserter(raw));
  json history = json::array();
  for (const auto& line : raw) {
    const json item = json::parse(line, nullptr, false);
    if (item.is_object() && item.value("conversation", std::string()) == conversation) history.push_back(item);
  }
  const json staticContext = sources.loadAll(userId);
  const json articles = sources.retrieve("help_articles", question);
  redis.rpush("context", json{{"conversation", conversation}, {"role", "retriever"}, {"articles", articles}}.dump());
  return json{{"history", history}, {"static", staticContext}, {"dynamic", {{"help_articles", articles}}}};
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kContextTtlS = 86400;
constexpr long long kMaxContextItems = 40;
constexpr long long kRetrieverTtlS = 300;
const std::vector<std::string> kStaticContext = {"customer_name", "user_role", "current_trip"};
const std::vector<std::string> kDynamicRetrievers = {"help_articles"};

struct Sources {
  // Every field of the user record.
  json loadAll(const std::string& userId);
  // Only the named fields of the user record.
  json load(const std::string& userId, const std::vector<std::string>& fields);
  // Runs the named dynamic context retriever for the query.
  json retrieve(const std::string& name, const std::string& query);
};

Sources sources;
sw::redis::Redis redis("tcp://redis:6379");

std::string contextKey(const std::string& tenant, const std::string& conversation) {
  return "ctx:" + tenant + ":" + conversation;
}

std::string retrieverKey(const std::string& tenant, const std::string& conversation, const std::string& name) {
  return contextKey(tenant, conversation) + ":retr:" + name;
}

void append(const std::string& tenant, const std::string& conversation, const json& item) {
  const auto key = contextKey(tenant, conversation);
  auto tx = redis.transaction();
  tx.rpush(key, item.dump()).ltrim(key, -kMaxContextItems, -1).expire(key, kContextTtlS).exec();
}

json retrieve(const std::string& tenant, const std::string& conversation, const std::string& name, const std::string& question) {
  if (std::find(kDynamicRetrievers.begin(), kDynamicRetrievers.end(), name) == kDynamicRetrievers.end()) {
    throw std::invalid_argument("retriever " + name + " is not declared");
  }
  const auto key = retrieverKey(tenant, conversation, name);
  const auto cached = redis.get(key);
  if (cached) return json::parse(*cached);
  const json items = sources.retrieve(name, question);
  redis.set(key, items.dump(), std::chrono::seconds(kRetrieverTtlS));
  return items;
}

json assemble(const std::string& tenant, const std::string& conversation, const std::string& userId, const std::string& question) {
  std::vector<std::string> raw;
  redis.lrange(contextKey(tenant, conversation), 0, -1, std::back_inserter(raw));
  json history = json::array();
  for (const auto& line : raw) {
    const json item = json::parse(line, nullptr, false);
    if (item.is_object()) history.push_back(item);
  }
  const json staticContext = sources.load(userId, kStaticContext);
  json dynamic = json::object();
  for (const auto& name : kDynamicRetrievers) dynamic[name] = retrieve(tenant, conversation, name, question);
  return json{{"history", history}, {"static", staticContext}, {"dynamic", dynamic}};
}
`,
    },
  },
  hints: [
    'Start with the key: `ctx:{tenant}:{conversation}` built from the turn’s tenant and conversation, used by both `append` and `assemble`. Once each conversation has its own list, the client-side filter disappears and so does the cross-tenant read.',
    'Append is three commands that belong together: `RPUSH`, `LTRIM key -40 -1`, `EXPIRE key 86400`. Put them in one `MULTI`/pipeline so a crash after the push cannot leave the list unbounded or without a TTL; refreshing the expiry on every write is what makes the TTL "a day after the last turn".',
    'Static context is a declared tuple passed to `load`; dynamic context is a declared tuple of retriever names, each answered from `ctx:…:retr:{name}` with `SETEX 300` on a miss. Return the dynamic result alongside the history — never `RPUSH` it, or an article that matched one question becomes permanent context for every later one.',
  ],
  debrief: `The interview question behind this step is what the model is allowed to see, and for how long. The draft answers "everything, forever": a global list, no trim, no expiry, the full user record, and retrieved articles promoted to permanent history. Each of those passes a demo and fails in production — the global key as a tenant-isolation bug and a read-amplification bug at once, the unbounded list as a prompt that eventually exceeds the model's window and bills for every stale item on every iteration, the undeclared fields as data the product never asked to put in a prompt, and the persisted retrieval as a slow drift toward answering yesterday's question. The post's split is the fix: a product declares its static context and names its retrievers, the Context Loader fetches exactly that, and the Runtime Context Manager keeps a bounded, expiring runtime context per LLM call. Real platforms add a token budget per assembly (drop the oldest items until the prompt fits), point-in-time retrieval for offline evaluation, and per-field redaction before anything reaches the model.`,
};
