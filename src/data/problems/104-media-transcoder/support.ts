/**
 * Hand-written support modules the media-transcoder steps import but no step builds: the
 * `transcoder` package. `transcoder.jobs` is the job store (one Redis hash per job, the course's
 * stand-in for the jobs database, plus the segment arithmetic), `transcoder.presets` the server-side
 * preset definitions, `transcoder.segments` the segment tracker of step 2 as later steps use it
 * (claims with a lease, the done set, the manifest, terminal failures), and `transcoder.urls` the
 * signed output references. The five languages keep the same keys and the same signature, so a
 * harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'transcoder/__init__.py': '',
  'transcoder/jobs.py': `"""
The job store (provided): every transcode job is a Redis hash job:{job_id} with job_id, tenant,
source_uri, source_sha256, duration_s, preset, encoder_args (a JSON list), output_bucket,
output_prefix, segment_count, state (queued, then done once finalized) and renditions (a JSON list
of {preset, key, duration_s}, written when the job is finalized). job:by-source:{tenant}:{sha256}:{preset}
holds the id of the job that source and preset were first submitted as. A job is a dict: duration_s
a float, segment_count an int, encoder_args and renditions lists.
"""
import json
import math

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SEGMENT_SECONDS = 6


def segment_count(duration_s: float) -> int:
    """How many SEGMENT_SECONDS segments cover duration_s seconds (the last one may be shorter)."""
    return math.ceil(duration_s / SEGMENT_SECONDS)


def segment_span(duration_s: float, index: int) -> tuple[float, float]:
    """(start_s, length_s) of segment index in a source of duration_s seconds."""
    start = index * SEGMENT_SECONDS
    return float(start), float(min(SEGMENT_SECONDS, duration_s - start))


def output_key(job: dict) -> str:
    """Where the job's rendition playlist lands in its output bucket."""
    return f"{job['output_prefix']}/{job['preset']}/index.m3u8"


def _source_key(tenant: str, source_sha256: str, preset: str) -> str:
    return f"job:by-source:{tenant}:{source_sha256}:{preset}"


def _job(raw: dict) -> dict | None:
    if not raw:
        return None
    return {
        "job_id": raw["job_id"],
        "tenant": raw["tenant"],
        "source_uri": raw["source_uri"],
        "source_sha256": raw["source_sha256"],
        "duration_s": float(raw["duration_s"]),
        "preset": raw["preset"],
        "encoder_args": json.loads(raw["encoder_args"]),
        "output_bucket": raw["output_bucket"],
        "output_prefix": raw["output_prefix"],
        "segment_count": int(raw["segment_count"]),
        "state": raw["state"],
        "renditions": json.loads(raw["renditions"]),
    }


def get(job_id: str) -> dict | None:
    """The job, or None."""
    return _job(r.hgetall(f"job:{job_id}"))


def find(tenant: str, source_sha256: str, preset: str) -> dict | None:
    """The job this tenant already submitted for (source_sha256, preset), if any."""
    job_id = r.get(_source_key(tenant, source_sha256, preset))
    return get(job_id) if job_id else None


def create(tenant: str, source_uri: str, source_sha256: str, duration_s: float, preset: str, encoder_args: list[str], output_bucket: str, output_prefix: str) -> dict:
    """A new queued job, recorded as the job for (tenant, source_sha256, preset); returns it."""
    job_id = f"tj-{r.incr('job:seq')}"
    r.hset(
        f"job:{job_id}",
        mapping={
            "job_id": job_id,
            "tenant": tenant,
            "source_uri": source_uri,
            "source_sha256": source_sha256,
            "duration_s": repr(float(duration_s)),
            "preset": preset,
            "encoder_args": json.dumps(list(encoder_args)),
            "output_bucket": output_bucket,
            "output_prefix": output_prefix,
            "segment_count": segment_count(duration_s),
            "state": "queued",
            "renditions": "[]",
        },
    )
    r.set(_source_key(tenant, source_sha256, preset), job_id)
    return get(job_id)


def finalize_job(job_id: str, renditions: list[dict]) -> None:
    """Mark the job done with its renditions ({preset, key, duration_s} each)."""
    r.hset(f"job:{job_id}", mapping={"state": "done", "renditions": json.dumps(renditions)})
`,
  'transcoder/presets.py': `"""
The preset definitions (provided): preset id → the encoder arguments a worker runs for it. These
are the only presets; any other id is unknown.
"""
PRESETS = {
    "h264-720p": ["-c:v", "libx264", "-vf", "scale=-2:720", "-crf", "21", "-preset", "medium"],
    "h264-1080p": ["-c:v", "libx264", "-vf", "scale=-2:1080", "-crf", "21", "-preset", "medium"],
    "h265-1080p": ["-c:v", "libx265", "-vf", "scale=-2:1080", "-crf", "24", "-preset", "medium"],
}


def encoder_args(preset_id: str) -> list[str] | None:
    """The encoder arguments of the preset, or None when no such preset exists."""
    args = PRESETS.get(preset_id)
    return list(args) if args is not None else None
`,
  'transcoder/segments.py': `"""
The segment tracker (provided; step 2 builds the same functions): transcode:claim:{job_id}:{index}
holds the worker encoding a segment, with a LEASE_MS expiry; transcode:done:{job_id} is the set of
indices whose encode returned; transcode:failed:{job_id} the indices that failed terminally. The
manifest is computed from the done set against every expected index.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEASE_MS = 90_000

# Deletes the claim only while it still names this worker: a lease that expired and was retaken stays.
RELEASE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
"""
release_script = r.register_script(RELEASE_LUA)


def claim_key(job_id: str, index: int) -> str:
    return f"transcode:claim:{job_id}:{index}"


def done_key(job_id: str) -> str:
    return f"transcode:done:{job_id}"


def failed_key(job_id: str) -> str:
    return f"transcode:failed:{job_id}"


def claim(job_id: str, index: int, worker: str) -> bool:
    """Take segment index for worker, for LEASE_MS; False when another worker holds it."""
    return r.set(claim_key(job_id, index), worker, nx=True, px=LEASE_MS) is True


def release(job_id: str, index: int, worker: str) -> None:
    """Give the claim back, if worker still holds it."""
    release_script(keys=[claim_key(job_id, index)], args=[worker])


def is_done(job_id: str, index: int) -> bool:
    return bool(r.sismember(done_key(job_id), index))


def mark_done(job_id: str, index: int) -> None:
    r.sadd(done_key(job_id), index)


def run_segment(job_id: str, index: int, worker: str, encode) -> str:
    """Encode segment index once: "skipped" (already done), "busy" (claimed elsewhere) or "done"."""
    if is_done(job_id, index):
        return "skipped"
    if not claim(job_id, index, worker):
        return "busy"
    try:
        encode(job_id, index)
    except Exception:
        release(job_id, index, worker)
        raise
    mark_done(job_id, index)
    release(job_id, index, worker)
    return "done"


def manifest(job_id: str, segment_count: int) -> dict:
    """{segment_count, done, missing, complete}: done and missing are sorted indices."""
    done = sorted(int(i) for i in r.smembers(done_key(job_id)))
    missing = sorted(set(range(segment_count)) - set(done))
    return {"segment_count": segment_count, "done": done, "missing": missing, "complete": not missing}


def mark_failed(job_id: str, index: int) -> None:
    """Record that segment index failed terminally (the worker gave up on it)."""
    r.sadd(failed_key(job_id), index)


def failed(job_id: str) -> list[int]:
    """The indices that failed terminally, sorted."""
    return sorted(int(i) for i in r.smembers(failed_key(job_id)))
`,
  'transcoder/urls.py': `"""
Signed output references (provided): sign(bucket, key, expires_at) is the URL a player may fetch
until expires_at (seconds since the epoch); the storage front refuses it afterwards. The signature
is a stand-in (FNV-1a over a secret, the bucket, the key and the expiry) for a store's HMAC.
"""
SIGNED_URL_TTL_S = 900
_SECRET = "transcoderd-signing-key"


def _fnv1a(text: str) -> str:
    h = 0x811C9DC5
    for b in text.encode():
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def sign(bucket: str, key: str, expires_at: int) -> str:
    """The URL that grants reading key in bucket until expires_at."""
    sig = _fnv1a(f"{_SECRET}|{bucket}|{key}|{expires_at}")
    return f"https://{bucket}.storage.example/{key}?expires={expires_at}&sig={sig}"
`,
};

export const supportModulesTs: Record<string, string> = {
  'transcoder/jobs.ts': `/**
 * The job store (provided): every transcode job is a Redis hash job:{job_id} with job_id, tenant,
 * source_uri, source_sha256, duration_s, preset, encoder_args (a JSON list), output_bucket,
 * output_prefix, segment_count, state (queued, then done once finalized) and renditions (a JSON
 * list of {preset, key, duration_s}, written when the job is finalized).
 * job:by-source:{tenant}:{sha256}:{preset} holds the id of the job that source and preset were
 * first submitted as.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const SEGMENT_SECONDS = 6;

export interface Rendition {
  preset: string;
  key: string;
  duration_s: number;
}

export interface Job {
  job_id: string;
  tenant: string;
  source_uri: string;
  source_sha256: string;
  duration_s: number;
  preset: string;
  encoder_args: string[];
  output_bucket: string;
  output_prefix: string;
  segment_count: number;
  state: string;
  renditions: Rendition[];
}

/** How many SEGMENT_SECONDS segments cover durationS seconds (the last one may be shorter). */
export const segmentCount = (durationS: number): number => Math.ceil(durationS / SEGMENT_SECONDS);

