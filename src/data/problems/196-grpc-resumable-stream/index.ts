import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {protoFiles, protoModules} from './proto';
import {resumableUploadStep} from './steps/1-resumable-upload';

/**
 * Drill: a client that uploads over a bidirectional gRPC stream and, when the stream dies, asks the
 * server for its committed point and resumes from there, with bounded exponential backoff.
 */
export const grpcResumableStreamProblem: Problem = {
  id: 'grpc-resumable-stream',
  title: 'A resumable gRPC upload stream',
  tagline:
    'Upload over a bidi stream, and after UNAVAILABLE or ABORTED resume from GetStatus.next_seq: no gaps, no resends, no restart from 0, bounded backoff.',
  difficulty: 'hard',
  concepts: ['grpc'],
  minutes: 40,
  statement: `# A resumable gRPC upload stream

A large upload over one long stream will meet a dropped connection, a server restart or a load
balancer draining. Starting over from byte 0 each time turns a flaky link into an upload that never
finishes. A **resumable upload** gives every chunk a position and keeps the server's **committed
point**: after a failure the client asks where the server is and sends only what is missing. That is
the contract of the [tus](https://tus.io/protocols/resumable-upload) protocol (\`HEAD\` answers
\`Upload-Offset\`), of Google Cloud Storage resumable uploads (a status \`PUT\` answers \`308\` with a
\`Range\` header) and of streaming ingest APIs that carry a sequence number per chunk.

The key fact: a stream can die after the server committed a chunk and before its acknowledgement
arrived. The client's last ack is therefore a lower bound; the server's status is the truth.

The service is \`ingest.v1.Ingest\` in \`ingest.proto\`:

- \`rpc Upload(stream Chunk) returns (stream Ack)\`: \`Chunk{upload_id, seq (int32), data (bytes)}\` in,
  \`Ack{seq}\` out, where \`seq\` is the highest contiguous committed seq.
- \`rpc GetStatus(StatusRequest{upload_id}) returns (StatusResponse{next_seq})\`: the committed point, \`0\`
  for a new upload.

The surface is one function, \`upload(stub, upload_id, chunks, max_attempts=4)\`, returning the number of
attempts it used. Retry \`UNAVAILABLE\` and \`ABORTED\` after \`0.1 × 2^(attempt - 1)\` s; raise anything else
at once, and the last error after \`max_attempts\`.

## What you build here

1. \`upload\`: per attempt, \`GetStatus\`, then one \`Upload\` stream carrying every seq from \`next_seq\` to the
   last, in order, finished on the \`Ack\` for the last seq; bounded exponential backoff between attempts.

## Left out on purpose

Creating the upload and choosing its id, per-chunk checksums, jitter on the backoff, retrying a failed
\`GetStatus\` itself, deadlines on the stream, uploading parts in parallel, and the server side, which the
harness plays.`,
  diagram: {
    nodes: [
      {id: 'uploader', kind: 'client', label: 'uploader', sub: 'upload(stub, upload_id, chunks)', x: 20, y: 50},
      {id: 'ingest', kind: 'grpc', label: 'Ingest', sub: 'ingest.v1 · committed point per upload', x: 75, y: 50},
    ],
    edges: [{from: 'uploader', to: 'ingest', kind: 'grpc', label: 'GetStatus · Upload (Chunk ⇄ Ack)'}],
  },
  support: {python: protoModules, typescript: protoFiles, go: protoFiles, cpp: protoFiles},
  steps: [resumableUploadStep],
  learn,
};
