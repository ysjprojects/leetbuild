/**
 * Hand-written support modules the promptguard steps import but no step builds: the `promptguard`
 * package. `config` is the contract every step agrees on (the model's address, the topic, the key
 * layout, the refusal text); `tokens` the course tokenizer and the repeat ratio; `documents` the
 * document store; `asks` the answers kept by (user, Idempotency-Key); `types` the values the steps
 * hand each other; and `model` the deterministic stand-in the checks serve over gRPC in place of the
 * model.
 */
import {CPP_DIGEST_H, CPP_IDS_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'promptguard/__init__.py': '',
  'promptguard/config.py': `"""Addresses, topics, keys and the refusal every step of promptguard agrees on."""
# The model's gRPC address: a stand-in served by the checks (promptguard.model).
MODEL = "model:9000"
# One security event per decision, keyed by user.
TOPIC = "prompt.security"
# The consumer group that counts attack signatures.
GROUP = "signatures"
# What a refused question gets back: the same text whatever the reason.
REFUSAL = "I cannot answer that from this document."


def limit_key(user: str, window: int) -> str:
    """The user's question counter for one 60-second window (window = unix seconds // 60)."""
    return f"limits:{user}:{window}"


def flagged_key(digest: str) -> str:
    """A question the model layer rejected, by the SHA-256 hex of its text."""
    return f"flagged:{digest}"


def session_key(user: str, document_id: str) -> str:
    """The hashes of the user's latest questions about one document, newest first."""
    return f"session:{user}:{document_id}"


def signatures_key(hour: int) -> str:
    """Refusals counted per signature for one hour (hour = unix seconds // 3600)."""
    return f"signatures:{hour}"
`,
  'promptguard/tokens.py': `"""
The course tokenizer (provided), a deterministic stand-in for a model's vocabulary such as
cl100k_base: a run of ASCII letters, digits and underscores is one token, every other character is a
token of its own, and space, newline and tab only separate tokens. A backspace, a carriage return or
a backslash is a token, as it is for the model.
"""
SEPARATORS = " \\n\\t"


def tokenize(text: str) -> list[str]:
    tokens: list[str] = []
    word: list[str] = []
    for ch in text:
        if ch.isascii() and (ch.isalnum() or ch == "_"):
            word.append(ch)
            continue
        if word:
            tokens.append("".join(word))
            word = []
        if ch not in SEPARATORS:
            tokens.append(ch)
    if word:
        tokens.append("".join(word))
    return tokens


def repeat_ratio(tokens: list[str]) -> float:
    """The share of the tokens covered by the most repeated sequence of 1, 2 or 3 tokens (0 to 1)."""
    if not tokens:
        return 0.0
    best = 0
    for n in (1, 2, 3):
        counts: dict[tuple[str, ...], int] = {}
        for i in range(len(tokens) - n + 1):
            gram = tuple(tokens[i : i + n])
            counts[gram] = counts.get(gram, 0) + 1
            best = max(best, counts[gram] * n)
    return min(1.0, best / len(tokens))
`,
  'promptguard/documents.py': `"""The document store (provided): each document's text in Redis under doc:{id}."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def get(document_id: str) -> str | None:
    """The document's text, None when the id is unknown."""
    return r.get(f"doc:{document_id}")
`,
  'promptguard/asks.py': `"""Answers kept by (user, Idempotency-Key) (provided): a retried question gets the stored decision back."""
import json

import redis

ASK_TTL_S = 86_400

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def get(user: str, idem_key: str) -> dict | None:
    """The decision stored for this user and key, None when there is none."""
    raw = r.get(f"ask:{user}:{idem_key}")
    return json.loads(raw) if raw else None


def put(user: str, idem_key: str, decision: dict) -> None:
    """Keep the decision for a day under (user, idem_key)."""
    r.set(f"ask:{user}:{idem_key}", json.dumps(decision), ex=ASK_TTL_S)
`,
  'promptguard/types.py': `"""The values the steps hand each other (provided)."""
from dataclasses import dataclass


@dataclass
class Admission:
    """Step 2's answer to "may this user ask now?"."""

    ok: bool
    remaining: int
    # Seconds until the user's window frees up; 0 when the question is admitted.
    retry_after: int


@dataclass
class ModelAnswer:
    """What step 3 returns: the answer and the passages of the document it cites."""

    answer: str
    spans: list[str]


@dataclass
class Decision:
    """What step 4 decides for one question, and what the client and the event see of it."""

    request_id: str
    document_hash: str
    answer: str
    spans: list[str]
    refused: bool
    signals: list[str]
    signature: str


class Rejected(Exception):
    """The model layer refuses the reply: a leaked canary, or a reply outside the answer schema."""


class ModelUnavailable(Exception):
    """The model did not answer: still UNAVAILABLE after the retry, or past the deadline."""
`,
  'promptguard/model.py': `"""
The stand-in for the model. The checks serve it over gRPC (Model.Complete at
promptguard.config.MODEL); the service's code never calls it directly. Deterministic on purpose: the
course grades what the service does around the model, never the prose.

complete(prompt) -> the reply text. The document is what stands between "<<<DOCUMENT" + newline and
newline + "DOCUMENT>>>" (empty without them); its first sentence is the answer, as JSON
{"answer": first, "spans": [first]}, unless the prompt contains
  LEAK-PROBE        everything before "<<<DOCUMENT" comes back: the instructions, echoed
  FREEFORM-PROBE    plain prose, not JSON
  SHAPE-PROBE       JSON without "spans"
  UNGROUNDED-PROBE  an answer citing a span the document does not contain
  SECRET-PROBE      the first sentence plus an e-mail address and an AWS key the document does not hold
  DIVERGE-PROBE     one word 120 times, citing the first sentence
"""
import json

OPEN = "<<<DOCUMENT\\n"
CLOSE = "\\nDOCUMENT>>>"


def first_sentence(document: str) -> str:
    head = document.strip().split(".")[0].strip()
    return head + "." if head else ""


def complete(prompt: str) -> str:
    start = prompt.find(OPEN)
    end = prompt.find(CLOSE, start + len(OPEN)) if start >= 0 else -1
    document = prompt[start + len(OPEN) : end] if start >= 0 and end >= 0 else ""
    first = first_sentence(document)
    if "LEAK-PROBE" in prompt:
        return prompt.split("<<<DOCUMENT")[0]
    if "FREEFORM-PROBE" in prompt:
        return "The notice period is thirty days."
    if "SHAPE-PROBE" in prompt:
        return json.dumps({"answer": first})
    if "UNGROUNDED-PROBE" in prompt:
        made_up = "The notice period is ninety days."
        return json.dumps({"answer": made_up, "spans": [made_up]})
    if "SECRET-PROBE" in prompt:
        return json.dumps({"answer": first + " Write to ops@corp.example with key AKIAIOSFODNN7EXAMPLE.", "spans": [first]})
    if "DIVERGE-PROBE" in prompt:
        return json.dumps({"answer": " ".join(["dog"] * 120), "spans": [first]})
    return json.dumps({"answer": first, "spans": [first]})
`,
};

