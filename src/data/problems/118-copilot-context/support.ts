/**
 * Hand-written support modules the copilot-context steps import but no earlier step builds: the
 * `copilot` package. `copilot.tabs` is the neighboring-tabs cache of step 2 as the endpoint uses it
 * (`remember_tabs`, `pick_snippets`); `copilot.model` is the step-3 model call (`complete`). Step 1
 * calls both, so its checks exercise the endpoint against working dependencies. The five languages
 * keep the same keys and the same scoring, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'copilot/__init__.py': '',
  'copilot/tabs.py': `"""
The neighboring-tabs cache (provided; step 2 builds the same two functions). Each open tab is the
string tabs:{session}:{path} holding the tab's text, with a 600 s TTL refreshed on every write.
pick_snippets reads a session's tabs with one MGET, scores every 500-character window of each tab
(stride 250) by Jaccard similarity between its identifiers and those of the last 60 lines before
the cursor, keeps the windows scoring at least 0.05 (the best one even below that bar, as long as
it shares an identifier), best first, at most 4.
"""
import re

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TAB_TTL_S = 600
SNIPPET_CHARS = 500
CURSOR_WINDOW_LINES = 60
MIN_SNIPPET_SCORE = 0.05
MAX_SNIPPETS = 4
IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def tabs_key(session: str, path: str) -> str:
    return f"tabs:{session}:{path}"


def remember_tabs(session: str, tabs: list[tuple[str, str]]) -> None:
    """Store each (path, text) under the session, one pipelined round trip."""
    pipe = r.pipeline(transaction=False)
    for path, text in tabs:
        pipe.set(tabs_key(session, path), text, ex=TAB_TTL_S)
    pipe.execute()


def identifiers(text: str) -> set[str]:
    return set(IDENTIFIER.findall(text))


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def best_window(text: str, cursor: set[str]) -> tuple[float, str]:
    """The SNIPPET_CHARS-wide window of a tab that shares the most identifiers with the cursor."""
    best_score, best_chunk = 0.0, ""
    for start in range(0, max(len(text), 1), SNIPPET_CHARS // 2):
        chunk = text[start : start + SNIPPET_CHARS]
        score = jaccard(identifiers(chunk), cursor)
        if score > best_score:
            best_score, best_chunk = score, chunk
    return best_score, best_chunk


def pick_snippets(session: str, paths: list[str], prefix: str) -> list[str]:
    """Snippets from the session's other open tabs that look like the code at the cursor, best first."""
    if not paths:
        return []
    cursor = identifiers("\\n".join(prefix.split("\\n")[-CURSOR_WINDOW_LINES:]))
    texts = r.mget([tabs_key(session, path) for path in paths])
    scored = [best_window(text, cursor) for text in texts if text is not None]
    scored = sorted((s for s in scored if s[0] > 0), key=lambda s: s[0], reverse=True)
    picked = [chunk for score, chunk in scored if score >= MIN_SNIPPET_SCORE]
    if not picked and scored:
        picked = [scored[0][1]]
    return picked[:MAX_SNIPPETS]
`,
  'copilot/model.py': `"""
The model call (provided; step 3 builds the same function). Complete on the model service at
model:9000 with the prefix and the suffix as separate fields and 3 candidates asked for, a 300 ms
deadline on every attempt, at most 2 attempts and only after UNAVAILABLE. It returns the candidates
worth showing: empty, truncated and duplicate ones dropped, in the model's order. A call that
fails returns [] (no ghost text for that keystroke).
"""
import logging

import grpc

import copilot_context_pb2
import copilot_context_pb2_grpc

logger = logging.getLogger("completiond.model")

MODEL_TARGET = "model:9000"
DEADLINE_S = 0.3
MAX_ATTEMPTS = 2
N_CANDIDATES = 3

stub = copilot_context_pb2_grpc.ModelStub(grpc.insecure_channel(MODEL_TARGET))


def filter_candidates(candidates) -> list[str]:
    """n generated, at most n shown: drop empty, truncated and duplicate candidates, keep the order."""
    shown: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = candidate.text.strip()
        if key == "" or candidate.truncated or key in seen:
            continue
        seen.add(key)
        shown.append(candidate.text)
    return shown


def complete(prefix: str, suffix: str, snippets: list[str], language: str) -> list[str]:
    request = copilot_context_pb2.CompleteRequest(
        prefix=prefix, suffix=suffix, snippets=snippets, language=language, n=N_CANDIDATES
    )
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = stub.Complete(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.UNAVAILABLE and attempt < MAX_ATTEMPTS:
                continue
            logger.warning("model call failed code=%s attempt=%d", exc.code().name, attempt)
            return []
        return filter_candidates(reply.candidates)
    return []
`,
};

export const supportModulesTs: Record<string, string> = {
  'copilot/tabs.ts': `/**
 * The neighboring-tabs cache (provided; step 2 builds the same two functions). Each open tab is the
 * string tabs:{session}:{path} holding the tab's text, with a 600 s TTL refreshed on every write.
 * pickSnippets reads a session's tabs with one MGET, scores every 500-character window of each tab
 * (stride 250) by Jaccard similarity between its identifiers and those of the last 60 lines before
 * the cursor, keeps the windows scoring at least 0.05 (the best one even below that bar, as long as
 * it shares an identifier), best first, at most 4.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const TAB_TTL_S = 600;
export const SNIPPET_CHARS = 500;
export const CURSOR_WINDOW_LINES = 60;
export const MIN_SNIPPET_SCORE = 0.05;
export const MAX_SNIPPETS = 4;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

export interface Tab {
  path: string;
  text: string;
}

export const tabsKey = (session: string, path: string): string => \`tabs:\${session}:\${path}\`;

/** Store each tab under the session, one pipelined round trip. */
export async function rememberTabs(session: string, tabs: Tab[]): Promise<void> {
  const pipe = redis.pipeline();
  for (const tab of tabs) pipe.set(tabsKey(session, tab.path), tab.text, 'EX', TAB_TTL_S);
  await pipe.exec();
}