/** [startS, lengthS] of segment index in a source of durationS seconds. */
export function segmentSpan(durationS: number, index: number): [number, number] {
  const start = index * SEGMENT_SECONDS;
  return [start, Math.min(SEGMENT_SECONDS, durationS - start)];
}

/** Where the job's rendition playlist lands in its output bucket. */
export const outputKey = (job: Job): string => \`\${job.output_prefix}/\${job.preset}/index.m3u8\`;

const sourceKey = (tenant: string, sourceSha256: string, preset: string): string => \`job:by-source:\${tenant}:\${sourceSha256}:\${preset}\`;

function jobOf(raw: Record<string, string>): Job | null {
  if (Object.keys(raw).length === 0) return null;
  return {
    job_id: raw.job_id,
    tenant: raw.tenant,
    source_uri: raw.source_uri,
    source_sha256: raw.source_sha256,
    duration_s: Number(raw.duration_s),
    preset: raw.preset,
    encoder_args: JSON.parse(raw.encoder_args) as string[],
    output_bucket: raw.output_bucket,
    output_prefix: raw.output_prefix,
    segment_count: Number(raw.segment_count),
    state: raw.state,
    renditions: JSON.parse(raw.renditions) as Rendition[],
  };
}

/** The job, or null. */
export async function get(jobId: string): Promise<Job | null> {
  return jobOf(await redis.hgetall(\`job:\${jobId}\`));
}

/** The job this tenant already submitted for (sourceSha256, preset), if any. */
export async function find(tenant: string, sourceSha256: string, preset: string): Promise<Job | null> {
  const jobId = await redis.get(sourceKey(tenant, sourceSha256, preset));
  return jobId === null ? null : get(jobId);
}

/** A new queued job, recorded as the job for (tenant, sourceSha256, preset); returns it. */
export async function create(
  tenant: string,
  sourceUri: string,
  sourceSha256: string,
  durationS: number,
  preset: string,
  encoderArgs: string[],
  outputBucket: string,
  outputPrefix: string,
): Promise<Job> {
  const jobId = \`tj-\${await redis.incr('job:seq')}\`;
  await redis.hset(\`job:\${jobId}\`, {
    job_id: jobId,
    tenant,
    source_uri: sourceUri,
    source_sha256: sourceSha256,
    duration_s: String(durationS),
    preset,
    encoder_args: JSON.stringify(encoderArgs),
    output_bucket: outputBucket,
    output_prefix: outputPrefix,
    segment_count: String(segmentCount(durationS)),
    state: 'queued',
    renditions: '[]',
  });
  await redis.set(sourceKey(tenant, sourceSha256, preset), jobId);
  return (await get(jobId)) as Job;
}

/** Mark the job done with its renditions. */
export async function finalizeJob(jobId: string, renditions: Rendition[]): Promise<void> {
  await redis.hset(\`job:\${jobId}\`, {state: 'done', renditions: JSON.stringify(renditions)});
}
`,
  'transcoder/presets.ts': `/**
 * The preset definitions (provided): preset id → the encoder arguments a worker runs for it. These
 * are the only presets; any other id is unknown.
 */
export const PRESETS: Record<string, readonly string[]> = {
  'h264-720p': ['-c:v', 'libx264', '-vf', 'scale=-2:720', '-crf', '21', '-preset', 'medium'],
  'h264-1080p': ['-c:v', 'libx264', '-vf', 'scale=-2:1080', '-crf', '21', '-preset', 'medium'],
  'h265-1080p': ['-c:v', 'libx265', '-vf', 'scale=-2:1080', '-crf', '24', '-preset', 'medium'],
};

/** The encoder arguments of the preset, or null when no such preset exists. */
export function encoderArgs(presetId: string): string[] | null {
  return Object.prototype.hasOwnProperty.call(PRESETS, presetId) ? [...PRESETS[presetId]] : null;
}
`,
  'transcoder/segments.ts': `/**
 * The segment tracker (provided; step 2 builds the same functions): transcode:claim:{job_id}:{index}
 * holds the worker encoding a segment, with a LEASE_MS expiry; transcode:done:{job_id} is the set
 * of indices whose encode returned; transcode:failed:{job_id} the indices that failed terminally.
 * The manifest is computed from the done set against every expected index.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const LEASE_MS = 90_000;

/** Deletes the claim only while it still names this worker: a lease that expired and was retaken stays. */
export const RELEASE_LUA = \`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
\`;

export interface Coverage {
  segment_count: number;
  done: number[];
  missing: number[];
  complete: boolean;
}

export const claimKey = (jobId: string, index: number): string => \`transcode:claim:\${jobId}:\${index}\`;
export const doneKey = (jobId: string): string => \`transcode:done:\${jobId}\`;
export const failedKey = (jobId: string): string => \`transcode:failed:\${jobId}\`;

/** Take segment index for worker, for LEASE_MS; false when another worker holds it. */
export async function claim(jobId: string, index: number, worker: string): Promise<boolean> {
  return (await redis.set(claimKey(jobId, index), worker, 'PX', LEASE_MS, 'NX')) === 'OK';
}

/** Give the claim back, if worker still holds it. */
export async function release(jobId: string, index: number, worker: string): Promise<void> {
  await redis.eval(RELEASE_LUA, 1, claimKey(jobId, index), worker);
}

export async function isDone(jobId: string, index: number): Promise<boolean> {
  return (await redis.sismember(doneKey(jobId), String(index))) === 1;
}

export async function markDone(jobId: string, index: number): Promise<void> {
  await redis.sadd(doneKey(jobId), String(index));
}

/** Encode segment index once: "skipped" (already done), "busy" (claimed elsewhere) or "done". */
export async function runSegment(jobId: string, index: number, worker: string, encode: (jobId: string, index: number) => Promise<void>): Promise<string> {
  if (await isDone(jobId, index)) return 'skipped';
  if (!(await claim(jobId, index, worker))) return 'busy';
  try {
    await encode(jobId, index);
  } catch (e) {
    await release(jobId, index, worker);
    throw e;
  }
  await markDone(jobId, index);
  await release(jobId, index, worker);
  return 'done';
}

/** The manifest: done and missing are sorted indices. */
export async function manifest(jobId: string, segmentCount: number): Promise<Coverage> {
  const done = (await redis.smembers(doneKey(jobId))).map(Number).sort((a, b) => a - b);
  const missing = Array.from({length: segmentCount}, (_, i) => i).filter(i => !done.includes(i));
  return {segment_count: segmentCount, done, missing, complete: missing.length === 0};
}

/** Record that segment index failed terminally (the worker gave up on it). */
export async function markFailed(jobId: string, index: number): Promise<void> {
  await redis.sadd(failedKey(jobId), String(index));
}

/** The indices that failed terminally, sorted. */
export async function failed(jobId: string): Promise<number[]> {
  return (await redis.smembers(failedKey(jobId))).map(Number).sort((a, b) => a - b);
}
`,
  'transcoder/urls.ts': `/**
 * Signed output references (provided): sign(bucket, key, expiresAt) is the URL a player may fetch
 * until expiresAt (seconds since the epoch); the storage front refuses it afterwards. The signature
 * is a stand-in (FNV-1a over a secret, the bucket, the key and the expiry) for a store's HMAC.
 */
export const SIGNED_URL_TTL_S = 900;
const SECRET = 'transcoderd-signing-key';

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The URL that grants reading key in bucket until expiresAt. */
export function sign(bucket: string, key: string, expiresAt: number): string {
  const sig = fnv1a(\`\${SECRET}|\${bucket}|\${key}|\${expiresAt}\`);
  return \`https://\${bucket}.storage.example/\${key}?expires=\${expiresAt}&sig=\${sig}\`;
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'transcoder/jobs/jobs.go': `// Package jobs is the job store (provided): every transcode job is a Redis hash job:{job_id} with
// job_id, tenant, source_uri, source_sha256, duration_s, preset, encoder_args (a JSON list),
// output_bucket, output_prefix, segment_count, state (queued, then done once finalized) and
// renditions (a JSON list of {preset, key, duration_s}, written when the job is finalized).
// job:by-source:{tenant}:{sha256}:{preset} holds the id of the job that source and preset were
// first submitted as.
package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// SegmentSeconds is the length of every segment but the last.
const SegmentSeconds = 6

