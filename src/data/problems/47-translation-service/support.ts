/**
 * Hand-written support modules the translation-service steps import but no step builds: the
 * `translate` package. `translate.text` is the platform's language detector and the text digest;
 * `translate.glossary` is step 2 as later steps use it (versioned glossaries and translation memory
 * in Redis); `translate.mt` is step 3 as steps 1 and 5 use it (the MT client with its deadline,
 * retry policy and marked fallback); `translate.outbox` is the table a rejected produce lands in.
 * The five languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

const PUBLISH_LUA = `local active = redis.call('GET', KEYS[2])
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
`;

export const supportModules: Record<string, string> = {
  'translate/__init__.py': '',
  'translate/text.py': `"""
Text helpers every step shares (provided). detect_language is the platform's language detector: kana
means ja; otherwise a stopword vote over en, fr, de, es and pt that answers only when it is
confident (two stopwords or more, and no tie), else None. sha256_hex is the hex SHA-256 of the
text's UTF-8 bytes.
"""
import hashlib

STOPWORDS = {
    "en": frozenset({"the", "and", "is", "of", "to", "with", "this"}),
    "fr": frozenset({"le", "la", "les", "et", "est", "des", "une", "avec"}),
    "de": frozenset({"der", "die", "das", "und", "ist", "mit", "ein"}),
    "es": frozenset({"el", "los", "las", "y", "es", "una", "con"}),
    "pt": frozenset({"o", "os", "as", "e", "uma", "com", "um"}),
}
PUNCTUATION = ".,;:!?\\"'()"


def detect_language(text: str) -> str | None:
    """The language the text is confidently in, or None."""
    if any("\\u3040" <= ch <= "\\u30ff" for ch in text):
        return "ja"
    words = [w.strip(PUNCTUATION).lower() for w in text.split()]
    votes = {lang: sum(1 for w in words if w in stop) for lang, stop in STOPWORDS.items()}
    best = max(votes.values())
    winners = [lang for lang, n in votes.items() if n == best]
    return winners[0] if best >= 2 and len(winners) == 1 else None


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
`,
  'translate/glossary.py': `"""
Glossary versions and translation memory in Redis (provided; step 2 builds the same functions).
glossary:{tenant}:{source}:{target}:v{n} is version n of a tenant's glossary for one language pair,
a hash of source term -> translation, written once and never edited; ...:seq mints the version
numbers and ...:active holds the version requests resolve. publish_terms copies the active terms,
applies the changes under the next version and moves the pointer, in one Lua script.
tm:{tenant}:{source}:{target}:v{n}:{sha256(text)} is a translation-memory entry made under version n,
kept TM_TTL_S seconds.
"""
import redis

from translate.text import sha256_hex

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TM_TTL_S = 3600

PUBLISH_LUA = """
${PUBLISH_LUA}"""
publish = r.register_script(PUBLISH_LUA)


def glossary_key(tenant: str, source: str, target: str, version) -> str:
    return f"glossary:{tenant}:{source}:{target}:v{version}"


def pointer_key(tenant: str, source: str, target: str) -> str:
    return f"glossary:{tenant}:{source}:{target}:active"


def seq_key(tenant: str, source: str, target: str) -> str:
    return f"glossary:{tenant}:{source}:{target}:seq"


def tm_key(tenant: str, source: str, target: str, version: int, text: str) -> str:
    return f"tm:{tenant}:{source}:{target}:v{version}:{sha256_hex(text)}"


def publish_terms(tenant: str, source: str, target: str, changes: dict[str, str]) -> int:
    """Publish the active terms plus changes as the next version and make it active; returns the version."""
    pairs = [part for term in sorted(changes) for part in (term, changes[term])]
    keys = [seq_key(tenant, source, target), pointer_key(tenant, source, target)]
    return int(publish(keys=keys, args=[glossary_key(tenant, source, target, ""), *pairs]))


def resolve_glossary(tenant: str, source: str, target: str, version: int | None = None) -> dict | None:
    """{"version", "terms"} of the pinned version, or of the active one (one pointer read) when version is None; None when there is none."""
    if version is None:
        active = r.get(pointer_key(tenant, source, target))
        if active is None:
            return None
        version = int(active)
    terms = r.hgetall(glossary_key(tenant, source, target, version))
    return {"version": version, "terms": terms} if terms else None


def tm_get(tenant: str, source: str, target: str, version: int, text: str) -> str | None:
    return r.get(tm_key(tenant, source, target, version, text))


def tm_put(tenant: str, source: str, target: str, version: int, text: str, translation: str) -> None:
    r.set(tm_key(tenant, source, target, version, text), translation, ex=TM_TTL_S)
`,
  'translate/mt.py': `"""
The MT client (provided; step 3 builds the same function). translate_segment answers from
translation memory when it can; otherwise it calls Translator.Translate on mt:9000 with the pinned
glossary's terms (sorted by term), each attempt under a DEADLINE_S deadline, at most MAX_ATTEMPTS
attempts, retrying only UNAVAILABLE and DEADLINE_EXCEEDED. INVALID_ARGUMENT raises PairRejected. A
translation is remembered; when the model never answered, the source text comes back with the
UNTRANSLATED marker and nothing is remembered.
"""
import grpc

import translation_service_pb2
import translation_service_pb2_grpc
from translate.glossary import tm_get, tm_put

DEADLINE_S = 2
MAX_ATTEMPTS = 3
RETRIABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
UNTRANSLATED = "untranslated"

stub = translation_service_pb2_grpc.TranslatorStub(grpc.insecure_channel("mt:9000"))


class PairRejected(Exception):
    """The model does not serve this language pair: a caller bug, not an outage."""


def translate_segment(tenant: str, text: str, source: str, target: str, pinned: dict) -> dict:
    """{"text", "marker"}: the translation (marker None) or the marked source text."""
    version = pinned["version"]
    cached = tm_get(tenant, source, target, version, text)
    if cached is not None:
        return {"text": cached, "marker": None}
    terms = [translation_service_pb2.Term(source=term, target=pinned["terms"][term]) for term in sorted(pinned["terms"])]
    request = translation_service_pb2.TranslateRequest(text=text, source=source, target=target, glossary_version=version, terms=terms)
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = stub.Translate(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.INVALID_ARGUMENT:
                raise PairRejected(exc.details()) from exc
            if exc.code() not in RETRIABLE:
                break
            continue
        tm_put(tenant, source, target, version, text, reply.text)
        return {"text": reply.text, "marker": None}
    return {"text": text, "marker": UNTRANSLATED}
`,
  'translate/outbox.py': `"""
The outbox (provided): a produce the broker refused is kept as a row (the event's JSON) in the Redis
list outbox:translation.done, which a relay replays later with the same producer.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OUTBOX_KEY = "outbox:translation.done"


def insert(value: str) -> None:
    r.rpush(OUTBOX_KEY, value)
`,
};

export const supportModulesTs: Record<string, string> = {
  'translate/text.ts': `/**
 * Text helpers every step shares (provided). detectLanguage is the platform's language detector:
 * kana means ja; otherwise a stopword vote over en, fr, de, es and pt that answers only when it is
 * confident (two stopwords or more, and no tie), else null. sha256Hex is the hex SHA-256 of the
 * text's UTF-8 bytes.
 */
