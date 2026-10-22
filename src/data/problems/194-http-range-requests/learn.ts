/**
 * The learning guide for the range-requests drill: why byte ranges exist, the Range grammar, 206 and 416,
 * If-Range and the corrupted resume it prevents, multipart/byteranges, and ranges behind a CDN. Rendered at
 * `/http-range-requests/learn`.
 */
export const learn = `# The mechanism at a glance

A **range request** asks for part of a representation instead of all of it. The client sends
\`Range: bytes=500-999\`; a server that supports ranges answers **206 Partial Content** with exactly those
bytes and a \`Content-Range\` header saying where they sit in the whole. It is what lets a download resume
after a dropped connection, a video player jump to minute 40, and a PDF viewer fetch page 300 without
the 299 before it. The rules are RFC 9110 §14.

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Downloader · video player", "sub": "Range · If-Range", "x": 22, "y": 50},
    {"id": "service", "kind": "service", "label": "files_api", "sub": "GET /files/{name} · FILES · 200 / 206 / 416", "x": 72, "y": 50}
  ],
  "edges": [
    {"from": "client", "to": "service", "kind": "http", "label": "GET · Range: bytes=a-b · If-Range: ETag"}
  ]
}
:::

The contract the drill implements:

- \`GET /files/{name}\` serves bytes from the module-level \`FILES\`; an unknown name is **404**.
- Every 200, 206 and 416 carries \`Accept-Ranges: bytes\` and a strong \`ETag\` (a quoted sha256 prefix);
  bodies are \`application/octet-stream\`.
- One satisfiable range → **206**, \`Content-Range: bytes a-b/len\`, \`Content-Length\` the slice length.
- An unsatisfiable range → **416**, \`Content-Range: bytes */len\`.
- A malformed range, another unit, several ranges, or an \`If-Range\` that is not the current ETag →
  **200** with the whole file.

# Why ranges exist

A GET without a range is all or nothing. That is fine for a 4 KB JSON document and wasteful for anything
large or anything read out of order:

| Use | What the client sends | Why the whole body is wrong |
|---|---|---|
| Resuming a download | \`bytes=734003200-\` after 700 MB arrived | re-sending 700 MB the client already holds |
| Seeking in a video | \`bytes=0-\`, then \`bytes=52428800-\` on a seek | the player wants minute 40 now, not after 39 minutes of bytes |
| Parallel download | four requests, each a quarter of the file | one connection is slower than four on a long, lossy path |
| Reading a file format | the footer first (\`bytes=-65536\`), then the parts it indexes | a ZIP central directory or a Parquet footer sits at the end |

The server advertises support with \`Accept-Ranges: bytes\`. A client that sees it on the first response
knows a later range request is worth trying; \`Accept-Ranges: none\` says it is not.

A video seek is the everyday case:

:::sequence
{
  "participants": ["Player", "files_api"],
  "messages": [
    {"from": "Player", "to": "files_api", "label": "GET /files/talk.mp4 · Range: bytes=0-", "kind": "sync"},
    {"from": "files_api", "to": "Player", "label": "206 · Content-Range: bytes 0-99999999/100000000 · Accept-Ranges: bytes", "kind": "reply"},
    {"from": "Player", "to": "Player", "label": "user drags to 40:00 · index says offset 52428800", "kind": "sync"},
    {"from": "Player", "to": "files_api", "label": "GET · Range: bytes=52428800-", "kind": "sync"},
    {"from": "files_api", "to": "Player", "label": "206 · Content-Range: bytes 52428800-99999999/100000000", "kind": "reply"}
  ]
}
:::

- The first request asks for \`bytes=0-\` rather than nothing: the answer is the whole file, but as a 206
  it also confirms that ranges work and states the total length.
- The player closes the first connection when it seeks. Nothing on the server tracks "where the client
  is": each request names its bytes and stands alone.

:::quiz
Q: Why does a resumable download need the total length in Content-Range rather than just the slice?
- [ ] Because Content-Length is not allowed on a 206
- [x] Because the client has to know when it is done and how far a later request may ask
- [ ] Because the total length doubles as the ETag
> Content-Length describes the body of this response only. The \`/len\` in \`bytes a-b/len\` is the size of the whole representation, which is what a downloader compares against to decide whether to ask for more.
:::

# The grammar

A \`Range\` header names a unit and one or more range specs. The drill supports the one unit everyone
uses, \`bytes\`, and three forms of a spec. Positions are zero-based and **inclusive** at both ends:
\`bytes=0-99\` is 100 bytes.

| Header on a 1000-byte file | Form | Outcome |
|---|---|---|
| \`bytes=0-99\` | first-last | 206 \`bytes 0-99/1000\`, 100 bytes |
| \`bytes=950-5000\` | first-last, past the end | 206 \`bytes 950-999/1000\`: the last position is clamped |
| \`bytes=900-\` | first, open-ended | 206 \`bytes 900-999/1000\` |
| \`bytes=-100\` | suffix | 206 \`bytes 900-999/1000\`: the last 100 bytes |
| \`bytes=-5000\` | suffix longer than the file | 206 \`bytes 0-999/1000\`: the whole file |
| \`bytes=1000-\` | first at or past the end | 416 \`bytes */1000\` |
| \`bytes=-0\` | empty suffix | 416 \`bytes */1000\` |
| \`bytes=50-10\` | last before first | invalid: ignored, 200 |
| \`items=0-9\`, \`0-9\`, \`bytes=abc-def\` | another unit, no unit, not digits | ignored, 200 |

Three rules are hidden in that table:

- **Clamping is the server's job.** A client asking for \`950-5000\` usually does not know the length yet;
  RFC 9110 §14.1.2 says a last position past the end means "to the end".
- **A suffix counts from the end.** \`bytes=-n\` is the only way to ask for the tail of a file whose
  length the client does not know, which is exactly what a ZIP or Parquet reader needs.
- **Invalid is not the same as unsatisfiable.** \`50-10\` is a malformed spec, so the server may treat
  the header as if it were absent. \`1000-\` is well formed and simply asks for bytes that do not exist,
  and that is what 416 reports.

The parse fits in a dozen lines:

\`\`\`text
require "bytes=" prefix, no ","            else ignore
match ^([0-9]*)-([0-9]*)$, not both empty   else ignore
suffix n:   n == 0 or len == 0             → 416
            start = max(0, len - n), end = len - 1
first a:    b given and b < a              → ignore
            end = b or len - 1
            start >= len                    → 416
            end = min(end, len - 1)         → 206
\`\`\`

:::quiz
Q: A 1000-byte file receives Range: bytes=990-2000. What is the answer?
- [ ] 416, because 2000 is past the end
- [x] 206 with Content-Range: bytes 990-999/1000 and 10 bytes
- [ ] 200 with the whole file, because the range is malformed
> The first position exists, so the range is satisfiable. A last position past the end is clamped to len - 1; only a first position at or beyond the end makes a range unsatisfiable.
:::

# 206 and 416

A satisfiable range turns a 200 into a 206 and changes three headers. The rest stays as it would be on
the full response:

\`\`\`text
HTTP/1.1 206 Partial Content
Accept-Ranges: bytes
ETag: "9f2c01d4e5b6a7c8"
Content-Type: application/octet-stream
Content-Range: bytes 100-199/1000
Content-Length: 100

<bytes 100 to 199>
\`\`\`

- \`Content-Range\` says which bytes these are and how many exist in total.
- \`Content-Length\` is the length of **this** body, 100, not 1000. A server that copies the file's
  length into it hangs the client waiting for 900 bytes that never come.
- The \`ETag\` is the ETag of the **whole** representation. Every slice of one version carries the same
  tag, which is what lets a client check that slices fetched minutes apart belong together.

An unsatisfiable range is **416 Range Not Satisfiable**, with the length the client was missing:

\`\`\`text
HTTP/1.1 416 Range Not Satisfiable
Accept-Ranges: bytes
ETag: "9f2c01d4e5b6a7c8"
Content-Range: bytes */1000
Content-Length: 0
\`\`\`

The \`*\` means "no range"; the \`/1000\` tells the client the real size so it can correct itself. A
downloader that already has all 1000 bytes and asks for \`bytes=1000-\` gets exactly this, and treats it
as "you are done". An empty file is the corner every range lands in: no position exists, so \`bytes=0-\`
and \`bytes=-10\` are both 416 \`bytes */0\`, while a plain GET is a 200 with an empty body.

When the server ignores a range it does not send a 206 with the whole file; it sends the response it
would have sent without the header, a 200. Answering 200 to a range request is always allowed: RFC 9110
§14.2 lets a server ignore \`Range\` entirely, and every client has to cope with that.

:::quiz
Q: A client sends Range: bytes=-0. What should it get?
- [ ] 206 with an empty body and Content-Range: bytes 1000-999/1000
- [ ] 200 with the whole file, because a zero suffix is malformed
- [x] 416 with Content-Range: bytes */1000
> A suffix of zero is well formed but selects no bytes. A 206 cannot describe an empty range (first must not exceed last), so the honest answer is 416 with the total length.
:::

# If-Range: never stitch two versions

A resumed download is a request that depends on state the client holds: the first half of a file. If
the file changed in between, the second half belongs to a different file. Without a guard, the server
cannot tell:

:::sequence
{
  "participants": ["Downloader", "files_api", "Publisher"],
  "messages": [
    {"from": "Downloader", "to": "files_api", "label": "GET /files/clip.bin · Range: bytes=0-", "kind": "sync"},
    {"from": "files_api", "to": "Downloader", "label": "206 · bytes 0-999/1000 · ETag \\"a1\\" · connection drops at 500", "kind": "reply"},
    {"from": "Publisher", "to": "files_api", "label": "replace clip.bin (v2, ETag \\"b7\\")", "kind": "sync"},
    {"from": "Downloader", "to": "files_api", "label": "GET · Range: bytes=500-  (no If-Range)", "kind": "sync"},
    {"from": "files_api", "to": "Downloader", "label": "206 · bytes 500-999/1000 of v2", "kind": "reply"},
    {"from": "Downloader", "to": "Downloader", "label": "v1[0..499] + v2[500..999]: a file that never existed", "kind": "sync"}
  ]
}
:::

Same length, same name, status 206 both times: nothing in the exchange looks wrong. The checksum fails
later, if there is one; otherwise an installer, an archive or a video is corrupt with no trace of why.
\`If-Range\` (RFC 9110 §13.1.5) makes the range conditional on the version:

:::sequence
{
  "participants": ["Downloader", "files_api"],
  "messages": [
    {"from": "Downloader", "to": "files_api", "label": "GET · Range: bytes=500- · If-Range: \\"a1\\"", "kind": "sync"},
    {"from": "files_api", "to": "files_api", "label": "\\"a1\\" ≠ \\"b7\\": ignore Range", "kind": "sync"},
    {"from": "files_api", "to": "Downloader", "label": "200 · ETag \\"b7\\" · v2 whole", "kind": "reply"},
    {"from": "Downloader", "to": "Downloader", "label": "discard the 500 bytes of v1, keep v2", "kind": "sync"}
  ]
}
:::

- **One round trip either way.** "Send me the rest if it is still \`"a1"\`, otherwise send me everything".
  \`If-Match\` would answer 412 on a change and cost a second request.
- **Strong comparison only.** A weak ETag (\`W/"a1"\`) promises the same meaning, not the same bytes at the
  same offsets, so it can never validate a byte range. The drill's ETag is strong, and a \`W/\` value in
  \`If-Range\` never matches it.
- **Dates count as no match here.** RFC 9110 allows an HTTP date in \`If-Range\`, compared with
  \`Last-Modified\`, and only when that date is strong (at least a second older than the response's
  \`Date\`). The drill sends no \`Last-Modified\`, so a date never matches and the client gets the whole file:
  safe, just less efficient.
- **The guard comes first.** A stale \`If-Range\` with an unsatisfiable range is a 200, not a 416, because a
  false \`If-Range\` means the \`Range\` header is ignored before anyone looks at it.

:::quiz
Q: A client resumes with Range: bytes=500- and If-Range carrying the ETag it saw yesterday. The file changed overnight. What does the server send?
- [ ] 412 Precondition Failed, so the client can restart
- [ ] 206 with bytes 500 to the end of the new file
- [x] 200 with the whole new file and its new ETag
> If-Range is a fallback, not a failure: when the validator does not match, the server ignores Range and answers as for a plain GET. The client replaces what it had and is done in one request.
:::

# Several ranges and multipart/byteranges

\`Range: bytes=0-9,20-29\` asks for two pieces at once. The standard answer is a 206 whose body is a
\`multipart/byteranges\` document, one part per range, each with its own \`Content-Range\`:

\`\`\`text
HTTP/1.1 206 Partial Content
Content-Type: multipart/byteranges; boundary=3d6b6a416f9b5

--3d6b6a416f9b5
Content-Type: application/octet-stream
Content-Range: bytes 0-9/1000

<10 bytes>
--3d6b6a416f9b5
Content-Type: application/octet-stream
Content-Range: bytes 20-29/1000

<10 bytes>
--3d6b6a416f9b5--
\`\`\`

The drill makes the documented choice not to: a request with several ranges gets a 200 with the whole
file. That is allowed, and it is common, for three reasons:

- **Few clients ask.** Download managers and players use one range at a time; parallel downloaders open
  several connections, each with one range.
- **Many ranges are an attack surface.** In 2011 a header listing hundreds of overlapping ranges made
  Apache build a separate part for each and exhaust memory
  ([CVE-2011-3192](https://nvd.nist.gov/vuln/detail/CVE-2011-3192)). RFC 9110 §14.2 now lets a server
  ignore or reject overlapping or many small unordered ranges.
- **Caches handle single ranges far better.** A multipart body is a new representation with its own
  boundary; a single range is a slice of one the cache already knows.

| Request | Drill's answer | A full implementation |
|---|---|---|
| \`bytes=0-9,20-29\` | 200, whole file | 206 \`multipart/byteranges\`, two parts |
| \`bytes=0-9,5-15\` (overlap) | 200, whole file | may coalesce to \`0-15\` and send one part |
| \`bytes=0-0,0-0,...\` × 500 | 200, whole file | must cap or ignore, or it is the CVE above |

:::quiz
Q: Why is answering 200 with the whole file a correct response to Range: bytes=0-9,20-29?
- [x] A server may always ignore Range; the client has to handle a 200 anyway
- [ ] Because a 206 can only ever carry one range
- [ ] Because two ranges are unsatisfiable by definition
> Range is an optimisation the server is free to decline. A 206 can carry several ranges as multipart/byteranges, but nothing obliges the server to build one, and declining is the safer default.
:::

# Ranges behind a CDN

Most large files reach users through a CDN, so the origin's range support is mostly exercised by the CDN,
not by the player:

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Players", "sub": "Range: bytes=52428800-", "x": 15, "y": 50},
    {"id": "cdn", "kind": "external", "label": "CDN edge", "sub": "cache · slices · answers ranges", "x": 50, "y": 50},
    {"id": "service", "kind": "service", "label": "files_api (origin)", "sub": "206 · ETag per version", "x": 85, "y": 50}
  ],
  "edges": [
    {"from": "client", "to": "cdn", "kind": "http", "label": "any range"},
    {"from": "cdn", "to": "service", "kind": "http", "label": "whole object or fixed slices"}
  ]
}
:::

- **On a miss, the edge picks what to fetch.** Some fetch the whole object, cache it, and cut every
  later range from the cached copy; the first viewer waits for the start of the object to arrive.
- **Large objects go in fixed slices.** nginx's
  [slice module](https://nginx.org/en/docs/http/ngx_http_slice_module.html) turns any client range into
  requests for aligned pieces of a fixed size (\`slice 1m;\` in its example), caches each piece under its own
  key, and assembles the answer. A seek into a 4 GB file pulls a few megabytes, not 4 GB.
- **Slices must agree on a version.** An object assembled from slices fetched at different times has the
  same problem as the resumed download, so the edge compares each slice's ETag with the first one's and
  refuses a mismatch. A stable, strong ETag per version is what makes that check possible; a tag that
  changes on every response (a timestamp, a per-host inode) defeats it.
- **The origin's correctness still matters.** A wrong \`Content-Range\`, a \`Content-Length\` of the whole
  file on a 206, or a 206 that ignores a stale validator is cached and served to everyone behind that edge.

:::quiz
Q: A CDN fetches a 4 GB video from the origin in 1 MB slices. Why does each slice's ETag matter?
- [ ] It is the cache key for the slice
- [x] The edge checks that every slice belongs to the same version before assembling them
- [ ] The CDN forwards it to the player as If-Range
> Slices fetched minutes apart are the CDN's own resumed download. If the origin published a new version in between, the ETags differ and the edge refetches instead of serving a stitched file.
:::

# What to take away

- **A range request names bytes, inclusive, zero-based.** \`bytes=a-b\`, \`bytes=a-\` and \`bytes=-n\`; the
  last position clamps to \`len - 1\`, and a suffix longer than the file is the whole file.
- **206 carries the slice; 416 carries the truth.** \`Content-Range: bytes a-b/len\` with a
  \`Content-Length\` of the slice, or \`bytes */len\` when no requested byte exists.
- **Anything doubtful is a 200.** Malformed specs, other units and several ranges are ignored, and the
  whole file is always a correct answer to a GET.
- **If-Range keeps a resume honest.** A strong ETag match gets the rest; anything else (another tag, a
  \`W/\` tag, a date without \`Last-Modified\`) gets the whole new file, so two versions are never stitched.
- **Strong, stable ETags are the contract** that lets clients, caches and CDNs fetch a file in pieces.

The primary reference is [RFC 9110 §14, Range Requests](https://www.rfc-editor.org/rfc/rfc9110#section-14),
with [§13.1.5, If-Range](https://www.rfc-editor.org/rfc/rfc9110#section-13.1.5); MDN's
[HTTP range requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Range_requests) is a readable
walkthrough.
`;
