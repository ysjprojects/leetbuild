import type {Step} from '@/lib/types';

export const glossaryCacheStep: Step = {
  id: 'state',
  title: 'Redis glossary and translation-memory caches',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'glossary'],
  task: `## Task

**Starting point.** The starter is the cache module behind \`POST /v1/translations\`: it caches a
glossary under \`glossary:{pair}\` with no expiry, caches translation-memory hits under
\`tm:{pair}:{text}\`, and adds a term with one \`HSET\` on the live glossary entry. It compiles, the
demo is fast, and it hides five flaws.

**Failure mode the checks target.** Two tenants that share a locale pair share a cache entry, so
tenant B's text is translated with tenant A's terminology; a term update mutates the entry a request
in flight is reading, so one translation applies half of an update; and with no TTL and no version
to bump, the wrong terms stay served until someone flushes Redis by hand.

Requirements:

- Cache keys are scoped by **\`(tenant, source, target, glossary version)\`** for glossaries, and
  by the same tuple plus the source text for translation memory.
- Every entry has a **one-hour TTL** (\`3600\` seconds) set at write time.
- A glossary is **versioned and immutable**. Writing a term bumps the version counter and writes
  under the new version's key instead of mutating the live one, so an in-flight request that pinned
  the old version keeps reading a complete glossary.
- A request resolves its version **once**, through the active-version pointer, and loads a
  read-only snapshot for that version.`,
  sequence: {
    participants: ['Translation API', 'Redis', 'Glossary store'],
    messages: [
      {from: 'Translation API', to: 'Redis', label: 'GET glossary:version:acme:en:fr', kind: 'sync'},
      {from: 'Redis', to: 'Translation API', label: 'v7', kind: 'reply'},
      {from: 'Translation API', to: 'Redis', label: 'GET glossary:acme:en:fr:v7', kind: 'sync'},
      {from: 'Redis', to: 'Translation API', label: 'miss', kind: 'reply'},
      {from: 'Translation API', to: 'Glossary store', label: 'read(acme, en, fr, v7)', kind: 'sync'},
      {from: 'Glossary store', to: 'Translation API', label: 'terms @ v7', kind: 'reply'},
      {from: 'Translation API', to: 'Redis', label: 'SETEX glossary:acme:en:fr:v7 3600 …', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'cache-key',
      title: 'Scopes glossary and translation-memory keys by tenant, pair and version',
      detail:
        'Both key builders take `(tenant, source, target, version)` so a shared locale pair cannot share an entry. The starter keys by locale pair alone.',
      match: {
        python: {all: [/glossary_cache_key/, /tm_cache_key/]},
        typescript: {all: [/glossaryCacheKey/, /tmCacheKey/]},
        go: {all: [/glossaryCacheKey/, /tmCacheKey/]},
        scala: {all: [/glossaryCacheKey/, /tmCacheKey/]},
        cpp: {all: [/glossaryCacheKey/, /tmCacheKey/]},
      },
    },
    {
      id: 'ttl',
      title: 'Expires every cached glossary and TM entry after one hour',
      detail:
        'Entries are written with a **3600**-second TTL. The starter writes them with no expiry, so a superseded glossary or a wrong TM hit outlives the incident.',
      match: {
        python: {all: [/CACHE_TTL_SECONDS/, /3600/]},
        typescript: {all: [/CACHE_TTL_SECONDS/, /3600/]},
        go: {all: [/cacheTtlSeconds/, /3600/]},
        scala: {all: [/CacheTtlSeconds/, /3600/]},
        cpp: {all: [/kCacheTtlSeconds/, /3600/]},
      },
    },
    {
      id: 'version-bump',
      title: 'Publishes glossary changes as a new version, never an in-place edit',
      detail:
        'Editing a term bumps a version **counter** and writes under the new version key. The starter `HSET`s the live entry, so a request in flight can read a half-updated glossary.',
      match: {
        python: {all: [/bump_glossary_version/, /\.incr\(/]},
        typescript: {all: [/bumpGlossaryVersion/, /\.incr\(/]},
        go: {all: [/bumpGlossaryVersion/, /\.Incr\(/]},
        scala: {all: [/bumpGlossaryVersion/, /\.incr\(/]},
        cpp: {all: [/bumpGlossaryVersion/, /\.incr\(/]},
      },
    },
    {
      id: 'active-version',
      title: 'Resolves the active version once, through its pointer',
      detail:
        'A request reads the version **pointer** for `(tenant, source, target)` at its start and pins that value for the rest of the request. The starter has no pointer at all.',
      match: {
        python: {all: [/active_glossary_version/, /GLOSSARY_VERSION_KEY/]},
        typescript: {all: [/activeGlossaryVersion/, /glossaryVersionKey/]},
        go: {all: [/activeGlossaryVersion/, /glossaryVersionKey/]},
        scala: {all: [/activeGlossaryVersion/, /GlossaryVersionKey/]},
        cpp: {all: [/activeGlossaryVersion/, /kGlossaryVersionKey/]},
      },
    },
    {
      id: 'snapshot',
      title: 'Loads an immutable snapshot instead of mutating a live glossary',
      detail:
        'The terms are loaded as a read-only **snapshot** for the pinned version and cached under that version key; nothing edits a glossary another request may be reading (no `HSET` on a live key).',
      match: {
        python: {all: [/load_glossary_snapshot/], none: [/\.hset\(/]},
        typescript: {all: [/loadGlossarySnapshot/], none: [/\.hset\(/]},
        go: {all: [/loadGlossarySnapshot/], none: [/\.HSet\(/]},
        scala: {all: [/loadGlossarySnapshot/], none: [/\.hset\(/]},
        cpp: {all: [/loadGlossarySnapshot/], none: [/\.hset\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class GlossaryStore:
    def read(self, tenant: str, source: str, target: str, version: str) -> list[dict]:
        raise NotImplementedError


glossaries = GlossaryStore()


def cache_key(pair: str) -> str:
    """The key the starter wrote for a locale pair."""
    return f"glossary:{pair}"


def load_glossary(pair: str) -> list[dict]:
    return json.loads(r.get(cache_key(pair)) or "[]")


def add_term(pair: str, source: str, target: str) -> None:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    r.hset(cache_key(pair), source, target)


def tm_lookup(pair: str, text: str) -> str | None:
    return r.get(f"tm:{pair}:{text}")
`,
      solution: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CACHE_TTL_SECONDS = 3600
GLOSSARY_KEY_PREFIX = "glossary"
GLOSSARY_VERSION_KEY = "glossary:version"


class GlossaryStore:
    def read(self, tenant: str, source: str, target: str, version: str) -> list[dict]:
        raise NotImplementedError


glossaries = GlossaryStore()


def glossary_cache_key(tenant: str, source: str, target: str, version: str) -> str:
    return f"{GLOSSARY_KEY_PREFIX}:{tenant}:{source}:{target}:v{version}"


def tm_cache_key(tenant: str, source: str, target: str, version: str) -> str:
    return f"tm:{tenant}:{source}:{target}:v{version}"


def active_glossary_version(tenant: str, source: str, target: str) -> str:
    """The version pointer a request resolves once, at its start."""
    return r.get(f"{GLOSSARY_VERSION_KEY}:{tenant}:{source}:{target}") or "0"


def bump_glossary_version(tenant: str, source: str, target: str) -> str:
    """Publish a new immutable glossary version; the old key is never mutated."""
    return str(r.incr(f"{GLOSSARY_VERSION_KEY}:{tenant}:{source}:{target}"))


def load_glossary_snapshot(tenant: str, source: str, target: str, version: str) -> list[dict]:
    """A read-only snapshot of one immutable version, cached under its own key."""
    key = glossary_cache_key(tenant, source, target, version)
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    terms = glossaries.read(tenant, source, target, version)
    r.setex(key, CACHE_TTL_SECONDS, json.dumps(terms))
    return terms


def remember(tenant: str, source: str, target: str, version: str, text: str, translation: str) -> None:
    r.setex(tm_cache_key(tenant, source, target, version) + ":" + text, CACHE_TTL_SECONDS, translation)


def tm_lookup(tenant: str, source: str, target: str, version: str, text: str) -> str | None:
    return r.get(tm_cache_key(tenant, source, target, version) + ":" + text)
`,
    },
    typescript: {
      starter: `/** The cache module behind POST /v1/translations. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

interface Term {
  source: string;
  target: string;
}

function cacheKey(pair: string): string {
  return 'glossary:' + pair;
}

async function loadGlossary(pair: string): Promise<Term[]> {
  const cached = await r.get(cacheKey(pair));
  return cached === null ? [] : (JSON.parse(cached) as Term[]);
}

async function addTerm(pair: string, source: string, target: string): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  await r.hset(cacheKey(pair), source, target);
}

async function tmLookup(pair: string, text: string): Promise<string | null> {
  return r.get('tm:' + pair + ':' + text);
}
`,
      solution: `/** The glossary and translation-memory caches, scoped by tenant, pair and glossary version. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const CACHE_TTL_SECONDS = 3600;
const GLOSSARY_KEY_PREFIX = 'glossary';
const glossaryVersionKey = 'glossary:version';

interface Term {
  source: string;
  target: string;
}

export function glossaryCacheKey(tenant: string, source: string, target: string, version: string): string {
  return GLOSSARY_KEY_PREFIX + ':' + tenant + ':' + source + ':' + target + ':v' + version;
}

export function tmCacheKey(tenant: string, source: string, target: string, version: string): string {
  return 'tm:' + tenant + ':' + source + ':' + target + ':v' + version;
}

export async function activeGlossaryVersion(tenant: string, source: string, target: string): Promise<string> {
  return (await r.get(glossaryVersionKey + ':' + tenant + ':' + source + ':' + target)) ?? '0';
}

export async function bumpGlossaryVersion(tenant: string, source: string, target: string): Promise<string> {
  const version = await r.incr(glossaryVersionKey + ':' + tenant + ':' + source + ':' + target);
  return String(version);
}

export async function loadGlossarySnapshot(
  tenant: string,
  source: string,
  target: string,
  version: string,
): Promise<Term[]> {
  const key = glossaryCacheKey(tenant, source, target, version);
  const cached = await r.get(key);
  if (cached !== null) return JSON.parse(cached) as Term[];
  const terms = await glossaries.read(tenant, source, target, version);
  await r.set(key, JSON.stringify(terms), 'EX', CACHE_TTL_SECONDS);
  return terms;
}

export async function tmLookup(
  tenant: string,
  source: string,
  target: string,
  version: string,
  text: string,
): Promise<string | null> {
  return r.get(tmCacheKey(tenant, source, target, version) + ':' + text);
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

type Term struct {
	Source string
	Target string
}

type GlossaryStore struct{}

func (s *GlossaryStore) Read(ctx context.Context, tenant, source, target, version string) ([]Term, error) {
	return nil, nil
}

var glossaries = &GlossaryStore{}

func cacheKey(pair string) string {
	return "glossary:" + pair
}

func loadGlossary(ctx context.Context, pair string) ([]Term, error) {
	cached, err := rdb.Get(ctx, cacheKey(pair)).Result()
	if err != nil {
		return nil, nil
	}
	var terms []Term
	return terms, json.Unmarshal([]byte(cached), &terms)
}

func addTerm(ctx context.Context, pair, source, target string) error {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	return rdb.HSet(ctx, cacheKey(pair), source, target).Err()
}

func tmLookup(ctx context.Context, pair, text string) (string, bool) {
	value, err := rdb.Get(ctx, "tm:"+pair+":"+text).Result()
	return value, err == nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	cacheTtlSeconds    = 3600
	glossaryKeyPrefix  = "glossary"
	glossaryVersionKey = "glossary:version"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Term struct {
	Source string
	Target string
}

type GlossaryStore struct{}

func (s *GlossaryStore) Read(ctx context.Context, tenant, source, target, version string) ([]Term, error) {
	return nil, nil
}

var glossaries = &GlossaryStore{}

func glossaryCacheKey(tenant, source, target, version string) string {
	return glossaryKeyPrefix + ":" + tenant + ":" + source + ":" + target + ":v" + version
}

func tmCacheKey(tenant, source, target, version string) string {
	return "tm:" + tenant + ":" + source + ":" + target + ":v" + version
}

func activeGlossaryVersion(ctx context.Context, tenant, source, target string) string {
	version, err := rdb.Get(ctx, glossaryVersionKey+":"+tenant+":"+source+":"+target).Result()
	if err != nil {
		return "0"
	}
	return version
}

func bumpGlossaryVersion(ctx context.Context, tenant, source, target string) (string, error) {
	version, err := rdb.Incr(ctx, glossaryVersionKey+":"+tenant+":"+source+":"+target).Result()
	if err != nil {
		return "", err
	}
	return strconv.FormatInt(version, 10), nil
}

func loadGlossarySnapshot(ctx context.Context, tenant, source, target, version string) ([]Term, error) {
	key := glossaryCacheKey(tenant, source, target, version)
	if cached, err := rdb.Get(ctx, key).Result(); err == nil {
		var terms []Term
		if err := json.Unmarshal([]byte(cached), &terms); err != nil {
			return nil, err
		}
		return terms, nil
	}
	terms, err := glossaries.Read(ctx, tenant, source, target, version)
	if err != nil {
		return nil, err
	}
	blob, err := json.Marshal(terms)
	if err != nil {
		return nil, err
	}
	if err := rdb.SetEx(ctx, key, blob, time.Duration(cacheTtlSeconds)*time.Second).Err(); err != nil {
		return nil, err
	}
	return terms, nil
}

func tmLookup(ctx context.Context, tenant, source, target, version, text string) (string, bool) {
	value, err := rdb.Get(ctx, tmCacheKey(tenant, source, target, version)+":"+text).Result()
	if err != nil {
		return "", false
	}
	return value, true
}
`,
    },
    scala: {
      starter: `import spray.json._

final case class Term(source: String, target: String)

object GlossaryCache {
  def cacheKey(pair: String): String = "glossary:" + pair

  def loadGlossary(pair: String): List[Term] =
    redis.get(cacheKey(pair)).map(_.parseJson.convertTo[List[Term]]).getOrElse(Nil)

  def addTerm(pair: String, source: String, target: String): Unit = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    redis.hset(cacheKey(pair), source, target)
  }

  def tmLookup(pair: String, text: String): Option[String] =
    redis.get("tm:" + pair + ":" + text)
}
`,
      solution: `import spray.json._

final case class Term(source: String, target: String)

object GlossaryCache {
  val CacheTtlSeconds = 3600
  val GlossaryKeyPrefix = "glossary"
  val GlossaryVersionKey = "glossary:version"

  def glossaryCacheKey(tenant: String, source: String, target: String, version: String): String =
    GlossaryKeyPrefix + ":" + tenant + ":" + source + ":" + target + ":v" + version

  def tmCacheKey(tenant: String, source: String, target: String, version: String): String =
    "tm:" + tenant + ":" + source + ":" + target + ":v" + version

  def activeGlossaryVersion(tenant: String, source: String, target: String): String =
    redis.get(GlossaryVersionKey + ":" + tenant + ":" + source + ":" + target).getOrElse("0")

  def bumpGlossaryVersion(tenant: String, source: String, target: String): String =
    redis.incr(GlossaryVersionKey + ":" + tenant + ":" + source + ":" + target).toString

  def loadGlossarySnapshot(tenant: String, source: String, target: String, version: String): List[Term] = {
    val key = glossaryCacheKey(tenant, source, target, version)
    redis.get(key) match {
      case Some(cached) => cached.parseJson.convertTo[List[Term]]
      case None =>
        val terms = glossaries.read(tenant, source, target, version)
        redis.setex(key, CacheTtlSeconds, terms.toJson.compactPrint)
        terms
    }
  }

  def tmLookup(tenant: String, source: String, target: String, version: String, text: String): Option[String] =
    redis.get(tmCacheKey(tenant, source, target, version) + ":" + text)
}
`,
    },
    cpp: {
      starter: `#include <optional>
#include <string>
#include <vector>

struct Term {
  std::string source;
  std::string target;
};

std::string cacheKey(const std::string& pair) { return "glossary:" + pair; }

std::vector<Term> loadGlossary(const std::string& pair) {
  auto cached = redis.get(cacheKey(pair));
  return cached ? parseTerms(*cached) : std::vector<Term>{};
}

void addTerm(const std::string& pair, const std::string& source, const std::string& target) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  redis.hset(cacheKey(pair), source, target);
}

std::optional<std::string> tmLookup(const std::string& pair, const std::string& text) {
  return redis.get("tm:" + pair + ":" + text);
}
`,
      solution: `#include <optional>
#include <string>
#include <vector>

struct Term {
  std::string source;
  std::string target;
};

constexpr int kCacheTtlSeconds = 3600;
const std::string kGlossaryKeyPrefix = "glossary";
const std::string kGlossaryVersionKey = "glossary:version";

std::string glossaryCacheKey(const std::string& tenant, const std::string& source, const std::string& target,
                             const std::string& version) {
  return kGlossaryKeyPrefix + ":" + tenant + ":" + source + ":" + target + ":v" + version;
}

std::string tmCacheKey(const std::string& tenant, const std::string& source, const std::string& target,
                       const std::string& version) {
  return "tm:" + tenant + ":" + source + ":" + target + ":v" + version;
}

std::string activeGlossaryVersion(const std::string& tenant, const std::string& source, const std::string& target) {
  auto value = redis.get(kGlossaryVersionKey + ":" + tenant + ":" + source + ":" + target);
  return value ? *value : "0";
}

std::string bumpGlossaryVersion(const std::string& tenant, const std::string& source, const std::string& target) {
  return std::to_string(redis.incr(kGlossaryVersionKey + ":" + tenant + ":" + source + ":" + target));
}

std::vector<Term> loadGlossarySnapshot(const std::string& tenant, const std::string& source,
                                       const std::string& target, const std::string& version) {
  const auto key = glossaryCacheKey(tenant, source, target, version);
  if (auto cached = redis.get(key)) return parseTerms(*cached);
  auto terms = glossaries.read(tenant, source, target, version);
  redis.setex(key, kCacheTtlSeconds, serializeTerms(terms));
  return terms;
}

std::optional<std::string> tmLookup(const std::string& tenant, const std::string& source,
                                    const std::string& target, const std::string& version,
                                    const std::string& text) {
  return redis.get(tmCacheKey(tenant, source, target, version) + ":" + text);
}
`,
    },
  },
  hints: [
    "Tenant B files a ticket: their French output uses tenant A's product names. While you look, a term edit lands and a request in flight returns a glossary with half the update applied.",
    'The key is `glossary:{pair}`, so every tenant on `en:fr` reads one entry; `add_term` runs `HSET` on that live entry; nothing sets an expiry and there is no version to pin or bump.',
    'Key by `(tenant, source, target, version)`, write with `SETEX … 3600`, publish edits by `INCR` on the version pointer then write under the new key; resolve that pointer once per request into a snapshot.',
  ],
  debrief: `The key carries the tenant and the version because a cache key is an isolation boundary: whatever is left out of the key is shared by everyone who hits it. Versions are immutable so that a reader never observes a write in progress; the counter is the only mutable thing, and bumping it makes every old entry unreachable in the same operation that publishes the new one, with no deletes to race. The TTL is the backstop for everything the version scheme does not cover, such as a wrong TM hit. Production caches also keep a negative entry for unknown versions, cap memory per tenant, and run a reconciler that compares the pointer with the stored blobs so a failed write cannot leave a dangling version.`,
};
