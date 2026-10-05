import type {Step} from '@/lib/types';

// ---- 3. JSON → gRPC proxy --------------------------------------------------------------------------
export const grpcProxyStep: Step = {
  id: 'grpc-proxy',
  title: 'Proxy GET /items/{id} to Catalog.GetItem',
  concept: 'grpc',
  file: 'catalog_proxy',
  focus: ['gateway', 'catalog'],
  task: `## Task

The catalog is an internal gRPC service; the public API is JSON. Bridge them:

\`\`\`proto
service Catalog {
  rpc GetItem(GetItemRequest) returns (Item);
}
message GetItemRequest { string id = 1; }
message Item { string id = 1; string name = 2; int64 price_cents = 3; }
\`\`\`

- \`GET /items/{id}\` calls \`Catalog.GetItem\` with a **2 s deadline** and returns the item as JSON.
- Forward the incoming \`X-Request-Id\` header as gRPC metadata **\`x-request-id\`** so the catalog's logs
  can be joined with the gateway's.
- Map the gRPC status to HTTP: \`NOT_FOUND\` → **404**, \`INVALID_ARGUMENT\` → **400**,
  \`DEADLINE_EXCEEDED\` → **504**, \`UNAVAILABLE\` → **503**, anything else → **502**.

:::widget grpc-streams {"mode": "unary"}

> A gateway does not retry on behalf of the client: the caller's budget is unknown and a \`GET\` that
> timed out once has already cost 2 s. Report the status honestly and let the client decide.

:::widget deadline-retry {"base": 100, "deadline": 2000, "attempts": 1}`,
  sequence: {
    participants: ['Client', 'gateway', 'Catalog'],
    messages: [
      {from: 'Client', to: 'gateway', label: 'GET /items/42 · X-Request-Id: r-9', kind: 'sync'},
      {from: 'gateway', to: 'Catalog', label: 'GetItem{id: 42} · x-request-id: r-9 · deadline 2 s', kind: 'sync'},
      {from: 'Catalog', to: 'gateway', label: 'Item{42, "Kettle", 3499}', kind: 'reply'},
      {from: 'gateway', to: 'Client', label: '200 application/json', kind: 'reply'},
      {from: 'gateway', to: 'Catalog', label: 'GetItem{id: ghost}', kind: 'sync'},
      {from: 'Catalog', to: 'gateway', label: 'status NOT_FOUND', kind: 'reply'},
      {from: 'gateway', to: 'Client', label: '404', kind: 'reply'},
    ],
  },
  hints: [
    'Two concerns per call: the call options (deadline, metadata) and the error translation. Build the options from the incoming request, make the call, then map the status in one place.',
    'Metadata keys are lowercase on the wire: read `X-Request-Id` from the HTTP request and attach it as `("x-request-id", value)` via the call’s metadata / outgoing context / `Metadata` + interceptor / `ClientContext::AddMetadata`.',
    'A lookup table from gRPC code to HTTP status with a 502 default (`HTTP_STATUS.get(code, 502)`, a `map` with an `ok` check, a `match` with `case _`, a `switch` with `default`) keeps the mapping in one readable place.',
  ],
  checks: [
    {
      id: 'route-call',
      title: 'GET /items/{id} calls Catalog.GetItem',
      detail: 'The `/items/{id}` handler must invoke `GetItem` on the generated stub with the path id and answer JSON.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/items\/\{/, /stub\.GetItem\(/]},
        go: {all: [/"GET \/items\/\{id\}"/, /stub\.GetItem\(/, /json\.(NewEncoder|Marshal)\(/]},
        scala: {all: [/path\(\s*"items"\s*\/\s*Segment\s*\)/, /\.getItem\(/, /application\/json/]},
        cpp: {all: [/svr\.Get\(\s*R?"\(?\/items\//, /stub->GetItem\(/, /"application\/json"/]},
      },
    },
    {
      id: 'deadline',
      title: 'Sets a 2 s deadline on the call',
      detail:
        'Every RPC must carry the 2 s deadline; without it a stalled catalog holds gateway connections open indefinitely.',
      match: {
        python: {all: [/stub\.GetItem\([\s\S]{0,200}?timeout\s*=\s*(DEADLINE_S|2(\.0)?)\b/]},
        go: {all: [/context\.WithTimeout\([^\n]*(deadline|2\s*\*\s*time\.Second)\s*\)/]},
        scala: {all: [/withDeadlineAfter\(\s*(DeadlineMillis|2000|2\s*,\s*TimeUnit\.SECONDS)/]},
        cpp: {all: [/set_deadline\([^\n]*(kDeadline|std::chrono::seconds[({]\s*2\s*[)}]|2s\b)/]},
      },
    },
    {
      id: 'request-id',
      title: 'Forwards X-Request-Id as x-request-id metadata',
      detail:
        'The HTTP `X-Request-Id` header must travel with the RPC as metadata `x-request-id`, so both services log the same id.',
      match: {
        python: {
          all: [
            /stub\.GetItem\([\s\S]{0,200}?metadata\s*=/,
            /["']x-request-id["']/,
            /headers(\.get\(|\[)\s*["']x-request-id["']/i,
          ],
        },
        go: {all: [/metadata\.(AppendToOutgoingContext|NewOutgoingContext)\(/, /"x-request-id"/, /X-Request-Id/]},
        scala: {
          all: [
            /Metadata\.Key\.of\(\s*"x-request-id"/,
            /MetadataUtils\.newAttachHeadersInterceptor\(/,
            /X-Request-Id/i,
          ],
        },
        cpp: {all: [/AddMetadata\(\s*"x-request-id"/, /X-Request-Id/i]},
      },
    },
    {
      id: 'status-map',
      title: 'Maps NOT_FOUND/INVALID_ARGUMENT/DEADLINE_EXCEEDED/UNAVAILABLE',
      detail: '404, 400, 504 and 503 respectively — the client must be able to tell "does not exist" from "try later".',
      match: {
        python: {
          all: [
            /NOT_FOUND[^\n]*\b404\b/,
            /INVALID_ARGUMENT[^\n]*\b400\b/,
            /DEADLINE_EXCEEDED[^\n]*\b504\b/,
            /UNAVAILABLE[^\n]*\b503\b/,
          ],
        },
        go: {
          all: [
            /codes\.NotFound[^\n]*(http\.StatusNotFound|\b404\b)/,
            /codes\.InvalidArgument[^\n]*(http\.StatusBadRequest|\b400\b)/,
            /codes\.DeadlineExceeded[^\n]*(http\.StatusGatewayTimeout|\b504\b)/,
            /codes\.Unavailable[^\n]*(http\.StatusServiceUnavailable|\b503\b)/,
          ],
        },
        scala: {
          all: [
            /NOT_FOUND[^\n]*(StatusCodes\.NotFound|\b404\b)/,
            /INVALID_ARGUMENT[^\n]*(StatusCodes\.BadRequest|\b400\b)/,
            /DEADLINE_EXCEEDED[^\n]*(StatusCodes\.GatewayTimeout|\b504\b)/,
            /UNAVAILABLE[^\n]*(StatusCodes\.ServiceUnavailable|\b503\b)/,
          ],
        },
        cpp: {
          all: [
            /NOT_FOUND[^\n]*\b404\b/,
            /INVALID_ARGUMENT[^\n]*\b400\b/,
            /DEADLINE_EXCEEDED[^\n]*\b504\b/,
            /UNAVAILABLE[^\n]*\b503\b/,
          ],
        },
      },
    },
    {
      id: 'fallback-502',
      title: 'Any other status becomes 502',
      detail:
        'Unknown upstream failures (INTERNAL, UNKNOWN, PERMISSION_DENIED…) are the gateway’s `502 Bad Gateway`, never a leaked 500 with a stack trace.',
      match: {
        python: {all: [/\b502\b/]},
        go: {all: [/http\.StatusBadGateway|\b502\b/]},
        scala: {all: [/StatusCodes\.BadGateway|\b502\b/]},
        cpp: {all: [/\b502\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc
from fastapi import FastAPI, HTTPException, Request

import catalog_pb2
import catalog_pb2_grpc

app = FastAPI()

DEADLINE_S = 2.0

channel = grpc.insecure_channel("catalog:9000")
stub = catalog_pb2_grpc.CatalogStub(channel)

# TODO: gRPC status → HTTP status (NOT_FOUND 404, INVALID_ARGUMENT 400, DEADLINE_EXCEEDED 504, UNAVAILABLE 503)
HTTP_STATUS: dict[grpc.StatusCode, int] = {}


@app.get("/items/{item_id}")
def get_item(item_id: str, request: Request) -> dict:
    # TODO: forward X-Request-Id as metadata ("x-request-id", value)
    # TODO: stub.GetItem(GetItemRequest(id=item_id)) with timeout=DEADLINE_S and that metadata
    # TODO: RpcError → HTTPException(HTTP_STATUS.get(code, 502)); success → {"id", "name", "price_cents"}
    raise HTTPException(status_code=501)
`,
      solution: `import grpc
from fastapi import FastAPI, HTTPException, Request

import catalog_pb2
import catalog_pb2_grpc

app = FastAPI()

DEADLINE_S = 2.0

channel = grpc.insecure_channel("catalog:9000")
stub = catalog_pb2_grpc.CatalogStub(channel)

HTTP_STATUS: dict[grpc.StatusCode, int] = {
    grpc.StatusCode.NOT_FOUND: 404,
    grpc.StatusCode.INVALID_ARGUMENT: 400,
    grpc.StatusCode.DEADLINE_EXCEEDED: 504,
    grpc.StatusCode.UNAVAILABLE: 503,
}


@app.get("/items/{item_id}")
def get_item(item_id: str, request: Request) -> dict:
    metadata = []
    if request_id := request.headers.get("x-request-id"):
        metadata.append(("x-request-id", request_id))
    try:
        item = stub.GetItem(catalog_pb2.GetItemRequest(id=item_id), timeout=DEADLINE_S, metadata=metadata)
    except grpc.RpcError as e:
        raise HTTPException(status_code=HTTP_STATUS.get(e.code(), 502), detail=e.details())
    return {"id": item.id, "name": item.name, "price_cents": item.price_cents}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "gateway/gen/catalog"
)

const deadline = 2 * time.Second

var conn, _ = grpc.NewClient("catalog:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewCatalogClient(conn)

// TODO: gRPC code → HTTP status (NotFound 404, InvalidArgument 400, DeadlineExceeded 504, Unavailable 503)
var httpStatus = map[codes.Code]int{}

func getItem(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	// TODO: context with the 2 s deadline; X-Request-Id → outgoing metadata x-request-id
	// TODO: stub.GetItem; error → httpStatus[status.Code(err)] or 502; success → JSON {id, name, price_cents}
	_ = id
	_ = context.Background
	_ = json.NewEncoder
	_ = metadata.AppendToOutgoingContext
	_ = status.Code
	http.Error(rw, "not implemented", http.StatusNotImplemented)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /items/{id}", getItem)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "gateway/gen/catalog"
)

const deadline = 2 * time.Second

var conn, _ = grpc.NewClient("catalog:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewCatalogClient(conn)

var httpStatus = map[codes.Code]int{
	codes.NotFound:         http.StatusNotFound,
	codes.InvalidArgument:  http.StatusBadRequest,
	codes.DeadlineExceeded: http.StatusGatewayTimeout,
	codes.Unavailable:      http.StatusServiceUnavailable,
}

func getItem(rw http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), deadline)
	defer cancel()
	if requestID := r.Header.Get("X-Request-Id"); requestID != "" {
		ctx = metadata.AppendToOutgoingContext(ctx, "x-request-id", requestID)
	}
	item, err := stub.GetItem(ctx, &pb.GetItemRequest{Id: r.PathValue("id")})
	if err != nil {
		code, known := httpStatus[status.Code(err)]
		if !known {
			code = http.StatusBadGateway
		}
		http.Error(rw, status.Convert(err).Message(), code)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{
		"id":          item.GetId(),
		"name":        item.GetName(),
		"price_cents": item.GetPriceCents(),
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /items/{id}", getItem)
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.stub.MetadataUtils
import io.grpc.{ManagedChannelBuilder, Metadata, Status, StatusRuntimeException}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import gateway.catalog.{CatalogGrpc, GetItemRequest}

object CatalogProxy {
  val DeadlineMillis = 2000L

  private val channel = ManagedChannelBuilder.forAddress("catalog", 9000).usePlaintext().build()
  private val stub = CatalogGrpc.blockingStub(channel)

  // TODO: Metadata.Key for x-request-id

  private def httpStatus(code: Status.Code): StatusCode = code match {
    // TODO: NOT_FOUND 404, INVALID_ARGUMENT 400, DEADLINE_EXCEEDED 504, UNAVAILABLE 503, otherwise 502
    case _ => StatusCodes.InternalServerError
  }

  val route: Route =
    path("items" / Segment) { id =>
      get {
        optionalHeaderValueByName("X-Request-Id") { requestId =>
          // TODO: stub with the request id attached as metadata and a DeadlineMillis deadline
          // TODO: getItem(GetItemRequest(id)) → JSON {id, name, price_cents}; StatusRuntimeException → httpStatus
          complete(StatusCodes.NotImplemented)
        }
      }
    }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.stub.MetadataUtils
import io.grpc.{ManagedChannelBuilder, Metadata, Status, StatusRuntimeException}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import gateway.catalog.{CatalogGrpc, GetItemRequest}

object CatalogProxy {
  val DeadlineMillis = 2000L

  private val channel = ManagedChannelBuilder.forAddress("catalog", 9000).usePlaintext().build()
  private val stub = CatalogGrpc.blockingStub(channel)

  private val RequestId = Metadata.Key.of("x-request-id", Metadata.ASCII_STRING_MARSHALLER)

  private def httpStatus(code: Status.Code): StatusCode = code match {
    case Status.Code.NOT_FOUND         => StatusCodes.NotFound
    case Status.Code.INVALID_ARGUMENT  => StatusCodes.BadRequest
    case Status.Code.DEADLINE_EXCEEDED => StatusCodes.GatewayTimeout
    case Status.Code.UNAVAILABLE       => StatusCodes.ServiceUnavailable
    case _                             => StatusCodes.BadGateway
  }

  val route: Route =
    path("items" / Segment) { id =>
      get {
        optionalHeaderValueByName("X-Request-Id") { requestId =>
          val headers = new Metadata()
          requestId.foreach(headers.put(RequestId, _))
          val call = stub
            .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers))
            .withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS)
          try {
            val item = call.getItem(GetItemRequest(id = id))
            val json = s"""{"id":"\${item.id}","name":"\${item.name}","price_cents":\${item.priceCents}}"""
            complete(HttpEntity(ContentTypes.\`application/json\`, json))
          } catch {
            case e: StatusRuntimeException =>
              val detail = Option(e.getStatus.getDescription).getOrElse("upstream error")
              complete(httpStatus(e.getStatus.getCode) -> detail)
          }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <grpcpp/grpcpp.h>
#include <httplib.h>

#include <chrono>
#include <string>

#include "catalog.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{2};

auto channel = grpc::CreateChannel("catalog:9000", grpc::InsecureChannelCredentials());
auto stub = gateway::Catalog::NewStub(channel);

int http_status(grpc::StatusCode code) {
  // TODO: NOT_FOUND 404, INVALID_ARGUMENT 400, DEADLINE_EXCEEDED 504, UNAVAILABLE 503, otherwise 502
  return 500;
}

void get_item(const httplib::Request& req, httplib::Response& res) {
  const std::string id = req.matches[1].str();
  // TODO: ClientContext with deadline now + kDeadline; X-Request-Id → AddMetadata("x-request-id", …)
  // TODO: stub->GetItem; !ok → http_status(code); ok → JSON {id, name, price_cents} as application/json
  res.status = 501;
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/items/([\\w-]+))", get_item);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <grpcpp/grpcpp.h>
#include <httplib.h>

#include <chrono>
#include <string>

#include "catalog.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{2};

auto channel = grpc::CreateChannel("catalog:9000", grpc::InsecureChannelCredentials());
auto stub = gateway::Catalog::NewStub(channel);

int http_status(grpc::StatusCode code) {
  switch (code) {
    case grpc::StatusCode::NOT_FOUND: return 404;
    case grpc::StatusCode::INVALID_ARGUMENT: return 400;
    case grpc::StatusCode::DEADLINE_EXCEEDED: return 504;
    case grpc::StatusCode::UNAVAILABLE: return 503;
    default: return 502;
  }
}

void get_item(const httplib::Request& req, httplib::Response& res) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  if (req.has_header("X-Request-Id")) ctx.AddMetadata("x-request-id", req.get_header_value("X-Request-Id"));

  gateway::GetItemRequest request;
  request.set_id(req.matches[1].str());
  gateway::Item item;
  const grpc::Status status = stub->GetItem(&ctx, request, &item);
  if (!status.ok()) {
    res.status = http_status(status.error_code());
    res.set_content(status.error_message(), "text/plain");
    return;
  }
  const std::string json = "{\\"id\\":\\"" + item.id() + "\\",\\"name\\":\\"" + item.name() +
                           "\\",\\"price_cents\\":" + std::to_string(item.price_cents()) + "}";
  res.set_content(json, "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/items/([\\w-]+))", get_item);
}
`,
    },
  },
  debrief: `The proxy is a translation layer and nothing more: it turns a path into a request message, a header into metadata, and a status code into another status code. The deadline is what makes it safe to sit in front of a service you do not control, and the 502 default is what keeps upstream internals from leaking to clients. Real gateways generate this code from the proto (grpc-gateway, Envoy's gRPC-JSON transcoder), propagate the *caller's* remaining deadline instead of a fixed 2 s, and copy a whole allow-list of headers (trace context, tenant) into metadata.`,
};