export const identifiers = (text: string): Set<string> => new Set(text.match(IDENTIFIER) ?? []);

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const id of a) if (b.has(id)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** The SNIPPET_CHARS-wide window of a tab that shares the most identifiers with the cursor. */
export function bestWindow(text: string, cursor: Set<string>): [number, string] {
  let best: [number, string] = [0, ''];
  for (let start = 0; start < Math.max(text.length, 1); start += SNIPPET_CHARS / 2) {
    const chunk = text.slice(start, start + SNIPPET_CHARS);
    const score = jaccard(identifiers(chunk), cursor);
    if (score > best[0]) best = [score, chunk];
  }
  return best;
}

/** Snippets from the session's other open tabs that look like the code at the cursor, best first. */
export async function pickSnippets(session: string, paths: string[], prefix: string): Promise<string[]> {
  if (paths.length === 0) return [];
  const cursor = identifiers(prefix.split('\\n').slice(-CURSOR_WINDOW_LINES).join('\\n'));
  const texts = await redis.mget(paths.map(path => tabsKey(session, path)));
  const scored = texts
    .filter((text): text is string => text !== null)
    .map(text => bestWindow(text, cursor))
    .filter(([score]) => score > 0)
    .sort((a, b) => b[0] - a[0]);
  let picked = scored.filter(([score]) => score >= MIN_SNIPPET_SCORE).map(([, chunk]) => chunk);
  if (picked.length === 0 && scored.length > 0) picked = [scored[0][1]];
  return picked.slice(0, MAX_SNIPPETS);
}
`,
  'copilot/model.ts': `/**
 * The model call (provided; step 3 builds the same function). Complete on the model service at
 * model:9000 with the prefix and the suffix as separate fields and 3 candidates asked for, a 300 ms
 * deadline on every attempt, at most 2 attempts and only after UNAVAILABLE. It resolves to the
 * candidates worth showing: empty, truncated and duplicate ones dropped, in the model's order. A
 * call that fails resolves to [] (no ghost text for that keystroke).
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const MODEL_TARGET = 'model:9000';
export const DEADLINE_MS = 300;
export const MAX_ATTEMPTS = 2;
export const N_CANDIDATES = 3;

export interface Candidate {
  text: string;
  truncated: boolean;
}
interface CompleteRequest {
  prefix: string;
  suffix: string;
  snippets: string[];
  language: string;
  n: number;
}
interface ModelClient {
  Complete(request: CompleteRequest, options: {deadline: number}): Promise<{candidates: Candidate[]}>;
}

const {copilotctx} = grpc.loadPackageDefinition(protoLoader.loadSync('copilot_context.proto')) as unknown as {
  copilotctx: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const stub = new copilotctx.Model(MODEL_TARGET, grpc.credentials.createInsecure());

/** n generated, at most n shown: drop empty, truncated and duplicate candidates, keep the order. */
export function filterCandidates(candidates: Candidate[]): string[] {
  const shown: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.text.trim();
    if (key === '' || candidate.truncated || seen.has(key)) continue;
    seen.add(key);
    shown.push(candidate.text);
  }
  return shown;
}

