import type {Step} from '@/lib/types';

export const bookSnapshotStep: Step = {
  id: 'book-snapshot',
  title: 'GET /book/{symbol}: the current top of book, never cached',
  concept: 'http',
  file: 'book_endpoint',
  focus: ['client', 'gateway', 'redis'],
  task: `## Task

Not every client wants a stream. Implement \`GET /book/{symbol}\` on the gateway: the top of book as JSON.

- Validate the symbol against \`^[A-Z]{1,6}$\` (the compiled pattern is provided) **before** touching Redis;
  anything else → **400**. A path segment is user input like any other.
- \`HGETALL book:{symbol}\`; an empty hash → **404**.
- Answer **200** with \`{"symbol": …, "bid": …, "ask": …, "last": …}\` and
  \`Cache-Control: no-store\`: a price that a browser, proxy or CDN replays a second later is wrong by
  definition.

:::widget status-codes {}

> Compare with the thumbnail service's \`max-age=86400\`: same header, opposite value, because the two resources
> have opposite lifetimes. Choosing the cache policy is part of designing the endpoint.`,
  sequence: {
    participants: ['Client', 'gateway', 'Redis'],
    messages: [
      {from: 'Client', to: 'gateway', label: 'GET /book/ACME', kind: 'sync'},
      {from: 'gateway', to: 'gateway', label: 'symbol matches ^[A-Z]{1,6}$', kind: 'sync'},
      {from: 'gateway', to: 'Redis', label: 'HGETALL book:ACME', kind: 'sync'},
      {from: 'Redis', to: 'gateway', label: '{bid, ask, last}', kind: 'reply'},
      {from: 'gateway', to: 'Client', label: '200 JSON · Cache-Control: no-store', kind: 'reply'},
      {from: 'Client', to: 'gateway', label: 'GET /book/acme-1', kind: 'sync'},
      {from: 'gateway', to: 'Client', label: '400 Bad Request', kind: 'reply'},
    ],
  },
  hints: [
    'Three exits in order: 400 (pattern), 404 (empty hash), 200 (JSON). Each one returns before the next check runs.',
    'HGETALL returns the fields as a map of strings; add the symbol to it and serialise — the hash already has the shape of the response.',
    '`no-store` is a response header like any other; set it on the 200 only — error responses carry no price and need no policy.',
  ],
  checks: [
    {
      id: 'validate',
      title: 'Rejects an invalid symbol with 400 before reading Redis',
      detail: 'Match the path segment against `^[A-Z]{1,6}$` and answer `400 Bad Request` before any Redis call.',
      match: {
        python: {
          all: [/status_code\s*=\s*400|HTTP_400/],
          order: [/SYMBOL_RE\.(fullmatch|match)\(\s*symbol\s*\)/, /\.hgetall\(/],
        },
        go: {all: [/http\.StatusBadRequest|\b400\b/], order: [/symbolRe\.MatchString\(\s*symbol\s*\)/, /\.HGetAll\(/]},
        scala: {
          all: [/StatusCodes\.BadRequest|\b400\b/],
          order: [/SymbolRe\.(matches|findFirstIn|unapplySeq)\(\s*symbol\s*\)|case SymbolRe\(\)/, /\.hgetAll\(/],
        },
        cpp: {all: [/\b400\b/], order: [/std::regex_match\(\s*symbol\s*,\s*kSymbolRe\s*\)/, /\.hgetall\(/]},
      },
    },
    {
      id: 'hash',
      title: 'Reads the top of book from book:{symbol}',
      detail: 'The endpoint reads the same hash the engine writes: `HGETALL book:{symbol}`.',
      match: {
        python: {all: [/f"book:\{symbol\}"/, /\.hgetall\(/]},
        go: {all: [/"book:"\s*\+\s*symbol/, /\.HGetAll\(\s*ctx\s*,/]},
        scala: {all: [/s"book:\$symbol"/, /\.hgetAll\(/]},
        cpp: {all: [/"book:"\s*\+\s*symbol/, /\.hgetall\(/]},
      },
    },
    {
      id: 'not-found',
      title: 'Answers 404 when there is no book',
      detail: 'An empty hash means the symbol has never traded here: `404 Not Found`, not an empty 200.',
      match: {
        python: {all: [/status_code\s*=\s*404|HTTP_404/]},
        go: {all: [/http\.StatusNotFound|\b404\b/]},
        scala: {all: [/StatusCodes\.NotFound|\b404\b/]},
        cpp: {all: [/\b404\b/]},
      },
    },
    {
      id: 'no-store',
      title: 'Forbids caching with Cache-Control: no-store',
      detail: 'Prices must never be served from a cache: the 200 carries `Cache-Control: no-store`.',
      match: {
        python: {all: [/Cache-Control/i, /no-store/]},
        go: {all: [/Cache-Control/i, /no-store/]},
        scala: {all: [/Cache-Control/i, /no-store/]},
        cpp: {all: [/Cache-Control/i, /no-store/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import re

import redis
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

SYMBOL_RE = re.compile(r"^[A-Z]{1,6}$")


@app.get("/book/{symbol}")
def book(symbol: str) -> JSONResponse:
    # TODO: 400 unless SYMBOL_RE matches the symbol
    # TODO: HGETALL book:{symbol}; empty → 404
    # TODO: 200 {"symbol", "bid", "ask", "last"} with Cache-Control: no-store
    raise HTTPException(status_code=501)


# uvicorn book_endpoint:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import re

import redis
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

SYMBOL_RE = re.compile(r"^[A-Z]{1,6}$")


@app.get("/book/{symbol}")
def book(symbol: str) -> JSONResponse:
    if not SYMBOL_RE.fullmatch(symbol):
        raise HTTPException(status_code=400, detail="symbol must be 1–6 upper-case letters")
    fields = r.hgetall(f"book:{symbol}")
    if not fields:
        raise HTTPException(status_code=404, detail=f"no book for {symbol}")
    return JSONResponse({"symbol": symbol, **fields}, headers={"Cache-Control": "no-store"})


# uvicorn book_endpoint:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var symbolRe = regexp.MustCompile(\`^[A-Z]{1,6}$\`)

func bookHandler(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	symbol := r.PathValue("symbol")
	// TODO: 400 unless symbolRe matches the symbol
	// TODO: HGetAll book:{symbol}; empty → 404
	// TODO: 200 {"symbol", "bid", "ask", "last"} with Cache-Control: no-store
	_ = ctx
	_ = symbol
	_ = json.NewEncoder
	http.Error(rw, "not implemented", http.StatusNotImplemented)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /book/{symbol}", bookHandler)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var symbolRe = regexp.MustCompile(\`^[A-Z]{1,6}$\`)

func bookHandler(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	symbol := r.PathValue("symbol")
	if !symbolRe.MatchString(symbol) {
		http.Error(rw, "symbol must be 1–6 upper-case letters", http.StatusBadRequest)
		return
	}
	fields, err := rdb.HGetAll(ctx, "book:"+symbol).Result()
	if err != nil {
		http.Error(rw, "market data unavailable", http.StatusBadGateway)
		return
	}
	if len(fields) == 0 {
		http.Error(rw, "no book for "+symbol, http.StatusNotFound)
		return
	}
	fields["symbol"] = symbol
	rw.Header().Set("Content-Type", "application/json")
	rw.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(rw).Encode(fields)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /book/{symbol}", bookHandler)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._
import spray.json._
import spray.json.DefaultJsonProtocol._

object BookEndpoint {
  val jedis = new JedisPooled("redis", 6379)
  val SymbolRe = "^[A-Z]{1,6}$".r

  val route: Route =
    path("book" / Segment) { symbol =>
      get {
        // TODO: 400 unless SymbolRe matches the symbol
        // TODO: hgetAll book:{symbol}; empty → 404
        // TODO: 200 {"symbol", "bid", "ask", "last"} with Cache-Control: no-store
        val _ = (jedis, symbol, classOf[RawHeader])
        complete(StatusCodes.NotImplemented)
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("gateway")
    // Tls (provided) builds an SSLContext from the PEM certificate and key.
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._
import spray.json._
import spray.json.DefaultJsonProtocol._

object BookEndpoint {
  val jedis = new JedisPooled("redis", 6379)
  val SymbolRe = "^[A-Z]{1,6}$".r

  val route: Route =
    path("book" / Segment) { symbol =>
      get {
        if (!SymbolRe.matches(symbol)) complete(StatusCodes.BadRequest -> "symbol must be 1–6 upper-case letters")
        else {
          val fields = jedis.hgetAll(s"book:$symbol").asScala.toMap
          if (fields.isEmpty) complete(StatusCodes.NotFound -> s"no book for $symbol")
          else {
            val body = (fields + ("symbol" -> symbol)).toJson.compactPrint
            complete(
              HttpResponse(
                StatusCodes.OK,
                headers = List(RawHeader("Cache-Control", "no-store")),
                entity = HttpEntity(ContentTypes.\`application/json\`, body),
              )
            )
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("gateway")
    // Tls (provided) builds an SSLContext from the PEM certificate and key.
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <nlohmann/json.hpp>
#include <regex>
#include <string>
#include <unordered_map>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");
const std::regex kSymbolRe("^[A-Z]{1,6}$");

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get(R"(/book/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string symbol = req.matches[1];
    // TODO: 400 unless std::regex_match(symbol, kSymbolRe)
    // TODO: redis.hgetall("book:" + symbol, inserter); empty → 404
    // TODO: 200 {"symbol", "bid", "ask", "last"} with Cache-Control: no-store
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <nlohmann/json.hpp>
#include <regex>
#include <string>
#include <unordered_map>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");
const std::regex kSymbolRe("^[A-Z]{1,6}$");

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get(R"(/book/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string symbol = req.matches[1];
    if (!std::regex_match(symbol, kSymbolRe)) {
      res.status = 400;
      res.set_content("symbol must be 1-6 upper-case letters", "text/plain");
      return;
    }
    std::unordered_map<std::string, std::string> fields;
    redis.hgetall("book:" + symbol, std::inserter(fields, fields.begin()));
    if (fields.empty()) {
      res.status = 404;
      res.set_content("no book for " + symbol, "text/plain");
      return;
    }
    json body(fields);
    body["symbol"] = symbol;
    res.set_header("Cache-Control", "no-store");
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The same three-exit shape as the first HTTPS step — validate, look up, represent — with the cache policy flipped: \`no-store\` because the resource's truth has a lifetime of one trade. Validating the path segment before the Redis call is not pedantry; it is what keeps \`GET /book/../../admin\`-style input from ever reaching a key. Real market-data APIs add \`ETag\`s made from the tick sequence number (so a poll can be cheap when nothing changed), rate limits per API key, and serve depth (the full ladder) from a snapshot log rather than one hash.`,
};
