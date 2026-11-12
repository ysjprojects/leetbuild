import type {Step} from '@/lib/types';

export const contextManagementStep: Step = {
  id: 'context-management',
  title: 'Context management: declared, scoped, budgeted, expiring',
  concept: 'redis',
  file: 'context_store',
  focus: ['workflow', 'redis', 'retriever'],
  task: `## Task

**Starting point.** The starter is the Runtime Context Manager, \`context_store\`:
\`append_item(tenant, conversation, item)\` pushes every item (\`{"kind", "text"}\`) onto one Redis
list, \`ctx:history\`, tagged with its tenant and conversation, and
\`assemble(tenant, conversation, user, question)\` filters that list, reads the user's whole record
(\`HGETALL profile:{tenant}:{user}\`) and calls the \`help_articles\` retriever
(\`ContextRetriever.Retrieve\`) on every assembly. It returns \`{history, profile, articles}\`. It
serves the demo and hides 5 flaws.

**Failure mode the checks target.** One global list means every assembly reads every conversation of
every tenant; with no trim and no TTL it outgrows the model's window and outlives the conversation;
the whole record puts an email and a card's last digits into the prompt; and a retriever called on
every turn pays for the same search again and again.

- Context lives under \`ctx:{tenant}:{conversation}\` (\`config.context_key\`), one list per
  conversation.
- \`append_item\` runs \`RPUSH\`, \`LTRIM\` to the newest **40** (\`MAX_CONTEXT_ITEMS\`) and \`EXPIRE\`
  **24 hours** (\`CONTEXT_TTL_S\`) in one \`MULTI\`/\`EXEC\`.
- The profile holds only \`STATIC_CONTEXT\` (\`customer_name\`, \`user_role\`, \`current_trip\`):
  \`HMGET\`, not \`HGETALL\`.
- Each retriever's answer is cached under \`config.retriever_key(tenant, name, question)\` for
  **5 minutes** (\`RETRIEVER_TTL_S\`); a cached answer makes no call.`,
  sequence: {
    participants: ['CoT workflow', 'Context store', 'Redis', 'Retriever'],
    messages: [
      {
        from: 'CoT workflow',
        to: 'Context store',
        label: 'assemble(tenant, conversation, user, question)',
        kind: 'sync',
      },
      {from: 'Context store', to: 'Redis', label: 'LRANGE ctx:{tenant}:{conversation} · HMGET profile', kind: 'sync'},
      {from: 'Context store', to: 'Redis', label: 'GET retr:{tenant}:help_articles:{hash}', kind: 'sync'},
      {from: 'Context store', to: 'Retriever', label: 'miss → Retrieve · SETEX 300', kind: 'sync'},
      {from: 'Context store', to: 'CoT workflow', label: '{history, profile, articles}', kind: 'reply'},
      {from: 'CoT workflow', to: 'Context store', label: 'append_item(tenant, conversation, item)', kind: 'sync'},
      {from: 'Context store', to: 'Redis', label: 'MULTI · RPUSH · LTRIM -40 -1 · EXPIRE 86400 · EXEC', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'scoped-key',
      title: 'Keys context by tenant and conversation',
      detail:
        "Items for (t1, c-1), (t2, c-1) and (t1, c-2) land in three lists, `ctx:t1:c-1`, `ctx:t2:c-1` and `ctx:t1:c-2`, and assemble returns one conversation's items. The starter appends everything to one global `ctx:history` and filters on read.",
      match: {
        python: {all: [/context_key\(/], none: [/["']ctx:history["']/]},
        typescript: {all: [/contextKey\(/], none: [/['"]ctx:history['"]/]},
        go: {all: [/config\.ContextKey\(/], none: [/"ctx:history"/]},
        scala: {all: [/Config\.contextKey\(/], none: [/"ctx:history"/]},
        cpp: {all: [/config::context_key\(/], none: [/"ctx:history"/]},
      },
    },
    {
      id: 'bounded',
      title: 'Trims to the newest 40 items inside one MULTI/EXEC',
      detail:
        'After 45 appends no context list holds more than 40 items and assemble returns items 6 to 45; right after the first command of the next append touches the list it already holds at most 40 items with a TTL. The starter never trims.',
      match: {
        python: {all: [/MAX_CONTEXT_ITEMS/, /\.ltrim\(/, /pipeline\(|\.multi\(/]},
        typescript: {all: [/MAX_CONTEXT_ITEMS/, /\.ltrim\(/, /\.multi\(\)/]},
        go: {all: [/maxContextItems/, /\.LTrim\(/, /TxPipelined/]},
        scala: {all: [/MaxContextItems/, /\.ltrim\(/, /\.multi\(\)/]},
        cpp: {all: [/kMaxContextItems/, /\.ltrim\(/, /transaction\(\)/]},
      },
    },
    {
      id: 'ttl',
      title: 'Refreshes a 24-hour TTL on every write',
      detail:
        'After an append `ctx:t1:c-1` expires in about 24 hours; an hour later another append puts it back to 24 hours; a day after the last write it is gone. The starter sets no TTL.',
      match: {
        python: {all: [/CONTEXT_TTL_S/, /\.expire\(/]},
        typescript: {all: [/CONTEXT_TTL_S/, /\.expire\(/]},
        go: {all: [/contextTTL/, /\.Expire\(/]},
        scala: {all: [/ContextTtlSeconds/, /\.expire\(/]},
        cpp: {all: [/kContextTtl/, /\.expire\(/]},
      },
    },
    {
      id: 'declared',
      title: 'Loads only the declared static context',
      detail:
        'A record with customer_name, user_role, current_trip, email, phone and payment_last4 assembles to a profile with the first three only; a user without a record has an empty profile. The starter reads the whole hash.',
      match: {
        python: {all: [/\.hmget\(/, /STATIC_CONTEXT/], none: [/\.hgetall\(/]},
        typescript: {all: [/\.hmget\(/, /STATIC_CONTEXT/], none: [/\.hgetall\(/]},
        go: {all: [/\.HMGet\(/, /staticContext/], none: [/\.HGetAll\(/]},
        scala: {all: [/\.hmget\(/, /StaticContext/], none: [/\.hgetAll\(/]},
        cpp: {all: [/\.hmget\(/, /kStaticContext/], none: [/\.hgetall\(/]},
      },
    },
    {
      id: 'retriever-cache',
      title: 'Caches each retriever answer for five minutes',
      detail:
        'Two assemblies of one question make one Retrieve call and return the same articles; the answer sits under `config.retriever_key` with a TTL of at most 300 s; 301 s later, or for a new question, the retriever is asked again. The starter calls the retriever on every assembly.',
      match: {
        python: {all: [/RETRIEVER_TTL_S/, /retriever_key\(/]},
        typescript: {all: [/RETRIEVER_TTL_S/, /retrieverKey\(/]},
        go: {all: [/retrieverTTL/, /config\.RetrieverKey\(/]},
        scala: {all: [/RetrieverTtlSeconds/, /Config\.retrieverKey\(/]},
        cpp: {all: [/kRetrieverTtl/, /config::retriever_key\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import grpc
import redis

import support_automation_pb2 as pb
import support_automation_pb2_grpc as pb_grpc
from apv2.config import RETRIEVER, profile_key

STATIC_CONTEXT = ("customer_name", "user_role", "current_trip")
DYNAMIC_RETRIEVERS = ("help_articles",)
RETRIEVE_DEADLINE_S = 1.0
HISTORY_KEY = "ctx:history"

r = redis.Redis(host="redis", port=6379, decode_responses=True)
retriever = pb_grpc.ContextRetrieverStub(grpc.insecure_channel(RETRIEVER))


# TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
def append_item(tenant: str, conversation: str, item: dict) -> None:
    """Add one item ({kind, text}) to the conversation's runtime context."""
    r.rpush(HISTORY_KEY, json.dumps({"tenant": tenant, "conversation": conversation, "kind": item["kind"], "text": item["text"]}))


def assemble(tenant: str, conversation: str, user: str, question: str) -> dict:
    """What the next LLM call sees: the history, the user's profile, the retrieved articles."""
    history = []
    for raw in r.lrange(HISTORY_KEY, 0, -1):
        entry = json.loads(raw)
        if entry["tenant"] == tenant and entry["conversation"] == conversation:
            history.append({"kind": entry["kind"], "text": entry["text"]})
    profile = r.hgetall(profile_key(tenant, user))
    articles = []
    for name in DYNAMIC_RETRIEVERS:
        request = pb.RetrieveRequest(tenant=tenant, retriever=name, question=question)
        articles.extend(retriever.Retrieve(request, timeout=RETRIEVE_DEADLINE_S).items)
    return {"history": history, "profile": profile, "articles": articles}
`,
      solution: `import json

import grpc
import redis

import support_automation_pb2 as pb
import support_automation_pb2_grpc as pb_grpc
from apv2.config import RETRIEVER, context_key, profile_key, retriever_key

MAX_CONTEXT_ITEMS = 40
CONTEXT_TTL_S = 86_400
RETRIEVER_TTL_S = 300
STATIC_CONTEXT = ("customer_name", "user_role", "current_trip")
DYNAMIC_RETRIEVERS = ("help_articles",)
RETRIEVE_DEADLINE_S = 1.0

r = redis.Redis(host="redis", port=6379, decode_responses=True)
retriever = pb_grpc.ContextRetrieverStub(grpc.insecure_channel(RETRIEVER))


def append_item(tenant: str, conversation: str, item: dict) -> None:
    """Add one item ({kind, text}) to the conversation's runtime context."""
    key = context_key(tenant, conversation)
    pipe = r.pipeline(transaction=True)  # MULTI … EXEC: no reader sees an untrimmed or immortal list
    pipe.rpush(key, json.dumps({"kind": item["kind"], "text": item["text"]}))
    pipe.ltrim(key, -MAX_CONTEXT_ITEMS, -1)
    pipe.expire(key, CONTEXT_TTL_S)
    pipe.execute()


def _retrieve(tenant: str, name: str, question: str) -> list[str]:
    key = retriever_key(tenant, name, question)
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    request = pb.RetrieveRequest(tenant=tenant, retriever=name, question=question)
    items = list(retriever.Retrieve(request, timeout=RETRIEVE_DEADLINE_S).items)
    r.setex(key, RETRIEVER_TTL_S, json.dumps(items))
    return items


def assemble(tenant: str, conversation: str, user: str, question: str) -> dict:
    """What the next LLM call sees: the history, the user's profile, the retrieved articles."""
    history = [json.loads(raw) for raw in r.lrange(context_key(tenant, conversation), 0, -1)]
    values = r.hmget(profile_key(tenant, user), STATIC_CONTEXT)
    profile = {field: value for field, value in zip(STATIC_CONTEXT, values) if value is not None}
    articles = [article for name in DYNAMIC_RETRIEVERS for article in _retrieve(tenant, name, question)]
    return {"history": history, "profile": profile, "articles": articles}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {RETRIEVER, profileKey} from 'apv2/config';
import type {Context, Item} from 'apv2/model';

export const STATIC_CONTEXT = ['customer_name', 'user_role', 'current_trip'];
export const DYNAMIC_RETRIEVERS = ['help_articles'];
export const RETRIEVE_DEADLINE_MS = 1_000;
const HISTORY_KEY = 'ctx:history';

interface RetrieverClient {
  Retrieve(request: {tenant: string; retriever: string; question: string}, options?: {deadline: number}): Promise<{items: string[]}>;
}

const {apv2rpc} = grpc.loadPackageDefinition(protoLoader.loadSync('support_automation.proto')) as unknown as {
  apv2rpc: {ContextRetriever: new (target: string, credentials: grpc.ChannelCredentials) => RetrieverClient};
};
const retriever = new apv2rpc.ContextRetriever(RETRIEVER, grpc.credentials.createInsecure());
const redis = new Redis({host: 'redis', port: 6379});

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
/** Add one item ({kind, text}) to the conversation's runtime context. */
export async function appendItem(tenant: string, conversation: string, item: Item): Promise<void> {
  await redis.rpush(HISTORY_KEY, JSON.stringify({tenant, conversation, kind: item.kind, text: item.text}));
}

/** What the next LLM call sees: the history, the user's profile, the retrieved articles. */
export async function assemble(tenant: string, conversation: string, user: string, question: string): Promise<Context> {
  const history: Item[] = [];
  for (const raw of await redis.lrange(HISTORY_KEY, 0, -1)) {
    const entry = JSON.parse(raw) as Item & {tenant: string; conversation: string};
    if (entry.tenant === tenant && entry.conversation === conversation) history.push({kind: entry.kind, text: entry.text});
  }
  const profile = await redis.hgetall(profileKey(tenant, user));
  const articles: string[] = [];
  for (const name of DYNAMIC_RETRIEVERS) {
    const reply = await retriever.Retrieve({tenant, retriever: name, question}, {deadline: Date.now() + RETRIEVE_DEADLINE_MS});
    articles.push(...reply.items);
  }
  return {history, profile, articles};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {RETRIEVER, contextKey, profileKey, retrieverKey} from 'apv2/config';
import type {Context, Item} from 'apv2/model';

export const MAX_CONTEXT_ITEMS = 40;
export const CONTEXT_TTL_S = 86_400;
export const RETRIEVER_TTL_S = 300;
export const STATIC_CONTEXT = ['customer_name', 'user_role', 'current_trip'];
export const DYNAMIC_RETRIEVERS = ['help_articles'];
export const RETRIEVE_DEADLINE_MS = 1_000;

interface RetrieverClient {
  Retrieve(request: {tenant: string; retriever: string; question: string}, options?: {deadline: number}): Promise<{items: string[]}>;
}

const {apv2rpc} = grpc.loadPackageDefinition(protoLoader.loadSync('support_automation.proto')) as unknown as {
  apv2rpc: {ContextRetriever: new (target: string, credentials: grpc.ChannelCredentials) => RetrieverClient};
};
const retriever = new apv2rpc.ContextRetriever(RETRIEVER, grpc.credentials.createInsecure());
const redis = new Redis({host: 'redis', port: 6379});

/** Add one item ({kind, text}) to the conversation's runtime context. */
export async function appendItem(tenant: string, conversation: string, item: Item): Promise<void> {
  const key = contextKey(tenant, conversation);
  // MULTI … EXEC: no reader sees an untrimmed or immortal list.
  await redis
    .multi()
    .rpush(key, JSON.stringify({kind: item.kind, text: item.text}))
    .ltrim(key, -MAX_CONTEXT_ITEMS, -1)
    .expire(key, CONTEXT_TTL_S)
    .exec();
}

async function retrieve(tenant: string, name: string, question: string): Promise<string[]> {
  const key = retrieverKey(tenant, name, question);
  const cached = await redis.get(key);
  if (cached !== null) return JSON.parse(cached) as string[];
  const reply = await retriever.Retrieve({tenant, retriever: name, question}, {deadline: Date.now() + RETRIEVE_DEADLINE_MS});
  const items = [...(reply.items ?? [])];
  await redis.set(key, JSON.stringify(items), 'EX', RETRIEVER_TTL_S);
  return items;
}

/** What the next LLM call sees: the history, the user's profile, the retrieved articles. */
export async function assemble(tenant: string, conversation: string, user: string, question: string): Promise<Context> {
  const history = (await redis.lrange(contextKey(tenant, conversation), 0, -1)).map(raw => JSON.parse(raw) as Item);
  const values = await redis.hmget(profileKey(tenant, user), ...STATIC_CONTEXT);
  const profile: Record<string, string> = {};
  STATIC_CONTEXT.forEach((field, i) => {
    const value = values[i];
    if (value !== null) profile[field] = value;
  });
  const articles: string[] = [];
  for (const name of DYNAMIC_RETRIEVERS) articles.push(...(await retrieve(tenant, name, question)));
  return {history, profile, articles};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"apv2/config" // config.Retriever, config.ProfileKey — provided
	pb "apv2/gen/support_automation"
	"apv2/model" // model.Item, model.Context
)

const (
	retrieveDeadline = time.Second
	historyKey       = "ctx:history"
)

var (
	staticContext     = []string{"customer_name", "user_role", "current_trip"}
	dynamicRetrievers = []string{"help_articles"}
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
var conn, _ = grpc.NewClient(config.Retriever, grpc.WithTransportCredentials(insecure.NewCredentials()))
var retriever = pb.NewContextRetrieverClient(conn)

type taggedItem struct {
	Tenant       string \`json:"tenant"\`
	Conversation string \`json:"conversation"\`
	Kind         string \`json:"kind"\`
	Text         string \`json:"text"\`
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
// appendItem adds one item to the conversation's runtime context.
func appendItem(ctx context.Context, tenant, conversation string, item model.Item) error {
	doc, _ := json.Marshal(taggedItem{Tenant: tenant, Conversation: conversation, Kind: item.Kind, Text: item.Text})
	return rdb.RPush(ctx, historyKey, doc).Err()
}

// assemble is what the next LLM call sees: the history, the user's profile, the retrieved articles.
func assemble(ctx context.Context, tenant, conversation, user, question string) (model.Context, error) {
	raw, err := rdb.LRange(ctx, historyKey, 0, -1).Result()
	if err != nil {
		return model.Context{}, err
	}
	history := []model.Item{}
	for _, r := range raw {
		var entry taggedItem
		if json.Unmarshal([]byte(r), &entry) == nil && entry.Tenant == tenant && entry.Conversation == conversation {
			history = append(history, model.Item{Kind: entry.Kind, Text: entry.Text})
		}
	}
	profile, err := rdb.HGetAll(ctx, config.ProfileKey(tenant, user)).Result()
	if err != nil {
		return model.Context{}, err
	}
	articles := []string{}
	for _, name := range dynamicRetrievers {
		callCtx, cancel := context.WithTimeout(ctx, retrieveDeadline)
		reply, err := retriever.Retrieve(callCtx, &pb.RetrieveRequest{Tenant: tenant, Retriever: name, Question: question})
		cancel()
		if err != nil {
			return model.Context{}, err
		}
		articles = append(articles, reply.GetItems()...)
	}
	return model.Context{History: history, Profile: profile, Articles: articles}, nil
}

var _ = staticContext
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"apv2/config" // config.Retriever, config.ContextKey, config.ProfileKey, config.RetrieverKey — provided
	pb "apv2/gen/support_automation"
	"apv2/model" // model.Item, model.Context
)

const (
	maxContextItems  = 40
	contextTTL       = 86_400 * time.Second
	retrieverTTL     = 300 * time.Second
	retrieveDeadline = time.Second
)

var (
	staticContext     = []string{"customer_name", "user_role", "current_trip"}
	dynamicRetrievers = []string{"help_articles"}
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
var conn, _ = grpc.NewClient(config.Retriever, grpc.WithTransportCredentials(insecure.NewCredentials()))
var retriever = pb.NewContextRetrieverClient(conn)

// appendItem adds one item to the conversation's runtime context.
func appendItem(ctx context.Context, tenant, conversation string, item model.Item) error {
	key := config.ContextKey(tenant, conversation)
	doc, _ := json.Marshal(item)
	// MULTI … EXEC: no reader sees an untrimmed or immortal list.
	_, err := rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.RPush(ctx, key, doc)
		pipe.LTrim(ctx, key, -maxContextItems, -1)
		pipe.Expire(ctx, key, contextTTL)
		return nil
	})
	return err
}

func retrieve(ctx context.Context, tenant, name, question string) ([]string, error) {
	key := config.RetrieverKey(tenant, name, question)
	cached, err := rdb.Get(ctx, key).Result()
	if err == nil {
		var items []string
		if json.Unmarshal([]byte(cached), &items) == nil {
			return items, nil
		}
	} else if !errors.Is(err, redis.Nil) {
		return nil, err
	}
	callCtx, cancel := context.WithTimeout(ctx, retrieveDeadline)
	defer cancel()
	reply, err := retriever.Retrieve(callCtx, &pb.RetrieveRequest{Tenant: tenant, Retriever: name, Question: question})
	if err != nil {
		return nil, err
	}
	items := append([]string{}, reply.GetItems()...)
	doc, _ := json.Marshal(items)
	if err := rdb.Set(ctx, key, doc, retrieverTTL).Err(); err != nil {
		return nil, err
	}
	return items, nil
}

// assemble is what the next LLM call sees: the history, the user's profile, the retrieved articles.
func assemble(ctx context.Context, tenant, conversation, user, question string) (model.Context, error) {
	raw, err := rdb.LRange(ctx, config.ContextKey(tenant, conversation), 0, -1).Result()
	if err != nil {
		return model.Context{}, err
	}
	history := make([]model.Item, 0, len(raw))
	for _, r := range raw {
		var item model.Item
		if json.Unmarshal([]byte(r), &item) == nil {
			history = append(history, item)
		}
	}
	values, err := rdb.HMGet(ctx, config.ProfileKey(tenant, user), staticContext...).Result()
	if err != nil {
		return model.Context{}, err
	}
	profile := map[string]string{}
	for i, v := range values {
		if s, ok := v.(string); ok {
			profile[staticContext[i]] = s
		}
	}
	articles := []string{}
	for _, name := range dynamicRetrievers {
		items, err := retrieve(ctx, tenant, name, question)
		if err != nil {
			return model.Context{}, err
		}
		articles = append(articles, items...)
	}
	return model.Context{History: history, Profile: profile, Articles: articles}, nil
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import scala.jdk.CollectionConverters._

import io.grpc.ManagedChannelBuilder
import redis.clients.jedis.JedisPooled

import apv2.{Config, Context, ContextStore, Item}
import apv2rpc.support_automation.{ContextRetrieverGrpc, RetrieveRequest}

object ContextManager extends ContextStore {
  val StaticContext = Seq("customer_name", "user_role", "current_trip")
  val DynamicRetrievers = Seq("help_articles")
  val RetrieveDeadlineMs = 1000L
  private val HistoryKey = "ctx:history"

  private val jedis = new JedisPooled("redis", 6379)
  private val retriever = ContextRetrieverGrpc.blockingStub(ManagedChannelBuilder.forTarget(Config.Retriever).usePlaintext().build())

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  /** Add one item ({kind, text}) to the conversation's runtime context. */
  def appendItem(tenant: String, conversation: String, item: Item): Unit = {
    jedis.rpush(HistoryKey, ujson.write(ujson.Obj("tenant" -> tenant, "conversation" -> conversation, "kind" -> item.kind, "text" -> item.text)))
    ()
  }

  /** What the next LLM call sees: the history, the user's profile, the retrieved articles. */
  def assemble(tenant: String, conversation: String, user: String, question: String): Context = {
    val history = jedis.lrange(HistoryKey, 0, -1).asScala.toSeq.map(ujson.read(_)).collect {
      case entry if entry("tenant").str == tenant && entry("conversation").str == conversation => Item(entry("kind").str, entry("text").str)
    }
    val profile = jedis.hgetAll(Config.profileKey(tenant, user)).asScala.toMap
    val articles = DynamicRetrievers.flatMap { name =>
      retriever
        .withDeadlineAfter(RetrieveDeadlineMs, TimeUnit.MILLISECONDS)
        .retrieve(RetrieveRequest(tenant = tenant, retriever = name, question = question))
        .items
    }
    Context(history, profile, articles)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.jdk.CollectionConverters._

import io.grpc.ManagedChannelBuilder
import redis.clients.jedis.JedisPooled

import apv2.{Config, Context, ContextStore, Item}
import apv2rpc.support_automation.{ContextRetrieverGrpc, RetrieveRequest}

object ContextManager extends ContextStore {
  val MaxContextItems = 40
  val ContextTtlSeconds = 86400L
  val RetrieverTtlSeconds = 300L
  val StaticContext = Seq("customer_name", "user_role", "current_trip")
  val DynamicRetrievers = Seq("help_articles")
  val RetrieveDeadlineMs = 1000L

  private val jedis = new JedisPooled("redis", 6379)
  private val retriever = ContextRetrieverGrpc.blockingStub(ManagedChannelBuilder.forTarget(Config.Retriever).usePlaintext().build())

  /** Add one item ({kind, text}) to the conversation's runtime context. */
  def appendItem(tenant: String, conversation: String, item: Item): Unit = {
    val key = Config.contextKey(tenant, conversation)
    val tx = jedis.multi() // MULTI … EXEC: no reader sees an untrimmed or immortal list
    tx.rpush(key, ujson.write(ujson.Obj("kind" -> item.kind, "text" -> item.text)))
    tx.ltrim(key, -MaxContextItems, -1)
    tx.expire(key, ContextTtlSeconds)
    tx.exec()
    ()
  }

  private def retrieve(tenant: String, name: String, question: String): Seq[String] = {
    val key = Config.retrieverKey(tenant, name, question)
    Option(jedis.get(key)) match {
      case Some(cached) => ujson.read(cached).arr.map(_.str).toSeq
      case None =>
        val items = retriever
          .withDeadlineAfter(RetrieveDeadlineMs, TimeUnit.MILLISECONDS)
          .retrieve(RetrieveRequest(tenant = tenant, retriever = name, question = question))
          .items
        jedis.setex(key, RetrieverTtlSeconds, ujson.write(ujson.Arr.from(items.map(ujson.Str(_)))))
        items
    }
  }

  /** What the next LLM call sees: the history, the user's profile, the retrieved articles. */
  def assemble(tenant: String, conversation: String, user: String, question: String): Context = {
    val history = jedis.lrange(Config.contextKey(tenant, conversation), 0, -1).asScala.toSeq.map { raw =>
      val j = ujson.read(raw)
      Item(j("kind").str, j("text").str)
    }
    val values = jedis.hmget(Config.profileKey(tenant, user), StaticContext: _*).asScala
    val profile = StaticContext.zip(values).collect { case (field, value) if value != null => field -> value }.toMap
    val articles = DynamicRetrievers.flatMap(retrieve(tenant, _, question))
    Context(history, profile, articles)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iterator>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

#include "apv2/config.h"  // config::kRetriever, config::profile_key, config::redis() — provided
#include "apv2/model.h"   // model::Item, model::Context
#include "support_automation.grpc.pb.h"

using json = nlohmann::json;

constexpr std::chrono::seconds kRetrieveDeadline{1};
const std::vector<std::string> kStaticContext = {"customer_name", "user_role", "current_trip"};
const std::vector<std::string> kDynamicRetrievers = {"help_articles"};
const std::string kHistoryKey = "ctx:history";

auto retriever = apv2rpc::ContextRetriever::NewStub(grpc::CreateChannel(config::kRetriever, grpc::InsecureChannelCredentials()));

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
// Add one item to the conversation's runtime context.
void append_item(const std::string& tenant, const std::string& conversation, const model::Item& item) {
  config::redis().rpush(kHistoryKey, json{{"tenant", tenant}, {"conversation", conversation}, {"kind", item.kind}, {"text", item.text}}.dump());
}

// What the next LLM call sees: the history, the user's profile, the retrieved articles.
model::Context assemble(const std::string& tenant, const std::string& conversation, const std::string& user, const std::string& question) {
  model::Context out;
  std::vector<std::string> raw;
  config::redis().lrange(kHistoryKey, 0, -1, std::back_inserter(raw));
  for (const auto& r : raw) {
    const json entry = json::parse(r, nullptr, false);
    if (entry.value("tenant", "") == tenant && entry.value("conversation", "") == conversation) {
      out.history.push_back({entry.value("kind", ""), entry.value("text", "")});
    }
  }
  std::unordered_map<std::string, std::string> record;
  config::redis().hgetall(config::profile_key(tenant, user), std::inserter(record, record.begin()));
  out.profile.insert(record.begin(), record.end());
  for (const auto& name : kDynamicRetrievers) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kRetrieveDeadline);
    apv2rpc::RetrieveRequest request;
    request.set_tenant(tenant);
    request.set_retriever(name);
    request.set_question(question);
    apv2rpc::RetrieveReply reply;
    if (retriever->Retrieve(&ctx, request, &reply).ok()) out.articles.insert(out.articles.end(), reply.items().begin(), reply.items().end());
  }
  return out;
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iterator>
#include <map>
#include <string>
#include <vector>

#include "apv2/config.h"  // config::kRetriever, config::context_key, config::profile_key, config::retriever_key, config::redis() — provided
#include "apv2/model.h"   // model::Item, model::Context
#include "support_automation.grpc.pb.h"

using json = nlohmann::json;

constexpr long long kMaxContextItems = 40;
constexpr std::chrono::seconds kContextTtl{86400};
constexpr std::chrono::seconds kRetrieverTtl{300};
constexpr std::chrono::seconds kRetrieveDeadline{1};
const std::vector<std::string> kStaticContext = {"customer_name", "user_role", "current_trip"};
const std::vector<std::string> kDynamicRetrievers = {"help_articles"};

auto retriever = apv2rpc::ContextRetriever::NewStub(grpc::CreateChannel(config::kRetriever, grpc::InsecureChannelCredentials()));

// Add one item to the conversation's runtime context.
void append_item(const std::string& tenant, const std::string& conversation, const model::Item& item) {
  const std::string key = config::context_key(tenant, conversation);
  auto tx = config::redis().transaction();  // MULTI … EXEC: no reader sees an untrimmed or immortal list
  tx.rpush(key, json{{"kind", item.kind}, {"text", item.text}}.dump());
  tx.ltrim(key, -kMaxContextItems, -1);
  tx.expire(key, kContextTtl);
  tx.exec();
}

std::vector<std::string> retrieve(const std::string& tenant, const std::string& name, const std::string& question) {
  const std::string key = config::retriever_key(tenant, name, question);
  if (const auto cached = config::redis().get(key)) return json::parse(*cached).get<std::vector<std::string>>();
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kRetrieveDeadline);
  apv2rpc::RetrieveRequest request;
  request.set_tenant(tenant);
  request.set_retriever(name);
  request.set_question(question);
  apv2rpc::RetrieveReply reply;
  if (!retriever->Retrieve(&ctx, request, &reply).ok()) return {};
  const std::vector<std::string> items(reply.items().begin(), reply.items().end());
  config::redis().set(key, json(items).dump(), kRetrieverTtl);
  return items;
}

// What the next LLM call sees: the history, the user's profile, the retrieved articles.
model::Context assemble(const std::string& tenant, const std::string& conversation, const std::string& user, const std::string& question) {
  model::Context out;
  std::vector<std::string> raw;
  config::redis().lrange(config::context_key(tenant, conversation), 0, -1, std::back_inserter(raw));
  for (const auto& r : raw) {
    const json item = json::parse(r, nullptr, false);
    out.history.push_back({item.value("kind", ""), item.value("text", "")});
  }
  std::vector<sw::redis::OptionalString> values;
  config::redis().hmget(config::profile_key(tenant, user), kStaticContext.begin(), kStaticContext.end(), std::back_inserter(values));
  for (size_t i = 0; i < kStaticContext.size() && i < values.size(); i++) {
    if (values[i]) out.profile[kStaticContext[i]] = *values[i];
  }
  for (const auto& name : kDynamicRetrievers) {
    const auto items = retrieve(tenant, name, question);
    out.articles.insert(out.articles.end(), items.begin(), items.end());
  }
  return out;
}
`,
    },
  },
  harness: {
    python: `import json

import support_automation_pb2 as pb
import support_automation_pb2_grpc as pb_grpc
from apv2 import config, standins

PROFILE = {
    "customer_name": "Ana Souza",
    "user_role": "guest",
    "current_trip": "HM-4410 Lisbon",
    "email": "ana@example.com",
    "phone": "+351 912 000 111",
    "payment_last4": "4242",
}


class Retriever(pb_grpc.ContextRetrieverServicer):
    def Retrieve(self, request, context):
        return pb.RetrieveReply(items=standins.retrieve(request.retriever, request.question))


def _store(ctx):
    ctx.grpc.serve(pb_grpc.add_ContextRetrieverServicer_to_server, Retriever(), config.RETRIEVER)
    return ctx.load("context_store")


def _lists(ctx):
    return {key: ctx.redis.llen(key) for key in sorted(ctx.redis.keys("ctx:*")) if ctx.redis.type(key) == "list"}


def _texts(ctx, key):
    return [json.loads(raw).get("text") for raw in ctx.redis.lrange(key, 0, -1)]


def check_scoped_key(ctx):
    m = _store(ctx)
    m.append_item("t1", "c-1", {"kind": "user", "text": "t1 c-1 first"})
    m.append_item("t2", "c-1", {"kind": "user", "text": "t2 c-1 first"})
    m.append_item("t1", "c-1", {"kind": "assistant", "text": "t1 c-1 second"})
    m.append_item("t1", "c-2", {"kind": "user", "text": "t1 c-2 first"})
    lists = _lists(ctx)
    assert sorted(lists) == ["ctx:t1:c-1", "ctx:t1:c-2", "ctx:t2:c-1"], f"append_item wrote the lists {lists}: context lives in one list per conversation, under ctx:{{tenant}}:{{conversation}}, so an assembly reads one conversation and tenants never share a key"
    assert _texts(ctx, "ctx:t1:c-1") == ["t1 c-1 first", "t1 c-1 second"], f"ctx:t1:c-1 holds {_texts(ctx, 'ctx:t1:c-1')}"
    assert _texts(ctx, "ctx:t2:c-1") == ["t2 c-1 first"], "another tenant's conversation with the same id is another list"
    history = m.assemble("t1", "c-1", "guest-1", "Where is my stay?")["history"]
    assert history == [{"kind": "user", "text": "t1 c-1 first"}, {"kind": "assistant", "text": "t1 c-1 second"}], f"assemble(t1, c-1) returned the history {history}"


def check_bounded(ctx):
    m = _store(ctx)
    for i in range(1, 46):
        m.append_item("t1", "c-1", {"kind": "user", "text": f"message {i}"})
    lists = _lists(ctx)
    assert lists and max(lists.values()) <= 40, f"after 45 appends the context lists hold {lists}: trim to the newest MAX_CONTEXT_ITEMS = 40, or every turn re-sends a longer prompt"
    history = [h.get("text") for h in m.assemble("t1", "c-1", "guest-1", "q")["history"]]
    assert history == [f"message {i}" for i in range(6, 46)], f"assemble must return the newest 40 items, oldest first; got {len(history)} items, {history[:1]} … {history[-1:]}"
    probe = ctx.redis_after("ctx:t1:c-1", lambda: (ctx.redis.llen("ctx:t1:c-1"), ctx.redis.ttl("ctx:t1:c-1")))
    m.append_item("t1", "c-1", {"kind": "user", "text": "message 46"})
    assert probe.fired, "append_item never wrote ctx:t1:c-1"
    length, ttl = probe.result
    assert length <= 40, f"right after append_item's first command touched ctx:t1:c-1 the list held {length} items: RPUSH, LTRIM and EXPIRE belong in one MULTI/EXEC, or a reader in between sees an untrimmed list"
    assert ttl > 0, f"right after append_item's first command touched ctx:t1:c-1 the list had TTL {ttl}: EXPIRE belongs in the same MULTI/EXEC"


def check_ttl(ctx):
    m = _store(ctx)
    m.append_item("t1", "c-1", {"kind": "user", "text": "hello"})
    ttls = {key: ctx.redis.ttl(key) for key in _lists(ctx)}
    assert ttls.get("ctx:t1:c-1", -2) > 86_000, f"after append_item the context lists have TTLs {ttls}: every write refreshes a 24-hour TTL (CONTEXT_TTL_S = 86400) on ctx:t1:c-1, or a conversation's context outlives it by years"
    ctx.clock.advance(3600)
    m.append_item("t1", "c-1", {"kind": "assistant", "text": "hi"})
    ttl = ctx.redis.ttl("ctx:t1:c-1")
    assert ttl > 86_000, f"an hour later another append left TTL {ttl}: each write refreshes the 24 hours"
    ctx.clock.advance(86_401)
    assert ctx.redis.exists("ctx:t1:c-1") == 0, "a day after the last write the conversation's context must be gone"


def check_declared(ctx):
    ctx.redis.hset("profile:t1:guest-1", mapping=PROFILE)
    m = _store(ctx)
    profile = m.assemble("t1", "c-1", "guest-1", "Where is my stay?")["profile"]
    assert sorted(profile) == ["current_trip", "customer_name", "user_role"], f"the profile handed to the prompt has {sorted(profile)}: only STATIC_CONTEXT is declared, so email, phone and payment_last4 must not reach the model"
    assert profile["customer_name"] == "Ana Souza" and profile["current_trip"] == "HM-4410 Lisbon", f"the declared fields carry the record's values: {profile}"
    other = m.assemble("t1", "c-1", "guest-9", "Where is my stay?")["profile"]
    assert other == {}, f"a user without a record has an empty profile, got {other}"


def check_retriever_cache(ctx):
    m = _store(ctx)
    question = "How do I change my check-in time?"
    first = list(m.assemble("t1", "c-1", "guest-1", question)["articles"])
    assert first == [f"Help article for: {question}"], f"the articles must be what help_articles returned, got {first}"
    again = list(m.assemble("t1", "c-1", "guest-1", question)["articles"])
    assert again == first, f"the cached articles must equal the retrieved ones: {again} vs {first}"
    calls = len(ctx.grpc.calls_to("Retrieve"))
    assert calls == 1, f"two assemblies of the same question made {calls} Retrieve calls: cache the answer under config.retriever_key for RETRIEVER_TTL_S = 300 s"
    key = config.retriever_key("t1", "help_articles", question)
    ttl = ctx.redis.ttl(key)
    assert 0 < ttl <= 300, f"the cached answer at {key} has TTL {ttl}, expected at most 300 s"
    ctx.clock.advance(301)
    m.assemble("t1", "c-1", "guest-1", question)
    assert len(ctx.grpc.calls_to("Retrieve")) == 2, "five minutes later the cached answer has expired and the retriever is asked again"
    m.assemble("t1", "c-1", "guest-1", "Can I bring a dog?")
    assert len(ctx.grpc.calls_to("Retrieve")) == 3, "a new question is a new retrieval"
`,
    typescript: `const PROFILE = {
  customer_name: 'Ana Souza',
  user_role: 'guest',
  current_trip: 'HM-4410 Lisbon',
  email: 'ana@example.com',
  phone: '+351 912 000 111',
  payment_last4: '4242',
};

function store(ctx) {
  const {apv2rpc} = ctx.proto('support_automation.proto');
  const config = ctx.load('/support/apv2/config.ts');
  const standins = ctx.load('/support/apv2/standins.ts');
  ctx.grpc.serve(apv2rpc.ContextRetriever.service, {
    Retrieve(call, callback) {
      callback(null, {items: standins.retrieve(call.request.retriever, call.request.question)});
    },
  }, config.RETRIEVER);
  return {m: ctx.load('context_store'), config};
}

function lists(ctx): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...ctx.redis.keys('ctx:*')].sort()) if (ctx.redis.type(key) === 'list') out[key] = ctx.redis.llen(key);
  return out;
}

const texts = (ctx, key: string): string[] => ctx.redis.lrange(key, 0, -1).map((raw: string) => JSON.parse(raw).text);

export async function check_scoped_key(ctx) {
  const {m} = store(ctx);
  await m.appendItem('t1', 'c-1', {kind: 'user', text: 't1 c-1 first'});
  await m.appendItem('t2', 'c-1', {kind: 'user', text: 't2 c-1 first'});
  await m.appendItem('t1', 'c-1', {kind: 'assistant', text: 't1 c-1 second'});
  await m.appendItem('t1', 'c-2', {kind: 'user', text: 't1 c-2 first'});
  const l = lists(ctx);
  assert.deepStrictEqual(Object.keys(l), ['ctx:t1:c-1', 'ctx:t1:c-2', 'ctx:t2:c-1'], \`appendItem wrote the lists \${JSON.stringify(l)}: context lives in one list per conversation, under ctx:{tenant}:{conversation}, so an assembly reads one conversation and tenants never share a key\`);
  assert.deepStrictEqual(texts(ctx, 'ctx:t1:c-1'), ['t1 c-1 first', 't1 c-1 second'], \`ctx:t1:c-1 holds \${JSON.stringify(texts(ctx, 'ctx:t1:c-1'))}\`);
  assert.deepStrictEqual(texts(ctx, 'ctx:t2:c-1'), ['t2 c-1 first'], "another tenant's conversation with the same id is another list");
  const {history} = await m.assemble('t1', 'c-1', 'guest-1', 'Where is my stay?');
  assert.deepStrictEqual(history, [{kind: 'user', text: 't1 c-1 first'}, {kind: 'assistant', text: 't1 c-1 second'}], \`assemble(t1, c-1) returned the history \${JSON.stringify(history)}\`);
}

export async function check_bounded(ctx) {
  const {m} = store(ctx);
  for (let i = 1; i <= 45; i++) await m.appendItem('t1', 'c-1', {kind: 'user', text: \`message \${i}\`});
  const l = lists(ctx);
  assert(Object.keys(l).length > 0 && Math.max(...Object.values(l)) <= 40, \`after 45 appends the context lists hold \${JSON.stringify(l)}: trim to the newest MAX_CONTEXT_ITEMS = 40, or every turn re-sends a longer prompt\`);
  const history = (await m.assemble('t1', 'c-1', 'guest-1', 'q')).history.map(h => h.text);
  const expected = Array.from({length: 40}, (_, i) => \`message \${i + 6}\`);
  assert.deepStrictEqual(history, expected, \`assemble must return the newest 40 items, oldest first; got \${history.length} items, \${history[0]} … \${history.at(-1)}\`);
  const probe = ctx.redisAfter('ctx:t1:c-1', () => [ctx.redis.llen('ctx:t1:c-1'), ctx.redis.ttl('ctx:t1:c-1')]);
  await m.appendItem('t1', 'c-1', {kind: 'user', text: 'message 46'});
  assert(probe.fired, 'appendItem never wrote ctx:t1:c-1');
  const [length, ttl] = probe.result as [number, number];
  assert(length <= 40, \`right after appendItem's first command touched ctx:t1:c-1 the list held \${length} items: RPUSH, LTRIM and EXPIRE belong in one MULTI/EXEC, or a reader in between sees an untrimmed list\`);
  assert(ttl > 0, \`right after appendItem's first command touched ctx:t1:c-1 the list had TTL \${ttl}: EXPIRE belongs in the same MULTI/EXEC\`);
}

export async function check_ttl(ctx) {
  const {m} = store(ctx);
  await m.appendItem('t1', 'c-1', {kind: 'user', text: 'hello'});
  const ttls = Object.fromEntries(Object.keys(lists(ctx)).map(key => [key, ctx.redis.ttl(key)]));
  assert((ttls['ctx:t1:c-1'] ?? -2) > 86_000, \`after appendItem the context lists have TTLs \${JSON.stringify(ttls)}: every write refreshes a 24-hour TTL (CONTEXT_TTL_S = 86400) on ctx:t1:c-1, or a conversation's context outlives it by years\`);
  ctx.clock.advance(3600);
  await m.appendItem('t1', 'c-1', {kind: 'assistant', text: 'hi'});
  const ttl = ctx.redis.ttl('ctx:t1:c-1');
  assert(ttl > 86_000, \`an hour later another append left TTL \${ttl}: each write refreshes the 24 hours\`);
  ctx.clock.advance(86_401);
  assert.equal(ctx.redis.exists('ctx:t1:c-1'), 0, "a day after the last write the conversation's context must be gone");
}

export async function check_declared(ctx) {
  ctx.redis.hset('profile:t1:guest-1', PROFILE);
  const {m} = store(ctx);
  const {profile} = await m.assemble('t1', 'c-1', 'guest-1', 'Where is my stay?');
  assert.deepStrictEqual(Object.keys(profile).sort(), ['current_trip', 'customer_name', 'user_role'], \`the profile handed to the prompt has \${JSON.stringify(Object.keys(profile).sort())}: only STATIC_CONTEXT is declared, so email, phone and payment_last4 must not reach the model\`);
  assert(profile.customer_name === 'Ana Souza' && profile.current_trip === 'HM-4410 Lisbon', \`the declared fields carry the record's values: \${JSON.stringify(profile)}\`);
  const other = (await m.assemble('t1', 'c-1', 'guest-9', 'Where is my stay?')).profile;
  assert.deepStrictEqual(other, {}, \`a user without a record has an empty profile, got \${JSON.stringify(other)}\`);
}

export async function check_retriever_cache(ctx) {
  const {m, config} = store(ctx);
  const question = 'How do I change my check-in time?';
  const first = [...(await m.assemble('t1', 'c-1', 'guest-1', question)).articles];
  assert.deepStrictEqual(first, [\`Help article for: \${question}\`], \`the articles must be what help_articles returned, got \${JSON.stringify(first)}\`);
  const again = [...(await m.assemble('t1', 'c-1', 'guest-1', question)).articles];
  assert.deepStrictEqual(again, first, \`the cached articles must equal the retrieved ones: \${JSON.stringify(again)}\`);
  const calls = ctx.grpc.callsTo('Retrieve').length;
  assert.equal(calls, 1, \`two assemblies of the same question made \${calls} Retrieve calls: cache the answer under config.retrieverKey for RETRIEVER_TTL_S = 300 s\`);
  const key = config.retrieverKey('t1', 'help_articles', question);
  const ttl = ctx.redis.ttl(key);
  assert(ttl > 0 && ttl <= 300, \`the cached answer at \${key} has TTL \${ttl}, expected at most 300 s\`);
  ctx.clock.advance(301);
  await m.assemble('t1', 'c-1', 'guest-1', question);
  assert.equal(ctx.grpc.callsTo('Retrieve').length, 2, 'five minutes later the cached answer has expired and the retriever is asked again');
  await m.assemble('t1', 'c-1', 'guest-1', 'Can I bring a dog?');
  assert.equal(ctx.grpc.callsTo('Retrieve').length, 3, 'a new question is a new retrieval');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"

	"apv2/config"
	pb "apv2/gen/support_automation"
	"apv2/model"
	"apv2/standins"

	"leetbuild/harness"
)

type retrieverPeer struct {
	pb.UnimplementedContextRetrieverServer
}

func (retrieverPeer) Retrieve(_ context.Context, req *pb.RetrieveRequest) (*pb.RetrieveReply, error) {
	return &pb.RetrieveReply{Items: standins.Retrieve(req.GetRetriever(), req.GetQuestion())}, nil
}

func storeWorld(ctx *harness.Ctx) {
	pb.RegisterContextRetrieverServer(ctx.GRPC.Server(config.Retriever), retrieverPeer{})
}

func storeAppend(ctx *harness.Ctx, tenant, conversation, kind, text string) {
	ctx.NoError(appendItem(context.Background(), tenant, conversation, model.Item{Kind: kind, Text: text}), "appendItem(%s, %s)", tenant, conversation)
}

func storeAssemble(ctx *harness.Ctx, user, question string) model.Context {
	c, err := assemble(context.Background(), "t1", "c-1", user, question)
	ctx.NoError(err, "assemble(t1, c-1)")
	return c
}

func storeLists(ctx *harness.Ctx) map[string]int64 {
	out := map[string]int64{}
	for _, key := range ctx.Redis.Keys("ctx:*") {
		if ctx.Redis.Type(key) == "list" {
			out[key] = ctx.Redis.LLen(key)
		}
	}
	return out
}

func storeTexts(ctx *harness.Ctx, key string) []string {
	out := []string{}
	for _, raw := range ctx.Redis.LRange(key, 0, -1) {
		var item map[string]any
		json.Unmarshal([]byte(raw), &item)
		text, _ := item["text"].(string)
		out = append(out, text)
	}
	return out
}

func CheckScopedKey(ctx *harness.Ctx) {
	storeWorld(ctx)
	storeAppend(ctx, "t1", "c-1", "user", "t1 c-1 first")
	storeAppend(ctx, "t2", "c-1", "user", "t2 c-1 first")
	storeAppend(ctx, "t1", "c-1", "assistant", "t1 c-1 second")
	storeAppend(ctx, "t1", "c-2", "user", "t1 c-2 first")
	lists := storeLists(ctx)
	keys := make([]string, 0, len(lists))
	for k := range lists {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	ctx.Equal(keys, []string{"ctx:t1:c-1", "ctx:t1:c-2", "ctx:t2:c-1"}, "context lives in one list per conversation, under ctx:{tenant}:{conversation}, so an assembly reads one conversation and tenants never share a key; the lists appendItem wrote")
	ctx.Equal(storeTexts(ctx, "ctx:t1:c-1"), []string{"t1 c-1 first", "t1 c-1 second"}, "ctx:t1:c-1")
	ctx.Equal(storeTexts(ctx, "ctx:t2:c-1"), []string{"t2 c-1 first"}, "another tenant's conversation with the same id is another list; ctx:t2:c-1")
	history := storeAssemble(ctx, "guest-1", "Where is my stay?").History
	ctx.Equal(history, []model.Item{{Kind: "user", Text: "t1 c-1 first"}, {Kind: "assistant", Text: "t1 c-1 second"}}, "assemble(t1, c-1)'s history")
}

func CheckBounded(ctx *harness.Ctx) {
	storeWorld(ctx)
	for i := 1; i <= 45; i++ {
		storeAppend(ctx, "t1", "c-1", "user", "message "+harness.Show(i))
	}
	lists := storeLists(ctx)
	longest := int64(-1)
	for _, n := range lists {
		if n > longest {
			longest = n
		}
	}
	ctx.Assert(longest >= 0 && longest <= 40, "after 45 appends the context lists hold %v: trim to the newest maxContextItems = 40, or every turn re-sends a longer prompt", lists)
	history := storeAssemble(ctx, "guest-1", "q").History
	ctx.Equal(len(history), 40, "assemble must return the newest 40 items; items returned")
	ctx.Assert(history[0].Text == "message 6" && history[39].Text == "message 45", "assemble must return items 6 to 45, oldest first; got %q … %q", history[0].Text, history[len(history)-1].Text)
	probe := ctx.Redis.After("ctx:t1:c-1", func() any {
		return []int64{ctx.Redis.LLen("ctx:t1:c-1"), ctx.Redis.TTL("ctx:t1:c-1")}
	})
	storeAppend(ctx, "t1", "c-1", "user", "message 46")
	ctx.Assert(probe.Fired, "appendItem never wrote ctx:t1:c-1")
	seen, _ := probe.Result.([]int64)
	ctx.Assert(len(seen) == 2 && seen[0] <= 40, "right after appendItem's first command touched ctx:t1:c-1 the list held %v items: RPush, LTrim and Expire belong in one MULTI/EXEC (TxPipelined), or a reader in between sees an untrimmed list", seen)
	ctx.Assert(seen[1] > 0, "right after appendItem's first command touched ctx:t1:c-1 the list had TTL %d: Expire belongs in the same MULTI/EXEC", seen[1])
}

func CheckTtl(ctx *harness.Ctx) {
	storeWorld(ctx)
	storeAppend(ctx, "t1", "c-1", "user", "hello")
	ttls := map[string]int64{}
	for key := range storeLists(ctx) {
		ttls[key] = ctx.Redis.TTL(key)
	}
	ttl, ok := ttls["ctx:t1:c-1"]
	ctx.Assert(ok && ttl > 86_000, "after appendItem the context lists have TTLs %v: every write refreshes a 24-hour TTL (contextTTL) on ctx:t1:c-1, or a conversation's context outlives it by years", ttls)
	ctx.Clock.Advance(3600)
	storeAppend(ctx, "t1", "c-1", "assistant", "hi")
	ttl = ctx.Redis.TTL("ctx:t1:c-1")
	ctx.Assert(ttl > 86_000, "an hour later another append left TTL %d: each write refreshes the 24 hours", ttl)
	ctx.Clock.Advance(86_401)
	ctx.Equal(ctx.Redis.Exists("ctx:t1:c-1"), 0, "a day after the last write the conversation's context must be gone; ctx:t1:c-1 exists")
}

func CheckDeclared(ctx *harness.Ctx) {
	ctx.Redis.Do("HSET", "profile:t1:guest-1", "customer_name", "Ana Souza", "user_role", "guest", "current_trip", "HM-4410 Lisbon", "email", "ana@example.com", "phone", "+351 912 000 111", "payment_last4", "4242")
	storeWorld(ctx)
	profile := storeAssemble(ctx, "guest-1", "Where is my stay?").Profile
	fields := make([]string, 0, len(profile))
	for k := range profile {
		fields = append(fields, k)
	}
	sort.Strings(fields)
	ctx.Equal(fields, []string{"current_trip", "customer_name", "user_role"}, "only staticContext is declared, so email, phone and payment_last4 must not reach the model; the profile's fields")
	ctx.Assert(profile["customer_name"] == "Ana Souza" && profile["current_trip"] == "HM-4410 Lisbon", "the declared fields carry the record's values: %v", profile)
	other := storeAssemble(ctx, "guest-9", "Where is my stay?").Profile
	ctx.Equal(len(other), 0, "a user without a record has an empty profile; fields")
}

func CheckRetrieverCache(ctx *harness.Ctx) {
	storeWorld(ctx)
	question := "How do I change my check-in time?"
	first := storeAssemble(ctx, "guest-1", question).Articles
	ctx.Equal(first, []string{"Help article for: " + question}, "the articles must be what help_articles returned")
	again := storeAssemble(ctx, "guest-1", question).Articles
	ctx.Equal(again, first, "the cached articles must equal the retrieved ones")
	ctx.Equal(len(ctx.GRPC.CallsTo("Retrieve", "")), 1, "two assemblies of the same question: cache the answer under config.RetrieverKey for retrieverTTL = 300 s; Retrieve calls")
	key := config.RetrieverKey("t1", "help_articles", question)
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(ttl > 0 && ttl <= 300, "the cached answer at %s has TTL %d, expected at most 300 s", key, ttl)
	ctx.Clock.Advance(301)
	storeAssemble(ctx, "guest-1", question)
	ctx.Equal(len(ctx.GRPC.CallsTo("Retrieve", "")), 2, "five minutes later the cached answer has expired and the retriever is asked again; Retrieve calls")
	storeAssemble(ctx, "guest-1", "Can I bring a dog?")
	ctx.Equal(len(ctx.GRPC.CallsTo("Retrieve", "")), 3, "a new question is a new retrieval; Retrieve calls")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <vector>

#include "apv2/standins.h"

namespace {

using json = nlohmann::json;

class RetrieverPeer final : public apv2rpc::ContextRetriever::Service {
 public:
  grpc::Status Retrieve(grpc::ServerContext*, const apv2rpc::RetrieveRequest* req, apv2rpc::RetrieveReply* reply) override {
    for (const auto& item : standins::retrieve(req->retriever(), req->question())) reply->add_items(item);
    return grpc::Status::OK;
  }
};

void storeWorld(harness::Ctx& ctx) {
  static RetrieverPeer peer;
  ctx.GRPC.Server(config::kRetriever)->RegisterService(&peer);
}

std::map<std::string, long long> storeLists(harness::Ctx& ctx) {
  std::map<std::string, long long> out;
  for (const auto& key : ctx.Redis.Keys("ctx:*")) {
    if (ctx.Redis.Type(key) == "list") out[key] = ctx.Redis.LLen(key);
  }
  return out;
}

std::vector<std::string> storeTexts(harness::Ctx& ctx, const std::string& key) {
  std::vector<std::string> out;
  for (const auto& raw : ctx.Redis.LRange(key, 0, -1)) out.push_back(json::parse(raw, nullptr, false).value("text", ""));
  return out;
}

std::string describe(const std::map<std::string, long long>& m) {
  std::string out = "{";
  for (const auto& [k, v] : m) out += (out.size() > 1 ? ", " : "") + k + ": " + std::to_string(v);
  return out + "}";
}

}  // namespace

void CheckScopedKey(harness::Ctx& ctx) {
  storeWorld(ctx);
  append_item("t1", "c-1", {"user", "t1 c-1 first"});
  append_item("t2", "c-1", {"user", "t2 c-1 first"});
  append_item("t1", "c-1", {"assistant", "t1 c-1 second"});
  append_item("t1", "c-2", {"user", "t1 c-2 first"});
  const auto lists = storeLists(ctx);
  std::vector<std::string> keys;
  for (const auto& [k, _] : lists) keys.push_back(k);
  ctx.Equal(keys, std::vector<std::string>{"ctx:t1:c-1", "ctx:t1:c-2", "ctx:t2:c-1"},
            "context lives in one list per conversation, under ctx:{tenant}:{conversation}, so an assembly reads one conversation and tenants never share a key; the lists append_item wrote");
  ctx.Equal(storeTexts(ctx, "ctx:t1:c-1"), std::vector<std::string>{"t1 c-1 first", "t1 c-1 second"}, "ctx:t1:c-1");
  ctx.Equal(storeTexts(ctx, "ctx:t2:c-1"), std::vector<std::string>{"t2 c-1 first"}, "another tenant's conversation with the same id is another list; ctx:t2:c-1");
  const auto history = assemble("t1", "c-1", "guest-1", "Where is my stay?").history;
  ctx.Assert(history.size() == 2 && history[0].kind == "user" && history[0].text == "t1 c-1 first" && history[1].kind == "assistant" && history[1].text == "t1 c-1 second",
             "assemble(t1, c-1) must return the conversation's two items, got %d", history.size());
}

void CheckBounded(harness::Ctx& ctx) {
  storeWorld(ctx);
  for (int i = 1; i <= 45; i++) append_item("t1", "c-1", {"user", "message " + std::to_string(i)});
  const auto lists = storeLists(ctx);
  long long longest = -1;
  for (const auto& [_, n] : lists) longest = std::max(longest, n);
  ctx.Assert(longest >= 0 && longest <= 40, "after 45 appends the context lists hold %s: trim to the newest kMaxContextItems = 40, or every turn re-sends a longer prompt", describe(lists));
  const auto history = assemble("t1", "c-1", "guest-1", "q").history;
  ctx.Equal(history.size(), 40, "assemble must return the newest 40 items; items returned");
  ctx.Assert(history.front().text == "message 6" && history.back().text == "message 45", "assemble must return items 6 to 45, oldest first; got %q … %q", history.front().text, history.back().text);
  bool fired = false;
  long long seenLength = -1, seenTtl = -1;
  ctx.Redis.After("ctx:t1:c-1", [&] {
    fired = true;
    seenLength = ctx.Redis.LLen("ctx:t1:c-1");
    seenTtl = ctx.Redis.TTL("ctx:t1:c-1");
  });
  append_item("t1", "c-1", {"user", "message 46"});
  ctx.Assert(fired, "append_item never wrote ctx:t1:c-1");
  ctx.Assert(seenLength <= 40, "right after append_item's first command touched ctx:t1:c-1 the list held %d items: rpush, ltrim and expire belong in one transaction(), or a reader in between sees an untrimmed list", seenLength);
  ctx.Assert(seenTtl > 0, "right after append_item's first command touched ctx:t1:c-1 the list had TTL %d: expire belongs in the same transaction()", seenTtl);
}

void CheckTtl(harness::Ctx& ctx) {
  storeWorld(ctx);
  append_item("t1", "c-1", {"user", "hello"});
  std::map<std::string, long long> ttls;
  for (const auto& [key, _] : storeLists(ctx)) ttls[key] = ctx.Redis.TTL(key);
  ctx.Assert(ttls.count("ctx:t1:c-1") == 1 && ttls["ctx:t1:c-1"] > 86000,
             "after append_item the context lists have TTLs %s: every write refreshes a 24-hour TTL (kContextTtl) on ctx:t1:c-1, or a conversation's context outlives it by years", describe(ttls));
  ctx.Clock.Advance(3600);
  append_item("t1", "c-1", {"assistant", "hi"});
  const long long ttl = ctx.Redis.TTL("ctx:t1:c-1");
  ctx.Assert(ttl > 86000, "an hour later another append left TTL %d: each write refreshes the 24 hours", ttl);
  ctx.Clock.Advance(86401);
  ctx.Equal(ctx.Redis.Exists("ctx:t1:c-1"), 0, "a day after the last write the conversation's context must be gone; ctx:t1:c-1 exists");
}

void CheckDeclared(harness::Ctx& ctx) {
  ctx.Redis.Do("HSET", "profile:t1:guest-1", "customer_name", "Ana Souza", "user_role", "guest", "current_trip", "HM-4410 Lisbon", "email", "ana@example.com", "phone",
               "+351 912 000 111", "payment_last4", "4242");
  storeWorld(ctx);
  const auto profile = assemble("t1", "c-1", "guest-1", "Where is my stay?").profile;
  std::vector<std::string> fields;
  for (const auto& [k, _] : profile) fields.push_back(k);
  ctx.Equal(fields, std::vector<std::string>{"current_trip", "customer_name", "user_role"},
            "only kStaticContext is declared, so email, phone and payment_last4 must not reach the model; the profile's fields");
  ctx.Assert(profile.at("customer_name") == "Ana Souza" && profile.at("current_trip") == "HM-4410 Lisbon", "the declared fields carry the record's values");
  ctx.Equal(assemble("t1", "c-1", "guest-9", "Where is my stay?").profile.size(), 0, "a user without a record has an empty profile; fields");
}

void CheckRetrieverCache(harness::Ctx& ctx) {
  storeWorld(ctx);
  const std::string question = "How do I change my check-in time?";
  const auto first = assemble("t1", "c-1", "guest-1", question).articles;
  ctx.Equal(first, std::vector<std::string>{"Help article for: " + question}, "the articles must be what help_articles returned");
  const auto again = assemble("t1", "c-1", "guest-1", question).articles;
  ctx.Equal(again, first, "the cached articles must equal the retrieved ones");
  ctx.Equal(ctx.GRPC.CallsTo("Retrieve").size(), 1, "two assemblies of the same question: cache the answer under config::retriever_key for kRetrieverTtl = 300 s; Retrieve calls");
  const std::string key = config::retriever_key("t1", "help_articles", question);
  const long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(ttl > 0 && ttl <= 300, "the cached answer at %s has TTL %d, expected at most 300 s", key, ttl);
  ctx.Clock.Advance(301);
  assemble("t1", "c-1", "guest-1", question);
  ctx.Equal(ctx.GRPC.CallsTo("Retrieve").size(), 2, "five minutes later the cached answer has expired and the retriever is asked again; Retrieve calls");
  assemble("t1", "c-1", "guest-1", "Can I bring a dog?");
  ctx.Equal(ctx.GRPC.CallsTo("Retrieve").size(), 3, "a new question is a new retrieval; Retrieve calls");
}
`,
  },
  hints: [
    "Symptom: assembling one guest's context gets slower as the platform grows, a week-old conversation is still in Redis next year, and a prompt log shows a customer's email and card digits beside a help article fetched for the third time in a minute.",
    'Mechanism: every item goes to one global list that is filtered on read and never trimmed or expired; `HGETALL` loads fields nobody declared; and the retriever is called before anyone asks whether the same question was answered a minute ago.',
    'Change: `context_key(tenant, conversation)` with RPUSH, LTRIM -40 -1 and EXPIRE 86400 in one `pipeline(transaction=True)`; `HMGET` the STATIC_CONTEXT fields; GET `retriever_key(...)` first and `SETEX` 300 on a miss.',
  ],
  debrief: `Context is the bill and the privacy boundary of an LLM platform, which is why each fix is a limit. One key per conversation makes an assembly read what it needs and keeps tenants apart by construction. The trim and the TTL run in one \`MULTI\` so no reader ever sees the list between them: the prompt has a fixed ceiling and the data a fixed lifetime. Declared fields turn "what the prompt may contain" into a list a reviewer can read. The retriever cache is keyed by the question, so a repeat costs one GET instead of a search. Production context stores summarise what the trim drops instead of forgetting it, count tokens rather than items, and record which context version each LLM call saw.`,
};
