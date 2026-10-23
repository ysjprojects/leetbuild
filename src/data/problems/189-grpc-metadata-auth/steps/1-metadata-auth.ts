import type {Step} from '@/lib/types';

// ---- 1. Authenticate and authorize every call from its metadata ----------------------------------
export const metadataAuthStep: Step = {
  id: 'metadata-auth',
  title: 'Authenticate from metadata, then authorize, then look',
  concept: 'grpc',
  file: 'notes_server',
  focus: ['client', 'notes'],
  task: `## Task

Serve \`notes.v1.Notes\` and decide every call from its **metadata** before the request is looked at:

\`\`\`proto
service Notes {
  rpc GetNote(GetNoteRequest) returns (Note);                      // scope notes.read
  rpc DeleteNote(DeleteNoteRequest) returns (DeleteNoteResponse);  // scope notes.write
}
message GetNoteRequest     { string id = 1; }
message Note               { string id = 1; string text = 2; }
message DeleteNoteRequest  { string id = 1; }
message DeleteNoteResponse { bool deleted = 1; }
\`\`\`

The module keeps two stores: \`NOTES\` (id → text, seeded by whoever runs the server) and \`TOKENS\`:

| token | scopes |
|---|---|
| \`reader-7f3a\` | \`notes.read\` |
| \`admin-91c2\` | \`notes.read\`, \`notes.write\` |

Every call runs four gates, in this order:

1. **Authenticate.** Read the metadata key \`authorization\`; it must be \`Bearer <token>\` with a token in
   \`TOKENS\`. Missing, without the \`Bearer \` prefix, or unknown → **\`UNAUTHENTICATED\`**.
2. **Authorize.** \`GetNote\` needs \`notes.read\`, \`DeleteNote\` needs \`notes.write\`. A known token without
   the scope → **\`PERMISSION_DENIED\`**.
3. **Validate.** An empty \`id\` → **\`INVALID_ARGUMENT\`**.
4. **Look up.** No such note → **\`NOT_FOUND\`**. Otherwise \`GetNote\` answers \`Note{id, text}\` and
   \`DeleteNote\` removes the note from \`NOTES\` and answers \`DeleteNoteResponse{deleted: true}\`.

Do the gates in the handlers through one shared helper: this runtime does not run server interceptors.
\`serve()\` registers the servicer and listens on \`0.0.0.0:50051\`.

> Credentials are judged before the request is. A caller who cannot prove who they are learns nothing,
> not even whether note \`n-1\` exists.`,
  sequence: {
    participants: ['reader', 'anonymous', 'Notes', 'admin'],
    messages: [
      {from: 'reader', to: 'Notes', label: 'GetNote{n-1} · authorization: Bearer reader-7f3a', kind: 'sync'},
      {from: 'Notes', to: 'reader', label: 'Note{n-1, "buy milk"}', kind: 'reply'},
      {from: 'reader', to: 'Notes', label: 'DeleteNote{n-1} · Bearer reader-7f3a', kind: 'sync'},
      {from: 'Notes', to: 'reader', label: 'PERMISSION_DENIED (no notes.write)', kind: 'reply'},
      {from: 'anonymous', to: 'Notes', label: 'GetNote{ghost} · no authorization', kind: 'sync'},
      {from: 'Notes', to: 'anonymous', label: 'UNAUTHENTICATED (never NOT_FOUND)', kind: 'reply'},
      {from: 'admin', to: 'Notes', label: 'DeleteNote{n-1} · Bearer admin-91c2', kind: 'sync'},
      {from: 'Notes', to: 'admin', label: 'DeleteNoteResponse{deleted: true}', kind: 'reply'},
      {from: 'admin', to: 'Notes', label: 'GetNote{n-1} · Bearer admin-91c2', kind: 'sync'},
      {from: 'Notes', to: 'admin', label: 'NOT_FOUND', kind: 'reply'},
    ],
  },
  hints: [
    'Write one helper, `authorize(context, scope)`, and make it the first line of both handlers. Only after it passes does the handler read `request.id`.',
    'Read the header from the call: Python `dict(context.invocation_metadata()).get("authorization", "")`, TypeScript `call.metadata.get(\'authorization\')[0]`, Go `metadata.FromIncomingContext(ctx)`, C++ `context->client_metadata().find("authorization")`, Scala a `ServerInterceptor` that copies the `Metadata.Key` into a `Context.Key`.',
    'Check the prefix before the lookup: `"Bearer "` exactly, then the rest is the token. A bare `reader-7f3a`, `Basic reader-7f3a` or the right value under another key are all UNAUTHENTICATED.',
  ],
  checks: [
    {
      id: 'reader-reads',
      title: 'A reader reads a note',
      detail:
        '`GetNote` with `authorization: Bearer reader-7f3a` answers `Note{id, text}` from `NOTES`; the admin token, which also holds `notes.read`, reads too.',
      match: {
        python: {all: [/class \w+\(\s*notes_pb2_grpc\.NotesServicer\s*\)/, /notes_pb2\.Note\(/, /NOTES\.get\(/]},
        typescript: {all: [/addService\(\s*[\w.]*Notes\.service\s*,/, /NOTES\.get\(/]},
        go: {all: [/pb\.UnimplementedNotesServer/, /&pb\.Note\{/]},
        scala: {all: [/NotesGrpc\.Notes\b/, /Future\.successful\(\s*Note\(/]},
        cpp: {all: [/notes::v1::Notes::Service/, /reply->set_text\(/]},
      },
    },
    {
      id: 'unauthenticated',
      title: 'Missing, malformed or unknown credentials get UNAUTHENTICATED',
      detail:
        'No `authorization`, an empty one, a bare token, `Basic …`, `Bearer ` with no token, an unknown token, or the right value under another key: every one is `UNAUTHENTICATED` on both RPCs, and nothing is deleted.',
      match: {
        python: {
          all: [/invocation_metadata\(\)/, /["']authorization["']/, /["']Bearer ["']/, /StatusCode\.UNAUTHENTICATED/],
        },
        typescript: {
          all: [/metadata\.get\(\s*['"]authorization['"]\s*\)/, /['"]Bearer ['"]/, /status\.UNAUTHENTICATED/],
        },
        go: {all: [/metadata\.FromIncomingContext\(/, /"authorization"/, /"Bearer "/, /codes\.Unauthenticated/]},
        scala: {all: [/Metadata\.Key\.of\(\s*"authorization"/, /"Bearer "/, /Status\.UNAUTHENTICATED/]},
        cpp: {all: [/client_metadata\(\)/, /"authorization"/, /"Bearer "/, /StatusCode::UNAUTHENTICATED/]},
      },
    },
    {
      id: 'permission-denied',
      title: "A reader's delete gets PERMISSION_DENIED and the note survives",
      detail:
        '`DeleteNote` needs `notes.write`: the reader token is known, so the answer is `PERMISSION_DENIED`, not `UNAUTHENTICATED`, for any id (missing and empty included), and `NOTES` keeps the note.',
      match: {
        python: {all: [/StatusCode\.PERMISSION_DENIED/, /["']notes\.write["']/]},
        typescript: {all: [/status\.PERMISSION_DENIED/, /['"]notes\.write['"]/]},
        go: {all: [/codes\.PermissionDenied/, /"notes\.write"/]},
        scala: {all: [/Status\.PERMISSION_DENIED/, /"notes\.write"/]},
        cpp: {all: [/StatusCode::PERMISSION_DENIED/, /"notes\.write"/]},
      },
    },
    {
      id: 'auth-first',
      title: 'Bad credentials win over a missing or empty id',
      detail:
        'With valid credentials an empty id is `INVALID_ARGUMENT` and an unknown id `NOT_FOUND`; with bad credentials both are `UNAUTHENTICATED`, with the same details as for a note that exists.',
      match: {
        python: {order: [/StatusCode\.UNAUTHENTICATED/, /StatusCode\.INVALID_ARGUMENT/, /StatusCode\.NOT_FOUND/]},
        typescript: {order: [/status\.UNAUTHENTICATED/, /status\.INVALID_ARGUMENT/, /status\.NOT_FOUND/]},
        go: {order: [/codes\.Unauthenticated/, /codes\.InvalidArgument/, /codes\.NotFound/]},
        scala: {order: [/Status\.UNAUTHENTICATED/, /Status\.INVALID_ARGUMENT/, /Status\.NOT_FOUND/]},
        cpp: {
          order: [/StatusCode::UNAUTHENTICATED/, /StatusCode::INVALID_ARGUMENT/, /StatusCode::NOT_FOUND/],
        },
      },
    },
    {
      id: 'admin-deletes',
      title: "An admin's delete works, then the note is NOT_FOUND",
      detail:
        '`DeleteNote` with `Bearer admin-91c2` removes the note from `NOTES` and answers `deleted: true`; reading it afterwards, or deleting it again, is `NOT_FOUND`.',
      match: {
        python: {all: [/NOTES\.pop\(|del NOTES\[/, /DeleteNoteResponse\(\s*deleted\s*=\s*True/]},
        typescript: {all: [/NOTES\.delete\(/, /deleted:\s*true/]},
        go: {all: [/delete\(\s*(s\.)?notes\s*,/, /&pb\.DeleteNoteResponse\{\s*Deleted:\s*true/]},
        scala: {all: [/Notes\.remove\(/, /DeleteNoteResponse\(\s*(deleted\s*=\s*)?true/]},
        cpp: {all: [/notes_\.erase\(/, /set_deleted\(\s*true/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio

import grpc

import notes_pb2
import notes_pb2_grpc

# id -> text. Whoever runs the server seeds it.
NOTES: dict[str, str] = {}

# Bearer token -> the scopes it grants.
TOKENS: dict[str, set[str]] = {
    "reader-7f3a": {"notes.read"},
    "admin-91c2": {"notes.read", "notes.write"},
}


class NotesService(notes_pb2_grpc.NotesServicer):
    async def GetNote(self, request: notes_pb2.GetNoteRequest, context: grpc.aio.ServicerContext) -> notes_pb2.Note:
        # TODO: authorization metadata must be "Bearer <known token>", else UNAUTHENTICATED
        # TODO: the token needs notes.read, else PERMISSION_DENIED
        # TODO: empty id -> INVALID_ARGUMENT; unknown id -> NOT_FOUND; else Note(id, text)
        await context.abort(grpc.StatusCode.UNIMPLEMENTED, "not implemented")

    async def DeleteNote(self, request: notes_pb2.DeleteNoteRequest, context: grpc.aio.ServicerContext) -> notes_pb2.DeleteNoteResponse:
        # TODO: the same authentication; the token needs notes.write
        # TODO: empty id -> INVALID_ARGUMENT; unknown id -> NOT_FOUND; else remove it, DeleteNoteResponse(deleted=True)
        await context.abort(grpc.StatusCode.UNIMPLEMENTED, "not implemented")


async def serve() -> None:
    server = grpc.aio.server()
    notes_pb2_grpc.add_NotesServicer_to_server(NotesService(), server)
    server.add_insecure_port("0.0.0.0:50051")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
`,
      solution: `import asyncio

import grpc

import notes_pb2
import notes_pb2_grpc

# id -> text. Whoever runs the server seeds it.
NOTES: dict[str, str] = {}

# Bearer token -> the scopes it grants.
TOKENS: dict[str, set[str]] = {
    "reader-7f3a": {"notes.read"},
    "admin-91c2": {"notes.read", "notes.write"},
}

BEARER = "Bearer "


async def authorize(context: grpc.aio.ServicerContext, scope: str) -> None:
    """Abort UNAUTHENTICATED without a known bearer token, PERMISSION_DENIED without \`scope\`."""
    header = dict(context.invocation_metadata()).get("authorization", "")
    if not header.startswith(BEARER):
        await context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing bearer token")
    scopes = TOKENS.get(header[len(BEARER):])
    if scopes is None:
        await context.abort(grpc.StatusCode.UNAUTHENTICATED, "unknown token")
    if scope not in scopes:
        await context.abort(grpc.StatusCode.PERMISSION_DENIED, f"token lacks {scope}")


class NotesService(notes_pb2_grpc.NotesServicer):
    async def GetNote(self, request: notes_pb2.GetNoteRequest, context: grpc.aio.ServicerContext) -> notes_pb2.Note:
        await authorize(context, "notes.read")
        if not request.id:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "id is required")
        text = NOTES.get(request.id)
        if text is None:
            await context.abort(grpc.StatusCode.NOT_FOUND, f"no note {request.id}")
        return notes_pb2.Note(id=request.id, text=text)

    async def DeleteNote(self, request: notes_pb2.DeleteNoteRequest, context: grpc.aio.ServicerContext) -> notes_pb2.DeleteNoteResponse:
        await authorize(context, "notes.write")
        if not request.id:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "id is required")
        if NOTES.pop(request.id, None) is None:
            await context.abort(grpc.StatusCode.NOT_FOUND, f"no note {request.id}")
        return notes_pb2.DeleteNoteResponse(deleted=True)


async def serve() -> None:
    server = grpc.aio.server()
    notes_pb2_grpc.add_NotesServicer_to_server(NotesService(), server)
    server.add_insecure_port("0.0.0.0:50051")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface GetNoteRequest {
  id: string;
}
interface Note {
  id: string;
  text: string;
}
interface DeleteNoteRequest {
  id: string;
}
interface DeleteNoteResponse {
  deleted: boolean;
}

/** id -> text. Whoever runs the server seeds it. */
export const NOTES = new Map<string, string>();

/** Bearer token -> the scopes it grants. */
export const TOKENS = new Map<string, Set<string>>([
  ['reader-7f3a', new Set(['notes.read'])],
  ['admin-91c2', new Set(['notes.read', 'notes.write'])],
]);

export const notesService = {
  GetNote(call: grpc.ServerUnaryCall<GetNoteRequest, Note>, callback: grpc.sendUnaryData<Note>): void {
    // TODO: authorization metadata must be "Bearer <known token>", else UNAUTHENTICATED
    // TODO: the token needs notes.read, else PERMISSION_DENIED
    // TODO: empty id -> INVALID_ARGUMENT; unknown id -> NOT_FOUND; else {id, text}
    callback({code: grpc.status.UNIMPLEMENTED, details: 'not implemented'});
  },
  DeleteNote(
    call: grpc.ServerUnaryCall<DeleteNoteRequest, DeleteNoteResponse>,
    callback: grpc.sendUnaryData<DeleteNoteResponse>,
  ): void {
    // TODO: the same authentication; the token needs notes.write
    // TODO: empty id -> INVALID_ARGUMENT; unknown id -> NOT_FOUND; else remove it, {deleted: true}
    callback({code: grpc.status.UNIMPLEMENTED, details: 'not implemented'});
  },
};

const notes = grpc.loadPackageDefinition(protoLoader.loadSync('notes.proto')).notes as grpc.GrpcObject;
const Notes = (notes.v1 as grpc.GrpcObject).Notes as grpc.ServiceClientConstructor;

export const server = new grpc.Server();
server.addService(Notes.service, notesService);

export function serve(): void {
  server.bindAsync('0.0.0.0:50051', grpc.ServerCredentials.createInsecure(), () => server.start());
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface GetNoteRequest {
  id: string;
}
interface Note {
  id: string;
  text: string;
}
interface DeleteNoteRequest {
  id: string;
}
interface DeleteNoteResponse {
  deleted: boolean;
}

/** id -> text. Whoever runs the server seeds it. */
export const NOTES = new Map<string, string>();

/** Bearer token -> the scopes it grants. */
export const TOKENS = new Map<string, Set<string>>([
  ['reader-7f3a', new Set(['notes.read'])],
  ['admin-91c2', new Set(['notes.read', 'notes.write'])],
]);

const BEARER = 'Bearer ';

type Denial = {code: grpc.status; details: string};

/** null when the caller holds \`scope\`; otherwise UNAUTHENTICATED or PERMISSION_DENIED. */
function authorize(metadata: grpc.Metadata, scope: string): Denial | null {
  const header = String(metadata.get('authorization')[0] ?? '');
  if (!header.startsWith(BEARER)) return {code: grpc.status.UNAUTHENTICATED, details: 'missing bearer token'};
  const scopes = TOKENS.get(header.slice(BEARER.length));
  if (scopes === undefined) return {code: grpc.status.UNAUTHENTICATED, details: 'unknown token'};
  if (!scopes.has(scope)) return {code: grpc.status.PERMISSION_DENIED, details: \`token lacks \${scope}\`};
  return null;
}

export const notesService = {
  GetNote(call: grpc.ServerUnaryCall<GetNoteRequest, Note>, callback: grpc.sendUnaryData<Note>): void {
    const denied = authorize(call.metadata, 'notes.read');
    if (denied !== null) return callback(denied);
    const {id} = call.request;
    if (!id) return callback({code: grpc.status.INVALID_ARGUMENT, details: 'id is required'});
    const text = NOTES.get(id);
    if (text === undefined) return callback({code: grpc.status.NOT_FOUND, details: \`no note \${id}\`});
    callback(null, {id, text});
  },
  DeleteNote(
    call: grpc.ServerUnaryCall<DeleteNoteRequest, DeleteNoteResponse>,
    callback: grpc.sendUnaryData<DeleteNoteResponse>,
  ): void {
    const denied = authorize(call.metadata, 'notes.write');
    if (denied !== null) return callback(denied);
    const {id} = call.request;
    if (!id) return callback({code: grpc.status.INVALID_ARGUMENT, details: 'id is required'});
    if (!NOTES.delete(id)) return callback({code: grpc.status.NOT_FOUND, details: \`no note \${id}\`});
    callback(null, {deleted: true});
  },
};

const notes = grpc.loadPackageDefinition(protoLoader.loadSync('notes.proto')).notes as grpc.GrpcObject;
const Notes = (notes.v1 as grpc.GrpcObject).Notes as grpc.ServiceClientConstructor;

export const server = new grpc.Server();
server.addService(Notes.service, notesService);

export function serve(): void {
  server.bindAsync('0.0.0.0:50051', grpc.ServerCredentials.createInsecure(), () => server.start());
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
	"net"
	"sync"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "notes/gen/notes"
)

// tokens maps a bearer token to the scopes it grants.
var tokens = map[string]map[string]bool{
	"reader-7f3a": {"notes.read": true},
	"admin-91c2":  {"notes.read": true, "notes.write": true},
}

type notesServer struct {
	pb.UnimplementedNotesServer
	mu    sync.Mutex
	notes map[string]string // id -> text, seeded by whoever runs the server
}

func (s *notesServer) GetNote(ctx context.Context, req *pb.GetNoteRequest) (*pb.Note, error) {
	// TODO: authorization metadata must be "Bearer <known token>", else codes.Unauthenticated
	// TODO: the token needs notes.read, else codes.PermissionDenied
	// TODO: empty id -> codes.InvalidArgument; unknown id -> codes.NotFound; else Note{Id, Text}
	return nil, status.Error(codes.Unimplemented, "not implemented")
}

func (s *notesServer) DeleteNote(ctx context.Context, req *pb.DeleteNoteRequest) (*pb.DeleteNoteResponse, error) {
	// TODO: the same authentication; the token needs notes.write
	// TODO: empty id -> codes.InvalidArgument; unknown id -> codes.NotFound; else remove it, Deleted: true
	return nil, status.Error(codes.Unimplemented, "not implemented")
}

func main() {
	lis, err := net.Listen("tcp", "0.0.0.0:50051")
	if err != nil {
		log.Fatal(err)
	}
	srv := grpc.NewServer()
	pb.RegisterNotesServer(srv, &notesServer{notes: map[string]string{}})
	log.Fatal(srv.Serve(lis))
}
`,
      solution: `package main

import (
	"context"
	"log"
	"net"
	"strings"
	"sync"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "notes/gen/notes"
)

const bearer = "Bearer "

// tokens maps a bearer token to the scopes it grants.
var tokens = map[string]map[string]bool{
	"reader-7f3a": {"notes.read": true},
	"admin-91c2":  {"notes.read": true, "notes.write": true},
}

// authorize returns nil when the caller holds scope; otherwise Unauthenticated or PermissionDenied.
func authorize(ctx context.Context, scope string) error {
	md, _ := metadata.FromIncomingContext(ctx)
	values := md.Get("authorization")
	if len(values) == 0 || !strings.HasPrefix(values[0], bearer) {
		return status.Error(codes.Unauthenticated, "missing bearer token")
	}
	scopes, ok := tokens[strings.TrimPrefix(values[0], bearer)]
	if !ok {
		return status.Error(codes.Unauthenticated, "unknown token")
	}
	if !scopes[scope] {
		return status.Errorf(codes.PermissionDenied, "token lacks %s", scope)
	}
	return nil
}

type notesServer struct {
	pb.UnimplementedNotesServer
	mu    sync.Mutex
	notes map[string]string // id -> text, seeded by whoever runs the server
}

func (s *notesServer) GetNote(ctx context.Context, req *pb.GetNoteRequest) (*pb.Note, error) {
	if err := authorize(ctx, "notes.read"); err != nil {
		return nil, err
	}
	if req.GetId() == "" {
		return nil, status.Error(codes.InvalidArgument, "id is required")
	}
	s.mu.Lock()
	text, ok := s.notes[req.GetId()]
	s.mu.Unlock()
	if !ok {
		return nil, status.Errorf(codes.NotFound, "no note %s", req.GetId())
	}
	return &pb.Note{Id: req.GetId(), Text: text}, nil
}

func (s *notesServer) DeleteNote(ctx context.Context, req *pb.DeleteNoteRequest) (*pb.DeleteNoteResponse, error) {
	if err := authorize(ctx, "notes.write"); err != nil {
		return nil, err
	}
	if req.GetId() == "" {
		return nil, status.Error(codes.InvalidArgument, "id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.notes[req.GetId()]; !ok {
		return nil, status.Errorf(codes.NotFound, "no note %s", req.GetId())
	}
	delete(s.notes, req.GetId())
	return &pb.DeleteNoteResponse{Deleted: true}, nil
}

func main() {
	lis, err := net.Listen("tcp", "0.0.0.0:50051")
	if err != nil {
		log.Fatal(err)
	}
	srv := grpc.NewServer()
	pb.RegisterNotesServer(srv, &notesServer{notes: map[string]string{}})
	log.Fatal(srv.Serve(lis))
}
`,
    },
    scala: {
      starter: `import io.grpc.{ServerBuilder, Status}
import notes.v1.notes.{DeleteNoteRequest, DeleteNoteResponse, GetNoteRequest, Note, NotesGrpc}
import scala.collection.concurrent.TrieMap
import scala.concurrent.{ExecutionContext, Future}

object NotesServer extends NotesGrpc.Notes {
  /** id -> text, seeded by whoever runs the server. */
  val Notes = TrieMap.empty[String, String]

  /** Bearer token -> the scopes it grants. */
  val Tokens: Map[String, Set[String]] =
    Map("reader-7f3a" -> Set("notes.read"), "admin-91c2" -> Set("notes.read", "notes.write"))

  override def getNote(req: GetNoteRequest): Future[Note] = {
    // TODO: a ServerInterceptor copies the authorization header into a Context.Key for the handlers
    // TODO: it must be "Bearer <known token>", else Status.UNAUTHENTICATED; notes.read, else Status.PERMISSION_DENIED
    // TODO: empty id -> Status.INVALID_ARGUMENT; unknown id -> Status.NOT_FOUND; else Note(id, text)
    Future.failed(Status.UNIMPLEMENTED.asRuntimeException())
  }

  override def deleteNote(req: DeleteNoteRequest): Future[DeleteNoteResponse] = {
    // TODO: the same authentication; the token needs notes.write
    // TODO: empty id -> Status.INVALID_ARGUMENT; unknown id -> Status.NOT_FOUND; else remove it, deleted = true
    Future.failed(Status.UNIMPLEMENTED.asRuntimeException())
  }

  def main(args: Array[String]): Unit =
    ServerBuilder
      .forPort(50051)
      .addService(NotesGrpc.bindService(this, ExecutionContext.global))
      .build()
      .start()
      .awaitTermination()
}
`,
      solution: `import io.grpc.{Context, Contexts, Metadata, ServerBuilder, ServerCall, ServerCallHandler, ServerInterceptor, ServerInterceptors, Status}
import notes.v1.notes.{DeleteNoteRequest, DeleteNoteResponse, GetNoteRequest, Note, NotesGrpc}
import scala.collection.concurrent.TrieMap
import scala.concurrent.{ExecutionContext, Future}

object NotesServer extends NotesGrpc.Notes {
  /** id -> text, seeded by whoever runs the server. */
  val Notes = TrieMap.empty[String, String]

  /** Bearer token -> the scopes it grants. */
  val Tokens: Map[String, Set[String]] =
    Map("reader-7f3a" -> Set("notes.read"), "admin-91c2" -> Set("notes.read", "notes.write"))

  val Bearer = "Bearer "
  val AuthorizationHeader: Metadata.Key[String] = Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER)
  val Authorization: Context.Key[String] = Context.key("authorization")

  /** ScalaPB handlers never see metadata: copy the header into the call's Context, where they read it. */
  object CaptureAuthorization extends ServerInterceptor {
    override def interceptCall[Req, Resp](
        call: ServerCall[Req, Resp],
        headers: Metadata,
        next: ServerCallHandler[Req, Resp]): ServerCall.Listener[Req] =
      Contexts.interceptCall(Context.current().withValue(Authorization, headers.get(AuthorizationHeader)), call, headers, next)
  }

  /** None when the caller holds \`scope\`; otherwise UNAUTHENTICATED or PERMISSION_DENIED. */
  private def authorize(scope: String): Option[Status] = {
    val header = Option(Authorization.get()).getOrElse("")
    val scopes = if (header.startsWith(Bearer)) Tokens.get(header.stripPrefix(Bearer)) else None
    scopes match {
      case None => Some(Status.UNAUTHENTICATED.withDescription("missing or unknown bearer token"))
      case Some(granted) if !granted.contains(scope) => Some(Status.PERMISSION_DENIED.withDescription(s"token lacks $scope"))
      case Some(_) => None
    }
  }

  override def getNote(req: GetNoteRequest): Future[Note] =
    authorize("notes.read") match {
      case Some(denied) => Future.failed(denied.asRuntimeException())
      case None if req.id.isEmpty => Future.failed(Status.INVALID_ARGUMENT.withDescription("id is required").asRuntimeException())
      case None =>
        Notes.get(req.id) match {
          case Some(text) => Future.successful(Note(id = req.id, text = text))
          case None => Future.failed(Status.NOT_FOUND.withDescription(s"no note \${req.id}").asRuntimeException())
        }
    }

  override def deleteNote(req: DeleteNoteRequest): Future[DeleteNoteResponse] =
    authorize("notes.write") match {
      case Some(denied) => Future.failed(denied.asRuntimeException())
      case None if req.id.isEmpty => Future.failed(Status.INVALID_ARGUMENT.withDescription("id is required").asRuntimeException())
      case None =>
        Notes.remove(req.id) match {
          case Some(_) => Future.successful(DeleteNoteResponse(deleted = true))
          case None => Future.failed(Status.NOT_FOUND.withDescription(s"no note \${req.id}").asRuntimeException())
        }
    }

  def main(args: Array[String]): Unit =
    ServerBuilder
      .forPort(50051)
      .addService(ServerInterceptors.intercept(NotesGrpc.bindService(this, ExecutionContext.global), CaptureAuthorization))
      .build()
      .start()
      .awaitTermination()
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <map>
#include <mutex>
#include <set>
#include <string>

#include "notes.grpc.pb.h"

using notes::v1::DeleteNoteRequest;
using notes::v1::DeleteNoteResponse;
using notes::v1::GetNoteRequest;
using notes::v1::Note;

// Bearer token -> the scopes it grants.
const std::map<std::string, std::set<std::string>> kTokens = {
    {"reader-7f3a", {"notes.read"}},
    {"admin-91c2", {"notes.read", "notes.write"}},
};

class NotesImpl final : public notes::v1::Notes::Service {
 public:
  grpc::Status GetNote(grpc::ServerContext* context, const GetNoteRequest* request, Note* reply) override {
    // TODO: authorization metadata must be "Bearer <known token>", else UNAUTHENTICATED
    // TODO: the token needs notes.read, else PERMISSION_DENIED
    // TODO: empty id -> INVALID_ARGUMENT; unknown id -> NOT_FOUND; else fill id and text
    return grpc::Status(grpc::StatusCode::UNIMPLEMENTED, "not implemented");
  }

  grpc::Status DeleteNote(grpc::ServerContext* context, const DeleteNoteRequest* request,
                          DeleteNoteResponse* reply) override {
    // TODO: the same authentication; the token needs notes.write
    // TODO: empty id -> INVALID_ARGUMENT; unknown id -> NOT_FOUND; else erase it, deleted = true
    return grpc::Status(grpc::StatusCode::UNIMPLEMENTED, "not implemented");
  }

 private:
  std::mutex mu_;
  std::map<std::string, std::string> notes_;  // id -> text, seeded by whoever runs the server
};

int main() {
  NotesImpl service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:50051", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <map>
#include <mutex>
#include <set>
#include <string>

#include "notes.grpc.pb.h"

using notes::v1::DeleteNoteRequest;
using notes::v1::DeleteNoteResponse;
using notes::v1::GetNoteRequest;
using notes::v1::Note;

const std::string kBearer = "Bearer ";

// Bearer token -> the scopes it grants.
const std::map<std::string, std::set<std::string>> kTokens = {
    {"reader-7f3a", {"notes.read"}},
    {"admin-91c2", {"notes.read", "notes.write"}},
};

// OK when the caller holds scope; otherwise UNAUTHENTICATED or PERMISSION_DENIED.
grpc::Status Authorize(const grpc::ServerContext* context, const std::string& scope) {
  const auto& md = context->client_metadata();
  const auto it = md.find("authorization");
  const std::string header = it == md.end() ? "" : std::string(it->second.data(), it->second.size());
  if (header.rfind(kBearer, 0) != 0) return grpc::Status(grpc::StatusCode::UNAUTHENTICATED, "missing bearer token");
  const auto token = kTokens.find(header.substr(kBearer.size()));
  if (token == kTokens.end()) return grpc::Status(grpc::StatusCode::UNAUTHENTICATED, "unknown token");
  if (token->second.count(scope) == 0) return grpc::Status(grpc::StatusCode::PERMISSION_DENIED, "token lacks " + scope);
  return grpc::Status::OK;
}

class NotesImpl final : public notes::v1::Notes::Service {
 public:
  grpc::Status GetNote(grpc::ServerContext* context, const GetNoteRequest* request, Note* reply) override {
    if (auto denied = Authorize(context, "notes.read"); !denied.ok()) return denied;
    if (request->id().empty()) return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "id is required");
    std::lock_guard<std::mutex> lock(mu_);
    const auto note = notes_.find(request->id());
    if (note == notes_.end()) return grpc::Status(grpc::StatusCode::NOT_FOUND, "no note " + request->id());
    reply->set_id(request->id());
    reply->set_text(note->second);
    return grpc::Status::OK;
  }

  grpc::Status DeleteNote(grpc::ServerContext* context, const DeleteNoteRequest* request,
                          DeleteNoteResponse* reply) override {
    if (auto denied = Authorize(context, "notes.write"); !denied.ok()) return denied;
    if (request->id().empty()) return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "id is required");
    std::lock_guard<std::mutex> lock(mu_);
    if (notes_.erase(request->id()) == 0) return grpc::Status(grpc::StatusCode::NOT_FOUND, "no note " + request->id());
    reply->set_deleted(true);
    return grpc::Status::OK;
  }

 private:
  std::mutex mu_;
  std::map<std::string, std::string> notes_;  // id -> text, seeded by whoever runs the server
};

int main() {
  NotesImpl service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:50051", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
    },
  },
  harness: {
    python: `import asyncio

import grpc

import notes_pb2
import notes_pb2_grpc

READER = "Bearer reader-7f3a"
ADMIN = "Bearer admin-91c2"
SEED = {"n-1": "buy milk", "n-2": "ship the release notes", "n-3": "rotate the admin token"}

# (what the caller sent, metadata): every one of them must be UNAUTHENTICATED.
BAD_CREDENTIALS = [
    ("no authorization", ()),
    ("an empty authorization", (("authorization", ""),)),
    ("a bare token", (("authorization", "reader-7f3a"),)),
    ("Basic instead of Bearer", (("authorization", "Basic admin-91c2"),)),
    ("'Bearer' without a space", (("authorization", "Beareradmin-91c2"),)),
    ("'Bearer ' with no token", (("authorization", "Bearer "),)),
    ("an unknown token", (("authorization", "Bearer guest-0000"),)),
    ("a known token with a suffix", (("authorization", "Bearer admin-91c2x"),)),
    ("the admin credentials under another key", (("token", ADMIN),)),
]


async def _start(ctx):
    m = ctx.load("notes_server")
    m.NOTES.clear()
    m.NOTES.update(SEED)
    asyncio.create_task(m.serve())
    await asyncio.sleep(0)
    assert ctx.grpc.find("/notes.v1.Notes/GetNote") is not None, "serve() must register the Notes servicer on a grpc.aio server"
    return m, notes_pb2_grpc.NotesStub(grpc.aio.insecure_channel("notes:50051"))


def _auth(value):
    return (("authorization", value),)


async def _get(stub, note_id, metadata):
    """(code, details, reply) of GetNote."""
    try:
        reply = await stub.GetNote(notes_pb2.GetNoteRequest(id=note_id), metadata=metadata, timeout=2.0)
    except grpc.RpcError as e:
        return e.code(), e.details(), None
    return grpc.StatusCode.OK, "", reply


async def _delete(stub, note_id, metadata):
    """(code, details, reply) of DeleteNote."""
    try:
        reply = await stub.DeleteNote(notes_pb2.DeleteNoteRequest(id=note_id), metadata=metadata, timeout=2.0)
    except grpc.RpcError as e:
        return e.code(), e.details(), None
    return grpc.StatusCode.OK, "", reply


async def check_reader_reads(ctx):
    m, stub = await _start(ctx)
    for note_id in ("n-1", "n-2"):
        code, details, reply = await _get(stub, note_id, _auth(READER))
        assert code == grpc.StatusCode.OK, f"GetNote({note_id}) with {READER!r} answered {code}: {details}"
        assert (reply.id, reply.text) == (note_id, SEED[note_id]), f"GetNote({note_id}) must answer Note{{{note_id}, {SEED[note_id]!r}}}, got {reply!r}"
    code, details, reply = await _get(stub, "n-3", _auth(ADMIN))
    assert code == grpc.StatusCode.OK, f"the admin token holds notes.read too, but GetNote(n-3) answered {code}: {details}"
    assert reply.text == SEED["n-3"], f"GetNote(n-3) must answer {SEED['n-3']!r}, got {reply.text!r}"
    assert dict(m.NOTES) == SEED, f"reading must not change NOTES, now {dict(m.NOTES)}"


async def check_unauthenticated(ctx):
    m, stub = await _start(ctx)
    for label, metadata in BAD_CREDENTIALS:
        code, details, _ = await _get(stub, "n-1", metadata)
        assert code == grpc.StatusCode.UNAUTHENTICATED, f"GetNote(n-1) with {label} {metadata!r} answered {code} ({details}), expected UNAUTHENTICATED"
        code, details, _ = await _delete(stub, "n-1", metadata)
        assert code == grpc.StatusCode.UNAUTHENTICATED, f"DeleteNote(n-1) with {label} {metadata!r} answered {code} ({details}), expected UNAUTHENTICATED"
    assert dict(m.NOTES) == SEED, f"no unauthenticated call may delete anything, NOTES is now {dict(m.NOTES)}"


async def check_permission_denied(ctx):
    m, stub = await _start(ctx)
    code, details, _ = await _delete(stub, "n-2", _auth(READER))
    assert code == grpc.StatusCode.PERMISSION_DENIED, f"DeleteNote(n-2) with the reader token answered {code} ({details}), expected PERMISSION_DENIED: the token is known, it lacks notes.write"
    assert m.NOTES.get("n-2") == SEED["n-2"], "a PERMISSION_DENIED delete must leave the note in NOTES"
    code, details, reply = await _get(stub, "n-2", _auth(READER))
    assert code == grpc.StatusCode.OK and reply.text == SEED["n-2"], f"after the refused delete the reader must still read n-2, got {code} ({details})"
    for note_id, what in (("ghost", "a missing note"), ("", "an empty id")):
        code, details, _ = await _delete(stub, note_id, _auth(READER))
        assert code == grpc.StatusCode.PERMISSION_DENIED, f"the reader's DeleteNote of {what} answered {code} ({details}), expected PERMISSION_DENIED: authorize before you validate or look up"
    assert dict(m.NOTES) == SEED, f"the reader must not be able to delete anything, NOTES is now {dict(m.NOTES)}"


async def check_auth_first(ctx):
    m, stub = await _start(ctx)
    code, details, _ = await _get(stub, "", _auth(READER))
    assert code == grpc.StatusCode.INVALID_ARGUMENT, f"GetNote with an empty id and valid credentials answered {code} ({details}), expected INVALID_ARGUMENT"
    code, details, _ = await _get(stub, "ghost", _auth(READER))
    assert code == grpc.StatusCode.NOT_FOUND, f"GetNote(ghost) with valid credentials answered {code} ({details}), expected NOT_FOUND"
    for label, metadata in (BAD_CREDENTIALS[0], BAD_CREDENTIALS[2], BAD_CREDENTIALS[6]):
        for rpc, call in (("GetNote", _get), ("DeleteNote", _delete)):
            exists = await call(stub, "n-1", metadata)
            for note_id, what in (("ghost", "a missing note"), ("", "an empty id")):
                code, details, _ = await call(stub, note_id, metadata)
                assert code == grpc.StatusCode.UNAUTHENTICATED, f"{rpc} of {what} with {label} answered {code} ({details}), expected UNAUTHENTICATED: authenticate before you validate or look up"
                assert (code, details) == exists[:2], f"{rpc} with {label} must answer the same for {what} as for an existing note, got {code.name} {details!r} vs {exists[0].name} {exists[1]!r}"
    assert dict(m.NOTES) == SEED, f"no unauthenticated call may delete anything, NOTES is now {dict(m.NOTES)}"


async def check_admin_deletes(ctx):
    m, stub = await _start(ctx)
    code, details, reply = await _delete(stub, "n-3", _auth(ADMIN))
    assert code == grpc.StatusCode.OK, f"DeleteNote(n-3) with the admin token answered {code}: {details}"
    assert reply.deleted is True, f"DeleteNote must answer deleted: true, got {reply!r}"
    assert "n-3" not in m.NOTES, "after the admin's delete n-3 must be gone from NOTES"
    assert {k: v for k, v in m.NOTES.items()} == {k: v for k, v in SEED.items() if k != "n-3"}, f"only n-3 may be deleted, NOTES is now {dict(m.NOTES)}"
    for token in (ADMIN, READER):
        code, details, _ = await _get(stub, "n-3", _auth(token))
        assert code == grpc.StatusCode.NOT_FOUND, f"GetNote(n-3) after the delete with {token!r} answered {code} ({details}), expected NOT_FOUND"
    code, details, _ = await _delete(stub, "n-3", _auth(ADMIN))
    assert code == grpc.StatusCode.NOT_FOUND, f"deleting n-3 a second time answered {code} ({details}), expected NOT_FOUND"
    code, details, _ = await _delete(stub, "", _auth(ADMIN))
    assert code == grpc.StatusCode.INVALID_ARGUMENT, f"the admin's DeleteNote with an empty id answered {code} ({details}), expected INVALID_ARGUMENT"
`,
    typescript: `import * as grpc from '@grpc/grpc-js';

const READER = 'Bearer reader-7f3a';
const ADMIN = 'Bearer admin-91c2';
const SEED: Record<string, string> = {'n-1': 'buy milk', 'n-2': 'ship the release notes', 'n-3': 'rotate the admin token'};

const STATUS_NAME = Object.fromEntries(Object.entries(grpc.status).map(([k, v]) => [v, k]));

// [what the caller sent, metadata entries]: every one of them must be UNAUTHENTICATED.
const BAD_CREDENTIALS: [string, [string, string][]][] = [
  ['no authorization', []],
  ['an empty authorization', [['authorization', '']]],
  ['a bare token', [['authorization', 'reader-7f3a']]],
  ['Basic instead of Bearer', [['authorization', 'Basic admin-91c2']]],
  ["'Bearer' without a space", [['authorization', 'Beareradmin-91c2']]],
  ["'Bearer ' with no token", [['authorization', 'Bearer ']]],
  ['an unknown token', [['authorization', 'Bearer guest-0000']]],
  ['a known token with a suffix', [['authorization', 'Bearer admin-91c2x']]],
  ['the admin credentials under another key', [['token', ADMIN]]],
];

function md(entries: [string, string][]) {
  const metadata = new grpc.Metadata();
  for (const [k, v] of entries) metadata.set(k, v);
  return metadata;
}

const auth = (value: string): [string, string][] => [['authorization', value]];

function start(ctx) {
  const m = ctx.load('notes_server');
  m.NOTES.clear();
  for (const [k, v] of Object.entries(SEED)) m.NOTES.set(k, v);
  m.serve();
  const pkg = ctx.proto('notes.proto');
  const client = new pkg.notes.v1.Notes('notes:50051', grpc.credentials.createInsecure());
  return {m, client};
}

const notes = (m): Record<string, string> => Object.fromEntries(m.NOTES);

/** [code name, details, reply] of one call. */
async function rpc(client, method: string, id: string, entries: [string, string][]): Promise<[string, string, any]> {
  try {
    const reply = await client[method]({id}, md(entries), {deadline: Date.now() + 2000});
    return ['OK', '', reply];
  } catch (e) {
    return [STATUS_NAME[e?.code] ?? String(e?.code), String(e?.details ?? e?.message ?? e), null];
  }
}

export async function check_reader_reads(ctx) {
  const {m, client} = start(ctx);
  for (const id of ['n-1', 'n-2']) {
    const [code, details, reply] = await rpc(client, 'GetNote', id, auth(READER));
    assert.equal(code, 'OK', \`GetNote(\${id}) with \${JSON.stringify(READER)} answered \${code}: \${details}\`);
    assert.deepEqual([reply?.id, reply?.text], [id, SEED[id]], \`GetNote(\${id}) must answer Note{\${id}, \${JSON.stringify(SEED[id])}}, got \${JSON.stringify(reply)}\`);
  }
  const [code, details, reply] = await rpc(client, 'GetNote', 'n-3', auth(ADMIN));
  assert.equal(code, 'OK', \`the admin token holds notes.read too, but GetNote(n-3) answered \${code}: \${details}\`);
  assert.equal(reply?.text, SEED['n-3'], \`GetNote(n-3) must answer \${JSON.stringify(SEED['n-3'])}, got \${JSON.stringify(reply)}\`);
  assert.deepEqual(notes(m), SEED, \`reading must not change NOTES, now \${JSON.stringify(notes(m))}\`);
}

export async function check_unauthenticated(ctx) {
  const {m, client} = start(ctx);
  for (const [label, entries] of BAD_CREDENTIALS) {
    for (const method of ['GetNote', 'DeleteNote']) {
      const [code, details] = await rpc(client, method, 'n-1', entries);
      assert.equal(code, 'UNAUTHENTICATED', \`\${method}(n-1) with \${label} \${JSON.stringify(entries)} answered \${code} (\${details}), expected UNAUTHENTICATED\`);
    }
  }
  assert.deepEqual(notes(m), SEED, \`no unauthenticated call may delete anything, NOTES is now \${JSON.stringify(notes(m))}\`);
}

export async function check_permission_denied(ctx) {
  const {m, client} = start(ctx);
  let [code, details] = await rpc(client, 'DeleteNote', 'n-2', auth(READER));
  assert.equal(code, 'PERMISSION_DENIED', \`DeleteNote(n-2) with the reader token answered \${code} (\${details}), expected PERMISSION_DENIED: the token is known, it lacks notes.write\`);
  assert.equal(m.NOTES.get('n-2'), SEED['n-2'], 'a PERMISSION_DENIED delete must leave the note in NOTES');
  const [readCode, readDetails, reply] = await rpc(client, 'GetNote', 'n-2', auth(READER));
  assert(readCode === 'OK' && reply?.text === SEED['n-2'], \`after the refused delete the reader must still read n-2, got \${readCode} (\${readDetails})\`);
  for (const [id, what] of [['ghost', 'a missing note'], ['', 'an empty id']]) {
    [code, details] = await rpc(client, 'DeleteNote', id, auth(READER));
    assert.equal(code, 'PERMISSION_DENIED', \`the reader's DeleteNote of \${what} answered \${code} (\${details}), expected PERMISSION_DENIED: authorize before you validate or look up\`);
  }
  assert.deepEqual(notes(m), SEED, \`the reader must not be able to delete anything, NOTES is now \${JSON.stringify(notes(m))}\`);
}

export async function check_auth_first(ctx) {
  const {m, client} = start(ctx);
  let [code, details] = await rpc(client, 'GetNote', '', auth(READER));
  assert.equal(code, 'INVALID_ARGUMENT', \`GetNote with an empty id and valid credentials answered \${code} (\${details}), expected INVALID_ARGUMENT\`);
  [code, details] = await rpc(client, 'GetNote', 'ghost', auth(READER));
  assert.equal(code, 'NOT_FOUND', \`GetNote(ghost) with valid credentials answered \${code} (\${details}), expected NOT_FOUND\`);
  for (const [label, entries] of [BAD_CREDENTIALS[0], BAD_CREDENTIALS[2], BAD_CREDENTIALS[6]]) {
    for (const method of ['GetNote', 'DeleteNote']) {
      const [existsCode, existsDetails] = await rpc(client, method, 'n-1', entries);
      for (const [id, what] of [['ghost', 'a missing note'], ['', 'an empty id']]) {
        [code, details] = await rpc(client, method, id, entries);
        assert.equal(code, 'UNAUTHENTICATED', \`\${method} of \${what} with \${label} answered \${code} (\${details}), expected UNAUTHENTICATED: authenticate before you validate or look up\`);
        assert.deepEqual([code, details], [existsCode, existsDetails], \`\${method} with \${label} must answer the same for \${what} as for an existing note, got \${code} \${JSON.stringify(details)} vs \${existsCode} \${JSON.stringify(existsDetails)}\`);
      }
    }
  }
  assert.deepEqual(notes(m), SEED, \`no unauthenticated call may delete anything, NOTES is now \${JSON.stringify(notes(m))}\`);
}

export async function check_admin_deletes(ctx) {
  const {m, client} = start(ctx);
  let [code, details, reply] = await rpc(client, 'DeleteNote', 'n-3', auth(ADMIN));
  assert.equal(code, 'OK', \`DeleteNote(n-3) with the admin token answered \${code}: \${details}\`);
  assert.equal(reply?.deleted, true, \`DeleteNote must answer deleted: true, got \${JSON.stringify(reply)}\`);
  assert(!m.NOTES.has('n-3'), 'after the admin\\'s delete n-3 must be gone from NOTES');
  assert.deepEqual(notes(m), {'n-1': SEED['n-1'], 'n-2': SEED['n-2']}, \`only n-3 may be deleted, NOTES is now \${JSON.stringify(notes(m))}\`);
  for (const token of [ADMIN, READER]) {
    [code, details] = await rpc(client, 'GetNote', 'n-3', auth(token));
    assert.equal(code, 'NOT_FOUND', \`GetNote(n-3) after the delete with \${JSON.stringify(token)} answered \${code} (\${details}), expected NOT_FOUND\`);
  }
  [code, details] = await rpc(client, 'DeleteNote', 'n-3', auth(ADMIN));
  assert.equal(code, 'NOT_FOUND', \`deleting n-3 a second time answered \${code} (\${details}), expected NOT_FOUND\`);
  [code, details] = await rpc(client, 'DeleteNote', '', auth(ADMIN));
  assert.equal(code, 'INVALID_ARGUMENT', \`the admin's DeleteNote with an empty id answered \${code} (\${details}), expected INVALID_ARGUMENT\`);
}
`,
    go: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"leetbuild/harness"

	pb "notes/gen/notes"
)

const (
	readerAuth = "Bearer reader-7f3a"
	adminAuth  = "Bearer admin-91c2"
)

var notesSeed = map[string]string{"n-1": "buy milk", "n-2": "ship the release notes", "n-3": "rotate the admin token"}

// badCredential is what a caller sent: every one of them must be Unauthenticated.
type badCredential struct {
	label string
	md    []string // metadata pairs
}

var badCredentials = []badCredential{
	{"no authorization", nil},
	{"an empty authorization", []string{"authorization", ""}},
	{"a bare token", []string{"authorization", "reader-7f3a"}},
	{"Basic instead of Bearer", []string{"authorization", "Basic admin-91c2"}},
	{"'Bearer' without a space", []string{"authorization", "Beareradmin-91c2"}},
	{"'Bearer ' with no token", []string{"authorization", "Bearer "}},
	{"an unknown token", []string{"authorization", "Bearer guest-0000"}},
	{"a known token with a suffix", []string{"authorization", "Bearer admin-91c2x"}},
	{"the admin credentials under another key", []string{"token", adminAuth}},
}

// notesAt is the learner's server, its notes seeded, served on notes:50051, and a client on it.
type notesAt struct {
	srv    *notesServer
	client pb.NotesClient
}

func startNotes(ctx *harness.Ctx) *notesAt {
	srv := &notesServer{notes: copyNotes(notesSeed)}
	pb.RegisterNotesServer(ctx.GRPC.Server("notes:50051"), srv)
	return &notesAt{srv: srv, client: pb.NewNotesClient(ctx.GRPC.Dial("notes:50051"))}
}

// stored is the server's notes now.
func (n *notesAt) stored() map[string]string {
	n.srv.mu.Lock()
	defer n.srv.mu.Unlock()
	return copyNotes(n.srv.notes)
}

func copyNotes(notes map[string]string) map[string]string {
	out := make(map[string]string, len(notes))
	for id, text := range notes {
		out[id] = text
	}
	return out
}

// notesReply is the outcome of one call: its code, details, and the reply when it is OK.
type notesReply struct {
	code    codes.Code
	details string
	note    *pb.Note
	deleted *pb.DeleteNoteResponse
}

func (n *notesAt) call(method, id string, pairs ...string) notesReply {
	c, cancel := context.WithTimeout(metadata.NewOutgoingContext(context.Background(), metadata.Pairs(pairs...)), 2*time.Second)
	defer cancel()
	var r notesReply
	var err error
	if method == "GetNote" {
		r.note, err = n.client.GetNote(c, &pb.GetNoteRequest{Id: id})
	} else {
		r.deleted, err = n.client.DeleteNote(c, &pb.DeleteNoteRequest{Id: id})
	}
	r.code, r.details = status.Code(err), status.Convert(err).Message()
	return r
}

func CheckReaderReads(ctx *harness.Ctx) {
	n := startNotes(ctx)
	for _, id := range []string{"n-1", "n-2"} {
		r := n.call("GetNote", id, "authorization", readerAuth)
		ctx.Equal(r.code, codes.OK, "GetNote(%s) with %q (%s)", id, readerAuth, r.details)
		ctx.Equal([]string{r.note.GetId(), r.note.GetText()}, []string{id, notesSeed[id]}, "GetNote(%s) must answer Note{%s, %q}; id and text", id, id, notesSeed[id])
	}
	r := n.call("GetNote", "n-3", "authorization", adminAuth)
	ctx.Equal(r.code, codes.OK, "the admin token holds notes.read too, but GetNote(n-3) failed (%s)", r.details)
	ctx.Equal(r.note.GetText(), notesSeed["n-3"], "GetNote(n-3)'s text")
	ctx.Equal(n.stored(), notesSeed, "reading must not change the notes")
}

func CheckUnauthenticated(ctx *harness.Ctx) {
	n := startNotes(ctx)
	for _, bad := range badCredentials {
		for _, method := range []string{"GetNote", "DeleteNote"} {
			r := n.call(method, "n-1", bad.md...)
			ctx.Equal(r.code, codes.Unauthenticated, "%s(n-1) with %s %q (%s)", method, bad.label, bad.md, r.details)
		}
	}
	ctx.Equal(n.stored(), notesSeed, "no unauthenticated call may delete anything: the notes")
}

func CheckPermissionDenied(ctx *harness.Ctx) {
	n := startNotes(ctx)
	r := n.call("DeleteNote", "n-2", "authorization", readerAuth)
	ctx.Equal(r.code, codes.PermissionDenied, "DeleteNote(n-2) with the reader token (%s): the token is known, it lacks notes.write", r.details)
	ctx.Equal(n.stored()["n-2"], notesSeed["n-2"], "a PermissionDenied delete must leave the note in the notes")
	read := n.call("GetNote", "n-2", "authorization", readerAuth)
	ctx.Assert(read.code == codes.OK && read.note.GetText() == notesSeed["n-2"], "after the refused delete the reader must still read n-2, got %v (%s)", read.code, read.details)
	for _, c := range [][2]string{{"ghost", "a missing note"}, {"", "an empty id"}} {
		r = n.call("DeleteNote", c[0], "authorization", readerAuth)
		ctx.Equal(r.code, codes.PermissionDenied, "the reader's DeleteNote of %s (%s): authorize before you validate or look up", c[1], r.details)
	}
	ctx.Equal(n.stored(), notesSeed, "the reader must not be able to delete anything: the notes")
}

func CheckAuthFirst(ctx *harness.Ctx) {
	n := startNotes(ctx)
	r := n.call("GetNote", "", "authorization", readerAuth)
	ctx.Equal(r.code, codes.InvalidArgument, "GetNote with an empty id and valid credentials (%s)", r.details)
	r = n.call("GetNote", "ghost", "authorization", readerAuth)
	ctx.Equal(r.code, codes.NotFound, "GetNote(ghost) with valid credentials (%s)", r.details)
	for _, bad := range []badCredential{badCredentials[0], badCredentials[2], badCredentials[6]} {
		for _, method := range []string{"GetNote", "DeleteNote"} {
			exists := n.call(method, "n-1", bad.md...)
			for _, c := range [][2]string{{"ghost", "a missing note"}, {"", "an empty id"}} {
				r = n.call(method, c[0], bad.md...)
				ctx.Equal(r.code, codes.Unauthenticated, "%s of %s with %s (%s): authenticate before you validate or look up", method, c[1], bad.label, r.details)
				ctx.Equal([]string{r.code.String(), r.details}, []string{exists.code.String(), exists.details}, "%s with %s must answer the same for %s as for an existing note; code and details", method, bad.label, c[1])
			}
		}
	}
	ctx.Equal(n.stored(), notesSeed, "no unauthenticated call may delete anything: the notes")
}

func CheckAdminDeletes(ctx *harness.Ctx) {
	n := startNotes(ctx)
	r := n.call("DeleteNote", "n-3", "authorization", adminAuth)
	ctx.Equal(r.code, codes.OK, "DeleteNote(n-3) with the admin token (%s)", r.details)
	ctx.Equal(r.deleted.GetDeleted(), true, "DeleteNote must answer Deleted: true, got %v", r.deleted)
	_, kept := n.stored()["n-3"]
	ctx.Assert(!kept, "after the admin's delete n-3 must be gone from the notes")
	ctx.Equal(n.stored(), map[string]string{"n-1": notesSeed["n-1"], "n-2": notesSeed["n-2"]}, "only n-3 may be deleted: the notes")
	for _, token := range []string{adminAuth, readerAuth} {
		r = n.call("GetNote", "n-3", "authorization", token)
		ctx.Equal(r.code, codes.NotFound, "GetNote(n-3) after the delete with %q (%s)", token, r.details)
	}
	r = n.call("DeleteNote", "n-3", "authorization", adminAuth)
	ctx.Equal(r.code, codes.NotFound, "deleting n-3 a second time (%s)", r.details)
	r = n.call("DeleteNote", "", "authorization", adminAuth)
	ctx.Equal(r.code, codes.InvalidArgument, "the admin's DeleteNote with an empty id (%s)", r.details)
}
`,
  },
  debrief: `The order of the gates is the whole design. Authentication answers "who is this?", and only a caller with an answer gets \`PERMISSION_DENIED\`, which says "I know you, and you may not". Validation and lookup come last because their answers carry information: \`NOT_FOUND\` against \`PERMISSION_DENIED\` tells an anonymous caller which ids exist, and an id space that can be probed for free is a leak even when the contents stay hidden. That is also why the auth failure has fixed details, independent of the request. Credentials ride in metadata rather than in the request message so that one helper (in production an interceptor, or a sidecar such as Envoy's ext_authz) can judge every RPC of every service the same way without knowing its messages. Real systems verify a signed token (a JWT checked against a JWKS, or an mTLS client certificate) instead of a lookup table, compare secrets in constant time, cache introspection results briefly, and log every denial with the caller's identity; some go further and answer \`NOT_FOUND\` instead of \`PERMISSION_DENIED\` when even the existence of a resource is private to its owner.`,
};
