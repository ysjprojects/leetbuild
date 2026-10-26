import type {Language, Matcher, Step} from '@/lib/types';

/** The five languages a course is written in (the drill is not in CUDA). */
type CourseLanguage = Exclude<Language, 'cuda'>;

/** One status code, the way each language's framework spells it. */
const status = (code: number, go: string, scala: string): Record<CourseLanguage, RegExp> => ({
  python: new RegExp(`status_code\\s*=\\s*${code}|HTTP_${code}`),
  typescript: new RegExp(`code\\(\\s*${code}\\s*\\)|status\\(\\s*${code}\\s*\\)`),
  go: new RegExp(`http\\.${go}|\\b${code}\\b`),
  scala: new RegExp(`StatusCodes\\.${scala}|\\b${code}\\b`),
  cpp: new RegExp(`status\\s*=\\s*${code}`),
});

const PARTIAL = status(206, 'StatusPartialContent', 'PartialContent');
const NOT_SATISFIABLE = status(416, 'StatusRequestedRangeNotSatisfiable', 'RangeNotSatisfiable');

/** Range support a library would do for you: the drill is writing it. */
const LIBRARY_RANGES: Record<CourseLanguage, RegExp[]> = {
  python: [/FileResponse|StaticFiles/],
  typescript: [/@fastify\/static|sendFile\(/],
  go: [/ServeContent|ServeFile|FileServer/],
  scala: [/withRangeSupport|getFromFile|getFromResource/],
  cpp: [/set_mount_point|set_base_dir/],
};

/** The If-Range comparison: the header value against the current ETag, as a strong (byte-for-byte) match. */
const IF_RANGE_COMPARE: Record<CourseLanguage, RegExp> = {
  python: /if_range\s*!=\s*etag/,
  typescript: /ifRange\s*!==\s*etag/,
  go: /ifRange\s*!=\s*etag/,
  scala: /ifRange\.exists\(\s*_\s*!=\s*etag\s*\)/,
  cpp: /if_range\s*!=\s*etag/,
};

/** The parser is the same arithmetic in every language, so its matchers are built once and applied everywhere. */
const perLanguage = (build: (language: CourseLanguage) => Matcher): Record<CourseLanguage, Matcher> => ({
  python: build('python'),
  typescript: build('typescript'),
  go: build('go'),
  scala: build('scala'),
  cpp: build('cpp'),
});

export const byteRangesStep: Step = {
  id: 'byte-ranges',
  title: 'GET /files/{name}: one byte range, 206 or 416, guarded by If-Range',
  concept: 'http',
  file: 'files_api',
  focus: ['client', 'service'],
  task: `## Task

Implement \`GET /files/{name}\` over the module-level store \`FILES\` (name → bytes; the harness seeds it).
Byte ranges follow RFC 9110 §14.

- **Unknown name** → **404**.
- **Every** 200, 206 and 416 carries \`Accept-Ranges: bytes\` and a strong \`ETag\`: a quoted prefix of the
  hex sha256 of the bytes (\`"9f2c01d4e5b6a7c8"\`). Bodies are \`Content-Type: application/octet-stream\`.
- **No \`Range\`** → **200** with the whole file.
- **\`If-Range\`** present and not byte-for-byte the current ETag (another ETag, a \`W/\` tag, an HTTP date)
  → **200** with the whole file, whatever the \`Range\` says. Evaluate it before the range.
- **Three forms**: \`bytes=a-b\` clamps \`b\` to \`len - 1\`; \`bytes=a-\` runs to the end; \`bytes=-n\` is the last
  \`n\` bytes, the whole file when \`n >= len\`.
- **One satisfiable range** → **206**, \`Content-Range: bytes a-b/len\`, \`Content-Length\` the slice length,
  and exactly bytes \`a\` to \`b\` (inclusive) as the body.
- **Unsatisfiable**: \`a >= len\`, \`bytes=-0\`, or any range on an empty file → **416** with
  \`Content-Range: bytes */len\` and no body.
- **Ignored**: the \`Range\` is malformed (\`b < a\`, non-digits, no \`bytes=\` prefix) or names another unit,
  or it lists several ranges (no \`multipart/byteranges\` here) → **200** with the whole file.

> A resumed download asks for "the rest" of a file it already half holds. \`If-Range\` makes that request
> conditional: if the file changed, the server sends all of the new one instead of the tail of a version
> the client never started.`,
  sequence: {
    participants: ['Player', 'files_api'],
    messages: [
      {from: 'Player', to: 'files_api', label: 'GET /files/clip.bin · Range: bytes=0-499', kind: 'sync'},
      {
        from: 'files_api',
        to: 'Player',
        label: '206 · Content-Range: bytes 0-499/1000 · ETag "9f2c01d4"',
        kind: 'reply',
      },
      {from: 'Player', to: 'files_api', label: 'Range: bytes=500- · If-Range: "9f2c01d4"', kind: 'sync'},
      {from: 'files_api', to: 'files_api', label: 'If-Range == ETag · 500 < 1000', kind: 'sync'},
      {from: 'files_api', to: 'Player', label: '206 · Content-Range: bytes 500-999/1000', kind: 'reply'},
      {from: 'Player', to: 'files_api', label: 'Range: bytes=1000-', kind: 'sync'},
      {from: 'files_api', to: 'Player', label: '416 · Content-Range: bytes */1000', kind: 'reply'},
    ],
  },
  hints: [
    'Decide in this order: 404; no `Range` → 200; `If-Range` present and not equal to the ETag → 200; then parse. Parsing has three outcomes: one range, unsatisfiable, or ignore. Only the first two change the response.',
    'Require the `bytes=` prefix, refuse a comma, then match `^([0-9]*)-([0-9]*)$` (both empty is malformed). An empty first part is a suffix: `max(0, size - suffix)` to `size - 1`, with `-0` and an empty file unsatisfiable. Otherwise an explicit last position with `end < start` is ignored (`bytes=1000-` has none, so it is not), `start >= size` is unsatisfiable, and the end is `min(end, size - 1)`.',
    'The end is inclusive: the 206 body is `data[start:end + 1]`, and the framework derives `Content-Length` from it. `If-Range` is a plain equality with the strong ETag, so a date or a `W/` tag simply falls through to 200.',
  ],
  checks: [
    {
      id: 'partial-content',
      title: 'One range answers 206 with Content-Range, Content-Length and exactly the slice',
      detail:
        'Without `Range`: 200, the whole file, `Accept-Ranges: bytes`, a strong quoted-hex `ETag`. `bytes=0-99` and `bytes=100-199` on a 1000-byte file: 206, `Content-Range: bytes 0-99/1000`, `Content-Length: 100`, those 100 bytes exactly, `application/octet-stream`, the same headers. An unknown name: 404.',
      match: perLanguage(language => ({
        all: [PARTIAL[language], /["']Content-Range["']/, /["']Accept-Ranges["']/, /application\/octet-stream/],
        none: LIBRARY_RANGES[language],
      })),
    },
    {
      id: 'suffix-and-open',
      title: 'Suffix and open-ended ranges: bytes=-n and bytes=a-',
      detail:
        '`bytes=-100` and `bytes=900-` both answer `bytes 900-999/1000`; `bytes=-1` the last byte; `bytes=0-`, `bytes=-1000` and `bytes=-5000` the whole file as a 206 `bytes 0-999/1000`.',
      match: perLanguage(() => ({all: [/max\(\s*0\w*\s*,\s*size\s*-\s*suffix\s*\)/]})),
    },
    {
      id: 'clamp-end',
      title: 'A last-byte-pos past the end is clamped to len - 1',
      detail:
        '`bytes=950-5000` answers 206 `bytes 950-999/1000` with 50 bytes; `bytes=500-1000` gives `500-999`; `bytes=999-999` the single last byte; `bytes=0-999` the whole file as a 206.',
      match: perLanguage(() => ({all: [/min\(\s*end\s*,\s*size\s*-\s*1\s*\)/]})),
    },
    {
      id: 'unsatisfiable',
      title: 'An unsatisfiable range answers 416 with Content-Range: bytes */len',
      detail:
        '`bytes=1000-`, `bytes=1000-1999`, `bytes=5000-6000` and `bytes=-0` on a 1000-byte file: 416, `Content-Range: bytes */1000`, no body, `Accept-Ranges` and `ETag` still set. On an empty file `bytes=0-` and `bytes=-10` answer 416 `bytes */0`. `bytes=999-` is still a 206.',
      match: perLanguage(language => ({
        all: [NOT_SATISFIABLE[language], /bytes \*\//, /start\s*>=\s*size/, /suffix\s*===?\s*0/],
      })),
    },
    {
      id: 'if-range',
      title: 'A stale If-Range answers 200 with the whole current file',
      detail:
        'The current ETag in `If-Range` gets the 206. After the file changes, resuming with `Range: bytes=500-` and the old ETag gets 200 with all of the new bytes and the new ETag; so do an HTTP date, a `W/` form of the current ETag, and a stale ETag with an unsatisfiable range (200, not 416).',
      match: perLanguage(language => ({
        all: [/["']if-range["']/i, IF_RANGE_COMPARE[language]],
        none: [/["']W\//],
      })),
    },
    {
      id: 'ignored-ranges',
      title: 'Multiple or malformed ranges are ignored: 200 with the whole file',
      detail:
        '`bytes=0-9,20-29`, `bytes=50-10`, `bytes=abc-def`, `bytes=-`, `bytes=1-2-3`, `items=0-9` and `0-9` each answer 200 with the whole file and no `Content-Range`.',
      match: perLanguage(() => ({all: [/["']bytes=["']/, /["'],["']/, /end\s*<\s*start/]})),
    },
  ],
  code: {
    python: {
      starter: `"""GET /files/{name}: byte ranges (RFC 9110 §14) for resumable downloads and seeking."""
import hashlib
import re

from fastapi import FastAPI, HTTPException, Request, Response

app = FastAPI()

FILES: dict[str, bytes] = {}  # name -> bytes; the harness seeds it


@app.get("/files/{name}")
def download(name: str, request: Request) -> Response:
    # TODO: 404 for an unknown name
    # TODO: on 200, 206 and 416: Accept-Ranges: bytes and a strong ETag (a quoted sha256 hex prefix)
    # TODO: an If-Range that is not exactly the ETag -> 200 with the whole file
    # TODO: bytes=a-b (b clamped), bytes=a-, bytes=-n -> 206, Content-Range: bytes a-b/len, the slice
    # TODO: a >= len, bytes=-0, any range on an empty file -> 416, Content-Range: bytes */len
    # TODO: malformed, another unit or several ranges -> ignore the Range, 200 with the whole file
    raise HTTPException(status_code=501)
`,
      solution: `"""GET /files/{name}: byte ranges (RFC 9110 §14) for resumable downloads and seeking."""
import hashlib
import re

from fastapi import FastAPI, HTTPException, Request, Response

app = FastAPI()

FILES: dict[str, bytes] = {}  # name -> bytes; the harness seeds it

RANGE_SPEC = re.compile(r"([0-9]*)-([0-9]*)")
UNSATISFIABLE = "unsatisfiable"


def etag_of(data: bytes) -> str:
    return '"' + hashlib.sha256(data).hexdigest()[:16] + '"'


def parse_range(header: str, size: int):
    """(start, end) inclusive for one satisfiable range, UNSATISFIABLE, or None: ignore the header."""
    if not header.startswith("bytes="):
        return None  # another unit, or no unit at all
    spec = header[len("bytes="):]
    if "," in spec:
        return None  # several ranges: served whole, no multipart/byteranges
    m = RANGE_SPEC.fullmatch(spec)
    if m is None or m.group(1) == m.group(2) == "":
        return None
    first, last = m.group(1), m.group(2)
    if first == "":
        suffix = int(last)
        if suffix == 0 or size == 0:
            return UNSATISFIABLE
        return max(0, size - suffix), size - 1
    start = int(first)
    end = int(last) if last else size - 1
    if last and end < start:
        return None
    if start >= size:
        return UNSATISFIABLE
    return start, min(end, size - 1)


@app.get("/files/{name}")
def download(name: str, request: Request) -> Response:
    data = FILES.get(name)
    if data is None:
        raise HTTPException(status_code=404, detail="no such file")
    size = len(data)
    etag = etag_of(data)
    headers = {"Accept-Ranges": "bytes", "ETag": etag}
    full = Response(content=data, media_type="application/octet-stream", headers=headers)
    range_header = request.headers.get("range")
    if range_header is None:
        return full
    if_range = request.headers.get("if-range")
    if if_range is not None and if_range != etag:
        return full  # another version: never stitch two
    parsed = parse_range(range_header, size)
    if parsed is None:
        return full
    if parsed == UNSATISFIABLE:
        return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{size}"})
    start, end = parsed
    return Response(
        content=data[start:end + 1],
        status_code=206,
        media_type="application/octet-stream",
        headers={**headers, "Content-Range": f"bytes {start}-{end}/{size}"},
    )
`,
    },
    typescript: {
      starter: `// GET /files/:name: byte ranges (RFC 9110 §14) for resumable downloads and seeking.
import {createHash} from 'node:crypto';
import Fastify from 'fastify';

export const app = Fastify();

/** name -> bytes; the harness seeds it. */
export const FILES = new Map<string, Uint8Array>();

app.get('/files/:name', async (request, reply) => {
  const {name} = request.params as {name: string};
  // TODO: 404 for an unknown name
  // TODO: on 200, 206 and 416: Accept-Ranges: bytes and a strong ETag (a quoted sha256 hex prefix)
  // TODO: an If-Range that is not exactly the ETag -> 200 with the whole file
  // TODO: bytes=a-b (b clamped), bytes=a-, bytes=-n -> 206, Content-Range: bytes a-b/len, the slice
  // TODO: a >= len, bytes=-0, any range on an empty file -> 416, Content-Range: bytes */len
  // TODO: malformed, another unit or several ranges -> ignore the Range, 200 with the whole file
  return reply.code(501).send();
});
`,
      solution: `// GET /files/:name: byte ranges (RFC 9110 §14) for resumable downloads and seeking.
import {createHash} from 'node:crypto';
import Fastify from 'fastify';

export const app = Fastify();

/** name -> bytes; the harness seeds it. */
export const FILES = new Map<string, Uint8Array>();

const RANGE_SPEC = /^([0-9]*)-([0-9]*)$/;

const etagOf = (data: Uint8Array): string => \`"\${createHash('sha256').update(data).digest('hex').slice(0, 16)}"\`;

/** One satisfiable range (inclusive), 'unsatisfiable', or null: ignore the header. */
type Parsed = {start: number; end: number} | 'unsatisfiable' | null;

function parseRange(header: string, size: number): Parsed {
  if (!header.startsWith('bytes=')) return null; // another unit, or no unit at all
  const spec = header.slice('bytes='.length);
  if (spec.includes(',')) return null; // several ranges: served whole, no multipart/byteranges
  const m = RANGE_SPEC.exec(spec);
  if (m === null || (m[1] === '' && m[2] === '')) return null;
  const [, first, last] = m;
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return {start: Math.max(0, size - suffix), end: size - 1};
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Number(last);
  if (last !== '' && end < start) return null;
  if (start >= size) return 'unsatisfiable';
  return {start, end: Math.min(end, size - 1)};
}

app.get('/files/:name', async (request, reply) => {
  const {name} = request.params as {name: string};
  const data = FILES.get(name);
  if (data === undefined) return reply.code(404).send({error: 'no such file'});
  const size = data.length;
  const etag = etagOf(data);
  reply.header('Accept-Ranges', 'bytes').header('ETag', etag);
  const range = request.headers['range'];
  const ifRange = request.headers['if-range'];
  // No Range, or an If-Range naming another version (never stitch two): the whole file.
  if (typeof range !== 'string' || (ifRange !== undefined && ifRange !== etag))
    return reply.type('application/octet-stream').send(data);
  const parsed = parseRange(range, size);
  if (parsed === null) return reply.type('application/octet-stream').send(data);
  if (parsed === 'unsatisfiable') return reply.code(416).header('Content-Range', \`bytes */\${size}\`).send();
  const {start, end} = parsed;
  return reply
    .code(206)
    .header('Content-Range', \`bytes \${start}-\${end}/\${size}\`)
    .type('application/octet-stream')
    .send(data.subarray(start, end + 1));
});
`,
    },
    go: {
      starter: `// GET /files/{name}: byte ranges (RFC 9110 §14) for resumable downloads and seeking.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// files maps a name to its bytes.
var files = map[string][]byte{}

func download(w http.ResponseWriter, r *http.Request) {
	data, ok := files[r.PathValue("name")]
	// TODO: 404 for an unknown name
	// TODO: on 200, 206 and 416: Accept-Ranges: bytes and a strong ETag (a quoted sha256 hex prefix)
	// TODO: an If-Range that is not exactly the ETag -> 200 with the whole file
	// TODO: bytes=a-b (b clamped), bytes=a-, bytes=-n -> 206, Content-Range: bytes a-b/len, the slice
	// TODO: a >= len, bytes=-0, any range on an empty file -> 416, Content-Range: bytes */len
	// TODO: malformed, another unit or several ranges -> ignore the Range, 200 with the whole file
	_, _, _, _, _, _ = data, ok, sha256.Sum256, hex.EncodeToString, fmt.Sprintf, regexp.MustCompile
	_, _ = strconv.ParseInt, strings.HasPrefix
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /files/{name}", download)
	log.Fatal(http.ListenAndServe(":8080", mux))
}
`,
      solution: `// GET /files/{name}: byte ranges (RFC 9110 §14) for resumable downloads and seeking.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// files maps a name to its bytes.
var files = map[string][]byte{}

var rangeSpec = regexp.MustCompile(\`^([0-9]*)-([0-9]*)$\`)

type outcome int

const (
	ignore outcome = iota // serve the whole file
	unsatisfiable
	partial
)

func etagOf(data []byte) string {
	sum := sha256.Sum256(data)
	return \`"\` + hex.EncodeToString(sum[:8]) + \`"\`
}

// parseRange returns one satisfiable range (inclusive), unsatisfiable, or ignore.
func parseRange(header string, size int64) (outcome, int64, int64) {
	if !strings.HasPrefix(header, "bytes=") {
		return ignore, 0, 0 // another unit, or no unit at all
	}
	spec := strings.TrimPrefix(header, "bytes=")
	if strings.Contains(spec, ",") {
		return ignore, 0, 0 // several ranges: served whole, no multipart/byteranges
	}
	m := rangeSpec.FindStringSubmatch(spec)
	if m == nil || (m[1] == "" && m[2] == "") {
		return ignore, 0, 0
	}
	if m[1] == "" {
		suffix, _ := strconv.ParseInt(m[2], 10, 64)
		if suffix == 0 || size == 0 {
			return unsatisfiable, 0, 0
		}
		return partial, max(0, size-suffix), size - 1
	}
	start, _ := strconv.ParseInt(m[1], 10, 64)
	end := size - 1
	if m[2] != "" {
		end, _ = strconv.ParseInt(m[2], 10, 64)
	}
	if m[2] != "" && end < start {
		return ignore, 0, 0
	}
	if start >= size {
		return unsatisfiable, 0, 0
	}
	return partial, start, min(end, size-1)
}

func download(w http.ResponseWriter, r *http.Request) {
	data, ok := files[r.PathValue("name")]
	if !ok {
		http.Error(w, "no such file", http.StatusNotFound)
		return
	}
	size := int64(len(data))
	etag := etagOf(data)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("ETag", etag)
	kind, start, end := ignore, int64(0), int64(0)
	ifRange := r.Header.Get("If-Range")
	stale := r.Header.Get("If-Range") != "" && ifRange != etag // another version: never stitch two
	if rangeHeader := r.Header.Get("Range"); rangeHeader != "" && !stale {
		kind, start, end = parseRange(rangeHeader, size)
	}
	switch kind {
	case unsatisfiable:
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", size))
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
	case partial:
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
		w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
		w.WriteHeader(http.StatusPartialContent)
		w.Write(data[start : end+1])
	default:
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(data)
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /files/{name}", download)
	log.Fatal(http.ListenAndServe(":8080", mux))
}
`,
    },
    scala: {
      starter: `// GET /files/{name}: byte ranges (RFC 9110 §14) for resumable downloads and seeking.
import java.security.MessageDigest

import scala.collection.concurrent.TrieMap

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object FilesApi {
  /** name -> bytes. */
  val Files: TrieMap[String, Array[Byte]] = TrieMap.empty

  val route: Route =
    path("files" / Segment) { name =>
      get {
        optionalHeaderValueByName("Range") { range =>
          // TODO: 404 for an unknown name
          // TODO: on 200, 206 and 416: Accept-Ranges: bytes and a strong ETag (a quoted sha256 hex prefix)
          // TODO: an If-Range that is not exactly the ETag -> 200 with the whole file
          // TODO: bytes=a-b (b clamped), bytes=a-, bytes=-n -> 206, Content-Range: bytes a-b/len, the slice
          // TODO: a >= len, bytes=-0, any range on an empty file -> 416, Content-Range: bytes */len
          // TODO: malformed, another unit or several ranges -> ignore the Range, 200 with the whole file
          complete(StatusCodes.NotImplemented)
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("files")
    Http().newServerAt("0.0.0.0", 8080).bind(route)
  }
}
`,
      solution: `// GET /files/{name}: byte ranges (RFC 9110 §14) for resumable downloads and seeking.
import java.security.MessageDigest

import scala.collection.concurrent.TrieMap

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object FilesApi {
  /** name -> bytes. */
  val Files: TrieMap[String, Array[Byte]] = TrieMap.empty

  private val RangeSpec = "([0-9]*)-([0-9]*)".r

  sealed trait Parsed
  case object Ignore extends Parsed // serve the whole file
  case object Unsatisfiable extends Parsed
  final case class Slice(start: Long, end: Long) extends Parsed // inclusive

  def etagOf(data: Array[Byte]): String =
    "\\"" + MessageDigest.getInstance("SHA-256").digest(data).take(8).map("%02x".format(_)).mkString + "\\""

  def parseRange(header: String, size: Long): Parsed =
    if (!header.startsWith("bytes=")) Ignore // another unit, or no unit at all
    else {
      val spec = header.stripPrefix("bytes=")
      if (spec.contains(",")) Ignore // several ranges: served whole, no multipart/byteranges
      else
        spec match {
          case RangeSpec("", "") => Ignore
          case RangeSpec("", last) =>
            val suffix = last.toLong
            if (suffix == 0 || size == 0) Unsatisfiable
            else Slice(math.max(0L, size - suffix), size - 1)
          case RangeSpec(first, last) =>
            val start = first.toLong
            val end = if (last.isEmpty) size - 1 else last.toLong
            if (last.nonEmpty && end < start) Ignore
            else if (start >= size) Unsatisfiable
            else Slice(start, math.min(end, size - 1))
          case _ => Ignore
        }
    }

  val route: Route =
    path("files" / Segment) { name =>
      get {
        optionalHeaderValueByName("Range") { range =>
          optionalHeaderValueByName("If-Range") { ifRange =>
            Files.get(name) match {
              case None => complete(StatusCodes.NotFound -> "no such file")
              case Some(data) =>
                val size = data.length.toLong
                val etag = etagOf(data)
                val common = List(RawHeader("Accept-Ranges", "bytes"), RawHeader("ETag", etag))
                // An If-Range naming another version: never stitch two, serve the whole file.
                val parsed = if (ifRange.exists(_ != etag)) Ignore else range.fold[Parsed](Ignore)(parseRange(_, size))
                parsed match {
                  case Ignore =>
                    complete(HttpResponse(StatusCodes.OK, headers = common, entity = HttpEntity(ContentTypes.\`application/octet-stream\`, data)))
                  case Unsatisfiable =>
                    complete(HttpResponse(StatusCodes.RangeNotSatisfiable, headers = common :+ RawHeader("Content-Range", s"bytes */$size")))
                  case Slice(start, end) =>
                    val body = data.slice(start.toInt, end.toInt + 1)
                    complete(
                      HttpResponse(
                        StatusCodes.PartialContent,
                        headers = common :+ RawHeader("Content-Range", s"bytes $start-$end/$size"),
                        entity = HttpEntity(ContentTypes.\`application/octet-stream\`, body)))
                }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("files")
    Http().newServerAt("0.0.0.0", 8080).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `// GET /files/{name}: byte ranges (RFC 9110 §14) for resumable downloads and seeking.
#include <httplib.h>

#include <algorithm>
#include <map>
#include <regex>
#include <string>

#include "sha256.h"  // std::string sha256_hex(const std::string&)

// name -> bytes
std::map<std::string, std::string> files;

int main() {
  httplib::Server svr;

  svr.Get(R"(/files/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string name = req.matches[1];
    // TODO: 404 for an unknown name
    // TODO: on 200, 206 and 416: Accept-Ranges: bytes and a strong ETag (a quoted sha256 hex prefix)
    // TODO: an If-Range that is not exactly the ETag -> 200 with the whole file
    // TODO: bytes=a-b (b clamped), bytes=a-, bytes=-n -> 206, Content-Range: bytes a-b/len, the slice
    // TODO: a >= len, bytes=-0, any range on an empty file -> 416, Content-Range: bytes */len
    // TODO: malformed, another unit or several ranges -> ignore the Range, 200 with the whole file
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8080);
}
`,
      solution: `// GET /files/{name}: byte ranges (RFC 9110 §14) for resumable downloads and seeking.
#include <httplib.h>

#include <algorithm>
#include <map>
#include <regex>
#include <string>

#include "sha256.h"  // std::string sha256_hex(const std::string&)

// name -> bytes
std::map<std::string, std::string> files;

enum class Kind { Ignore, Unsatisfiable, Slice };  // Ignore: serve the whole file

struct Parsed {
  Kind kind;
  long long start = 0;  // inclusive
  long long end = 0;    // inclusive
};

Parsed parse_range(const std::string& header, long long size) {
  if (header.rfind("bytes=", 0) != 0) return {Kind::Ignore};  // another unit, or no unit at all
  const std::string spec = header.substr(6);
  if (spec.find(',') != std::string::npos) return {Kind::Ignore};  // several ranges: no multipart/byteranges
  static const std::regex range_spec("([0-9]*)-([0-9]*)");
  std::smatch m;
  if (!std::regex_match(spec, m, range_spec) || (m[1].length() == 0 && m[2].length() == 0)) return {Kind::Ignore};
  if (m[1].length() == 0) {
    const long long suffix = std::stoll(m[2].str());
    if (suffix == 0 || size == 0) return {Kind::Unsatisfiable};
    return {Kind::Slice, std::max(0LL, size - suffix), size - 1};
  }
  const long long start = std::stoll(m[1].str());
  const long long end = m[2].length() ? std::stoll(m[2].str()) : size - 1;
  if (m[2].length() && end < start) return {Kind::Ignore};
  if (start >= size) return {Kind::Unsatisfiable};
  return {Kind::Slice, start, std::min(end, size - 1)};
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/files/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto it = files.find(req.matches[1]);
    if (it == files.end()) {
      res.status = 404;
      res.set_content("no such file", "text/plain");
      return;
    }
    const std::string& data = it->second;
    const long long size = static_cast<long long>(data.size());
    const std::string etag = "\\"" + sha256_hex(data).substr(0, 16) + "\\"";
    res.set_header("Accept-Ranges", "bytes");
    res.set_header("ETag", etag);
    const std::string if_range = req.get_header_value("If-Range");
    const bool stale = req.has_header("If-Range") && if_range != etag;  // another version: never stitch two
    Parsed parsed{Kind::Ignore};
    if (req.has_header("Range") && !stale) parsed = parse_range(req.get_header_value("Range"), size);
    switch (parsed.kind) {
      case Kind::Unsatisfiable:
        res.status = 416;
        res.set_header("Content-Range", "bytes */" + std::to_string(size));
        return;
      case Kind::Slice:
        res.status = 206;
        res.set_header("Content-Range", "bytes " + std::to_string(parsed.start) + "-" + std::to_string(parsed.end) +
                                            "/" + std::to_string(size));
        res.set_content(data.substr(parsed.start, parsed.end - parsed.start + 1), "application/octet-stream");
        return;
      case Kind::Ignore:
        res.set_content(data, "application/octet-stream");
        return;
    }
  });

  svr.listen("0.0.0.0", 8080);
}
`,
    },
  },
  harness: {
    python: `import re

CLIP = bytes((i * 7 + 3) % 256 for i in range(1000))
CLIP_V2 = bytes((i * 11 + 5) % 256 for i in range(1000))


def _api(ctx):
    m = ctx.load("files_api")
    m.FILES.clear()
    m.FILES["clip.bin"] = CLIP
    m.FILES["empty.bin"] = b""
    return m


def _strong_etag(r, what):
    etag = r.headers.get("etag") or ""
    assert re.fullmatch('"[0-9a-f]{8,64}"', etag), f"{what}: ETag was {etag!r}, expected a strong quoted hex sha256 prefix such as '\\"9f2c01d4e5b6a7c8\\"'"
    return etag


def _common(r, what):
    assert r.headers.get("accept-ranges") == "bytes", f"{what}: Accept-Ranges was {r.headers.get('accept-ranges')!r}, expected 'bytes'"
    return _strong_etag(r, what)


def _partial(r, start, end, data, what):
    assert r.status_code == 206, f"{what} answered {r.status_code}, not 206"
    want = f"bytes {start}-{end}/{len(data)}"
    got = r.headers.get("content-range")
    assert got == want, f"{what}: Content-Range was {got!r}, expected {want!r}"
    length = end - start + 1
    assert r.headers.get("content-length") == str(length), f"{what}: Content-Length was {r.headers.get('content-length')!r}, expected {length}"
    assert r.content == data[start:end + 1], f"{what}: the body must be exactly bytes {start} to {end} ({length} bytes), got {len(r.content)} bytes that differ"
    ctype = r.headers.get("content-type") or ""
    assert ctype.startswith("application/octet-stream"), f"{what}: Content-Type was {ctype!r}, expected application/octet-stream"
    return _common(r, what)


def _full(r, data, what):
    assert r.status_code == 200, f"{what} answered {r.status_code}, not 200 with the whole file"
    assert r.content == data, f"{what}: the body must be the whole file ({len(data)} bytes), got {len(r.content)} bytes"
    assert r.headers.get("content-range") is None, f"{what}: a 200 carries no Content-Range, got {r.headers.get('content-range')!r}"
    return _common(r, what)


def _unsatisfiable(r, size, what):
    assert r.status_code == 416, f"{what} answered {r.status_code}, not 416"
    want = f"bytes */{size}"
    got = r.headers.get("content-range")
    assert got == want, f"{what}: Content-Range was {got!r}, expected {want!r}"
    assert r.content == b"", f"{what}: a 416 carries no body, got {len(r.content)} bytes"
    return _common(r, what)


async def check_partial_content(ctx):
    m = _api(ctx)
    async with ctx.client(m.app) as c:
        whole = await c.get("/files/clip.bin")
        head = await c.get("/files/clip.bin", headers={"Range": "bytes=0-99"})
        middle = await c.get("/files/clip.bin", headers={"Range": "bytes=100-199"})
        missing = await c.get("/files/ghost.bin", headers={"Range": "bytes=0-99"})
    etag = _full(whole, CLIP, "GET /files/clip.bin without Range")
    ctype = whole.headers.get("content-type") or ""
    assert ctype.startswith("application/octet-stream"), f"the 200 Content-Type was {ctype!r}, expected application/octet-stream"
    assert _partial(head, 0, 99, CLIP, "Range: bytes=0-99") == etag, "the 206 must carry the same ETag as the 200"
    _partial(middle, 100, 199, CLIP, "Range: bytes=100-199")
    assert missing.status_code == 404, f"GET /files/ghost.bin answered {missing.status_code}, not 404"


async def check_suffix_and_open(ctx):
    m = _api(ctx)
    cases = [("bytes=-100", 900, 999), ("bytes=900-", 900, 999), ("bytes=-1", 999, 999), ("bytes=0-", 0, 999), ("bytes=-1000", 0, 999), ("bytes=-5000", 0, 999)]
    async with ctx.client(m.app) as c:
        for spec, start, end in cases:
            r = await c.get("/files/clip.bin", headers={"Range": spec})
            _partial(r, start, end, CLIP, f"Range: {spec} on 1000 bytes")


async def check_clamp_end(ctx):
    m = _api(ctx)
    cases = [("bytes=950-5000", 950, 999), ("bytes=500-1000", 500, 999), ("bytes=999-999", 999, 999), ("bytes=0-999", 0, 999)]
    async with ctx.client(m.app) as c:
        for spec, start, end in cases:
            r = await c.get("/files/clip.bin", headers={"Range": spec})
            _partial(r, start, end, CLIP, f"Range: {spec} on 1000 bytes")


async def check_unsatisfiable(ctx):
    m = _api(ctx)
    async with ctx.client(m.app) as c:
        for spec in ["bytes=1000-", "bytes=1000-1999", "bytes=5000-6000", "bytes=-0"]:
            r = await c.get("/files/clip.bin", headers={"Range": spec})
            _unsatisfiable(r, 1000, f"Range: {spec} on 1000 bytes")
        for spec in ["bytes=0-", "bytes=-10"]:
            r = await c.get("/files/empty.bin", headers={"Range": spec})
            _unsatisfiable(r, 0, f"Range: {spec} on an empty file")
        empty = await c.get("/files/empty.bin")
        last = await c.get("/files/clip.bin", headers={"Range": "bytes=999-"})
    _full(empty, b"", "GET /files/empty.bin without Range")
    _partial(last, 999, 999, CLIP, "Range: bytes=999- (the last byte exists)")


async def check_if_range(ctx):
    m = _api(ctx)
    async with ctx.client(m.app) as c:
        first = await c.get("/files/clip.bin", headers={"Range": "bytes=0-499"})
        old = _partial(first, 0, 499, CLIP, "Range: bytes=0-499")
        same = await c.get("/files/clip.bin", headers={"Range": "bytes=500-", "If-Range": old})
        _partial(same, 500, 999, CLIP, "Range: bytes=500- with If-Range equal to the current ETag")
        m.FILES["clip.bin"] = CLIP_V2
        resumed = await c.get("/files/clip.bin", headers={"Range": "bytes=500-", "If-Range": old})
        new = _full(resumed, CLIP_V2, "after the file changed, Range: bytes=500- with the old ETag in If-Range")
        assert new != old, f"the file changed but its ETag stayed {old}"
        current = await c.get("/files/clip.bin", headers={"Range": "bytes=500-", "If-Range": new})
        _partial(current, 500, 999, CLIP_V2, "Range: bytes=500- with If-Range equal to the new ETag")
        dated = await c.get("/files/clip.bin", headers={"Range": "bytes=500-", "If-Range": "Wed, 21 Oct 2026 07:28:00 GMT"})
        _full(dated, CLIP_V2, "If-Range carrying an HTTP date")
        weak = await c.get("/files/clip.bin", headers={"Range": "bytes=500-", "If-Range": "W/" + new})
        _full(weak, CLIP_V2, f"If-Range: W/{new} (a weak tag never matches strongly)")
        stale_416 = await c.get("/files/clip.bin", headers={"Range": "bytes=5000-", "If-Range": old})
        _full(stale_416, CLIP_V2, "a stale If-Range with an unsatisfiable Range: the Range is ignored, so not 416")


async def check_ignored_ranges(ctx):
    m = _api(ctx)
    async with ctx.client(m.app) as c:
        for spec in ["bytes=0-9,20-29", "bytes=50-10", "bytes=abc-def", "bytes=-", "bytes=1-2-3", "items=0-9", "0-9"]:
            r = await c.get("/files/clip.bin", headers={"Range": spec})
            _full(r, CLIP, f"Range: {spec}")
`,
    typescript: `const CLIP = Uint8Array.from({length: 1000}, (_, i) => (i * 7 + 3) % 256);
const CLIP_V2 = Uint8Array.from({length: 1000}, (_, i) => (i * 11 + 5) % 256);
const EMPTY = new Uint8Array();

function api(ctx) {
  const m = ctx.load('files_api');
  m.FILES.clear();
  m.FILES.set('clip.bin', CLIP);
  m.FILES.set('empty.bin', EMPTY);
  return m;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

function strongEtag(r, what: string): string {
  const etag = r.headers['etag'] ?? '';
  assert(/^"[0-9a-f]{8,64}"$/.test(etag), \`\${what}: ETag was \${JSON.stringify(etag)}, expected a strong quoted hex sha256 prefix such as '"9f2c01d4e5b6a7c8"'\`);
  return etag;
}

function common(r, what: string): string {
  assert.equal(r.headers['accept-ranges'], 'bytes', \`\${what}: Accept-Ranges was \${JSON.stringify(r.headers['accept-ranges'])}, expected 'bytes'\`);
  return strongEtag(r, what);
}

function partial(r, start: number, end: number, data: Uint8Array, what: string): string {
  assert.equal(r.status, 206, \`\${what} answered \${r.status}, not 206\`);
  const want = \`bytes \${start}-\${end}/\${data.length}\`;
  assert.equal(r.headers['content-range'], want, \`\${what}: Content-Range was \${JSON.stringify(r.headers['content-range'])}, expected '\${want}'\`);
  const length = end - start + 1;
  assert.equal(r.headers['content-length'], String(length), \`\${what}: Content-Length was \${JSON.stringify(r.headers['content-length'])}, expected \${length}\`);
  assert(sameBytes(r.bytes, data.subarray(start, end + 1)), \`\${what}: the body must be exactly bytes \${start} to \${end} (\${length} bytes), got \${r.bytes.length} bytes that differ\`);
  const ctype = r.headers['content-type'] ?? '';
  assert(ctype.startsWith('application/octet-stream'), \`\${what}: Content-Type was \${JSON.stringify(ctype)}, expected application/octet-stream\`);
  return common(r, what);
}

function full(r, data: Uint8Array, what: string): string {
  assert.equal(r.status, 200, \`\${what} answered \${r.status}, not 200 with the whole file\`);
  assert(sameBytes(r.bytes, data), \`\${what}: the body must be the whole file (\${data.length} bytes), got \${r.bytes.length} bytes\`);
  assert.equal(r.headers['content-range'], undefined, \`\${what}: a 200 carries no Content-Range, got \${JSON.stringify(r.headers['content-range'])}\`);
  return common(r, what);
}

function unsatisfiable(r, size: number, what: string): string {
  assert.equal(r.status, 416, \`\${what} answered \${r.status}, not 416\`);
  const want = \`bytes */\${size}\`;
  assert.equal(r.headers['content-range'], want, \`\${what}: Content-Range was \${JSON.stringify(r.headers['content-range'])}, expected '\${want}'\`);
  assert.equal(r.bytes.length, 0, \`\${what}: a 416 carries no body, got \${r.bytes.length} bytes\`);
  return common(r, what);
}

const ranged = (c, name: string, headers: Record<string, string>) => c.get(\`/files/\${name}\`, {headers});

export async function check_partial_content(ctx) {
  const c = ctx.client(api(ctx).app);
  const whole = await c.get('/files/clip.bin');
  const etag = full(whole, CLIP, 'GET /files/clip.bin without Range');
  const ctype = whole.headers['content-type'] ?? '';
  assert(ctype.startsWith('application/octet-stream'), \`the 200 Content-Type was \${JSON.stringify(ctype)}, expected application/octet-stream\`);
  const head = await ranged(c, 'clip.bin', {Range: 'bytes=0-99'});
  assert.equal(partial(head, 0, 99, CLIP, 'Range: bytes=0-99'), etag, 'the 206 must carry the same ETag as the 200');
  partial(await ranged(c, 'clip.bin', {Range: 'bytes=100-199'}), 100, 199, CLIP, 'Range: bytes=100-199');
  const missing = await ranged(c, 'ghost.bin', {Range: 'bytes=0-99'});
  assert.equal(missing.status, 404, \`GET /files/ghost.bin answered \${missing.status}, not 404\`);
}

export async function check_suffix_and_open(ctx) {
  const c = ctx.client(api(ctx).app);
  const cases: [string, number, number][] = [
    ['bytes=-100', 900, 999],
    ['bytes=900-', 900, 999],
    ['bytes=-1', 999, 999],
    ['bytes=0-', 0, 999],
    ['bytes=-1000', 0, 999],
    ['bytes=-5000', 0, 999],
  ];
  for (const [spec, start, end] of cases)
    partial(await ranged(c, 'clip.bin', {Range: spec}), start, end, CLIP, \`Range: \${spec} on 1000 bytes\`);
}

export async function check_clamp_end(ctx) {
  const c = ctx.client(api(ctx).app);
  const cases: [string, number, number][] = [
    ['bytes=950-5000', 950, 999],
    ['bytes=500-1000', 500, 999],
    ['bytes=999-999', 999, 999],
    ['bytes=0-999', 0, 999],
  ];
  for (const [spec, start, end] of cases)
    partial(await ranged(c, 'clip.bin', {Range: spec}), start, end, CLIP, \`Range: \${spec} on 1000 bytes\`);
}

export async function check_unsatisfiable(ctx) {
  const c = ctx.client(api(ctx).app);
  for (const spec of ['bytes=1000-', 'bytes=1000-1999', 'bytes=5000-6000', 'bytes=-0'])
    unsatisfiable(await ranged(c, 'clip.bin', {Range: spec}), 1000, \`Range: \${spec} on 1000 bytes\`);
  for (const spec of ['bytes=0-', 'bytes=-10'])
    unsatisfiable(await ranged(c, 'empty.bin', {Range: spec}), 0, \`Range: \${spec} on an empty file\`);
  full(await c.get('/files/empty.bin'), EMPTY, 'GET /files/empty.bin without Range');
  partial(await ranged(c, 'clip.bin', {Range: 'bytes=999-'}), 999, 999, CLIP, 'Range: bytes=999- (the last byte exists)');
}

export async function check_if_range(ctx) {
  const m = api(ctx);
  const c = ctx.client(m.app);
  const old = partial(await ranged(c, 'clip.bin', {Range: 'bytes=0-499'}), 0, 499, CLIP, 'Range: bytes=0-499');
  const same = await ranged(c, 'clip.bin', {Range: 'bytes=500-', 'If-Range': old});
  partial(same, 500, 999, CLIP, 'Range: bytes=500- with If-Range equal to the current ETag');
  m.FILES.set('clip.bin', CLIP_V2);
  const resumed = await ranged(c, 'clip.bin', {Range: 'bytes=500-', 'If-Range': old});
  const fresh = full(resumed, CLIP_V2, 'after the file changed, Range: bytes=500- with the old ETag in If-Range');
  assert.notEqual(fresh, old, \`the file changed but its ETag stayed \${old}\`);
  const current = await ranged(c, 'clip.bin', {Range: 'bytes=500-', 'If-Range': fresh});
  partial(current, 500, 999, CLIP_V2, 'Range: bytes=500- with If-Range equal to the new ETag');
  const dated = await ranged(c, 'clip.bin', {Range: 'bytes=500-', 'If-Range': 'Wed, 21 Oct 2026 07:28:00 GMT'});
  full(dated, CLIP_V2, 'If-Range carrying an HTTP date');
  const weak = await ranged(c, 'clip.bin', {Range: 'bytes=500-', 'If-Range': \`W/\${fresh}\`});
  full(weak, CLIP_V2, \`If-Range: W/\${fresh} (a weak tag never matches strongly)\`);
  const stale416 = await ranged(c, 'clip.bin', {Range: 'bytes=5000-', 'If-Range': old});
  full(stale416, CLIP_V2, 'a stale If-Range with an unsatisfiable Range: the Range is ignored, so not 416');
}

export async function check_ignored_ranges(ctx) {
  const c = ctx.client(api(ctx).app);
  for (const spec of ['bytes=0-9,20-29', 'bytes=50-10', 'bytes=abc-def', 'bytes=-', 'bytes=1-2-3', 'items=0-9', '0-9'])
    full(await ranged(c, 'clip.bin', {Range: spec}), CLIP, \`Range: \${spec}\`);
}
`,
    go: `package main

import (
	"bytes"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"leetbuild/harness"
)

var (
	rangeClip   = rangeBytes(7, 3)
	rangeClipV2 = rangeBytes(11, 5)
	rangeEmpty  = []byte{}
	rangeStrong = regexp.MustCompile(\`^"[0-9a-f]{8,64}"$\`)
)

// rangeBytes is 1000 bytes, byte i being (i*mul + add) % 256.
func rangeBytes(mul, add int) []byte {
	data := make([]byte, 1000)
	for i := range data {
		data[i] = byte((i*mul + add) % 256)
	}
	return data
}

// rangeAPI seeds files with clip.bin and empty.bin and returns a client of the learner's server.
func rangeAPI(ctx *harness.Ctx) *harness.HTTP {
	files = map[string][]byte{"clip.bin": rangeClip, "empty.bin": rangeEmpty}
	return ctx.Main(main).HTTP()
}

// rangeHeader is a header's value, or nil when the response does not carry it.
func rangeHeader(r *harness.Response, name string) any {
	if _, ok := r.Header[http.CanonicalHeaderKey(name)]; !ok {
		return nil
	}
	return r.Header.Get(name)
}

func rangeCommon(ctx *harness.Ctx, r *harness.Response, what string) string {
	ctx.Equal(rangeHeader(r, "Accept-Ranges"), "bytes", "%s: Accept-Ranges", what)
	etag := r.Header.Get("ETag")
	ctx.Assert(rangeStrong.MatchString(etag), "%s: ETag was %q, expected a strong quoted hex sha256 prefix such as '\\"9f2c01d4e5b6a7c8\\"'", what, etag)
	return etag
}

func rangePartial(ctx *harness.Ctx, r *harness.Response, start, end int, data []byte, what string) string {
	ctx.Equal(r.Status, 206, "%s: the status", what)
	ctx.Equal(rangeHeader(r, "Content-Range"), fmt.Sprintf("bytes %d-%d/%d", start, end, len(data)), "%s: Content-Range", what)
	length := end - start + 1
	ctx.Equal(rangeHeader(r, "Content-Length"), strconv.Itoa(length), "%s: Content-Length", what)
	ctx.Assert(bytes.Equal(r.Body, data[start:end+1]), "%s: the body must be exactly bytes %d to %d (%d bytes), got %d bytes that differ", what, start, end, length, len(r.Body))
	ctype := r.Header.Get("Content-Type")
	ctx.Assert(strings.HasPrefix(ctype, "application/octet-stream"), "%s: Content-Type was %q, expected application/octet-stream", what, ctype)
	return rangeCommon(ctx, r, what)
}

func rangeFull(ctx *harness.Ctx, r *harness.Response, data []byte, what string) string {
	ctx.Equal(r.Status, 200, "%s: the status (200 with the whole file)", what)
	ctx.Assert(bytes.Equal(r.Body, data), "%s: the body must be the whole file (%d bytes), got %d bytes", what, len(data), len(r.Body))
	ctx.Equal(rangeHeader(r, "Content-Range"), nil, "%s: a 200 carries no Content-Range", what)
	return rangeCommon(ctx, r, what)
}

func rangeUnsatisfiable(ctx *harness.Ctx, r *harness.Response, size int, what string) string {
	ctx.Equal(r.Status, 416, "%s: the status", what)
	ctx.Equal(rangeHeader(r, "Content-Range"), fmt.Sprintf("bytes */%d", size), "%s: Content-Range", what)
	ctx.Equal(len(r.Body), 0, "%s: a 416 carries no body; its length", what)
	return rangeCommon(ctx, r, what)
}

func CheckPartialContent(ctx *harness.Ctx) {
	c := rangeAPI(ctx)
	whole := c.Get("/files/clip.bin")
	etag := rangeFull(ctx, whole, rangeClip, "GET /files/clip.bin without Range")
	ctype := whole.Header.Get("Content-Type")
	ctx.Assert(strings.HasPrefix(ctype, "application/octet-stream"), "the 200 Content-Type was %q, expected application/octet-stream", ctype)
	head := c.Get("/files/clip.bin", "Range", "bytes=0-99")
	ctx.Equal(rangePartial(ctx, head, 0, 99, rangeClip, "Range: bytes=0-99"), etag, "the 206 must carry the same ETag as the 200")
	rangePartial(ctx, c.Get("/files/clip.bin", "Range", "bytes=100-199"), 100, 199, rangeClip, "Range: bytes=100-199")
	missing := c.Get("/files/ghost.bin", "Range", "bytes=0-99")
	ctx.Equal(missing.Status, 404, "GET /files/ghost.bin")
}

func CheckSuffixAndOpen(ctx *harness.Ctx) {
	c := rangeAPI(ctx)
	for _, tc := range []struct {
		spec       string
		start, end int
	}{
		{"bytes=-100", 900, 999},
		{"bytes=900-", 900, 999},
		{"bytes=-1", 999, 999},
		{"bytes=0-", 0, 999},
		{"bytes=-1000", 0, 999},
		{"bytes=-5000", 0, 999},
	} {
		rangePartial(ctx, c.Get("/files/clip.bin", "Range", tc.spec), tc.start, tc.end, rangeClip, "Range: "+tc.spec+" on 1000 bytes")
	}
}

func CheckClampEnd(ctx *harness.Ctx) {
	c := rangeAPI(ctx)
	for _, tc := range []struct {
		spec       string
		start, end int
	}{
		{"bytes=950-5000", 950, 999},
		{"bytes=500-1000", 500, 999},
		{"bytes=999-999", 999, 999},
		{"bytes=0-999", 0, 999},
	} {
		rangePartial(ctx, c.Get("/files/clip.bin", "Range", tc.spec), tc.start, tc.end, rangeClip, "Range: "+tc.spec+" on 1000 bytes")
	}
}

func CheckUnsatisfiable(ctx *harness.Ctx) {
	c := rangeAPI(ctx)
	for _, spec := range []string{"bytes=1000-", "bytes=1000-1999", "bytes=5000-6000", "bytes=-0"} {
		rangeUnsatisfiable(ctx, c.Get("/files/clip.bin", "Range", spec), 1000, "Range: "+spec+" on 1000 bytes")
	}
	for _, spec := range []string{"bytes=0-", "bytes=-10"} {
		rangeUnsatisfiable(ctx, c.Get("/files/empty.bin", "Range", spec), 0, "Range: "+spec+" on an empty file")
	}
	rangeFull(ctx, c.Get("/files/empty.bin"), rangeEmpty, "GET /files/empty.bin without Range")
	rangePartial(ctx, c.Get("/files/clip.bin", "Range", "bytes=999-"), 999, 999, rangeClip, "Range: bytes=999- (the last byte exists)")
}

func CheckIfRange(ctx *harness.Ctx) {
	c := rangeAPI(ctx)
	old := rangePartial(ctx, c.Get("/files/clip.bin", "Range", "bytes=0-499"), 0, 499, rangeClip, "Range: bytes=0-499")
	same := c.Get("/files/clip.bin", "Range", "bytes=500-", "If-Range", old)
	rangePartial(ctx, same, 500, 999, rangeClip, "Range: bytes=500- with If-Range equal to the current ETag")
	files["clip.bin"] = rangeClipV2
	resumed := c.Get("/files/clip.bin", "Range", "bytes=500-", "If-Range", old)
	fresh := rangeFull(ctx, resumed, rangeClipV2, "after the file changed, Range: bytes=500- with the old ETag in If-Range")
	ctx.Assert(fresh != old, "the file changed but its ETag stayed %s", old)
	current := c.Get("/files/clip.bin", "Range", "bytes=500-", "If-Range", fresh)
	rangePartial(ctx, current, 500, 999, rangeClipV2, "Range: bytes=500- with If-Range equal to the new ETag")
	dated := c.Get("/files/clip.bin", "Range", "bytes=500-", "If-Range", "Wed, 21 Oct 2026 07:28:00 GMT")
	rangeFull(ctx, dated, rangeClipV2, "If-Range carrying an HTTP date")
	weak := c.Get("/files/clip.bin", "Range", "bytes=500-", "If-Range", "W/"+fresh)
	rangeFull(ctx, weak, rangeClipV2, "If-Range: W/"+fresh+" (a weak tag never matches strongly)")
	stale416 := c.Get("/files/clip.bin", "Range", "bytes=5000-", "If-Range", old)
	rangeFull(ctx, stale416, rangeClipV2, "a stale If-Range with an unsatisfiable Range: the Range is ignored, so not 416")
}

func CheckIgnoredRanges(ctx *harness.Ctx) {
	c := rangeAPI(ctx)
	for _, spec := range []string{"bytes=0-9,20-29", "bytes=50-10", "bytes=abc-def", "bytes=-", "bytes=1-2-3", "items=0-9", "0-9"} {
		rangeFull(ctx, c.Get("/files/clip.bin", "Range", spec), rangeClip, "Range: "+spec)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <optional>
#include <regex>
#include <string>

namespace {

// rangeBytes is 1000 bytes, byte i being (i*mul + add) % 256.
std::string rangeBytes(int mul, int add) {
  std::string data(1000, '\\0');
  for (int i = 0; i < 1000; i++) data[i] = static_cast<char>((i * mul + add) % 256);
  return data;
}

const std::string rangeClip = rangeBytes(7, 3);
const std::string rangeClipV2 = rangeBytes(11, 5);
const std::string rangeEmpty;
const std::regex rangeStrong(R"(^"[0-9a-f]{8,64}"$)");

// rangeAPI seeds files with clip.bin and empty.bin and returns a client of the learner's server.
harness::HTTP rangeAPI(harness::Ctx& ctx) {
  files = {{"clip.bin", rangeClip}, {"empty.bin", rangeEmpty}};
  return ctx.Main().HTTP();
}

// rangeHeader is a header's value, or nullopt when the response does not carry it.
std::optional<std::string> rangeHeader(const harness::Response& r, const std::string& name) {
  if (r.Header.find(name) == r.Header.end()) return std::nullopt;
  return r.HeaderValue(name);
}

std::string rangeCommon(harness::Ctx& ctx, const harness::Response& r, const std::string& what) {
  ctx.Equal(rangeHeader(r, "Accept-Ranges"), "bytes", "%s: Accept-Ranges", what);
  const std::string etag = r.HeaderValue("ETag");
  ctx.Assert(std::regex_match(etag, rangeStrong), R"(%s: ETag was %q, expected a strong quoted hex sha256 prefix such as '"9f2c01d4e5b6a7c8"')", what, etag);
  return etag;
}

std::string rangePartial(harness::Ctx& ctx, const harness::Response& r, int start, int end, const std::string& data,
                         const std::string& what) {
  ctx.Equal(r.Status, 206, "%s: the status", what);
  ctx.Equal(rangeHeader(r, "Content-Range"), harness::Sprintf("bytes %d-%d/%d", start, end, data.size()),
            "%s: Content-Range", what);
  const int length = end - start + 1;
  ctx.Equal(rangeHeader(r, "Content-Length"), std::to_string(length), "%s: Content-Length", what);
  ctx.Assert(r.Body == data.substr(start, length), "%s: the body must be exactly bytes %d to %d (%d bytes), got %d bytes that differ", what, start, end, length, r.Body.size());
  const std::string ctype = r.HeaderValue("Content-Type");
  ctx.Assert(ctype.rfind("application/octet-stream", 0) == 0, "%s: Content-Type was %q, expected application/octet-stream", what, ctype);
  return rangeCommon(ctx, r, what);
}

std::string rangeFull(harness::Ctx& ctx, const harness::Response& r, const std::string& data, const std::string& what) {
  ctx.Equal(r.Status, 200, "%s: the status (200 with the whole file)", what);
  ctx.Assert(r.Body == data, "%s: the body must be the whole file (%d bytes), got %d bytes", what, data.size(), r.Body.size());
  ctx.Equal(rangeHeader(r, "Content-Range"), nullptr, "%s: a 200 carries no Content-Range", what);
  return rangeCommon(ctx, r, what);
}

std::string rangeUnsatisfiable(harness::Ctx& ctx, const harness::Response& r, int size, const std::string& what) {
  ctx.Equal(r.Status, 416, "%s: the status", what);
  ctx.Equal(rangeHeader(r, "Content-Range"), harness::Sprintf("bytes */%d", size), "%s: Content-Range", what);
  ctx.Equal(r.Body.size(), 0, "%s: a 416 carries no body; its length", what);
  return rangeCommon(ctx, r, what);
}

struct RangeCase {
  std::string spec;
  int start, end;
};

}  // namespace

void CheckPartialContent(harness::Ctx& ctx) {
  auto c = rangeAPI(ctx);
  auto whole = c.Get("/files/clip.bin");
  const std::string etag = rangeFull(ctx, whole, rangeClip, "GET /files/clip.bin without Range");
  const std::string ctype = whole.HeaderValue("Content-Type");
  ctx.Assert(ctype.rfind("application/octet-stream", 0) == 0, "the 200 Content-Type was %q, expected application/octet-stream", ctype);
  auto head = c.Get("/files/clip.bin", "Range", "bytes=0-99");
  ctx.Equal(rangePartial(ctx, head, 0, 99, rangeClip, "Range: bytes=0-99"), etag, "the 206 must carry the same ETag as the 200");
  rangePartial(ctx, c.Get("/files/clip.bin", "Range", "bytes=100-199"), 100, 199, rangeClip, "Range: bytes=100-199");
  auto missing = c.Get("/files/ghost.bin", "Range", "bytes=0-99");
  ctx.Equal(missing.Status, 404, "GET /files/ghost.bin");
}

void CheckSuffixAndOpen(harness::Ctx& ctx) {
  auto c = rangeAPI(ctx);
  for (const RangeCase& tc : std::initializer_list<RangeCase>{
           {"bytes=-100", 900, 999},
           {"bytes=900-", 900, 999},
           {"bytes=-1", 999, 999},
           {"bytes=0-", 0, 999},
           {"bytes=-1000", 0, 999},
           {"bytes=-5000", 0, 999},
       }) {
    rangePartial(ctx, c.Get("/files/clip.bin", "Range", tc.spec), tc.start, tc.end, rangeClip, "Range: " + tc.spec + " on 1000 bytes");
  }
}

void CheckClampEnd(harness::Ctx& ctx) {
  auto c = rangeAPI(ctx);
  for (const RangeCase& tc : std::initializer_list<RangeCase>{
           {"bytes=950-5000", 950, 999},
           {"bytes=500-1000", 500, 999},
           {"bytes=999-999", 999, 999},
           {"bytes=0-999", 0, 999},
       }) {
    rangePartial(ctx, c.Get("/files/clip.bin", "Range", tc.spec), tc.start, tc.end, rangeClip, "Range: " + tc.spec + " on 1000 bytes");
  }
}

void CheckUnsatisfiable(harness::Ctx& ctx) {
  auto c = rangeAPI(ctx);
  for (const std::string spec : {"bytes=1000-", "bytes=1000-1999", "bytes=5000-6000", "bytes=-0"}) {
    rangeUnsatisfiable(ctx, c.Get("/files/clip.bin", "Range", spec), 1000, "Range: " + spec + " on 1000 bytes");
  }
  for (const std::string spec : {"bytes=0-", "bytes=-10"}) {
    rangeUnsatisfiable(ctx, c.Get("/files/empty.bin", "Range", spec), 0, "Range: " + spec + " on an empty file");
  }
  rangeFull(ctx, c.Get("/files/empty.bin"), rangeEmpty, "GET /files/empty.bin without Range");
  rangePartial(ctx, c.Get("/files/clip.bin", "Range", "bytes=999-"), 999, 999, rangeClip, "Range: bytes=999- (the last byte exists)");
}

void CheckIfRange(harness::Ctx& ctx) {
  auto c = rangeAPI(ctx);
  const std::string old = rangePartial(ctx, c.Get("/files/clip.bin", "Range", "bytes=0-499"), 0, 499, rangeClip, "Range: bytes=0-499");
  auto same = c.Get("/files/clip.bin", "Range", "bytes=500-", "If-Range", old);
  rangePartial(ctx, same, 500, 999, rangeClip, "Range: bytes=500- with If-Range equal to the current ETag");
  files["clip.bin"] = rangeClipV2;
  auto resumed = c.Get("/files/clip.bin", "Range", "bytes=500-", "If-Range", old);
  const std::string fresh = rangeFull(ctx, resumed, rangeClipV2, "after the file changed, Range: bytes=500- with the old ETag in If-Range");
  ctx.Assert(fresh != old, "the file changed but its ETag stayed %s", old);
  auto current = c.Get("/files/clip.bin", "Range", "bytes=500-", "If-Range", fresh);
  rangePartial(ctx, current, 500, 999, rangeClipV2, "Range: bytes=500- with If-Range equal to the new ETag");
  auto dated = c.Get("/files/clip.bin", "Range", "bytes=500-", "If-Range", "Wed, 21 Oct 2026 07:28:00 GMT");
  rangeFull(ctx, dated, rangeClipV2, "If-Range carrying an HTTP date");
  auto weak = c.Get("/files/clip.bin", "Range", "bytes=500-", "If-Range", "W/" + fresh);
  rangeFull(ctx, weak, rangeClipV2, "If-Range: W/" + fresh + " (a weak tag never matches strongly)");
  auto stale416 = c.Get("/files/clip.bin", "Range", "bytes=5000-", "If-Range", old);
  rangeFull(ctx, stale416, rangeClipV2, "a stale If-Range with an unsatisfiable Range: the Range is ignored, so not 416");
}

void CheckIgnoredRanges(harness::Ctx& ctx) {
  auto c = rangeAPI(ctx);
  for (const std::string spec : {"bytes=0-9,20-29", "bytes=50-10", "bytes=abc-def", "bytes=-", "bytes=1-2-3", "items=0-9", "0-9"}) {
    rangeFull(ctx, c.Get("/files/clip.bin", "Range", spec), rangeClip, "Range: " + spec);
  }
}
`,
  },
  debrief: `The handler is a decision in a fixed order: 404, then no \`Range\`, then \`If-Range\`, then the parse. The
order matters at one place: a stale \`If-Range\` with an unsatisfiable range answers 200, not 416, because RFC
9110 §13.1.5 says a false \`If-Range\` makes the server ignore \`Range\` entirely. The parse has three outcomes
and only two of them change the response; everything the server does not understand (another unit, a
malformed spec, \`b < a\`, a list) degrades to the whole file, which is always a correct answer to a GET.

\`If-Range\` exists because the alternative is silent corruption. A client resuming with only \`Range:
bytes=500-\` gets bytes 500 to 999 of whatever is there now, appends them to bytes 0 to 499 of what was there
before, and holds a file that never existed. The strong comparison is the point: a weak ETag says
"semantically the same", which is not "the same bytes at the same offsets", so \`W/\` tags and dates (which
have one-second resolution) never satisfy it here.

Real servers add what this one leaves out: \`multipart/byteranges\` for several ranges (with a cap, since
\`bytes=0-0,0-0,...\` is an amplification attack; Apache's CVE-2011-3192), coalescing overlapping ranges,
\`Last-Modified\` and date-form \`If-Range\` with the one-second rule, \`HEAD\` returning the same headers,
streaming the slice from disk with \`sendfile\` or an object store's own ranged GET, and CDNs that fetch
the whole object once and answer every range from cache.`,
};
