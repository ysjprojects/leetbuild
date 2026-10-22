/**
 * The learning guide for the resumable-stream drill: where resumable uploads come from (tus, GCS),
 * why an Ack is only a lower bound and the server's committed point is the truth, the restart-from-zero
 * and trust-your-acks failures, idempotent chunks keyed by seq, and which status codes earn a backoff.
 * Rendered at `/grpc-resumable-stream/learn`.
 */
export const learn = `# The mechanism at a glance

A **resumable upload** sends a large object as numbered chunks and lets the server keep one number per
upload: its **committed point**, the first chunk it does not yet hold. When the connection fails, the
client does not start again. It asks the server where it is and sends only what is missing. Here the
chunks travel over one bidirectional gRPC stream, and a second, unary call reads the committed point:

:::diagram
{
  "nodes": [
    {"id": "uploader", "kind": "client", "label": "uploader", "sub": "upload(stub, upload_id, chunks) · resume, back off, give up", "x": 20, "y": 50},
    {"id": "ingest", "kind": "grpc", "label": "Ingest", "sub": "ingest.v1 · commits seq n only at next_seq n", "x": 75, "y": 50}
  ],
  "edges": [
    {"from": "uploader", "to": "ingest", "kind": "grpc", "label": "GetStatus · Upload (Chunk ⇄ Ack)"}
  ]
}
:::

The contract the drill implements:

- \`Upload(stream Chunk) returns (stream Ack)\`: \`Chunk{upload_id, seq, data}\` in, \`Ack{seq}\` out, where
  \`Ack.seq\` is the highest contiguous committed seq.
- \`GetStatus(StatusRequest{upload_id}) returns (StatusResponse{next_seq})\`: the committed point, \`0\` for an
  upload the server has never seen.
- \`upload(stub, upload_id, chunks, max_attempts=4)\` returns the attempts it used. Each attempt calls
  \`GetStatus\`, returns at once if \`next_seq == len(chunks)\`, otherwise opens one \`Upload\` stream, sends every
  seq from \`next_seq\` to the last in order, and finishes on the \`Ack\` for the last seq.
- \`UNAVAILABLE\` and \`ABORTED\` wait \`0.1 × 2^(attempt - 1)\` s and try again; after \`max_attempts\` the last error
  is raised. Every other status is raised at once.

# Where resumable uploads come from

Uploads big enough to fail halfway are common: phone videos over a cellular link, database backups,
model checkpoints, log archives. Two widely deployed protocols settle the same question, "where do I
resume?", the same way: the server says.

| | [tus](https://tus.io/protocols/resumable-upload) 1.0 | [GCS resumable upload](https://cloud.google.com/storage/docs/performing-resumable-uploads) | this drill |
|---|---|---|---|
| Start | \`POST\` with \`Upload-Length\` → \`201 Created\`, \`Location\` | \`POST ?uploadType=resumable\` → session URI in \`Location\` | an \`upload_id\` the caller already has |
| Ask where to resume | \`HEAD\` → \`Upload-Offset: n\` | \`PUT\`, empty body, \`Content-Range: bytes */size\` → \`308\` with \`Range: bytes=0-n\` | \`GetStatus\` → \`next_seq\` |
| Send the rest | \`PATCH\` with \`Upload-Offset: n\`, body from byte \`n\` | \`PUT\` with \`Content-Range: bytes n+1-…/size\` | \`Chunk{seq}\` from \`next_seq\` on |
| Wrong position | \`409 Conflict\` | the \`308\` \`Range\` tells you what was kept | gap → \`FAILED_PRECONDITION\`, below → ignored |
| Unit | bytes | bytes, chunks a multiple of 256 KiB | whole chunks, numbered |

- Both use byte offsets; a gRPC stream that carries messages can number messages instead. The seq is the
  offset in units of chunks.
- GCS spells out the lesson of this drill in its own documentation: use the upper value of the \`Range\`
  header to decide where the next chunk starts, and "you should not assume that the server received all
  bytes sent in any given request".
- tus makes the server strict: a \`PATCH\` whose \`Upload-Offset\` does not match the server's offset is
  refused with \`409\`. Strict servers turn a client bug into a loud error instead of a corrupt object.

:::quiz
Q: In tus, what does the client do first after its connection dropped in the middle of a PATCH?
- [ ] Repeat the same PATCH from the offset it started at
- [x] Send HEAD and resume from the Upload-Offset the server returns
- [ ] Start a new upload with POST, since the old one is incomplete
> The server's offset is the only reliable record of what was stored. The interrupted PATCH may have written some, all or none of its body before the connection died; HEAD tells the client which.
:::

# An Ack is a lower bound

The client sees two numbers that look alike: the last \`Ack\` it received and the server's \`next_seq\`.
They differ exactly when it matters. The server commits a chunk, then sends its \`Ack\`. If the stream
dies in between, the commit happened and the \`Ack\` never arrived:

:::sequence
{
  "participants": ["uploader", "Ingest"],
  "messages": [
    {"from": "uploader", "to": "Ingest", "label": "GetStatus(up-1)", "kind": "sync"},
    {"from": "Ingest", "to": "uploader", "label": "next_seq 0", "kind": "reply"},
    {"from": "uploader", "to": "Ingest", "label": "Upload: Chunk 0 … 7", "kind": "async"},
    {"from": "Ingest", "to": "uploader", "label": "Ack 0 … Ack 3", "kind": "reply"},
    {"from": "Ingest", "to": "Ingest", "label": "commit seq 4", "kind": "sync"},
    {"from": "Ingest", "to": "uploader", "label": "UNAVAILABLE (no Ack 4)", "kind": "reply"},
    {"from": "uploader", "to": "uploader", "label": "sleep 0.1 s", "kind": "sync"},
    {"from": "uploader", "to": "Ingest", "label": "GetStatus(up-1)", "kind": "sync"},
    {"from": "Ingest", "to": "uploader", "label": "next_seq 5", "kind": "reply"},
    {"from": "uploader", "to": "Ingest", "label": "Upload: Chunk 5 … 7", "kind": "async"},
    {"from": "Ingest", "to": "uploader", "label": "Ack 5 … Ack 7", "kind": "reply"},
    {"from": "uploader", "to": "Ingest", "label": "close send · return 2", "kind": "async"}
  ]
}
:::

- The last \`Ack\` said 3. The truth was 4. Nothing the client holds can tell it so: only the server knows
  what it committed.
- The reverse error cannot happen in this protocol, because the server acks only after it commits. An
  \`Ack\` is never ahead of the store, so it is a safe lower bound and an unsafe resume point.
- The extreme case is the final chunk: all eight committed, the \`Ack\` for seq 7 lost with the stream.
  \`GetStatus\` answers \`next_seq 8\`, which equals \`len(chunks)\`: there is nothing to send, and the attempt
  that asked is the one that succeeded. Opening a stream anyway would send nothing and wait for an
  \`Ack\` the server has no reason to send.

The cost of asking is one unary round trip per attempt, paid only after a failure (and once at the
start). The cost of not asking is the subject of the next section.

:::quiz
Q: The last Ack your client received says seq 3. GetStatus says next_seq 5. Which chunk does the next stream start with?
- [ ] 4, the one after the last Ack
- [x] 5, the server's next_seq
- [ ] 0, to be safe
> The server committed 4 and lost the Ack with the stream. next_seq is the committed point itself; the last Ack is only a lower bound on it.
:::

# Restarting from zero, and trusting your own count

Two plausible clients get resumption wrong in opposite directions. The first throws away progress and
starts every attempt at seq 0. On a link that drops every stream after five chunks, it never gets past
seq 4:

:::sequence
{
  "participants": ["uploader", "Ingest"],
  "messages": [
    {"from": "uploader", "to": "Ingest", "label": "attempt 1 · Chunk 0 … 4", "kind": "async"},
    {"from": "Ingest", "to": "uploader", "label": "UNAVAILABLE (link drops)", "kind": "reply"},
    {"from": "uploader", "to": "Ingest", "label": "attempt 2 · Chunk 0 … 4 again", "kind": "async"},
    {"from": "Ingest", "to": "uploader", "label": "UNAVAILABLE", "kind": "reply"},
    {"from": "uploader", "to": "Ingest", "label": "attempts 3, 4 · the same", "kind": "async"},
    {"from": "Ingest", "to": "uploader", "label": "UNAVAILABLE · UNAVAILABLE", "kind": "reply"},
    {"from": "uploader", "to": "uploader", "label": "raise: 20 sent, seq 5 never reached", "kind": "sync"}
  ]
}
:::

- Every attempt re-pays for everything before the failure. The same link and a client that resumes
  finish in two attempts: 0 to 4, then 5 to 7. If a link drops every 4 GB, a 10 GB upload that restarts
  from zero never completes; one that resumes finishes in three attempts.
- On a server that is not idempotent, the resent chunks are also a correctness bug: appended twice, the
  object is corrupt.

The second client counts its own \`Ack\`s and resumes from the last one plus one, never calling
\`GetStatus\` again. It works until an \`Ack\` is lost, then resends a committed chunk:

| 0 to 4 committed, Ack 4 lost | Next stream starts at | Resends | Skips |
|---|---|---|---|
| restart from zero | 0 | 0, 1, 2, 3, 4 | none |
| trust the last Ack (3) | 4 | 4 | none |
| \`GetStatus\` (\`next_seq\` 5) | 5 | none | none |
| a buggy "last sent + 1" | 8 | none | 5, 6, 7 |

The last row is the mirror image: a client that resumes from what it *sent*, not what was *acked*,
skips chunks that were in flight when the stream died. A strict server refuses the gap with
\`FAILED_PRECONDITION\`; a lenient one stores a hole. Only the server's number is neither too low nor too
high.

:::quiz
Q: Why can a client that resumes from its last received Ack still resend data?
- [ ] Because gRPC delivers Acks out of order
- [x] Because the server may have committed a chunk whose Ack was lost with the stream
- [ ] Because Acks are only sent every few chunks
> Acks are in order and one per chunk here. The gap is between commit and Ack: the stream can fail after the first and before the second, so the client's count lags the server's.
:::

# At-least-once on the wire, exactly-once in the store

Retries make delivery at-least-once: after a failure the client cannot know which of its in-flight
chunks arrived, so some will arrive twice across attempts. The server turns that into exactly-once
storage by treating the seq as an idempotency key and keeping one rule:

\`\`\`text
on Chunk{upload_id, seq}:
  expected = committed[upload_id]            # 0 for a new upload
  seq == expected → store, committed = seq + 1, Ack{seq}
  seq <  expected → already stored: ignore, Ack{expected - 1}
  seq >  expected → a gap: refuse with FAILED_PRECONDITION
\`\`\`

| Chunk arrives | Server holds 0 to 4 (\`next_seq\` 5) | Ack | Stored |
|---|---|---|---|
| seq 5 | the next one | \`Ack{5}\` | 0 to 5 |
| seq 4 | a duplicate | \`Ack{4}\`, unchanged | 0 to 4 |
| seq 7 | a gap (5 and 6 missing) | stream ends \`FAILED_PRECONDITION\` | 0 to 4 |

- **Contiguous commits** are what make one number enough. If the server accepted chunks out of order,
  its state would be a set, and the status call would have to return it. S3 multipart uploads work
  that way: parts are independent, and \`ListParts\` returns which ones exist.
- **Acks carry the committed point**, not the seq just received, so a duplicate is answered with
  the same number as before and the client's view only ever moves forward.
- **Idempotent chunks** mean the client may be careless about duplicates without corrupting the object.
  The drill still forbids resending below \`next_seq\`: it is wasted bandwidth, and it hides the
  difference between a client that asks and a client that guesses.

:::details Why refuse a gap instead of buffering it?
A server could hold seq 7 aside until 5 and 6 arrive. That buys little on one ordered stream, where a
gap can only mean the client skipped, and it costs memory per upload plus a rule for when to give up on
the missing chunks. Refusing keeps the server's state one integer and makes the client's bug visible on
the first attempt. Systems with parallel parts (S3, GCS composite objects) accept out-of-order data and
pay for it with a list of parts and a final "complete" call.
:::

:::quiz
Q: A client resends seq 3 to a server whose next_seq is 6. What should the server do?
- [ ] Overwrite chunk 3 with the new bytes
- [x] Ignore it and ack its committed point, seq 5
- [ ] End the stream with FAILED_PRECONDITION
> Below the committed point a chunk is a duplicate, the normal by-product of at-least-once delivery. Acking the committed point keeps the upload moving; overwriting would make a retry change stored data.
:::

# Backoff, and which codes earn one

A stream fails for reasons a retry can fix and reasons it cannot. The [gRPC status code
guide](https://grpc.io/docs/guides/status-codes/) is explicit about the two the drill retries:

| Status | Meaning | Retry? |
|---|---|---|
| \`UNAVAILABLE\` | the service is unreachable or restarting; "most likely a transient condition" | yes, with backoff |
| \`ABORTED\` | the operation was aborted, typically a concurrency conflict; retry at a higher level | yes, as a new attempt from \`GetStatus\` |
| \`INVALID_ARGUMENT\` | the request is wrong (a bad \`upload_id\`, a chunk too large) | no: it fails the same way again |
| \`PERMISSION_DENIED\` | the caller may not write this upload | no |
| \`FAILED_PRECONDITION\` | the server refused a gap | no: the client has a bug |

\`ABORTED\` fits a resumable upload well: the server can abort a stream when a second writer appears for
the same upload, and the right response is to re-read the committed point and continue, which is
exactly what a fresh attempt does.

The wait doubles from 0.1 s, and there is no wait after the last attempt:

\`\`\`text
attempt 1 fails → sleep 0.1 s
attempt 2 fails → sleep 0.2 s
attempt 3 fails → sleep 0.4 s
attempt 4 fails → raise that error (max_attempts = 4)
\`\`\`

- The \`GetStatus\` calls of four attempts land at 0, 0.1, 0.3 and 0.7 s. The total wait is bounded by
  \`0.1 × (2^(max_attempts - 1) - 1)\` s, 0.7 s here.
- The error raised is the last one, with its details. A caller deciding whether to alert, or to retry
  later at a higher level, needs the status that actually ended the upload.
- Attempts that make progress still count. A link that fails after every chunk exhausts four attempts
  after four chunks; an uploader meant for such links can reset the counter whenever \`next_seq\` moved, so
  that only attempts without progress are bounded.

:::widget deadline-retry {"base": 100, "deadline": 2000, "attempts": 4}

Production clients add jitter, a random fraction of each wait, so that a thousand uploaders cut off by
the same server restart do not all return in the same millisecond. The drill leaves it out because it
makes the schedule untestable to the millisecond; the shape is the same.

:::quiz
Q: Attempt 4 of 4 fails with UNAVAILABLE. What does upload do?
- [ ] Sleep 0.8 s, then raise
- [x] Raise that UNAVAILABLE at once
- [ ] Try a fifth time, since UNAVAILABLE is transient
> The backoff exists to space out attempts. After the last allowed attempt there is nothing to space out, so waiting only delays the caller's own error handling.
:::

# What to take away

- The server's committed point is the only resume position that is never too low and never too high:
  ask for it at the start of every attempt.
- An \`Ack\` is a lower bound. A stream can die between a commit and its \`Ack\`, most visibly on the last
  chunk, where the right next step is to send nothing.
- Seq numbers make chunks idempotent: duplicates are ignored, gaps are refused, and at-least-once
  delivery becomes exactly-once storage.
- Retry only what a retry can fix (\`UNAVAILABLE\`, \`ABORTED\`), with exponential backoff, a hard cap on
  attempts, and the last error raised as it was.
- Real uploaders add per-chunk checksums, jitter, expiring sessions and chunk sizes aligned to the
  server's granularity.

Primary reference: Google Cloud Storage, [Perform resumable uploads](https://cloud.google.com/storage/docs/performing-resumable-uploads).
`;
