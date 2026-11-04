/**
 * Hand-written support modules the summarizer steps import but no step builds: the `summarizer`
 * package. `summarizer.text` holds the text rules every step shares (chunks, sentences, the content
 * hash, the extractive lead and its citations); `summarizer.store` is the summary store in Redis
 * (sources, summary records, the support console's lookup, request keys, the outbox). The five
 * languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

const TEXT_DOC = `A source is chunks separated by a blank line; a sentence ends at . ! or ? followed by whitespace
or the end of the text. content_hash is the SHA-256 of the UTF-8 text in hex. lead is the
extractive lead: the source's first sentences while they fit in \`words\` words (the first one cut
to \`words\` words when it alone is longer). cite points every sentence of a summary at the chunk
it was taken from: sentence (its index in the summary), chunk_index, char_start and char_end
(offsets in the chunk) and chunk_hash; a sentence the source does not contain verbatim gets no
citation.`;

const STORE_DOC = `The summary store (provided), in Redis. source:{tenant}:{source_ref} holds the current text of a
source (content, source_hash). summary:{tenant}:{summary_id} is one summary record: summary_id,
tenant, source_ref, source_hash, band, target_words, kind (extractive or abstractive),
model_version, summary, citations (JSON), source_bytes, summary_chars, chunks_done. summary:owner
maps every summary id to its tenant for the support console. idem:{tenant}:{key} is the response
recorded for a request key; outbox is the list of events the broker did not take.`;

const comment = (prefix: string, doc: string): string =>
  doc
    .split('\n')
    .map(line => `${prefix}${line}`)
    .join('\n');

export const supportModules: Record<string, string> = {
  'summarizer/__init__.py': '',
  'summarizer/text.py': `"""
${TEXT_DOC}
"""
import hashlib

SPACE = " \\n\\t"
ENDS = ".!?"


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def chunks(content: str) -> list[str]:
    return content.split("\\n\\n")


def _next(text: str, i: int) -> tuple[int, int] | None:
    """The next sentence of text at or after offset i, as (start, end)."""
    n = len(text)
    while i < n and text[i] in SPACE:
        i += 1
    if i >= n:
        return None
    start = i
    while i < n:
        if text[i] in ENDS and (i + 1 == n or text[i + 1] in SPACE):
            return (start, i + 1)
        i += 1
    end = n
    while end > start and text[end - 1] in SPACE:
        end -= 1
    return (start, end)


def sentences(text: str) -> list[tuple[int, int]]:
    """The (start, end) offsets of the sentences in text."""
    spans = []
    span = _next(text, 0)
    while span is not None:
        spans.append(span)
        span = _next(text, span[1])
    return spans


def lead(content: str, words: int) -> str:
    """The source's first sentences while they fit in words words."""
    picked: list[str] = []
    count = 0
    for chunk in chunks(content):
        span = _next(chunk, 0)
        while span is not None:
            sentence = chunk[span[0] : span[1]]
            n = len(sentence.split())
            if count + n > words:
                if not picked:
                    picked.append(" ".join(sentence.split()[:words]))
                return " ".join(picked)
            picked.append(sentence)
            count += n
            span = _next(chunk, span[1])
    return " ".join(picked)


def cite(content: str, summary: str) -> list[dict]:
    """One pointer per summary sentence the source contains verbatim."""
    parts = chunks(content)
    out = []
    for i, (start, end) in enumerate(sentences(summary)):
        sentence = summary[start:end]
        for index, chunk in enumerate(parts):
            at = chunk.find(sentence)
            if at >= 0:
                out.append(
                    {"sentence": i, "chunk_index": index, "char_start": at, "char_end": at + len(sentence), "chunk_hash": content_hash(chunk)}
                )
                break
    return out
`,
  'summarizer/store.py': `"""
${STORE_DOC}
"""
import json

import redis

from summarizer import text

r = redis.Redis(host="redis", port=6379, decode_responses=True)

NUMBERS = ("target_words", "source_bytes", "summary_chars", "chunks_done")


def put_source(tenant: str, source_ref: str, content: str) -> str:
    """Store the current text of a source; returns its source_hash."""
    source_hash = text.content_hash(content)
    r.hset(f"source:{tenant}:{source_ref}", mapping={"source_hash": source_hash, "content": content})
    return source_hash


def current_source(tenant: str, source_ref: str) -> dict | None:
    """The source as it is now: source_ref, source_hash, chunks and chunk_hashes."""
    raw = r.hgetall(f"source:{tenant}:{source_ref}")
    if not raw:
        return None
    parts = text.chunks(raw["content"])
    return {"source_ref": source_ref, "source_hash": raw["source_hash"], "chunks": parts, "chunk_hashes": [text.content_hash(c) for c in parts]}


def new_summary_id() -> str:
    return f"s-{r.incr('summary:seq')}"


def save_summary(record: dict) -> None:
    """Write the record under summary:{tenant}:{summary_id}."""
    fields = {name: json.dumps(value) if name == "citations" else str(value) for name, value in record.items()}
    r.hset(f"summary:{record['tenant']}:{record['summary_id']}", mapping=fields)
    r.hset("summary:owner", record["summary_id"], record["tenant"])


def _record(raw: dict) -> dict | None:
    if not raw:
        return None
    record = dict(raw)
    for name in NUMBERS:
        record[name] = int(raw[name])
    record["citations"] = json.loads(raw["citations"])
    return record


def load_summary(tenant: str, summary_id: str) -> dict | None:
    """The tenant's summary with this id, or None."""
    return _record(r.hgetall(f"summary:{tenant}:{summary_id}"))


def find_summary(summary_id: str) -> dict | None:
    """The support console's lookup: the summary with this id, whatever tenant owns it."""
    tenant = r.hget("summary:owner", summary_id)
    return None if tenant is None else load_summary(tenant, summary_id)


def create_summary(tenant: str, source_ref: str, content: str, band: str, target_words: int) -> dict:
    """Store the source, write its extractive lead with citations as a new summary; returns the record."""
    source_hash = put_source(tenant, source_ref, content)
    summary = text.lead(content, target_words)
    record = {
        "summary_id": new_summary_id(),
        "tenant": tenant,
        "source_ref": source_ref,
        "source_hash": source_hash,
        "band": band,
        "target_words": target_words,
        "kind": "extractive",
        "model_version": "",
        "summary": summary,
        "citations": text.cite(content, summary),
        "source_bytes": len(content.encode("utf-8")),
        "summary_chars": len(summary),
        "chunks_done": len(text.chunks(content)),
    }
    save_summary(record)
    return record


def replay(tenant: str, key: str) -> dict | None:
    """The response recorded for (tenant, key), if any."""
    raw = r.get(f"idem:{tenant}:{key}")
    return json.loads(raw) if raw else None


def remember(tenant: str, key: str, response: dict) -> None:
    """Record the response for (tenant, key), for its replays."""
    r.set(f"idem:{tenant}:{key}", json.dumps(response))


def outbox_put(topic: str, key: str, payload: dict) -> None:
    """Park an event the broker did not take; a relay produces it later."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'summarizer/text.ts': `/**
${comment(' * ', TEXT_DOC)}
 */
