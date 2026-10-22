import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/voice/sessions: a session with a codec contract',
  concept: 'http',
  file: 'api',
  focus: ['client', 'gateway', 'sessions'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and hands back a session id, so the demo call connects. It hides four production flaws at
the trust boundary. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/voice/sessions\` with body \`{"codec": "opus", "sample_rate": 48000, "max_duration_s": 1800}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`codec\` must be one of **\`opus\`**, **\`pcm16\`**, **\`g711_ulaw\`** and \`sample_rate\` must be a
  rate the media pipeline accepts (**8000**, **16000**, **24000** or **48000**). Anything else is
  **415 Unsupported Media Type** — a codec the pipeline cannot decode must never open a stream.
- \`max_duration_s\` is optional and defaults to **1800** (30 minutes). It must be an integer from
  **1** to **1800**; a longer or non-positive value is **400**. Never leave a session unbounded.
- \`Idempotency-Key\` is required (**400** when missing). A retry with the same \`(tenant, key)\`
  returns the **live session it already created** — same \`session_id\`, same \`turn_count\` — with
  **200**, instead of forking a second session that bills twice. A first create answers **201**.
- Log the accepted session (tenant, session id, codec) — never raw audio.

**Failure mode the checks target.** Accepting any codec string lets a caller open a stream the media
pipeline cannot decode; an unlimited default duration means one stuck caller holds a stream and its
GPU forever; and starting a new session on every reconnect forks the conversation, doubles the
billing and splits the transcript. The reconnecting client is the common case on a flaky mobile
network, so the idempotent resume is the flaw candidates miss most.`,
  sequence: {
    participants: ['Client', 'Voice Gateway', 'Session store'],
    messages: [
      {
        from: 'Client',
        to: 'Voice Gateway',
        label: 'POST /v1/voice/sessions · codec · sample_rate · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'Voice Gateway', to: 'Voice Gateway', label: 'validate tenant · codec · duration', kind: 'sync'},
      {from: 'Voice Gateway', to: 'Session store', label: 'get(tenant, idem_key)', kind: 'sync'},
      {from: 'Session store', to: 'Voice Gateway', label: 'live session + turn_count / none', kind: 'reply'},
      {from: 'Voice Gateway', to: 'Session store', label: 'put(tenant, idem_key, session)', kind: 'async'},
      {
        from: 'Voice Gateway',
        to: 'Client',
        label: '201 create · 200 replay {session_id, codec, sample_rate, max_duration_s, turn_count}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Write the guard clauses first, in cost order: tenant 401, Idempotency-Key 400, body shape, codec whitelist 415, duration range 400 — all before any session state is written, so a caller the media pipeline cannot serve never gets a session id.',
    'The idempotency lookup is keyed by `(tenant, key)` and happens before minting a session id; a hit returns the stored session — same `session_id`, same `turn_count` — with 200. A reconnect is the common case on a flaky mobile network, and a second session bills the conversation twice and splits its transcript.',
    'The default duration is a constant, not `None`/`null`/`0`: an omitted `max_duration_s` must mean 1800 seconds, and the cap must be enforced on the value the caller sent too. A session with no deadline holds a media stream and its GPU until someone notices.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/voice/sessions',
      detail: 'Register the session route on `POST /v1/voice/sessions`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/voice\/sessions["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/voice\/sessions['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/voice\/sessions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"voice"\s*\/\s*"sessions"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/voice\/sessions"/]},
      },
    },
    {
      id: 'codec',
      title: 'Rejects an unsupported codec or sample rate with 415',
      detail:
        '`codec` is checked against the supported set and `sample_rate` against the rates the pipeline accepts; an unsupported pair is **415**. The draft accepts any codec string and opens a stream the media pipeline cannot decode.',
      match: {
        python: {all: [/SUPPORTED_CODECS/, /status_code\s*=\s*415/]},
        typescript: {all: [/SUPPORTED_CODECS/, /code\(\s*415\s*\)/]},
        go: {all: [/supportedCodecs/, /StatusUnsupportedMediaType/]},
        scala: {all: [/SupportedCodecs/, /StatusCodes\.UnsupportedMediaType/]},
        cpp: {all: [/kSupportedCodecs/, /\b415\b/]},
      },
    },
    {
      id: 'duration',
      title: 'Caps the session at 30 minutes',
      detail:
        'The duration defaults to 1800 s and anything from 1..1800 is accepted; a longer or non-positive value is **400**. The draft leaves the duration unlimited by default.',
      match: {
        python: {all: [/MAX_DURATION_S/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_DURATION_S/, /code\(\s*400\s*\)/]},
        go: {all: [/maxDurationS/, /StatusBadRequest/]},
        scala: {all: [/MaxDurationS/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxDurationS/, /\b400\b/]},
      },
    },
    {
      id: 'idempotent-resume',
      title: 'Resumes the live session for a replayed Idempotency-Key',
      detail:
        '`Idempotency-Key` is required and `(tenant, key)` maps to the session that already exists; a replay answers 200 with the same `session_id` and its prior `turn_count`. The draft ignores the header and forks a second session on every reconnect.',
      match: {
        python: {all: [/Idempotency-Key/, /sessions\.get\(/, /sessions\.put\(/, /turn_count/]},
        typescript: {all: [/idempotency-key/, /sessions\.get\(/, /sessions\.put\(/, /turn_count/]},
        go: {all: [/Idempotency-Key/, /sessions\.Get\(/, /sessions\.Put\(/, /TurnCount/]},
        scala: {all: [/Idempotency-Key/, /sessions\.get\(/, /sessions\.put\(/, /turn_count|turnCount/]},
        cpp: {all: [/Idempotency-Key/, /sessions\.get\(/, /sessions\.put\(/, /turn_count/]},
      },
    },
    {
      id: 'tenant',
      title: 'Authenticates the tenant with 401',
      detail:
        'The tenant comes from `X-Tenant-Id` and a missing or empty one is **401** before anything else happens. The draft reads the header but lets an anonymous caller through.',
      match: {
        python: {all: [/X-Tenant-Id/, /status_code\s*=\s*401/]},
        typescript: {all: [/x-tenant-id/, /code\(\s*401\s*\)/]},
        go: {all: [/X-Tenant-Id/, /StatusUnauthorized/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.Unauthorized/]},
        cpp: {all: [/X-Tenant-Id/, /\b401\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("voice-gateway")

DRAFT_DURATION_S = 86400


class CreateSession(BaseModel):
    codec: str
    sample_rate: int
    max_duration_s: int | None = None


@app.post("/v1/voice/sessions")
def create_session(body: CreateSession, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft accepts any codec string and any sample rate, defaults the duration to a day
    # with no cap, ignores Idempotency-Key (a reconnect forks a second session) and lets an
    # anonymous caller through. Review all four.
    session = {
        "session_id": f"vs_{uuid.uuid4().hex}",
        "codec": body.codec,
        "sample_rate": body.sample_rate,
        "max_duration_s": body.max_duration_s if body.max_duration_s is not None else DRAFT_DURATION_S,
    }
    logger.info("session open tenant=%s session=%s codec=%s", tenant, session["session_id"], body.codec)
    return JSONResponse(session, status_code=201)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("voice-gateway")

SUPPORTED_CODECS = {"opus", "pcm16", "g711_ulaw"}
SUPPORTED_SAMPLE_RATES = {8000, 16000, 24000, 48000}
DEFAULT_DURATION_S = 1800
MAX_DURATION_S = 1800


class CreateSession(BaseModel):
    codec: str
    sample_rate: int
    max_duration_s: int | None = None


class SessionStore:
    """The live sessions, keyed by (tenant, Idempotency-Key): the session store service in production."""

    def __init__(self) -> None:
        self._live: dict[tuple[str, str], dict] = {}

    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The live session stored for (tenant, idem_key), if any."""
        return self._live.get((tenant, idem_key))

    def put(self, tenant: str, idem_key: str, session: dict) -> None:
        """Store the live session under (tenant, idem_key)."""
        self._live[(tenant, idem_key)] = session


sessions = SessionStore()


@app.post("/v1/voice/sessions")
def create_session(
    body: CreateSession,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.codec not in SUPPORTED_CODECS:
        raise HTTPException(status_code=415, detail=f"unsupported codec {body.codec}")
    if body.sample_rate not in SUPPORTED_SAMPLE_RATES:
        raise HTTPException(status_code=415, detail=f"unsupported sample_rate {body.sample_rate}")
    max_duration_s = DEFAULT_DURATION_S if body.max_duration_s is None else body.max_duration_s
    if max_duration_s < 1 or max_duration_s > MAX_DURATION_S:
        raise HTTPException(status_code=400, detail="max_duration_s must be 1..1800")

    stored = sessions.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    session = {
        "session_id": f"vs_{uuid.uuid4().hex}",
        "codec": body.codec,
        "sample_rate": body.sample_rate,
        "max_duration_s": max_duration_s,
        "turn_count": 0,
    }
    sessions.put(tenant, idem_key, session)
    logger.info("session open tenant=%s session=%s codec=%s", tenant, session["session_id"], body.codec)
    return JSONResponse(session, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/voice/sessions: opens the media session the realtime speech loop runs in. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const DRAFT_DURATION_S = 86400;

interface CreateSessionBody {
  codec: string;
  sample_rate: number;
  max_duration_s?: number;
}

app.post('/v1/voice/sessions', async (request, reply) => {
  // TODO: this draft accepts any codec string and any sample rate, defaults the duration to a day
  // with no cap, ignores Idempotency-Key (a reconnect forks a second session) and lets an
  // anonymous caller through. Review all four.
  const tenant = request.headers['x-tenant-id'];
  const body = request.body as CreateSessionBody;
  const session = {
    session_id: \`vs_\${randomUUID().replace(/-/g, '')}\`,
    codec: body.codec,
    sample_rate: body.sample_rate,
    max_duration_s: body.max_duration_s ?? DRAFT_DURATION_S,
  };
  request.log.info({tenant, session_id: session.session_id, codec: session.codec}, 'session open');
  return reply.code(201).send(session);
});

void app.listen({port: 8444, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/voice/sessions: a codec contract, a duration cap and a resumable session. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const SUPPORTED_CODECS: Record<string, true> = {opus: true, pcm16: true, g711_ulaw: true};
const SUPPORTED_SAMPLE_RATES: Record<number, true> = {8000: true, 16000: true, 24000: true, 48000: true};
const DEFAULT_DURATION_S = 1800;
const MAX_DURATION_S = 1800;

interface CreateSessionBody {
  codec: string;
  sample_rate: number;
  max_duration_s?: number;
}

interface VoiceSession {
  session_id: string;
  codec: string;
  sample_rate: number;
  max_duration_s: number;
  /** Turns completed so far; the turn state moves it in place. */
  turn_count: number;
}

/** The live sessions, keyed by (tenant, Idempotency-Key): the session store service in production. */
interface SessionStore {
  get(tenant: string, idemKey: string): Promise<VoiceSession | null>;
  put(tenant: string, idemKey: string, session: VoiceSession): Promise<void>;
}

const live = new Map<string, VoiceSession>();
const sessions: SessionStore = {
  async get(tenant, idemKey) {
    return live.get(\`\${tenant}:\${idemKey}\`) ?? null;
  },
  async put(tenant, idemKey, session) {
    live.set(\`\${tenant}:\${idemKey}\`, session);
  },
};

app.post('/v1/voice/sessions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<CreateSessionBody> | null;
  if (
    body === null ||
    typeof body !== 'object' ||
    typeof body.codec !== 'string' ||
    typeof body.sample_rate !== 'number'
  )
    return reply.code(400).send({error: 'codec and sample_rate are required'});
  if (SUPPORTED_CODECS[body.codec] !== true) return reply.code(415).send({error: 'unsupported codec'});
  if (SUPPORTED_SAMPLE_RATES[body.sample_rate] !== true)
    return reply.code(415).send({error: 'unsupported sample_rate'});
  const maxDurationS = body.max_duration_s ?? DEFAULT_DURATION_S;
  if (!Number.isInteger(maxDurationS) || maxDurationS < 1 || maxDurationS > MAX_DURATION_S)
    return reply.code(400).send({error: 'max_duration_s must be 1..1800'});

  const stored = await sessions.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const session: VoiceSession = {
    session_id: \`vs_\${randomUUID().replace(/-/g, '')}\`,
    codec: body.codec,
    sample_rate: body.sample_rate,
    max_duration_s: maxDurationS,
    turn_count: 0,
  };
  await sessions.put(tenant, idemKey, session);
  request.log.info({tenant, session_id: session.session_id, codec: session.codec}, 'session open');
  return reply.code(201).send(session);
});

void app.listen({port: 8444, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

const draftDurationS = 86400

type createSessionRequest struct {
	Codec        string \`json:"codec"\`
	SampleRate   int    \`json:"sample_rate"\`
	MaxDurationS int    \`json:"max_duration_s"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createSession(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body createSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft accepts any codec string and any sample rate, defaults the duration to a day
	// with no cap, ignores Idempotency-Key (a reconnect forks a second session) and lets an
	// anonymous caller through. Review all four.
	maxDuration := body.MaxDurationS
	if maxDuration == 0 {
		maxDuration = draftDurationS
	}
	session := map[string]any{
		"session_id":     "vs_" + uuid.NewString(),
		"codec":          body.Codec,
		"sample_rate":    body.SampleRate,
		"max_duration_s": maxDuration,
	}
	log.Printf("session open tenant=%s session=%s codec=%s", tenant, session["session_id"], body.Codec)
	writeJSON(rw, http.StatusCreated, session)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/voice/sessions", createSession)
	log.Fatal(http.ListenAndServeTLS(":8444", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/google/uuid"
)

const (
	defaultDurationS = 1800
	maxDurationS     = 1800
)

var supportedCodecs = map[string]bool{"opus": true, "pcm16": true, "g711_ulaw": true}

var supportedSampleRates = map[int]bool{8000: true, 16000: true, 24000: true, 48000: true}

type createSessionRequest struct {
	Codec        string \`json:"codec"\`
	SampleRate   int    \`json:"sample_rate"\`
	MaxDurationS int    \`json:"max_duration_s"\`
}

// voiceSession is what the client keeps for the rest of the call; TurnCount moves with the turn state.
type voiceSession struct {
	SessionID    string \`json:"session_id"\`
	Codec        string \`json:"codec"\`
	SampleRate   int    \`json:"sample_rate"\`
	MaxDurationS int    \`json:"max_duration_s"\`
	TurnCount    int    \`json:"turn_count"\`
}

// SessionStore holds the live sessions keyed by (tenant, Idempotency-Key): the session store
// service in production.
type SessionStore struct {
	mu   sync.Mutex
	live map[string]*voiceSession
}

func (s *SessionStore) Get(ctx context.Context, tenant, idemKey string) (*voiceSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.live[tenant+":"+idemKey], nil
}

func (s *SessionStore) Put(ctx context.Context, tenant, idemKey string, session *voiceSession) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.live[tenant+":"+idemKey] = session
	return nil
}

var sessions = &SessionStore{live: map[string]*voiceSession{}}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createSession(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body createSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if !supportedCodecs[body.Codec] {
		writeJSON(rw, http.StatusUnsupportedMediaType, map[string]string{"error": "unsupported codec"})
		return
	}
	if !supportedSampleRates[body.SampleRate] {
		writeJSON(rw, http.StatusUnsupportedMediaType, map[string]string{"error": "unsupported sample_rate"})
		return
	}
	maxDuration := body.MaxDurationS
	if maxDuration == 0 {
		maxDuration = defaultDurationS
	}
	if maxDuration < 1 || maxDuration > maxDurationS {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "max_duration_s must be 1..1800"})
		return
	}
	stored, err := sessions.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	session := &voiceSession{
		SessionID:    "vs_" + uuid.NewString(),
		Codec:        body.Codec,
		SampleRate:   body.SampleRate,
		MaxDurationS: maxDuration,
		TurnCount:    0,
	}
	if err := sessions.Put(r.Context(), tenant, idemKey, session); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("session open tenant=%s session=%s codec=%s", tenant, session.SessionID, session.Codec)
	writeJSON(rw, http.StatusCreated, session)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/voice/sessions", createSession)
	log.Fatal(http.ListenAndServeTLS(":8444", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CreateSession(codec: String, sample_rate: Int, max_duration_s: Option[Int])
final case class VoiceSession(session_id: String, codec: String, sample_rate: Int, max_duration_s: Int)

object Api {
  implicit val system: ActorSystem = ActorSystem("voice-gateway")
  implicit val createFormat: RootJsonFormat[CreateSession] = jsonFormat3(CreateSession)
  implicit val sessionFormat: RootJsonFormat[VoiceSession] = jsonFormat4(VoiceSession)

  val DraftDurationS = 86400

  val route: Route =
    path("v1" / "voice" / "sessions") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[CreateSession]) { body =>
            // TODO: this draft accepts any codec string and any sample rate, defaults the duration
            // to a day with no cap, ignores Idempotency-Key (a reconnect forks a second session)
            // and lets an anonymous caller through. Review all four.
            val session = VoiceSession(
              s"vs_\${java.util.UUID.randomUUID()}",
              body.codec,
              body.sample_rate,
              body.max_duration_s.getOrElse(DraftDurationS))
            system.log.info(s"session open tenant=$tenant session=\${session.session_id} codec=\${body.codec}")
            complete(StatusCodes.Created, session)
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8444).bind(route)
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CreateSession(codec: String, sample_rate: Int, max_duration_s: Option[Int])
final case class VoiceSession(
    session_id: String,
    codec: String,
    sample_rate: Int,
    max_duration_s: Int,
    turn_count: Int)

/** The live sessions, keyed by (tenant, Idempotency-Key): the session store service in production. */
class SessionStore {
  private val live = scala.collection.concurrent.TrieMap.empty[String, VoiceSession]

  def get(tenant: String, idemKey: String): Option[VoiceSession] = live.get(s"$tenant:$idemKey")

  def put(tenant: String, idemKey: String, session: VoiceSession): Unit =
    live.put(s"$tenant:$idemKey", session)
}

object SessionStore {
  def open(): SessionStore = new SessionStore
}

object Api {
  implicit val system: ActorSystem = ActorSystem("voice-gateway")
  implicit val createFormat: RootJsonFormat[CreateSession] = jsonFormat3(CreateSession)
  implicit val sessionFormat: RootJsonFormat[VoiceSession] = jsonFormat5(VoiceSession)

  val SupportedCodecs: Set[String] = Set("opus", "pcm16", "g711_ulaw")
  val SupportedSampleRates: Set[Int] = Set(8000, 16000, 24000, 48000)
  val DefaultDurationS = 1800
  val MaxDurationS = 1800

  val sessions = SessionStore.open()

  val route: Route =
    path("v1" / "voice" / "sessions") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[CreateSession]) { body =>
              val tenant = tenantOpt.filter(_.nonEmpty)
              val idemKey = idemOpt.filter(_.nonEmpty)
              val maxDurationS = body.max_duration_s.getOrElse(DefaultDurationS)
              if (tenant.isEmpty) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (idemKey.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (!SupportedCodecs.contains(body.codec)) {
                complete(StatusCodes.UnsupportedMediaType, """{"error":"unsupported codec"}""")
              } else if (!SupportedSampleRates.contains(body.sample_rate)) {
                complete(StatusCodes.UnsupportedMediaType, """{"error":"unsupported sample_rate"}""")
              } else if (maxDurationS < 1 || maxDurationS > MaxDurationS) {
                complete(StatusCodes.BadRequest, """{"error":"max_duration_s must be 1..1800"}""")
              } else {
                sessions.get(tenant.get, idemKey.get) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    val session = VoiceSession(
                      s"vs_\${UUID.randomUUID()}",
                      body.codec,
                      body.sample_rate,
                      maxDurationS,
                      0)
                    sessions.put(tenant.get, idemKey.get, session)
                    system.log.info(
                      s"session open tenant=\${tenant.get} session=\${session.session_id} codec=\${body.codec}")
                    complete(StatusCodes.Created, session)
                }
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8444).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

constexpr int kDraftDurationS = 86400;

std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/voice/sessions", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft accepts any codec string and any sample rate, defaults the duration to a day
    // with no cap, ignores Idempotency-Key (a reconnect forks a second session) and lets an
    // anonymous caller through. Review all four.
    const json session = {
        {"session_id", "vs_" + uuidString()},
        {"codec", body.value("codec", std::string())},
        {"sample_rate", body.value("sample_rate", 0)},
        {"max_duration_s", body.value("max_duration_s", kDraftDurationS)},
    };
    std::cerr << "session open tenant=" << tenant << " session=" << session["session_id"]
              << " codec=" << session["codec"] << "\\n";
    res.status = 201;
    res.set_content(session.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8444);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

const std::set<std::string> kSupportedCodecs = {"opus", "pcm16", "g711_ulaw"};
const std::set<int> kSupportedSampleRates = {8000, 16000, 24000, 48000};
constexpr int kDefaultDurationS = 1800;
constexpr int kMaxDurationS = 1800;

/** The live sessions, keyed by (tenant, Idempotency-Key): the session store service in production. */
struct SessionStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey) {
    const std::lock_guard<std::mutex> lock(mu_);
    const auto it = live_.find(tenant + ":" + idemKey);
    if (it == live_.end()) return std::nullopt;
    return it->second;
  }

  void put(const std::string& tenant, const std::string& idemKey, const json& session) {
    const std::lock_guard<std::mutex> lock(mu_);
    live_[tenant + ":" + idemKey] = session;
  }

 private:
  std::mutex mu_;
  std::map<std::string, json> live_;
};

SessionStore sessions;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/voice/sessions", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("codec") || !body["codec"].is_string() ||
        !body.contains("sample_rate") || !body["sample_rate"].is_number_integer()) {
      res.status = 400;
      res.set_content(R"({"error":"codec and sample_rate are required"})", "application/json");
      return;
    }
    const auto codec = body["codec"].get<std::string>();
    const int sampleRate = body["sample_rate"].get<int>();
    if (kSupportedCodecs.count(codec) == 0) {
      res.status = 415;
      res.set_content(R"({"error":"unsupported codec"})", "application/json");
      return;
    }
    if (kSupportedSampleRates.count(sampleRate) == 0) {
      res.status = 415;
      res.set_content(R"({"error":"unsupported sample_rate"})", "application/json");
      return;
    }
    const int maxDurationS = body.value("max_duration_s", kDefaultDurationS);
    if (maxDurationS < 1 || maxDurationS > kMaxDurationS) {
      res.status = 400;
      res.set_content(R"({"error":"max_duration_s must be 1..1800"})", "application/json");
      return;
    }
    const auto stored = sessions.get(tenant, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const json session = {
        {"session_id", "vs_" + uuidString()},
        {"codec", codec},
        {"sample_rate", sampleRate},
        {"max_duration_s", maxDurationS},
        {"turn_count", 0},
    };
    sessions.put(tenant, idemKey, session);
    std::cerr << "session open tenant=" << tenant << " session=" << session["session_id"] << " codec=" << codec
              << "\\n";
    res.status = 201;
    res.set_content(session.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8444);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The draft reads fine because the demo call sends one well-formed request from one tenant that never reconnects; the flaws only appear when the traffic does. A missing 401 lets an anonymous caller open media sessions on your capacity, and a codec whitelist is not pedantry: the media pipeline can only decode \`opus\`, \`pcm16\` and \`g711_ulaw\`, so any other string is a stream that is admitted and then dies mid-sentence, after the caller has already been billed for the attempt. The duration cap is what keeps one stuck client from holding a stream and its GPU forever, and the default matters as much as the cap — an omitted \`max_duration_s\` must mean 1800 seconds, not "unbounded". The idempotent resume is the flaw candidates miss most: on a flaky mobile network the reconnect is the common case, not the exception, so keying by \`Idempotency-Key\` and returning the live session with its prior \`turn_count\` is the difference between one conversation and two forked ones that bill twice and split the transcript. Real voice platforms layer on a per-tenant codec policy (the whitelist is the intersection of what the pipeline decodes and what the tenant negotiated), session affinity so the media node that owns the stream serves the resume, capacity accounting per media node before a session is admitted, and a reconnect path that rejoins the live session instead of starting over.`,
};