import {createHash} from 'node:crypto';

export const STOPWORDS: [string, Set<string>][] = [
  ['en', new Set(['the', 'and', 'is', 'of', 'to', 'with', 'this'])],
  ['fr', new Set(['le', 'la', 'les', 'et', 'est', 'des', 'une', 'avec'])],
  ['de', new Set(['der', 'die', 'das', 'und', 'ist', 'mit', 'ein'])],
  ['es', new Set(['el', 'los', 'las', 'y', 'es', 'una', 'con'])],
  ['pt', new Set(['o', 'os', 'as', 'e', 'uma', 'com', 'um'])],
];

/** The language the text is confidently in, or null. */
export function detectLanguage(text: string): string | null {
  if (/[\\u3040-\\u30ff]/.test(text)) return 'ja';
  const words = text
    .split(/\\s+/)
    .filter(w => w !== '')
    .map(w => w.replace(/^[.,;:!?"'()]+|[.,;:!?"'()]+$/g, '').toLowerCase());
  const votes = STOPWORDS.map(([lang, stop]) => [lang, words.filter(w => stop.has(w)).length] as const);
  const best = Math.max(...votes.map(([, n]) => n));
  const winners = votes.filter(([, n]) => n === best);
  return best >= 2 && winners.length === 1 ? winners[0][0] : null;
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
`,
  'translate/glossary.ts': `/**
 * Glossary versions and translation memory in Redis (provided; step 2 builds the same functions).
 * glossary:{tenant}:{source}:{target}:v{n} is version n of a tenant's glossary for one language
 * pair, a hash of source term -> translation, written once and never edited; ...:seq mints the
 * version numbers and ...:active holds the version requests resolve. publishTerms copies the active
 * terms, applies the changes under the next version and moves the pointer, in one Lua script.
 * tm:{tenant}:{source}:{target}:v{n}:{sha256(text)} is a translation-memory entry made under
 * version n, kept TM_TTL_S seconds.
 */
import Redis from 'ioredis';

import {sha256Hex} from 'translate/text';

export const TM_TTL_S = 3600;

export const PUBLISH_LUA = \`
${PUBLISH_LUA}\`;

export interface Glossary {
  version: number;
  terms: Record<string, string>;
}

interface PublishRedis extends Redis {
  publishTerms(seqKey: string, pointerKey: string, prefix: string, ...pairs: string[]): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as PublishRedis;
redis.defineCommand('publishTerms', {numberOfKeys: 2, lua: PUBLISH_LUA});

export const glossaryKey = (tenant: string, source: string, target: string, version: number | string): string =>
  \`glossary:\${tenant}:\${source}:\${target}:v\${version}\`;
export const pointerKey = (tenant: string, source: string, target: string): string => \`glossary:\${tenant}:\${source}:\${target}:active\`;
export const seqKey = (tenant: string, source: string, target: string): string => \`glossary:\${tenant}:\${source}:\${target}:seq\`;
export const tmKey = (tenant: string, source: string, target: string, version: number, text: string): string =>
  \`tm:\${tenant}:\${source}:\${target}:v\${version}:\${sha256Hex(text)}\`;

/** Publish the active terms plus changes as the next version and make it active; resolves the version. */
export async function publishTerms(tenant: string, source: string, target: string, changes: Record<string, string>): Promise<number> {
  const pairs = Object.keys(changes)
    .sort()
    .flatMap(term => [term, changes[term]]);
  return Number(await redis.publishTerms(seqKey(tenant, source, target), pointerKey(tenant, source, target), glossaryKey(tenant, source, target, ''), ...pairs));
}

/** The pinned version, or the active one (one pointer read) when version is null; null when there is none. */
export async function resolveGlossary(tenant: string, source: string, target: string, version: number | null = null): Promise<Glossary | null> {
  let pinned = version;
  if (pinned === null) {
    const active = await redis.get(pointerKey(tenant, source, target));
    if (active === null) return null;
    pinned = Number(active);
  }
  const terms = await redis.hgetall(glossaryKey(tenant, source, target, pinned));
  return Object.keys(terms).length > 0 ? {version: pinned, terms} : null;
}

export const tmGet = (tenant: string, source: string, target: string, version: number, text: string): Promise<string | null> =>
  redis.get(tmKey(tenant, source, target, version, text));

export async function tmPut(tenant: string, source: string, target: string, version: number, text: string, translation: string): Promise<void> {
  await redis.set(tmKey(tenant, source, target, version, text), translation, 'EX', TM_TTL_S);
}
`,
  'translate/mt.ts': `/**
 * The MT client (provided; step 3 builds the same function). translateSegment answers from
 * translation memory when it can; otherwise it calls Translator.Translate on mt:9000 with the pinned
 * glossary's terms (sorted by term), each attempt under a DEADLINE_MS deadline, at most MAX_ATTEMPTS
 * attempts, retrying only UNAVAILABLE and DEADLINE_EXCEEDED. INVALID_ARGUMENT throws PairRejected.
 * A translation is remembered; when the model never answered, the source text comes back with the
 * UNTRANSLATED marker and nothing is remembered.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Glossary, tmGet, tmPut} from 'translate/glossary';

export const DEADLINE_MS = 2000;
export const MAX_ATTEMPTS = 3;
export const UNTRANSLATED = 'untranslated';
const RETRIABLE = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

export interface Translation {
  text: string;
  marker: string | null;
}

interface TranslateRequest {
  text: string;
  source: string;
  target: string;
  glossary_version: number;
  terms: {source: string; target: string}[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('translation_service.proto')) as unknown as {
  translationsvc: {Translator: grpc.ServiceClientConstructor};
};
const stub = new pkg.translationsvc.Translator('mt:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Translate(request: TranslateRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{text: string; model: string}>;
};

/** The model does not serve this language pair: a caller bug, not an outage. */
export class PairRejected extends Error {}

/** The translation (marker null) or the marked source text. */
export async function translateSegment(tenant: string, text: string, source: string, target: string, pinned: Glossary): Promise<Translation> {
  const cached = await tmGet(tenant, source, target, pinned.version, text);
  if (cached !== null) return {text: cached, marker: null};
  const terms = Object.keys(pinned.terms)
    .sort()
    .map(term => ({source: term, target: pinned.terms[term]}));
  const request = {text, source, target, glossary_version: pinned.version, terms};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let reply;
    try {
      reply = await stub.Translate(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      if (code === grpc.status.INVALID_ARGUMENT) throw new PairRejected(details);
      if (!RETRIABLE.has(code)) break;
      continue;
    }
    await tmPut(tenant, source, target, pinned.version, text, reply.text);
    return {text: reply.text, marker: null};
  }
  return {text, marker: UNTRANSLATED};
}
`,
  'translate/outbox.ts': `/**
 * The outbox (provided): a produce the broker refused is kept as a row (the event's JSON) in the
 * Redis list outbox:translation.done, which a relay replays later with the same producer.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX_KEY = 'outbox:translation.done';

export async function insert(value: string): Promise<void> {
  await redis.rpush(OUTBOX_KEY, value);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'translate/text/text.go': `// Package text holds the helpers every step shares (provided). DetectLanguage is the platform's
// language detector: kana means ja; otherwise a stopword vote over en, fr, de, es and pt that
// answers only when it is confident (two stopwords or more, and no tie), else "". SHA256Hex is the
// hex SHA-256 of the text's UTF-8 bytes.
package text

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

type stopwords struct {
	lang  string
	words map[string]bool
}

func set(words ...string) map[string]bool {
	out := map[string]bool{}
	for _, w := range words {
		out[w] = true
	}
	return out
}

var votes = []stopwords{
	{"en", set("the", "and", "is", "of", "to", "with", "this")},
	{"fr", set("le", "la", "les", "et", "est", "des", "une", "avec")},
	{"de", set("der", "die", "das", "und", "ist", "mit", "ein")},
	{"es", set("el", "los", "las", "y", "es", "una", "con")},
	{"pt", set("o", "os", "as", "e", "uma", "com", "um")},
}

const punctuation = ".,;:!?\\"'()"

// DetectLanguage is the language the text is confidently in, or "".
func DetectLanguage(s string) string {
	for _, r := range s {
		if r >= 0x3040 && r <= 0x30ff {
			return "ja"
		}
	}
	counts := make([]int, len(votes))
	for _, w := range strings.Fields(s) {
		w = strings.ToLower(strings.Trim(w, punctuation))
		for i, v := range votes {
			if v.words[w] {
				counts[i]++
			}
		}
	}
	best, winner, tie := 0, "", false
	for i, n := range counts {
		if n > best {
			best, winner, tie = n, votes[i].lang, false
		} else if n == best && n > 0 {
			tie = true
		}
	}
	if best >= 2 && !tie {
		return winner
	}
	return ""
}

// SHA256Hex is the hex SHA-256 of the text.
func SHA256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
`,
  'translate/glossary/glossary.go': `// Package glossary is glossary versions and translation memory in Redis (provided; step 2 builds
// the same functions). glossary:{tenant}:{source}:{target}:v{n} is version n of a tenant's glossary
// for one language pair, a hash of source term -> translation, written once and never edited;
// ...:seq mints the version numbers and ...:active holds the version requests resolve. PublishTerms
// copies the active terms, applies the changes under the next version and moves the pointer, in one
// Lua script. tm:{tenant}:{source}:{target}:v{n}:{sha256(text)} is a translation-memory entry made
// under version n, kept TMTTL.
package glossary

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"translate/text"
)

// TMTTL is how long a translation-memory entry lives.
const TMTTL = time.Hour

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Publish copies the active version (KEYS[2] holds it) into the next one KEYS[1] mints, applies the
// term pairs ARGV[2..] and moves the pointer; ARGV[1] is the version keys' prefix.
var Publish = redis.NewScript(\`
${PUBLISH_LUA}\`)

// Glossary is one version of a tenant's glossary for a language pair.
type Glossary struct {
	Version int64
	Terms   map[string]string
}

func GlossaryKey(tenant, source, target string, version int64) string {
	return fmt.Sprintf("glossary:%s:%s:%s:v%d", tenant, source, target, version)
}

func PointerKey(tenant, source, target string) string {
	return fmt.Sprintf("glossary:%s:%s:%s:active", tenant, source, target)
}

func SeqKey(tenant, source, target string) string {
	return fmt.Sprintf("glossary:%s:%s:%s:seq", tenant, source, target)
}

func TMKey(tenant, source, target string, version int64, s string) string {
	return fmt.Sprintf("tm:%s:%s:%s:v%d:%s", tenant, source, target, version, text.SHA256Hex(s))
}

// PublishTerms publishes the active terms plus changes as the next version and makes it active.
func PublishTerms(ctx context.Context, tenant, source, target string, changes map[string]string) (int64, error) {
	terms := make([]string, 0, len(changes))
	for term := range changes {
		terms = append(terms, term)
	}
	sort.Strings(terms)
	args := []any{fmt.Sprintf("glossary:%s:%s:%s:v", tenant, source, target)}
	for _, term := range terms {
		args = append(args, term, changes[term])
	}
	return Publish.Run(ctx, rdb, []string{SeqKey(tenant, source, target), PointerKey(tenant, source, target)}, args...).Int64()
}

// ResolveGlossary is the pinned version, or the active one (one pointer read) when version is 0; nil when there is none.
func ResolveGlossary(ctx context.Context, tenant, source, target string, version int64) (*Glossary, error) {
	if version == 0 {
		active, err := rdb.Get(ctx, PointerKey(tenant, source, target)).Result()
		if err == redis.Nil {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		version, _ = strconv.ParseInt(active, 10, 64)
	}
	terms, err := rdb.HGetAll(ctx, GlossaryKey(tenant, source, target, version)).Result()
	if err != nil {
		return nil, err
	}
	if len(terms) == 0 {
		return nil, nil
	}
	return &Glossary{Version: version, Terms: terms}, nil
}

// TMGet is the remembered translation, if any.
func TMGet(ctx context.Context, tenant, source, target string, version int64, s string) (string, bool) {
	value, err := rdb.Get(ctx, TMKey(tenant, source, target, version, s)).Result()
	return value, err == nil
}

// TMPut remembers a translation for TMTTL.
func TMPut(ctx context.Context, tenant, source, target string, version int64, s, translation string) error {
	return rdb.Set(ctx, TMKey(tenant, source, target, version, s), translation, TMTTL).Err()
}
`,
  'translate/mt/mt.go': `// Package mt is the MT client (provided; step 3 builds the same function). TranslateSegment answers
// from translation memory when it can; otherwise it calls Translator.Translate on mt:9000 with the
// pinned glossary's terms (sorted by term), each attempt under a Deadline, at most MaxAttempts
// attempts, retrying only Unavailable and DeadlineExceeded. InvalidArgument is ErrPairRejected. A
// translation is remembered; when the model never answered, the source text comes back with the
// Untranslated marker and nothing is remembered.
package mt

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "translate/gen/translation_service"
	"translate/glossary"
)

const (
	Deadline     = 2 * time.Second
	MaxAttempts  = 3
	Untranslated = "untranslated"
)

var (
	conn, _ = grpc.NewClient("mt:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	stub    = pb.NewTranslatorClient(conn)
)

// ErrPairRejected: the model does not serve this language pair, a caller bug, not an outage.
var ErrPairRejected = errors.New("language pair rejected")

// Translation is the translated text (Marker "") or the source text marked Untranslated.
type Translation struct {
	Text   string
	Marker string
}

// TranslateSegment translates one segment under the pinned glossary.
func TranslateSegment(ctx context.Context, tenant, text, source, target string, pinned glossary.Glossary) (Translation, error) {
	if cached, ok := glossary.TMGet(ctx, tenant, source, target, pinned.Version, text); ok {
		return Translation{Text: cached}, nil
	}
	names := make([]string, 0, len(pinned.Terms))
	for term := range pinned.Terms {
		names = append(names, term)
	}
	sort.Strings(names)
	request := &pb.TranslateRequest{Text: text, Source: source, Target: target, GlossaryVersion: pinned.Version}
	for _, term := range names {
		request.Terms = append(request.Terms, &pb.Term{Source: term, Target: pinned.Terms[term]})
	}
	for attempt := 0; attempt < MaxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, Deadline)
		reply, err := stub.Translate(callCtx, request)
		cancel()
		if err == nil {
			if err := glossary.TMPut(ctx, tenant, source, target, pinned.Version, text, reply.GetText()); err != nil {
				return Translation{}, err
			}
			return Translation{Text: reply.GetText()}, nil
		}
		code := status.Code(err)
		if code == codes.InvalidArgument {
			return Translation{}, fmt.Errorf("%w: %s", ErrPairRejected, status.Convert(err).Message())
		}
		if code != codes.Unavailable && code != codes.DeadlineExceeded {
			break
		}
	}
	return Translation{Text: text, Marker: Untranslated}, nil
}
`,
  'translate/outbox/outbox.go': `// Package outbox is the outbox (provided): a produce the broker refused is kept as a row (the
// event's JSON) in the Redis list outbox:translation.done, which a relay replays later with the
// same producer.
package outbox

import (
	"context"

	"github.com/redis/go-redis/v9"
)

const Key = "outbox:translation.done"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert keeps the event for the relay.
func Insert(ctx context.Context, value []byte) error {
	return rdb.RPush(ctx, Key, string(value)).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'translate/text.h': `// Text helpers every step shares (provided). detectLanguage is the platform's language detector:
// kana means ja; otherwise a stopword vote over en, fr, de, es and pt that answers only when it is
// confident (two stopwords or more, and no tie), else "". sha256Hex is the hex SHA-256 of the
// text's UTF-8 bytes.
#pragma once

#include <openssl/sha.h>

#include <cctype>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace text {

inline const std::vector<std::pair<std::string, std::set<std::string>>>& stopwords() {
  static const std::vector<std::pair<std::string, std::set<std::string>>> kStopwords = {
      {"en", {"the", "and", "is", "of", "to", "with", "this"}},
      {"fr", {"le", "la", "les", "et", "est", "des", "une", "avec"}},
      {"de", {"der", "die", "das", "und", "ist", "mit", "ein"}},
      {"es", {"el", "los", "las", "y", "es", "una", "con"}},
      {"pt", {"o", "os", "as", "e", "uma", "com", "um"}},
  };
  return kStopwords;
}

// The language the text is confidently in, or "".
inline std::string detectLanguage(const std::string& s) {
  // U+3040..U+30FF (hiragana, katakana) is E3 81 80 .. E3 83 BF in UTF-8.
  for (size_t i = 0; i + 1 < s.size(); i++) {
    const auto lead = static_cast<unsigned char>(s[i]), next = static_cast<unsigned char>(s[i + 1]);
    if (lead == 0xE3 && next >= 0x81 && next <= 0x83) return "ja";
  }
  const std::string punctuation = ".,;:!?\\"'()";
  std::vector<int> counts(stopwords().size(), 0);
  std::istringstream in(s);
  std::string w;
  while (in >> w) {
    const auto first = w.find_first_not_of(punctuation);
    if (first == std::string::npos) continue;
    w = w.substr(first, w.find_last_not_of(punctuation) - first + 1);
    for (char& c : w) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    for (size_t i = 0; i < counts.size(); i++) counts[i] += stopwords()[i].second.count(w) ? 1 : 0;
  }
  int best = 0;
  std::string winner;
  bool tie = false;
  for (size_t i = 0; i < counts.size(); i++) {
    if (counts[i] > best) {
      best = counts[i];
      winner = stopwords()[i].first;
      tie = false;
    } else if (counts[i] == best && best > 0) {
      tie = true;
    }
  }
  return best >= 2 && !tie ? winner : "";
}

inline std::string sha256Hex(const std::string& s) {
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

}  // namespace text
`,
  'translate/glossary.h': `// Glossary versions and translation memory in Redis (provided; step 2 builds the same functions).
// glossary:{tenant}:{source}:{target}:v{n} is version n of a tenant's glossary for one language
// pair, a hash of source term -> translation, written once and never edited; ...:seq mints the
// version numbers and ...:active holds the version requests resolve. publishTerms copies the active
// terms, applies the changes under the next version and moves the pointer, in one Lua script.
// tm:{tenant}:{source}:{target}:v{n}:{sha256(text)} is a translation-memory entry made under version
// n, kept kTmTtl.
#pragma once

#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "translate/text.h"

namespace glossary {

constexpr std::chrono::seconds kTmTtl{3600};

inline const std::string kPublishLua = R"lua(
${PUBLISH_LUA})lua";

// One version of a tenant's glossary for a language pair.
struct Glossary {
  long version = 0;
  std::map<std::string, std::string> terms;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string glossaryKey(const std::string& tenant, const std::string& source, const std::string& target, long version) {
  return "glossary:" + tenant + ":" + source + ":" + target + ":v" + std::to_string(version);
}

inline std::string pointerKey(const std::string& tenant, const std::string& source, const std::string& target) {
  return "glossary:" + tenant + ":" + source + ":" + target + ":active";
}

inline std::string seqKey(const std::string& tenant, const std::string& source, const std::string& target) {
  return "glossary:" + tenant + ":" + source + ":" + target + ":seq";
}

inline std::string tmKey(const std::string& tenant, const std::string& source, const std::string& target, long version, const std::string& s) {
  return "tm:" + tenant + ":" + source + ":" + target + ":v" + std::to_string(version) + ":" + text::sha256Hex(s);
}

// Publish the active terms plus changes as the next version and make it active; returns the version.
inline long publishTerms(const std::string& tenant, const std::string& source, const std::string& target, const std::map<std::string, std::string>& changes) {
  std::vector<std::string> args = {"glossary:" + tenant + ":" + source + ":" + target + ":v"};
  for (const auto& [term, translation] : changes) {
    args.push_back(term);
    args.push_back(translation);
  }
  return redis().eval<long long>(kPublishLua, {seqKey(tenant, source, target), pointerKey(tenant, source, target)}, args);
}

// The pinned version, or the active one (one pointer read) when version is 0; none when there is none.
inline std::optional<Glossary> resolveGlossary(const std::string& tenant, const std::string& source, const std::string& target, long version = 0) {
  if (version == 0) {
    const auto active = redis().get(pointerKey(tenant, source, target));
    if (!active) return std::nullopt;
    version = std::stol(*active);
  }
  const std::unordered_map<std::string, std::string> terms = redis().hgetall(glossaryKey(tenant, source, target, version));
  if (terms.empty()) return std::nullopt;
  return Glossary{version, std::map<std::string, std::string>(terms.begin(), terms.end())};
}

inline std::optional<std::string> tmGet(const std::string& tenant, const std::string& source, const std::string& target, long version, const std::string& s) {
  return redis().get(tmKey(tenant, source, target, version, s));
}

inline void tmPut(const std::string& tenant, const std::string& source, const std::string& target, long version, const std::string& s, const std::string& translation) {
  redis().set(tmKey(tenant, source, target, version, s), translation, kTmTtl);
}

}  // namespace glossary
`,
  'translate/mt.h': `// The MT client (provided; step 3 builds the same function). translateSegment answers from
// translation memory when it can; otherwise it calls Translator.Translate on mt:9000 with the pinned
// glossary's terms (sorted by term), each attempt under a kDeadline deadline, at most kMaxAttempts
// attempts, retrying only UNAVAILABLE and DEADLINE_EXCEEDED. INVALID_ARGUMENT throws PairRejected. A
// translation is remembered; when the model never answered, the source text comes back with the
// kUntranslated marker and nothing is remembered.
#pragma once

#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "translate/glossary.h"
#include "translation_service.grpc.pb.h"

namespace mt {

constexpr std::chrono::seconds kDeadline{2};
constexpr int kMaxAttempts = 3;
inline const std::string kUntranslated = "untranslated";

// The model does not serve this language pair: a caller bug, not an outage.
struct PairRejected : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The translated text (marker "") or the source text marked kUntranslated.
struct Translation {
  std::string text;
  std::string marker;
};

inline translationsvc::Translator::Stub& stub() {
  static auto s = translationsvc::Translator::NewStub(grpc::CreateChannel("mt:9000", grpc::InsecureChannelCredentials()));
  return *s;
}

inline Translation translateSegment(const std::string& tenant, const std::string& text, const std::string& source, const std::string& target,
                                    const glossary::Glossary& pinned) {
  if (const auto cached = glossary::tmGet(tenant, source, target, pinned.version, text)) return {*cached, ""};
  translationsvc::TranslateRequest request;
  request.set_text(text);
  request.set_source(source);
  request.set_target(target);
  request.set_glossary_version(pinned.version);
  for (const auto& [term, translation] : pinned.terms) {
    translationsvc::Term* t = request.add_terms();
    t->set_source(term);
    t->set_target(translation);
  }
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    translationsvc::TranslateReply reply;
    const grpc::Status status = stub().Translate(&ctx, request, &reply);
    if (status.ok()) {
      glossary::tmPut(tenant, source, target, pinned.version, text, reply.text());
      return {reply.text(), ""};
    }
    if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT) throw PairRejected(status.error_message());
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE && status.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED) break;
  }
  return {text, kUntranslated};
}

}  // namespace mt
`,
  'translate/outbox.h': `// The outbox (provided): a produce the broker refused is kept as a row (the event's JSON) in the
// Redis list outbox:translation.done, which a relay replays later with the same producer.
#pragma once

#include <sw/redis++/redis++.h>

#include <string>

namespace outbox {

inline const std::string kKey = "outbox:translation.done";

inline void insert(const std::string& value) {
  static sw::redis::Redis r("tcp://redis:6379");
  r.rpush(kKey, value);
}

}  // namespace outbox
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('translate', 'Text')]: `package translate

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/**
 * Text helpers every step shares (provided). detectLanguage is the platform's language detector:
 * kana means ja; otherwise a stopword vote over en, fr, de, es and pt that answers only when it is
 * confident (two stopwords or more, and no tie), else None. sha256Hex is the hex SHA-256 of the
 * text's UTF-8 bytes.
 */
object Text {
  val Stopwords: Seq[(String, Set[String])] = Seq(
    "en" -> Set("the", "and", "is", "of", "to", "with", "this"),
    "fr" -> Set("le", "la", "les", "et", "est", "des", "une", "avec"),
    "de" -> Set("der", "die", "das", "und", "ist", "mit", "ein"),
    "es" -> Set("el", "los", "las", "y", "es", "una", "con"),
    "pt" -> Set("o", "os", "as", "e", "uma", "com", "um"),
  )
  private val Punctuation = ".,;:!?\\"'()"

  /** The language the text is confidently in. */
  def detectLanguage(text: String): Option[String] =
    if (text.exists(c => c >= '\\u3040' && c <= '\\u30ff')) Some("ja")
    else {
      val words = text.split("\\\\s+").toSeq.map(w => w.dropWhile(Punctuation.contains(_)).reverse.dropWhile(Punctuation.contains(_)).reverse.toLowerCase)
      val votes = Stopwords.map { case (lang, stop) => lang -> words.count(stop.contains) }
      val best = votes.map(_._2).max
      val winners = votes.filter(_._2 == best)
      if (best >= 2 && winners.size == 1) Some(winners.head._1) else None
    }

  def sha256Hex(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)).map(b => f"\${b & 0xff}%02x").mkString
}
`,
  [scalaPath('translate', 'Glossary')]: `package translate

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

/**
 * Glossary versions and translation memory in Redis (provided; step 2 builds the same functions).
 * glossary:{tenant}:{source}:{target}:v{n} is version n of a tenant's glossary for one language
 * pair, a hash of source term -> translation, written once and never edited; ...:seq mints the
 * version numbers and ...:active holds the version requests resolve. publishTerms copies the active
 * terms, applies the changes under the next version and moves the pointer, in one Lua script.
 * tm:{tenant}:{source}:{target}:v{n}:{sha256(text)} is a translation-memory entry made under
 * version n, kept TmTtlSeconds.
 */
object Glossary {
  /** One version of a tenant's glossary for a language pair. */
  final case class Pinned(version: Long, terms: Map[String, String])

  val TmTtlSeconds = 3600L

  val PublishLua: String = """
${PUBLISH_LUA}"""

  val jedis = new JedisPooled("redis", 6379)

  def glossaryKey(tenant: String, source: String, target: String, version: Long): String = s"glossary:$tenant:$source:$target:v$version"
  def pointerKey(tenant: String, source: String, target: String): String = s"glossary:$tenant:$source:$target:active"
  def seqKey(tenant: String, source: String, target: String): String = s"glossary:$tenant:$source:$target:seq"
  def tmKey(tenant: String, source: String, target: String, version: Long, text: String): String =
    s"tm:$tenant:$source:$target:v$version:\${Text.sha256Hex(text)}"

  /** Publish the active terms plus changes as the next version and make it active; returns the version. */
  def publishTerms(tenant: String, source: String, target: String, changes: Map[String, String]): Long = {
    val args = s"glossary:$tenant:$source:$target:v" +: changes.toSeq.sortBy(_._1).flatMap { case (term, translation) => Seq(term, translation) }
    jedis.eval(PublishLua, List(seqKey(tenant, source, target), pointerKey(tenant, source, target)).asJava, args.asJava).asInstanceOf[java.lang.Long]
  }

  /** The pinned version, or the active one (one pointer read) when version is None. */
  def resolveGlossary(tenant: String, source: String, target: String, version: Option[Long] = None): Option[Pinned] =
    version.orElse(Option(jedis.get(pointerKey(tenant, source, target))).map(_.toLong)).flatMap { v =>
      val terms = jedis.hgetAll(glossaryKey(tenant, source, target, v)).asScala.toMap
      if (terms.isEmpty) None else Some(Pinned(v, terms))
    }

  def tmGet(tenant: String, source: String, target: String, version: Long, text: String): Option[String] =
    Option(jedis.get(tmKey(tenant, source, target, version, text)))

  def tmPut(tenant: String, source: String, target: String, version: Long, text: String, translation: String): Unit =
    jedis.set(tmKey(tenant, source, target, version, text), translation, SetParams.setParams().ex(TmTtlSeconds))
}
`,
  [scalaPath('translate', 'Mt')]: `package translate

import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import translationsvc.translation_service.{Term, TranslateRequest, TranslatorGrpc}

/**
 * The MT client (provided; step 3 builds the same function). translateSegment answers from
 * translation memory when it can; otherwise it calls Translator.Translate on mt:9000 with the pinned
 * glossary's terms (sorted by term), each attempt under a DeadlineSeconds deadline, at most
 * MaxAttempts attempts, retrying only UNAVAILABLE and DEADLINE_EXCEEDED. INVALID_ARGUMENT throws
 * PairRejected. A translation is remembered; when the model never answered, the source text comes
 * back with the Untranslated marker and nothing is remembered.
 */
object Mt {
  val DeadlineSeconds = 2L
  val MaxAttempts = 3
  val Untranslated = "untranslated"
  private val Retriable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  /** The model does not serve this language pair: a caller bug, not an outage. */
  final class PairRejected(message: String) extends Exception(message)

  /** The translated text (marker None) or the source text marked Untranslated. */
  final case class Translation(text: String, marker: Option[String])

  private val stub = TranslatorGrpc.blockingStub(ManagedChannelBuilder.forAddress("mt", 9000).usePlaintext().build())

  def translateSegment(tenant: String, text: String, source: String, target: String, pinned: Glossary.Pinned): Translation =
    Glossary.tmGet(tenant, source, target, pinned.version, text) match {
      case Some(cached) => Translation(cached, None)
      case None =>
        val terms = pinned.terms.toSeq.sortBy(_._1).map { case (term, translation) => Term(term, translation) }
        val request = TranslateRequest(text, source, target, pinned.version, terms)
        var attempt = 0
        var result: Option[Translation] = None
        while (result.isEmpty && attempt < MaxAttempts) {
          attempt += 1
          try {
            val reply = stub.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).translate(request)
            Glossary.tmPut(tenant, source, target, pinned.version, text, reply.text)
            result = Some(Translation(reply.text, None))
          } catch {
            case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.INVALID_ARGUMENT =>
              throw new PairRejected(Option(e.getStatus.getDescription).getOrElse("language pair rejected"))
            case e: StatusRuntimeException if !Retriable.contains(e.getStatus.getCode) => attempt = MaxAttempts
            case _: StatusRuntimeException => ()
          }
        }
        result.getOrElse(Translation(text, Some(Untranslated)))
    }
}
`,
  [scalaPath('translate', 'Outbox')]: `package translate

import redis.clients.jedis.JedisPooled

/**
 * The outbox (provided): a produce the broker refused is kept as a row (the event's JSON) in the
 * Redis list outbox:translation.done, which a relay replays later with the same producer.
 */
object Outbox {
  val Key = "outbox:translation.done"
  val jedis = new JedisPooled("redis", 6379)

  def insert(value: String): Unit = jedis.rpush(Key, value)
}
`,
};
