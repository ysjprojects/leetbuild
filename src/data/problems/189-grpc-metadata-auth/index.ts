import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {protoFiles, protoModules} from './proto';
import {metadataAuthStep} from './steps/1-metadata-auth';

/**
 * Drill: a gRPC server that authenticates and authorizes every call from its `authorization`
 * metadata, in the order that keeps an anonymous caller from learning which notes exist.
 */
export const grpcMetadataAuthProblem: Problem = {
  id: 'grpc-metadata-auth',
  title: 'gRPC auth from metadata',
  tagline:
    'Bearer token in metadata: UNAUTHENTICATED for bad credentials, PERMISSION_DENIED for a missing scope, both before the request is looked at.',
  difficulty: 'easy',
  concepts: ['grpc'],
  minutes: 15,
  statement: `# gRPC auth from metadata

A gRPC call carries its credentials in **metadata**, the HTTP/2 headers beside the message:
\`authorization: Bearer <token>\`. The server answers two questions before it does any work. Who is
calling? A missing, malformed or unknown token is \`UNAUTHENTICATED\`. May they do this? A known token
without the needed scope is \`PERMISSION_DENIED\`. Only then does it validate the request and look anything
up, so a caller without credentials never learns whether a note exists. Every gRPC API behind a bearer
token works this way, from Google Cloud to internal services behind a mesh, usually in a server
interceptor.

The surface is \`notes.v1.Notes\` in \`proto/notes.proto\`: \`GetNote(GetNoteRequest{id}) → Note{id, text}\`
(scope \`notes.read\`) and \`DeleteNote(DeleteNoteRequest{id}) → DeleteNoteResponse{deleted}\` (scope
\`notes.write\`), over a module-level store \`NOTES\` (id → text). \`TOKENS\` grants \`reader-7f3a\` the scope
\`notes.read\` and \`admin-91c2\` both scopes. An empty id is \`INVALID_ARGUMENT\`, a missing note \`NOT_FOUND\`.

## What you build here

1. The \`Notes\` server: one helper that reads \`authorization\` and answers \`UNAUTHENTICATED\` or
   \`PERMISSION_DENIED\`, called first in both handlers, then validation, then the lookup.

## Left out on purpose

Signed tokens (JWT verification against a JWKS, expiry, audience), token refresh, mutual TLS, per-note
ownership, constant-time comparison, audit logging of denials, and server interceptors, which this
runtime does not run.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Callers', sub: 'authorization: Bearer <token>', x: 22, y: 50},
      {
        id: 'notes',
        kind: 'grpc',
        label: 'notes.v1.Notes',
        sub: 'authenticate · authorize · validate · look up',
        x: 70,
        y: 50,
      },
    ],
    edges: [{from: 'client', to: 'notes', kind: 'grpc', label: 'GetNote · DeleteNote + metadata'}],
  },
  support: {python: protoModules, typescript: protoFiles, go: protoFiles, cpp: protoFiles},
  steps: [metadataAuthStep],
  learn,
};