export const supportModulesTs: Record<string, string> = {
  'promptguard/config.ts': `/** Addresses, topics, keys and the refusal every step of promptguard agrees on. */
/** The model's gRPC address: a stand-in served by the checks (promptguard/model). */
export const MODEL = 'model:9000';
/** One security event per decision, keyed by user. */
export const TOPIC = 'prompt.security';
/** The consumer group that counts attack signatures. */
export const GROUP = 'signatures';
/** What a refused question gets back: the same text whatever the reason. */
export const REFUSAL = 'I cannot answer that from this document.';

/** The user's question counter for one 60-second window (window = unix seconds / 60, floored). */
export const limitKey = (user: string, window: number): string => \`limits:\${user}:\${window}\`;
/** A question the model layer rejected, by the SHA-256 hex of its text. */
export const flaggedKey = (digest: string): string => \`flagged:\${digest}\`;
/** The hashes of the user's latest questions about one document, newest first. */
export const sessionKey = (user: string, documentId: string): string => \`session:\${user}:\${documentId}\`;
/** Refusals counted per signature for one hour (hour = unix seconds / 3600, floored). */
export const signaturesKey = (hour: number): string => \`signatures:\${hour}\`;
`,
  'promptguard/tokens.ts': `/**
 * The course tokenizer (provided), a deterministic stand-in for a model's vocabulary such as
 * cl100k_base: a run of ASCII letters, digits and underscores is one token, every other character is
 * a token of its own, and space, newline and tab only separate tokens. A backspace, a carriage return
 * or a backslash is a token, as it is for the model.
 */
const WORD = /^[A-Za-z0-9_]$/;
const SEPARATORS = ' \\n\\t';

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let word = '';
  for (const ch of text) {
    if (WORD.test(ch)) {
      word += ch;
      continue;
    }
    if (word !== '') {
      tokens.push(word);
      word = '';
    }
    if (!SEPARATORS.includes(ch)) tokens.push(ch);
  }
  if (word !== '') tokens.push(word);
  return tokens;
}

/** The share of the tokens covered by the most repeated sequence of 1, 2 or 3 tokens (0 to 1). */
export function repeatRatio(tokens: string[]): number {
  if (tokens.length === 0) return 0;
  let best = 0;
  for (const n of [1, 2, 3]) {
    const counts = new Map<string, number>();
    for (let i = 0; i + n <= tokens.length; i++) {
      const gram = tokens.slice(i, i + n).join('\\x1f');
      const seen = (counts.get(gram) ?? 0) + 1;
      counts.set(gram, seen);
      best = Math.max(best, seen * n);
    }
  }
  return Math.min(1, best / tokens.length);
}
`,
  'promptguard/documents.ts': `/** The document store (provided): each document's text in Redis under doc:{id}. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const documents = {
  /** The document's text, null when the id is unknown. */
  async get(documentId: string): Promise<string | null> {
    return redis.get(\`doc:\${documentId}\`);
  },
};
`,
  'promptguard/asks.ts': `/** Answers kept by (user, Idempotency-Key) (provided): a retried question gets the stored decision back. */
import Redis from 'ioredis';

import type {Decision} from 'promptguard/types';

export const ASK_TTL_S = 86_400;

const redis = new Redis({host: 'redis', port: 6379});

export const asks = {
  /** The decision stored for this user and key, null when there is none. */
  async get(user: string, idemKey: string): Promise<Decision | null> {
    const raw = await redis.get(\`ask:\${user}:\${idemKey}\`);
    return raw === null ? null : (JSON.parse(raw) as Decision);
  },

  /** Keep the decision for a day under (user, idemKey). */
  async put(user: string, idemKey: string, decision: Decision): Promise<void> {
    await redis.set(\`ask:\${user}:\${idemKey}\`, JSON.stringify(decision), 'EX', ASK_TTL_S);
  },
};
`,
  'promptguard/types.ts': `/** The values the steps hand each other (provided). */

/** Step 2's answer to "may this user ask now?". retry_after: seconds until the window frees up, 0 when admitted. */
export interface Admission {
  ok: boolean;
  remaining: number;
  retry_after: number;
}

/** What step 3 returns: the answer and the passages of the document it cites. */
export interface ModelAnswer {
  answer: string;
  spans: string[];
}

/** What step 4 decides for one question, and what the client and the event see of it. */
export interface Decision {
  request_id: string;
  document_hash: string;
  answer: string;
  spans: string[];
  refused: boolean;
  signals: string[];
  signature: string;
}

/** The model layer refuses the reply: a leaked canary, or a reply outside the answer schema. */
export class Rejected extends Error {
  override name = 'Rejected';
}

/** The model did not answer: still UNAVAILABLE after the retry, or past the deadline. */
export class ModelUnavailable extends Error {
  override name = 'ModelUnavailable';
}
`,
  'promptguard/model.ts': `/**
 * The stand-in for the model. The checks serve it over gRPC (Model.Complete at promptguard/config's
 * MODEL); the service's code never calls it directly. Deterministic on purpose: the course grades
 * what the service does around the model, never the prose.
 *
 * complete(prompt) → the reply text. The document is what stands between "<<<DOCUMENT" + newline and
 * newline + "DOCUMENT>>>" (empty without them); its first sentence is the answer, as JSON
 * {"answer": first, "spans": [first]}, unless the prompt contains
 *   LEAK-PROBE        everything before "<<<DOCUMENT" comes back: the instructions, echoed
 *   FREEFORM-PROBE    plain prose, not JSON
 *   SHAPE-PROBE       JSON without "spans"
 *   UNGROUNDED-PROBE  an answer citing a span the document does not contain
 *   SECRET-PROBE      the first sentence plus an e-mail address and an AWS key the document does not hold
 *   DIVERGE-PROBE     one word 120 times, citing the first sentence
 */
const OPEN = '<<<DOCUMENT\\n';
const CLOSE = '\\nDOCUMENT>>>';

export function firstSentence(document: string): string {
  const head = document.trim().split('.')[0].trim();
  return head === '' ? '' : head + '.';
}

export function complete(prompt: string): string {
  const start = prompt.indexOf(OPEN);
  const end = start >= 0 ? prompt.indexOf(CLOSE, start + OPEN.length) : -1;
  const document = start >= 0 && end >= 0 ? prompt.slice(start + OPEN.length, end) : '';
  const first = firstSentence(document);
  if (prompt.includes('LEAK-PROBE')) return prompt.split('<<<DOCUMENT')[0];
  if (prompt.includes('FREEFORM-PROBE')) return 'The notice period is thirty days.';
  if (prompt.includes('SHAPE-PROBE')) return JSON.stringify({answer: first});
  if (prompt.includes('UNGROUNDED-PROBE')) {
    const madeUp = 'The notice period is ninety days.';
    return JSON.stringify({answer: madeUp, spans: [madeUp]});
  }
  if (prompt.includes('SECRET-PROBE'))
    return JSON.stringify({answer: first + ' Write to ops@corp.example with key AKIAIOSFODNN7EXAMPLE.', spans: [first]});
  if (prompt.includes('DIVERGE-PROBE')) return JSON.stringify({answer: Array(120).fill('dog').join(' '), spans: [first]});
  return JSON.stringify({answer: first, spans: [first]});
}
`,
};