import {createHash} from 'node:crypto';

export interface Citation {
  sentence: number;
  chunk_index: number;
  char_start: number;
  char_end: number;
  chunk_hash: string;
}

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\\n' || c === '\\t';
const words = (s: string): string[] => s.split(/\\s+/).filter(w => w !== '');

export const contentHash = (text: string): string => createHash('sha256').update(text).digest('hex') as string;

export const chunks = (content: string): string[] => content.split('\\n\\n');

/** The next sentence of text at or after offset i, as [start, end]. */
function next(text: string, i: number): [number, number] | null {
  const n = text.length;
  while (i < n && isSpace(text[i])) i++;
  if (i >= n) return null;
  const start = i;
  for (; i < n; i++) {
    if ('.!?'.includes(text[i]) && (i + 1 === n || isSpace(text[i + 1]))) return [start, i + 1];
  }
  let end = n;
  while (end > start && isSpace(text[end - 1])) end--;
  return [start, end];
}

/** The [start, end] offsets of the sentences in text. */
export function sentences(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (let span = next(text, 0); span !== null; span = next(text, span[1])) spans.push(span);
  return spans;
}

/** The source's first sentences while they fit in limit words. */
export function lead(content: string, limit: number): string {
  const picked: string[] = [];
  let count = 0;
  for (const chunk of chunks(content)) {
    for (let span = next(chunk, 0); span !== null; span = next(chunk, span[1])) {
      const sentence = chunk.slice(span[0], span[1]);
      const n = words(sentence).length;
      if (count + n > limit) {
        if (picked.length === 0) picked.push(words(sentence).slice(0, limit).join(' '));
        return picked.join(' ');
      }
      picked.push(sentence);
      count += n;
    }
  }
  return picked.join(' ');
}

/** One pointer per summary sentence the source contains verbatim. */
export function cite(content: string, summary: string): Citation[] {
  const parts = chunks(content);
  const out: Citation[] = [];
  sentences(summary).forEach(([start, end], i) => {
    const sentence = summary.slice(start, end);
    const index = parts.findIndex(chunk => chunk.includes(sentence));
    if (index < 0) return;
    const at = parts[index].indexOf(sentence);
    out.push({sentence: i, chunk_index: index, char_start: at, char_end: at + sentence.length, chunk_hash: contentHash(parts[index])});
  });
  return out;
}
`,
  'summarizer/store.ts': `/**
${comment(' * ', STORE_DOC)}
 */
import Redis from 'ioredis';

import {type Citation, chunks, cite, contentHash, lead} from 'summarizer/text';

const redis = new Redis({host: 'redis', port: 6379});

