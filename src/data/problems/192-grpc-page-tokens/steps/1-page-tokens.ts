import type {Step} from '@/lib/types';

// ---- 1. ListBooks with AIP-158 page tokens, keyset by book id -----------------------------------
export const pageTokensStep: Step = {
  id: 'page-tokens',
  title: 'ListBooks: page_size, an opaque token, keyset by id',
  concept: 'grpc',
  file: 'library_server',
  focus: ['clients', 'library'],
  task: `## Task

The catalogue lists a shelf's books over gRPC, one page at a time, by the rules of Google's
[AIP-158](https://google.aip.dev/158):

\`\`\`proto
package library.v1;

service Library {
  rpc ListBooks(ListBooksRequest) returns (ListBooksResponse);
}
message ListBooksRequest  { string shelf = 1; int32 page_size = 2; string page_token = 3; }
message Book              { string id = 1; string title = 2; }
message ListBooksResponse { repeated Book books = 1; string next_page_token = 2; }
\`\`\`

The store is the module-level \`SHELVES\`: shelf → {book id → title}. Other code adds and removes books
at any moment, including between two pages of one walk. Implement \`ListBooks\`, served on \`:9000\`, with
\`DEFAULT_PAGE_SIZE = 50\` and \`MAX_PAGE_SIZE = 100\`:

- An unknown shelf → **\`NOT_FOUND\`**.
- \`page_size < 0\` → **\`INVALID_ARGUMENT\`**. \`0\` means 50; anything above 100 is clamped to 100, not
  rejected.
- Books come in **ascending \`id\` order** (string order), each with its title.
- \`page_token\` \`""\` is the first page. Any other value must be a token this server issued: base64url
  (no padding) of a small JSON object carrying the **shelf** and the **last id returned**, for example
  \`{"shelf": "fiction", "after": "b-0050"}\`. The field names are yours; clients never look inside.
- A token that does not decode to such an object (bad base64, not JSON, not an object, a field missing)
  or that names another shelf → **\`INVALID_ARGUMENT\`**. An exception escaping the handler surfaces as
  \`UNKNOWN\`, which is wrong.
- A page holds the books with \`id > after\`, at most \`page_size\` of them, read from \`SHELVES\` **as it is
  now**. A book removed between calls shifts nothing, even when it is the token's own last id.
- \`next_page_token\` encodes the shelf and the last id on this page, and is set **only if more books
  follow it**. The last page carries \`""\`: a page of exactly the remaining books is the last one.

:::widget grpc-streams {"mode": "unary"}

> An offset says "skip n of whatever the list holds now"; a key says "everything after this book".
> Only the key survives a list that changes while someone walks it.`,
  sequence: {
    participants: ['Client', 'Library', 'Catalogue'],
    messages: [
      {from: 'Client', to: 'Library', label: 'ListBooks(fiction, page_size 5, page_token "")', kind: 'sync'},
      {
        from: 'Library',
        to: 'Client',
        label: 'b-0010 … b-0050 · next_page_token T1 = {fiction, after b-0050}',
        kind: 'reply',
      },
      {from: 'Catalogue', to: 'Library', label: 'remove b-0020, b-0030 (already listed)', kind: 'async'},
      {from: 'Client', to: 'Library', label: 'ListBooks(fiction, 5, T1)', kind: 'sync'},
      {from: 'Library', to: 'Library', label: 'id > b-0050, not "skip 5"', kind: 'sync'},
      {from: 'Library', to: 'Client', label: 'b-0060 … b-0100 · T2 = {fiction, after b-0100}', kind: 'reply'},
      {from: 'Client', to: 'Library', label: 'ListBooks(history, 5, T2)', kind: 'sync'},
      {from: 'Library', to: 'Client', label: 'INVALID_ARGUMENT · token issued for another shelf', kind: 'reply'},
      {from: 'Client', to: 'Library', label: 'ListBooks(fiction, 5, T4)', kind: 'sync'},
      {from: 'Library', to: 'Client', label: 'b-0160 … b-0200 · next_page_token ""', kind: 'reply'},
    ],
  },
  hints: [
    'Validate in order: shelf, then `page_size`, then the token. After rejecting negatives, `size = min(page_size or DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)`.',
    'Filter, sort, slice: `rest = sorted(i for i in books if i > after)`, `page = rest[:size]`. More books remain exactly when `len(rest) > size`; only then encode `(shelf, page[-1])`. Never look the cursor up by position: it may have been removed.',
    'Decode defensively: `json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))` raises `ValueError` for every kind of garbage, and a JSON list or number still needs an `isinstance(body, dict)` check. Compare the token\'s shelf with `request.shelf` before using its position.',
  ],
  checks: [
    {
      id: 'page-size',
      title: 'page_size 0 means 50 and anything above 100 is clamped to 100',
      detail:
        'On a shelf of 250 books, `page_size` 0 returns 50 books, 7 returns 7, 100, 101 and 500 return 100: the lowest ids in ascending order, each with its title, and a `next_page_token` because books remain.',
      match: {
        python: {all: [/DEFAULT_PAGE_SIZE\s*=\s*50\b/, /MAX_PAGE_SIZE\s*=\s*100\b/, /\bmin\([^\n]*MAX_PAGE_SIZE\s*\)/]},
        typescript: {
          all: [/DEFAULT_PAGE_SIZE\s*=\s*50\b/, /MAX_PAGE_SIZE\s*=\s*100\b/, /Math\.min\([^\n]*MAX_PAGE_SIZE\s*\)/],
        },
        go: {all: [/defaultPageSize\s*=\s*50\b/, /maxPageSize\s*=\s*100\b/, /\bmin\([^\n]*maxPageSize\s*\)/]},
        scala: {all: [/DefaultPageSize\s*=\s*50\b/, /MaxPageSize\s*=\s*100\b/, /math\.min\([^\n]*MaxPageSize\s*\)/]},
        cpp: {all: [/kDefaultPageSize\s*=\s*50\b/, /kMaxPageSize\s*=\s*100\b/, /std::min\([^\n]*kMaxPageSize\s*\)/]},
      },
    },
    {
      id: 'reject-bad-request',
      title: 'An unknown shelf is NOT_FOUND, a negative page_size is INVALID_ARGUMENT',
      detail:
        'Shelf `poetry` (and `""`) answers `NOT_FOUND`; `page_size` -1 and -100 answer `INVALID_ARGUMENT`, on the first page and with a valid token.',
      match: {
        python: {all: [/StatusCode\.NOT_FOUND/, /page_size\s*<\s*0/, /StatusCode\.INVALID_ARGUMENT/]},
        typescript: {all: [/status\.NOT_FOUND/, /(pageSize|page_size)\s*<\s*0/, /status\.INVALID_ARGUMENT/]},
        go: {all: [/codes\.NotFound/, /(GetPageSize\(\)|PageSize)\s*<\s*0/, /codes\.InvalidArgument/]},
        scala: {all: [/Status\.NOT_FOUND/, /pageSize\s*<\s*0/, /Status\.INVALID_ARGUMENT/]},
        cpp: {all: [/StatusCode::NOT_FOUND/, /page_size\(\)\s*<\s*0/, /StatusCode::INVALID_ARGUMENT/]},
      },
    },
    {
      id: 'full-walk',
      title: 'A full walk returns every book once, in order, and ends with an empty token',
      detail:
        '120 books at the default size come back as pages of 50, 50 and 20; 100 books at `page_size` 50 as exactly two pages, the second with `next_page_token` `""`; 3 books at size 1 as three pages; an empty shelf as one empty page with no token.',
      match: {
        python: {all: [/\bsorted\(/, /len\(\w+\)\s*>\s*size\b/]},
        typescript: {all: [/\.sort\(\)/, /\.length\s*>\s*size\b/]},
        go: {all: [/sort\.Strings\(|slices\.Sort\(/, /len\(\w+\)\s*>\s*size\b/]},
        scala: {all: [/\.sorted\b/, /\.(length|size)\s*>\s*size\b/]},
        cpp: {
          all: [
            /std::map<std::string,\s*std::map<std::string,\s*std::string>>/,
            /if\s*\(\s*\w+\s*!=\s*\w+\.end\(\)\s*\)\s*reply->set_next_page_token\(/,
          ],
        },
      },
    },
    {
      id: 'keyset',
      title: "Each page continues strictly after the token's last id, whatever changed in between",
      detail:
        "Two listed books removed, three added before the cursor, the cursor's own book removed and one added ahead of it: no book comes back twice, no book present throughout is skipped, the new one ahead is listed, and the walk stays in id order.",
      match: {
        python: {all: [/\w+\s*>\s*after\b/]},
        typescript: {all: [/\w+\s*>\s*after\b/]},
        go: {all: [/\w+\s*>\s*after\b/]},
        scala: {all: [/(_|\w+)\s*>\s*after\b/]},
        cpp: {all: [/\.upper_bound\(/]},
      },
    },
    {
      id: 'bound-to-shelf',
      title: 'A page token is bound to its shelf',
      detail:
        'A `fiction` token sent with shelf `history` (and the reverse) answers `INVALID_ARGUMENT`; each token still continues its own shelf, and neither is the raw last id.',
      match: {
        python: {all: [/json\.dumps\(\{[^\n]*["']shelf["']/, /!=\s*request\.shelf\b/]},
        typescript: {all: [/JSON\.stringify\(\{[^\n]*\bshelf\b/, /!==\s*shelf\b/]},
        go: {all: [/json:"shelf"/, /\.Shelf\s*!=\s*req\.GetShelf\(\)/]},
        scala: {all: [/"shelf"\s*->/, /(==|!=)\s*req\.shelf\b/]},
        cpp: {all: [/\{"shelf",\s*\w+\}/, /->first\s*!=\s*request->shelf\(\)/]},
      },
    },
    {
      id: 'malformed-token',
      title: 'A malformed page token is INVALID_ARGUMENT, never UNKNOWN',
      detail:
        '`not a token`, `%%%`, and base64url of `not json`, `[1, 2]`, `42`, `{}` and `"b-0010"` each answer `INVALID_ARGUMENT`; an empty token is still the first page.',
      match: {
        python: {all: [/base64\.urlsafe_b64decode\(/, /except\s*\(?[\w.,\s]*ValueError/]},
        typescript: {all: [/Buffer\.from\([^\n]*['"]base64url['"]\)/, /\bcatch\b/]},
        go: {all: [/base64\.RawURLEncoding\.DecodeString\(/, /json\.Unmarshal\(/]},
        scala: {all: [/Base64\.getUrlDecoder/, /\bTry\s*\{|\bcatch\b/]},
        cpp: {all: [/absl::WebSafeBase64Unescape\(/, /is_discarded\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio
import base64
import json

import grpc

import library_pb2
import library_pb2_grpc

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100

# shelf -> {book id -> title}. The catalogue adds and removes books at any time; ListBooks only reads.
SHELVES: dict[str, dict[str, str]] = {}


class LibraryService(library_pb2_grpc.LibraryServicer):
    async def ListBooks(self, request: library_pb2.ListBooksRequest, context: grpc.aio.ServicerContext) -> library_pb2.ListBooksResponse:
        # TODO: unknown shelf → NOT_FOUND; page_size < 0 → INVALID_ARGUMENT; 0 → DEFAULT_PAGE_SIZE; cap at MAX_PAGE_SIZE
        # TODO: page_token "" is the first page; otherwise decode base64url JSON {shelf, after}
        # TODO: malformed, or issued for another shelf → INVALID_ARGUMENT
        # TODO: the books with id > after, ascending, at most size of them
        # TODO: next_page_token = a token for (shelf, last id on the page) only while more books follow, else ""
        await context.abort(grpc.StatusCode.UNIMPLEMENTED, "not implemented")


async def serve() -> None:
    server = grpc.aio.server()
    library_pb2_grpc.add_LibraryServicer_to_server(LibraryService(), server)
    server.add_insecure_port("[::]:9000")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
`,
      solution: `import asyncio
import base64
import json

import grpc

import library_pb2
import library_pb2_grpc

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100

# shelf -> {book id -> title}. The catalogue adds and removes books at any time; ListBooks only reads.
SHELVES: dict[str, dict[str, str]] = {}


def encode_token(shelf: str, after: str) -> str:
    """Opaque to clients: base64url of {"shelf": …, "after": <the last id returned>}."""
    raw = json.dumps({"shelf": shelf, "after": after}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_token(token: str) -> tuple[str, str] | None:
    """(shelf, after) from a token this server issued, or None when it is not one."""
    try:
        body = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
    except ValueError:  # bad base64, bad UTF-8 and bad JSON are all ValueErrors
        return None
    if not isinstance(body, dict):
        return None
    shelf, after = body.get("shelf"), body.get("after")
    if not isinstance(shelf, str) or not isinstance(after, str) or not after:
        return None
    return shelf, after


class LibraryService(library_pb2_grpc.LibraryServicer):
    async def ListBooks(self, request: library_pb2.ListBooksRequest, context: grpc.aio.ServicerContext) -> library_pb2.ListBooksResponse:
        books = SHELVES.get(request.shelf)
        if books is None:
            await context.abort(grpc.StatusCode.NOT_FOUND, f"shelf {request.shelf!r} not found")
        if request.page_size < 0:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "page_size must not be negative")
        size = min(request.page_size or DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
        after = ""
        if request.page_token:
            token = decode_token(request.page_token)
            if token is None or token[0] != request.shelf:
                await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "page_token is malformed or was issued for another shelf")
            after = token[1]
        # Keyset: strictly after the last id returned, so books added or removed behind the cursor shift nothing.
        rest = sorted(book_id for book_id in books if book_id > after)
        page = rest[:size]
        # A token only while books remain past this page: the last page carries "".
        next_token = encode_token(request.shelf, page[-1]) if len(rest) > size else ""
        return library_pb2.ListBooksResponse(
            books=[library_pb2.Book(id=book_id, title=books[book_id]) for book_id in page],
            next_page_token=next_token,
        )


async def serve() -> None:
    server = grpc.aio.server()
    library_pb2_grpc.add_LibraryServicer_to_server(LibraryService(), server)
    server.add_insecure_port("[::]:9000")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/** shelf → (book id → title). The catalogue adds and removes books at any time; ListBooks only reads. */
export const SHELVES = new Map<string, Map<string, string>>();

interface ListBooksRequest {
  shelf: string;
  page_size: number;
  page_token: string;
}

interface Book {
  id: string;
  title: string;
}

interface ListBooksResponse {
  books: Book[];
  next_page_token: string;
}

export const libraryService = {
  ListBooks(
    call: grpc.ServerUnaryCall<ListBooksRequest, ListBooksResponse>,
    callback: grpc.sendUnaryData<ListBooksResponse>,
  ): void {
    // TODO: unknown shelf → NOT_FOUND; page_size < 0 → INVALID_ARGUMENT; 0 → DEFAULT_PAGE_SIZE; cap at MAX_PAGE_SIZE
    // TODO: page_token '' is the first page; otherwise decode base64url JSON {shelf, after}
    // TODO: malformed, or issued for another shelf → INVALID_ARGUMENT
    // TODO: the books with id > after, ascending, at most size of them
    // TODO: next_page_token = a token for (shelf, last id on the page) only while more books follow, else ''
    callback({code: grpc.status.UNIMPLEMENTED, details: 'not implemented'});
  },
};

const v1 = (grpc.loadPackageDefinition(protoLoader.loadSync('library.proto')).library as grpc.GrpcObject)
  .v1 as grpc.GrpcObject;
const Library = v1.Library as grpc.ServiceClientConstructor;

export const server = new grpc.Server();
server.addService(Library.service, libraryService);

export function serve(): void {
  server.bindAsync('0.0.0.0:9000', grpc.ServerCredentials.createInsecure(), () => server.start());
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/** shelf → (book id → title). The catalogue adds and removes books at any time; ListBooks only reads. */
export const SHELVES = new Map<string, Map<string, string>>();

interface ListBooksRequest {
  shelf: string;
  page_size: number;
  page_token: string;
}

interface Book {
  id: string;
  title: string;
}

interface ListBooksResponse {
  books: Book[];
  next_page_token: string;
}

/** Opaque to clients: base64url of {"shelf": …, "after": <the last id returned>}. */
const encodeToken = (shelf: string, after: string): string =>
  Buffer.from(JSON.stringify({shelf, after})).toString('base64url');

/** {shelf, after} from a token this server issued, or null when it is not one. */
function decodeToken(token: string): {shelf: string; after: string} | null {
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return null; // bad base64 or bad JSON
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const {shelf, after} = body as Record<string, unknown>;
  return typeof shelf === 'string' && typeof after === 'string' && after !== '' ? {shelf, after} : null;
}

export const libraryService = {
  ListBooks(
    call: grpc.ServerUnaryCall<ListBooksRequest, ListBooksResponse>,
    callback: grpc.sendUnaryData<ListBooksResponse>,
  ): void {
    const {shelf, page_size: pageSize, page_token: pageToken} = call.request;
    const books = SHELVES.get(shelf);
    if (books === undefined) {
      callback({code: grpc.status.NOT_FOUND, details: \`shelf \${shelf} not found\`});
      return;
    }
    if (pageSize < 0) {
      callback({code: grpc.status.INVALID_ARGUMENT, details: 'page_size must not be negative'});
      return;
    }
    const size = Math.min(pageSize || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    let after = '';
    if (pageToken !== '') {
      const token = decodeToken(pageToken);
      if (token === null || token.shelf !== shelf) {
        callback({code: grpc.status.INVALID_ARGUMENT, details: 'page_token is malformed or was issued for another shelf'});
        return;
      }
      after = token.after;
    }
    // Keyset: strictly after the last id returned, so books added or removed behind the cursor shift nothing.
    const rest = [...books.keys()].filter(id => id > after).sort();
    const page = rest.slice(0, size);
    // A token only while books remain past this page: the last page carries ''.
    const nextPageToken = rest.length > size ? encodeToken(shelf, page[page.length - 1]) : '';
    callback(null, {books: page.map(id => ({id, title: books.get(id) ?? ''})), next_page_token: nextPageToken});
  },
};

const v1 = (grpc.loadPackageDefinition(protoLoader.loadSync('library.proto')).library as grpc.GrpcObject)
  .v1 as grpc.GrpcObject;
const Library = v1.Library as grpc.ServiceClientConstructor;

export const server = new grpc.Server();
server.addService(Library.service, libraryService);

export function serve(): void {
  server.bindAsync('0.0.0.0:9000', grpc.ServerCredentials.createInsecure(), () => server.start());
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

	pb "library/gen/library"
)

const (
	defaultPageSize = 50
	maxPageSize     = 100
)

// shelves maps shelf → book id → title. The catalogue adds and removes books under mu; ListBooks only reads.
var (
	mu      sync.RWMutex
	shelves = map[string]map[string]string{}
)

type libraryServer struct {
	pb.UnimplementedLibraryServer
}

func (s *libraryServer) ListBooks(ctx context.Context, req *pb.ListBooksRequest) (*pb.ListBooksResponse, error) {
	// TODO: unknown shelf → codes.NotFound; PageSize < 0 → codes.InvalidArgument; 0 → defaultPageSize; cap at maxPageSize
	// TODO: PageToken "" is the first page; otherwise decode base64url JSON {shelf, after}
	// TODO: malformed, or issued for another shelf → codes.InvalidArgument
	// TODO: the books with id > after, ascending, at most size of them
	// TODO: NextPageToken = a token for (shelf, last id on the page) only while more books follow, else ""
	return nil, status.Error(codes.Unimplemented, "not implemented")
}

func main() {
	lis, _ := net.Listen("tcp", ":9000")
	srv := grpc.NewServer()
	pb.RegisterLibraryServer(srv, &libraryServer{})
	log.Fatal(srv.Serve(lis))
}
`,
      solution: `package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"net"
	"sort"
	"sync"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "library/gen/library"
)

const (
	defaultPageSize = 50
	maxPageSize     = 100
)

// shelves maps shelf → book id → title. The catalogue adds and removes books under mu; ListBooks only reads.
var (
	mu      sync.RWMutex
	shelves = map[string]map[string]string{}
)

// pageToken is opaque to clients: base64url of its JSON.
type pageToken struct {
	Shelf string \`json:"shelf"\`
	After string \`json:"after"\` // the last id returned
}

func encodeToken(shelf, after string) string {
	raw, _ := json.Marshal(pageToken{Shelf: shelf, After: after})
	return base64.RawURLEncoding.EncodeToString(raw)
}

// decodeToken returns the token this server issued, or false when it is not one.
func decodeToken(token string) (pageToken, bool) {
	var t pageToken
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || json.Unmarshal(raw, &t) != nil || t.Shelf == "" || t.After == "" {
		return pageToken{}, false
	}
	return t, true
}

type libraryServer struct {
	pb.UnimplementedLibraryServer
}

func (s *libraryServer) ListBooks(ctx context.Context, req *pb.ListBooksRequest) (*pb.ListBooksResponse, error) {
	mu.RLock()
	defer mu.RUnlock()
	books, ok := shelves[req.GetShelf()]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "shelf %q not found", req.GetShelf())
	}
	if req.GetPageSize() < 0 {
		return nil, status.Error(codes.InvalidArgument, "page_size must not be negative")
	}
	size := int(req.GetPageSize())
	if size == 0 {
		size = defaultPageSize
	}
	size = min(size, maxPageSize)
	after := ""
	if req.GetPageToken() != "" {
		t, ok := decodeToken(req.GetPageToken())
		if !ok || t.Shelf != req.GetShelf() {
			return nil, status.Error(codes.InvalidArgument, "page_token is malformed or was issued for another shelf")
		}
		after = t.After
	}
	// Keyset: strictly after the last id returned, so books added or removed behind the cursor shift nothing.
	rest := make([]string, 0, len(books))
	for id := range books {
		if id > after {
			rest = append(rest, id)
		}
	}
	sort.Strings(rest)
	page := rest[:min(size, len(rest))]
	reply := &pb.ListBooksResponse{Books: make([]*pb.Book, 0, len(page))}
	for _, id := range page {
		reply.Books = append(reply.Books, &pb.Book{Id: id, Title: books[id]})
	}
	// A token only while books remain past this page: the last page carries "".
	if len(rest) > size {
		reply.NextPageToken = encodeToken(req.GetShelf(), page[len(page)-1])
	}
	return reply, nil
}

func main() {
	lis, _ := net.Listen("tcp", ":9000")
	srv := grpc.NewServer()
	pb.RegisterLibraryServer(srv, &libraryServer{})
	log.Fatal(srv.Serve(lis))
}
`,
    },
    scala: {
      starter: `import io.grpc.{ServerBuilder, Status}
import library.v1.library.{Book, LibraryGrpc, ListBooksRequest, ListBooksResponse}
import scala.collection.concurrent.TrieMap
import scala.concurrent.{ExecutionContext, Future}

object LibraryServer extends LibraryGrpc.Library {
  val DefaultPageSize = 50
  val MaxPageSize = 100

  /** shelf → book id → title. The catalogue adds and removes books at any time; listBooks only reads. */
  val Shelves = TrieMap.empty[String, TrieMap[String, String]]

  override def listBooks(req: ListBooksRequest): Future[ListBooksResponse] = {
    // TODO: unknown shelf → Status.NOT_FOUND; pageSize < 0 → Status.INVALID_ARGUMENT; 0 → DefaultPageSize; cap at MaxPageSize
    // TODO: pageToken "" is the first page; otherwise decode base64url JSON {shelf, after}
    // TODO: malformed, or issued for another shelf → Status.INVALID_ARGUMENT
    // TODO: the books with id > after, ascending, at most size of them
    // TODO: nextPageToken = a token for (shelf, last id on the page) only while more books follow, else ""
    Future.failed(Status.UNIMPLEMENTED.asRuntimeException())
  }

  def main(args: Array[String]): Unit =
    ServerBuilder.forPort(9000).addService(LibraryGrpc.bindService(this, ExecutionContext.global)).build().start().awaitTermination()
}
`,
      solution: `import io.grpc.{ServerBuilder, Status}
import library.v1.library.{Book, LibraryGrpc, ListBooksRequest, ListBooksResponse}
import java.nio.charset.StandardCharsets.UTF_8
import java.util.Base64
import scala.collection.concurrent.TrieMap
import scala.concurrent.{ExecutionContext, Future}
import scala.util.Try

object LibraryServer extends LibraryGrpc.Library {
  val DefaultPageSize = 50
  val MaxPageSize = 100

  /** shelf → book id → title. The catalogue adds and removes books at any time; listBooks only reads. */
  val Shelves = TrieMap.empty[String, TrieMap[String, String]]

  /** Opaque to clients: base64url of {"shelf": …, "after": <the last id returned>}. */
  def encodeToken(shelf: String, after: String): String =
    Base64.getUrlEncoder.withoutPadding.encodeToString(ujson.write(ujson.Obj("shelf" -> shelf, "after" -> after)).getBytes(UTF_8))

  /** (shelf, after) from a token this server issued, or None when it is not one. */
  def decodeToken(token: String): Option[(String, String)] =
    Try {
      val body = ujson.read(new String(Base64.getUrlDecoder.decode(token), UTF_8))
      (body("shelf").str, body("after").str)
    }.toOption.filter(_._2.nonEmpty)

  private def invalid(message: String): Future[ListBooksResponse] =
    Future.failed(Status.INVALID_ARGUMENT.withDescription(message).asRuntimeException())

  override def listBooks(req: ListBooksRequest): Future[ListBooksResponse] = {
    val books = Shelves.get(req.shelf) match {
      case Some(b) => b
      case None    => return Future.failed(Status.NOT_FOUND.withDescription(s"shelf \${req.shelf} not found").asRuntimeException())
    }
    if (req.pageSize < 0) return invalid("page_size must not be negative")
    val size = math.min(if (req.pageSize == 0) DefaultPageSize else req.pageSize, MaxPageSize)
    val after =
      if (req.pageToken.isEmpty) ""
      else
        decodeToken(req.pageToken) match {
          case Some((shelf, last)) if shelf == req.shelf => last
          case _                                         => return invalid("page_token is malformed or was issued for another shelf")
        }
    // Keyset: strictly after the last id returned, so books added or removed behind the cursor shift nothing.
    val rest = books.keys.filter(_ > after).toVector.sorted
    val page = rest.take(size)
    // A token only while books remain past this page: the last page carries "".
    val next = if (rest.length > size) encodeToken(req.shelf, page.last) else ""
    Future.successful(ListBooksResponse(page.map(id => Book(id, books.getOrElse(id, ""))), next))
  }

  def main(args: Array[String]): Unit =
    ServerBuilder.forPort(9000).addService(LibraryGrpc.bindService(this, ExecutionContext.global)).build().start().awaitTermination()
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <map>
#include <shared_mutex>
#include <string>

#include "library.grpc.pb.h"

using library::v1::Book;
using library::v1::ListBooksRequest;
using library::v1::ListBooksResponse;

constexpr int kDefaultPageSize = 50;
constexpr int kMaxPageSize = 100;

// shelf -> book id -> title, ordered by id. The catalogue writes it under shelves_mu; ListBooks only reads.
std::shared_mutex shelves_mu;
std::map<std::string, std::map<std::string, std::string>> SHELVES;

class LibraryImpl final : public library::v1::Library::Service {
 public:
  grpc::Status ListBooks(grpc::ServerContext*, const ListBooksRequest* request, ListBooksResponse* reply) override {
    // TODO: unknown shelf → NOT_FOUND; page_size() < 0 → INVALID_ARGUMENT; 0 → kDefaultPageSize; cap at kMaxPageSize
    // TODO: page_token() "" is the first page; otherwise decode base64url JSON {shelf, after}
    // TODO: malformed, or issued for another shelf → INVALID_ARGUMENT
    // TODO: the books with id > after, ascending, at most size of them
    // TODO: next_page_token = a token for (shelf, last id on the page) only while more books follow, else ""
    return grpc::Status(grpc::StatusCode::UNIMPLEMENTED, "not implemented");
  }
};

int main() {
  LibraryImpl service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:9000", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
      solution: `#include <absl/strings/escaping.h>
#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <string>
#include <utility>

#include "library.grpc.pb.h"

using library::v1::Book;
using library::v1::ListBooksRequest;
using library::v1::ListBooksResponse;

constexpr int kDefaultPageSize = 50;
constexpr int kMaxPageSize = 100;

// shelf -> book id -> title, ordered by id. The catalogue writes it under shelves_mu; ListBooks only reads.
std::shared_mutex shelves_mu;
std::map<std::string, std::map<std::string, std::string>> SHELVES;

// Opaque to clients: base64url of {"shelf": …, "after": <the last id returned>}.
std::string encode_token(const std::string& shelf, const std::string& after) {
  return absl::WebSafeBase64Escape(nlohmann::json{{"shelf", shelf}, {"after", after}}.dump());
}

// {shelf, after} from a token this server issued, or nullopt when it is not one.
std::optional<std::pair<std::string, std::string>> decode_token(const std::string& token) {
  std::string raw;
  if (!absl::WebSafeBase64Unescape(token, &raw)) return std::nullopt;
  const auto body = nlohmann::json::parse(raw, nullptr, /*allow_exceptions=*/false);
  if (body.is_discarded() || !body.is_object()) return std::nullopt;
  const auto shelf = body.find("shelf");
  const auto after = body.find("after");
  if (shelf == body.end() || after == body.end() || !shelf->is_string() || !after->is_string()) return std::nullopt;
  auto last = after->get<std::string>();
  if (last.empty()) return std::nullopt;
  return std::make_pair(shelf->get<std::string>(), std::move(last));
}

class LibraryImpl final : public library::v1::Library::Service {
 public:
  grpc::Status ListBooks(grpc::ServerContext*, const ListBooksRequest* request, ListBooksResponse* reply) override {
    std::shared_lock lock(shelves_mu);
    const auto shelf = SHELVES.find(request->shelf());
    if (shelf == SHELVES.end()) return grpc::Status(grpc::StatusCode::NOT_FOUND, "shelf " + request->shelf() + " not found");
    if (request->page_size() < 0) return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "page_size must not be negative");
    const int size = std::min(request->page_size() == 0 ? kDefaultPageSize : request->page_size(), kMaxPageSize);
    const auto& books = shelf->second;
    auto it = books.begin();
    if (!request->page_token().empty()) {
      const auto token = decode_token(request->page_token());
      if (!token || token->first != request->shelf())
        return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "page_token is malformed or was issued for another shelf");
      it = books.upper_bound(token->second);  // keyset: strictly after the last id returned
    }
    for (int n = 0; n < size && it != books.end(); ++n, ++it) {
      Book* book = reply->add_books();
      book->set_id(it->first);
      book->set_title(it->second);
    }
    // A token only while books remain past this page: the last page carries "".
    if (it != books.end()) reply->set_next_page_token(encode_token(request->shelf(), reply->books(reply->books_size() - 1).id()));
    return grpc::Status::OK;
  }
};

int main() {
  LibraryImpl service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:9000", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
    },
  },
  harness: {
    python: `import asyncio
import base64

import grpc

import library_pb2
import library_pb2_grpc

METHOD = "/library.v1.Library/ListBooks"
OK = grpc.StatusCode.OK
NOT_FOUND = grpc.StatusCode.NOT_FOUND
INVALID_ARGUMENT = grpc.StatusCode.INVALID_ARGUMENT
UNKNOWN = grpc.StatusCode.UNKNOWN


def _ids(n, step=1):
    """b-0001, b-0002, … (or b-0010, b-0020, … with step 10)."""
    return [f"b-{(i + 1) * step:04d}" for i in range(n)]


def _scrambled(ids):
    """The same ids in an order that is neither ascending nor descending: the service must sort."""
    return [ids[i] for r in range(3) for i in range(r, len(ids), 3)][::-1]


def _shelf(ids):
    return {book_id: f"Title {book_id}" for book_id in _scrambled(ids)}


def _show(ids):
    ids = list(ids)
    return repr(ids) if len(ids) <= 6 else f"{len(ids)} books {ids[:3]} … {ids[-2:]}"


def _b64(text):
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


async def _start(ctx, shelves):
    """The learner's server running, SHELVES seeded in place, and a stub on it."""
    m = ctx.load("library_server")
    m.SHELVES.clear()
    for name, ids in shelves.items():
        m.SHELVES[name] = _shelf(ids)
    asyncio.create_task(m.serve())
    await asyncio.sleep(0)
    assert ctx.grpc.find(METHOD) is not None, "serve() must register the Library servicer (add_LibraryServicer_to_server) and start the server"
    return m, library_pb2_grpc.LibraryStub(grpc.aio.insecure_channel("library:9000"))


def _call(stub, shelf, page_size=0, page_token=""):
    return stub.ListBooks(library_pb2.ListBooksRequest(shelf=shelf, page_size=page_size, page_token=page_token), timeout=2.0)


async def _list(stub, shelf, page_size=0, page_token=""):
    try:
        return await _call(stub, shelf, page_size, page_token)
    except grpc.RpcError as e:
        raise AssertionError(f"ListBooks(shelf={shelf!r}, page_size={page_size}, page_token={page_token!r}) failed with {e.code().name}: {e.details()}")


async def _code(stub, shelf, page_size=0, page_token=""):
    try:
        await _call(stub, shelf, page_size, page_token)
    except grpc.RpcError as e:
        return e.code()
    return OK


def _book_ids(reply):
    return [b.id for b in reply.books]


async def _walk(stub, shelf, page_size, page_token=""):
    """Every page from page_token to the one carrying next_page_token ""."""
    pages = []
    for _ in range(20):
        reply = await _list(stub, shelf, page_size, page_token)
        pages.append(_book_ids(reply))
        page_token = reply.next_page_token
        if not page_token:
            return pages
    raise AssertionError(f"shelf {shelf!r} at page_size {page_size}: still a next_page_token after 20 pages, sizes {[len(p) for p in pages]}")


async def check_page_size(ctx):
    _, stub = await _start(ctx, {"fiction": _ids(250)})
    every = _ids(250)
    for size, want in ((0, 50), (7, 7), (100, 100), (101, 100), (500, 100)):
        reply = await _list(stub, "fiction", size)
        got = _book_ids(reply)
        assert len(got) == want, f"page_size {size} on a shelf of 250 books must return {want} books, got {len(got)}"
        assert got == every[:want], f"page_size {size}: the first page is the {want} lowest ids in ascending order ({every[0]} to {every[want - 1]}), got {_show(got)}"
        assert reply.next_page_token, f"page_size {size}: {250 - want} books remain after the first page, so next_page_token must not be empty"
    first = (await _list(stub, "fiction", 1)).books[0]
    assert first.title == "Title b-0001", f"each Book carries its title from SHELVES: expected 'Title b-0001', got {first.title!r}"


async def check_reject_bad_request(ctx):
    _, stub = await _start(ctx, {"fiction": _ids(20)})
    for shelf, size in (("poetry", 0), ("poetry", 10), ("", 0)):
        code = await _code(stub, shelf, size)
        assert code == NOT_FOUND, f"shelf {shelf!r} does not exist: expected NOT_FOUND, got {code.name}"
    for size in (-1, -100):
        code = await _code(stub, "fiction", size)
        assert code == INVALID_ARGUMENT, f"page_size {size} must be INVALID_ARGUMENT, got {code.name}"
    token = (await _list(stub, "fiction", 5)).next_page_token
    assert token, "5 of 20 books listed: next_page_token must not be empty"
    code = await _code(stub, "fiction", -1, token)
    assert code == INVALID_ARGUMENT, f"page_size -1 with a valid page_token must be INVALID_ARGUMENT too, got {code.name}"


async def check_full_walk(ctx):
    _, stub = await _start(ctx, {"fiction": _ids(120), "history": _ids(100), "trilogy": _ids(3), "empty": []})
    pages = await _walk(stub, "fiction", 0)
    sizes = [len(p) for p in pages]
    assert sizes == [50, 50, 20], f"120 books at the default page size are pages of [50, 50, 20], got {sizes}"
    flat = [i for p in pages for i in p]
    assert flat == _ids(120), f"the walk must return every book once in ascending id order, got {_show(flat)}"
    pages = await _walk(stub, "history", 50)
    sizes = [len(p) for p in pages]
    assert sizes == [50, 50], f"100 books at page_size 50 are exactly two pages, the second with next_page_token \\"\\" because nothing follows it; got pages of {sizes}"
    assert [i for p in pages for i in p] == _ids(100), "the history walk must return b-0001 to b-0100 in order"
    pages = await _walk(stub, "trilogy", 1)
    assert pages == [["b-0001"], ["b-0002"], ["b-0003"]], f"3 books at page_size 1 are three pages of one, got {pages}"
    reply = await _list(stub, "empty")
    assert list(reply.books) == [] and reply.next_page_token == "", f"an empty shelf is one empty page with next_page_token \\"\\", got {_book_ids(reply)} and {reply.next_page_token!r}"


async def check_keyset(ctx):
    m, stub = await _start(ctx, {"fiction": _ids(20, 10)})  # b-0010 … b-0200
    books = m.SHELVES["fiction"]
    page = await _list(stub, "fiction", 5)
    seen = _book_ids(page)
    assert seen == ["b-0010", "b-0020", "b-0030", "b-0040", "b-0050"], f"page 1 at page_size 5 is b-0010 to b-0050, got {seen}"
    # Two books already listed are removed: an offset into the shorter list would skip b-0060 and b-0070.
    del books["b-0020"], books["b-0030"]
    page = await _list(stub, "fiction", 5, page.next_page_token)
    got = _book_ids(page)
    assert got == ["b-0060", "b-0070", "b-0080", "b-0090", "b-0100"], f"b-0020 and b-0030 (already listed) were removed: page 2 must continue after b-0050 with b-0060 to b-0100, got {got} (an offset skips survivors)"
    seen += got
    # Three books added before the cursor, and the cursor's own book removed: an offset would repeat books.
    for book_id in ("b-0005", "b-0025", "b-0045"):
        books[book_id] = f"Title {book_id}"
    del books["b-0100"]
    page = await _list(stub, "fiction", 5, page.next_page_token)
    got = _book_ids(page)
    assert got == ["b-0110", "b-0120", "b-0130", "b-0140", "b-0150"], f"three books were added before the cursor and the cursor's own book (b-0100) was removed: page 3 must continue strictly after b-0100 with b-0110 to b-0150, got {got}"
    seen += got
    # A book added ahead of the cursor is simply part of the rest of the walk.
    books["b-0155"] = "Title b-0155"
    rest = [i for p in await _walk(stub, "fiction", 5, page.next_page_token) for i in p]
    assert rest == ["b-0155", "b-0160", "b-0170", "b-0180", "b-0190", "b-0200"], f"the rest of the walk is everything now after b-0150 (b-0155 was added ahead of the cursor), got {rest}"
    seen += rest
    twice = sorted({i for i in seen if seen.count(i) > 1})
    assert not twice, f"no book may come back twice in one walk, but {twice} did"
    survivors = [i for i in _ids(20, 10) if i not in ("b-0020", "b-0030", "b-0100")]
    missing = [i for i in survivors if i not in seen]
    assert not missing, f"every book present for the whole walk must be listed, but {missing} never was"
    assert seen == sorted(seen), f"one walk lists books in ascending id order, got {_show(seen)}"


async def check_bound_to_shelf(ctx):
    _, stub = await _start(ctx, {"fiction": _ids(30), "history": _ids(30)})
    fiction = await _list(stub, "fiction", 10)
    token = fiction.next_page_token
    assert token, "10 of 30 fiction books listed: next_page_token must not be empty"
    assert token not in ("b-0010", "b-0011", "10"), f"the token must be opaque and carry the shelf, not the bare position {token!r}"
    code = await _code(stub, "history", 10, token)
    assert code == INVALID_ARGUMENT, f"a token issued for shelf 'fiction' sent with shelf 'history' must be INVALID_ARGUMENT, got {code.name}"
    got = _book_ids(await _list(stub, "fiction", 10, token))
    assert got == _ids(20)[10:], f"the fiction token still continues fiction with b-0011 to b-0020, got {got}"
    history = await _list(stub, "history", 10)
    code = await _code(stub, "fiction", 10, history.next_page_token)
    assert code == INVALID_ARGUMENT, f"a token issued for shelf 'history' sent with shelf 'fiction' must be INVALID_ARGUMENT, got {code.name}"
    got = _book_ids(await _list(stub, "history", 10, history.next_page_token))
    assert got == _ids(20)[10:], f"the history token still continues history with b-0011 to b-0020, got {got}"


async def check_malformed_token(ctx):
    _, stub = await _start(ctx, {"fiction": _ids(30)})
    for token in ("not a token", "%%%", _b64("not json"), _b64("[1, 2]"), _b64("42"), _b64("{}"), _b64('"b-0010"')):
        code = await _code(stub, "fiction", 10, token)
        hint = " (an exception escaped the handler)" if code == UNKNOWN else ""
        assert code == INVALID_ARGUMENT, f"page_token {token!r} is not a token this server issued: expected INVALID_ARGUMENT, got {code.name}{hint}"
    got = _book_ids(await _list(stub, "fiction", 10, ""))
    assert got == _ids(10), f"an empty page_token is the first page, b-0001 to b-0010, got {got}"
`,
    typescript: `import * as grpc from '@grpc/grpc-js';

const STATUS_NAME = Object.fromEntries(Object.entries(grpc.status).map(([k, v]) => [v, k]));

/** b-0001, b-0002, … (or b-0010, b-0020, … with step 10). */
const ids = (n: number, step = 1): string[] =>
  Array.from({length: n}, (_, i) => \`b-\${String((i + 1) * step).padStart(4, '0')}\`);

/** The same ids in an order that is neither ascending nor descending: the service must sort. */
const scrambled = (list: string[]): string[] => [0, 1, 2].flatMap(r => list.filter((_, i) => i % 3 === r)).reverse();

const shelfOf = (list: string[]): Map<string, string> => new Map(scrambled(list).map(id => [id, \`Title \${id}\`]));

const show = (list: string[]): string =>
  list.length <= 6 ? JSON.stringify(list) : \`\${list.length} books \${JSON.stringify(list.slice(0, 3))} … \${JSON.stringify(list.slice(-2))}\`;

const b64 = (text: string): string => Buffer.from(text).toString('base64url');

/** The learner's server running, SHELVES seeded in place, and a client on it. */
function start(ctx, shelves: Record<string, string[]>) {
  const m = ctx.load('library_server');
  m.SHELVES.clear();
  for (const [name, list] of Object.entries(shelves)) m.SHELVES.set(name, shelfOf(list));
  m.serve();
  const pkg = ctx.proto('library.proto');
  const client = new pkg.library.v1.Library('library:9000', grpc.credentials.createInsecure());
  return {m, client};
}

const call = (client, shelf: string, pageSize = 0, pageToken = '') =>
  client.ListBooks({shelf, page_size: pageSize, page_token: pageToken}, {deadline: Date.now() + 2000});

async function list(client, shelf: string, pageSize = 0, pageToken = '') {
  try {
    return await call(client, shelf, pageSize, pageToken);
  } catch (e) {
    assert.fail(
      \`ListBooks(shelf=\${JSON.stringify(shelf)}, page_size=\${pageSize}, page_token=\${JSON.stringify(pageToken)}) failed with \${STATUS_NAME[e?.code] ?? e?.code}: \${e?.details ?? e?.message ?? e}\`,
    );
  }
}

async function code(client, shelf: string, pageSize = 0, pageToken = ''): Promise<string> {
  try {
    await call(client, shelf, pageSize, pageToken);
  } catch (e) {
    return STATUS_NAME[e?.code] ?? String(e?.code);
  }
  return 'OK';
}

const bookIds = (reply): string[] => (reply?.books ?? []).map(b => b.id);

/** Every page from pageToken to the one carrying next_page_token ''. */
async function walk(client, shelf: string, pageSize: number, pageToken = ''): Promise<string[][]> {
  const pages: string[][] = [];
  for (let n = 0; n < 20; n++) {
    const reply = await list(client, shelf, pageSize, pageToken);
    pages.push(bookIds(reply));
    pageToken = reply.next_page_token;
    if (!pageToken) return pages;
  }
  assert.fail(
    \`shelf \${JSON.stringify(shelf)} at page_size \${pageSize}: still a next_page_token after 20 pages, sizes \${JSON.stringify(pages.map(p => p.length))}\`,
  );
}

export async function check_page_size(ctx) {
  const {client} = start(ctx, {fiction: ids(250)});
  const every = ids(250);
  for (const [size, want] of [[0, 50], [7, 7], [100, 100], [101, 100], [500, 100]]) {
    const reply = await list(client, 'fiction', size);
    const got = bookIds(reply);
    assert.equal(got.length, want, \`page_size \${size} on a shelf of 250 books must return \${want} books, got \${got.length}\`);
    assert.deepEqual(got, every.slice(0, want), \`page_size \${size}: the first page is the \${want} lowest ids in ascending order (\${every[0]} to \${every[want - 1]}), got \${show(got)}\`);
    assert(reply.next_page_token, \`page_size \${size}: \${250 - want} books remain after the first page, so next_page_token must not be empty\`);
  }
  const first = (await list(client, 'fiction', 1)).books[0];
  assert.equal(first?.title, 'Title b-0001', \`each Book carries its title from SHELVES: expected 'Title b-0001', got \${JSON.stringify(first?.title)}\`);
}

export async function check_reject_bad_request(ctx) {
  const {client} = start(ctx, {fiction: ids(20)});
  for (const [shelf, size] of [['poetry', 0], ['poetry', 10], ['', 0]] as const) {
    const got = await code(client, shelf, size);
    assert.equal(got, 'NOT_FOUND', \`shelf \${JSON.stringify(shelf)} does not exist: expected NOT_FOUND, got \${got}\`);
  }
  for (const size of [-1, -100]) {
    const got = await code(client, 'fiction', size);
    assert.equal(got, 'INVALID_ARGUMENT', \`page_size \${size} must be INVALID_ARGUMENT, got \${got}\`);
  }
  const token = (await list(client, 'fiction', 5)).next_page_token;
  assert(token, '5 of 20 books listed: next_page_token must not be empty');
  const got = await code(client, 'fiction', -1, token);
  assert.equal(got, 'INVALID_ARGUMENT', \`page_size -1 with a valid page_token must be INVALID_ARGUMENT too, got \${got}\`);
}

export async function check_full_walk(ctx) {
  const {client} = start(ctx, {fiction: ids(120), history: ids(100), trilogy: ids(3), empty: []});
  let pages = await walk(client, 'fiction', 0);
  let sizes = pages.map(p => p.length);
  assert.deepEqual(sizes, [50, 50, 20], \`120 books at the default page size are pages of [50, 50, 20], got \${JSON.stringify(sizes)}\`);
  const flat = pages.flat();
  assert.deepEqual(flat, ids(120), \`the walk must return every book once in ascending id order, got \${show(flat)}\`);
  pages = await walk(client, 'history', 50);
  sizes = pages.map(p => p.length);
  assert.deepEqual(sizes, [50, 50], \`100 books at page_size 50 are exactly two pages, the second with next_page_token "" because nothing follows it; got pages of \${JSON.stringify(sizes)}\`);
  assert.deepEqual(pages.flat(), ids(100), 'the history walk must return b-0001 to b-0100 in order');
  pages = await walk(client, 'trilogy', 1);
  assert.deepEqual(pages, [['b-0001'], ['b-0002'], ['b-0003']], \`3 books at page_size 1 are three pages of one, got \${JSON.stringify(pages)}\`);
  const reply = await list(client, 'empty');
  assert(bookIds(reply).length === 0 && reply.next_page_token === '', \`an empty shelf is one empty page with next_page_token "", got \${JSON.stringify(bookIds(reply))} and \${JSON.stringify(reply.next_page_token)}\`);
}

export async function check_keyset(ctx) {
  const {m, client} = start(ctx, {fiction: ids(20, 10)}); // b-0010 … b-0200
  const books = m.SHELVES.get('fiction');
  let page = await list(client, 'fiction', 5);
  const seen = bookIds(page);
  assert.deepEqual(seen, ['b-0010', 'b-0020', 'b-0030', 'b-0040', 'b-0050'], \`page 1 at page_size 5 is b-0010 to b-0050, got \${JSON.stringify(seen)}\`);
  // Two books already listed are removed: an offset into the shorter list would skip b-0060 and b-0070.
  books.delete('b-0020');
  books.delete('b-0030');
  page = await list(client, 'fiction', 5, page.next_page_token);
  let got = bookIds(page);
  assert.deepEqual(got, ['b-0060', 'b-0070', 'b-0080', 'b-0090', 'b-0100'], \`b-0020 and b-0030 (already listed) were removed: page 2 must continue after b-0050 with b-0060 to b-0100, got \${JSON.stringify(got)} (an offset skips survivors)\`);
  seen.push(...got);
  // Three books added before the cursor, and the cursor's own book removed: an offset would repeat books.
  for (const id of ['b-0005', 'b-0025', 'b-0045']) books.set(id, \`Title \${id}\`);
  books.delete('b-0100');
  page = await list(client, 'fiction', 5, page.next_page_token);
  got = bookIds(page);
  assert.deepEqual(got, ['b-0110', 'b-0120', 'b-0130', 'b-0140', 'b-0150'], \`three books were added before the cursor and the cursor's own book (b-0100) was removed: page 3 must continue strictly after b-0100 with b-0110 to b-0150, got \${JSON.stringify(got)}\`);
  seen.push(...got);
  // A book added ahead of the cursor is simply part of the rest of the walk.
  books.set('b-0155', 'Title b-0155');
  const rest = (await walk(client, 'fiction', 5, page.next_page_token)).flat();
  assert.deepEqual(rest, ['b-0155', 'b-0160', 'b-0170', 'b-0180', 'b-0190', 'b-0200'], \`the rest of the walk is everything now after b-0150 (b-0155 was added ahead of the cursor), got \${JSON.stringify(rest)}\`);
  seen.push(...rest);
  const twice = [...new Set(seen.filter((id, i) => seen.indexOf(id) !== i))].sort();
  assert.deepEqual(twice, [], \`no book may come back twice in one walk, but \${JSON.stringify(twice)} did\`);
  const missing = ids(20, 10).filter(id => !['b-0020', 'b-0030', 'b-0100'].includes(id) && !seen.includes(id));
  assert.deepEqual(missing, [], \`every book present for the whole walk must be listed, but \${JSON.stringify(missing)} never was\`);
  assert.deepEqual(seen, [...seen].sort(), \`one walk lists books in ascending id order, got \${show(seen)}\`);
}

export async function check_bound_to_shelf(ctx) {
  const {client} = start(ctx, {fiction: ids(30), history: ids(30)});
  const fiction = await list(client, 'fiction', 10);
  const token = fiction.next_page_token;
  assert(token, '10 of 30 fiction books listed: next_page_token must not be empty');
  assert(!['b-0010', 'b-0011', '10'].includes(token), \`the token must be opaque and carry the shelf, not the bare position \${JSON.stringify(token)}\`);
  let got = await code(client, 'history', 10, token);
  assert.equal(got, 'INVALID_ARGUMENT', \`a token issued for shelf 'fiction' sent with shelf 'history' must be INVALID_ARGUMENT, got \${got}\`);
  let page = bookIds(await list(client, 'fiction', 10, token));
  assert.deepEqual(page, ids(20).slice(10), \`the fiction token still continues fiction with b-0011 to b-0020, got \${JSON.stringify(page)}\`);
  const history = await list(client, 'history', 10);
  got = await code(client, 'fiction', 10, history.next_page_token);
  assert.equal(got, 'INVALID_ARGUMENT', \`a token issued for shelf 'history' sent with shelf 'fiction' must be INVALID_ARGUMENT, got \${got}\`);
  page = bookIds(await list(client, 'history', 10, history.next_page_token));
  assert.deepEqual(page, ids(20).slice(10), \`the history token still continues history with b-0011 to b-0020, got \${JSON.stringify(page)}\`);
}

export async function check_malformed_token(ctx) {
  const {client} = start(ctx, {fiction: ids(30)});
  for (const token of ['not a token', '%%%', b64('not json'), b64('[1, 2]'), b64('42'), b64('{}'), b64('"b-0010"')]) {
    const got = await code(client, 'fiction', 10, token);
    const hint = got === 'UNKNOWN' ? ' (an exception escaped the handler)' : '';
    assert.equal(got, 'INVALID_ARGUMENT', \`page_token \${JSON.stringify(token)} is not a token this server issued: expected INVALID_ARGUMENT, got \${got}\${hint}\`);
  }
  const page = bookIds(await list(client, 'fiction', 10, ''));
  assert.deepEqual(page, ids(10), \`an empty page_token is the first page, b-0001 to b-0010, got \${JSON.stringify(page)}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"slices"
	"sort"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"leetbuild/harness"

	pb "library/gen/library"
)

// bookIDs is b-0001, b-0002, … (or b-0010, b-0020, … with step 10).
func bookIDs(n, step int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("b-%04d", (i+1)*step)
	}
	return out
}

func showBooks(list []string) string {
	if len(list) <= 6 {
		return fmt.Sprintf("%q", list)
	}
	return fmt.Sprintf("%d books %q … %q", len(list), list[:3], list[len(list)-2:])
}

func rawB64(text string) string { return base64.RawURLEncoding.EncodeToString([]byte(text)) }

// setShelf puts a book on a shelf (or takes it off with an empty title), as the catalogue does.
func setShelf(shelf, id, title string) {
	mu.Lock()
	defer mu.Unlock()
	if title == "" {
		delete(shelves[shelf], id)
		return
	}
	shelves[shelf][id] = title
}

// startLibrary seeds shelves in place, runs the learner's server and returns a client on it.
func startLibrary(ctx *harness.Ctx, seed map[string][]string) pb.LibraryClient {
	mu.Lock()
	for name := range shelves {
		delete(shelves, name)
	}
	for name, list := range seed {
		books := map[string]string{}
		for _, id := range list {
			books[id] = "Title " + id
		}
		shelves[name] = books
	}
	mu.Unlock()
	ctx.Main(main)
	return pb.NewLibraryClient(ctx.GRPC.Dial("library:9000"))
}

func listCall(client pb.LibraryClient, shelf string, pageSize int32, pageToken string) (*pb.ListBooksResponse, error) {
	c, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return client.ListBooks(c, &pb.ListBooksRequest{Shelf: shelf, PageSize: pageSize, PageToken: pageToken})
}

func listBooks(ctx *harness.Ctx, client pb.LibraryClient, shelf string, pageSize int32, pageToken string) *pb.ListBooksResponse {
	reply, err := listCall(client, shelf, pageSize, pageToken)
	if err != nil {
		ctx.Fatalf("ListBooks(shelf=%q, page_size=%d, page_token=%q) failed with %v: %s", shelf, pageSize, pageToken, status.Code(err), status.Convert(err).Message())
	}
	return reply
}

func listCode(client pb.LibraryClient, shelf string, pageSize int32, pageToken string) codes.Code {
	_, err := listCall(client, shelf, pageSize, pageToken)
	return status.Code(err)
}

func idsOf(reply *pb.ListBooksResponse) []string {
	out := []string{}
	for _, b := range reply.GetBooks() {
		out = append(out, b.GetId())
	}
	return out
}

// walkShelf is every page from pageToken to the one carrying NextPageToken "".
func walkShelf(ctx *harness.Ctx, client pb.LibraryClient, shelf string, pageSize int32, pageToken string) [][]string {
	var pages [][]string
	for range 20 {
		reply := listBooks(ctx, client, shelf, pageSize, pageToken)
		pages = append(pages, idsOf(reply))
		pageToken = reply.GetNextPageToken()
		if pageToken == "" {
			return pages
		}
	}
	ctx.Fatalf("shelf %q at page_size %d: still a next_page_token after 20 pages, sizes %v", shelf, pageSize, pageSizes(pages))
	return nil
}

func pageSizes(pages [][]string) []int {
	sizes := make([]int, len(pages))
	for i, p := range pages {
		sizes[i] = len(p)
	}
	return sizes
}

func flattenPages(pages [][]string) []string {
	out := []string{}
	for _, p := range pages {
		out = append(out, p...)
	}
	return out
}

func CheckPageSize(ctx *harness.Ctx) {
	client := startLibrary(ctx, map[string][]string{"fiction": bookIDs(250, 1)})
	every := bookIDs(250, 1)
	for _, c := range [][2]int{{0, 50}, {7, 7}, {100, 100}, {101, 100}, {500, 100}} {
		size, want := c[0], c[1]
		reply := listBooks(ctx, client, "fiction", int32(size), "")
		got := idsOf(reply)
		ctx.Equal(len(got), want, "the books page_size %d returns on a shelf of 250", size)
		ctx.Assert(slices.Equal(got, every[:want]), "page_size %d: the first page is the %d lowest ids in ascending order (%s to %s), got %s", size, want, every[0], every[want-1], showBooks(got))
		ctx.Assert(reply.GetNextPageToken() != "", "page_size %d: %d books remain after the first page, so next_page_token must not be empty", size, 250-want)
	}
	books := listBooks(ctx, client, "fiction", 1, "").GetBooks()
	ctx.Assert(len(books) > 0, "page_size 1 returned no book")
	ctx.Equal(books[0].GetTitle(), "Title b-0001", "each Book carries its title from shelves")
}

func CheckRejectBadRequest(ctx *harness.Ctx) {
	client := startLibrary(ctx, map[string][]string{"fiction": bookIDs(20, 1)})
	for _, c := range []struct {
		shelf string
		size  int32
	}{{"poetry", 0}, {"poetry", 10}, {"", 0}} {
		ctx.Equal(listCode(client, c.shelf, c.size, ""), codes.NotFound, "shelf %q does not exist", c.shelf)
	}
	for _, size := range []int32{-1, -100} {
		ctx.Equal(listCode(client, "fiction", size, ""), codes.InvalidArgument, "page_size %d", size)
	}
	token := listBooks(ctx, client, "fiction", 5, "").GetNextPageToken()
	ctx.Assert(token != "", "5 of 20 books listed: next_page_token must not be empty")
	ctx.Equal(listCode(client, "fiction", -1, token), codes.InvalidArgument, "page_size -1 with a valid page_token")
}

func CheckFullWalk(ctx *harness.Ctx) {
	client := startLibrary(ctx, map[string][]string{"fiction": bookIDs(120, 1), "history": bookIDs(100, 1), "trilogy": bookIDs(3, 1), "empty": nil})
	pages := walkShelf(ctx, client, "fiction", 0, "")
	ctx.Equal(pageSizes(pages), []int{50, 50, 20}, "120 books at the default page size: the page sizes")
	flat := flattenPages(pages)
	ctx.Assert(slices.Equal(flat, bookIDs(120, 1)), "the walk must return every book once in ascending id order, got %s", showBooks(flat))
	pages = walkShelf(ctx, client, "history", 50, "")
	ctx.Equal(pageSizes(pages), []int{50, 50}, "100 books at page_size 50 are exactly two pages, the second with next_page_token %q because nothing follows it; the page sizes", "")
	ctx.Assert(slices.Equal(flattenPages(pages), bookIDs(100, 1)), "the history walk must return b-0001 to b-0100 in order")
	pages = walkShelf(ctx, client, "trilogy", 1, "")
	ctx.Equal(pages, [][]string{{"b-0001"}, {"b-0002"}, {"b-0003"}}, "3 books at page_size 1 are three pages of one")
	reply := listBooks(ctx, client, "empty", 0, "")
	ctx.Assert(len(idsOf(reply)) == 0 && reply.GetNextPageToken() == "", "an empty shelf is one empty page with next_page_token %q, got %q and %q", "", idsOf(reply), reply.GetNextPageToken())
}

func CheckKeyset(ctx *harness.Ctx) {
	client := startLibrary(ctx, map[string][]string{"fiction": bookIDs(20, 10)}) // b-0010 … b-0200
	page := listBooks(ctx, client, "fiction", 5, "")
	seen := idsOf(page)
	ctx.Equal(seen, []string{"b-0010", "b-0020", "b-0030", "b-0040", "b-0050"}, "page 1 at page_size 5")
	// Two books already listed are removed: an offset into the shorter list would skip b-0060 and b-0070.
	setShelf("fiction", "b-0020", "")
	setShelf("fiction", "b-0030", "")
	page = listBooks(ctx, client, "fiction", 5, page.GetNextPageToken())
	got := idsOf(page)
	ctx.Equal(got, []string{"b-0060", "b-0070", "b-0080", "b-0090", "b-0100"}, "b-0020 and b-0030 (already listed) were removed: page 2 must continue after b-0050 (an offset skips survivors)")
	seen = append(seen, got...)
	// Three books added before the cursor, and the cursor's own book removed: an offset would repeat books.
	for _, id := range []string{"b-0005", "b-0025", "b-0045"} {
		setShelf("fiction", id, "Title "+id)
	}
	setShelf("fiction", "b-0100", "")
	page = listBooks(ctx, client, "fiction", 5, page.GetNextPageToken())
	got = idsOf(page)
	ctx.Equal(got, []string{"b-0110", "b-0120", "b-0130", "b-0140", "b-0150"}, "three books were added before the cursor and the cursor's own book (b-0100) was removed: page 3 must continue strictly after b-0100")
	seen = append(seen, got...)
	// A book added ahead of the cursor is simply part of the rest of the walk.
	setShelf("fiction", "b-0155", "Title b-0155")
	rest := flattenPages(walkShelf(ctx, client, "fiction", 5, page.GetNextPageToken()))
	ctx.Equal(rest, []string{"b-0155", "b-0160", "b-0170", "b-0180", "b-0190", "b-0200"}, "the rest of the walk is everything now after b-0150 (b-0155 was added ahead of the cursor)")
	seen = append(seen, rest...)
	twice := []string{}
	for i, id := range seen {
		if slices.Index(seen, id) != i && !slices.Contains(twice, id) {
			twice = append(twice, id)
		}
	}
	sort.Strings(twice)
	ctx.Assert(len(twice) == 0, "no book may come back twice in one walk, but %q did", twice)
	missing := []string{}
	for _, id := range bookIDs(20, 10) {
		if !slices.Contains([]string{"b-0020", "b-0030", "b-0100"}, id) && !slices.Contains(seen, id) {
			missing = append(missing, id)
		}
	}
	ctx.Assert(len(missing) == 0, "every book present for the whole walk must be listed, but %q never was", missing)
	ctx.Assert(sort.StringsAreSorted(seen), "one walk lists books in ascending id order, got %s", showBooks(seen))
}

func CheckBoundToShelf(ctx *harness.Ctx) {
	client := startLibrary(ctx, map[string][]string{"fiction": bookIDs(30, 1), "history": bookIDs(30, 1)})
	token := listBooks(ctx, client, "fiction", 10, "").GetNextPageToken()
	ctx.Assert(token != "", "10 of 30 fiction books listed: next_page_token must not be empty")
	ctx.Assert(!slices.Contains([]string{"b-0010", "b-0011", "10"}, token), "the token must be opaque and carry the shelf, not the bare position %q", token)
	ctx.Equal(listCode(client, "history", 10, token), codes.InvalidArgument, "a token issued for shelf %q sent with shelf %q", "fiction", "history")
	page := idsOf(listBooks(ctx, client, "fiction", 10, token))
	ctx.Equal(page, bookIDs(20, 1)[10:], "the fiction token still continues fiction with b-0011 to b-0020")
	history := listBooks(ctx, client, "history", 10, "")
	ctx.Equal(listCode(client, "fiction", 10, history.GetNextPageToken()), codes.InvalidArgument, "a token issued for shelf %q sent with shelf %q", "history", "fiction")
	page = idsOf(listBooks(ctx, client, "history", 10, history.GetNextPageToken()))
	ctx.Equal(page, bookIDs(20, 1)[10:], "the history token still continues history with b-0011 to b-0020")
}

func CheckMalformedToken(ctx *harness.Ctx) {
	client := startLibrary(ctx, map[string][]string{"fiction": bookIDs(30, 1)})
	for _, token := range []string{"not a token", "%%%", rawB64("not json"), rawB64("[1, 2]"), rawB64("42"), rawB64("{}"), rawB64(fmt.Sprintf("%q", "b-0010"))} {
		got := listCode(client, "fiction", 10, token)
		hint := ""
		if got == codes.Unknown {
			hint = " (a panic escaped the handler)"
		}
		ctx.Assert(got == codes.InvalidArgument, "page_token %q is not a token this server issued: expected InvalidArgument, got %v%s", token, got, hint)
	}
	page := idsOf(listBooks(ctx, client, "fiction", 10, ""))
	ctx.Equal(page, bookIDs(10, 1), "an empty page_token is the first page, b-0001 to b-0010")
}
`,
  },
  debrief: `The token carries a key, not a count, because a count is only meaningful against the list it was computed on, and that list is gone by the next call: remove two books before the cursor and "skip 5" skips two survivors, add three and it repeats three. "Everything with \`id > b-0050\`" means the same thing whatever happened in between, including when \`b-0050\` itself was deleted, which is why the comparison is strict and the cursor is never looked up by position. The shelf travels inside the token so a token cannot be replayed against another collection, and decoding is total: garbage, a JSON list or a number is the client's mistake (\`INVALID_ARGUMENT\`), never an exception that surfaces as \`UNKNOWN\`. Counting what lies past the page, instead of checking that the page came out full, is what keeps the last page's token empty when the remaining books divide evenly. Real list methods run the same idea in the database (\`WHERE id > $1 ORDER BY id LIMIT $2 + 1\` on an index), use a composite key such as \`(created_at, id)\` when the sort column is not unique, bind every request parameter (\`filter\`, \`order_by\`) into the token, and serialize it as a versioned proto that is signed or encrypted, because AIP-158 says plain base64 is not opacity: clients that can read a token will come to depend on what is inside it.`,
};