/** The Go twins: the same \`promptguard\` packages, imported as promptguard/config, promptguard/tokens, … */
export const supportModulesGo: Record<string, string> = {
  'promptguard/config/config.go': `// Package config holds the addresses, topics, keys and the refusal every step of promptguard agrees on.
package config

import "strconv"

const (
	// Model is the model's gRPC address: a stand-in served by the checks (promptguard/model).
	Model = "model:9000"
	// Topic carries one security event per decision, keyed by user.
	Topic = "prompt.security"
	// Group is the consumer group that counts attack signatures.
	Group = "signatures"
	// Refusal is what a refused question gets back: the same text whatever the reason.
	Refusal = "I cannot answer that from this document."
)

// LimitKey is the user's question counter for one 60-second window (window = unix seconds / 60).
func LimitKey(user string, window int64) string { return "limits:" + user + ":" + strconv.FormatInt(window, 10) }

// FlaggedKey is a question the model layer rejected, by the SHA-256 hex of its text.
func FlaggedKey(digest string) string { return "flagged:" + digest }

// SessionKey holds the hashes of the user's latest questions about one document, newest first.
func SessionKey(user, documentID string) string { return "session:" + user + ":" + documentID }

// SignaturesKey counts refusals per signature for one hour (hour = unix seconds / 3600).
func SignaturesKey(hour int64) string { return "signatures:" + strconv.FormatInt(hour, 10) }
`,
  'promptguard/tokens/tokens.go': `// Package tokens is the course tokenizer (provided), a deterministic stand-in for a model's
// vocabulary such as cl100k_base: a run of ASCII letters, digits and underscores is one token, every
// other character is a token of its own, and space, newline and tab only separate tokens. A
// backspace, a carriage return or a backslash is a token, as it is for the model.
package tokens

import "strings"

func isWord(r rune) bool {
	return r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
}

// Tokenize splits text into the course's tokens.
func Tokenize(text string) []string {
	tokens := []string{}
	var word strings.Builder
	for _, r := range text {
		if isWord(r) {
			word.WriteRune(r)
			continue
		}
		if word.Len() > 0 {
			tokens = append(tokens, word.String())
			word.Reset()
		}
		if r != ' ' && r != '\\n' && r != '\\t' {
			tokens = append(tokens, string(r))
		}
	}
	if word.Len() > 0 {
		tokens = append(tokens, word.String())
	}
	return tokens
}

// RepeatRatio is the share of the tokens covered by the most repeated sequence of 1, 2 or 3 tokens (0 to 1).
func RepeatRatio(tokens []string) float64 {
	if len(tokens) == 0 {
		return 0
	}
	best := 0
	for n := 1; n <= 3; n++ {
		counts := map[string]int{}
		for i := 0; i+n <= len(tokens); i++ {
			gram := strings.Join(tokens[i:i+n], "\\x1f")
			counts[gram]++
			if counts[gram]*n > best {
				best = counts[gram] * n
			}
		}
	}
	ratio := float64(best) / float64(len(tokens))
	if ratio > 1 {
		return 1
	}
	return ratio
}
`,
  'promptguard/documents/documents.go': `// Package documents is the document store (provided): each document's text in Redis under doc:{id}.
package documents

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Get is the document's text; ok is false when the id is unknown.
func Get(ctx context.Context, documentID string) (text string, ok bool, err error) {
	text, err = rdb.Get(ctx, "doc:"+documentID).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return text, true, nil
}
`,
  'promptguard/asks/asks.go': `// Package asks keeps answers by (user, Idempotency-Key) (provided): a retried question gets the
// stored decision back.
package asks

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"promptguard/types"
)

const TTL = 24 * time.Hour

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Get is the decision stored for this user and key; nil when there is none.
func Get(ctx context.Context, user, idemKey string) (*types.Decision, error) {
	raw, err := rdb.Get(ctx, "ask:"+user+":"+idemKey).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var d types.Decision
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, err
	}
	return &d, nil
}

// Put keeps the decision for a day under (user, idemKey).
func Put(ctx context.Context, user, idemKey string, d types.Decision) error {
	doc, err := json.Marshal(d)
	if err != nil {
		return err
	}
	return rdb.Set(ctx, "ask:"+user+":"+idemKey, doc, TTL).Err()
}
`,
  'promptguard/types/types.go': `// Package types holds the values the steps hand each other (provided).
package types

import "errors"

// Admission is step 2's answer to "may this user ask now?". RetryAfter is the seconds until the
// window frees up, 0 when the question is admitted.
type Admission struct {
	OK         bool
	Remaining  int64
	RetryAfter int64
}

// ModelAnswer is what step 3 returns: the answer and the passages of the document it cites.
type ModelAnswer struct {
	Answer string
	Spans  []string
}

// Decision is what step 4 decides for one question, and what the client and the event see of it.
type Decision struct {
	RequestID    string   \`json:"request_id"\`
	DocumentHash string   \`json:"document_hash"\`
	Answer       string   \`json:"answer"\`
	Spans        []string \`json:"spans"\`
	Refused      bool     \`json:"refused"\`
	Signals      []string \`json:"signals"\`
	Signature    string   \`json:"signature"\`
}

// ErrRejected: the model layer refuses the reply (a leaked canary, a reply outside the answer schema).
var ErrRejected = errors.New("rejected")

// ErrModelUnavailable: the model did not answer (still UNAVAILABLE after the retry, or past the deadline).
var ErrModelUnavailable = errors.New("model unavailable")
`,
  'promptguard/model/model.go': `// Package model is the stand-in for the model. The checks serve it over gRPC (Model.Complete at
// config.Model); the service's code never calls it directly. Deterministic on purpose: the course
// grades what the service does around the model, never the prose.
//
// Complete(prompt) is the reply text. The document is what stands between "<<<DOCUMENT" + newline
// and newline + "DOCUMENT>>>" (empty without them); its first sentence is the answer, as JSON
// {"answer": first, "spans": [first]}, unless the prompt contains
//
//	LEAK-PROBE        everything before "<<<DOCUMENT" comes back: the instructions, echoed
//	FREEFORM-PROBE    plain prose, not JSON
//	SHAPE-PROBE       JSON without "spans"
//	UNGROUNDED-PROBE  an answer citing a span the document does not contain
//	SECRET-PROBE      the first sentence plus an e-mail address and an AWS key the document does not hold
//	DIVERGE-PROBE     one word 120 times, citing the first sentence
package model

import (
	"encoding/json"
	"strings"
)

const (
	openMark  = "<<<DOCUMENT\\n"
	closeMark = "\\nDOCUMENT>>>"
)

// FirstSentence is the document's text up to its first full stop, with the stop.
func FirstSentence(document string) string {
	head := strings.TrimSpace(strings.SplitN(strings.TrimSpace(document), ".", 2)[0])
	if head == "" {
		return ""
	}
	return head + "."
}

func reply(answer string, spans []string) string {
	body := map[string]any{"answer": answer}
	if spans != nil {
		body["spans"] = spans
	}
	out, _ := json.Marshal(body)
	return string(out)
}

// Complete is the model's reply to prompt.
func Complete(prompt string) string {
	document := ""
	if start := strings.Index(prompt, openMark); start >= 0 {
		if end := strings.Index(prompt[start+len(openMark):], closeMark); end >= 0 {
			document = prompt[start+len(openMark) : start+len(openMark)+end]
		}
	}
	first := FirstSentence(document)
	switch {
	case strings.Contains(prompt, "LEAK-PROBE"):
		return strings.SplitN(prompt, "<<<DOCUMENT", 2)[0]
	case strings.Contains(prompt, "FREEFORM-PROBE"):
		return "The notice period is thirty days."
	case strings.Contains(prompt, "SHAPE-PROBE"):
		return reply(first, nil)
	case strings.Contains(prompt, "UNGROUNDED-PROBE"):
		madeUp := "The notice period is ninety days."
		return reply(madeUp, []string{madeUp})
	case strings.Contains(prompt, "SECRET-PROBE"):
		return reply(first+" Write to ops@corp.example with key AKIAIOSFODNN7EXAMPLE.", []string{first})
	case strings.Contains(prompt, "DIVERGE-PROBE"):
		return reply(strings.TrimSpace(strings.Repeat("dog ", 120)), []string{first})
	}
	return reply(first, []string{first})
}
`,
};

