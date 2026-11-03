/**
 * Hand-written support modules the pii-redactor steps import but no step builds: the `redactor`
 * package. `spans` is the shared vocabulary (a span, a detection, the eight entity types, the regex
 * table for the five a pattern can find, and the helpers that order, apply and count spans). `ner` is
 * the detector client as steps 1 and 2 use it (step 3 builds the same `detect`). `store` keeps each
 * redaction (the hash `doc:{document_id}`) and the audit outbox (`outbox:privacy.redacted`). The five
 * languages keep the same keys and payloads, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'redactor/__init__.py': '',
  'redactor/spans.py': `"""
The redactor's shared vocabulary (provided). A Span is [start, end) in the original text, its entity
type and the replacement written over it; a Detection is what ner.detect answers: the spans, the
detector that found them ("model" or "regex"), whether the answer is degraded, and that detector's
version. ENTITY_TYPES are the eight types a caller may ask for, ENTITY_PATTERNS the deterministic
patterns for the five a regular expression can find; scan runs them over a text.
"""
import re
from collections import Counter
from dataclasses import dataclass

ENTITY_TYPES = ("EMAIL", "PHONE", "SSN", "CREDIT_CARD", "IP_ADDRESS", "PERSON", "LOCATION", "ORGANIZATION")
DEFAULT_ENTITIES = ("EMAIL", "PHONE", "SSN")
PATTERNS_VERSION = "regex-2026.11"
ENTITY_PATTERNS = {
    "EMAIL": re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"),
    "PHONE": re.compile(r"\\(?[0-9]{3}\\)?[ .-][0-9]{3}[ .-][0-9]{4}"),
    "SSN": re.compile(r"[0-9]{3}-[0-9]{2}-[0-9]{4}"),
    "CREDIT_CARD": re.compile(r"[0-9]{4}[ -][0-9]{4}[ -][0-9]{4}[ -][0-9]{4}"),
    "IP_ADDRESS": re.compile(r"[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}"),
}


class DetectorUnavailable(Exception):
    """No detector can answer this request: the redactor fails closed."""


@dataclass
class Span:
    start: int
    end: int
    entity: str
    replacement: str


@dataclass
class Detection:
    spans: list[Span]
    source: str
    degraded: bool
    detector_version: str


def span(start: int, end: int, entity: str) -> Span:
    """A span of entity over [start, end), replaced by [ENTITY]."""
    return Span(start, end, entity, f"[{entity}]")


def ordered(found: list[Span]) -> list[Span]:
    """The spans by start (the longer first at one start); a span overlapping the previous one is dropped."""
    out: list[Span] = []
    for s in sorted(found, key=lambda s: (s.start, -s.end)):
        if not out or s.start >= out[-1].end:
            out.append(s)
    return out


def scan(text: str, entities) -> list[Span]:
    """The deterministic pass: every match of the requested types that have a pattern, ordered."""
    return ordered([span(m.start(), m.end(), e) for e in entities if e in ENTITY_PATTERNS for m in ENTITY_PATTERNS[e].finditer(text)])


def apply_spans(text: str, found: list[Span]) -> str:
    """The text with every span replaced (the spans ordered, as ordered() returns them)."""
    out, cursor = [], 0
    for s in found:
        out.append(text[cursor:s.start])
        out.append(s.replacement)
        cursor = s.end
    out.append(text[cursor:])
    return "".join(out)


def count_entities(found: list[Span]) -> dict[str, int]:
    """How many spans of each entity type."""
    return dict(Counter(s.entity for s in found))
`,
  'redactor/ner.py': `"""
The detector client (provided; step 3 builds the same detect): one Detect call per attempt under a
600 ms deadline, at most two attempts, a second one only after UNAVAILABLE or DEADLINE_EXCEEDED.
When the attempts fail it falls back to the regex pass, marked source "regex" and degraded, if every
requested type has a pattern; otherwise it raises DetectorUnavailable.
"""
import grpc

import detector_pb2
import detector_pb2_grpc
from redactor.spans import ENTITY_PATTERNS, PATTERNS_VERSION, Detection, DetectorUnavailable, scan, span

DEADLINE_S = 0.6
MAX_ATTEMPTS = 2
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
FALLBACK_SOURCE = "regex"

detector = detector_pb2_grpc.DetectorStub(grpc.insecure_channel("detector:9000"))


def detect(text: str, entities) -> Detection:
    """The entity spans of text for the requested types."""
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = detector.Detect(detector_pb2.DetectRequest(text=text, entities=list(entities)), timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE:
                break
            continue
        return Detection([span(s.start, s.end, s.entity) for s in reply.spans], "model", False, reply.model_version)
    uncovered = [e for e in entities if e not in ENTITY_PATTERNS]
    if uncovered:
        raise DetectorUnavailable(f"the detector is down and no pattern covers {', '.join(uncovered)}")
    return Detection(scan(text, entities), FALLBACK_SOURCE, True, PATTERNS_VERSION)
`,
  'redactor/store.py': `"""
The redaction store and the audit outbox (provided), in Redis. doc:{document_id} is a hash: tenant,
spans and entity_counts (JSON), detector_version and redacted_text (the output handed back to the
caller). outbox:privacy.redacted is the list of audit events the broker refused, as JSON rows
{"event", "reason"} that a relay produces later.
"""
import json
from dataclasses import asdict, dataclass

import redis

from redactor.spans import Span, count_entities

r = redis.Redis(host="redis", port=6379, decode_responses=True)
OUTBOX_KEY = "outbox:privacy.redacted"


@dataclass
class Redaction:
    document_id: str
    tenant: str
    spans: list[Span]
    entity_counts: dict[str, int]
    detector_version: str
    redacted_text: str


def save(tenant: str, document_id: str, found: list[Span], detector_version: str, redacted_text: str) -> None:
    """Keep what the redaction of document_id produced, owned by tenant."""
    r.hset(
        f"doc:{document_id}",
        mapping={
            "tenant": tenant,
            "spans": json.dumps([asdict(s) for s in found]),
            "entity_counts": json.dumps(count_entities(found)),
            "detector_version": detector_version,
            "redacted_text": redacted_text,
        },
    )


def load(document_id: str) -> Redaction | None:
    """The redaction of document_id, whichever tenant owns it; None when there is none."""
    raw = r.hgetall(f"doc:{document_id}")
    if not raw:
        return None
    found = [Span(**s) for s in json.loads(raw["spans"])]
    return Redaction(document_id, raw["tenant"], found, json.loads(raw["entity_counts"]), raw["detector_version"], raw["redacted_text"])


def insert_outbox(event: dict, reason: str) -> None:
    """Keep an audit event the broker refused, for the relay."""
    r.rpush(OUTBOX_KEY, json.dumps({"event": event, "reason": reason}))


def outbox_rows() -> list[dict]:
    """The kept events, oldest first."""
    return [json.loads(row) for row in r.lrange(OUTBOX_KEY, 0, -1)]
`,
};

export const supportModulesTs: Record<string, string> = {
  'redactor/spans.ts': `/**
 * The redactor's shared vocabulary (provided). A Span is [start, end) in the original text, its
 * entity type and the replacement written over it; a Detection is what ner.detect answers: the
 * spans, the detector that found them ("model" or "regex"), whether the answer is degraded, and that
 * detector's version. ENTITY_TYPES are the eight types a caller may ask for, ENTITY_PATTERNS the
 * deterministic patterns for the five a regular expression can find; scan runs them over a text.
 */
