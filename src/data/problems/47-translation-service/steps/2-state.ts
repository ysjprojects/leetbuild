import type {Step} from '@/lib/types';

export const glossaryStateStep: Step = {
  id: 'state',
  title: 'Glossary versions and translation memory in Redis',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the glossary state every request goes through:
\`publish_terms(tenant, source, target, changes)\` writes the changes into the hash of the version
\`glossary:{tenant}:{source}:{target}:active\` names, \`resolve_glossary\` loads a version's terms
(the active one when no version is pinned), and \`tm_get\`/\`tm_put\` keep translation memory under
\`tm:{source}:{target}:{sha256(text)}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Tenant B is served tenant A's translation of the same sentence;
a translation made under last quarter's glossary is served forever; a glossary edit rewrites the
version a request in flight pinned; and an edit landing mid-read labels the old terms with the new
version number.

- \`tm_key\` is \`tm:{tenant}:{source}:{target}:v{version}:{sha256(text)}\`, and \`tm_put\` sets
  \`TM_TTL_S\` = 3600 s.
- A version is immutable. \`publish_terms\` copies the active terms, applies the changes under the
  next number from \`:seq\` and moves \`:active\`, in one Lua script, so two editors publishing at
  once both land.
- \`resolve_glossary\` reads \`:active\` once and loads exactly that version; a version or tenant
  with no glossary is \`None\`.`,
  sequence: {
    participants: ['Translation API', 'Redis'],
    messages: [
      {
        from: 'Translation API',
        to: 'Redis',
        label: 'EVAL publish: INCR :seq · HGETALL active · HSET v{n+1} · SET :active',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Translation API', label: 'n+1', kind: 'reply'},
      {from: 'Translation API', to: 'Redis', label: 'GET :active (once) → HGETALL v{n}', kind: 'sync'},
      {from: 'Redis', to: 'Translation API', label: '{version: n, terms}', kind: 'reply'},
      {from: 'Translation API', to: 'Redis', label: 'SET tm:{tenant}:{pair}:v{n}:{sha} EX 3600', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'tm-key',
      title: 'Keys translation memory by tenant and glossary version',
      detail:
        'A translation-memory entry lives under `tm:{tenant}:{source}:{target}:v{version}:{sha256(text)}`: another tenant, or another glossary version, never reads it. The starter keys it by the pair and the text alone.',
      match: {
        python: {all: [/f["']tm:\{tenant\}:\{source\}:\{target\}:v\{version\}:/]},
        typescript: {all: [/`tm:\$\{tenant\}:\$\{source\}:\$\{target\}:v\$\{version\}:/]},
        go: {all: [/"tm:%s:%s:%s:v%d:%s",\s*tenant,\s*source,\s*target,\s*version/]},
        scala: {all: [/s"tm:\$tenant:\$source:\$target:v\$version:/]},
        cpp: {
          all: [
            /"tm:"\s*\+\s*tenant\s*\+\s*":"\s*\+\s*source\s*\+\s*":"\s*\+\s*target\s*\+\s*":v"\s*\+\s*std::to_string\(version\)/,
          ],
        },
      },
    },
    {
      id: 'tm-ttl',
      title: 'Expires translation memory after an hour',
      detail:
        '`tm_put` writes the entry with `TM_TTL_S` = 3600 s, so a wrong entry ages out instead of waiting for someone to flush Redis. The starter writes it with no expiry.',
      match: {
        python: {all: [/TM_TTL_S\s*=\s*3600\b/, /ex\s*=\s*TM_TTL_S/]},
        typescript: {all: [/TM_TTL_S\s*=\s*3600\b/, /['"]EX['"],\s*TM_TTL_S/]},
        go: {all: [/tmTTL\s*=\s*(time\.Hour|3600\s*\*\s*time\.Second)/, /\.Set\([^\n]*tmTTL\)/]},
        scala: {all: [/TmTtlSeconds\s*=\s*3600L?\b/, /\.ex\(\s*TmTtlSeconds\s*\)/]},
        cpp: {all: [/kTmTtl\{3600\}/, /\.set\([^\n]*kTmTtl\)/]},
      },
    },
    {
      id: 'new-version',
      title: 'Publishes an edit as the next version, in one script',
      detail:
        'One Lua script mints the next version (`INCR` on `:seq`), copies the active terms (`HGETALL`), applies the changes and moves `:active`; no code writes into an existing version. The starter `HSET`s the changes into the active version.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /INCR/, /HGETALL/], none: [/r\.hset\(\s*glossary_key/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /INCR/, /HGETALL/], none: [/\.hset\(\s*glossaryKey/]},
        go: {all: [/redis\.NewScript\(/, /INCR/, /HGETALL/], none: [/\.HSet\(ctx,\s*glossaryKey/]},
        scala: {all: [/jedis\.eval\(/, /INCR/, /HGETALL/], none: [/jedis\.hset\(\s*glossaryKey/]},
        cpp: {all: [/redis\.eval<[^>]*>\(/, /INCR/, /HGETALL/], none: [/redis\.hset\(\s*glossaryKey/]},
      },
    },
    {
      id: 'pointer-once',
      title: 'Reads the active pointer once per resolve',
      detail:
        "`resolve_glossary` reads `:active` once and returns the version it loaded, so an edit landing mid-read cannot pair one version number with another version's terms. The starter calls `active_version()` twice.",
      match: {
        python: {
          all: [/def resolve_glossary/],
          none: [/def resolve_glossary(?:(?!\ndef )[\s\S])*?active_version\((?:(?!\ndef )[\s\S])*?active_version\(/],
        },
        typescript: {
          all: [/function resolveGlossary/],
          none: [/function resolveGlossary(?:(?!\n\})[\s\S])*?activeVersion\((?:(?!\n\})[\s\S])*?activeVersion\(/],
        },
        go: {
          all: [/func resolveGlossary/],
          none: [/func resolveGlossary(?:(?!\n\})[\s\S])*?activeVersion\((?:(?!\n\})[\s\S])*?activeVersion\(/],
        },
        scala: {
          all: [/def resolveGlossary/],
          none: [
            /def resolveGlossary(?:(?!\n {2}def |\n {2}\/\*\*)[\s\S])*?activeVersion\((?:(?!\n {2}def |\n {2}\/\*\*)[\s\S])*?activeVersion\(/,
          ],
        },
        cpp: {
          all: [/resolveGlossary\(/],
          none: [
            /std::optional<Glossary> resolveGlossary\((?:(?!\n\})[\s\S])*?activeVersion\((?:(?!\n\})[\s\S])*?activeVersion\(/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from translate.text import sha256_hex

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def glossary_key(tenant: str, source: str, target: str, version) -> str:
    return f"glossary:{tenant}:{source}:{target}:v{version}"


def pointer_key(tenant: str, source: str, target: str) -> str:
    return f"glossary:{tenant}:{source}:{target}:active"


def seq_key(tenant: str, source: str, target: str) -> str:
    return f"glossary:{tenant}:{source}:{target}:seq"


def tm_key(tenant: str, source: str, target: str, version: int, text: str) -> str:
    return f"tm:{source}:{target}:{sha256_hex(text)}"


def active_version(tenant: str, source: str, target: str) -> int | None:
    value = r.get(pointer_key(tenant, source, target))
    return int(value) if value is not None else None


def publish_terms(tenant: str, source: str, target: str, changes: dict[str, str]) -> int:
    """Publish the active terms plus changes and make them active; returns the version."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    version = active_version(tenant, source, target) or r.incr(seq_key(tenant, source, target))
    r.hset(glossary_key(tenant, source, target, version), mapping=changes)
    r.set(pointer_key(tenant, source, target), version)
    return version


def resolve_glossary(tenant: str, source: str, target: str, version: int | None = None) -> dict | None:
    """{"version", "terms"} of the pinned version, or of the active one when version is None; None when there is none."""
    terms = r.hgetall(glossary_key(tenant, source, target, version or active_version(tenant, source, target)))
    if not terms:
        return None
    return {"version": version or active_version(tenant, source, target), "terms": terms}


def tm_get(tenant: str, source: str, target: str, version: int, text: str) -> str | None:
    return r.get(tm_key(tenant, source, target, version, text))


def tm_put(tenant: str, source: str, target: str, version: int, text: str, translation: str) -> None:
    r.set(tm_key(tenant, source, target, version, text), translation)
`,
      solution: `import redis

from translate.text import sha256_hex

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TM_TTL_S = 3600

# Copy the active version into the next one, apply the changes, move the pointer: one atomic step,
# so two editors publishing at once both land and a version, once written, is never edited.
PUBLISH_LUA = """
local active = redis.call('GET', KEYS[2])
local version = string.format('%d', redis.call('INCR', KEYS[1]))
local key = ARGV[1] .. version
if active then
  local terms = redis.call('HGETALL', ARGV[1] .. active)
  for i = 1, #terms, 2 do
    redis.call('HSET', key, terms[i], terms[i + 1])
  end
end
for i = 2, #ARGV, 2 do
  redis.call('HSET', key, ARGV[i], ARGV[i + 1])
end
redis.call('SET', KEYS[2], version)
return tonumber(version)
"""
publish = r.register_script(PUBLISH_LUA)


def glossary_key(tenant: str, source: str, target: str, version) -> str:
    return f"glossary:{tenant}:{source}:{target}:v{version}"


def pointer_key(tenant: str, source: str, target: str) -> str:
    return f"glossary:{tenant}:{source}:{target}:active"


def seq_key(tenant: str, source: str, target: str) -> str:
    return f"glossary:{tenant}:{source}:{target}:seq"


def tm_key(tenant: str, source: str, target: str, version: int, text: str) -> str:
    # The tenant and the glossary version are part of what a translation was made with.
    return f"tm:{tenant}:{source}:{target}:v{version}:{sha256_hex(text)}"


def active_version(tenant: str, source: str, target: str) -> int | None:
    value = r.get(pointer_key(tenant, source, target))
    return int(value) if value is not None else None


def publish_terms(tenant: str, source: str, target: str, changes: dict[str, str]) -> int:
    """Publish the active terms plus changes as the next version and make it active; returns the version."""
    pairs = [part for term in sorted(changes) for part in (term, changes[term])]
    keys = [seq_key(tenant, source, target), pointer_key(tenant, source, target)]
    return int(publish(keys=keys, args=[glossary_key(tenant, source, target, ""), *pairs]))


def resolve_glossary(tenant: str, source: str, target: str, version: int | None = None) -> dict | None:
    """{"version", "terms"} of the pinned version, or of the active one when version is None; None when there is none."""
    if version is None:
        version = active_version(tenant, source, target)  # one read: the request is pinned to it
        if version is None:
            return None
    terms = r.hgetall(glossary_key(tenant, source, target, version))
    return {"version": version, "terms": terms} if terms else None


def tm_get(tenant: str, source: str, target: str, version: int, text: str) -> str | None:
    return r.get(tm_key(tenant, source, target, version, text))


def tm_put(tenant: str, source: str, target: str, version: int, text: str, translation: str) -> None:
    r.set(tm_key(tenant, source, target, version, text), translation, ex=TM_TTL_S)
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {sha256Hex} from 'translate/text';

const redis = new Redis({host: 'redis', port: 6379});

export interface Glossary {
  version: number;
  terms: Record<string, string>;
}

export const glossaryKey = (tenant: string, source: string, target: string, version: number | string): string =>
  \`glossary:\${tenant}:\${source}:\${target}:v\${version}\`;
export const pointerKey = (tenant: string, source: string, target: string): string => \`glossary:\${tenant}:\${source}:\${target}:active\`;
export const seqKey = (tenant: string, source: string, target: string): string => \`glossary:\${tenant}:\${source}:\${target}:seq\`;
export const tmKey = (tenant: string, source: string, target: string, version: number, text: string): string =>
  \`tm:\${source}:\${target}:\${sha256Hex(text)}\`;

async function activeVersion(tenant: string, source: string, target: string): Promise<number | null> {
  const value = await redis.get(pointerKey(tenant, source, target));
  return value === null ? null : Number(value);
}

/** Publish the active terms plus changes and make them active; resolves the version. */
export async function publishTerms(tenant: string, source: string, target: string, changes: Record<string, string>): Promise<number> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const version = (await activeVersion(tenant, source, target)) ?? (await redis.incr(seqKey(tenant, source, target)));
  await redis.hset(glossaryKey(tenant, source, target, version), changes);
  await redis.set(pointerKey(tenant, source, target), version);
  return version;
}

/** The pinned version, or the active one when version is null; null when there is none. */
export async function resolveGlossary(tenant: string, source: string, target: string, version: number | null = null): Promise<Glossary | null> {
  const terms = await redis.hgetall(glossaryKey(tenant, source, target, version ?? (await activeVersion(tenant, source, target)) ?? 0));
  if (Object.keys(terms).length === 0) return null;
  return {version: version ?? (await activeVersion(tenant, source, target)) ?? 0, terms};
}

export const tmGet = (tenant: string, source: string, target: string, version: number, text: string): Promise<string | null> =>
  redis.get(tmKey(tenant, source, target, version, text));

export async function tmPut(tenant: string, source: string, target: string, version: number, text: string, translation: string): Promise<void> {
  await redis.set(tmKey(tenant, source, target, version, text), translation);
}
`,
      solution: `import Redis from 'ioredis';

import {sha256Hex} from 'translate/text';

export const TM_TTL_S = 3600;

// Copy the active version into the next one, apply the changes, move the pointer: one atomic step,
// so two editors publishing at once both land and a version, once written, is never edited.
export const PUBLISH_LUA = \`
local active = redis.call('GET', KEYS[2])
local version = string.format('%d', redis.call('INCR', KEYS[1]))
local key = ARGV[1] .. version
if active then
  local terms = redis.call('HGETALL', ARGV[1] .. active)
  for i = 1, #terms, 2 do
    redis.call('HSET', key, terms[i], terms[i + 1])
  end
end
for i = 2, #ARGV, 2 do
  redis.call('HSET', key, ARGV[i], ARGV[i + 1])
end
redis.call('SET', KEYS[2], version)
return tonumber(version)
\`;

interface PublishRedis extends Redis {
  publishTerms(seqKey: string, pointerKey: string, prefix: string, ...pairs: string[]): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as PublishRedis;
redis.defineCommand('publishTerms', {numberOfKeys: 2, lua: PUBLISH_LUA});

export interface Glossary {
  version: number;
  terms: Record<string, string>;
}

export const glossaryKey = (tenant: string, source: string, target: string, version: number | string): string =>
  \`glossary:\${tenant}:\${source}:\${target}:v\${version}\`;
export const pointerKey = (tenant: string, source: string, target: string): string => \`glossary:\${tenant}:\${source}:\${target}:active\`;
export const seqKey = (tenant: string, source: string, target: string): string => \`glossary:\${tenant}:\${source}:\${target}:seq\`;
// The tenant and the glossary version are part of what a translation was made with.
export const tmKey = (tenant: string, source: string, target: string, version: number, text: string): string =>
  \`tm:\${tenant}:\${source}:\${target}:v\${version}:\${sha256Hex(text)}\`;

async function activeVersion(tenant: string, source: string, target: string): Promise<number | null> {
  const value = await redis.get(pointerKey(tenant, source, target));
  return value === null ? null : Number(value);
}

/** Publish the active terms plus changes as the next version and make it active; resolves the version. */
export async function publishTerms(tenant: string, source: string, target: string, changes: Record<string, string>): Promise<number> {
  const pairs = Object.keys(changes)
    .sort()
    .flatMap(term => [term, changes[term]]);
  return Number(await redis.publishTerms(seqKey(tenant, source, target), pointerKey(tenant, source, target), glossaryKey(tenant, source, target, ''), ...pairs));
}

/** The pinned version, or the active one when version is null; null when there is none. */
export async function resolveGlossary(tenant: string, source: string, target: string, version: number | null = null): Promise<Glossary | null> {
  const pinned = version ?? (await activeVersion(tenant, source, target)); // one read: the request is pinned to it
  if (pinned === null) return null;
  const terms = await redis.hgetall(glossaryKey(tenant, source, target, pinned));
  return Object.keys(terms).length > 0 ? {version: pinned, terms} : null;
}

export const tmGet = (tenant: string, source: string, target: string, version: number, text: string): Promise<string | null> =>
  redis.get(tmKey(tenant, source, target, version, text));

export async function tmPut(tenant: string, source: string, target: string, version: number, text: string, translation: string): Promise<void> {
  await redis.set(tmKey(tenant, source, target, version, text), translation, 'EX', TM_TTL_S);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"

	"translate/text" // text.SHA256Hex
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Glossary is one version of a tenant's glossary for a language pair.
type Glossary struct {
	Version int64
	Terms   map[string]string
}

func glossaryKey(tenant, source, target string, version int64) string {
	return fmt.Sprintf("glossary:%s:%s:%s:v%d", tenant, source, target, version)
}

func pointerKey(tenant, source, target string) string {
	return fmt.Sprintf("glossary:%s:%s:%s:active", tenant, source, target)
}

func seqKey(tenant, source, target string) string {
	return fmt.Sprintf("glossary:%s:%s:%s:seq", tenant, source, target)
}

func tmKey(tenant, source, target string, version int64, s string) string {
	return fmt.Sprintf("tm:%s:%s:%s", source, target, text.SHA256Hex(s))
}

// activeVersion is the version :active names, 0 when there is none.
func activeVersion(ctx context.Context, tenant, source, target string) int64 {
	n, _ := strconv.ParseInt(rdb.Get(ctx, pointerKey(tenant, source, target)).Val(), 10, 64)
	return n
}

// publishTerms publishes the active terms plus changes and makes them active.
func publishTerms(ctx context.Context, tenant, source, target string, changes map[string]string) (int64, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	version := activeVersion(ctx, tenant, source, target)
	if version == 0 {
		minted, err := rdb.Incr(ctx, seqKey(tenant, source, target)).Result()
		if err != nil {
			return 0, err
		}
		version = minted
	}
	fields := []any{}
	for term, translation := range changes {
		fields = append(fields, term, translation)
	}
	if err := rdb.HSet(ctx, glossaryKey(tenant, source, target, version), fields...).Err(); err != nil {
		return 0, err
	}
	return version, rdb.Set(ctx, pointerKey(tenant, source, target), version, 0).Err()
}

// resolveGlossary is the pinned version, or the active one when version is 0; nil when there is none.
func resolveGlossary(ctx context.Context, tenant, source, target string, version int64) (*Glossary, error) {
	pinned := version
	if pinned == 0 {
		pinned = activeVersion(ctx, tenant, source, target)
	}
	terms, err := rdb.HGetAll(ctx, glossaryKey(tenant, source, target, pinned)).Result()
	if err != nil {
		return nil, err
	}
	if len(terms) == 0 {
		return nil, nil
	}
	if version == 0 {
		version = activeVersion(ctx, tenant, source, target)
	}
	return &Glossary{Version: version, Terms: terms}, nil
}

// tmGet is the remembered translation, if any.
func tmGet(ctx context.Context, tenant, source, target string, version int64, s string) (string, bool) {
	value, err := rdb.Get(ctx, tmKey(tenant, source, target, version, s)).Result()
	return value, err == nil
}

// tmPut remembers a translation.
func tmPut(ctx context.Context, tenant, source, target string, version int64, s, translation string) error {
	return rdb.Set(ctx, tmKey(tenant, source, target, version, s), translation, 0).Err()
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"translate/text" // text.SHA256Hex
)

const tmTTL = time.Hour

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// publish copies the active version into the next one, applies the changes and moves the pointer:
// one atomic step, so two editors publishing at once both land and a written version never changes.
var publish = redis.NewScript(\`
local active = redis.call('GET', KEYS[2])
local version = string.format('%d', redis.call('INCR', KEYS[1]))
local key = ARGV[1] .. version
if active then
  local terms = redis.call('HGETALL', ARGV[1] .. active)
  for i = 1, #terms, 2 do
    redis.call('HSET', key, terms[i], terms[i + 1])
  end
end
for i = 2, #ARGV, 2 do
  redis.call('HSET', key, ARGV[i], ARGV[i + 1])
end
redis.call('SET', KEYS[2], version)
return tonumber(version)
\`)

// Glossary is one version of a tenant's glossary for a language pair.
type Glossary struct {
	Version int64
	Terms   map[string]string
}

func glossaryKey(tenant, source, target string, version int64) string {
	return fmt.Sprintf("glossary:%s:%s:%s:v%d", tenant, source, target, version)
}

func pointerKey(tenant, source, target string) string {
	return fmt.Sprintf("glossary:%s:%s:%s:active", tenant, source, target)
}

func seqKey(tenant, source, target string) string {
	return fmt.Sprintf("glossary:%s:%s:%s:seq", tenant, source, target)
}

// tmKey: the tenant and the glossary version are part of what a translation was made with.
func tmKey(tenant, source, target string, version int64, s string) string {
	return fmt.Sprintf("tm:%s:%s:%s:v%d:%s", tenant, source, target, version, text.SHA256Hex(s))
}

// activeVersion is the version :active names, 0 when there is none.
func activeVersion(ctx context.Context, tenant, source, target string) int64 {
	n, _ := strconv.ParseInt(rdb.Get(ctx, pointerKey(tenant, source, target)).Val(), 10, 64)
	return n
}

// publishTerms publishes the active terms plus changes as the next version and makes it active.
func publishTerms(ctx context.Context, tenant, source, target string, changes map[string]string) (int64, error) {
	terms := make([]string, 0, len(changes))
	for term := range changes {
		terms = append(terms, term)
	}
	sort.Strings(terms)
	args := []any{fmt.Sprintf("glossary:%s:%s:%s:v", tenant, source, target)}
	for _, term := range terms {
		args = append(args, term, changes[term])
	}
	return publish.Run(ctx, rdb, []string{seqKey(tenant, source, target), pointerKey(tenant, source, target)}, args...).Int64()
}

// resolveGlossary is the pinned version, or the active one when version is 0; nil when there is none.
func resolveGlossary(ctx context.Context, tenant, source, target string, version int64) (*Glossary, error) {
	if version == 0 {
		version = activeVersion(ctx, tenant, source, target) // one read: the request is pinned to it
		if version == 0 {
			return nil, nil
		}
	}
	terms, err := rdb.HGetAll(ctx, glossaryKey(tenant, source, target, version)).Result()
	if err != nil {
		return nil, err
	}
	if len(terms) == 0 {
		return nil, nil
	}
	return &Glossary{Version: version, Terms: terms}, nil
}

// tmGet is the remembered translation, if any.
func tmGet(ctx context.Context, tenant, source, target string, version int64, s string) (string, bool) {
	value, err := rdb.Get(ctx, tmKey(tenant, source, target, version, s)).Result()
	return value, err == nil
}

// tmPut remembers a translation for tmTTL.
func tmPut(ctx context.Context, tenant, source, target string, version int64, s, translation string) error {
	return rdb.Set(ctx, tmKey(tenant, source, target, version, s), translation, tmTTL).Err()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import translate.Text // Text.sha256Hex

object State {
  final case class Pinned(version: Long, terms: Map[String, String])

  val jedis = new JedisPooled("redis", 6379)

  def glossaryKey(tenant: String, source: String, target: String, version: Long): String = s"glossary:$tenant:$source:$target:v$version"
  def pointerKey(tenant: String, source: String, target: String): String = s"glossary:$tenant:$source:$target:active"
  def seqKey(tenant: String, source: String, target: String): String = s"glossary:$tenant:$source:$target:seq"
  def tmKey(tenant: String, source: String, target: String, version: Long, text: String): String =
    s"tm:$source:$target:\${Text.sha256Hex(text)}"

  def activeVersion(tenant: String, source: String, target: String): Option[Long] =
    Option(jedis.get(pointerKey(tenant, source, target))).map(_.toLong)

  /** Publish the active terms plus changes and make them active; returns the version. */
  def publishTerms(tenant: String, source: String, target: String, changes: Map[String, String]): Long = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val version = activeVersion(tenant, source, target).getOrElse(jedis.incr(seqKey(tenant, source, target)).longValue)
    jedis.hset(glossaryKey(tenant, source, target, version), changes.asJava)
    jedis.set(pointerKey(tenant, source, target), version.toString)
    version
  }

  /** The pinned version, or the active one when version is None. */
  def resolveGlossary(tenant: String, source: String, target: String, version: Option[Long] = None): Option[Pinned] = {
    val terms = jedis.hgetAll(glossaryKey(tenant, source, target, version.orElse(activeVersion(tenant, source, target)).getOrElse(0L))).asScala.toMap
    if (terms.isEmpty) None
    else Some(Pinned(version.orElse(activeVersion(tenant, source, target)).getOrElse(0L), terms))
  }

  def tmGet(tenant: String, source: String, target: String, version: Long, text: String): Option[String] =
    Option(jedis.get(tmKey(tenant, source, target, version, text)))

  def tmPut(tenant: String, source: String, target: String, version: Long, text: String, translation: String): Unit =
    jedis.set(tmKey(tenant, source, target, version, text), translation)
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

import translate.Text // Text.sha256Hex

object State {
  final case class Pinned(version: Long, terms: Map[String, String])

  val TmTtlSeconds = 3600L

  /** Copy the active version into the next one, apply the changes, move the pointer: one atomic step. */
  val PublishLua: String = """
local active = redis.call('GET', KEYS[2])
local version = string.format('%d', redis.call('INCR', KEYS[1]))
local key = ARGV[1] .. version
if active then
  local terms = redis.call('HGETALL', ARGV[1] .. active)
  for i = 1, #terms, 2 do
    redis.call('HSET', key, terms[i], terms[i + 1])
  end
end
for i = 2, #ARGV, 2 do
  redis.call('HSET', key, ARGV[i], ARGV[i + 1])
end
redis.call('SET', KEYS[2], version)
return tonumber(version)
"""

  val jedis = new JedisPooled("redis", 6379)

  def glossaryKey(tenant: String, source: String, target: String, version: Long): String = s"glossary:$tenant:$source:$target:v$version"
  def pointerKey(tenant: String, source: String, target: String): String = s"glossary:$tenant:$source:$target:active"
  def seqKey(tenant: String, source: String, target: String): String = s"glossary:$tenant:$source:$target:seq"
  /** The tenant and the glossary version are part of what a translation was made with. */
  def tmKey(tenant: String, source: String, target: String, version: Long, text: String): String =
    s"tm:$tenant:$source:$target:v$version:\${Text.sha256Hex(text)}"

  def activeVersion(tenant: String, source: String, target: String): Option[Long] =
    Option(jedis.get(pointerKey(tenant, source, target))).map(_.toLong)

  /** Publish the active terms plus changes as the next version and make it active; returns the version. */
  def publishTerms(tenant: String, source: String, target: String, changes: Map[String, String]): Long = {
    val args = s"glossary:$tenant:$source:$target:v" +: changes.toSeq.sortBy(_._1).flatMap { case (term, translation) => Seq(term, translation) }
    jedis.eval(PublishLua, List(seqKey(tenant, source, target), pointerKey(tenant, source, target)).asJava, args.asJava).asInstanceOf[java.lang.Long]
  }

  /** The pinned version, or the active one (one read of the pointer) when version is None. */
  def resolveGlossary(tenant: String, source: String, target: String, version: Option[Long] = None): Option[Pinned] =
    version.orElse(activeVersion(tenant, source, target)).flatMap { pinned =>
      val terms = jedis.hgetAll(glossaryKey(tenant, source, target, pinned)).asScala.toMap
      if (terms.isEmpty) None else Some(Pinned(pinned, terms))
    }

  def tmGet(tenant: String, source: String, target: String, version: Long, text: String): Option[String] =
    Option(jedis.get(tmKey(tenant, source, target, version, text)))

  def tmPut(tenant: String, source: String, target: String, version: Long, text: String, translation: String): Unit =
    jedis.set(tmKey(tenant, source, target, version, text), translation, SetParams.setParams().ex(TmTtlSeconds))
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <string>
#include <unordered_map>

#include "translate/text.h"  // text::sha256Hex

sw::redis::Redis redis("tcp://redis:6379");

// One version of a tenant's glossary for a language pair.
struct Glossary {
  long version = 0;
  std::map<std::string, std::string> terms;
};

std::string glossaryKey(const std::string& tenant, const std::string& source, const std::string& target, long version) {
  return "glossary:" + tenant + ":" + source + ":" + target + ":v" + std::to_string(version);
}

std::string pointerKey(const std::string& tenant, const std::string& source, const std::string& target) {
  return "glossary:" + tenant + ":" + source + ":" + target + ":active";
}

std::string seqKey(const std::string& tenant, const std::string& source, const std::string& target) {
  return "glossary:" + tenant + ":" + source + ":" + target + ":seq";
}

std::string tmKey(const std::string& tenant, const std::string& source, const std::string& target, long version, const std::string& s) {
  return "tm:" + source + ":" + target + ":" + text::sha256Hex(s);
}

// The version :active names, 0 when there is none.
long activeVersion(const std::string& tenant, const std::string& source, const std::string& target) {
  const auto value = redis.get(pointerKey(tenant, source, target));
  return value ? std::stol(*value) : 0;
}

// Publish the active terms plus changes and make them active; returns the version.
long publishTerms(const std::string& tenant, const std::string& source, const std::string& target, const std::map<std::string, std::string>& changes) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  long version = activeVersion(tenant, source, target);
  if (version == 0) version = redis.incr(seqKey(tenant, source, target));
  redis.hset(glossaryKey(tenant, source, target, version), changes.begin(), changes.end());
  redis.set(pointerKey(tenant, source, target), std::to_string(version));
  return version;
}

// The pinned version, or the active one when version is 0; none when there is none.
std::optional<Glossary> resolveGlossary(const std::string& tenant, const std::string& source, const std::string& target, long version = 0) {
  const std::unordered_map<std::string, std::string> terms =
      redis.hgetall(glossaryKey(tenant, source, target, version ? version : activeVersion(tenant, source, target)));
  if (terms.empty()) return std::nullopt;
  return Glossary{version ? version : activeVersion(tenant, source, target), std::map<std::string, std::string>(terms.begin(), terms.end())};
}

std::optional<std::string> tmGet(const std::string& tenant, const std::string& source, const std::string& target, long version, const std::string& s) {
  return redis.get(tmKey(tenant, source, target, version, s));
}

void tmPut(const std::string& tenant, const std::string& source, const std::string& target, long version, const std::string& s, const std::string& translation) {
  redis.set(tmKey(tenant, source, target, version, s), translation);
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "translate/text.h"  // text::sha256Hex

constexpr std::chrono::seconds kTmTtl{3600};

// Copy the active version into the next one, apply the changes, move the pointer: one atomic step,
// so two editors publishing at once both land and a written version never changes.
const std::string kPublishLua = R"lua(
local active = redis.call('GET', KEYS[2])
local version = string.format('%d', redis.call('INCR', KEYS[1]))
local key = ARGV[1] .. version
if active then
  local terms = redis.call('HGETALL', ARGV[1] .. active)
  for i = 1, #terms, 2 do
    redis.call('HSET', key, terms[i], terms[i + 1])
  end
end
for i = 2, #ARGV, 2 do
  redis.call('HSET', key, ARGV[i], ARGV[i + 1])
end
redis.call('SET', KEYS[2], version)
return tonumber(version)
)lua";

sw::redis::Redis redis("tcp://redis:6379");

// One version of a tenant's glossary for a language pair.
struct Glossary {
  long version = 0;
  std::map<std::string, std::string> terms;
};

std::string glossaryKey(const std::string& tenant, const std::string& source, const std::string& target, long version) {
  return "glossary:" + tenant + ":" + source + ":" + target + ":v" + std::to_string(version);
}

std::string pointerKey(const std::string& tenant, const std::string& source, const std::string& target) {
  return "glossary:" + tenant + ":" + source + ":" + target + ":active";
}

std::string seqKey(const std::string& tenant, const std::string& source, const std::string& target) {
  return "glossary:" + tenant + ":" + source + ":" + target + ":seq";
}

// The tenant and the glossary version are part of what a translation was made with.
std::string tmKey(const std::string& tenant, const std::string& source, const std::string& target, long version, const std::string& s) {
  return "tm:" + tenant + ":" + source + ":" + target + ":v" + std::to_string(version) + ":" + text::sha256Hex(s);
}

// The version :active names, 0 when there is none.
long activeVersion(const std::string& tenant, const std::string& source, const std::string& target) {
  const auto value = redis.get(pointerKey(tenant, source, target));
  return value ? std::stol(*value) : 0;
}

// Publish the active terms plus changes as the next version and make it active; returns the version.
long publishTerms(const std::string& tenant, const std::string& source, const std::string& target, const std::map<std::string, std::string>& changes) {
  std::vector<std::string> args = {"glossary:" + tenant + ":" + source + ":" + target + ":v"};
  for (const auto& [term, translation] : changes) {
    args.push_back(term);
    args.push_back(translation);
  }
  return redis.eval<long long>(kPublishLua, {seqKey(tenant, source, target), pointerKey(tenant, source, target)}, args);
}

// The pinned version, or the active one when version is 0; none when there is none.
std::optional<Glossary> resolveGlossary(const std::string& tenant, const std::string& source, const std::string& target, long version = 0) {
  if (version == 0) {
    version = activeVersion(tenant, source, target);  // one read: the request is pinned to it
    if (version == 0) return std::nullopt;
  }
  const std::unordered_map<std::string, std::string> terms = redis.hgetall(glossaryKey(tenant, source, target, version));
  if (terms.empty()) return std::nullopt;
  return Glossary{version, std::map<std::string, std::string>(terms.begin(), terms.end())};
}

std::optional<std::string> tmGet(const std::string& tenant, const std::string& source, const std::string& target, long version, const std::string& s) {
  return redis.get(tmKey(tenant, source, target, version, s));
}

void tmPut(const std::string& tenant, const std::string& source, const std::string& target, long version, const std::string& s, const std::string& translation) {
  redis.set(tmKey(tenant, source, target, version, s), translation, kTmTtl);
}
`,
    },
  },
  harness: {
    python: `import hashlib

SAMPLE = "Open the Dashboard"
BASE = "glossary:acme:en:fr"


def _sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _publish_raw(ctx, changes):
    """Another replica publishing acme's en->fr glossary by the contract: copy the active version, apply, mint, move the pointer."""
    active = ctx.redis.get(f"{BASE}:active")
    merged = dict(ctx.redis.hgetall(f"{BASE}:v{active}")) if active else {}
    merged.update(changes)
    version = ctx.redis.incr(f"{BASE}:seq")
    ctx.redis.hset(f"{BASE}:v{version}", mapping=merged)
    ctx.redis.set(f"{BASE}:active", version)
    return version


def check_tm_key(ctx):
    m = ctx.load("state")
    m.tm_put("acme", "en", "fr", 1, SAMPLE, "Ouvrir le Tableau de bord")
    key = f"tm:acme:en:fr:v1:{_sha(SAMPLE)}"
    assert ctx.redis.exists(key), f"tm_put wrote {sorted(ctx.redis.keys('tm:*'))}, expected {key}: the key names the tenant, the pair, the glossary version and the text's hash"
    assert m.tm_get("acme", "en", "fr", 1, SAMPLE) == "Ouvrir le Tableau de bord", "tm_get must answer what tm_put remembered"
    other = m.tm_get("globex", "en", "fr", 1, SAMPLE)
    assert other is None, f"tenant globex was served acme's translation {other!r}: a translation made with one tenant's glossary must not reach another"
    stale = m.tm_get("acme", "en", "fr", 2, SAMPLE)
    assert stale is None, f"under glossary version 2 tm_get answered {stale!r}, the translation made under version 1: translation memory must not undo a glossary update"


def check_tm_ttl(ctx):
    m = ctx.load("state")
    m.tm_put("acme", "en", "fr", 1, SAMPLE, "Ouvrir le Tableau de bord")
    keys = ctx.redis.keys("tm:*")
    assert len(keys) == 1, f"one tm_put wrote {keys}"
    ttl = ctx.redis.ttl(keys[0])
    assert 3500 < ttl <= 3600, f"the translation-memory entry {keys[0]} has TTL {ttl}: it must expire after an hour (TM_TTL_S = 3600), or a wrong entry is served until someone flushes Redis"


def check_new_version(ctx):
    m = ctx.load("state")
    v1 = m.publish_terms("acme", "en", "fr", {"Dashboard": "Tableau de bord", "Invoice": "Facture"})
    assert v1 == 1, f"the first publish answered version {v1!r}, expected 1"
    v2 = m.publish_terms("acme", "en", "fr", {"Dashboard": "Panneau"})
    pinned = ctx.redis.hgetall(f"{BASE}:v1")
    assert pinned == {"Dashboard": "Tableau de bord", "Invoice": "Facture"}, f"after an update version 1 holds {pinned}: a request that pinned version 1 now translates with half of the update. Publish the change as the next version"
    assert v2 == 2, f"an update answered version {v2!r}, expected 2"
    active = m.resolve_glossary("acme", "en", "fr")
    assert active == {"version": 2, "terms": {"Dashboard": "Panneau", "Invoice": "Facture"}}, f"the active glossary is {active}: version 2 is version 1's terms with the change applied"
    # A second editor publishes while this one is mid-publish.
    probe = ctx.redis_after(f"{BASE}:active", lambda: _publish_raw(ctx, {"Refund": "Remboursement"}))
    m.publish_terms("acme", "en", "fr", {"Invoice": "Note"})
    assert probe.fired, "publish_terms never touched the :active pointer"
    final = m.resolve_glossary("acme", "en", "fr")
    terms = final["terms"] if final else {}
    assert terms.get("Invoice") == "Note" and terms.get("Refund") == "Remboursement", f"two editors published at once and the active glossary is {final}: one change was lost. Copy, write and move the pointer in one script"


def check_pointer_once(ctx):
    m = ctx.load("state")
    ctx.redis.hset(f"{BASE}:v1", mapping={"Dashboard": "Tableau de bord"})
    ctx.redis.set(f"{BASE}:seq", 1)
    ctx.redis.set(f"{BASE}:active", 1)
    # An edit lands right after the request first reads the pointer.
    probe = ctx.redis_after(f"{BASE}:active", lambda: _publish_raw(ctx, {"Dashboard": "Panneau"}))
    got = m.resolve_glossary("acme", "en", "fr")
    assert probe.fired, "resolve_glossary never read the :active pointer"
    expected = {1: {"Dashboard": "Tableau de bord"}, 2: {"Dashboard": "Panneau"}}
    assert got is not None and got["terms"] == expected.get(got["version"]), f"an edit landed mid-read and resolve_glossary answered {got}: one version's number with another version's terms. Read the pointer once and load exactly that version"
    assert m.resolve_glossary("acme", "en", "fr", 1) == {"version": 1, "terms": {"Dashboard": "Tableau de bord"}}, "a pinned version 1 must load version 1's terms"
    assert m.resolve_glossary("acme", "en", "fr", 7) is None, "a version that does not exist must resolve to None"
    assert m.resolve_glossary("globex", "en", "fr") is None, "globex has no en->fr glossary and must resolve to None"
`,
    typescript: `import {createHash} from 'node:crypto';

const SAMPLE = 'Open the Dashboard';
const BASE = 'glossary:acme:en:fr';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Another replica publishing acme's en->fr glossary by the contract: copy the active version, apply, mint, move the pointer. */
function publishRaw(ctx, changes: Record<string, string>): number {
  const active = ctx.redis.get(\`\${BASE}:active\`);
  const merged = {...(active === null ? {} : ctx.redis.hgetall(\`\${BASE}:v\${active}\`)), ...changes};
  const version = ctx.redis.incr(\`\${BASE}:seq\`);
  ctx.redis.hset(\`\${BASE}:v\${version}\`, ...Object.entries(merged).flat());
  ctx.redis.set(\`\${BASE}:active\`, version);
  return version;
}

export async function check_tm_key(ctx) {
  const m = ctx.load('state');
  await m.tmPut('acme', 'en', 'fr', 1, SAMPLE, 'Ouvrir le Tableau de bord');
  const key = \`tm:acme:en:fr:v1:\${sha(SAMPLE)}\`;
  assert(ctx.redis.exists(key), \`tmPut wrote \${JSON.stringify(ctx.redis.keys('tm:*'))}, expected \${key}: the key names the tenant, the pair, the glossary version and the text's hash\`);
  assert.equal(await m.tmGet('acme', 'en', 'fr', 1, SAMPLE), 'Ouvrir le Tableau de bord', 'tmGet must answer what tmPut remembered');
  const other = await m.tmGet('globex', 'en', 'fr', 1, SAMPLE);
  assert.equal(other, null, \`tenant globex was served acme's translation \${JSON.stringify(other)}: a translation made with one tenant's glossary must not reach another\`);
  const stale = await m.tmGet('acme', 'en', 'fr', 2, SAMPLE);
  assert.equal(stale, null, \`under glossary version 2 tmGet answered \${JSON.stringify(stale)}, the translation made under version 1: translation memory must not undo a glossary update\`);
}

export async function check_tm_ttl(ctx) {
  const m = ctx.load('state');
  await m.tmPut('acme', 'en', 'fr', 1, SAMPLE, 'Ouvrir le Tableau de bord');
  const keys = ctx.redis.keys('tm:*');
  assert.equal(keys.length, 1, \`one tmPut wrote \${JSON.stringify(keys)}\`);
  const ttl = ctx.redis.ttl(keys[0]);
  assert(3500 < ttl && ttl <= 3600, \`the translation-memory entry \${keys[0]} has TTL \${ttl}: it must expire after an hour (TM_TTL_S = 3600), or a wrong entry is served until someone flushes Redis\`);
}

export async function check_new_version(ctx) {
  const m = ctx.load('state');
  const v1 = await m.publishTerms('acme', 'en', 'fr', {Dashboard: 'Tableau de bord', Invoice: 'Facture'});
  assert.equal(v1, 1, \`the first publish answered version \${v1}, expected 1\`);
  const v2 = await m.publishTerms('acme', 'en', 'fr', {Dashboard: 'Panneau'});
  const pinned = ctx.redis.hgetall(\`\${BASE}:v1\`);
  assert.deepStrictEqual(pinned, {Dashboard: 'Tableau de bord', Invoice: 'Facture'}, \`after an update version 1 holds \${JSON.stringify(pinned)}: a request that pinned version 1 now translates with half of the update. Publish the change as the next version\`);
  assert.equal(v2, 2, \`an update answered version \${v2}, expected 2\`);
  const active = await m.resolveGlossary('acme', 'en', 'fr');
  assert.deepStrictEqual(active, {version: 2, terms: {Dashboard: 'Panneau', Invoice: 'Facture'}}, \`the active glossary is \${JSON.stringify(active)}: version 2 is version 1's terms with the change applied\`);
  // A second editor publishes while this one is mid-publish.
  const probe = ctx.redisAfter(\`\${BASE}:active\`, () => publishRaw(ctx, {Refund: 'Remboursement'}));
  await m.publishTerms('acme', 'en', 'fr', {Invoice: 'Note'});
  assert(probe.fired, 'publishTerms never touched the :active pointer');
  const final = await m.resolveGlossary('acme', 'en', 'fr');
  const terms = final?.terms ?? {};
  assert(terms.Invoice === 'Note' && terms.Refund === 'Remboursement', \`two editors published at once and the active glossary is \${JSON.stringify(final)}: one change was lost. Copy, write and move the pointer in one script\`);
}

export async function check_pointer_once(ctx) {
  const m = ctx.load('state');
  ctx.redis.hset(\`\${BASE}:v1\`, 'Dashboard', 'Tableau de bord');
  ctx.redis.set(\`\${BASE}:seq\`, 1);
  ctx.redis.set(\`\${BASE}:active\`, 1);
  // An edit lands right after the request first reads the pointer.
  const probe = ctx.redisAfter(\`\${BASE}:active\`, () => publishRaw(ctx, {Dashboard: 'Panneau'}));
  const got = await m.resolveGlossary('acme', 'en', 'fr');
  assert(probe.fired, 'resolveGlossary never read the :active pointer');
  const expected = {1: {Dashboard: 'Tableau de bord'}, 2: {Dashboard: 'Panneau'}};
  assert(got !== null && JSON.stringify(got.terms) === JSON.stringify(expected[got.version]), \`an edit landed mid-read and resolveGlossary answered \${JSON.stringify(got)}: one version's number with another version's terms. Read the pointer once and load exactly that version\`);
  assert.deepStrictEqual(await m.resolveGlossary('acme', 'en', 'fr', 1), {version: 1, terms: {Dashboard: 'Tableau de bord'}}, "a pinned version 1 must load version 1's terms");
  assert.equal(await m.resolveGlossary('acme', 'en', 'fr', 7), null, 'a version that does not exist must resolve to null');
  assert.equal(await m.resolveGlossary('globex', 'en', 'fr'), null, 'globex has no en->fr glossary and must resolve to null');
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strconv"

	"leetbuild/harness"
)

const (
	stateSample = "Open the Dashboard"
	stateBase   = "glossary:acme:en:fr"
)

var stateBg = context.Background()

func stateSha(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// publishRaw is another replica publishing acme's en->fr glossary by the contract: copy the active
// version, apply, mint, move the pointer.
func publishRaw(ctx *harness.Ctx, changes map[string]string) int64 {
	merged := map[string]string{}
	if active, ok := ctx.Redis.Get(stateBase + ":active"); ok {
		for term, translation := range ctx.Redis.HGetAll(stateBase + ":v" + active) {
			merged[term] = translation
		}
	}
	for term, translation := range changes {
		merged[term] = translation
	}
	version := ctx.Redis.Do("INCR", stateBase+":seq").(int64)
	args := []any{"HSET", stateBase + ":v" + strconv.FormatInt(version, 10)}
	for term, translation := range merged {
		args = append(args, term, translation)
	}
	ctx.Redis.Do(args...)
	ctx.Redis.Set(stateBase+":active", version)
	return version
}

func mustResolve(ctx *harness.Ctx, tenant string, version int64) *Glossary {
	g, err := resolveGlossary(stateBg, tenant, "en", "fr", version)
	ctx.NoError(err, "resolveGlossary(%s, en, fr, %d) failed", tenant, version)
	return g
}

func CheckTmKey(ctx *harness.Ctx) {
	ctx.NoError(tmPut(stateBg, "acme", "en", "fr", 1, stateSample, "Ouvrir le Tableau de bord"), "tmPut failed")
	key := "tm:acme:en:fr:v1:" + stateSha(stateSample)
	ctx.Assert(ctx.Redis.Exists(key) == 1, "tmPut wrote %q, expected %s: the key names the tenant, the pair, the glossary version and the text's hash", ctx.Redis.Keys("tm:*"), key)
	got, ok := tmGet(stateBg, "acme", "en", "fr", 1, stateSample)
	ctx.Assert(ok && got == "Ouvrir le Tableau de bord", "tmGet must answer what tmPut remembered, got %q", got)
	other, ok := tmGet(stateBg, "globex", "en", "fr", 1, stateSample)
	ctx.Assert(!ok, "tenant globex was served acme's translation %q: a translation made with one tenant's glossary must not reach another", other)
	stale, ok := tmGet(stateBg, "acme", "en", "fr", 2, stateSample)
	ctx.Assert(!ok, "under glossary version 2 tmGet answered %q, the translation made under version 1: translation memory must not undo a glossary update", stale)
}

func CheckTmTtl(ctx *harness.Ctx) {
	ctx.NoError(tmPut(stateBg, "acme", "en", "fr", 1, stateSample, "Ouvrir le Tableau de bord"), "tmPut failed")
	keys := ctx.Redis.Keys("tm:*")
	ctx.Equal(len(keys), 1, "one tmPut wrote %q; the keys", keys)
	ttl := ctx.Redis.TTL(keys[0])
	ctx.Assert(3500 < ttl && ttl <= 3600, "the translation-memory entry %s has TTL %d: it must expire after an hour (tmTTL), or a wrong entry is served until someone flushes Redis", keys[0], ttl)
}

func CheckNewVersion(ctx *harness.Ctx) {
	v1, err := publishTerms(stateBg, "acme", "en", "fr", map[string]string{"Dashboard": "Tableau de bord", "Invoice": "Facture"})
	ctx.NoError(err, "the first publish failed")
	ctx.Equal(v1, int64(1), "the first publish's version")
	v2, err := publishTerms(stateBg, "acme", "en", "fr", map[string]string{"Dashboard": "Panneau"})
	ctx.NoError(err, "the update failed")
	ctx.Equal(ctx.Redis.HGetAll(stateBase+":v1"), map[string]string{"Dashboard": "Tableau de bord", "Invoice": "Facture"}, "after an update version 1 must keep its terms, or a request that pinned version 1 translates with half of the update. Publish the change as the next version; version 1")
	ctx.Equal(v2, int64(2), "an update's version")
	active := mustResolve(ctx, "acme", 0)
	ctx.Assert(active != nil && active.Version == 2, "the active glossary must be version 2, got %+v", active)
	ctx.Equal(active.Terms, map[string]string{"Dashboard": "Panneau", "Invoice": "Facture"}, "version 2 is version 1's terms with the change applied; its terms")
	// A second editor publishes while this one is mid-publish.
	probe := ctx.Redis.After(stateBase+":active", func() any { return publishRaw(ctx, map[string]string{"Refund": "Remboursement"}) })
	_, err = publishTerms(stateBg, "acme", "en", "fr", map[string]string{"Invoice": "Note"})
	ctx.NoError(err, "the third publish failed")
	ctx.Assert(probe.Fired, "publishTerms never touched the :active pointer")
	final := mustResolve(ctx, "acme", 0)
	ctx.Assert(final != nil && final.Terms["Invoice"] == "Note" && final.Terms["Refund"] == "Remboursement", "two editors published at once and the active glossary is %+v: one change was lost. Copy, write and move the pointer in one script", final)
}

func CheckPointerOnce(ctx *harness.Ctx) {
	ctx.Redis.Do("HSET", stateBase+":v1", "Dashboard", "Tableau de bord")
	ctx.Redis.Set(stateBase+":seq", 1)
	ctx.Redis.Set(stateBase+":active", 1)
	// An edit lands right after the request first reads the pointer.
	probe := ctx.Redis.After(stateBase+":active", func() any { return publishRaw(ctx, map[string]string{"Dashboard": "Panneau"}) })
	got := mustResolve(ctx, "acme", 0)
	ctx.Assert(probe.Fired, "resolveGlossary never read the :active pointer")
	expected := map[int64]string{1: "Tableau de bord", 2: "Panneau"}
	ctx.Assert(got != nil && got.Terms["Dashboard"] == expected[got.Version], "an edit landed mid-read and resolveGlossary answered %+v: one version's number with another version's terms. Read the pointer once and load exactly that version", got)
	pinned := mustResolve(ctx, "acme", 1)
	ctx.Assert(pinned != nil && pinned.Version == 1 && pinned.Terms["Dashboard"] == "Tableau de bord", "a pinned version 1 must load version 1's terms, got %+v", pinned)
	ctx.Assert(mustResolve(ctx, "acme", 7) == nil, "a version that does not exist must resolve to nil")
	ctx.Assert(mustResolve(ctx, "globex", 0) == nil, "globex has no en->fr glossary and must resolve to nil")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <openssl/sha.h>

#include <map>
#include <string>
#include <vector>

namespace {

const std::string kSample = "Open the Dashboard";
const std::string kBase = "glossary:acme:en:fr";

std::string sha(const std::string& s) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(s.data()), s.size(), digest);
  static const char* hex = "0123456789abcdef";
  std::string out;
  for (unsigned char b : digest) {
    out += hex[b >> 4];
    out += hex[b & 0x0f];
  }
  return out;
}

// Another replica publishing acme's en->fr glossary by the contract: copy the active version, apply,
// mint, move the pointer.
long long publishRaw(harness::Ctx& ctx, const std::map<std::string, std::string>& changes) {
  std::map<std::string, std::string> merged;
  if (const auto active = ctx.Redis.Get(kBase + ":active")) merged = ctx.Redis.HGetAll(kBase + ":v" + *active);
  for (const auto& [term, translation] : changes) merged[term] = translation;
  const long long version = ctx.Redis.Do("INCR", kBase + ":seq").Int();
  std::vector<std::string> args = {"HSET", kBase + ":v" + std::to_string(version)};
  for (const auto& [term, translation] : merged) {
    args.push_back(term);
    args.push_back(translation);
  }
  ctx.Redis.Must(args);
  ctx.Redis.Set(kBase + ":active", std::to_string(version));
  return version;
}

std::string describe(const std::optional<Glossary>& g) {
  if (!g) return "none";
  std::string out = "version " + std::to_string(g->version) + " {";
  for (const auto& [term, translation] : g->terms) out += " " + term + "=" + translation;
  return out + " }";
}

}  // namespace

void CheckTmKey(harness::Ctx& ctx) {
  tmPut("acme", "en", "fr", 1, kSample, "Ouvrir le Tableau de bord");
  const std::string key = "tm:acme:en:fr:v1:" + sha(kSample);
  ctx.Assert(ctx.Redis.Exists(key) == 1, "tmPut wrote %q, expected %s: the key names the tenant, the pair, the glossary version and the text's hash", ctx.Redis.Keys("tm:*"), key);
  ctx.Equal(tmGet("acme", "en", "fr", 1, kSample), std::optional<std::string>("Ouvrir le Tableau de bord"), "tmGet must answer what tmPut remembered");
  const auto other = tmGet("globex", "en", "fr", 1, kSample);
  ctx.Assert(!other, "tenant globex was served acme's translation %q: a translation made with one tenant's glossary must not reach another", other.value_or(""));
  const auto stale = tmGet("acme", "en", "fr", 2, kSample);
  ctx.Assert(!stale, "under glossary version 2 tmGet answered %q, the translation made under version 1: translation memory must not undo a glossary update", stale.value_or(""));
}

void CheckTmTtl(harness::Ctx& ctx) {
  tmPut("acme", "en", "fr", 1, kSample, "Ouvrir le Tableau de bord");
  const auto keys = ctx.Redis.Keys("tm:*");
  ctx.Equal(keys.size(), 1, "one tmPut wrote %q; the keys", keys);
  const auto ttl = ctx.Redis.TTL(keys[0]);
  ctx.Assert(3500 < ttl && ttl <= 3600, "the translation-memory entry %s has TTL %d: it must expire after an hour (kTmTtl), or a wrong entry is served until someone flushes Redis", keys[0], ttl);
}

void CheckNewVersion(harness::Ctx& ctx) {
  const long v1 = publishTerms("acme", "en", "fr", {{"Dashboard", "Tableau de bord"}, {"Invoice", "Facture"}});
  ctx.Equal(v1, 1, "the first publish's version");
  const long v2 = publishTerms("acme", "en", "fr", {{"Dashboard", "Panneau"}});
  ctx.Equal(ctx.Redis.HGetAll(kBase + ":v1"), std::map<std::string, std::string>{{"Dashboard", "Tableau de bord"}, {"Invoice", "Facture"}},
            "after an update version 1 must keep its terms, or a request that pinned version 1 translates with half of the update. Publish the change as the next version; version 1");
  ctx.Equal(v2, 2, "an update's version");
  const auto active = resolveGlossary("acme", "en", "fr");
  ctx.Assert(active && active->version == 2 && active->terms == std::map<std::string, std::string>{{"Dashboard", "Panneau"}, {"Invoice", "Facture"}},
             "the active glossary is %s: version 2 is version 1's terms with the change applied", describe(active));
  // A second editor publishes while this one is mid-publish.
  bool fired = false;
  ctx.Redis.After(kBase + ":active", [&] {
    fired = true;
    publishRaw(ctx, {{"Refund", "Remboursement"}});
  });
  publishTerms("acme", "en", "fr", {{"Invoice", "Note"}});
  ctx.Assert(fired, "publishTerms never touched the :active pointer");
  const auto final = resolveGlossary("acme", "en", "fr");
  ctx.Assert(final && final->terms.count("Invoice") && final->terms.at("Invoice") == "Note" && final->terms.count("Refund"),
             "two editors published at once and the active glossary is %s: one change was lost. Copy, write and move the pointer in one script", describe(final));
}

void CheckPointerOnce(harness::Ctx& ctx) {
  ctx.Redis.Do("HSET", kBase + ":v1", "Dashboard", "Tableau de bord");
  ctx.Redis.Set(kBase + ":seq", "1");
  ctx.Redis.Set(kBase + ":active", "1");
  // An edit lands right after the request first reads the pointer.
  bool fired = false;
  ctx.Redis.After(kBase + ":active", [&] {
    fired = true;
    publishRaw(ctx, {{"Dashboard", "Panneau"}});
  });
  const auto got = resolveGlossary("acme", "en", "fr");
  ctx.Assert(fired, "resolveGlossary never read the :active pointer");
  const std::map<long, std::string> expected = {{1, "Tableau de bord"}, {2, "Panneau"}};
  ctx.Assert(got && expected.count(got->version) && got->terms.count("Dashboard") && got->terms.at("Dashboard") == expected.at(got->version),
             "an edit landed mid-read and resolveGlossary answered %s: one version's number with another version's terms. Read the pointer once and load exactly that version", describe(got));
  const auto pinned = resolveGlossary("acme", "en", "fr", 1);
  ctx.Assert(pinned && pinned->version == 1 && pinned->terms.at("Dashboard") == "Tableau de bord", "a pinned version 1 must load version 1's terms, got %s", describe(pinned));
  ctx.Assert(!resolveGlossary("acme", "en", "fr", 7), "a version that does not exist must resolve to none");
  ctx.Assert(!resolveGlossary("globex", "en", "fr"), "globex has no en->fr glossary and must resolve to none");
}
`,
  },
  hints: [
    "Publish an edit and read version 1 back: the terms a request pinned changed under it. Ask translation memory as another tenant for the same sentence: it answers with acme's translation.",
    '`publish_terms` writes into the version `:active` already names; `tm_key` leaves the tenant and the version out and `tm_put` sets no expiry; `resolve_glossary` calls `active_version()` twice, so an edit between the calls splits the number from the terms.',
    'Key TM as `tm:{tenant}:{source}:{target}:v{version}:{sha}` with `ex=TM_TTL_S`; publish through one Lua script that INCRs `:seq`, copies the active hash, applies the changes and SETs `:active`; read the pointer once in `resolve_glossary`.',
  ],
  debrief: `Immutable versions make the rest of the course cheap: a request pins a number, and everything it touches (the terms, the translation-memory entry, the event it emits) is keyed by that number, so an edit is never half visible. The script exists because copying forward is a read-modify-write: two editors who each copy the same base lose one change unless one runs after the other. Putting the version in the TM key turns a glossary edit into a cache invalidation without deleting a key. A production glossary store keeps versions in a database with author and time, garbage-collects versions no request can still pin, and caps the size of a glossary, as hosted MT services do for custom terminology.`,
};