/** The C++ twins as headers (promptguard/*.h), plus digest.h (SHA-256) and ids.h (UUIDs). */
export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'ids.h': CPP_IDS_H,
  'promptguard/config.h': `// Addresses, topics, keys and the refusal every step of promptguard agrees on.
#pragma once

#include <string>

#include <sw/redis++/redis++.h>

namespace config {

// The model's gRPC address: a stand-in served by the checks (promptguard/model.h).
inline constexpr const char* kModel = "model:9000";
// One security event per decision, keyed by user.
inline constexpr const char* kTopic = "prompt.security";
// The consumer group that counts attack signatures.
inline constexpr const char* kGroup = "signatures";
// What a refused question gets back: the same text whatever the reason.
inline constexpr const char* kRefusal = "I cannot answer that from this document.";

// The user's question counter for one 60-second window (window = unix seconds / 60).
inline std::string limit_key(const std::string& user, long long window) {
  return "limits:" + user + ":" + std::to_string(window);
}
// A question the model layer rejected, by the SHA-256 hex of its text.
inline std::string flagged_key(const std::string& digest) { return "flagged:" + digest; }
// The hashes of the user's latest questions about one document, newest first.
inline std::string session_key(const std::string& user, const std::string& document_id) {
  return "session:" + user + ":" + document_id;
}
// Refusals counted per signature for one hour (hour = unix seconds / 3600).
inline std::string signatures_key(long long hour) { return "signatures:" + std::to_string(hour); }

// The one Redis connection the provided modules share.
inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

}  // namespace config
`,
  'promptguard/tokens.h': `// The course tokenizer (provided), a deterministic stand-in for a model's vocabulary such as
// cl100k_base: a run of ASCII letters, digits and underscores is one token, every other character is
// a token of its own, and space, newline and tab only separate tokens. A backspace, a carriage return
// or a backslash is a token, as it is for the model.
#pragma once

#include <map>
#include <string>
#include <vector>

namespace tokens {

inline bool is_word_char(unsigned char c) {
  return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}

inline std::vector<std::string> tokenize(const std::string& text) {
  std::vector<std::string> out;
  std::string word;
  for (const unsigned char c : text) {
    if (is_word_char(c)) {
      word.push_back(static_cast<char>(c));
      continue;
    }
    if (!word.empty()) {
      out.push_back(word);
      word.clear();
    }
    if (c != ' ' && c != '\\n' && c != '\\t') out.push_back(std::string(1, static_cast<char>(c)));
  }
  if (!word.empty()) out.push_back(word);
  return out;
}

// The share of the tokens covered by the most repeated sequence of 1, 2 or 3 tokens (0 to 1).
inline double repeat_ratio(const std::vector<std::string>& toks) {
  if (toks.empty()) return 0.0;
  size_t best = 0;
  for (size_t n = 1; n <= 3; n++) {
    std::map<std::string, size_t> grams;
    for (size_t i = 0; i + n <= toks.size(); i++) {
      std::string gram;
      for (size_t j = i; j < i + n; j++) {
        gram += toks[j];
        gram.push_back('\\x1f');
      }
      const size_t seen = ++grams[gram];
      if (seen * n > best) best = seen * n;
    }
  }
  const double ratio = static_cast<double>(best) / static_cast<double>(toks.size());
  return ratio > 1.0 ? 1.0 : ratio;
}

}  // namespace tokens
`,
  'promptguard/documents.h': `// The document store (provided): each document's text in Redis under doc:{id}.
#pragma once

#include <optional>
#include <string>

#include "promptguard/config.h"

namespace documents {

// The document's text, nothing when the id is unknown.
inline std::optional<std::string> get(const std::string& document_id) {
  return config::redis().get("doc:" + document_id);
}

}  // namespace documents
`,
  'promptguard/types.h': `// The values the steps hand each other (provided).
#pragma once

#include <stdexcept>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

// Step 2's answer to "may this user ask now?". retry_after: seconds until the window frees up, 0
// when the question is admitted.
struct Admission {
  bool ok = false;
  long long remaining = 0;
  long long retry_after = 0;
};

// What step 3 returns: the answer and the passages of the document it cites.
struct ModelAnswer {
  std::string answer;
  std::vector<std::string> spans;
};

// What step 4 decides for one question, and what the client and the event see of it.
struct Decision {
  std::string request_id;
  std::string document_hash;
  std::string answer;
  std::vector<std::string> spans;
  bool refused = false;
  std::vector<std::string> signals;
  std::string signature;

  nlohmann::json to_json() const {
    return {{"request_id", request_id}, {"document_hash", document_hash}, {"answer", answer}, {"spans", spans},
            {"refused", refused},       {"signals", signals},             {"signature", signature}};
  }
};

// The model layer refuses the reply: a leaked canary, or a reply outside the answer schema.
struct Rejected : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The model did not answer: still UNAVAILABLE after the retry, or past the deadline.
struct ModelUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};
`,
  'promptguard/asks.h': `// Answers kept by (user, Idempotency-Key) (provided): a retried question gets the stored decision back.
#pragma once

#include <chrono>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "promptguard/config.h"
#include "promptguard/types.h"

namespace asks {

inline constexpr long long kTtlSeconds = 86400;

// The decision stored for this user and key (as JSON), nothing when there is none.
inline std::optional<nlohmann::json> get(const std::string& user, const std::string& idem_key) {
  const auto raw = config::redis().get("ask:" + user + ":" + idem_key);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Keep the decision for a day under (user, idem_key).
inline void put(const std::string& user, const std::string& idem_key, const Decision& decision) {
  config::redis().set("ask:" + user + ":" + idem_key, decision.to_json().dump(), std::chrono::seconds(kTtlSeconds));
}

}  // namespace asks
`,
  'promptguard/model.h': `// The stand-in for the model. The checks serve it over gRPC (Model.Complete at config::kModel); the
// service's code never calls it directly. Deterministic on purpose: the course grades what the
// service does around the model, never the prose.
//
// complete(prompt) is the reply text. The document is what stands between "<<<DOCUMENT" + newline
// and newline + "DOCUMENT>>>" (empty without them); its first sentence is the answer, as JSON
// {"answer": first, "spans": [first]}, unless the prompt contains
//   LEAK-PROBE        everything before "<<<DOCUMENT" comes back: the instructions, echoed
//   FREEFORM-PROBE    plain prose, not JSON
//   SHAPE-PROBE       JSON without "spans"
//   UNGROUNDED-PROBE  an answer citing a span the document does not contain
//   SECRET-PROBE      the first sentence plus an e-mail address and an AWS key the document does not hold
//   DIVERGE-PROBE     one word 120 times, citing the first sentence
#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace model {

inline std::string trimmed(const std::string& s) {
  const size_t start = s.find_first_not_of(" \\t\\r\\n");
  if (start == std::string::npos) return "";
  return s.substr(start, s.find_last_not_of(" \\t\\r\\n") - start + 1);
}

// The document's text up to its first full stop, with the stop.
inline std::string first_sentence(const std::string& document) {
  const std::string text = trimmed(document);
  const std::string head = trimmed(text.substr(0, text.find('.')));
  return head.empty() ? "" : head + ".";
}

inline std::string complete(const std::string& prompt) {
  const std::string open = "<<<DOCUMENT\\n";
  const std::string close = "\\nDOCUMENT>>>";
  std::string document;
  const size_t start = prompt.find(open);
  if (start != std::string::npos) {
    const size_t stop = prompt.find(close, start + open.size());
    if (stop != std::string::npos) document = prompt.substr(start + open.size(), stop - start - open.size());
  }
  const std::string first = first_sentence(document);
  const auto has = [&prompt](const char* probe) { return prompt.find(probe) != std::string::npos; };
  if (has("LEAK-PROBE")) return prompt.substr(0, prompt.find("<<<DOCUMENT"));
  if (has("FREEFORM-PROBE")) return "The notice period is thirty days.";
  if (has("SHAPE-PROBE")) return nlohmann::json{{"answer", first}}.dump();
  if (has("UNGROUNDED-PROBE")) {
    const std::string made_up = "The notice period is ninety days.";
    return nlohmann::json{{"answer", made_up}, {"spans", {made_up}}}.dump();
  }
  if (has("SECRET-PROBE"))
    return nlohmann::json{{"answer", first + " Write to ops@corp.example with key AKIAIOSFODNN7EXAMPLE."},
                          {"spans", std::vector<std::string>{first}}}
        .dump();
  if (has("DIVERGE-PROBE")) {
    std::string words = "dog";
    for (int i = 1; i < 120; i++) words += " dog";
    return nlohmann::json{{"answer", words}, {"spans", std::vector<std::string>{first}}}.dump();
  }
  return nlohmann::json{{"answer", first}, {"spans", std::vector<std::string>{first}}}.dump();
}

}  // namespace model
`,
};

