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
        typescript: {all: [/\.get\(\s*['"]\/healthz['"]/, /ok:\s*true/]},
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
        typescript: {all: [/minVersion:\s*['"]TLSv1\.2['"]/]},
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
        typescript: {all: [/addHook\(\s*['"]onSend['"]/, /Strict-Transport-Security/i, /max-age=63072000/]},
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
        typescript: {all: [/process\.(on|once)\(\s*['"]SIGTERM['"]/, /app\.close\(\)/]},
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
        typescript: {all: [/setTimeout\([^\n]*(DRAIN_MS|10_?000)\s*\)/]},
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
    typescript: {
      starter: `import Fastify from 'fastify';
import {cert, key} from 'gateway/tls';

export const PORT = 8443;
export const DRAIN_MS = 10_000;

// TODO: https with cert, key and a TLS 1.2 floor (minVersion)
export const app = Fastify();

// TODO: a hook that adds Strict-Transport-Security: max-age=63072000 to every response

app.get('/healthz', async (request, reply) => {
  // TODO: {ok: true}
  return reply.code(501).send();
});

/** The process entry point: listen, then hand SIGTERM to a bounded graceful stop. */
export async function main(): Promise<void> {
  await app.listen({port: PORT, host: '0.0.0.0'});
  // TODO: on SIGTERM app.close() drains in-flight requests, then process.exit(0)
  // TODO: a DRAIN_MS timer calls process.exit(1) if the drain takes longer
}
`,
      solution: `import Fastify from 'fastify';
import {cert, key} from 'gateway/tls';

export const PORT = 8443;
export const DRAIN_MS = 10_000;

export const app = Fastify({
  https: {cert, key, minVersion: 'TLSv1.2'},
});

// A hook, not a per-route header: no route can forget it.
app.addHook('onSend', async (request, reply) => {
  reply.header('Strict-Transport-Security', 'max-age=63072000');
});

app.get('/healthz', async () => ({ok: true}));

/** The process entry point: listen, then hand SIGTERM to a bounded graceful stop. */
export async function main(): Promise<void> {
  await app.listen({port: PORT, host: '0.0.0.0'});
  process.once('SIGTERM', () => {
    // the listener closes at once; open connections get DRAIN_MS to finish, then the process exits anyway
    const deadline = setTimeout(() => process.exit(1), DRAIN_MS);
    void app.close().then(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
  });
}
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
  harness: {
    python: `import asyncio
import signal
import ssl

import uvicorn


async def _booted(ctx):
    """Run main(): the uvicorn stub records the Config and the Server and serve() returns at once.
    The runtime's loop has no add_signal_handler and there is no process to signal, so the handlers
    main() installs (loop.add_signal_handler or signal.signal) are captured and can be fired by hand."""
    m = ctx.load("gateway_server")
    handlers = {}
    loop = asyncio.get_running_loop()
    original_signal = signal.signal
    loop.add_signal_handler = lambda sig, cb, *args: handlers.__setitem__(int(sig), lambda: cb(*args))
    signal.signal = lambda sig, h: handlers.__setitem__(int(sig), lambda: h(sig, None))
    before = len(uvicorn.configs)
    try:
        await m.main()
    finally:
        del loop.add_signal_handler
        signal.signal = original_signal
    assert len(uvicorn.configs) > before, "main() built no uvicorn.Config"
    return m, uvicorn.configs[-1], handlers


async def check_healthz(ctx):
    m = ctx.load("gateway_server")
    async with ctx.client(m.app) as c:
        r = await c.get("/healthz")
    assert r.status_code == 200, f"GET /healthz answered {r.status_code}, expected 200"
    assert r.headers.get("content-type", "").startswith("application/json"), f"GET /healthz must answer JSON, got Content-Type {r.headers.get('content-type')!r}"
    assert r.json() == {"ok": True}, f'GET /healthz body is {r.text!r}, expected {{"ok": true}}'


async def check_tls_min(ctx):
    original_load = uvicorn.Config.load

    def permissive_load(cfg):
        # this OpenSSL may already default a fresh context to TLS 1.2: start from the lowest floor so
        # only an explicitly set minimum_version counts
        original_load(cfg)
        if cfg.ssl is not None:
            cfg.ssl.minimum_version = ssl.TLSVersion.MINIMUM_SUPPORTED

    uvicorn.Config.load = permissive_load
    try:
        m, cfg, _ = await _booted(ctx)
    finally:
        uvicorn.Config.load = original_load
    assert cfg.port == 8443, f"the listener is configured on port {cfg.port}, expected 8443"
    assert cfg.ssl_certfile and cfg.ssl_keyfile, "the listener must be configured with ssl_certfile=cert.pem and ssl_keyfile=key.pem"
    assert cfg.ssl is not None, "config.load() was never called, so there is no TLS context to set a floor on"
    floor = cfg.ssl.minimum_version
    assert floor == ssl.TLSVersion.TLSv1_2, f"config.ssl.minimum_version is {floor!r}: the floor must be ssl.TLSVersion.TLSv1_2"


async def check_hsts(ctx):
    m = ctx.load("gateway_server")
    async with ctx.client(m.app) as c:
        ok = await c.get("/healthz")
        missing = await c.get("/no-such-route")
    for name, r in (("/healthz", ok), ("/no-such-route", missing)):
        value = r.headers.get("strict-transport-security")
        assert value is not None, f"{name} ({r.status_code}) carries no Strict-Transport-Security header: add it in a middleware so every response has it"
        assert "max-age=63072000" in value.replace(" ", ""), f"{name}: Strict-Transport-Security is {value!r}, expected max-age=63072000"


async def check_sigterm(ctx):
    m, cfg, handlers = await _booted(ctx)
    assert uvicorn.servers, "main() built no uvicorn.Server"
    server = uvicorn.servers[-1]
    assert int(signal.SIGTERM) in handlers, f"main() installed handlers for {sorted(handlers)}, none for SIGTERM ({int(signal.SIGTERM)})"
    assert not server.should_exit, "the server must keep serving until SIGTERM arrives"
    handlers[int(signal.SIGTERM)]()
    assert server.should_exit, "the SIGTERM handler ran but the server was not told to stop: call server.handle_exit so the listener closes and in-flight requests drain"


async def check_drain_bound(ctx):
    m, cfg, _ = await _booted(ctx)
    drain = cfg.timeout_graceful_shutdown
    assert drain is not None, "the Config has no timeout_graceful_shutdown: a client holding a connection open could keep the old process alive forever"
    assert drain == 10, f"timeout_graceful_shutdown is {drain!r}, expected 10 s"
`,
    typescript: `/**
 * No sockets and no real signals here: the runtime's \`process\` records handlers and exits, and the
 * harness delivers SIGTERM through \`ctx.process.emit\`. The app's listen() and close() are wrapped so
 * the check sees the configured port and decides when the "in-flight" connections are gone.
 */

/** Let the handler's promise chain run without a macrotask turn (a turn would jump the clock to the next timer). */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** Run main(): records what the listener was configured with and lets the check decide when the drain ends. */
async function booted(ctx) {
  const m = ctx.load('gateway_server');
  const listens: {port?: number}[] = [];
  const drain = Promise.withResolvers<void>();
  const server = {closed: false, release: drain.resolve};
  const listen = m.app.listen.bind(m.app);
  m.app.listen = async (opts, cb) => {
    listens.push(typeof opts === 'number' ? {port: opts} : opts ?? {});
    return listen(opts, cb);
  };
  m.app.close = async () => {
    server.closed = true;
    await drain.promise;
  };
  assert.equal(typeof m.main, 'function', 'gateway_server must export main()');
  await m.main();
  assert(listens.length > 0, 'main() never called app.listen(): nothing is serving');
  return {m, listens, server};
}

export async function check_healthz(ctx) {
  const m = ctx.load('gateway_server');
  const r = await ctx.client(m.app).get('/healthz');
  assert.equal(r.status, 200, \`GET /healthz answered \${r.status}, expected 200\`);
  assert((r.headers['content-type'] ?? '').startsWith('application/json'), \`GET /healthz must answer JSON, got Content-Type \${JSON.stringify(r.headers['content-type'])}\`);
  assert.deepEqual(r.json(), {ok: true}, \`GET /healthz body is \${JSON.stringify(r.text)}, expected {"ok": true}\`);
}

export async function check_tls_min(ctx) {
  const {m, listens} = await booted(ctx);
  const port = listens[listens.length - 1].port;
  assert.equal(port, 8443, \`the listener is configured on port \${port}, expected 8443\`);
  const https = m.app.initialConfig.https as {cert?: unknown; key?: unknown; minVersion?: unknown} | undefined;
  assert(https !== undefined && https !== null, 'the app was built without an https option: pass {https: {cert, key, minVersion}} to Fastify so it terminates TLS');
  assert(https.cert && https.key, 'the https option must carry the cert and key from gateway/tls');
  const floor = https.minVersion;
  assert(floor !== undefined, 'https.minVersion is not set: Node still accepts TLS 1.0 and 1.1 by default, the floor must be TLSv1.2');
  assert.equal(floor, 'TLSv1.2', \`https.minVersion is \${JSON.stringify(floor)}: the floor must be 'TLSv1.2'\`);
}

export async function check_hsts(ctx) {
  const m = ctx.load('gateway_server');
  const c = ctx.client(m.app);
  const ok = await c.get('/healthz');
  const missing = await c.get('/no-such-route');
  for (const [name, r] of [['/healthz', ok], ['/no-such-route', missing]] as const) {
    const value = r.headers['strict-transport-security'];
    assert(value !== undefined, \`\${name} (\${r.status}) carries no Strict-Transport-Security header: add it in an onSend hook so every response has it\`);
    assert(value.replace(/ /g, '').includes('max-age=63072000'), \`\${name}: Strict-Transport-Security is \${JSON.stringify(value)}, expected max-age=63072000\`);
  }
}

export async function check_sigterm(ctx) {
  const {server} = await booted(ctx);
  assert(ctx.process.listenerCount('SIGTERM') > 0, 'main() installed no SIGTERM handler: the process would die mid-request when the orchestrator stops it');
  assert(!server.closed, 'the server must keep serving until SIGTERM arrives');
  ctx.process.emit('SIGTERM');
  await tick();
  assert(server.closed, 'the SIGTERM handler ran but the server was not told to stop: call app.close() so the listener closes and in-flight requests drain');
  assert.equal(ctx.process.exited, null, \`the process exited with \${ctx.process.exited} while requests were still in flight: wait for app.close() to resolve before process.exit\`);
  server.release();
  await tick();
  assert(ctx.process.exited !== null, 'the drain finished but the process is still running: process.exit(0) once app.close() has resolved');
}

export async function check_drain_bound(ctx) {
  await booted(ctx);
  assert(ctx.process.listenerCount('SIGTERM') > 0, 'main() installed no SIGTERM handler');
  ctx.process.emit('SIGTERM');
  await tick();
  ctx.clock.advance(9);
  await tick();
  assert.equal(ctx.process.exited, null, \`9 s into the drain, with a request still in flight, the process already exited with \${ctx.process.exited}: give open connections the full 10 s\`);
  ctx.clock.advance(2);
  await tick();
  assert(ctx.process.exited !== null, '11 s after SIGTERM the process is still alive with a connection held open: bound the drain to DRAIN_MS (10 s) with a timer that exits anyway');
}
`,
    go: `package main

import (
	"crypto/tls"
	"net/http"
	"strings"
	"syscall"

	"leetbuild/harness"
)

func CheckHealthz(ctx *harness.Ctx) {
	r := ctx.Main(main).HTTP().Get("/healthz")
	ctx.Equal(r.Status, 200, "GET /healthz")
	ctype := r.Header.Get("Content-Type")
	ctx.Assert(strings.HasPrefix(ctype, "application/json"), "GET /healthz must answer JSON, got Content-Type %q", ctype)
	ctx.Equal(r.JSON(), map[string]any{"ok": true}, "GET /healthz body")
}

func CheckTlsMin(ctx *harness.Ctx) {
	p := ctx.Main(main)
	servers := p.Servers()
	ctx.Assert(len(servers) > 0, "main() never started listening: nothing is serving")
	s := servers[len(servers)-1]
	ctx.Assert(strings.HasSuffix(s.Addr, ":8443"), "the listener is configured on %q, expected :8443", s.Addr)
	srv, _ := s.Server.(*http.Server)
	ctx.Assert(s.TLS, "the server listens without TLS: serve it with srv.ListenAndServeTLS(%q, %q) so it terminates TLS", "cert.pem", "key.pem")
	ctx.Assert(s.CertFile != "" && s.KeyFile != "" || srv != nil && srv.TLSConfig != nil && len(srv.TLSConfig.Certificates) > 0, "the listener must be configured with cert.pem and key.pem")
	ctx.Assert(srv != nil && srv.TLSConfig != nil && srv.TLSConfig.MinVersion != 0, "TLSConfig.MinVersion is not set: the floor must be tls.VersionTLS12, set explicitly on the server's TLSConfig")
	ctx.Equal(srv.TLSConfig.MinVersion, tls.VersionTLS12, "TLSConfig.MinVersion (the floor must be tls.VersionTLS12)")
}

func CheckHsts(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	ok := c.Get("/healthz")
	missing := c.Get("/no-such-route")
	for _, tc := range []struct {
		name string
		r    *harness.Response
	}{{"/healthz", ok}, {"/no-such-route", missing}} {
		values := tc.r.Header.Values("Strict-Transport-Security")
		ctx.Assert(len(values) > 0, "%s (%d) carries no Strict-Transport-Security header: add it in a middleware wrapped around the mux so every response has it", tc.name, tc.r.Status)
		value := tc.r.Header.Get("Strict-Transport-Security")
		ctx.Assert(strings.Contains(strings.ReplaceAll(value, " ", ""), "max-age=63072000"), "%s: Strict-Transport-Security is %q, expected max-age=63072000", tc.name, value)
	}
}

func CheckSigterm(ctx *harness.Ctx) {
	p := ctx.Main(main)
	release := p.HTTP().Hold("GET", "/healthz", nil) // a request in flight when the signal lands
	ctx.Assert(p.Listening(), "the server must keep serving until SIGTERM arrives")
	ctx.Assert(p.Signal(syscall.SIGTERM) > 0, "main() installed no SIGTERM handler (signal.Notify): the process would die mid-request when the orchestrator stops it")
	ctx.Tick()
	ctx.Assert(!p.Listening(), "the SIGTERM handler ran but the server was not told to stop: call srv.Shutdown so the listener closes and in-flight requests drain")
	ctx.Assert(p.Running(), "the process ended while a request was still in flight: wait for srv.Shutdown to return before main returns")
	release()
	ctx.Tick()
	ctx.Assert(!p.Running(), "the drain finished but the process is still running: return from main once srv.Shutdown has returned")
}

func CheckDrainBound(ctx *harness.Ctx) {
	p := ctx.Main(main)
	p.HTTP().Hold("GET", "/healthz", nil) // a client holding its request open through the drain
	ctx.Assert(p.Signal(syscall.SIGTERM) > 0, "main() installed no SIGTERM handler (signal.Notify)")
	ctx.Tick()
	ctx.Clock.Advance(9)
	ctx.Tick()
	ctx.Assert(p.Running(), "9 s into the drain, with a request still in flight, the process already ended: give open connections the full 10 s")
	ctx.Clock.Advance(2)
	ctx.Tick()
	ctx.Assert(!p.Running(), "11 s after SIGTERM the process is still alive with a connection held open: bound the drain to drainTimeout (10 s) with context.WithTimeout")
}
`,
  },
  debrief: `The listener is where three cross-cutting policies live, because it is the one place every request passes: the TLS floor (a property of the context, checked once per handshake), HSTS (a middleware, so a new route cannot forget it) and graceful shutdown (close the accept socket first, then wait with a deadline). Real gateways add OCSP stapling, certificate hot-reload, ALPN for HTTP/2, and health checks that go *unhealthy* a few seconds before the drain starts so the load balancer stops sending traffic first.`,
};
