import type {Step} from '@/lib/types';

// ---- 1. TLS listener with graceful shutdown -------------------------------------------------------
export const tlsListenerStep: Step = {
  id: 'tls-listener',
  title: 'An HTTPS listener that shuts down cleanly',
  concept: 'http',
  file: 'gateway_server',
  focus: ['client', 'gateway'],
  task: `## Task

Stand up the gateway process itself: the TLS listener every other step plugs into.

- Serve **HTTPS on :8443** with \`cert.pem\` / \`key.pem\` and refuse anything older than **TLS 1.2**.
- \`GET /healthz\` answers \`{"ok": true}\` — the load balancer polls it.
- Every response carries \`Strict-Transport-Security: max-age=63072000\` (two years), whatever the route.
- On **SIGTERM** stop accepting new connections and **drain** in-flight requests, waiting at most **10 s**
  before the process exits anyway.

:::widget http-lifecycle {"tls": true}

> Orchestrators send SIGTERM first and SIGKILL after a grace period. A server that ignores the first
> signal drops every request it was in the middle of when the second one lands.`,
  sequence: {
    participants: ['Client', 'gateway', 'OS'],
    messages: [
      {from: 'Client', to: 'gateway', label: 'TLS handshake (1.2 or newer)', kind: 'sync'},
      {from: 'Client', to: 'gateway', label: 'GET /healthz', kind: 'sync'},
      {from: 'gateway', to: 'Client', label: '200 {"ok":true} · Strict-Transport-Security', kind: 'reply'},
      {from: 'OS', to: 'gateway', label: 'SIGTERM', kind: 'async'},
      {from: 'gateway', to: 'gateway', label: 'close listener · drain ≤ 10 s', kind: 'sync'},
      {from: 'gateway', to: 'Client', label: 'last in-flight response', kind: 'reply'},
    ],
  },
  hints: [
    'Three independent pieces: the TLS settings live on the server/engine configuration, HSTS is a middleware (or post-routing hook) so no route can forget it, and shutdown is a signal handler that calls the server’s own graceful stop.',
    'Minimum TLS version is a property of the TLS context (`MinVersion`, `minimum_version`, enabled protocols on the `SSLEngine`, `SSL_CTX_set_min_proto_version`) — not something you check per request.',
    'Graceful stop = close the listening socket, then wait for open connections with a deadline: `srv.Shutdown(ctx)` with a 10 s context, uvicorn’s `timeout_graceful_shutdown` + `handle_exit`, Pekko’s `addToCoordinatedShutdown(hardTerminationDeadline)`, or `svr.stop()` plus a bounded `wait_for` on the serving thread.',
  ],
  checks: [
    {
      id: 'healthz',
      title: 'GET /healthz answers {"ok": true}',
      detail:
        'A `GET /healthz` route must return the JSON document `{"ok": true}` so the load balancer can probe the process.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/healthz["']\s*\)/, /"ok":\s*True/]},
        go: {all: [/HandleFunc\(\s*"GET \/healthz"/, /"ok":\s*true/]},
        scala: {all: [/path\(\s*"healthz"\s*\)/, /"ok":\s*true/]},
        cpp: {all: [/svr\.Get\(\s*"\/healthz"/, /"ok":\s*true/]},
      },
    },
    {
      id: 'tls-min',
      title: 'Refuses TLS older than 1.2',
      detail:
        'The TLS context must set a minimum protocol version of TLS 1.2; TLS 1.0/1.1 are deprecated and fail compliance scans.',
      match: {
        python: {all: [/minimum_version\s*=\s*ssl\.TLSVersion\.TLSv1_2/]},
        go: {all: [/MinVersion:\s*tls\.VersionTLS12/]},
        scala: {all: [/setEnabledProtocols\([^\n]*"TLSv1\.2"/], none: [/"TLSv1"|"TLSv1\.1"|"SSLv3"/]},
        cpp: {all: [/SSL_CTX_set_min_proto_version\([^\n]*TLS1_2_VERSION/]},
      },
    },
    {
      id: 'hsts',
      title: 'Sends HSTS on every response',
      detail:
        '`Strict-Transport-Security: max-age=63072000` must be added centrally (middleware / post-routing hook), not per route.',
      match: {
        python: {all: [/@app\.middleware\(\s*["']http["']\s*\)/, /Strict-Transport-Security/i, /max-age=63072000/]},
        go: {all: [/Handler:\s*hsts\(\s*mux\s*\)/, /Strict-Transport-Security/i, /max-age=63072000/]},
        scala: {all: [/respondWithHeaders?\(/, /Strict-Transport-Security/i, /max-age=63072000/]},
        cpp: {all: [/set_post_routing_handler\(/, /Strict-Transport-Security/i, /max-age=63072000/]},
      },
    },
    {
      id: 'sigterm',
      title: 'SIGTERM triggers a graceful stop',
      detail:
        'A SIGTERM handler must call the server’s graceful shutdown (close the listener, let in-flight requests finish) instead of letting the process die mid-request.',
      match: {
        python: {all: [/signal\.SIGTERM/, /handle_exit/]},
        go: {all: [/signal\.Notify(Context)?\([^\n]*syscall\.SIGTERM/, /srv\.Shutdown\(/]},
        scala: {all: [/addToCoordinatedShutdown\(|sys\.addShutdownHook/]},
        cpp: {all: [/SIGTERM/, /svr\.stop\(\)/]},
      },
    },
    {
      id: 'drain-bound',
      title: 'Draining is bounded to 10 s',
      detail:
        'The drain must have a deadline (10 s): a client holding a connection open must not be able to keep the old process alive forever.',
      match: {
        python: {all: [/timeout_graceful_shutdown\s*=\s*(DRAIN_S|10)\b/]},
        go: {all: [/context\.WithTimeout\([^\n]*(drainTimeout|10\s*\*\s*time\.Second)\s*\)/]},
        scala: {
          all: [
            /hardTerminationDeadline\s*=\s*(DrainTimeout|10\.seconds)|terminate\(\s*(DrainTimeout|10\.seconds)\s*\)/,
          ],
        },
        cpp: {all: [/wait_for\(\s*(kDrainTimeout|std::chrono::seconds[({]\s*10\s*[)}]|10s)\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio
import signal
import ssl

import uvicorn
from fastapi import FastAPI, Request

app = FastAPI()

PORT = 8443
DRAIN_S = 10


# TODO: middleware that adds Strict-Transport-Security: max-age=63072000 to every response


# TODO: GET /healthz → {"ok": true}


async def main() -> None:
    config = uvicorn.Config(app, host="0.0.0.0", port=PORT, ssl_certfile="cert.pem", ssl_keyfile="key.pem")
    # TODO: drain for at most DRAIN_S on shutdown (timeout_graceful_shutdown)
    # TODO: config.load(); refuse TLS older than 1.2 on config.ssl
    server = uvicorn.Server(config)
    # TODO: SIGTERM → server.handle_exit (stop accepting, drain, exit)
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
`,
      solution: `import asyncio
import signal
import ssl

import uvicorn
from fastapi import FastAPI, Request

app = FastAPI()

PORT = 8443
DRAIN_S = 10


@app.middleware("http")
async def hsts(request: Request, call_next):
    response = await call_next(request)
    response.headers["Strict-Transport-Security"] = "max-age=63072000"
    return response


@app.get("/healthz")
def healthz() -> dict[str, bool]:
    return {"ok": True}


async def main() -> None:
    config = uvicorn.Config(
        app,
        host="0.0.0.0",
        port=PORT,
        ssl_certfile="cert.pem",
        ssl_keyfile="key.pem",
        timeout_graceful_shutdown=DRAIN_S,
    )
    config.load()  # builds config.ssl from the cert and key
    config.ssl.minimum_version = ssl.TLSVersion.TLSv1_2
    server = uvicorn.Server(config)
    loop = asyncio.get_running_loop()
    # handle_exit flips should_exit: the listener closes, open connections get DRAIN_S to finish.
    loop.add_signal_handler(signal.SIGTERM, server.handle_exit, signal.SIGTERM, None)
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const drainTimeout = 10 * time.Second

// hsts adds Strict-Transport-Security to every response.
func hsts(next http.Handler) http.Handler {
	// TODO: set Strict-Transport-Security: max-age=63072000, then call next
	return next
}

func main() {
	mux := http.NewServeMux()
	// TODO: GET /healthz → {"ok": true}
	srv := &http.Server{
		Addr:    ":8443",
		Handler: mux, // TODO: wrap with hsts()
		// TODO: TLSConfig with MinVersion tls.VersionTLS12
	}
	// TODO: serve in the background; on SIGTERM call srv.Shutdown with a drainTimeout context
	_ = context.Background
	_ = tls.Config{}
	_ = json.NewEncoder
	_ = os.Interrupt
	_ = signal.Notify
	_ = syscall.Getpid
	log.Fatal(srv.ListenAndServeTLS("cert.pem", "key.pem"))
}
`,
      solution: `package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const drainTimeout = 10 * time.Second

func healthz(rw http.ResponseWriter, r *http.Request) {
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]bool{"ok": true})
}

// hsts adds Strict-Transport-Security to every response.
func hsts(next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Strict-Transport-Security", "max-age=63072000")
		next.ServeHTTP(rw, r)
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz)
	srv := &http.Server{
		Addr:      ":8443",
		Handler:   hsts(mux),
		TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12},
	}
	go func() {
		if err := srv.ListenAndServeTLS("cert.pem", "key.pem"); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, os.Interrupt)
	<-stop
	// Shutdown closes the listener at once and waits for open connections, but not past drainTimeout.
	ctx, cancel := context.WithTimeout(context.Background(), drainTimeout)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("drain incomplete: %v", err)
	}
}
`,
    },
    scala: {
      starter: `import javax.net.ssl.SSLContext

import scala.concurrent.duration._

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object GatewayServer {
  val Port = 8443
  val DrainTimeout: FiniteDuration = 10.seconds

  /** SSLContext loaded from the PEM files (provided). */
  def serverContext(cert: String, key: String): SSLContext = Tls.serverContext(cert, key)

  val route: Route =
    // TODO: respondWithHeader Strict-Transport-Security: max-age=63072000 around every route
    // TODO: GET /healthz → {"ok":true}
    complete(StatusCodes.NotImplemented)

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("gateway")
    import system.dispatcher
    val ctx = serverContext("cert.pem", "key.pem")
    // TODO: build the HttpsConnectionContext from an SSLEngine limited to TLSv1.2 and TLSv1.3
    val https = ConnectionContext.httpsServer(ctx)
    val binding = Http().newServerAt("0.0.0.0", Port).enableHttps(https).bind(route)
    // TODO: on SIGTERM unbind and drain for at most DrainTimeout (coordinated shutdown)
    binding.foreach(_ => println(s"listening on $Port"))
  }
}
`,
      solution: `import javax.net.ssl.SSLContext

import scala.concurrent.duration._

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object GatewayServer {
  val Port = 8443
  val DrainTimeout: FiniteDuration = 10.seconds

  /** SSLContext loaded from the PEM files (provided). */
  def serverContext(cert: String, key: String): SSLContext = Tls.serverContext(cert, key)

  val route: Route =
    respondWithHeader(RawHeader("Strict-Transport-Security", "max-age=63072000")) {
      path("healthz") {
        get {
          complete(HttpEntity(ContentTypes.\`application/json\`, """{"ok":true}"""))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("gateway")
    import system.dispatcher
    val ctx = serverContext("cert.pem", "key.pem")
    val https = ConnectionContext.httpsServer { () =>
      val engine = ctx.createSSLEngine()
      engine.setUseClientMode(false)
      engine.setEnabledProtocols(Array("TLSv1.2", "TLSv1.3"))
      engine
    }
    val binding = Http().newServerAt("0.0.0.0", Port).enableHttps(https).bind(route)
    // SIGTERM runs the JVM shutdown hook → CoordinatedShutdown: unbind first, then terminate
    // once in-flight requests are done or DrainTimeout has passed.
    binding.foreach(_.addToCoordinatedShutdown(hardTerminationDeadline = DrainTimeout))
  }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>

#include <chrono>
#include <csignal>
#include <future>
#include <string>

constexpr int kPort = 8443;
constexpr std::chrono::seconds kDrainTimeout{10};

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");
  // TODO: refuse TLS older than 1.2 on svr.ssl_context()
  // TODO: Strict-Transport-Security: max-age=63072000 on every response (post-routing handler)
  // TODO: GET /healthz → {"ok":true}
  // TODO: block SIGTERM, serve on a background thread, sigwait, svr.stop(), wait at most kDrainTimeout
  svr.listen("0.0.0.0", kPort);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>

#include <chrono>
#include <csignal>
#include <cstdlib>
#include <future>
#include <string>

constexpr int kPort = 8443;
constexpr std::chrono::seconds kDrainTimeout{10};

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");
  SSL_CTX_set_min_proto_version(svr.ssl_context(), TLS1_2_VERSION);

  svr.set_post_routing_handler([](const httplib::Request&, httplib::Response& res) {
    res.set_header("Strict-Transport-Security", "max-age=63072000");
  });

  svr.Get("/healthz", [](const httplib::Request&, httplib::Response& res) {
    res.set_content(R"({"ok":true})", "application/json");
  });

  // Block SIGTERM in every thread so it is delivered to sigwait below and nowhere else.
  sigset_t signals;
  sigemptyset(&signals);
  sigaddset(&signals, SIGTERM);
  pthread_sigmask(SIG_BLOCK, &signals, nullptr);

  auto served = std::async(std::launch::async, [&svr] { return svr.listen("0.0.0.0", kPort); });

  int sig = 0;
  sigwait(&signals, &sig);
  svr.stop();  // closes the listening socket; workers finish the requests they hold
  if (served.wait_for(kDrainTimeout) != std::future_status::ready) {
    std::_Exit(1);  // a client kept a connection open past the drain budget: leave anyway
  }
}
`,
    },
  },
  debrief: `The listener is where three cross-cutting policies live, because it is the one place every request passes: the TLS floor (a property of the context, checked once per handshake), HSTS (a middleware, so a new route cannot forget it) and graceful shutdown (close the accept socket first, then wait with a deadline). Real gateways add OCSP stapling, certificate hot-reload, ALPN for HTTP/2, and health checks that go *unhealthy* a few seconds before the drain starts so the load balancer stops sending traffic first.`,
};