/** The Scala twins: the same \`promptguard\` objects, compiled with the steps by \`yarn check:scala\`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('promptguard', 'Config')]: `package promptguard

/** Addresses, topics, keys and the refusal every step of promptguard agrees on. */
object Config {
  /** The model's gRPC address: a stand-in served by the checks. */
  val Model = "model:9000"
  /** One security event per decision, keyed by user. */
  val Topic = "prompt.security"
  /** The consumer group that counts attack signatures. */
  val Group = "signatures"
  /** What a refused question gets back: the same text whatever the reason. */
  val Refusal = "I cannot answer that from this document."

  /** The user's question counter for one 60-second window (window = unix seconds / 60). */
  def limitKey(user: String, window: Long): String = s"limits:$user:$window"
  /** A question the model layer rejected, by the SHA-256 hex of its text. */
  def flaggedKey(digest: String): String = s"flagged:$digest"
  /** The hashes of the user's latest questions about one document, newest first. */
  def sessionKey(user: String, documentId: String): String = s"session:$user:$documentId"
  /** Refusals counted per signature for one hour (hour = unix seconds / 3600). */
  def signaturesKey(hour: Long): String = s"signatures:$hour"
}
`,
  [scalaPath('promptguard', 'Tokens')]: `package promptguard

/**
 * The course tokenizer (provided), a deterministic stand-in for a model's vocabulary such as
 * cl100k_base: a run of ASCII letters, digits and underscores is one token, every other character is
 * a token of its own, and space, newline and tab only separate tokens.
 */