export interface Summary {
  summary_id: string;
  tenant: string;
  source_ref: string;
  source_hash: string;
  band: string;
  target_words: number;
  kind: string;
  model_version: string;
  summary: string;
  citations: Citation[];
  source_bytes: number;
  summary_chars: number;
  chunks_done: number;
}

export interface Source {
  source_ref: string;
  source_hash: string;
  chunks: string[];
  chunk_hashes: string[];
}

const NUMBERS = ['target_words', 'source_bytes', 'summary_chars', 'chunks_done'];

/** Store the current text of a source; resolves its source_hash. */
export async function putSource(tenant: string, sourceRef: string, content: string): Promise<string> {
  const sourceHash = contentHash(content);
  await redis.hset(\`source:\${tenant}:\${sourceRef}\`, {source_hash: sourceHash, content});
  return sourceHash;
}

/** The source as it is now: source_ref, source_hash, chunks and chunk_hashes. */
export async function currentSource(tenant: string, sourceRef: string): Promise<Source | null> {
  const raw = await redis.hgetall(\`source:\${tenant}:\${sourceRef}\`);
  if (Object.keys(raw).length === 0) return null;
  const parts = chunks(raw.content);
  return {source_ref: sourceRef, source_hash: raw.source_hash, chunks: parts, chunk_hashes: parts.map(contentHash)};
}

export async function newSummaryId(): Promise<string> {
  return \`s-\${await redis.incr('summary:seq')}\`;
}

/** Write the record under summary:{tenant}:{summary_id}. */
export async function saveSummary(record: Summary): Promise<void> {
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) fields[name] = name === 'citations' ? JSON.stringify(value) : String(value);
  await redis.hset(\`summary:\${record.tenant}:\${record.summary_id}\`, fields);
  await redis.hset('summary:owner', record.summary_id, record.tenant);
}

function summaryOf(raw: Record<string, string>): Summary | null {
  if (Object.keys(raw).length === 0) return null;
  const record: Record<string, unknown> = {...raw, citations: JSON.parse(raw.citations)};
  for (const name of NUMBERS) record[name] = Number(raw[name]);
  return record as unknown as Summary;
}

/** The tenant's summary with this id, or null. */
export async function loadSummary(tenant: string, summaryId: string): Promise<Summary | null> {
  return summaryOf(await redis.hgetall(\`summary:\${tenant}:\${summaryId}\`));
}

/** The support console's lookup: the summary with this id, whatever tenant owns it. */
export async function findSummary(summaryId: string): Promise<Summary | null> {
  const tenant = await redis.hget('summary:owner', summaryId);
  return tenant === null ? null : loadSummary(tenant, summaryId);
}

/** Store the source, write its extractive lead with citations as a new summary; resolves the record. */
export async function createSummary(tenant: string, sourceRef: string, content: string, band: string, targetWords: number): Promise<Summary> {
  const sourceHash = await putSource(tenant, sourceRef, content);
  const summary = lead(content, targetWords);
  const record: Summary = {
    summary_id: await newSummaryId(),
    tenant,
    source_ref: sourceRef,
    source_hash: sourceHash,
    band,
    target_words: targetWords,
    kind: 'extractive',
    model_version: '',
    summary,
    citations: cite(content, summary),
    source_bytes: new TextEncoder().encode(content).length,
    summary_chars: summary.length,
    chunks_done: chunks(content).length,
  };
  await saveSummary(record);
  return record;
}

/** The response recorded for (tenant, key), if any. */
export async function replay(tenant: string, key: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(\`idem:\${tenant}:\${key}\`);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

/** Record the response for (tenant, key), for its replays. */
export async function remember(tenant: string, key: string, response: Record<string, unknown>): Promise<void> {
  await redis.set(\`idem:\${tenant}:\${key}\`, JSON.stringify(response));
}

/** Park an event the broker did not take; a relay produces it later. */
export async function outboxPut(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'summarizer/text/text.go': `// Package text holds the text rules every step shares (provided).
${comment('// ', TEXT_DOC)}
package text

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// Citation points one summary sentence at the chunk of the source it was taken from.
type Citation struct {
	Sentence   int    \`json:"sentence"\`
	ChunkIndex int    \`json:"chunk_index"\`
	CharStart  int    \`json:"char_start"\`
	CharEnd    int    \`json:"char_end"\`
	ChunkHash  string \`json:"chunk_hash"\`
}

func isSpace(c byte) bool { return c == ' ' || c == '\\n' || c == '\\t' }

// ContentHash is the SHA-256 of the text in hex.
func ContentHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// Chunks splits a source at its blank lines.
func Chunks(content string) []string { return strings.Split(content, "\\n\\n") }

// next is the next sentence of s at or after offset i (ok false when there is none).
func next(s string, i int) (int, int, bool) {
	n := len(s)
	for i < n && isSpace(s[i]) {
		i++
	}
	if i >= n {
		return 0, 0, false
	}
	start := i
	for ; i < n; i++ {
		if strings.IndexByte(".!?", s[i]) >= 0 && (i+1 == n || isSpace(s[i+1])) {
			return start, i + 1, true
		}
	}
	end := n
	for end > start && isSpace(s[end-1]) {
		end--
	}
	return start, end, true
}

// Sentences are the [start, end] offsets of the sentences in s.
func Sentences(s string) [][2]int {
	var spans [][2]int
	for start, end, ok := next(s, 0); ok; start, end, ok = next(s, end) {
		spans = append(spans, [2]int{start, end})
	}
	return spans
}

// Lead is the source's first sentences while they fit in limit words.
func Lead(content string, limit int) string {
	var picked []string
	count := 0
	for _, chunk := range Chunks(content) {
		for start, end, ok := next(chunk, 0); ok; start, end, ok = next(chunk, end) {
			sentence := chunk[start:end]
			words := strings.Fields(sentence)
			if count+len(words) > limit {
				if len(picked) == 0 {
					picked = append(picked, strings.Join(words[:limit], " "))
				}
				return strings.Join(picked, " ")
			}
			picked = append(picked, sentence)
			count += len(words)
		}
	}
	return strings.Join(picked, " ")
}

// Cite is one pointer per summary sentence the source contains verbatim.
func Cite(content, summary string) []Citation {
	parts := Chunks(content)
	out := []Citation{}
	for i, span := range Sentences(summary) {
		sentence := summary[span[0]:span[1]]
		for index, chunk := range parts {
			if at := strings.Index(chunk, sentence); at >= 0 {
				out = append(out, Citation{Sentence: i, ChunkIndex: index, CharStart: at, CharEnd: at + len(sentence), ChunkHash: ContentHash(chunk)})
				break
			}
		}
	}
	return out
}
`,
  'summarizer/store/store.go': `// Package store is the summary store (provided).
${comment('// ', STORE_DOC)}
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"

	"summarizer/text"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Summary is one summary record.
type Summary struct {
	SummaryID    string          \`json:"summary_id"\`
	Tenant       string          \`json:"tenant"\`
	SourceRef    string          \`json:"source_ref"\`
	SourceHash   string          \`json:"source_hash"\`
	Band         string          \`json:"band"\`
	TargetWords  int             \`json:"target_words"\`
	Kind         string          \`json:"kind"\`
	ModelVersion string          \`json:"model_version"\`
	Summary      string          \`json:"summary"\`
	Citations    []text.Citation \`json:"citations"\`
	SourceBytes  int             \`json:"source_bytes"\`
	SummaryChars int             \`json:"summary_chars"\`
	ChunksDone   int             \`json:"chunks_done"\`
}

// Source is a source as it is now.
type Source struct {
	SourceRef   string   \`json:"source_ref"\`
	SourceHash  string   \`json:"source_hash"\`
	Chunks      []string \`json:"chunks"\`
	ChunkHashes []string \`json:"chunk_hashes"\`
}

// PutSource stores the current text of a source and returns its source_hash.
func PutSource(ctx context.Context, tenant, sourceRef, content string) string {
	sourceHash := text.ContentHash(content)
	rdb.HSet(ctx, "source:"+tenant+":"+sourceRef, map[string]any{"source_hash": sourceHash, "content": content})
	return sourceHash
}

// CurrentSource is the source as it is now, or nil.
func CurrentSource(ctx context.Context, tenant, sourceRef string) *Source {
	raw := rdb.HGetAll(ctx, "source:"+tenant+":"+sourceRef).Val()
	if len(raw) == 0 {
		return nil
	}
	parts := text.Chunks(raw["content"])
	hashes := make([]string, len(parts))
	for i, c := range parts {
		hashes[i] = text.ContentHash(c)
	}
	return &Source{SourceRef: sourceRef, SourceHash: raw["source_hash"], Chunks: parts, ChunkHashes: hashes}
}

// NewSummaryID mints the next summary id.
func NewSummaryID(ctx context.Context) string {
	return fmt.Sprintf("s-%d", rdb.Incr(ctx, "summary:seq").Val())
}

// SaveSummary writes the record under summary:{tenant}:{summary_id}.
func SaveSummary(ctx context.Context, s Summary) error {
	cites, _ := json.Marshal(s.Citations)
	fields := map[string]any{
		"summary_id": s.SummaryID, "tenant": s.Tenant, "source_ref": s.SourceRef, "source_hash": s.SourceHash,
		"band": s.Band, "target_words": strconv.Itoa(s.TargetWords), "kind": s.Kind, "model_version": s.ModelVersion,
		"summary": s.Summary, "citations": string(cites), "source_bytes": strconv.Itoa(s.SourceBytes),
		"summary_chars": strconv.Itoa(s.SummaryChars), "chunks_done": strconv.Itoa(s.ChunksDone),
	}
	if err := rdb.HSet(ctx, "summary:"+s.Tenant+":"+s.SummaryID, fields).Err(); err != nil {
		return err
	}
	return rdb.HSet(ctx, "summary:owner", s.SummaryID, s.Tenant).Err()
}

func summaryOf(raw map[string]string) *Summary {
	if len(raw) == 0 {
		return nil
	}
	num := func(name string) int {
		n, _ := strconv.Atoi(raw[name])
		return n
	}
	s := &Summary{
		SummaryID: raw["summary_id"], Tenant: raw["tenant"], SourceRef: raw["source_ref"], SourceHash: raw["source_hash"],
		Band: raw["band"], TargetWords: num("target_words"), Kind: raw["kind"], ModelVersion: raw["model_version"],
		Summary: raw["summary"], SourceBytes: num("source_bytes"), SummaryChars: num("summary_chars"), ChunksDone: num("chunks_done"),
	}
	json.Unmarshal([]byte(raw["citations"]), &s.Citations)
	if s.Citations == nil {
		s.Citations = []text.Citation{}
	}
	return s
}

// LoadSummary is the tenant's summary with this id, or nil.
func LoadSummary(ctx context.Context, tenant, summaryID string) *Summary {
	return summaryOf(rdb.HGetAll(ctx, "summary:"+tenant+":"+summaryID).Val())
}

// FindSummary is the support console's lookup: the summary with this id, whatever tenant owns it.
func FindSummary(ctx context.Context, summaryID string) *Summary {
	tenant, err := rdb.HGet(ctx, "summary:owner", summaryID).Result()
	if err != nil {
		return nil
	}
	return LoadSummary(ctx, tenant, summaryID)
}

// CreateSummary stores the source, writes its extractive lead with citations as a new summary and returns the record.
func CreateSummary(ctx context.Context, tenant, sourceRef, content, band string, targetWords int) Summary {
	sourceHash := PutSource(ctx, tenant, sourceRef, content)
	summary := text.Lead(content, targetWords)
	s := Summary{
		SummaryID: NewSummaryID(ctx), Tenant: tenant, SourceRef: sourceRef, SourceHash: sourceHash, Band: band,
		TargetWords: targetWords, Kind: "extractive", Summary: summary, Citations: text.Cite(content, summary),
		SourceBytes: len(content), SummaryChars: len(summary), ChunksDone: len(text.Chunks(content)),
	}
	SaveSummary(ctx, s)
	return s
}

// Replay is the response recorded for (tenant, key), or nil.
func Replay(ctx context.Context, tenant, key string) map[string]any {
	raw, err := rdb.Get(ctx, "idem:"+tenant+":"+key).Result()
	if err != nil {
		return nil
	}
	var response map[string]any
	json.Unmarshal([]byte(raw), &response)
	return response
}

// Remember records the response for (tenant, key), for its replays.
func Remember(ctx context.Context, tenant, key string, response any) {
	raw, _ := json.Marshal(response)
	rdb.Set(ctx, "idem:"+tenant+":"+key, raw, 0)
}

// OutboxPut parks an event the broker did not take; a relay produces it later.
func OutboxPut(ctx context.Context, topic, key string, payload any) error {
	raw, _ := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	return rdb.RPush(ctx, "outbox", raw).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'summarizer/text.h': `// The text rules every step shares (provided).
${comment('// ', TEXT_DOC)}
// A citation is a JSON object with those five fields.
#pragma once

#include <nlohmann/json.hpp>
#include <openssl/sha.h>

#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace summarizer::text {

inline bool isSpace(char c) { return c == ' ' || c == '\\n' || c == '\\t'; }

inline std::vector<std::string> words(const std::string& s) {
  std::istringstream in(s);
  std::vector<std::string> out;
  for (std::string w; in >> w;) out.push_back(w);
  return out;
}

inline std::string join(const std::vector<std::string>& parts, size_t n) {
  std::string out;
  for (size_t i = 0; i < n && i < parts.size(); i++) out += (i ? " " : "") + parts[i];
  return out;
}

// The SHA-256 of the text in hex.
inline std::string contentHash(const std::string& s) {
  unsigned char digest[32];
  SHA256(reinterpret_cast<const unsigned char*>(s.data()), s.size(), digest);
  static const char* hex = "0123456789abcdef";
  std::string out;
  for (unsigned char b : digest) {
    out += hex[b >> 4];
    out += hex[b & 15];
  }
  return out;
}

// A source split at its blank lines.
inline std::vector<std::string> chunks(const std::string& content) {
  std::vector<std::string> out;
  size_t from = 0;
  for (size_t at; (at = content.find("\\n\\n", from)) != std::string::npos; from = at + 2) out.push_back(content.substr(from, at - from));
  out.push_back(content.substr(from));
  return out;
}

// The next sentence of s at or after offset i, as {start, end}; {npos, npos} when there is none.
inline std::pair<size_t, size_t> next(const std::string& s, size_t i) {
  const size_t n = s.size();
  while (i < n && isSpace(s[i])) i++;
  if (i >= n) return {std::string::npos, std::string::npos};
  const size_t start = i;
  for (; i < n; i++) {
    if ((s[i] == '.' || s[i] == '!' || s[i] == '?') && (i + 1 == n || isSpace(s[i + 1]))) return {start, i + 1};
  }
  size_t end = n;
  while (end > start && isSpace(s[end - 1])) end--;
  return {start, end};
}

// The {start, end} offsets of the sentences in s.
inline std::vector<std::pair<size_t, size_t>> sentences(const std::string& s) {
  std::vector<std::pair<size_t, size_t>> spans;
  for (auto span = next(s, 0); span.first != std::string::npos; span = next(s, span.second)) spans.push_back(span);
  return spans;
}

// The source's first sentences while they fit in limit words.
inline std::string lead(const std::string& content, long limit) {
  std::vector<std::string> picked;
  long count = 0;
  for (const std::string& chunk : chunks(content)) {
    for (auto span = next(chunk, 0); span.first != std::string::npos; span = next(chunk, span.second)) {
      const std::string sentence = chunk.substr(span.first, span.second - span.first);
      const auto ws = words(sentence);
      if (count + static_cast<long>(ws.size()) > limit) {
        if (picked.empty()) picked.push_back(join(ws, static_cast<size_t>(limit)));
        return join(picked, picked.size());
      }
      picked.push_back(sentence);
      count += static_cast<long>(ws.size());
    }
  }
  return join(picked, picked.size());
}

// One pointer per summary sentence the source contains verbatim (a JSON array).
inline nlohmann::json cite(const std::string& content, const std::string& summary) {
  const auto parts = chunks(content);
  nlohmann::json out = nlohmann::json::array();
  long i = 0;
  for (const auto& [start, end] : sentences(summary)) {
    const std::string sentence = summary.substr(start, end - start);
    for (size_t index = 0; index < parts.size(); index++) {
      const size_t at = parts[index].find(sentence);
      if (at == std::string::npos) continue;
      out.push_back({{"sentence", i}, {"chunk_index", index}, {"char_start", at}, {"char_end", at + sentence.size()}, {"chunk_hash", contentHash(parts[index])}});
      break;
    }
    i++;
  }
  return out;
}

}  // namespace summarizer::text
`,
  'summarizer/store.h': `// The summary store (provided).
${comment('// ', STORE_DOC)}
// A record is a JSON object with those fields (citations a JSON array, the numbers as numbers).
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>

#include "summarizer/text.h"

namespace summarizer::store {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Store the current text of a source; returns its source_hash.
inline std::string putSource(const std::string& tenant, const std::string& source_ref, const std::string& content) {
  const std::string source_hash = text::contentHash(content);
  redis().hset("source:" + tenant + ":" + source_ref, {{"source_hash", source_hash}, {"content", content}});
  return source_hash;
}

// The source as it is now: source_ref, source_hash, chunks and chunk_hashes.
inline std::optional<nlohmann::json> currentSource(const std::string& tenant, const std::string& source_ref) {
  std::unordered_map<std::string, std::string> raw = redis().hgetall("source:" + tenant + ":" + source_ref);
  if (raw.empty()) return std::nullopt;
  const auto parts = text::chunks(raw["content"]);
  nlohmann::json hashes = nlohmann::json::array();
  for (const auto& c : parts) hashes.push_back(text::contentHash(c));
  return nlohmann::json{{"source_ref", source_ref}, {"source_hash", raw["source_hash"]}, {"chunks", parts}, {"chunk_hashes", hashes}};
}

inline std::string newSummaryId() { return "s-" + std::to_string(redis().incr("summary:seq")); }

// Write the record under summary:{tenant}:{summary_id}.
inline void saveSummary(const nlohmann::json& record) {
  std::unordered_map<std::string, std::string> fields;
  for (const auto& [name, value] : record.items()) fields[name] = value.is_string() ? value.get<std::string>() : value.dump();
  const std::string tenant = record.at("tenant").get<std::string>();
  const std::string id = record.at("summary_id").get<std::string>();
  redis().hset("summary:" + tenant + ":" + id, fields.begin(), fields.end());
  redis().hset("summary:owner", id, tenant);
}

// The tenant's summary with this id, or none.
inline std::optional<nlohmann::json> loadSummary(const std::string& tenant, const std::string& summary_id) {
  std::unordered_map<std::string, std::string> raw = redis().hgetall("summary:" + tenant + ":" + summary_id);
  if (raw.empty()) return std::nullopt;
  nlohmann::json record = nlohmann::json::object();
  for (const auto& [name, value] : raw) record[name] = value;
  for (const char* name : {"target_words", "source_bytes", "summary_chars", "chunks_done"}) record[name] = std::stol(raw[name]);
  record["citations"] = nlohmann::json::parse(raw["citations"]);
  return record;
}

// The support console's lookup: the summary with this id, whatever tenant owns it.
inline std::optional<nlohmann::json> findSummary(const std::string& summary_id) {
  const auto tenant = redis().hget("summary:owner", summary_id);
  if (!tenant) return std::nullopt;
  return loadSummary(*tenant, summary_id);
}

// Store the source, write its extractive lead with citations as a new summary; returns the record.
inline nlohmann::json createSummary(const std::string& tenant, const std::string& source_ref, const std::string& content,
                                    const std::string& band, long target_words) {
  const std::string source_hash = putSource(tenant, source_ref, content);
  const std::string summary = text::lead(content, target_words);
  const nlohmann::json record = {{"summary_id", newSummaryId()},
                                 {"tenant", tenant},
                                 {"source_ref", source_ref},
                                 {"source_hash", source_hash},
                                 {"band", band},
                                 {"target_words", target_words},
                                 {"kind", "extractive"},
                                 {"model_version", ""},
                                 {"summary", summary},
                                 {"citations", text::cite(content, summary)},
                                 {"source_bytes", content.size()},
                                 {"summary_chars", summary.size()},
                                 {"chunks_done", text::chunks(content).size()}};
  saveSummary(record);
  return record;
}

// The response recorded for (tenant, key), if any.
inline std::optional<nlohmann::json> replay(const std::string& tenant, const std::string& key) {
  const auto raw = redis().get("idem:" + tenant + ":" + key);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Record the response for (tenant, key), for its replays.
inline void remember(const std::string& tenant, const std::string& key, const nlohmann::json& response) {
  redis().set("idem:" + tenant + ":" + key, response.dump());
}

// Park an event the broker did not take; a relay produces it later.
inline void outboxPut(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace summarizer::store
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('summarizer', 'Text')]: `package summarizer

import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest

import scala.collection.mutable.ArrayBuffer

/**
${comment(' * ', TEXT_DOC)}
 */
object Text {
  final case class Citation(sentence: Int, chunkIndex: Int, charStart: Int, charEnd: Int, chunkHash: String)

  private def isSpace(c: Char): Boolean = c == ' ' || c == '\\n' || c == '\\t'
  private def words(s: String): Vector[String] = s.split("\\\\s+").filter(_.nonEmpty).toVector

  def contentHash(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes(UTF_8)).map(b => "%02x".format(b & 0xff)).mkString

  def chunks(content: String): Vector[String] = content.split("\\n\\n", -1).toVector

  /** The next sentence of text at or after offset from, as (start, end). */
  private def next(text: String, from: Int): Option[(Int, Int)] = {
    var i = from
    while (i < text.length && isSpace(text(i))) i += 1
    if (i >= text.length) None
    else {
      val start = i
      var found = -1
      while (i < text.length && found < 0) {
        if (".!?".indexOf(text(i).toInt) >= 0 && (i + 1 == text.length || isSpace(text(i + 1)))) found = i + 1
        i += 1
      }
      if (found >= 0) Some((start, found))
      else {
        var end = text.length
        while (end > start && isSpace(text(end - 1))) end -= 1
        Some((start, end))
      }
    }
  }

  /** The (start, end) offsets of the sentences in text. */
  def sentences(text: String): Vector[(Int, Int)] = {
    val spans = ArrayBuffer.empty[(Int, Int)]
    var span = next(text, 0)
    while (span.isDefined) {
      spans += span.get
      span = next(text, span.get._2)
    }
    spans.toVector
  }

  /** The source's first sentences while they fit in limit words. */
  def lead(content: String, limit: Int): String = {
    val picked = ArrayBuffer.empty[String]
    var count = 0
    var full = false
    for (chunk <- chunks(content) if !full) {
      var span = next(chunk, 0)
      while (span.isDefined && !full) {
        val (start, end) = span.get
        val sentence = chunk.substring(start, end)
        val n = words(sentence).length
        if (count + n > limit) {
          if (picked.isEmpty) picked += words(sentence).take(limit).mkString(" ")
          full = true
        } else {
          picked += sentence
          count += n
          span = next(chunk, end)
        }
      }
    }
    picked.mkString(" ")
  }

  /** One pointer per summary sentence the source contains verbatim. */
  def cite(content: String, summary: String): Vector[Citation] = {
    val parts = chunks(content)
    sentences(summary).zipWithIndex.flatMap { case ((start, end), i) =>
      val sentence = summary.substring(start, end)
      parts.indexWhere(_.contains(sentence)) match {
        case -1 => None
        case index =>
          val at = parts(index).indexOf(sentence)
          Some(Citation(i, index, at, at + sentence.length, contentHash(parts(index))))
      }
    }
  }
}
`,
  [scalaPath('summarizer', 'Store')]: `package summarizer

import java.nio.charset.StandardCharsets.UTF_8

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

/**
${comment(' * ', STORE_DOC)}
 */
object Store {
  final case class Summary(
      summaryId: String,
      tenant: String,
      sourceRef: String,
      sourceHash: String,
      band: String,
      targetWords: Int,
      kind: String,
      modelVersion: String,
      summary: String,
      citations: Vector[Text.Citation],
      sourceBytes: Int,
      summaryChars: Int,
      chunksDone: Int)

  final case class Source(sourceRef: String, sourceHash: String, chunks: Vector[String], chunkHashes: Vector[String])

  val jedis = new JedisPooled("redis", 6379)

  def citationJson(c: Text.Citation): JsObject = JsObject(
    "sentence" -> JsNumber(c.sentence),
    "chunk_index" -> JsNumber(c.chunkIndex),
    "char_start" -> JsNumber(c.charStart),
    "char_end" -> JsNumber(c.charEnd),
    "chunk_hash" -> JsString(c.chunkHash))

  private def citationOf(v: JsValue): Text.Citation = {
    val f = v.asJsObject.fields
    Text.Citation(f("sentence").convertTo[Int], f("chunk_index").convertTo[Int], f("char_start").convertTo[Int], f("char_end").convertTo[Int], f("chunk_hash").convertTo[String])
  }

  /** The record as JSON, with the store's field names. */
  def toJson(s: Summary): JsObject = JsObject(
    "summary_id" -> JsString(s.summaryId),
    "tenant" -> JsString(s.tenant),
    "source_ref" -> JsString(s.sourceRef),
    "source_hash" -> JsString(s.sourceHash),
    "band" -> JsString(s.band),
    "target_words" -> JsNumber(s.targetWords),
    "kind" -> JsString(s.kind),
    "model_version" -> JsString(s.modelVersion),
    "summary" -> JsString(s.summary),
    "citations" -> JsArray(s.citations.map(citationJson)),
    "source_bytes" -> JsNumber(s.sourceBytes),
    "summary_chars" -> JsNumber(s.summaryChars),
    "chunks_done" -> JsNumber(s.chunksDone))

  /** Store the current text of a source; returns its source_hash. */
  def putSource(tenant: String, sourceRef: String, content: String): String = {
    val sourceHash = Text.contentHash(content)
    jedis.hset(s"source:$tenant:$sourceRef", Map("source_hash" -> sourceHash, "content" -> content).asJava)
    sourceHash
  }

  /** The source as it is now. */
  def currentSource(tenant: String, sourceRef: String): Option[Source] = {
    val raw = jedis.hgetAll(s"source:$tenant:$sourceRef").asScala
    if (raw.isEmpty) None
    else {
      val parts = Text.chunks(raw("content"))
      Some(Source(sourceRef, raw("source_hash"), parts, parts.map(Text.contentHash)))
    }
  }

  def newSummaryId(): String = "s-" + jedis.incr("summary:seq")

  /** Write the record under summary:{tenant}:{summary_id}. */
  def saveSummary(s: Summary): Unit = {
    val fields = toJson(s).fields.map {
      case (name, JsString(value)) => name -> value
      case (name, value) => name -> value.compactPrint
    }
    jedis.hset(s"summary:\${s.tenant}:\${s.summaryId}", fields.asJava)
    jedis.hset("summary:owner", s.summaryId, s.tenant)
  }

  private def summaryOf(raw: Map[String, String]): Option[Summary] =
    if (raw.isEmpty) None
    else
      Some(Summary(raw("summary_id"), raw("tenant"), raw("source_ref"), raw("source_hash"), raw("band"), raw("target_words").toInt,
        raw("kind"), raw("model_version"), raw("summary"), raw("citations").parseJson.asInstanceOf[JsArray].elements.map(citationOf),
        raw("source_bytes").toInt, raw("summary_chars").toInt, raw("chunks_done").toInt))

  /** The tenant's summary with this id. */
  def loadSummary(tenant: String, summaryId: String): Option[Summary] =
    summaryOf(jedis.hgetAll(s"summary:$tenant:$summaryId").asScala.toMap)

  /** The support console's lookup: the summary with this id, whatever tenant owns it. */
  def findSummary(summaryId: String): Option[Summary] =
    Option(jedis.hget("summary:owner", summaryId)).flatMap(tenant => loadSummary(tenant, summaryId))

  /** Store the source, write its extractive lead with citations as a new summary; returns the record. */
  def createSummary(tenant: String, sourceRef: String, content: String, band: String, targetWords: Int): Summary = {
    val sourceHash = putSource(tenant, sourceRef, content)
    val summary = Text.lead(content, targetWords)
    val record = Summary(newSummaryId(), tenant, sourceRef, sourceHash, band, targetWords, "extractive", "", summary,
      Text.cite(content, summary), content.getBytes(UTF_8).length, summary.length, Text.chunks(content).length)
    saveSummary(record)
    record
  }

  /** The response recorded for (tenant, key), if any. */
  def replay(tenant: String, key: String): Option[JsObject] =
    Option(jedis.get(s"idem:$tenant:$key")).map(_.parseJson.asJsObject)

  /** Record the response for (tenant, key), for its replays. */
  def remember(tenant: String, key: String, response: JsObject): Unit =
    jedis.set(s"idem:$tenant:$key", response.compactPrint)

  /** Park an event the broker did not take; a relay produces it later. */
  def outboxPut(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
};
