import type {Step} from '@/lib/types';

export const transcriptionReadStep: Step = {
  id: 'read',
  title: 'GET /v1/transcriptions/{id}: finished only when it is finished',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'db', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it reads the id from the path,
returns the segments it finds, and answers with a confident \`status\`. The demo polls its own job, the
demo job always finishes, and the demo transcript fits on one page — so every defect stays invisible.
Find them, fix them, and prove the fix.

Implement \`GET /v1/transcriptions/{id}\`:

- The tenant comes from the authenticated \`X-Tenant-Id\` header and the job is resolved **scoped to it**:
  a missing id *and* an id that belongs to another tenant are both **404** — never 403, because 403
  confirms that the job exists, which is information the caller has no right to. The draft resolves by
  id alone, so any authenticated caller reads any tenant's transcript.
- The response reports \`status\`, \`completed_chunks\`, \`total_chunks\` and the \`transcript\` assembled
  from the stored segments **in order** (\`ORDER BY seq\`). The draft hands back raw rows and calls the
  caller's job done.
- \`status\` is \`"done"\` **only** when every chunk is complete. If any chunk is failed, or any chunk is
  still pending, the status is \`"partial"\`. A job that stalled halfway keeps the segments it already
  produced and reports them honestly — but it is never certified done.
- The transcript is **cursor-paginated**: a \`cursor\` query parameter selects the page
  (\`seq > cursor\`), and the response carries \`next_cursor\` when the page came back full, so segments
  past the first page are reachable. The draft hard-caps at the first 1000 segments and never says how
  to continue.

**Failure mode the checks target.** Three ways a read endpoint can lie. It can lie about identity: a
lookup by id alone is an IDOR, and a 403 for a foreign id leaks the existence of another tenant's job.
It can lie about completion: the presence of segments is not proof that the work finished, and a
\`done\` that arrives with a failed chunk will bill, notify and archive an unfinished transcript.
And it can lie about reachability: a fixed \`LIMIT 1000\` looks bounded and silently truncates a
four-hour recording, because no cursor is ever returned to walk past the cap.`,
  sequence: {
    participants: ['Client', 'Transcription API', 'jobs store', 'Redis'],
    messages: [
      {
        from: 'Client',
        to: 'Transcription API',
        label: 'GET /v1/transcriptions/{id}?cursor=… · X-Tenant-Id',
        kind: 'sync',
      },
      {
        from: 'Transcription API',
        to: 'jobs store',
        label: 'SELECT total_chunks FROM jobs WHERE id = $1 AND tenant_id = $2',
        kind: 'sync',
      },
      {from: 'jobs store', to: 'Transcription API', label: 'job row / no row → 404, never 403', kind: 'reply'},
      {
        from: 'Transcription API',
        to: 'Redis',
        label: 'HMGET transcription:{id}:chunks completed failed',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Transcription API', label: 'completed and failed chunk counts', kind: 'reply'},
      {
        from: 'Transcription API',
        to: 'jobs store',
        label: 'SELECT seq, text FROM segments WHERE job_id = $1 AND seq > $2 ORDER BY seq LIMIT $3',
        kind: 'sync',
      },
      {from: 'jobs store', to: 'Transcription API', label: 'the page of segments, in seq order', kind: 'reply'},
      {
        from: 'Transcription API',
        to: 'Client',
        label: '200 {status: done | partial, completed_chunks, total_chunks, transcript, next_cursor}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/transcriptions/{id}',
      detail: 'Register the read on `GET /v1/transcriptions/{id}` with the job id read from the path.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/transcriptions\/\{job_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/transcriptions\/:id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/transcriptions\/\{id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"transcriptions"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/transcriptions\//, /req\.matches\[1\]/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'A missing or foreign job is 404, never another tenant’s transcript',
      detail:
        'The tenant comes from `X-Tenant-Id` and the job is resolved with `WHERE id = $1 AND tenant_id = $2`; a foreign id answers **404**, exactly like an id that does not exist — never 403, which would confirm the job exists. The draft resolves by id alone, so any caller reads any tenant’s transcript.',
      match: {
        python: {
          all: [/WHERE id = %s AND tenant_id = %s/, /X-Tenant-Id/, /status_code\s*=\s*404/],
          none: [/status_code\s*=\s*403/],
        },
        typescript: {
          all: [/WHERE id = \$1 AND tenant_id = \$2/, /x-tenant-id/, /code\(\s*404\s*\)/],
          none: [/code\(\s*403\s*\)/],
        },
        go: {all: [/WHERE id = \$1 AND tenant_id = \$2/, /X-Tenant-Id/, /StatusNotFound/], none: [/StatusForbidden/]},
        scala: {
          all: [/WHERE id = \? AND tenant_id = \?/, /X-Tenant-Id/, /StatusCodes\.NotFound/],
          none: [/StatusCodes\.Forbidden/],
        },
        cpp: {all: [/WHERE id = \$1 AND tenant_id = \$2/, /X-Tenant-Id/, /\b404\b/], none: [/\b403\b/]},
      },
    },
    {
      id: 'honest-status',
      title: 'Certifies done only when no chunk is failed or pending',
      detail:
        '`status` is `done` only when the chunk-progress set reports nothing failed and nothing pending; a job that stalled answers `partial` with the segments it already has. The draft answers `done` as soon as any segment exists, so a half-transcribed file is certified finished.',
      match: {
        python: {all: [/["']partial["']/, /failed/, /pending/]},
        typescript: {all: [/['"]partial['"]/, /failed/, /pending/]},
        go: {all: [/"partial"/, /failed/, /pending/]},
        scala: {all: [/"partial"/, /failed/, /pending/]},
        cpp: {all: [/"partial"/, /failed/, /pending/]},
      },
    },
    {
      id: 'segment-assembly',
      title: 'Assembles the transcript from the stored segments in order',
      detail:
        'The segments are read `ORDER BY seq` and concatenated into `transcript`, so the caller receives a transcript rather than an unordered page of rows. The draft returns raw rows with no ordering and no assembled text.',
      match: {
        python: {all: [/ORDER BY seq/, /"transcript"\s*:/, /join\(/]},
        typescript: {all: [/ORDER BY seq/, /transcript\s*:/, /join\(/]},
        go: {all: [/ORDER BY seq/, /"transcript":/, /strings\.Join/]},
        scala: {all: [/ORDER BY seq/, /"transcript"/, /mkString/]},
        cpp: {all: [/ORDER BY seq/, /"transcript"/, /transcript \+=/]},
      },
    },
    {
      id: 'cursor-pagination',
      title: 'Pages segments with a cursor instead of a fixed 1000 cap',
      detail:
        'A `cursor` query parameter seeks with `seq > cursor` and the response carries `next_cursor` built from the last segment of a full page, so a long transcript is reachable past the first page. The draft caps the read at the first 1000 segments and returns no way to continue.',
      match: {
        python: {all: [/next_cursor/, /\bcursor\b/, /seq > %s/], none: [/LIMIT 1000/]},
        typescript: {all: [/next_cursor/, /\bcursor\b/, /seq > \$2/], none: [/LIMIT 1000/]},
        go: {all: [/next_cursor/, /\bcursor\b/, /seq > \$2/], none: [/LIMIT 1000/]},
        scala: {all: [/next_cursor/, /\bcursor\b/, /seq > \?/], none: [/LIMIT 1000/]},
        cpp: {all: [/next_cursor/, /\bcursor\b/, /seq > \$2/], none: [/LIMIT 1000/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/transcriptions/{job_id}")
def read_transcription(job_id: str, cur=None) -> JSONResponse:
    # TODO: this draft resolves the job by id alone, calls it done as soon as a segment exists, and
    # stops at the first page of 1000 segments. Scope the lookup by tenant, judge the chunk progress
    # before certifying, and page the transcript with a cursor.
    cur.execute("SELECT total_chunks FROM jobs WHERE id = %s", (job_id,))
    row = cur.fetchone()
    cur.execute("SELECT seq, text FROM segments WHERE job_id = %s LIMIT 1000", (job_id,))
    segments = cur.fetchall()
    completed = int(r.hget(f"transcription:{job_id}:chunks", "completed") or 0)
    return JSONResponse(
        {
            "id": job_id,
            "status": "done" if segments else "processing",
            "completed_chunks": completed,
            "total_chunks": row[0] if row else 0,
            "segments": [{"seq": segment["seq"], "text": segment["text"]} for segment in segments],
        },
        status_code=200,
    )
`,
      solution: `import redis
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

PAGE_SIZE = 200


def progress_key(job_id: str) -> str:
    """The hash the chunk workers write: one field per completed and failed chunk count."""
    return f"transcription:{job_id}:chunks"


def chunk_counters(job_id: str) -> tuple[int, int]:
    key = progress_key(job_id)
    completed = int(r.hget(key, "completed") or 0)
    failed = int(r.hget(key, "failed") or 0)
    return completed, failed


@app.get("/v1/transcriptions/{job_id}")
def read_transcription(
    job_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    cursor: str | None = Query(default=None),
    cur=None,
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail={"error": "missing X-Tenant-Id"})
    cur.execute(
        "SELECT total_chunks FROM jobs WHERE id = %s AND tenant_id = %s",
        (job_id, tenant),
    )
    row = cur.fetchone()
    # 404, not 403: a foreign job must be indistinguishable from one that never existed.
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not found"})
    total_chunks = row[0]

    completed_chunks, failed_chunks = chunk_counters(job_id)
    pending_chunks = total_chunks - completed_chunks - failed_chunks
    # A stalled job keeps the segments it produced, but it is never certified done.
    if completed_chunks == total_chunks and failed_chunks == 0 and pending_chunks == 0:
        status = "done"
    else:
        status = "partial"

    after = int(cursor) if cursor else 0
    cur.execute(
        "SELECT seq, speaker, text FROM segments"
        " WHERE job_id = %s AND seq > %s ORDER BY seq LIMIT %s",
        (job_id, after, PAGE_SIZE),
    )
    segments = cur.fetchall()
    transcript = "".join(segment["text"] for segment in segments)
    next_cursor = str(segments[-1]["seq"]) if len(segments) == PAGE_SIZE else None
    return JSONResponse(
        {
            "id": job_id,
            "status": status,
            "completed_chunks": completed_chunks,
            "total_chunks": total_chunks,
            "transcript": transcript,
            "next_cursor": next_cursor,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/transcriptions/:id: a model-generated draft that trusts the id and stops at page one. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
export const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/transcriptions/:id', async (request, reply) => {
  // TODO: this draft resolves the job by id alone, calls it done as soon as a segment exists, and
  // reads only the first 1000 segments. Scope the lookup by tenant, judge the chunk progress before
  // certifying, and page the transcript with a cursor.
  const {id} = request.params as {id: string};
  const {rows: jobs} = await db.query('SELECT total_chunks FROM jobs WHERE id = $1', [id]);
  const completed = Number((await redis.hget(\`transcription:\${id}:chunks\`, 'completed')) ?? 0);
  const {rows: segments} = await db.query(
    'SELECT seq, text FROM segments WHERE job_id = $1 LIMIT 1000',
    [id],
  );
  return reply.code(200).send({
    id,
    status: segments.length > 0 ? 'done' : 'processing',
    completed_chunks: completed,
    total_chunks: jobs[0]?.total_chunks ?? 0,
    segments,
  });
});
`,
      solution: `/** GET /v1/transcriptions/:id: tenant-scoped, honest about partial work, cursor-paginated. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
export const redis = new Redis({host: 'redis', port: 6379});

const PAGE_SIZE = 200;

interface ChunkProgress {
  completed_chunks: number;
  failed_chunks: number;
  pending_chunks: number;
}

/** The hash the chunk workers write: completed and failed counts, the remainder is still pending. */
async function chunkProgress(id: string, totalChunks: number): Promise<ChunkProgress> {
  const [completed, failed] = await redis.hmget(\`transcription:\${id}:chunks\`, 'completed', 'failed');
  const completedChunks = Number(completed ?? 0);
  const failedChunks = Number(failed ?? 0);
  return {
    completed_chunks: completedChunks,
    failed_chunks: failedChunks,
    pending_chunks: totalChunks - completedChunks - failedChunks,
  };
}

app.get('/v1/transcriptions/:id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const {id} = request.params as {id: string};
  const {cursor} = request.query as {cursor?: string};

  const {rows: jobs} = await db.query('SELECT total_chunks FROM jobs WHERE id = $1 AND tenant_id = $2', [
    id,
    tenant,
  ]);
  const job = jobs[0];
  // 404, not 403: a foreign job must be indistinguishable from one that never existed.
  if (job === undefined) return reply.code(404).send({error: 'not found'});

  const chunks = await chunkProgress(id, job.total_chunks);
  // A stalled job keeps the segments it produced, but it is never certified done.
  const status = chunks.failed_chunks === 0 && chunks.pending_chunks === 0 ? 'done' : 'partial';

  const after = cursor === undefined || cursor === '' ? 0 : Number(cursor);
  const {rows: segments} = await db.query(
    'SELECT seq, speaker, text FROM segments WHERE job_id = $1 AND seq > $2 ORDER BY seq LIMIT $3',
    [id, after, PAGE_SIZE],
  );
  const transcript = segments.map(segment => segment.text).join('');
  const next_cursor =
    segments.length === PAGE_SIZE ? String(segments[segments.length - 1].seq) : null;
  return reply.code(200).send({
    id,
    status,
    completed_chunks: chunks.completed_chunks,
    total_chunks: job.total_chunks,
    transcript: transcript,
    next_cursor: next_cursor,
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
)

func writeJSON(rw http.ResponseWriter, status int, payload map[string]any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(payload)
}

func readTranscription(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft resolves the job by id alone, calls it done as soon as a segment exists, and
	// reads only the first 1000 segments. Scope the lookup by tenant, judge the chunk progress
	// before certifying, and page the transcript with a cursor.
	jobID := r.PathValue("id")

	var totalChunks int64
	_ = db.QueryRowContext(r.Context(), "SELECT total_chunks FROM jobs WHERE id = $1", jobID).Scan(&totalChunks)
	completed, _ := rdb.HGet(r.Context(), "transcription:"+jobID+":chunks", "completed").Int64()

	rows, _ := db.QueryContext(r.Context(), "SELECT seq, text FROM segments WHERE job_id = $1 LIMIT 1000", jobID)
	var segments []map[string]any
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var seq int64
			var text string
			_ = rows.Scan(&seq, &text)
			segments = append(segments, map[string]any{"seq": seq, "text": text})
		}
	}
	status := "processing"
	if len(segments) > 0 {
		status = "done"
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"id":               jobID,
		"status":           status,
		"completed_chunks": completed,
		"total_chunks":     totalChunks,
		"segments":         segments,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/transcriptions/{id}", readTranscription)
	_ = http.ListenAndServe("0.0.0.0:8443", mux)
}
`,
      solution: `package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

const pageSize = 200

// ChunkProgress is what the workers recorded for the job: completed and failed spans, and the rest.
type ChunkProgress struct {
	completed int64
	failed    int64
	pending   int64
}

// chunkProgress reads the hash the chunk workers write and derives the still-pending span.
func chunkProgress(r *http.Request, jobID string, totalChunks int64) (ChunkProgress, error) {
	fields, err := rdb.HMGet(r.Context(), "transcription:"+jobID+":chunks", "completed", "failed").Result()
	if err != nil {
		return ChunkProgress{}, err
	}
	completed := int64(0)
	if raw, ok := fields[0].(string); ok {
		completed, _ = strconv.ParseInt(raw, 10, 64)
	}
	failed := int64(0)
	if raw, ok := fields[1].(string); ok {
		failed, _ = strconv.ParseInt(raw, 10, 64)
	}
	return ChunkProgress{completed: completed, failed: failed, pending: totalChunks - completed - failed}, nil
}

// SegmentRow is one stored transcript segment.
type SegmentRow struct {
	Seq     int64  \`json:"seq"\`
	Speaker string \`json:"speaker"\`
	Text    string \`json:"text"\`
}

func readTranscription(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	jobID := r.PathValue("id")

	var totalChunks int64
	err := db.QueryRowContext(
		r.Context(),
		"SELECT total_chunks FROM jobs WHERE id = $1 AND tenant_id = $2",
		jobID, tenant,
	).Scan(&totalChunks)
	// 404, not 403: a foreign job must be indistinguishable from one that never existed.
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "lookup failed"})
		return
	}

	progress, err := chunkProgress(r, jobID, totalChunks)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "progress unavailable"})
		return
	}
	// A stalled job keeps the segments it produced, but it is never certified done.
	status := "partial"
	if progress.failed == 0 && progress.pending == 0 {
		status = "done"
	}

	after := int64(0)
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		after, _ = strconv.ParseInt(cursor, 10, 64)
	}
	rows, err := db.QueryContext(
		r.Context(),
		"SELECT seq, speaker, text FROM segments WHERE job_id = $1 AND seq > $2 ORDER BY seq LIMIT $3",
		jobID, after, pageSize,
	)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "transcript unavailable"})
		return
	}
	defer rows.Close()

	var segments []SegmentRow
	var texts []string
	for rows.Next() {
		var segment SegmentRow
		if scanErr := rows.Scan(&segment.Seq, &segment.Speaker, &segment.Text); scanErr != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "corrupt segment"})
			return
		}
		texts = append(texts, segment.Text)
		segments = append(segments, segment)
	}
	transcript := strings.Join(texts, "")

	var nextCursor any
	if len(segments) == pageSize {
		nextCursor = strconv.FormatInt(segments[len(segments)-1].Seq, 10)
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"id":               jobID,
		"status":           status,
		"completed_chunks": progress.completed,
		"total_chunks":     totalChunks,
		"transcript":       transcript,
		"next_cursor":      nextCursor,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/transcriptions/{id}", readTranscription)
	_ = http.ListenAndServe("0.0.0.0:8443", mux)
}
`,
    },
    scala: {
      starter: `import java.sql.Connection

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

object TranscriptionRead {
  implicit val system: ActorSystem = ActorSystem("transcription-api")

  def jsonEntity(body: String): ResponseEntity =
    HttpEntity(ContentTypes.\`application/json\`, body)

  val route: Route =
    path("v1" / "transcriptions" / Segment) { jobId =>
      get {
        // TODO: this draft resolves the job by id alone, calls it done as soon as a segment exists,
        // and reads only the first 1000 segments. Scope the lookup by tenant, judge the chunk
        // progress before certifying, and page the transcript with a cursor.
        val job = conn.prepareStatement("SELECT total_chunks FROM jobs WHERE id = ?")
        job.setString(1, jobId)
        val jobRow = job.executeQuery()
        val totalChunks = if (jobRow.next()) jobRow.getLong("total_chunks") else 0L

        val stored = conn.prepareStatement("SELECT text FROM segments WHERE job_id = ? LIMIT 1000")
        stored.setString(1, jobId)
        val rows = stored.executeQuery()
        val texts = List.newBuilder[String]
        while (rows.next()) texts += rows.getString("text")

        val response = JsObject(
          "id" -> JsString(jobId),
          "status" -> JsString(if (texts.result().nonEmpty) "done" else "processing"),
          "total_chunks" -> JsNumber(totalChunks),
          "segments" -> JsArray(texts.result().map(JsString(_)).toVector)
        )
        complete(StatusCodes.OK, jsonEntity(response.compactPrint))
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.sql.Connection

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

final case class SegmentRow(seq: Long, speaker: String, text: String)

object TranscriptionRead {
  implicit val system: ActorSystem = ActorSystem("transcription-api")

  val PageSize = 200

  def jsonEntity(body: String): ResponseEntity =
    HttpEntity(ContentTypes.\`application/json\`, body)

  /** Completed and failed counts as the workers recorded them; the remainder is still pending. */
  def chunkProgress(jobId: String, totalChunks: Long): (Long, Long, Long) = {
    val key = s"transcription:$jobId:chunks"
    val completed = Option(jedis.hget(key, "completed")).map(_.toLong).getOrElse(0L)
    val failed = Option(jedis.hget(key, "failed")).map(_.toLong).getOrElse(0L)
    (completed, failed, totalChunks - completed - failed)
  }

  def segments(conn: Connection, jobId: String, after: Long, limit: Int): List[SegmentRow] = {
    val stmt = conn.prepareStatement(
      "SELECT seq, speaker, text FROM segments WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?"
    )
    stmt.setString(1, jobId)
    stmt.setLong(2, after)
    stmt.setInt(3, limit)
    val rows = stmt.executeQuery()
    val page = List.newBuilder[SegmentRow]
    while (rows.next()) page += SegmentRow(rows.getLong("seq"), rows.getString("speaker"), rows.getString("text"))
    page.result()
  }

  val route: Route =
    path("v1" / "transcriptions" / Segment) { jobId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          parameters("cursor".?) { cursorOpt =>
            val tenant = tenantOpt.filter(_.nonEmpty)
            if (tenant.isEmpty) complete(StatusCodes.Unauthorized, jsonEntity("""{"error":"missing X-Tenant-Id"}"""))
            else {
              val job = conn.prepareStatement("SELECT total_chunks FROM jobs WHERE id = ? AND tenant_id = ?")
              job.setString(1, jobId)
              job.setString(2, tenant.get)
              val jobRow = job.executeQuery()
              // 404, not 403: a foreign job must be indistinguishable from one that never existed.
              if (!jobRow.next()) complete(StatusCodes.NotFound, jsonEntity("""{"error":"not found"}"""))
              else {
                val totalChunks = jobRow.getLong("total_chunks")
                val (completedChunks, failedChunks, pendingChunks) = chunkProgress(jobId, totalChunks)
                // A stalled job keeps the segments it produced, but it is never certified done.
                val status = if (failedChunks == 0 && pendingChunks == 0) "done" else "partial"

                val after = cursorOpt.flatMap(_.toLongOption).getOrElse(0L)
                val page = segments(conn, jobId, after, PageSize)
                val transcript = page.map(_.text).mkString
                val nextCursor = if (page.length == PageSize) Some(page.last.seq.toString) else None
                val response = JsObject(
                  "id" -> JsString(jobId),
                  "status" -> JsString(status),
                  "completed_chunks" -> JsNumber(completedChunks),
                  "total_chunks" -> JsNumber(totalChunks),
                  "transcript" -> JsString(transcript),
                  "next_cursor" -> nextCursor.map(JsString(_)).getOrElse(JsNull)
                )
                complete(StatusCodes.OK, jsonEntity(response.compactPrint))
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/transcriptions/([\\w-]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string job_id = req.matches[1];
    // TODO: this draft resolves the job by id alone, calls it done as soon as a segment exists, and
    // reads only the first 1000 segments. Scope the lookup by tenant, judge the chunk progress
    // before certifying, and page the transcript with a cursor.
    pqxx::work tx(db_pool());
    const auto job = tx.exec_params("SELECT total_chunks FROM jobs WHERE id = $1", job_id);
    const auto rows = tx.exec_params("SELECT seq, text FROM segments WHERE job_id = $1 LIMIT 1000", job_id);

    json segments = json::array();
    for (const auto& row : rows)
      segments.push_back(json{{"seq", row["seq"].as<long long>()}, {"text", row["text"].as<std::string>()}});

    res.status = 200;
    res.set_content(
        json{{"id", job_id},
             {"status", segments.empty() ? "processing" : "done"},
             {"total_chunks", job.empty() ? 0 : job[0]["total_chunks"].as<long long>()},
             {"segments", segments}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

constexpr int kPageSize = 200;

// Chunk progress as the workers recorded it: completed and failed spans, and the rest.
struct ChunkProgress {
  long long completed = 0;
  long long failed = 0;
  long long pending = 0;
};

ChunkProgress chunk_progress(const std::string& job_id, long long total_chunks) {
  const auto key = "transcription:" + job_id + ":chunks";
  ChunkProgress progress;
  if (const auto completed = redis.hget(key, "completed")) progress.completed = std::stoll(*completed);
  if (const auto failed = redis.hget(key, "failed")) progress.failed = std::stoll(*failed);
  progress.pending = total_chunks - progress.completed - progress.failed;
  return progress;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/transcriptions/([\\w-]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string job_id = req.matches[1];

    pqxx::work tx(db_pool());
    const auto jobs = tx.exec_params(
        "SELECT total_chunks FROM jobs WHERE id = $1 AND tenant_id = $2", job_id, tenant);
    // 404, not 403: a foreign job must be indistinguishable from one that never existed.
    if (jobs.empty()) {
      res.status = 404;
      res.set_content(R"({"error":"not found"})", "application/json");
      return;
    }
    const long long total_chunks = jobs[0]["total_chunks"].as<long long>();

    const ChunkProgress progress = chunk_progress(job_id, total_chunks);
    // A stalled job keeps the segments it produced, but it is never certified done.
    const std::string status = progress.failed == 0 && progress.pending == 0 ? "done" : "partial";

    long long after = 0;
    if (const auto cursor = req.get_param_value("cursor"); !cursor.empty()) after = std::stoll(cursor);
    const auto rows = tx.exec_params(
        "SELECT seq, speaker, text FROM segments WHERE job_id = $1 AND seq > $2 ORDER BY seq LIMIT $3",
        job_id, after, kPageSize);

    std::string transcript;
    for (const auto& row : rows) transcript += row["text"].as<std::string>();
    const bool full_page = static_cast<int>(rows.size()) == kPageSize;
    const json next_cursor = full_page ? json(rows[rows.size() - 1]["seq"].as<long long>()) : json(nullptr);

    res.status = 200;
    res.set_content(
        json{{"id", job_id},
             {"status", status},
             {"completed_chunks", progress.completed},
             {"total_chunks", total_chunks},
             {"transcript", transcript},
             {"next_cursor", next_cursor}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Scope first: read `X-Tenant-Id` and resolve the job with `WHERE id = $1 AND tenant_id = $2`. A foreign job and a job that never existed must be the same answer — same 404, same body — because a 403 would confirm the job exists before the caller is allowed to know that.',
    'Let the chunk-progress hash decide the status, not the segments: `completed` and `failed` for the job, `pending = total_chunks - completed - failed`, and `done` only when nothing is failed and nothing is pending. A stalled job still has the segments it managed to publish; reporting those as `done` is the bug the whole read path exists to prevent.',
    'Page with keyset, not with a cap: `WHERE job_id = $1 AND seq > $2 ORDER BY seq LIMIT <page>` and answer `next_cursor` (the last `seq`) only when the page came back full. A fixed `LIMIT 1000` cannot be walked past, so a four-hour recording is permanently truncated.',
  ],
  debrief: `The interviewer is testing three ways a read endpoint can lie, and the draft tells all three lies in ten lines. It lies about identity: a lookup by id alone is an IDOR, and the only safe answer for a foreign id is the one a missing id gets — a 404 with the same body and the same latency, because 403 leaks that another tenant's job exists. It lies about completion: the presence of segments is not evidence that the work finished, so status has to be derived from the chunk-progress set — completed, failed, and the remainder that is still pending — and a job that stalled halfway must answer \`partial\` while still serving the segments it produced. It lies about reachability: \`LIMIT 1000\` looks like a bound and is really a wall, because no cursor is ever returned to walk past it; a keyset cursor over \`seq\` is stable under concurrent writes, costs one indexed seek per page, and says \`next_cursor\` only when more rows remain. Real systems push each of the three further — signing the cursor so callers cannot forge positions, reconciling the chunk counters against the ASR provider's usage before certifying \`done\`, and retiring segments that arrive from chunks that later failed — but the contract is decided by these three: who may read, whether the answer is certified, and whether the caller can reach the end.`,
};