object Tokens {
  private def isWord(c: Char): Boolean =
    c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')

  def tokenize(text: String): Vector[String] = {
    val out = Vector.newBuilder[String]
    val word = new StringBuilder
    text.foreach { c =>
      if (isWord(c)) word.append(c)
      else {
        if (word.nonEmpty) { out += word.toString; word.clear() }
        if (c != ' ' && c != '\\n' && c != '\\t') out += c.toString
      }
    }
    if (word.nonEmpty) out += word.toString
    out.result()
  }

  /** The share of the tokens covered by the most repeated sequence of 1, 2 or 3 tokens (0 to 1). */
  def repeatRatio(tokens: Vector[String]): Double =
    if (tokens.isEmpty) 0.0
    else {
      val best = (1 to 3).map { n =>
        if (tokens.size < n) 0
        else tokens.sliding(n).toVector.groupBy(identity).values.map(_.size * n).max
      }.max
      math.min(1.0, best.toDouble / tokens.size)
    }
}
`,
  [scalaPath('promptguard', 'Documents')]: `package promptguard

import redis.clients.jedis.JedisPooled

/** The document store (provided): each document's text in Redis under doc:{id}. */
object Documents {
  private val jedis = new JedisPooled("redis", 6379)

  /** The document's text, None when the id is unknown. */
  def get(documentId: String): Option[String] = Option(jedis.get(s"doc:$documentId"))
}
`,
  [scalaPath('promptguard', 'Types')]: `package promptguard

