/**
 * Hand-written support modules the transcription steps import but no step builds: the `transcribe`
 * package. `transcribe.jobs` is the jobs store (job records, the audio index, saved segments and the
 * outbox, in Redis), `transcribe.audio` the audio store client whose staging step 1 must not reach
 * for a refused request, `transcribe.redact` the redactor step 4 runs before it publishes, and
 * `transcribe.progress` the chunk ledger of step 2 as step 5 reads it. The five languages keep the
 * same keys, so a harness reads one layout whatever the stack.
 */
import {CPP_DIGEST_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'transcribe/__init__.py': '',
  'transcribe/jobs.py': `"""
The jobs store (provided), in Redis:

  job:{job_id}                       hash: job_id, tenant, audio_ref, audio_hash, duration_seconds,
                                     language, total_chunks, status (queued, then done)
  jobs:audio:{tenant}:{audio_hash}   string: the job submitted for that audio by that tenant
  job:{job_id}:segments              list: one JSON segment per entry, in the order they were saved
  outbox                             list: one JSON row {topic, key, payload} per refused record

A job is a dict (duration_seconds and total_chunks as ints); a segment is a dict with chunk_index,
start_ms, end_ms, speaker and text.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def _job(raw: dict) -> dict | None:
    if not raw:
        return None
    return {**raw, "duration_seconds": int(raw["duration_seconds"]), "total_chunks": int(raw["total_chunks"])}


def get(job_id: str) -> dict | None:
    """The job, or None."""
    return _job(r.hgetall(f"job:{job_id}"))


def create(tenant: str, audio_ref: str, audio_hash: str, duration_seconds: int, language: str, total_chunks: int) -> dict:
    """A new queued job; it becomes the job find_by_audio(tenant, audio_hash) returns."""
    job_id = f"tr-{r.incr('jobs:seq')}"
    r.hset(
        f"job:{job_id}",
        mapping={
            "job_id": job_id,
            "tenant": tenant,
            "audio_ref": audio_ref,
            "audio_hash": audio_hash,
            "duration_seconds": duration_seconds,
            "language": language,
            "total_chunks": total_chunks,
            "status": "queued",
        },
    )
    r.set(f"jobs:audio:{tenant}:{audio_hash}", job_id)
    return get(job_id)


def find_by_audio(tenant: str, audio_hash: str) -> dict | None:
    """The job this tenant submitted for this audio hash, or None."""
    job_id = r.get(f"jobs:audio:{tenant}:{audio_hash}")
    return get(job_id) if job_id else None


def mark_done(job_id: str) -> None:
    """Record that every chunk of the job is transcribed."""
    r.hset(f"job:{job_id}", "status", "done")


def save_segments(job_id: str, segments: list[dict]) -> None:
    """Append segments to the job's transcript, as they are."""
    if segments:
        r.rpush(f"job:{job_id}:segments", *[json.dumps(s) for s in segments])


def segments(job_id: str) -> list[dict]:
    """Every segment saved for the job, in the order it was saved."""
    return [json.loads(s) for s in r.lrange(f"job:{job_id}:segments", 0, -1)]


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """Keep a record the broker refused; the relay produces it again later."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
  'transcribe/audio.py': `"""
The audio store client (provided). stage(audio_ref) copies the object into the bucket the chunk
workers read from: a download billed per byte. Every staging is recorded in the Redis list
audio:staged.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def stage(audio_ref: str) -> None:
    """Download the audio object and keep it for the chunk workers."""
    r.rpush("audio:staged", audio_ref)
`,
  'transcribe/redact.py': `"""
Redaction (provided): redact(text) replaces e-mail addresses with [EMAIL] and phone numbers (seven
or more characters of digits, spaces and dashes, starting and ending with a digit) with [PHONE].
"""
import re

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")
PHONE = re.compile(r"\\+?[0-9][0-9 -]{5,}[0-9]")


def redact(text: str) -> str:
    return PHONE.sub("[PHONE]", EMAIL.sub("[EMAIL]", text))
`,
  'transcribe/progress.py': `"""
The chunk ledger (provided; step 2 builds the same functions): job:{job_id}:chunks is a hash of
chunk index to running, done or failed. run_chunk claims the chunk in one Lua script (a chunk with
no state, or a failed one, can be claimed), calls transcribe(), and records done or failed; when
the last chunk is done the ledger expires in 24 hours and the job is marked done. completed(job_id)
counts the done chunks.
"""
import redis

from transcribe import jobs

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEDGER_TTL_S = 86400
CLAIM_LUA = """
local state = redis.call('HGET', KEYS[1], ARGV[1])
if state == 'running' or state == 'done' then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], 'running')
return 1
"""
claim = r.register_script(CLAIM_LUA)


def ledger_key(job_id: str) -> str:
    return f"job:{job_id}:chunks"


def completed(job_id: str) -> int:
    """The number of chunks of the job that are done."""
    return sum(1 for state in r.hvals(ledger_key(job_id)) if state == "done")


def run_chunk(job_id: str, index: int, total: int, transcribe) -> dict:
    """Transcribe chunk index once: {"status": "done" | "duplicate" | "failed", "segments": [...]}."""
    key = ledger_key(job_id)
    if claim(keys=[key], args=[index]) != 1:
        return {"status": "duplicate", "segments": []}
    try:
        segments = transcribe()
    except Exception:
        r.hset(key, index, "failed")
        return {"status": "failed", "segments": []}
    r.hset(key, index, "done")
    if completed(job_id) == total:
        r.expire(key, LEDGER_TTL_S)
        jobs.mark_done(job_id)
    return {"status": "done", "segments": segments}
`,
};

export const supportModulesTs: Record<string, string> = {
  'transcribe/jobs.ts': `/**
 * The jobs store (provided), in Redis:
 *
 *   job:{job_id}                       hash: job_id, tenant, audio_ref, audio_hash, duration_seconds,
 *                                      language, total_chunks, status (queued, then done)
 *   jobs:audio:{tenant}:{audio_hash}   string: the job submitted for that audio by that tenant
 *   job:{job_id}:segments              list: one JSON segment per entry, in the order they were saved
 *   outbox                             list: one JSON row {topic, key, payload} per refused record
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Job {
  job_id: string;
  tenant: string;
  audio_ref: string;
  audio_hash: string;
  duration_seconds: number;
  language: string;
  total_chunks: number;
  status: string;
}

export interface Segment {
  chunk_index: number;
  start_ms: number;
  end_ms: number;
  speaker: string;
  text: string;
}

/** The job, or null. */
export async function get(jobId: string): Promise<Job | null> {
  const raw = await redis.hgetall(\`job:\${jobId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {
    job_id: raw.job_id,
    tenant: raw.tenant,
    audio_ref: raw.audio_ref,
    audio_hash: raw.audio_hash,
    duration_seconds: Number(raw.duration_seconds),
    language: raw.language,
    total_chunks: Number(raw.total_chunks),
    status: raw.status,
  };
}

/** A new queued job; it becomes the job findByAudio(tenant, audioHash) returns. */
export async function create(
  tenant: string,
  audioRef: string,
  audioHash: string,
  durationSeconds: number,
  language: string,
  totalChunks: number,
): Promise<Job> {
  const jobId = \`tr-\${await redis.incr('jobs:seq')}\`;
  await redis.hset(\`job:\${jobId}\`, {
    job_id: jobId,
    tenant,
    audio_ref: audioRef,
    audio_hash: audioHash,
    duration_seconds: String(durationSeconds),
    language,
    total_chunks: String(totalChunks),
    status: 'queued',
  });
  await redis.set(\`jobs:audio:\${tenant}:\${audioHash}\`, jobId);
  return (await get(jobId)) as Job;
}

/** The job this tenant submitted for this audio hash, or null. */
export async function findByAudio(tenant: string, audioHash: string): Promise<Job | null> {
  const jobId = await redis.get(\`jobs:audio:\${tenant}:\${audioHash}\`);
  return jobId === null ? null : get(jobId);
}

/** Record that every chunk of the job is transcribed. */
export async function markDone(jobId: string): Promise<void> {
  await redis.hset(\`job:\${jobId}\`, 'status', 'done');
}

/** Append segments to the job's transcript, as they are. */
export async function saveSegments(jobId: string, segments: Segment[]): Promise<void> {
  if (segments.length > 0) await redis.rpush(\`job:\${jobId}:segments\`, ...segments.map(s => JSON.stringify(s)));
}

/** Every segment saved for the job, in the order it was saved. */
export async function segments(jobId: string): Promise<Segment[]> {
  return (await redis.lrange(\`job:\${jobId}:segments\`, 0, -1)).map(s => JSON.parse(s) as Segment);
}

/** Keep a record the broker refused; the relay produces it again later. */
export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
  'transcribe/audio.ts': `/**
 * The audio store client (provided). stage(audioRef) copies the object into the bucket the chunk
 * workers read from: a download billed per byte. Every staging is recorded in the Redis list
 * audio:staged.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** Download the audio object and keep it for the chunk workers. */
export async function stage(audioRef: string): Promise<void> {
  await redis.rpush('audio:staged', audioRef);
}
`,
  'transcribe/redact.ts': `/**
 * Redaction (provided): redact(text) replaces e-mail addresses with [EMAIL] and phone numbers (seven
 * or more characters of digits, spaces and dashes, starting and ending with a digit) with [PHONE].
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g;
const PHONE = /\\+?[0-9][0-9 -]{5,}[0-9]/g;

export function redact(text: string): string {
  return text.replace(EMAIL, '[EMAIL]').replace(PHONE, '[PHONE]');
}
`,
  'transcribe/progress.ts': `/**
 * The chunk ledger (provided; step 2 builds the same functions): job:{job_id}:chunks is a hash of
 * chunk index to running, done or failed. runChunk claims the chunk in one Lua script (a chunk with
 * no state, or a failed one, can be claimed), calls transcribe(), and records done or failed; when
 * the last chunk is done the ledger expires in 24 hours and the job is marked done.
 * completed(jobId) counts the done chunks.
 */
import Redis from 'ioredis';

import {type Segment, markDone} from 'transcribe/jobs';

const redis = new Redis({host: 'redis', port: 6379});

export const LEDGER_TTL_S = 86400;
export const CLAIM_LUA = \`
local state = redis.call('HGET', KEYS[1], ARGV[1])
if state == 'running' or state == 'done' then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], 'running')
return 1
\`;

export interface ChunkResult {
  status: 'done' | 'duplicate' | 'failed';
  segments: Segment[];
}

export const ledgerKey = (jobId: string): string => \`job:\${jobId}:chunks\`;

/** The number of chunks of the job that are done. */
export async function completed(jobId: string): Promise<number> {
  return (await redis.hvals(ledgerKey(jobId))).filter(state => state === 'done').length;
}

/** Transcribe chunk index once. */
export async function runChunk(jobId: string, index: number, total: number, transcribe: () => Promise<Segment[]>): Promise<ChunkResult> {
  const key = ledgerKey(jobId);
  if ((await redis.eval(CLAIM_LUA, 1, key, String(index))) !== 1) return {status: 'duplicate', segments: []};
  let segments: Segment[];
  try {
    segments = await transcribe();
  } catch {
    await redis.hset(key, String(index), 'failed');
    return {status: 'failed', segments: []};
  }
  await redis.hset(key, String(index), 'done');
  if ((await completed(jobId)) === total) {
    await redis.expire(key, LEDGER_TTL_S);
    await markDone(jobId);
  }
  return {status: 'done', segments};
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'transcribe/jobs/jobs.go': `// Package jobs is the jobs store (provided), in Redis:
//
//	job:{job_id}                       hash: job_id, tenant, audio_ref, audio_hash, duration_seconds,
//	                                   language, total_chunks, status (queued, then done)
//	jobs:audio:{tenant}:{audio_hash}   string: the job submitted for that audio by that tenant
//	job:{job_id}:segments              list: one JSON segment per entry, in the order they were saved
//	outbox                             list: one JSON row {topic, key, payload} per refused record
package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Job is one transcription job.
type Job struct {
	JobID           string \`json:"job_id"\`
	Tenant          string \`json:"tenant"\`
	AudioRef        string \`json:"audio_ref"\`
	AudioHash       string \`json:"audio_hash"\`
	DurationSeconds int    \`json:"duration_seconds"\`
	Language        string \`json:"language"\`
	TotalChunks     int    \`json:"total_chunks"\`
	Status          string \`json:"status"\`
}

// Segment is one transcribed span of a chunk, timestamps from the start of the audio.
type Segment struct {
	ChunkIndex int    \`json:"chunk_index"\`
	StartMs    int    \`json:"start_ms"\`
	EndMs      int    \`json:"end_ms"\`
	Speaker    string \`json:"speaker"\`
	Text       string \`json:"text"\`
}

// Get is the job, or nil.
func Get(ctx context.Context, jobID string) *Job {
	raw := rdb.HGetAll(ctx, "job:"+jobID).Val()
	if len(raw) == 0 {
		return nil
	}
	duration, _ := strconv.Atoi(raw["duration_seconds"])
	total, _ := strconv.Atoi(raw["total_chunks"])
	return &Job{JobID: raw["job_id"], Tenant: raw["tenant"], AudioRef: raw["audio_ref"], AudioHash: raw["audio_hash"], DurationSeconds: duration, Language: raw["language"], TotalChunks: total, Status: raw["status"]}
}

// Create makes a new queued job; it becomes the job FindByAudio(tenant, audioHash) returns.
func Create(ctx context.Context, tenant, audioRef, audioHash string, durationSeconds int, language string, totalChunks int) *Job {
	jobID := fmt.Sprintf("tr-%d", rdb.Incr(ctx, "jobs:seq").Val())
	rdb.HSet(ctx, "job:"+jobID, map[string]any{
		"job_id": jobID, "tenant": tenant, "audio_ref": audioRef, "audio_hash": audioHash,
		"duration_seconds": strconv.Itoa(durationSeconds), "language": language,
		"total_chunks": strconv.Itoa(totalChunks), "status": "queued",
	})
	rdb.Set(ctx, "jobs:audio:"+tenant+":"+audioHash, jobID, 0)
	return Get(ctx, jobID)
}

// FindByAudio is the job this tenant submitted for this audio hash, or nil.
func FindByAudio(ctx context.Context, tenant, audioHash string) *Job {
	jobID, err := rdb.Get(ctx, "jobs:audio:"+tenant+":"+audioHash).Result()
	if err != nil {
		return nil
	}
	return Get(ctx, jobID)
}

// MarkDone records that every chunk of the job is transcribed.
func MarkDone(ctx context.Context, jobID string) {
	rdb.HSet(ctx, "job:"+jobID, "status", "done")
}

// SaveSegments appends segments to the job's transcript, as they are.
func SaveSegments(ctx context.Context, jobID string, segments []Segment) {
	values := make([]any, 0, len(segments))
	for _, s := range segments {
		raw, _ := json.Marshal(s)
		values = append(values, string(raw))
	}
	if len(values) > 0 {
		rdb.RPush(ctx, "job:"+jobID+":segments", values...)
	}
}

// Segments is every segment saved for the job, in the order it was saved.
func Segments(ctx context.Context, jobID string) []Segment {
	out := []Segment{}
	for _, raw := range rdb.LRange(ctx, "job:"+jobID+":segments", 0, -1).Val() {
		var s Segment
		json.Unmarshal([]byte(raw), &s)
		out = append(out, s)
	}
	return out
}

// InsertOutbox keeps a record the broker refused; the relay produces it again later.
func InsertOutbox(ctx context.Context, topic, key string, payload any) {
	raw, _ := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	rdb.RPush(ctx, "outbox", string(raw))
}
`,
  'transcribe/audio/audio.go': `// Package audio is the audio store client (provided). Stage copies the object into the bucket the
// chunk workers read from: a download billed per byte. Every staging is recorded in the Redis list
// audio:staged.
package audio

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Stage downloads the audio object and keeps it for the chunk workers.
func Stage(ctx context.Context, audioRef string) {
	rdb.RPush(ctx, "audio:staged", audioRef)
}
`,
  'transcribe/redact/redact.go': `// Package redact is redaction (provided): Redact replaces e-mail addresses with [EMAIL] and phone
// numbers (seven or more characters of digits, spaces and dashes, starting and ending with a digit)
// with [PHONE].
package redact

import "regexp"

var (
	email = regexp.MustCompile(\`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\`)
	phone = regexp.MustCompile(\`\\+?[0-9][0-9 -]{5,}[0-9]\`)
)

// Redact is text with its e-mail addresses and phone numbers replaced.
func Redact(text string) string {
	return phone.ReplaceAllString(email.ReplaceAllString(text, "[EMAIL]"), "[PHONE]")
}
`,
  'transcribe/progress/progress.go': `// Package progress is the chunk ledger (provided; step 2 builds the same functions):
// job:{job_id}:chunks is a hash of chunk index to running, done or failed. RunChunk claims the
// chunk in one Lua script (a chunk with no state, or a failed one, can be claimed), calls
// transcribe, and records done or failed; when the last chunk is done the ledger expires in 24
// hours and the job is marked done. Completed counts the done chunks.
package progress

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"transcribe/jobs"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// LedgerTTL is how long a finished job's ledger is kept.
const LedgerTTL = 24 * time.Hour

var claim = redis.NewScript(\`
local state = redis.call('HGET', KEYS[1], ARGV[1])
if state == 'running' or state == 'done' then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], 'running')
return 1
\`)

// Result is what one delivery of a chunk did: Status is done, duplicate or failed.
type Result struct {
	Status   string
	Segments []jobs.Segment
}

// LedgerKey is the job's ledger hash.
func LedgerKey(jobID string) string { return "job:" + jobID + ":chunks" }

// Completed is the number of chunks of the job that are done.
func Completed(ctx context.Context, jobID string) int {
	n := 0
	for _, state := range rdb.HVals(ctx, LedgerKey(jobID)).Val() {
		if state == "done" {
			n++
		}
	}
	return n
}

// RunChunk transcribes chunk index once.
func RunChunk(ctx context.Context, jobID string, index, total int, transcribe func() ([]jobs.Segment, error)) (Result, error) {
	key := LedgerKey(jobID)
	field := strconv.Itoa(index)
	won, err := claim.Run(ctx, rdb, []string{key}, field).Int64()
	if err != nil {
		return Result{}, err
	}
	if won != 1 {
		return Result{Status: "duplicate"}, nil
	}
	segments, err := transcribe()
	if err != nil {
		return Result{Status: "failed"}, rdb.HSet(ctx, key, field, "failed").Err()
	}
	if err := rdb.HSet(ctx, key, field, "done").Err(); err != nil {
		return Result{}, err
	}
	if Completed(ctx, jobID) == total {
		rdb.Expire(ctx, key, LedgerTTL)
		jobs.MarkDone(ctx, jobID)
	}
	return Result{Status: "done", Segments: segments}, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'transcribe/jobs.h': `// The jobs store (provided), in Redis:
//
//   job:{job_id}                       hash: job_id, tenant, audio_ref, audio_hash, duration_seconds,
//                                      language, total_chunks, status (queued, then done)
//   jobs:audio:{tenant}:{audio_hash}   string: the job submitted for that audio by that tenant
//   job:{job_id}:segments              list: one JSON segment per entry, in the order they were saved
//   outbox                             list: one JSON row {topic, key, payload} per refused record
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace jobs {

struct Job {
  std::string job_id;
  std::string tenant;
  std::string audio_ref;
  std::string audio_hash;
  long duration_seconds = 0;
  std::string language;
  long total_chunks = 0;
  std::string status;
};

// One transcribed span of a chunk, timestamps from the start of the audio.
struct Segment {
  int chunk_index = 0;
  int start_ms = 0;
  int end_ms = 0;
  std::string speaker;
  std::string text;
};

inline nlohmann::json toJson(const Segment& s) {
  return {{"chunk_index", s.chunk_index}, {"start_ms", s.start_ms}, {"end_ms", s.end_ms}, {"speaker", s.speaker}, {"text", s.text}};
}

inline Segment segmentOf(const nlohmann::json& j) {
  return {j.value("chunk_index", 0), j.value("start_ms", 0), j.value("end_ms", 0), j.value("speaker", ""), j.value("text", "")};
}

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The job, or none.
inline std::optional<Job> get(const std::string& job_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall("job:" + job_id, std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  return Job{raw["job_id"], raw["tenant"], raw["audio_ref"], raw["audio_hash"], std::stol(raw["duration_seconds"]),
             raw["language"], std::stol(raw["total_chunks"]), raw["status"]};
}

// A new queued job; it becomes the job findByAudio(tenant, audio_hash) returns.
inline Job create(const std::string& tenant, const std::string& audio_ref, const std::string& audio_hash, long duration_seconds,
                  const std::string& language, long total_chunks) {
  const std::string job_id = "tr-" + std::to_string(redis().incr("jobs:seq"));
  redis().hset("job:" + job_id, {{"job_id", job_id}, {"tenant", tenant}, {"audio_ref", audio_ref}, {"audio_hash", audio_hash},
                                 {"duration_seconds", std::to_string(duration_seconds)}, {"language", language},
                                 {"total_chunks", std::to_string(total_chunks)}, {"status", "queued"}});
  redis().set("jobs:audio:" + tenant + ":" + audio_hash, job_id);
  return *get(job_id);
}

// The job this tenant submitted for this audio hash, or none.
inline std::optional<Job> findByAudio(const std::string& tenant, const std::string& audio_hash) {
  const auto job_id = redis().get("jobs:audio:" + tenant + ":" + audio_hash);
  if (!job_id) return std::nullopt;
  return get(*job_id);
}

// Record that every chunk of the job is transcribed.
inline void markDone(const std::string& job_id) { redis().hset("job:" + job_id, "status", "done"); }

// Append segments to the job's transcript, as they are.
inline void saveSegments(const std::string& job_id, const std::vector<Segment>& segments) {
  std::vector<std::string> values;
  for (const Segment& s : segments) values.push_back(toJson(s).dump());
  if (!values.empty()) redis().rpush("job:" + job_id + ":segments", values.begin(), values.end());
}

// Every segment saved for the job, in the order it was saved.
inline std::vector<Segment> segments(const std::string& job_id) {
  std::vector<std::string> raw;
  redis().lrange("job:" + job_id + ":segments", 0, -1, std::back_inserter(raw));
  std::vector<Segment> out;
  for (const std::string& s : raw) out.push_back(segmentOf(nlohmann::json::parse(s)));
  return out;
}

// Keep a record the broker refused; the relay produces it again later.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace jobs
`,
  'transcribe/audio.h': `// The audio store client (provided). stage(audio_ref) copies the object into the bucket the chunk
// workers read from: a download billed per byte. Every staging is recorded in the Redis list
// audio:staged.
#pragma once

#include <sw/redis++/redis++.h>

#include <string>

namespace audio {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Download the audio object and keep it for the chunk workers.
inline void stage(const std::string& audio_ref) { redis().rpush("audio:staged", audio_ref); }

}  // namespace audio
`,
  'transcribe/redact.h': `// Redaction (provided): redact(text) replaces e-mail addresses with [EMAIL] and phone numbers
// (seven or more characters of digits, spaces and dashes, starting and ending with a digit) with
// [PHONE].
#pragma once

#include <regex>
#include <string>

namespace redact {

inline std::string redact(const std::string& text) {
  static const std::regex email(R"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})");
  static const std::regex phone(R"(\\+?[0-9][0-9 -]{5,}[0-9])");
  return std::regex_replace(std::regex_replace(text, email, "[EMAIL]"), phone, "[PHONE]");
}

}  // namespace redact
`,
  'transcribe/progress.h': `// The chunk ledger (provided; step 2 builds the same functions): job:{job_id}:chunks is a hash of
// chunk index to running, done or failed. runChunk claims the chunk in one Lua script (a chunk with
// no state, or a failed one, can be claimed), calls transcribe(), and records done or failed; when
// the last chunk is done the ledger expires in 24 hours and the job is marked done. completed(job_id)
// counts the done chunks.
#pragma once

#include <sw/redis++/redis++.h>

#include <exception>
#include <functional>
#include <iterator>
#include <string>
#include <vector>

#include "transcribe/jobs.h"

namespace progress {

constexpr long long kLedgerTtlSeconds = 86400;

inline const std::string kClaimLua = R"lua(
local state = redis.call('HGET', KEYS[1], ARGV[1])
if state == 'running' or state == 'done' then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], 'running')
return 1
)lua";

// What one delivery of a chunk did: status is done, duplicate or failed.
struct ChunkResult {
  std::string status;
  std::vector<jobs::Segment> segments;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string ledgerKey(const std::string& job_id) { return "job:" + job_id + ":chunks"; }

// The number of chunks of the job that are done.
inline long completed(const std::string& job_id) {
  std::vector<std::string> states;
  redis().hvals(ledgerKey(job_id), std::back_inserter(states));
  long n = 0;
  for (const std::string& s : states) n += s == "done" ? 1 : 0;
  return n;
}

// Transcribe chunk index once.
inline ChunkResult runChunk(const std::string& job_id, int index, int total, const std::function<std::vector<jobs::Segment>()>& transcribe) {
  const std::string key = ledgerKey(job_id);
  const std::string field = std::to_string(index);
  if (redis().eval<long long>(kClaimLua, {key}, {field}) != 1) return {"duplicate", {}};
  std::vector<jobs::Segment> segments;
  try {
    segments = transcribe();
  } catch (const std::exception&) {
    redis().hset(key, field, "failed");
    return {"failed", {}};
  }
  redis().hset(key, field, "done");
  if (completed(job_id) == total) {
    redis().expire(key, kLedgerTtlSeconds);
    jobs::markDone(job_id);
  }
  return {"done", segments};
}

}  // namespace progress
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('transcribe', 'Jobs')]: `package transcribe

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

/**
 * The jobs store (provided), in Redis:
 *
 *   job:{job_id}                       hash: job_id, tenant, audio_ref, audio_hash, duration_seconds,
 *                                      language, total_chunks, status (queued, then done)
 *   jobs:audio:{tenant}:{audio_hash}   string: the job submitted for that audio by that tenant
 *   job:{job_id}:segments              list: one JSON segment per entry, in the order they were saved
 *   outbox                             list: one JSON row {topic, key, payload} per refused record
 */
object Jobs {
  final case class Job(jobId: String, tenant: String, audioRef: String, audioHash: String, durationSeconds: Int, language: String, totalChunks: Int, status: String)

  /** One transcribed span of a chunk, timestamps from the start of the audio. */
  final case class Segment(chunkIndex: Int, startMs: Int, endMs: Int, speaker: String, text: String)

  val jedis = new JedisPooled("redis", 6379)

  def segmentJson(s: Segment): JsObject = JsObject(
    "chunk_index" -> JsNumber(s.chunkIndex), "start_ms" -> JsNumber(s.startMs), "end_ms" -> JsNumber(s.endMs),
    "speaker" -> JsString(s.speaker), "text" -> JsString(s.text))

  private def segmentOf(j: JsObject): Segment = {
    val f = j.fields
    Segment(f("chunk_index").convertTo[Int], f("start_ms").convertTo[Int], f("end_ms").convertTo[Int], f("speaker").convertTo[String], f("text").convertTo[String])
  }

  /** The job, if it exists. */
  def get(jobId: String): Option[Job] = {
    val raw = jedis.hgetAll(s"job:$jobId").asScala.toMap
    if (raw.isEmpty) None
    else Some(Job(raw("job_id"), raw("tenant"), raw("audio_ref"), raw("audio_hash"), raw("duration_seconds").toInt, raw("language"), raw("total_chunks").toInt, raw("status")))
  }

  /** A new queued job; it becomes the job findByAudio(tenant, audioHash) returns. */
  def create(tenant: String, audioRef: String, audioHash: String, durationSeconds: Int, language: String, totalChunks: Int): Job = {
    val jobId = s"tr-\${jedis.incr("jobs:seq")}"
    jedis.hset(s"job:$jobId", Map(
      "job_id" -> jobId, "tenant" -> tenant, "audio_ref" -> audioRef, "audio_hash" -> audioHash,
      "duration_seconds" -> durationSeconds.toString, "language" -> language,
      "total_chunks" -> totalChunks.toString, "status" -> "queued").asJava)
    jedis.set(s"jobs:audio:$tenant:$audioHash", jobId)
    get(jobId).get
  }

  /** The job this tenant submitted for this audio hash, if any. */
  def findByAudio(tenant: String, audioHash: String): Option[Job] =
    Option(jedis.get(s"jobs:audio:$tenant:$audioHash")).flatMap(get)

  /** Record that every chunk of the job is transcribed. */
  def markDone(jobId: String): Unit = jedis.hset(s"job:$jobId", "status", "done")

  /** Append segments to the job's transcript, as they are. */
  def saveSegments(jobId: String, segments: Seq[Segment]): Unit =
    if (segments.nonEmpty) jedis.rpush(s"job:$jobId:segments", segments.map(s => segmentJson(s).compactPrint): _*)

  /** Every segment saved for the job, in the order it was saved. */
  def segments(jobId: String): Seq[Segment] =
    jedis.lrange(s"job:$jobId:segments", 0, -1).asScala.toSeq.map(raw => segmentOf(raw.parseJson.asJsObject))

  /** Keep a record the broker refused; the relay produces it again later. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
  [scalaPath('transcribe', 'Audio')]: `package transcribe

import redis.clients.jedis.JedisPooled

/**
 * The audio store client (provided). stage(audioRef) copies the object into the bucket the chunk
 * workers read from: a download billed per byte. Every staging is recorded in the Redis list
 * audio:staged.
 */
object Audio {
  val jedis = new JedisPooled("redis", 6379)

  /** Download the audio object and keep it for the chunk workers. */
  def stage(audioRef: String): Unit = jedis.rpush("audio:staged", audioRef)
}
`,
  [scalaPath('transcribe', 'Redact')]: `package transcribe

/**
 * Redaction (provided): redact(text) replaces e-mail addresses with [EMAIL] and phone numbers (seven
 * or more characters of digits, spaces and dashes, starting and ending with a digit) with [PHONE].
 */
object Redact {
  private val Email = "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\\\.[A-Za-z]{2,}".r
  private val Phone = "\\\\+?[0-9][0-9 -]{5,}[0-9]".r

  def redact(text: String): String = Phone.replaceAllIn(Email.replaceAllIn(text, "[EMAIL]"), "[PHONE]")
}
`,
  [scalaPath('transcribe', 'Progress')]: `package transcribe

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The chunk ledger (provided; step 2 builds the same functions): job:{job_id}:chunks is a hash of
 * chunk index to running, done or failed. runChunk claims the chunk in one Lua script (a chunk with
 * no state, or a failed one, can be claimed), calls transcribe, and records done or failed; when the
 * last chunk is done the ledger expires in 24 hours and the job is marked done. completed(jobId)
 * counts the done chunks.
 */
object Progress {
  /** What one delivery of a chunk did: status is done, duplicate or failed. */
  final case class ChunkResult(status: String, segments: Seq[Jobs.Segment])

  val LedgerTtlSeconds = 86400L

  val ClaimLua: String =
    """local state = redis.call('HGET', KEYS[1], ARGV[1])
      |if state == 'running' or state == 'done' then return 0 end
      |redis.call('HSET', KEYS[1], ARGV[1], 'running')
      |return 1
      |""".stripMargin

  val jedis = new JedisPooled("redis", 6379)

  def ledgerKey(jobId: String): String = s"job:$jobId:chunks"

  /** The number of chunks of the job that are done. */
  def completed(jobId: String): Int = jedis.hvals(ledgerKey(jobId)).asScala.count(_ == "done")

  /** Transcribe chunk index once. */
  def runChunk(jobId: String, index: Int, total: Int, transcribe: () => Seq[Jobs.Segment]): ChunkResult = {
    val key = ledgerKey(jobId)
    val field = index.toString
    val won = jedis.eval(ClaimLua, List(key).asJava, List(field).asJava).asInstanceOf[java.lang.Long]
    if (won != 1L) ChunkResult("duplicate", Seq.empty)
    else
      try {
        val segments = transcribe()
        jedis.hset(key, field, "done")
        if (completed(jobId) == total) {
          jedis.expire(key, LedgerTtlSeconds)
          Jobs.markDone(jobId)
        }
        ChunkResult("done", segments)
      } catch {
        case _: Exception =>
          jedis.hset(key, field, "failed")
          ChunkResult("failed", Seq.empty)
      }
  }
}
`,
};