export async function complete(prefix: string, suffix: string, snippets: string[], language: string): Promise<string[]> {
  const request = {prefix, suffix, snippets, language, n: N_CANDIDATES};
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await stub.Complete(request, {deadline: Date.now() + DEADLINE_MS});
      return filterCandidates(reply.candidates ?? []);
    } catch (err) {
      const {code} = err as grpc.ServiceError;
      if (code === grpc.status.UNAVAILABLE && attempt < MAX_ATTEMPTS) continue;
      console.warn(\`model call failed code=\${code} attempt=\${attempt}\`);
      return [];
    }
  }
  return [];
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'copilot/tabs/tabs.go': `// Package tabs is the neighboring-tabs cache (provided; step 2 builds the same two functions).
// Each open tab is the string tabs:{session}:{path} holding the tab's text, with a 600 s TTL
// refreshed on every write. PickSnippets reads a session's tabs with one MGET, scores every
// 500-character window of each tab (stride 250) by Jaccard similarity between its identifiers and
// those of the last 60 lines before the cursor, keeps the windows scoring at least 0.05 (the best
// one even below that bar, as long as it shares an identifier), best first, at most 4.
package tabs

import (
	"context"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	TabTTL            = 600 * time.Second
	SnippetChars      = 500
	CursorWindowLines = 60
	MinSnippetScore   = 0.05
	MaxSnippets       = 4
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var identifier = regexp.MustCompile(\`[A-Za-z_][A-Za-z0-9_]*\`)

// Tab is one tab the editor has open.
type Tab struct {
	Path string \`json:"path"\`
	Text string \`json:"text"\`
}

// Key is where a session's tab is stored.
func Key(session, path string) string { return "tabs:" + session + ":" + path }

// RememberTabs stores each tab under the session, one pipelined round trip.
func RememberTabs(ctx context.Context, session string, tabs []Tab) error {
	if len(tabs) == 0 {
		return nil
	}
	pipe := rdb.Pipeline()
	for _, tab := range tabs {
		pipe.Set(ctx, Key(session, tab.Path), tab.Text, TabTTL)
	}
	_, err := pipe.Exec(ctx)
	return err
}

func identifiers(text string) map[string]bool {
	out := map[string]bool{}
	for _, id := range identifier.FindAllString(text, -1) {
		out[id] = true
	}
	return out
}

func jaccard(a, b map[string]bool) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	shared := 0
	for id := range a {
		if b[id] {
			shared++
		}
	}
	return float64(shared) / float64(len(a)+len(b)-shared)
}

// bestWindow is the SnippetChars-wide window of a tab that shares the most identifiers with the cursor.
func bestWindow(text string, cursor map[string]bool) (float64, string) {
	bestScore, bestChunk := 0.0, ""
	for start := 0; start == 0 || start < len(text); start += SnippetChars / 2 {
		end := start + SnippetChars
		if end > len(text) {
			end = len(text)
		}
		chunk := text[start:end]
		if score := jaccard(identifiers(chunk), cursor); score > bestScore {
			bestScore, bestChunk = score, chunk
		}
	}
	return bestScore, bestChunk
}

type window struct {
	score float64
	chunk string
}

// PickSnippets is the session's other open tabs that look like the code at the cursor, best first.
func PickSnippets(ctx context.Context, session string, paths []string, prefix string) ([]string, error) {
	if len(paths) == 0 {
		return []string{}, nil
	}
	lines := strings.Split(prefix, "\\n")
	if len(lines) > CursorWindowLines {
		lines = lines[len(lines)-CursorWindowLines:]
	}
	cursor := identifiers(strings.Join(lines, "\\n"))
	keys := make([]string, len(paths))
	for i, path := range paths {
		keys[i] = Key(session, path)
	}
	texts, err := rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	scored := []window{}
	for _, value := range texts {
		text, ok := value.(string)
		if !ok {
			continue
		}
		if score, chunk := bestWindow(text, cursor); score > 0 {
			scored = append(scored, window{score, chunk})
		}
	}
	sort.SliceStable(scored, func(i, j int) bool { return scored[i].score > scored[j].score })
	picked := []string{}
	for _, w := range scored {
		if w.score >= MinSnippetScore {
			picked = append(picked, w.chunk)
		}
	}
	if len(picked) == 0 && len(scored) > 0 {
		picked = []string{scored[0].chunk}
	}
	if len(picked) > MaxSnippets {
		picked = picked[:MaxSnippets]
	}
	return picked, nil
}
`,
  'copilot/model/model.go': `// Package model is the model call (provided; step 3 builds the same function). Complete calls the
// model service at model:9000 with the prefix and the suffix as separate fields and 3 candidates
// asked for, a 300 ms deadline on every attempt, at most 2 attempts and only after UNAVAILABLE. It
// returns the candidates worth showing: empty, truncated and duplicate ones dropped, in the model's
// order. A call that fails returns none (no ghost text for that keystroke).
package model

import (
	"context"
	"log"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "copilot/gen/copilot_context"
)

const (
	Target      = "model:9000"
	Deadline    = 300 * time.Millisecond
	MaxAttempts = 2
	NCandidates = 3
)

var conn, _ = grpc.NewClient(Target, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewModelClient(conn)

// FilterCandidates is n generated, at most n shown: empty, truncated and duplicate candidates dropped, the order kept.
func FilterCandidates(candidates []*pb.Candidate) []string {
	shown := []string{}
	seen := map[string]bool{}
	for _, candidate := range candidates {
		key := strings.TrimSpace(candidate.GetText())
		if key == "" || candidate.GetTruncated() || seen[key] {
			continue
		}
		seen[key] = true
		shown = append(shown, candidate.GetText())
	}
	return shown
}

// Complete is the candidates to show as ghost text; none when the model gives none.
func Complete(ctx context.Context, prefix, suffix string, snippets []string, language string) []string {
	req := &pb.CompleteRequest{Prefix: prefix, Suffix: suffix, Snippets: snippets, Language: language, N: NCandidates}
	for attempt := 1; attempt <= MaxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, Deadline)
		reply, err := stub.Complete(callCtx, req)
		cancel()
		if err == nil {
			return FilterCandidates(reply.GetCandidates())
		}
		if status.Code(err) == codes.Unavailable && attempt < MaxAttempts {
			continue
		}
		log.Printf("model call failed code=%s attempt=%d", status.Code(err), attempt)
		return []string{}
	}
	return []string{}
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'copilot/tabs.h': `// The neighboring-tabs cache (provided; step 2 builds the same two functions). Each open tab is the
// string tabs:{session}:{path} holding the tab's text, with a 600 s TTL refreshed on every write.
// pickSnippets reads a session's tabs with one MGET, scores every 500-character window of each tab
// (stride 250) by Jaccard similarity between its identifiers and those of the last 60 lines before
// the cursor, keeps the windows scoring at least 0.05 (the best one even below that bar, as long as
// it shares an identifier), best first, at most 4.
#pragma once

#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <iterator>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace tabs {

constexpr long long kTabTtlS = 600;
constexpr std::size_t kSnippetChars = 500;
constexpr std::size_t kCursorWindowLines = 60;
constexpr double kMinSnippetScore = 0.05;
constexpr std::size_t kMaxSnippets = 4;

// One tab the editor has open.
struct Tab {
  std::string path;
  std::string text;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string tabsKey(const std::string& session, const std::string& path) { return "tabs:" + session + ":" + path; }

// Store each tab under the session, one pipelined round trip.
inline void rememberTabs(const std::string& session, const std::vector<Tab>& open) {
  if (open.empty()) return;
  auto pipe = redis().pipeline();
  for (const Tab& tab : open) pipe.set(tabsKey(session, tab.path), tab.text, std::chrono::seconds(kTabTtlS));
  pipe.exec();
}

// The identifiers of a text: [A-Za-z_][A-Za-z0-9_]*.
inline std::set<std::string> identifiers(const std::string& text) {
  std::set<std::string> out;
  std::size_t i = 0;
  while (i < text.size()) {
    const unsigned char c = static_cast<unsigned char>(text[i]);
    if (!std::isalpha(c) && c != '_') {
      i++;
      continue;
    }
    std::size_t j = i + 1;
    while (j < text.size() && (std::isalnum(static_cast<unsigned char>(text[j])) || text[j] == '_')) j++;
    out.insert(text.substr(i, j - i));
    i = j;
  }
  return out;
}

inline double jaccard(const std::set<std::string>& a, const std::set<std::string>& b) {
  if (a.empty() || b.empty()) return 0;
  std::size_t shared = 0;
  for (const std::string& id : a) shared += b.count(id);
  return static_cast<double>(shared) / static_cast<double>(a.size() + b.size() - shared);
}

// The kSnippetChars-wide window of a tab that shares the most identifiers with the cursor.
inline std::pair<double, std::string> bestWindow(const std::string& text, const std::set<std::string>& cursor) {
  std::pair<double, std::string> best{0.0, ""};
  for (std::size_t start = 0; start == 0 || start < text.size(); start += kSnippetChars / 2) {
    const std::string chunk = text.substr(start, kSnippetChars);
    const double score = jaccard(identifiers(chunk), cursor);
    if (score > best.first) best = {score, chunk};
  }
  return best;
}

// The session's other open tabs that look like the code at the cursor, best first.
inline std::vector<std::string> pickSnippets(const std::string& session, const std::vector<std::string>& paths,
                                             const std::string& prefix) {
  if (paths.empty()) return {};
  std::vector<std::string> lines;
  for (std::size_t start = 0;;) {
    const std::size_t nl = prefix.find('\\n', start);
    lines.push_back(prefix.substr(start, nl == std::string::npos ? std::string::npos : nl - start));
    if (nl == std::string::npos) break;
    start = nl + 1;
  }
  std::string window;
  for (std::size_t i = lines.size() > kCursorWindowLines ? lines.size() - kCursorWindowLines : 0; i < lines.size(); i++)
    window += lines[i] + "\\n";
  const std::set<std::string> cursor = identifiers(window);
  std::vector<std::string> keys;
  for (const std::string& path : paths) keys.push_back(tabsKey(session, path));
  std::vector<sw::redis::OptionalString> texts;
  redis().mget(keys.begin(), keys.end(), std::back_inserter(texts));
  std::vector<std::pair<double, std::string>> scored;
  for (const auto& text : texts) {
    if (!text) continue;
    auto best = bestWindow(*text, cursor);
    if (best.first > 0) scored.push_back(std::move(best));
  }
  std::stable_sort(scored.begin(), scored.end(), [](const auto& a, const auto& b) { return a.first > b.first; });
  std::vector<std::string> picked;
  for (const auto& [score, chunk] : scored)
    if (score >= kMinSnippetScore) picked.push_back(chunk);
  if (picked.empty() && !scored.empty()) picked.push_back(scored.front().second);
  if (picked.size() > kMaxSnippets) picked.resize(kMaxSnippets);
  return picked;
}

}  // namespace tabs
`,
  'copilot/model.h': `// The model call (provided; step 3 builds the same function). complete calls the model service at
// model:9000 with the prefix and the suffix as separate fields and 3 candidates asked for, a 300 ms
// deadline on every attempt, at most 2 attempts and only after UNAVAILABLE. It returns the
// candidates worth showing: empty, truncated and duplicate ones dropped, in the model's order. A
// call that fails returns none (no ghost text for that keystroke).
#pragma once

#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "copilot_context.grpc.pb.h"

namespace model {

inline const std::string kTarget = "model:9000";
constexpr std::chrono::milliseconds kDeadline{300};
constexpr int kMaxAttempts = 2;
constexpr int kNCandidates = 3;

inline copilotctx::Model::Stub& stub() {
  static std::unique_ptr<copilotctx::Model::Stub> s =
      copilotctx::Model::NewStub(grpc::CreateChannel(kTarget, grpc::InsecureChannelCredentials()));
  return *s;
}

// n generated, at most n shown: empty, truncated and duplicate candidates dropped, the order kept.
inline std::vector<std::string> filterCandidates(const copilotctx::CompleteReply& reply) {
  std::vector<std::string> shown;
  std::set<std::string> seen;
  for (const auto& candidate : reply.candidates()) {
    const std::string& text = candidate.text();
    const auto first = text.find_first_not_of(" \\t\\r\\n");
    if (first == std::string::npos || candidate.truncated()) continue;
    const std::string key = text.substr(first, text.find_last_not_of(" \\t\\r\\n") - first + 1);
    if (!seen.insert(key).second) continue;
    shown.push_back(text);
  }
  return shown;
}

// The candidates to show as ghost text; none when the model gives none.
inline std::vector<std::string> complete(const std::string& prefix, const std::string& suffix,
                                         const std::vector<std::string>& snippets, const std::string& language) {
  copilotctx::CompleteRequest request;
  request.set_prefix(prefix);
  request.set_suffix(suffix);
  for (const std::string& snippet : snippets) request.add_snippets(snippet);
  request.set_language(language);
  request.set_n(kNCandidates);
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    copilotctx::CompleteReply reply;
    const grpc::Status status = stub().Complete(&ctx, request, &reply);
    if (status.ok()) return filterCandidates(reply);
    if (status.error_code() == grpc::StatusCode::UNAVAILABLE && attempt < kMaxAttempts) continue;
    std::cerr << "model call failed code=" << status.error_code() << " attempt=" << attempt << "\\n";
    return {};
  }
  return {};
}

}  // namespace model
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('copilot', 'Tabs')]: `package copilot

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The neighboring-tabs cache (provided; step 2 builds the same two functions). Each open tab is the
 * string tabs:{session}:{path} holding the tab's text, with a 600 s TTL refreshed on every write.
 * pickSnippets reads a session's tabs with one MGET, scores every 500-character window of each tab
 * (stride 250) by Jaccard similarity between its identifiers and those of the last 60 lines before
 * the cursor, keeps the windows scoring at least 0.05 (the best one even below that bar, as long as
 * it shares an identifier), best first, at most 4.
 */
object Tabs {
  final case class Tab(path: String, text: String)

  val TabTtlS = 600L
  val SnippetChars = 500
  val CursorWindowLines = 60
  val MinSnippetScore = 0.05
  val MaxSnippets = 4
  private val Identifier = "[A-Za-z_][A-Za-z0-9_]*".r

  val jedis = new JedisPooled("redis", 6379)

  def tabsKey(session: String, path: String): String = s"tabs:$session:$path"

  /** Store each tab under the session, one pipelined round trip. */
  def rememberTabs(session: String, tabs: Seq[Tab]): Unit = {
    val pipe = jedis.pipelined()
    tabs.foreach(tab => pipe.setex(tabsKey(session, tab.path), TabTtlS, tab.text))
    pipe.sync()
  }

  def identifiers(text: String): Set[String] = Identifier.findAllIn(text).toSet

  def jaccard(a: Set[String], b: Set[String]): Double =
    if (a.isEmpty || b.isEmpty) 0.0 else (a & b).size.toDouble / (a | b).size

  /** The SnippetChars-wide window of a tab that shares the most identifiers with the cursor. */
  def bestWindow(text: String, cursor: Set[String]): (Double, String) =
    (0 until math.max(text.length, 1) by SnippetChars / 2)
      .map(start => text.slice(start, start + SnippetChars))
      .foldLeft((0.0, "")) { case (best, chunk) =>
        val score = jaccard(identifiers(chunk), cursor)
        if (score > best._1) (score, chunk) else best
      }

  /** The session's other open tabs that look like the code at the cursor, best first. */
  def pickSnippets(session: String, paths: Seq[String], prefix: String): Seq[String] =
    if (paths.isEmpty) Seq.empty
    else {
      val cursor = identifiers(prefix.split("\\n", -1).takeRight(CursorWindowLines).mkString("\\n"))
      val texts = jedis.mget(paths.map(tabsKey(session, _)): _*).asScala.toSeq
      val scored = texts.flatMap(Option(_)).map(bestWindow(_, cursor)).filter(_._1 > 0).sortBy(-_._1)
      val picked = scored.filter(_._1 >= MinSnippetScore).map(_._2)
      (if (picked.isEmpty) scored.take(1).map(_._2) else picked).take(MaxSnippets)
    }
}
`,
  [scalaPath('copilot', 'Model')]: `package copilot

import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import copilotctx.copilot_context.{Candidate, CompleteRequest, ModelGrpc}

/**
 * The model call (provided; step 3 builds the same function). complete calls the model service at
 * model:9000 with the prefix and the suffix as separate fields and 3 candidates asked for, a 300 ms
 * deadline on every attempt, at most 2 attempts and only after UNAVAILABLE. It returns the
 * candidates worth showing: empty, truncated and duplicate ones dropped, in the model's order. A
 * call that fails returns none (no ghost text for that keystroke).
 */
object Model {
  val Target = "model:9000"
  val DeadlineMs = 300L
  val MaxAttempts = 2
  val NCandidates = 3

  private val stub = ModelGrpc.blockingStub(ManagedChannelBuilder.forTarget(Target).usePlaintext().build())

  /** n generated, at most n shown: empty, truncated and duplicate candidates dropped, the order kept. */
  def filterCandidates(candidates: Seq[Candidate]): Seq[String] =
    candidates
      .filter(c => c.text.trim.nonEmpty && !c.truncated)
      .foldLeft((Vector.empty[String], Set.empty[String])) { case ((shown, seen), c) =>
        if (seen(c.text.trim)) (shown, seen) else (shown :+ c.text, seen + c.text.trim)
      }
      ._1

  /** The candidates to show as ghost text; none when the model gives none. */
  def complete(prefix: String, suffix: String, snippets: Seq[String], language: String): Seq[String] = {
    val request = CompleteRequest(prefix = prefix, suffix = suffix, snippets = snippets, language = language, n = NCandidates)
    var attempt = 1
    while (attempt <= MaxAttempts) {
      try {
        return filterCandidates(stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).complete(request).candidates)
      } catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.UNAVAILABLE && attempt < MaxAttempts =>
          attempt += 1
        case e: StatusRuntimeException =>
          System.err.println(s"model call failed code=\${e.getStatus.getCode} attempt=$attempt")
          return Seq.empty
      }
    }
    Seq.empty
  }
}
`,
};