/** Step 2's answer to "may this user ask now?". retryAfter: seconds until the window frees up, 0 when admitted. */
final case class Admission(ok: Boolean, remaining: Long, retryAfter: Long)

/** What step 3 returns: the answer and the passages of the document it cites. */
final case class ModelAnswer(answer: String, spans: List[String])

/** What step 4 decides for one question, and what the client and the event see of it. */
final case class Decision(
    requestId: String,
    documentHash: String,
    answer: String,
    spans: List[String],
    refused: Boolean,
    signals: List[String],
    signature: String
) {
  def toJson: ujson.Obj = ujson.Obj(
    "request_id" -> requestId,
    "document_hash" -> documentHash,
    "answer" -> answer,
    "spans" -> ujson.Arr.from(spans),
    "refused" -> refused,
    "signals" -> ujson.Arr.from(signals),
    "signature" -> signature
  )
}

/** The model layer refuses the reply: a leaked canary, or a reply outside the answer schema. */
final class Rejected(message: String) extends RuntimeException(message)

/** The model did not answer: still UNAVAILABLE after the retry, or past the deadline. */
final class ModelUnavailable(message: String) extends RuntimeException(message)
`,
  [scalaPath('promptguard', 'Asks')]: `package promptguard

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

/** Answers kept by (user, Idempotency-Key) (provided): a retried question gets the stored decision back. */
object Asks {
  val TtlSeconds = 86400L
  private val jedis = new JedisPooled("redis", 6379)

  /** The decision stored for this user and key (its JSON), None when there is none. */
  def get(user: String, idemKey: String): Option[String] = Option(jedis.get(s"ask:$user:$idemKey"))

  /** Keep the decision for a day under (user, idemKey). */
  def put(user: String, idemKey: String, decision: Decision): Unit = {
    jedis.set(s"ask:$user:$idemKey", ujson.write(decision.toJson), SetParams.setParams().ex(TtlSeconds))
    ()
  }
}
`,
};