export const ENTITY_TYPES: readonly string[] = ['EMAIL', 'PHONE', 'SSN', 'CREDIT_CARD', 'IP_ADDRESS', 'PERSON', 'LOCATION', 'ORGANIZATION'];
export const DEFAULT_ENTITIES: readonly string[] = ['EMAIL', 'PHONE', 'SSN'];
export const PATTERNS_VERSION = 'regex-2026.11';
export const ENTITY_PATTERNS: Readonly<Record<string, RegExp>> = {
  EMAIL: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g,
  PHONE: /\\(?[0-9]{3}\\)?[ .-][0-9]{3}[ .-][0-9]{4}/g,
  SSN: /[0-9]{3}-[0-9]{2}-[0-9]{4}/g,
  CREDIT_CARD: /[0-9]{4}[ -][0-9]{4}[ -][0-9]{4}[ -][0-9]{4}/g,
  IP_ADDRESS: /[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}/g,
};

/** No detector can answer this request: the redactor fails closed. */
export class DetectorUnavailable extends Error {}

export interface Span {
  start: number;
  end: number;
  entity: string;
  replacement: string;
}

export interface Detection {
  spans: Span[];
  source: string;
  degraded: boolean;
  detector_version: string;
}

/** A span of entity over [start, end), replaced by [ENTITY]. */
export const span = (start: number, end: number, entity: string): Span => ({start, end, entity, replacement: \`[\${entity}]\`});

/** The spans by start (the longer first at one start); a span overlapping the previous one is dropped. */
export function ordered(found: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...found].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (out.length === 0 || s.start >= out[out.length - 1].end) out.push(s);
  }
  return out;
}

/** The deterministic pass: every match of the requested types that have a pattern, ordered. */
export function scan(text: string, entities: readonly string[]): Span[] {
  const found: Span[] = [];
  for (const entity of entities) {
    const pattern = ENTITY_PATTERNS[entity];
    if (pattern === undefined) continue;
    for (const m of text.matchAll(pattern)) found.push(span(m.index, m.index + m[0].length, entity));
  }
  return ordered(found);
}

/** The text with every span replaced (the spans ordered, as ordered() returns them). */
export function applySpans(text: string, found: Span[]): string {
  let out = '';
  let cursor = 0;
  for (const s of found) {
    out += text.slice(cursor, s.start) + s.replacement;
    cursor = s.end;
  }
  return out + text.slice(cursor);
}

/** How many spans of each entity type. */
export function countEntities(found: Span[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of found) counts[s.entity] = (counts[s.entity] ?? 0) + 1;
  return counts;
}
`,
  'redactor/ner.ts': `/**
 * The detector client (provided; step 3 builds the same detect): one Detect call per attempt under a
 * 600 ms deadline, at most two attempts, a second one only after UNAVAILABLE or DEADLINE_EXCEEDED.
 * When the attempts fail it falls back to the regex pass, marked source "regex" and degraded, if
 * every requested type has a pattern; otherwise it throws DetectorUnavailable.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Detection, DetectorUnavailable, ENTITY_PATTERNS, PATTERNS_VERSION, scan, span} from 'redactor/spans';

export const DEADLINE_MS = 600;
export const MAX_ATTEMPTS = 2;
export const RETRYABLE: ReadonlySet<number> = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);
export const FALLBACK_SOURCE = 'regex';

interface DetectReply {
  spans?: {start: number; end: number; entity: string}[];
  model_version?: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('detector.proto')) as unknown as {
  redactor: {Detector: grpc.ServiceClientConstructor};
};
const detector = new pkg.redactor.Detector('detector:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Detect(request: {text: string; entities: string[]}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<DetectReply>;
};

/** The entity spans of text for the requested types. */
export async function detect(text: string, entities: readonly string[]): Promise<Detection> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await detector.Detect({text, entities: [...entities]}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      return {spans: (reply.spans ?? []).map(s => span(s.start, s.end, s.entity)), source: 'model', degraded: false, detector_version: reply.model_version ?? ''};
    } catch (e) {
      if (!RETRYABLE.has((e as grpc.ServiceError).code)) break;
    }
  }
  const uncovered = entities.filter(e => ENTITY_PATTERNS[e] === undefined);
  if (uncovered.length > 0) throw new DetectorUnavailable(\`the detector is down and no pattern covers \${uncovered.join(', ')}\`);
  return {spans: scan(text, entities), source: FALLBACK_SOURCE, degraded: true, detector_version: PATTERNS_VERSION};
}
`,
  'redactor/store.ts': `/**
 * The redaction store and the audit outbox (provided), in Redis. doc:{document_id} is a hash: tenant,
 * spans and entity_counts (JSON), detector_version and redacted_text (the output handed back to the
 * caller). outbox:privacy.redacted is the list of audit events the broker refused, as JSON rows
 * {"event", "reason"} that a relay produces later.
 */
import Redis from 'ioredis';

import {type Span, countEntities} from 'redactor/spans';

const redis = new Redis({host: 'redis', port: 6379});
export const OUTBOX_KEY = 'outbox:privacy.redacted';

export interface Redaction {
  document_id: string;
  tenant: string;
  spans: Span[];
  entity_counts: Record<string, number>;
  detector_version: string;
  redacted_text: string;
}

/** Keep what the redaction of documentId produced, owned by tenant. */
export async function save(tenant: string, documentId: string, found: Span[], detectorVersion: string, redactedText: string): Promise<void> {
  await redis.hset(\`doc:\${documentId}\`, {
    tenant,
    spans: JSON.stringify(found),
    entity_counts: JSON.stringify(countEntities(found)),
    detector_version: detectorVersion,
    redacted_text: redactedText,
  });
}

/** The redaction of documentId, whichever tenant owns it; null when there is none. */
export async function load(documentId: string): Promise<Redaction | null> {
  const raw = await redis.hgetall(\`doc:\${documentId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {
    document_id: documentId,
    tenant: raw.tenant,
    spans: JSON.parse(raw.spans) as Span[],
    entity_counts: JSON.parse(raw.entity_counts) as Record<string, number>,
    detector_version: raw.detector_version,
    redacted_text: raw.redacted_text,
  };
}

/** Keep an audit event the broker refused, for the relay. */
export async function insertOutbox(event: object, reason: string): Promise<void> {
  await redis.rpush(OUTBOX_KEY, JSON.stringify({event, reason}));
}

/** The kept events, oldest first. */
export async function outboxRows(): Promise<{event: Record<string, unknown>; reason: string}[]> {
  return (await redis.lrange(OUTBOX_KEY, 0, -1)).map(row => JSON.parse(row));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'redactor/spans/spans.go': `// Package spans is the redactor's shared vocabulary (provided). A Span is [start, end) in the
// original text, its entity type and the replacement written over it; a Detection is what ner.Detect
// answers: the spans, the detector that found them ("model" or "regex"), whether the answer is
// degraded, and that detector's version. EntityTypes are the eight types a caller may ask for,
// EntityPatterns the deterministic patterns for the five a regular expression can find; Scan runs
// them over a text.
package spans

import (
	"errors"
	"regexp"
	"sort"
	"strings"
)

var (
	EntityTypes     = []string{"EMAIL", "PHONE", "SSN", "CREDIT_CARD", "IP_ADDRESS", "PERSON", "LOCATION", "ORGANIZATION"}
	DefaultEntities = []string{"EMAIL", "PHONE", "SSN"}
	EntityPatterns  = map[string]*regexp.Regexp{
		"EMAIL":       regexp.MustCompile(\`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\`),
		"PHONE":       regexp.MustCompile(\`\\(?[0-9]{3}\\)?[ .-][0-9]{3}[ .-][0-9]{4}\`),
		"SSN":         regexp.MustCompile(\`[0-9]{3}-[0-9]{2}-[0-9]{4}\`),
		"CREDIT_CARD": regexp.MustCompile(\`[0-9]{4}[ -][0-9]{4}[ -][0-9]{4}[ -][0-9]{4}\`),
		"IP_ADDRESS":  regexp.MustCompile(\`[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\`),
	}
)

// PatternsVersion is the detector version a regex answer reports.
const PatternsVersion = "regex-2026.11"

// ErrDetectorUnavailable: no detector can answer this request, the redactor fails closed.
var ErrDetectorUnavailable = errors.New("detector unavailable")

type Span struct {
	Start       int    \`json:"start"\`
	End         int    \`json:"end"\`
	Entity      string \`json:"entity"\`
	Replacement string \`json:"replacement"\`
}

type Detection struct {
	Spans           []Span \`json:"spans"\`
	Source          string \`json:"source"\`
	Degraded        bool   \`json:"degraded"\`
	DetectorVersion string \`json:"detector_version"\`
}

// NewSpan is a span of entity over [start, end), replaced by [ENTITY].
func NewSpan(start, end int, entity string) Span {
	return Span{Start: start, End: end, Entity: entity, Replacement: "[" + entity + "]"}
}

// Ordered is the spans by start (the longer first at one start); a span overlapping the previous one is dropped.
func Ordered(found []Span) []Span {
	sorted := append([]Span{}, found...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].Start != sorted[j].Start {
			return sorted[i].Start < sorted[j].Start
		}
		return sorted[i].End > sorted[j].End
	})
	out := make([]Span, 0, len(sorted))
	for _, s := range sorted {
		if len(out) == 0 || s.Start >= out[len(out)-1].End {
			out = append(out, s)
		}
	}
	return out
}

// Scan is the deterministic pass: every match of the requested types that have a pattern, ordered.
func Scan(text string, entities []string) []Span {
	var found []Span
	for _, entity := range entities {
		pattern, ok := EntityPatterns[entity]
		if !ok {
			continue
		}
		for _, m := range pattern.FindAllStringIndex(text, -1) {
			found = append(found, NewSpan(m[0], m[1], entity))
		}
	}
	return Ordered(found)
}

// ApplySpans is the text with every span replaced (the spans ordered, as Ordered returns them).
func ApplySpans(text string, found []Span) string {
	var out strings.Builder
	cursor := 0
	for _, s := range found {
		out.WriteString(text[cursor:s.Start])
		out.WriteString(s.Replacement)
		cursor = s.End
	}
	out.WriteString(text[cursor:])
	return out.String()
}

// CountEntities is how many spans of each entity type.
func CountEntities(found []Span) map[string]int {
	counts := map[string]int{}
	for _, s := range found {
		counts[s.Entity]++
	}
	return counts
}
`,
  'redactor/ner/ner.go': `// Package ner is the detector client (provided; step 3 builds the same detect): one Detect call per
// attempt under a 600 ms deadline, at most two attempts, a second one only after UNAVAILABLE or
// DEADLINE_EXCEEDED. When the attempts fail it falls back to the regex pass, marked source "regex"
// and degraded, if every requested type has a pattern; otherwise it returns ErrDetectorUnavailable.
package ner

import (
	"context"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "redactor/gen/detector"
	"redactor/spans"
)

const (
	Deadline       = 600 * time.Millisecond
	MaxAttempts    = 2
	FallbackSource = "regex"
)

var (
	conn, _  = grpc.NewClient("detector:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	detector = pb.NewDetectorClient(conn)
)

func retryable(err error) bool {
	code := status.Code(err)
	return code == codes.Unavailable || code == codes.DeadlineExceeded
}

// Detect is the entity spans of text for the requested types.
func Detect(ctx context.Context, text string, entities []string) (spans.Detection, error) {
	for attempt := 0; attempt < MaxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, Deadline)
		reply, err := detector.Detect(callCtx, &pb.DetectRequest{Text: text, Entities: entities})
		cancel()
		if err == nil {
			found := make([]spans.Span, 0, len(reply.GetSpans()))
			for _, s := range reply.GetSpans() {
				found = append(found, spans.NewSpan(int(s.GetStart()), int(s.GetEnd()), s.GetEntity()))
			}
			return spans.Detection{Spans: found, Source: "model", DetectorVersion: reply.GetModelVersion()}, nil
		}
		if !retryable(err) {
			break
		}
	}
	var uncovered []string
	for _, entity := range entities {
		if _, ok := spans.EntityPatterns[entity]; !ok {
			uncovered = append(uncovered, entity)
		}
	}
	if len(uncovered) > 0 {
		return spans.Detection{}, fmt.Errorf("%w: the detector is down and no pattern covers %s", spans.ErrDetectorUnavailable, strings.Join(uncovered, ", "))
	}
	return spans.Detection{Spans: spans.Scan(text, entities), Source: FallbackSource, Degraded: true, DetectorVersion: spans.PatternsVersion}, nil
}
`,
  'redactor/store/store.go': `// Package store is the redaction store and the audit outbox (provided), in Redis. doc:{document_id}
// is a hash: tenant, spans and entity_counts (JSON), detector_version and redacted_text (the output
// handed back to the caller). outbox:privacy.redacted is the list of audit events the broker
// refused, as JSON rows {"event", "reason"} that a relay produces later.
package store

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"

	"redactor/spans"
)

const OutboxKey = "outbox:privacy.redacted"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Redaction struct {
	DocumentID      string         \`json:"document_id"\`
	Tenant          string         \`json:"tenant"\`
	Spans           []spans.Span   \`json:"spans"\`
	EntityCounts    map[string]int \`json:"entity_counts"\`
	DetectorVersion string         \`json:"detector_version"\`
	RedactedText    string         \`json:"redacted_text"\`
}

type OutboxRow struct {
	Event  json.RawMessage \`json:"event"\`
	Reason string          \`json:"reason"\`
}

// Save keeps what the redaction of documentID produced, owned by tenant.
func Save(ctx context.Context, tenant, documentID string, found []spans.Span, detectorVersion, redactedText string) error {
	if found == nil {
		found = []spans.Span{}
	}
	rawSpans, _ := json.Marshal(found)
	counts, _ := json.Marshal(spans.CountEntities(found))
	return rdb.HSet(ctx, "doc:"+documentID, map[string]any{
		"tenant":           tenant,
		"spans":            string(rawSpans),
		"entity_counts":    string(counts),
		"detector_version": detectorVersion,
		"redacted_text":    redactedText,
	}).Err()
}

// Load is the redaction of documentID, whichever tenant owns it; nil when there is none.
func Load(ctx context.Context, documentID string) (*Redaction, error) {
	raw, err := rdb.HGetAll(ctx, "doc:"+documentID).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	r := &Redaction{DocumentID: documentID, Tenant: raw["tenant"], DetectorVersion: raw["detector_version"], RedactedText: raw["redacted_text"]}
	if err := json.Unmarshal([]byte(raw["spans"]), &r.Spans); err != nil {
		return nil, err
	}
	return r, json.Unmarshal([]byte(raw["entity_counts"]), &r.EntityCounts)
}

// InsertOutbox keeps an audit event (its JSON) the broker refused, for the relay.
func InsertOutbox(ctx context.Context, event []byte, reason string) error {
	row, _ := json.Marshal(OutboxRow{Event: event, Reason: reason})
	return rdb.RPush(ctx, OutboxKey, row).Err()
}

// OutboxRows is the kept events, oldest first.
func OutboxRows(ctx context.Context) ([]OutboxRow, error) {
	raw, err := rdb.LRange(ctx, OutboxKey, 0, -1).Result()
	if err != nil {
		return nil, err
	}
	rows := make([]OutboxRow, 0, len(raw))
	for _, item := range raw {
		var row OutboxRow
		if err := json.Unmarshal([]byte(item), &row); err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'redactor/spans.h': `// The redactor's shared vocabulary (provided). A Span is [start, end) in the original text, its
// entity type and the replacement written over it; a Detection is what ner::detect answers: the
// spans, the detector that found them ("model" or "regex"), whether the answer is degraded, and that
// detector's version. kEntityTypes are the eight types a caller may ask for, kEntityPatterns the
// deterministic patterns for the five a regular expression can find; scan runs them over a text.
#pragma once

#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <regex>
#include <stdexcept>
#include <string>
#include <vector>

namespace spans {

inline const std::vector<std::string> kEntityTypes = {"EMAIL", "PHONE", "SSN", "CREDIT_CARD", "IP_ADDRESS", "PERSON", "LOCATION", "ORGANIZATION"};
inline const std::vector<std::string> kDefaultEntities = {"EMAIL", "PHONE", "SSN"};
inline const std::string kPatternsVersion = "regex-2026.11";
inline const std::map<std::string, std::regex> kEntityPatterns = {
    {"EMAIL", std::regex(R"re([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})re")},
    {"PHONE", std::regex(R"re(\\(?[0-9]{3}\\)?[ .-][0-9]{3}[ .-][0-9]{4})re")},
    {"SSN", std::regex(R"re([0-9]{3}-[0-9]{2}-[0-9]{4})re")},
    {"CREDIT_CARD", std::regex(R"re([0-9]{4}[ -][0-9]{4}[ -][0-9]{4}[ -][0-9]{4})re")},
    {"IP_ADDRESS", std::regex(R"re([0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3})re")},
};

// No detector can answer this request: the redactor fails closed.
struct DetectorUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

struct Span {
  int start = 0;
  int end = 0;
  std::string entity;
  std::string replacement;
};

inline void to_json(nlohmann::json& j, const Span& s) {
  j = nlohmann::json{{"start", s.start}, {"end", s.end}, {"entity", s.entity}, {"replacement", s.replacement}};
}

inline void from_json(const nlohmann::json& j, Span& s) {
  s.start = j.at("start").get<int>();
  s.end = j.at("end").get<int>();
  s.entity = j.at("entity").get<std::string>();
  s.replacement = j.at("replacement").get<std::string>();
}

struct Detection {
  std::vector<Span> spans;
  std::string source;
  bool degraded = false;
  std::string detector_version;
};

// A span of entity over [start, end), replaced by [ENTITY].
inline Span span(int start, int end, const std::string& entity) { return Span{start, end, entity, "[" + entity + "]"}; }

// The spans by start (the longer first at one start); a span overlapping the previous one is dropped.
inline std::vector<Span> ordered(std::vector<Span> found) {
  std::stable_sort(found.begin(), found.end(), [](const Span& a, const Span& b) { return a.start != b.start ? a.start < b.start : a.end > b.end; });
  std::vector<Span> out;
  for (const Span& s : found) {
    if (out.empty() || s.start >= out.back().end) out.push_back(s);
  }
  return out;
}

// The deterministic pass: every match of the requested types that have a pattern, ordered.
inline std::vector<Span> scan(const std::string& text, const std::vector<std::string>& entities) {
  std::vector<Span> found;
  for (const std::string& entity : entities) {
    const auto pattern = kEntityPatterns.find(entity);
    if (pattern == kEntityPatterns.end()) continue;
    for (auto m = std::sregex_iterator(text.begin(), text.end(), pattern->second); m != std::sregex_iterator(); ++m) {
      const int start = static_cast<int>(m->position(0));
      found.push_back(span(start, start + static_cast<int>(m->length(0)), entity));
    }
  }
  return ordered(found);
}

// The text with every span replaced (the spans ordered, as ordered() returns them).
inline std::string apply_spans(const std::string& text, const std::vector<Span>& found) {
  std::string out;
  size_t cursor = 0;
  for (const Span& s : found) {
    out += text.substr(cursor, s.start - cursor);
    out += s.replacement;
    cursor = s.end;
  }
  return out + text.substr(cursor);
}

// How many spans of each entity type.
inline std::map<std::string, int> count_entities(const std::vector<Span>& found) {
  std::map<std::string, int> counts;
  for (const Span& s : found) counts[s.entity]++;
  return counts;
}

}  // namespace spans
`,
  'redactor/ner.h': `// The detector client (provided; step 3 builds the same detect): one Detect call per attempt under a
// 600 ms deadline, at most two attempts, a second one only after UNAVAILABLE or DEADLINE_EXCEEDED.
// When the attempts fail it falls back to the regex pass, marked source "regex" and degraded, if
// every requested type has a pattern; otherwise it throws spans::DetectorUnavailable.
#pragma once

#include <grpcpp/grpcpp.h>

#include <chrono>
#include <memory>
#include <string>
#include <vector>

#include "detector.grpc.pb.h"
#include "redactor/spans.h"

namespace ner {

constexpr std::chrono::milliseconds kDeadline{600};
constexpr int kMaxAttempts = 2;
inline const std::string kFallbackSource = "regex";

inline redactor::Detector::Stub& detector() {
  static std::unique_ptr<redactor::Detector::Stub> stub =
      redactor::Detector::NewStub(grpc::CreateChannel("detector:9000", grpc::InsecureChannelCredentials()));
  return *stub;
}

inline bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
}

// The entity spans of text for the requested types.
inline spans::Detection detect(const std::string& text, const std::vector<std::string>& entities) {
  redactor::DetectRequest request;
  request.set_text(text);
  for (const std::string& entity : entities) request.add_entities(entity);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    redactor::DetectResponse reply;
    const grpc::Status status = detector().Detect(&ctx, request, &reply);
    if (status.ok()) {
      spans::Detection detection{{}, "model", false, reply.model_version()};
      for (const auto& s : reply.spans()) detection.spans.push_back(spans::span(s.start(), s.end(), s.entity()));
      return detection;
    }
    if (!retryable(status.error_code())) break;
  }
  std::string uncovered;
  for (const std::string& entity : entities) {
    if (spans::kEntityPatterns.count(entity) == 0) uncovered += (uncovered.empty() ? "" : ", ") + entity;
  }
  if (!uncovered.empty()) throw spans::DetectorUnavailable("the detector is down and no pattern covers " + uncovered);
  return spans::Detection{spans::scan(text, entities), kFallbackSource, true, spans::kPatternsVersion};
}

}  // namespace ner
`,
  'redactor/store.h': `// The redaction store and the audit outbox (provided), in Redis. doc:{document_id} is a hash: tenant,
// spans and entity_counts (JSON), detector_version and redacted_text (the output handed back to the
// caller). outbox:privacy.redacted is the list of audit events the broker refused, as JSON rows
// {"event", "reason"} that a relay produces later.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "redactor/spans.h"

namespace store {

inline const std::string kOutboxKey = "outbox:privacy.redacted";

struct Redaction {
  std::string document_id;
  std::string tenant;
  std::vector<spans::Span> spans;
  std::map<std::string, int> entity_counts;
  std::string detector_version;
  std::string redacted_text;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Keep what the redaction of document_id produced, owned by tenant.
inline void save(const std::string& tenant, const std::string& document_id, const std::vector<spans::Span>& found,
                 const std::string& detector_version, const std::string& redacted_text) {
  const std::unordered_map<std::string, std::string> fields = {
      {"tenant", tenant},
      {"spans", nlohmann::json(found).dump()},
      {"entity_counts", nlohmann::json(spans::count_entities(found)).dump()},
      {"detector_version", detector_version},
      {"redacted_text", redacted_text},
  };
  redis().hset("doc:" + document_id, fields.begin(), fields.end());
}

// The redaction of document_id, whichever tenant owns it; none when there is none.
inline std::optional<Redaction> load(const std::string& document_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall("doc:" + document_id, std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  Redaction r;
  r.document_id = document_id;
  r.tenant = raw["tenant"];
  r.spans = nlohmann::json::parse(raw["spans"]).get<std::vector<spans::Span>>();
  r.entity_counts = nlohmann::json::parse(raw["entity_counts"]).get<std::map<std::string, int>>();
  r.detector_version = raw["detector_version"];
  r.redacted_text = raw["redacted_text"];
  return r;
}

// Keep an audit event the broker refused, for the relay.
inline void insert_outbox(const nlohmann::json& event, const std::string& reason) {
  redis().rpush(kOutboxKey, nlohmann::json{{"event", event}, {"reason", reason}}.dump());
}

// The kept events, oldest first.
inline std::vector<nlohmann::json> outbox_rows() {
  std::vector<std::string> raw;
  redis().lrange(kOutboxKey, 0, -1, std::back_inserter(raw));
  std::vector<nlohmann::json> rows;
  for (const std::string& row : raw) rows.push_back(nlohmann::json::parse(row));
  return rows;
}

}  // namespace store
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('redactor', 'Spans')]: `package redactor

import scala.util.matching.Regex

import spray.json._

/** No detector can answer this request: the redactor fails closed. */
final class DetectorUnavailable(message: String) extends Exception(message)

/**
 * The redactor's shared vocabulary (provided). A Span is [start, end) in the original text, its
 * entity type and the replacement written over it; a Detection is what Ner.detect answers: the
 * spans, the detector that found them ("model" or "regex"), whether the answer is degraded, and that
 * detector's version. EntityTypes are the eight types a caller may ask for, EntityPatterns the
 * deterministic patterns for the five a regular expression can find; scan runs them over a text.
 */
object Spans {
  final case class Span(start: Int, end: Int, entity: String, replacement: String)
  final case class Detection(spans: Seq[Span], source: String, degraded: Boolean, detectorVersion: String)

  val EntityTypes: Seq[String] = Seq("EMAIL", "PHONE", "SSN", "CREDIT_CARD", "IP_ADDRESS", "PERSON", "LOCATION", "ORGANIZATION")
  val DefaultEntities: Seq[String] = Seq("EMAIL", "PHONE", "SSN")
  val PatternsVersion = "regex-2026.11"
  val EntityPatterns: Map[String, Regex] = Map(
    "EMAIL" -> """[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}""".r,
    "PHONE" -> """\\(?[0-9]{3}\\)?[ .-][0-9]{3}[ .-][0-9]{4}""".r,
    "SSN" -> """[0-9]{3}-[0-9]{2}-[0-9]{4}""".r,
    "CREDIT_CARD" -> """[0-9]{4}[ -][0-9]{4}[ -][0-9]{4}[ -][0-9]{4}""".r,
    "IP_ADDRESS" -> """[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}""".r,
  )

  /** A span of entity over [start, end), replaced by [ENTITY]. */
  def span(start: Int, end: Int, entity: String): Span = Span(start, end, entity, s"[$entity]")

  /** The spans by start (the longer first at one start); a span overlapping the previous one is dropped. */
  def ordered(found: Seq[Span]): Seq[Span] =
    found.sortBy(s => (s.start, -s.end)).foldLeft(Vector.empty[Span]) { (out, s) =>
      if (out.isEmpty || s.start >= out.last.end) out :+ s else out
    }

  /** The deterministic pass: every match of the requested types that have a pattern, ordered. */
  def scan(text: String, entities: Seq[String]): Seq[Span] =
    ordered(for {
      entity <- entities
      pattern <- EntityPatterns.get(entity).toSeq
      m <- pattern.findAllMatchIn(text)
    } yield span(m.start, m.end, entity))

  /** The text with every span replaced (the spans ordered, as ordered returns them). */
  def applySpans(text: String, found: Seq[Span]): String = {
    val out = new StringBuilder
    var cursor = 0
    found.foreach { s =>
      out ++= text.substring(cursor, s.start) ++= s.replacement
      cursor = s.end
    }
    (out ++= text.substring(cursor)).toString
  }

  /** How many spans of each entity type. */
  def countEntities(found: Seq[Span]): Map[String, Int] = found.groupBy(_.entity).map { case (entity, all) => entity -> all.size }

  def spanJson(s: Span): JsObject =
    JsObject("start" -> JsNumber(s.start), "end" -> JsNumber(s.end), "entity" -> JsString(s.entity), "replacement" -> JsString(s.replacement))

  def countsJson(counts: Map[String, Int]): JsObject = JsObject(counts.map { case (entity, n) => entity -> JsNumber(n) })
}
`,
  [scalaPath('redactor', 'Ner')]: `package redactor

import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import redactor.Spans.{Detection, EntityPatterns, PatternsVersion, scan, span}
import redactor.detector.{DetectRequest, DetectorGrpc}

/**
 * The detector client (provided; step 3 builds the same detect): one Detect call per attempt under a
 * 600 ms deadline, at most two attempts, a second one only after UNAVAILABLE or DEADLINE_EXCEEDED.
 * When the attempts fail it falls back to the regex pass, marked source "regex" and degraded, if
 * every requested type has a pattern; otherwise it throws DetectorUnavailable.
 */
object Ner {
  val DeadlineMs = 600L
  val MaxAttempts = 2
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)
  val FallbackSource = "regex"

  private val detector = DetectorGrpc.blockingStub(ManagedChannelBuilder.forAddress("detector", 9000).usePlaintext().build())

  /** The entity spans of text for the requested types. */
  def detect(text: String, entities: Seq[String]): Detection = {
    var attempt = 0
    var retry = true
    while (attempt < MaxAttempts && retry) {
      attempt += 1
      try {
        val reply = detector.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).detect(DetectRequest(text = text, entities = entities))
        return Detection(reply.spans.map(s => span(s.start, s.end, s.entity)), "model", degraded = false, reply.modelVersion)
      } catch {
        case e: StatusRuntimeException => retry = Retryable.contains(e.getStatus.getCode)
      }
    }
    val uncovered = entities.filterNot(EntityPatterns.contains)
    if (uncovered.nonEmpty) throw new DetectorUnavailable(s"the detector is down and no pattern covers \${uncovered.mkString(", ")}")
    Detection(scan(text, entities), FallbackSource, degraded = true, PatternsVersion)
  }
}
`,
  [scalaPath('redactor', 'Store')]: `package redactor

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import redactor.Spans.{Span, countEntities, countsJson, spanJson}

/**
 * The redaction store and the audit outbox (provided), in Redis. doc:{document_id} is a hash: tenant,
 * spans and entity_counts (JSON), detector_version and redacted_text (the output handed back to the
 * caller). outbox:privacy.redacted is the list of audit events the broker refused, as JSON rows
 * {"event", "reason"} that a relay produces later.
 */
object Store {
  final case class Redaction(
      documentId: String,
      tenant: String,
      spans: Seq[Span],
      entityCounts: Map[String, Int],
      detectorVersion: String,
      redactedText: String,
  )

  val OutboxKey = "outbox:privacy.redacted"

  private val jedis = new JedisPooled("redis", 6379)

  /** Keep what the redaction of documentId produced, owned by tenant. */
  def save(tenant: String, documentId: String, found: Seq[Span], detectorVersion: String, redactedText: String): Unit = {
    val fields = Map(
      "tenant" -> tenant,
      "spans" -> JsArray(found.map(spanJson).toVector).compactPrint,
      "entity_counts" -> countsJson(countEntities(found)).compactPrint,
      "detector_version" -> detectorVersion,
      "redacted_text" -> redactedText,
    )
    jedis.hset(s"doc:$documentId", fields.asJava)
  }

  /** The redaction of documentId, whichever tenant owns it; None when there is none. */
  def load(documentId: String): Option[Redaction] = {
    val raw = jedis.hgetAll(s"doc:$documentId").asScala.toMap
    if (raw.isEmpty) None
    else {
      val found = raw("spans").parseJson.asInstanceOf[JsArray].elements.map { v =>
        val f = v.asJsObject.fields
        Span(f("start").asInstanceOf[JsNumber].value.toInt, f("end").asInstanceOf[JsNumber].value.toInt,
          f("entity").asInstanceOf[JsString].value, f("replacement").asInstanceOf[JsString].value)
      }
      val counts = raw("entity_counts").parseJson.asJsObject.fields.map { case (entity, n) => entity -> n.asInstanceOf[JsNumber].value.toInt }
      Some(Redaction(documentId, raw("tenant"), found, counts, raw("detector_version"), raw("redacted_text")))
    }
  }

  /** Keep an audit event the broker refused, for the relay. */
  def insertOutbox(event: JsObject, reason: String): Unit =
    jedis.rpush(OutboxKey, JsObject("event" -> event, "reason" -> JsString(reason)).compactPrint)

  /** The kept events, oldest first. */
  def outboxRows(): Seq[JsObject] = jedis.lrange(OutboxKey, 0, -1).asScala.toSeq.map(_.parseJson.asJsObject)
}
`,
};