// Rendition is one output of a finished job.
type Rendition struct {
	Preset    string  \`json:"preset"\`
	Key       string  \`json:"key"\`
	DurationS float64 \`json:"duration_s"\`
}

// Job is one transcode job.
type Job struct {
	JobID        string      \`json:"job_id"\`
	Tenant       string      \`json:"tenant"\`
	SourceURI    string      \`json:"source_uri"\`
	SourceSHA256 string      \`json:"source_sha256"\`
	DurationS    float64     \`json:"duration_s"\`
	Preset       string      \`json:"preset"\`
	EncoderArgs  []string    \`json:"encoder_args"\`
	OutputBucket string      \`json:"output_bucket"\`
	OutputPrefix string      \`json:"output_prefix"\`
	SegmentCount int         \`json:"segment_count"\`
	State        string      \`json:"state"\`
	Renditions   []Rendition \`json:"renditions"\`
}

// SegmentCount is how many SegmentSeconds segments cover durationS seconds (the last may be shorter).
func SegmentCount(durationS float64) int { return int(math.Ceil(durationS / SegmentSeconds)) }

// SegmentSpan is (startS, lengthS) of segment index in a source of durationS seconds.
func SegmentSpan(durationS float64, index int) (float64, float64) {
	start := float64(index * SegmentSeconds)
	return start, math.Min(SegmentSeconds, durationS-start)
}

// OutputKey is where the job's rendition playlist lands in its output bucket.
func OutputKey(job *Job) string { return job.OutputPrefix + "/" + job.Preset + "/index.m3u8" }

func sourceKey(tenant, sourceSHA256, preset string) string {
	return fmt.Sprintf("job:by-source:%s:%s:%s", tenant, sourceSHA256, preset)
}

// Get is the job, or nil.
func Get(ctx context.Context, jobID string) *Job {
	raw, err := rdb.HGetAll(ctx, "job:"+jobID).Result()
	if err != nil || len(raw) == 0 {
		return nil
	}
	job := &Job{JobID: raw["job_id"], Tenant: raw["tenant"], SourceURI: raw["source_uri"], SourceSHA256: raw["source_sha256"],
		Preset: raw["preset"], OutputBucket: raw["output_bucket"], OutputPrefix: raw["output_prefix"], State: raw["state"]}
	job.DurationS, _ = strconv.ParseFloat(raw["duration_s"], 64)
	job.SegmentCount, _ = strconv.Atoi(raw["segment_count"])
	json.Unmarshal([]byte(raw["encoder_args"]), &job.EncoderArgs)
	json.Unmarshal([]byte(raw["renditions"]), &job.Renditions)
	return job
}

// Find is the job this tenant already submitted for (sourceSHA256, preset), or nil.
func Find(ctx context.Context, tenant, sourceSHA256, preset string) *Job {
	jobID, err := rdb.Get(ctx, sourceKey(tenant, sourceSHA256, preset)).Result()
	if err != nil {
		return nil
	}
	return Get(ctx, jobID)
}

// Create records a new queued job as the job for (tenant, sourceSHA256, preset) and returns it.
func Create(ctx context.Context, tenant, sourceURI, sourceSHA256 string, durationS float64, preset string, encoderArgs []string, outputBucket, outputPrefix string) *Job {
	jobID := fmt.Sprintf("tj-%d", rdb.Incr(ctx, "job:seq").Val())
	if encoderArgs == nil {
		encoderArgs = []string{}
	}
	args, _ := json.Marshal(encoderArgs)
	rdb.HSet(ctx, "job:"+jobID, map[string]any{
		"job_id": jobID, "tenant": tenant, "source_uri": sourceURI, "source_sha256": sourceSHA256,
		"duration_s": strconv.FormatFloat(durationS, 'f', -1, 64), "preset": preset, "encoder_args": string(args),
		"output_bucket": outputBucket, "output_prefix": outputPrefix, "segment_count": SegmentCount(durationS),
		"state": "queued", "renditions": "[]",
	})
	rdb.Set(ctx, sourceKey(tenant, sourceSHA256, preset), jobID, 0)
	return Get(ctx, jobID)
}

// FinalizeJob marks the job done with its renditions.
func FinalizeJob(ctx context.Context, jobID string, renditions []Rendition) {
	raw, _ := json.Marshal(renditions)
	rdb.HSet(ctx, "job:"+jobID, map[string]any{"state": "done", "renditions": string(raw)})
}
`,
  'transcoder/presets/presets.go': `// Package presets holds the preset definitions (provided): preset id → the encoder arguments a
// worker runs for it. These are the only presets; any other id is unknown.
package presets

// Presets maps a preset id to its encoder arguments.
var Presets = map[string][]string{
	"h264-720p":  {"-c:v", "libx264", "-vf", "scale=-2:720", "-crf", "21", "-preset", "medium"},
	"h264-1080p": {"-c:v", "libx264", "-vf", "scale=-2:1080", "-crf", "21", "-preset", "medium"},
	"h265-1080p": {"-c:v", "libx265", "-vf", "scale=-2:1080", "-crf", "24", "-preset", "medium"},
}

// EncoderArgs is the encoder arguments of the preset; false when no such preset exists.
func EncoderArgs(presetID string) ([]string, bool) {
	args, ok := Presets[presetID]
	if !ok {
		return nil, false
	}
	return append([]string{}, args...), true
}
`,
  'transcoder/segments/segments.go': `// Package segments is the segment tracker (provided; step 2 builds the same functions):
// transcode:claim:{job_id}:{index} holds the worker encoding a segment, with a LeaseMS expiry;
// transcode:done:{job_id} is the set of indices whose encode returned; transcode:failed:{job_id}
// the indices that failed terminally. The manifest is computed from the done set against every
// expected index.
package segments

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// LeaseMS is how long a claim lasts before another worker may take the segment.
const LeaseMS = 90000

// releaseScript deletes the claim only while it still names this worker: a lease that expired and
// was retaken stays.
var releaseScript = redis.NewScript(\`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
\`)

// Coverage is the manifest of a job: Done and Missing are sorted indices.
type Coverage struct {
	SegmentCount int   \`json:"segment_count"\`
	Done         []int \`json:"done"\`
	Missing      []int \`json:"missing"\`
	Complete     bool  \`json:"complete"\`
}

func ClaimKey(jobID string, index int) string { return fmt.Sprintf("transcode:claim:%s:%d", jobID, index) }
func DoneKey(jobID string) string             { return "transcode:done:" + jobID }
func FailedKey(jobID string) string           { return "transcode:failed:" + jobID }

// Claim takes segment index for worker, for LeaseMS; false when another worker holds it.
func Claim(ctx context.Context, jobID string, index int, worker string) (bool, error) {
	return rdb.SetNX(ctx, ClaimKey(jobID, index), worker, LeaseMS*time.Millisecond).Result()
}

// Release gives the claim back, if worker still holds it.
func Release(ctx context.Context, jobID string, index int, worker string) error {
	return releaseScript.Run(ctx, rdb, []string{ClaimKey(jobID, index)}, worker).Err()
}

func IsDone(ctx context.Context, jobID string, index int) (bool, error) {
	return rdb.SIsMember(ctx, DoneKey(jobID), index).Result()
}

func MarkDone(ctx context.Context, jobID string, index int) error {
	return rdb.SAdd(ctx, DoneKey(jobID), index).Err()
}

// RunSegment encodes segment index once: "skipped" (already done), "busy" (claimed elsewhere) or "done".
func RunSegment(ctx context.Context, jobID string, index int, worker string, encode func(jobID string, index int) error) (string, error) {
	done, err := IsDone(ctx, jobID, index)
	if err != nil {
		return "", err
	}
	if done {
		return "skipped", nil
	}
	won, err := Claim(ctx, jobID, index, worker)
	if err != nil {
		return "", err
	}
	if !won {
		return "busy", nil
	}
	if err := encode(jobID, index); err != nil {
		Release(ctx, jobID, index, worker)
		return "", err
	}
	if err := MarkDone(ctx, jobID, index); err != nil {
		return "", err
	}
	return "done", Release(ctx, jobID, index, worker)
}

func indices(members []string) []int {
	out := make([]int, 0, len(members))
	for _, m := range members {
		n, _ := strconv.Atoi(m)
		out = append(out, n)
	}
	sort.Ints(out)
	return out
}

// Manifest is the job's coverage of every expected index.
func Manifest(ctx context.Context, jobID string, segmentCount int) (Coverage, error) {
	members, err := rdb.SMembers(ctx, DoneKey(jobID)).Result()
	if err != nil {
		return Coverage{}, err
	}
	done := indices(members)
	seen := map[int]bool{}
	for _, i := range done {
		seen[i] = true
	}
	missing := []int{}
	for i := 0; i < segmentCount; i++ {
		if !seen[i] {
			missing = append(missing, i)
		}
	}
	return Coverage{SegmentCount: segmentCount, Done: done, Missing: missing, Complete: len(missing) == 0}, nil
}

// MarkFailed records that segment index failed terminally (the worker gave up on it).
func MarkFailed(ctx context.Context, jobID string, index int) error {
	return rdb.SAdd(ctx, FailedKey(jobID), index).Err()
}

// Failed is the indices that failed terminally, sorted.
func Failed(ctx context.Context, jobID string) ([]int, error) {
	members, err := rdb.SMembers(ctx, FailedKey(jobID)).Result()
	if err != nil {
		return nil, err
	}
	return indices(members), nil
}
`,
  'transcoder/urls/urls.go': `// Package urls makes signed output references (provided): Sign(bucket, key, expiresAt) is the URL a
// player may fetch until expiresAt (seconds since the epoch); the storage front refuses it
// afterwards. The signature is a stand-in (FNV-1a over a secret, the bucket, the key and the
// expiry) for a store's HMAC.
package urls

import (
	"fmt"
	"hash/fnv"
)

// SignedURLTTL is how long a signed reference stays valid, in seconds.
const SignedURLTTL = 900

const secret = "transcoderd-signing-key"

// Sign is the URL that grants reading key in bucket until expiresAt.
func Sign(bucket, key string, expiresAt int64) string {
	h := fnv.New32a()
	h.Write([]byte(fmt.Sprintf("%s|%s|%s|%d", secret, bucket, key, expiresAt)))
	return fmt.Sprintf("https://%s.storage.example/%s?expires=%d&sig=%08x", bucket, key, expiresAt, h.Sum32())
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'transcoder/jobs.h': `// The job store (provided): every transcode job is a Redis hash job:{job_id} with job_id, tenant,
// source_uri, source_sha256, duration_s, preset, encoder_args (a JSON list), output_bucket,
// output_prefix, segment_count, state (queued, then done once finalized) and renditions (a JSON list
// of {preset, key, duration_s}, written when the job is finalized).
// job:by-source:{tenant}:{sha256}:{preset} holds the id of the job that source and preset were
// first submitted as.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cmath>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace jobs {

constexpr int kSegmentSeconds = 6;

struct Rendition {
  std::string preset;
  std::string key;
  double duration_s = 0;
};

struct Job {
  std::string job_id;
  std::string tenant;
  std::string source_uri;
  std::string source_sha256;
  double duration_s = 0;
  std::string preset;
  std::vector<std::string> encoder_args;
  std::string output_bucket;
  std::string output_prefix;
  int segment_count = 0;
  std::string state;
  std::vector<Rendition> renditions;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// How many kSegmentSeconds segments cover duration_s seconds (the last one may be shorter).
inline int segmentCount(double duration_s) { return static_cast<int>(std::ceil(duration_s / kSegmentSeconds)); }

// (start_s, length_s) of segment index in a source of duration_s seconds.
inline std::pair<double, double> segmentSpan(double duration_s, int index) {
  const double start = index * kSegmentSeconds;
  return {start, std::min<double>(kSegmentSeconds, duration_s - start)};
}

// Where the job's rendition playlist lands in its output bucket.
inline std::string outputKey(const Job& job) { return job.output_prefix + "/" + job.preset + "/index.m3u8"; }

inline std::string sourceKey(const std::string& tenant, const std::string& source_sha256, const std::string& preset) {
  return "job:by-source:" + tenant + ":" + source_sha256 + ":" + preset;
}

inline nlohmann::json renditionsJson(const std::vector<Rendition>& renditions) {
  nlohmann::json out = nlohmann::json::array();
  for (const Rendition& r : renditions) out.push_back({{"preset", r.preset}, {"key", r.key}, {"duration_s", r.duration_s}});
  return out;
}

// The job, or none.
inline std::optional<Job> get(const std::string& job_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("job:" + job_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  Job job;
  job.job_id = text("job_id");
  job.tenant = text("tenant");
  job.source_uri = text("source_uri");
  job.source_sha256 = text("source_sha256");
  job.duration_s = std::stod(text("duration_s"));
  job.preset = text("preset");
  job.encoder_args = nlohmann::json::parse(text("encoder_args")).get<std::vector<std::string>>();
  job.output_bucket = text("output_bucket");
  job.output_prefix = text("output_prefix");
  job.segment_count = std::stoi(text("segment_count"));
  job.state = text("state");
  for (const auto& r : nlohmann::json::parse(text("renditions"))) {
    job.renditions.push_back({r.value("preset", ""), r.value("key", ""), r.value("duration_s", 0.0)});
  }
  return job;
}

// The job this tenant already submitted for (source_sha256, preset), if any.
inline std::optional<Job> find(const std::string& tenant, const std::string& source_sha256, const std::string& preset) {
  const auto job_id = redis().get(sourceKey(tenant, source_sha256, preset));
  if (!job_id) return std::nullopt;
  return jobs::get(*job_id);
}

// A new queued job, recorded as the job for (tenant, source_sha256, preset); returns it.
inline Job create(const std::string& tenant, const std::string& source_uri, const std::string& source_sha256, double duration_s,
                  const std::string& preset, const std::vector<std::string>& encoder_args, const std::string& output_bucket,
                  const std::string& output_prefix) {
  const std::string job_id = "tj-" + std::to_string(redis().incr("job:seq"));
  redis().hset("job:" + job_id, {{"job_id", job_id},
                                 {"tenant", tenant},
                                 {"source_uri", source_uri},
                                 {"source_sha256", source_sha256},
                                 {"duration_s", nlohmann::json(duration_s).dump()},
                                 {"preset", preset},
                                 {"encoder_args", nlohmann::json(encoder_args).dump()},
                                 {"output_bucket", output_bucket},
                                 {"output_prefix", output_prefix},
                                 {"segment_count", std::to_string(segmentCount(duration_s))},
                                 {"state", "queued"},
                                 {"renditions", "[]"}});
  redis().set(sourceKey(tenant, source_sha256, preset), job_id);
  return *jobs::get(job_id);
}

// Mark the job done with its renditions.
inline void finalizeJob(const std::string& job_id, const std::vector<Rendition>& renditions) {
  redis().hset("job:" + job_id, {{"state", "done"}, {"renditions", renditionsJson(renditions).dump()}});
}

}  // namespace jobs
`,
  'transcoder/presets.h': `// The preset definitions (provided): preset id → the encoder arguments a worker runs for it. These
// are the only presets; any other id is unknown.
#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

namespace presets {

inline const std::map<std::string, std::vector<std::string>> kPresets = {
    {"h264-720p", {"-c:v", "libx264", "-vf", "scale=-2:720", "-crf", "21", "-preset", "medium"}},
    {"h264-1080p", {"-c:v", "libx264", "-vf", "scale=-2:1080", "-crf", "21", "-preset", "medium"}},
    {"h265-1080p", {"-c:v", "libx265", "-vf", "scale=-2:1080", "-crf", "24", "-preset", "medium"}},
};

// The encoder arguments of the preset, or none when no such preset exists.
inline std::optional<std::vector<std::string>> encoderArgs(const std::string& preset_id) {
  const auto it = kPresets.find(preset_id);
  if (it == kPresets.end()) return std::nullopt;
  return it->second;
}

}  // namespace presets
`,
  'transcoder/segments.h': `// The segment tracker (provided; step 2 builds the same functions): transcode:claim:{job_id}:{index}
// holds the worker encoding a segment, with a kLeaseMs expiry; transcode:done:{job_id} is the set
// of indices whose encode returned; transcode:failed:{job_id} the indices that failed terminally.
// The manifest is computed from the done set against every expected index.
#pragma once

#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <functional>
#include <set>
#include <string>
#include <vector>

namespace segments {

constexpr long long kLeaseMs = 90000;

// Deletes the claim only while it still names this worker: a lease that expired and was retaken stays.
inline const std::string kReleaseLua = R"lua(
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
)lua";

// The manifest of a job: done and missing are sorted indices.
struct Coverage {
  int segment_count = 0;
  std::vector<int> done;
  std::vector<int> missing;
  bool complete = false;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string claimKey(const std::string& job_id, int index) { return "transcode:claim:" + job_id + ":" + std::to_string(index); }
inline std::string doneKey(const std::string& job_id) { return "transcode:done:" + job_id; }
inline std::string failedKey(const std::string& job_id) { return "transcode:failed:" + job_id; }

// Take segment index for worker, for kLeaseMs; false when another worker holds it.
inline bool claim(const std::string& job_id, int index, const std::string& worker) {
  return redis().set(claimKey(job_id, index), worker, std::chrono::milliseconds(kLeaseMs), sw::redis::UpdateType::NOT_EXIST);
}

// Give the claim back, if worker still holds it.
inline void release(const std::string& job_id, int index, const std::string& worker) {
  redis().eval<long long>(kReleaseLua, {claimKey(job_id, index)}, {worker});
}

inline bool isDone(const std::string& job_id, int index) { return redis().sismember(doneKey(job_id), std::to_string(index)); }

inline void markDone(const std::string& job_id, int index) { redis().sadd(doneKey(job_id), std::to_string(index)); }

// Encode segment index once: "skipped" (already done), "busy" (claimed elsewhere) or "done".
inline std::string runSegment(const std::string& job_id, int index, const std::string& worker,
                              const std::function<void(const std::string&, int)>& encode) {
  if (isDone(job_id, index)) return "skipped";
  if (!claim(job_id, index, worker)) return "busy";
  try {
    encode(job_id, index);
  } catch (...) {
    release(job_id, index, worker);
    throw;
  }
  markDone(job_id, index);
  release(job_id, index, worker);
  return "done";
}

inline std::vector<int> indices(const std::vector<std::string>& members) {
  std::vector<int> out;
  for (const std::string& m : members) out.push_back(std::stoi(m));
  std::sort(out.begin(), out.end());
  return out;
}

// The job's coverage of every expected index.
inline Coverage manifest(const std::string& job_id, int segment_count) {
  Coverage out;
  out.segment_count = segment_count;
  out.done = indices(redis().smembers(doneKey(job_id)));
  const std::set<int> seen(out.done.begin(), out.done.end());
  for (int i = 0; i < segment_count; i++) {
    if (!seen.count(i)) out.missing.push_back(i);
  }
  out.complete = out.missing.empty();
  return out;
}

// Record that segment index failed terminally (the worker gave up on it).
inline void markFailed(const std::string& job_id, int index) { redis().sadd(failedKey(job_id), std::to_string(index)); }

// The indices that failed terminally, sorted.
inline std::vector<int> failed(const std::string& job_id) { return indices(redis().smembers(failedKey(job_id))); }

}  // namespace segments
`,
  'transcoder/urls.h': `// Signed output references (provided): sign(bucket, key, expires_at) is the URL a player may fetch
// until expires_at (seconds since the epoch); the storage front refuses it afterwards. The
// signature is a stand-in (FNV-1a over a secret, the bucket, the key and the expiry) for a store's
// HMAC.
#pragma once

#include <cstdint>
#include <cstdio>
#include <string>

namespace urls {

constexpr long long kSignedUrlTtlS = 900;

inline std::string fnv1a(const std::string& text) {
  uint32_t h = 0x811c9dc5u;
  for (const unsigned char b : text) {
    h ^= b;
    h *= 0x01000193u;
  }
  char out[9];
  std::snprintf(out, sizeof out, "%08x", h);
  return out;
}

// The URL that grants reading key in bucket until expires_at.
inline std::string sign(const std::string& bucket, const std::string& key, long long expires_at) {
  const std::string sig = fnv1a("transcoderd-signing-key|" + bucket + "|" + key + "|" + std::to_string(expires_at));
  return "https://" + bucket + ".storage.example/" + key + "?expires=" + std::to_string(expires_at) + "&sig=" + sig;
}

}  // namespace urls
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('transcoder', 'Jobs')]: `package transcoder

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

/**
 * The job store (provided): every transcode job is a Redis hash job:{job_id} with job_id, tenant,
 * source_uri, source_sha256, duration_s, preset, encoder_args (a JSON list), output_bucket,
 * output_prefix, segment_count, state (queued, then done once finalized) and renditions (a JSON
 * list of {preset, key, duration_s}, written when the job is finalized).
 * job:by-source:{tenant}:{sha256}:{preset} holds the id of the job that source and preset were
 * first submitted as.
 */
object Jobs {
  final case class Rendition(preset: String, key: String, durationS: Double)
  final case class Job(
      jobId: String,
      tenant: String,
      sourceUri: String,
      sourceSha256: String,
      durationS: Double,
      preset: String,
      encoderArgs: Seq[String],
      outputBucket: String,
      outputPrefix: String,
      segmentCount: Int,
      state: String,
      renditions: Seq[Rendition])

  val SegmentSeconds = 6

  val jedis = new JedisPooled("redis", 6379)

  /** How many SegmentSeconds segments cover durationS seconds (the last one may be shorter). */
  def segmentCount(durationS: Double): Int = math.ceil(durationS / SegmentSeconds).toInt

  /** (startS, lengthS) of segment index in a source of durationS seconds. */
  def segmentSpan(durationS: Double, index: Int): (Double, Double) = {
    val start = (index * SegmentSeconds).toDouble
    (start, math.min(SegmentSeconds.toDouble, durationS - start))
  }

  /** Where the job's rendition playlist lands in its output bucket. */
  def outputKey(job: Job): String = s"\${job.outputPrefix}/\${job.preset}/index.m3u8"

  private def sourceKey(tenant: String, sourceSha256: String, preset: String): String = s"job:by-source:$tenant:$sourceSha256:$preset"

  private def renditionJson(r: Rendition): JsValue = JsObject("preset" -> JsString(r.preset), "key" -> JsString(r.key), "duration_s" -> JsNumber(r.durationS))

  /** The job, if it exists. */
  def get(jobId: String): Option[Job] = {
    val raw = jedis.hgetAll(s"job:$jobId").asScala.toMap
    if (raw.isEmpty) None
    else {
      val renditions = raw("renditions").parseJson.convertTo[Seq[JsValue]].map { v =>
        val f = v.asJsObject.fields
        Rendition(f("preset").convertTo[String], f("key").convertTo[String], f("duration_s").convertTo[Double])
      }
      Some(Job(raw("job_id"), raw("tenant"), raw("source_uri"), raw("source_sha256"), raw("duration_s").toDouble, raw("preset"),
        raw("encoder_args").parseJson.convertTo[Seq[String]], raw("output_bucket"), raw("output_prefix"), raw("segment_count").toInt,
        raw("state"), renditions))
    }
  }

  /** The job this tenant already submitted for (sourceSha256, preset), if any. */
  def find(tenant: String, sourceSha256: String, preset: String): Option[Job] =
    Option(jedis.get(sourceKey(tenant, sourceSha256, preset))).flatMap(get)

  /** A new queued job, recorded as the job for (tenant, sourceSha256, preset); returns it. */
  def create(tenant: String, sourceUri: String, sourceSha256: String, durationS: Double, preset: String, encoderArgs: Seq[String], outputBucket: String, outputPrefix: String): Job = {
    val jobId = s"tj-\${jedis.incr("job:seq")}"
    jedis.hset(s"job:$jobId", Map(
      "job_id" -> jobId, "tenant" -> tenant, "source_uri" -> sourceUri, "source_sha256" -> sourceSha256,
      "duration_s" -> durationS.toString, "preset" -> preset, "encoder_args" -> encoderArgs.toJson.compactPrint,
      "output_bucket" -> outputBucket, "output_prefix" -> outputPrefix, "segment_count" -> segmentCount(durationS).toString,
      "state" -> "queued", "renditions" -> "[]").asJava)
    jedis.set(sourceKey(tenant, sourceSha256, preset), jobId)
    get(jobId).get
  }

  /** Mark the job done with its renditions. */
  def finalizeJob(jobId: String, renditions: Seq[Rendition]): Unit =
    jedis.hset(s"job:$jobId", Map("state" -> "done", "renditions" -> JsArray(renditions.map(renditionJson).toVector).compactPrint).asJava)
}
`,
  [scalaPath('transcoder', 'Presets')]: `package transcoder

/** The preset definitions (provided): preset id → the encoder arguments a worker runs for it. These are the only presets. */
object Presets {
  val Definitions: Map[String, Seq[String]] = Map(
    "h264-720p" -> Seq("-c:v", "libx264", "-vf", "scale=-2:720", "-crf", "21", "-preset", "medium"),
    "h264-1080p" -> Seq("-c:v", "libx264", "-vf", "scale=-2:1080", "-crf", "21", "-preset", "medium"),
    "h265-1080p" -> Seq("-c:v", "libx265", "-vf", "scale=-2:1080", "-crf", "24", "-preset", "medium"))

  /** The encoder arguments of the preset, or None when no such preset exists. */
  def encoderArgs(presetId: String): Option[Seq[String]] = Definitions.get(presetId)
}
`,
  [scalaPath('transcoder', 'Segments')]: `package transcoder

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

/**
 * The segment tracker (provided; step 2 builds the same functions): transcode:claim:{job_id}:{index}
 * holds the worker encoding a segment, with a LeaseMs expiry; transcode:done:{job_id} is the set of
 * indices whose encode returned; transcode:failed:{job_id} the indices that failed terminally. The
 * manifest is computed from the done set against every expected index.
 */
object Segments {
  /** The manifest of a job: done and missing are sorted indices. */
  final case class Coverage(segmentCount: Int, done: Seq[Int], missing: Seq[Int], complete: Boolean)

  val LeaseMs = 90000L

  /** Deletes the claim only while it still names this worker: a lease that expired and was retaken stays. */
  val ReleaseLua: String =
    """if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
      |return 0
      |""".stripMargin

  val jedis = new JedisPooled("redis", 6379)

  def claimKey(jobId: String, index: Int): String = s"transcode:claim:$jobId:$index"
  def doneKey(jobId: String): String = s"transcode:done:$jobId"
  def failedKey(jobId: String): String = s"transcode:failed:$jobId"

  /** Take segment index for worker, for LeaseMs; false when another worker holds it. */
  def claim(jobId: String, index: Int, worker: String): Boolean =
    jedis.set(claimKey(jobId, index), worker, SetParams.setParams().nx().px(LeaseMs)) != null

  /** Give the claim back, if worker still holds it. */
  def release(jobId: String, index: Int, worker: String): Unit =
    jedis.eval(ReleaseLua, List(claimKey(jobId, index)).asJava, List(worker).asJava)

  def isDone(jobId: String, index: Int): Boolean = jedis.sismember(doneKey(jobId), index.toString)

  def markDone(jobId: String, index: Int): Unit = jedis.sadd(doneKey(jobId), index.toString)

  /** Encode segment index once: "skipped" (already done), "busy" (claimed elsewhere) or "done". */
  def runSegment(jobId: String, index: Int, worker: String, encode: (String, Int) => Unit): String =
    if (isDone(jobId, index)) "skipped"
    else if (!claim(jobId, index, worker)) "busy"
    else {
      try encode(jobId, index)
      catch { case e: Exception => release(jobId, index, worker); throw e }
      markDone(jobId, index)
      release(jobId, index, worker)
      "done"
    }

  private def indices(key: String): Seq[Int] = jedis.smembers(key).asScala.toSeq.map(_.toInt).sorted

  /** The job's coverage of every expected index. */
  def manifest(jobId: String, segmentCount: Int): Coverage = {
    val done = indices(doneKey(jobId))
    val missing = (0 until segmentCount).filterNot(done.toSet)
    Coverage(segmentCount, done, missing, missing.isEmpty)
  }

  /** Record that segment index failed terminally (the worker gave up on it). */
  def markFailed(jobId: String, index: Int): Unit = jedis.sadd(failedKey(jobId), index.toString)

  /** The indices that failed terminally, sorted. */
  def failed(jobId: String): Seq[Int] = indices(failedKey(jobId))
}
`,
  [scalaPath('transcoder', 'Urls')]: `package transcoder

import java.nio.charset.StandardCharsets.UTF_8

/**
 * Signed output references (provided): sign(bucket, key, expiresAt) is the URL a player may fetch
 * until expiresAt (seconds since the epoch); the storage front refuses it afterwards. The signature
 * is a stand-in (FNV-1a over a secret, the bucket, the key and the expiry) for a store's HMAC.
 */
object Urls {
  val SignedUrlTtlSeconds = 900L

  private def fnv1a(text: String): String = {
    var h = 0x811c9dc5
    text.getBytes(UTF_8).foreach { b =>
      h ^= (b & 0xff)
      h *= 0x01000193
    }
    f"\${h & 0xffffffffL}%08x"
  }

  /** The URL that grants reading key in bucket until expiresAt. */
  def sign(bucket: String, key: String, expiresAt: Long): String = {
    val sig = fnv1a(s"transcoderd-signing-key|$bucket|$key|$expiresAt")
    s"https://$bucket.storage.example/$key?expires=$expiresAt&sig=$sig"
  }
}
`,
};
