import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis uniqueness keys for every identity handle',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/signup\`: it lowercases the email, checks
\`handle:email:{email}\` with \`EXISTS\`, writes the key with a separate \`SET\`, inserts the row and
answers **201**; a second signup with the same email gets **409**. It serves the demo and hides 5
flaws.

**Failure mode the checks target.** \`EXISTS\`-then-\`SET\` lets two concurrent signups both see
\`alice@x.com\` as free; nothing protects the phone, so two accounts can share one number; and a
claim that is never released refuses the address to its real owner for the whole TTL.

- Keys are \`handle:{kind}:{value}\` (\`kind\` is \`email\` or \`phone\`), built by one \`handle_key\`
  helper from \`HANDLE_KEY_PREFIX\`, stored in Redis with \`HANDLE_TTL_S\` (**7 days**).
- Each handle is claimed with one atomic set-if-absent (\`SET … NX EX\`, \`setnx\`, \`SetNX\`,
  \`SET … NOT_EXIST\`) whose reply decides ownership.
- Claim the email *and* the phone; if the second claim is refused, release the first, then answer
  **409 Conflict**.
- Claims happen **before** the insert; a signup that loses a claim creates no row.
- If the insert fails, delete every claimed key before the **503**.`,
  sequence: {
    participants: ['Client', 'Identity Service', 'Redis', 'Accounts DB'],
    messages: [
      {from: 'Client', to: 'Identity Service', label: 'POST /v1/signup {email, phone}', kind: 'sync'},
      {from: 'Identity Service', to: 'Redis', label: 'SET handle:email:ada@x.com NX EX 604800', kind: 'sync'},
      {from: 'Redis', to: 'Identity Service', label: 'OK — this signup owns the address', kind: 'reply'},
      {from: 'Identity Service', to: 'Redis', label: 'SET handle:phone:+15550100 NX EX 604800', kind: 'sync'},
      {from: 'Redis', to: 'Identity Service', label: 'OK — every handle of the account is claimed', kind: 'reply'},
      {from: 'Identity Service', to: 'Accounts DB', label: 'INSERT INTO accounts (id, email, phone)', kind: 'sync'},
      {from: 'Accounts DB', to: 'Identity Service', label: 'id = u_7f2c', kind: 'reply'},
      {from: 'Identity Service', to: 'Client', label: '201 {id}', kind: 'reply'},
      {
        from: 'Redis',
        to: 'Identity Service',
        label: 'nil on a concurrent signup for the same handle → 409, no row',
        kind: 'reply',
      },
      {
        from: 'Identity Service',
        to: 'Redis',
        label: 'DEL handle:email:… handle:phone:… when the insert fails',
        kind: 'async',
      },
    ],
  },
  hints: [
    'Two people who signed up at the same second both got `alice@x.com`; two accounts share one phone; and a signup whose insert failed left the address refused to its owner for a week.',
    '`EXISTS` then `SET` is two round trips with a window between them, the phone is never claimed, the key is spelled inline rather than built from one helper, and the failure path deletes nothing.',
    'Add `handle_key` over `HANDLE_KEY_PREFIX`, claim email and phone with `SET … NX EX HANDLE_TTL_S` before the insert, answer 409 on a refused claim, and `release_claims` every key when `create_account` fails.',
  ],
  checks: [
    {
      id: 'namespace',
      title: 'Every claim lives in one named Redis namespace',
      detail:
        'All handles are claimed under `HANDLE_KEY_PREFIX` as `handle:{kind}:{value}`, built by one `handle_key` helper, and carry `HANDLE_TTL_S` (**7 days**) so a claim survives a restart and ages out on its own. Keys spelled out inline on one path and not on another are two namespaces, and two namespaces quietly mean two identities.',
      match: {
        python: {all: [/HANDLE_KEY_PREFIX/, /def handle_key\(/, /HANDLE_TTL_S/]},
        typescript: {all: [/HANDLE_KEY_PREFIX/, /function handleKey\(/, /HANDLE_TTL_S/]},
        go: {all: [/handleKeyPrefix/, /func handleKey\(/, /handleTTL/]},
        scala: {all: [/HandleKeyPrefix/, /def handleKey\(/, /HandleTtlSeconds/]},
        cpp: {all: [/kHandleKeyPrefix/, /handleKey\(/, /kHandleTtlSeconds/]},
      },
    },
    {
      id: 'email-atomic',
      title: 'The email handle is claimed with one atomic SET NX',
      detail:
        'One `SET handle:email:… NX EX HANDLE_TTL_S` both asks whether the address is free and claims it, and its reply is the decision. The starter reads with `EXISTS` and writes with a separate `SET`: between the two commands a concurrent signup sees the same address as free, and one address becomes two accounts.',
      match: {
        python: {all: [/claim_handle\(\s*["']email["']/, /nx=True/], none: [/\br\.(get|exists)\(/]},
        typescript: {all: [/claimHandle\(\s*'email'/, /'NX'/], none: [/\br\.(get|exists)\(/]},
        go: {all: [/claimHandle\([^\n]*"email"/, /SetNX\(/], none: [/\brdb\.(Get|Exists)\(/]},
        scala: {all: [/claimHandle\(\s*"email"/, /\.nx\(\)/], none: [/\bjedis\.(get|exists)\(/]},
        cpp: {all: [/claimHandle\([^\n]*"email"/, /UpdateType::NOT_EXIST/], none: [/\bredis\.(get|exists)\(/]},
      },
    },
    {
      id: 'phone-claimed',
      title: 'The phone handle is claimed through the same atomic path',
      detail:
        'The phone goes through the same `handle_key` + set-if-absent claim as the email, so one number cannot back two accounts. The starter claims only the email: a second signup with the same phone succeeds and the same person — or whoever the carrier recycled the number to — gets a second account.',
      match: {
        python: {all: [/claim_handle\(\s*["']phone["']/, /nx=True/]},
        typescript: {all: [/claimHandle\(\s*'phone'/, /'NX'/]},
        go: {all: [/claimHandle\([^\n]*"phone"/, /SetNX\(/]},
        scala: {all: [/claimHandle\(\s*"phone"/, /\.nx\(\)/]},
        cpp: {all: [/claimHandle\([^\n]*"phone"/, /UpdateType::NOT_EXIST/]},
      },
    },
    {
      id: 'release-on-abort',
      title: 'An aborted signup releases every key it claimed',
      detail:
        '`release_claims` deletes every key the signup claimed and the failure path calls it: when the row is not written the handles go back to the pool. The starter leaves its claim behind, so an address it never confirmed is refused to its real owner until the TTL runs out.',
      match: {
        python: {all: [/def release_claims/, /\.delete\(/], order: [/nx=True/, /(?<!def )release_claims\(/]},
        typescript: {
          all: [/async function releaseClaims/, /\.del\(/],
          order: [/'NX'/, /(?<!function )releaseClaims\(/],
        },
        go: {all: [/func releaseClaims/, /\.Del\(/], order: [/SetNX\(/, /(?<!func )releaseClaims\(/]},
        scala: {all: [/def releaseClaims/, /jedis\.del\(/], order: [/\.nx\(\)/, /(?<!def )releaseClaims\(/]},
        cpp: {all: [/void releaseClaims/, /redis\.del\(/], order: [/NOT_EXIST/, /(?<!void )releaseClaims\(/]},
      },
    },
    {
      id: 'one-winner',
      title: 'Concurrent signups for one handle yield one account',
      detail:
        'The claim is one atomic set-if-absent and it happens **before** the row is inserted, so of two concurrent signups for one handle exactly one wins, and the loser is told **409 Conflict** — not handed a second account. The starter checks, then writes, then inserts: both signups pass the check and both rows exist.',
      match: {
        python: {all: [/nx=True/, /status_code\s*=\s*409/], order: [/\.set\([^\n]*nx=True/, /create_account\(/]},
        typescript: {all: [/'NX'/, /\.code\(\s*409\s*\)/], order: [/\.set\([^\n]*'NX'/, /createAccount\(/]},
        go: {all: [/SetNX\(/, /StatusConflict/], order: [/SetNX\(/, /createAccount\(/]},
        scala: {all: [/\.nx\(\)/, /StatusCodes\.Conflict/], order: [/\.nx\(\)/, /createAccount\(/]},
        cpp: {all: [/UpdateType::NOT_EXIST/, /status\s*=\s*409/], order: [/NOT_EXIST/, /createAccount\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import sqlite3
import uuid

import redis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)
db = sqlite3.connect("identity.db", check_same_thread=False)

HANDLE_TTL_S = 7 * 24 * 3600

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL
)
"""
db.execute(SCHEMA)


class SignupRequest(BaseModel):
    email: str
    phone: str
    password: str


def create_account(email: str, phone: str, password: str) -> dict:
    user_id = uuid.uuid4().hex
    db.execute(
        "INSERT INTO accounts (id, email, phone, password_hash) VALUES (?, ?, ?, ?)",
        (user_id, email, phone, hashlib.sha256(password.encode()).hexdigest()),
    )
    db.commit()
    return {"id": user_id, "email": email, "phone": phone}


@app.post("/v1/signup", status_code=201)
def signup(body: SignupRequest) -> dict:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    email = body.email.strip().lower()
    phone = body.phone.strip()
    key = f"handle:email:{email}"
    if r.exists(key):
        raise HTTPException(status_code=409, detail="email is already registered")
    r.set(key, email, ex=HANDLE_TTL_S)
    return create_account(email, phone, body.password)
`,
      solution: `import hashlib
import sqlite3
import uuid

import redis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)
db = sqlite3.connect("identity.db", check_same_thread=False)

HANDLE_KEY_PREFIX = "handle"
HANDLE_TTL_S = 7 * 24 * 3600

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL
)
"""
db.execute(SCHEMA)


class SignupRequest(BaseModel):
    email: str
    phone: str
    password: str


def handle_key(kind: str, value: str) -> str:
    return f"{HANDLE_KEY_PREFIX}:{kind}:{value}"


def create_account(email: str, phone: str, password: str) -> dict:
    user_id = uuid.uuid4().hex
    db.execute(
        "INSERT INTO accounts (id, email, phone, password_hash) VALUES (?, ?, ?, ?)",
        (user_id, email, phone, hashlib.sha256(password.encode()).hexdigest()),
    )
    db.commit()
    return {"id": user_id, "email": email, "phone": phone}


def release_claims(keys: list[str]) -> None:
    # A claim that outlives its account refuses the address to its real owner for the whole TTL:
    # an aborted signup must give every handle back.
    if keys:
        r.delete(*keys)


def claim_handle(kind: str, value: str) -> str:
    """One SET NX claims the handle; a falsy reply means somebody else owns it."""
    key = handle_key(kind, value)
    if not r.set(key, value, nx=True, ex=HANDLE_TTL_S):
        raise HTTPException(status_code=409, detail=f"{kind} is already registered")
    return key


def claim_handles(email: str, phone: str) -> list[str]:
    claimed: list[str] = []
    try:
        claimed.append(claim_handle("email", email))
        claimed.append(claim_handle("phone", phone))
    except HTTPException:
        release_claims(claimed)  # the refusal must not keep the first handle
        raise
    return claimed


@app.post("/v1/signup", status_code=201)
def signup(body: SignupRequest) -> dict:
    email = body.email.strip().lower()
    phone = body.phone.strip()
    claimed = claim_handles(email, phone)
    try:
        account = create_account(email, phone, body.password)
    except Exception as exc:
        release_claims(claimed)  # the row was not written: every handle goes back
        raise HTTPException(status_code=503, detail="signup failed, try again") from exc
    return account
`,
    },
    typescript: {
      starter: `/** POST /v1/signup. */
import {createHash, randomUUID} from 'node:crypto';

import Database from 'better-sqlite3';
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');
const db = new Database('identity.db');

const HANDLE_TTL_S = 7 * 24 * 3600;

const SCHEMA = \`
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL
)
\`;
db.exec(SCHEMA);

interface SignupBody {
  email: string;
  phone: string;
  password: string;
}

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

function createAccount(email: string, phone: string, password: string): {id: string; email: string; phone: string} {
  const id = randomUUID();
  db.prepare('INSERT INTO accounts (id, email, phone, password_hash) VALUES (?, ?, ?, ?)').run(
    id,
    email,
    phone,
    hashPassword(password),
  );
  return {id, email, phone};
}

app.post('/v1/signup', async (request, reply) => {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const body = request.body as SignupBody;
  const email = body.email.trim().toLowerCase();
  const phone = body.phone.trim();
  const key = \`handle:email:\${email}\`;
  if ((await r.exists(key)) === 1) return reply.code(409).send({error: 'email is already registered'});
  await r.set(key, email, 'EX', HANDLE_TTL_S);
  return reply.code(201).send(createAccount(email, phone, body.password));
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/signup: claim every handle atomically, then write the row. */
import {createHash, randomUUID} from 'node:crypto';

import Database from 'better-sqlite3';
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');
const db = new Database('identity.db');

const HANDLE_KEY_PREFIX = 'handle';
const HANDLE_TTL_S = 7 * 24 * 3600;

const SCHEMA = \`
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL
)
\`;
db.exec(SCHEMA);

interface SignupBody {
  email: string;
  phone: string;
  password: string;
}

function handleKey(kind: string, value: string): string {
  return \`\${HANDLE_KEY_PREFIX}:\${kind}:\${value}\`;
}

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

function createAccount(email: string, phone: string, password: string): {id: string; email: string; phone: string} {
  const id = randomUUID();
  db.prepare('INSERT INTO accounts (id, email, phone, password_hash) VALUES (?, ?, ?, ?)').run(
    id,
    email,
    phone,
    hashPassword(password),
  );
  return {id, email, phone};
}

// A claim that outlives its account refuses the address to its real owner for the whole TTL: an
// aborted signup must give every handle back.
async function releaseClaims(keys: string[]): Promise<void> {
  if (keys.length > 0) await r.del(...keys);
}

/** One SET NX claims the handle; null means somebody else owns it. */
async function claimHandle(kind: string, value: string): Promise<string | null> {
  const key = handleKey(kind, value);
  const won = await r.set(key, value, 'EX', HANDLE_TTL_S, 'NX');
  return won === null ? null : key;
}

async function claimHandles(email: string, phone: string): Promise<string[] | null> {
  const emailKey = await claimHandle('email', email);
  if (emailKey === null) return null;
  const phoneKey = await claimHandle('phone', phone);
  if (phoneKey === null) {
    await releaseClaims([emailKey]); // the refusal must not keep the first handle
    return null;
  }
  return [emailKey, phoneKey];
}

app.post('/v1/signup', async (request, reply) => {
  const body = request.body as SignupBody;
  const email = body.email.trim().toLowerCase();
  const phone = body.phone.trim();
  const claimed = await claimHandles(email, phone);
  if (claimed === null) return reply.code(409).send({error: 'handle already registered'});
  try {
    const account = createAccount(email, phone, body.password);
    return reply.code(201).send(account);
  } catch (err) {
    await releaseClaims(claimed); // the row was not written: every handle goes back
    return reply.code(503).send({error: 'signup failed, try again'});
  }
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	_ "modernc.org/sqlite"
)

const handleTTL = 7 * 24 * time.Hour

const schema = \`
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL
)\`

var (
	rdb *redis.Client
	db  *sql.DB
)

func hashPassword(password string) string {
	sum := sha256.Sum256([]byte(password))
	return hex.EncodeToString(sum[:])
}

func newID() string {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func createAccount(ctx context.Context, email, phone, password string) (string, error) {
	id := newID()
	_, err := db.ExecContext(
		ctx,
		"INSERT INTO accounts (id, email, phone, password_hash) VALUES (?, ?, ?, ?)",
		id,
		email,
		phone,
		hashPassword(password),
	)
	if err != nil {
		return "", err
	}
	return id, nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func signup(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	body := struct {
		Email    string \`json:"email"\`
		Phone    string \`json:"phone"\`
		Password string \`json:"password"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	email := strings.ToLower(strings.TrimSpace(body.Email))
	phone := strings.TrimSpace(body.Phone)

	key := "handle:email:" + email
	if n, _ := rdb.Exists(r.Context(), key).Result(); n > 0 {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "email is already registered"})
		return
	}
	_ = rdb.Set(r.Context(), key, email, handleTTL)
	id, err := createAccount(r.Context(), email, phone, body.Password)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "signup failed, try again"})
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]string{"id": id, "email": email, "phone": phone})
}

func main() {}
`,
      solution: `package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	_ "modernc.org/sqlite"
)

const (
	handleKeyPrefix = "handle"
	handleTTL       = 7 * 24 * time.Hour
)

const schema = \`
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL
)\`

var (
	rdb *redis.Client
	db  *sql.DB
)

var errHandleTaken = errors.New("handle already registered")

func handleKey(kind, value string) string {
	return fmt.Sprintf("%s:%s:%s", handleKeyPrefix, kind, value)
}

func hashPassword(password string) string {
	sum := sha256.Sum256([]byte(password))
	return hex.EncodeToString(sum[:])
}

func newID() string {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func createAccount(ctx context.Context, email, phone, password string) (string, error) {
	id := newID()
	_, err := db.ExecContext(
		ctx,
		"INSERT INTO accounts (id, email, phone, password_hash) VALUES (?, ?, ?, ?)",
		id,
		email,
		phone,
		hashPassword(password),
	)
	if err != nil {
		return "", err
	}
	return id, nil
}

// A claim that outlives its account refuses the address to its real owner for the whole TTL: an
// aborted signup must give every handle back.
func releaseClaims(ctx context.Context, keys []string) {
	if len(keys) == 0 {
		return
	}
	_ = rdb.Del(ctx, keys...).Err()
}

// claimHandle claims one handle; errHandleTaken means somebody else owns it.
func claimHandle(ctx context.Context, kind, value string) (string, error) {
	key := handleKey(kind, value)
	won, err := rdb.SetNX(ctx, key, value, handleTTL).Result()
	if err != nil {
		return "", err
	}
	if !won {
		return "", errHandleTaken
	}
	return key, nil
}

func claimHandles(ctx context.Context, email, phone string) ([]string, error) {
	emailKey, err := claimHandle(ctx, "email", email)
	if err != nil {
		return nil, err
	}
	phoneKey, err := claimHandle(ctx, "phone", phone)
	if err != nil {
		releaseClaims(ctx, []string{emailKey}) // the refusal must not keep the first handle
		return nil, err
	}
	return []string{emailKey, phoneKey}, nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func signup(rw http.ResponseWriter, r *http.Request) {
	body := struct {
		Email    string \`json:"email"\`
		Phone    string \`json:"phone"\`
		Password string \`json:"password"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	email := strings.ToLower(strings.TrimSpace(body.Email))
	phone := strings.TrimSpace(body.Phone)

	claimed, err := claimHandles(r.Context(), email, phone)
	if errors.Is(err, errHandleTaken) {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "handle already registered"})
		return
	}
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "claim store unavailable"})
		return
	}
	id, err := createAccount(r.Context(), email, phone, body.Password)
	if err != nil {
		releaseClaims(r.Context(), claimed) // the row was not written: every handle goes back
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "signup failed, try again"})
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]string{"id": id, "email": email, "phone": phone})
}

func main() {}
`,
    },
    scala: {
      starter: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.sql.{Connection, DriverManager}
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class SignupRequest(email: String, phone: String, password: String)

object SignupApi {
  implicit val system: ActorSystem = ActorSystem("identity-service")
  implicit val signupFormat: RootJsonFormat[SignupRequest] = jsonFormat3(SignupRequest)

  val HandleTtlSeconds = 7 * 24 * 3600L
  val jedis = new Jedis("redis", 6379)
  val db: Connection = DriverManager.getConnection("jdbc:sqlite:identity.db")

  val Schema =
    """
      |CREATE TABLE IF NOT EXISTS accounts (
      |  id TEXT PRIMARY KEY,
      |  email TEXT NOT NULL UNIQUE,
      |  phone TEXT NOT NULL,
      |  password_hash TEXT NOT NULL
      |)
      |""".stripMargin
  db.createStatement().execute(Schema)

  def hashPassword(password: String): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(password.getBytes(StandardCharsets.UTF_8))
      .map("%02x".format(_))
      .mkString

  def createAccount(email: String, phone: String, password: String): String = {
    val id = UUID.randomUUID().toString
    val stmt = db.prepareStatement("INSERT INTO accounts (id, email, phone, password_hash) VALUES (?, ?, ?, ?)")
    stmt.setString(1, id)
    stmt.setString(2, email)
    stmt.setString(3, phone)
    stmt.setString(4, hashPassword(password))
    stmt.executeUpdate() // throws when the row cannot be written
    id
  }

  val route: Route =
    path("v1" / "signup") {
      post {
        entity(as[SignupRequest]) { body =>
          // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
          val email = body.email.trim.toLowerCase
          val phone = body.phone.trim
          val key = s"handle:email:$email"
          if (jedis.exists(key)) {
            complete(
              HttpResponse(
                StatusCodes.Conflict,
                entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"email is already registered"}""")
              )
            )
          } else {
            jedis.set(key, email, SetParams.setParams().ex(HandleTtlSeconds))
            try {
              val id = createAccount(email, phone, body.password)
              complete(StatusCodes.Created, s"""{"id":"$id","email":"$email","phone":"$phone"}""")
            } catch {
              case _: Exception =>
                complete(
                  HttpResponse(
                    StatusCodes.ServiceUnavailable,
                    entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"signup failed, try again"}""")
                  )
                )
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.sql.{Connection, DriverManager}
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class SignupRequest(email: String, phone: String, password: String)

object SignupApi {
  implicit val system: ActorSystem = ActorSystem("identity-service")
  implicit val signupFormat: RootJsonFormat[SignupRequest] = jsonFormat3(SignupRequest)

  val HandleKeyPrefix = "handle"
  val HandleTtlSeconds = 7 * 24 * 3600L
  val jedis = new Jedis("redis", 6379)
  val db: Connection = DriverManager.getConnection("jdbc:sqlite:identity.db")

  val Schema =
    """
      |CREATE TABLE IF NOT EXISTS accounts (
      |  id TEXT PRIMARY KEY,
      |  email TEXT NOT NULL UNIQUE,
      |  phone TEXT NOT NULL,
      |  password_hash TEXT NOT NULL
      |)
      |""".stripMargin
  db.createStatement().execute(Schema)

  def handleKey(kind: String, value: String): String = s"$HandleKeyPrefix:$kind:$value"

  def hashPassword(password: String): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(password.getBytes(StandardCharsets.UTF_8))
      .map("%02x".format(_))
      .mkString

  def createAccount(email: String, phone: String, password: String): String = {
    val id = UUID.randomUUID().toString
    val stmt = db.prepareStatement("INSERT INTO accounts (id, email, phone, password_hash) VALUES (?, ?, ?, ?)")
    stmt.setString(1, id)
    stmt.setString(2, email)
    stmt.setString(3, phone)
    stmt.setString(4, hashPassword(password))
    stmt.executeUpdate() // throws when the row cannot be written
    id
  }

  // A claim that outlives its account refuses the address to its real owner for the whole TTL: an
  // aborted signup must give every handle back.
  def releaseClaims(keys: Seq[String]): Unit = {
    if (keys.nonEmpty) jedis.del(keys: _*)
  }

  // One SET NX claims the handle; a null reply means somebody else owns it.
  def claimHandle(kind: String, value: String): Option[String] = {
    val key = handleKey(kind, value)
    val claimed = jedis.set(key, value, SetParams.setParams().nx().ex(HandleTtlSeconds))
    if (claimed == null) None else Some(key)
  }

  def claimHandles(email: String, phone: String): Option[Seq[String]] =
    claimHandle("email", email) match {
      case None => None
      case Some(emailKey) =>
        claimHandle("phone", phone) match {
          case Some(phoneKey) => Some(Seq(emailKey, phoneKey))
          case None =>
            releaseClaims(Seq(emailKey)) // the refusal must not keep the first handle
            None
        }
    }

  val route: Route =
    path("v1" / "signup") {
      post {
        entity(as[SignupRequest]) { body =>
          val email = body.email.trim.toLowerCase
          val phone = body.phone.trim
          claimHandles(email, phone) match {
            case None =>
              complete(
                HttpResponse(
                  StatusCodes.Conflict,
                  entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"handle already registered"}""")
                )
              )
            case Some(claimed) =>
              try {
                val id = createAccount(email, phone, body.password)
                complete(StatusCodes.Created, s"""{"id":"$id","email":"$email","phone":"$phone"}""")
              } catch {
                case _: Exception =>
                  releaseClaims(claimed) // the row was not written: every handle goes back
                  complete(
                    HttpResponse(
                      StatusCodes.ServiceUnavailable,
                      entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"signup failed, try again"}""")
                    )
                  )
              }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sqlite3.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <optional>
#include <random>
#include <sstream>
#include <string>

using json = nlohmann::json;

constexpr long long kHandleTtlSeconds = 7 * 24 * 3600;

const char* kSchema = R"SQL(
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL
)
)SQL";

std::string trim(const std::string& text) {
  const auto begin = text.find_first_not_of(" \\t\\r\\n");
  if (begin == std::string::npos) return std::string();
  return text.substr(begin, text.find_last_not_of(" \\t\\r\\n") - begin + 1);
}

std::string lower(std::string text) {
  std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return text;
}

std::string newId() {
  std::random_device device;
  std::mt19937_64 generator(device());
  std::uniform_int_distribution<unsigned long long> dist;
  std::ostringstream out;
  out << std::hex << dist(generator) << dist(generator);
  return out.str();
}

std::string hashPassword(const std::string& password) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(password.data()), password.size(), digest);
  std::string hex(SHA256_DIGEST_LENGTH * 2, '0');
  for (std::size_t i = 0; i < SHA256_DIGEST_LENGTH; ++i) std::snprintf(&hex[i * 2], 3, "%02x", digest[i]);
  return hex;
}

std::optional<std::string> createAccount(
    sqlite3* db,
    const std::string& email,
    const std::string& phone,
    const std::string& password) {
  const auto id = newId();
  const auto hash = hashPassword(password);
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(
          db,
          "INSERT INTO accounts (id, email, phone, password_hash) VALUES (?, ?, ?, ?)",
          -1,
          &stmt,
          nullptr) != SQLITE_OK) {
    return std::nullopt;
  }
  sqlite3_bind_text(stmt, 1, id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 2, email.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 3, phone.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 4, hash.c_str(), -1, SQLITE_TRANSIENT);
  const int rc = sqlite3_step(stmt);
  sqlite3_finalize(stmt);
  if (rc != SQLITE_DONE) return std::nullopt;
  return id;
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  sqlite3* db = nullptr;
  sqlite3_open("identity.db", &db);
  sqlite3_exec(db, kSchema, nullptr, nullptr, nullptr);

  httplib::Server svr;
  svr.Post("/v1/signup", [&](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto email = lower(trim(body.value("email", std::string())));
    const auto phone = trim(body.value("phone", std::string()));

    const auto key = "handle:email:" + email;
    if (redis.exists(key) > 0) {
      res.status = 409;
      res.set_content(R"({"error":"email is already registered"})", "application/json");
      return;
    }
    redis.set(key, email, kHandleTtlSeconds);
    const auto account = createAccount(db, email, phone, body.value("password", std::string()));
    if (!account) {
      res.status = 503;
      res.set_content(R"({"error":"signup failed, try again"})", "application/json");
      return;
    }
    res.status = 201;
    res.set_content(json{{"id", *account}, {"email", email}, {"phone", phone}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sqlite3.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <optional>
#include <random>
#include <sstream>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr const char* kHandleKeyPrefix = "handle";
constexpr long long kHandleTtlSeconds = 7 * 24 * 3600;

const char* kSchema = R"SQL(
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL
)
)SQL";

std::string handleKey(const std::string& kind, const std::string& value) {
  return std::string(kHandleKeyPrefix) + ":" + kind + ":" + value;
}

std::string trim(const std::string& text) {
  const auto begin = text.find_first_not_of(" \\t\\r\\n");
  if (begin == std::string::npos) return std::string();
  return text.substr(begin, text.find_last_not_of(" \\t\\r\\n") - begin + 1);
}

std::string lower(std::string text) {
  std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return text;
}

std::string newId() {
  std::random_device device;
  std::mt19937_64 generator(device());
  std::uniform_int_distribution<unsigned long long> dist;
  std::ostringstream out;
  out << std::hex << dist(generator) << dist(generator);
  return out.str();
}

std::string hashPassword(const std::string& password) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(password.data()), password.size(), digest);
  std::string hex(SHA256_DIGEST_LENGTH * 2, '0');
  for (std::size_t i = 0; i < SHA256_DIGEST_LENGTH; ++i) std::snprintf(&hex[i * 2], 3, "%02x", digest[i]);
  return hex;
}

std::optional<std::string> createAccount(
    sqlite3* db,
    const std::string& email,
    const std::string& phone,
    const std::string& password) {
  const auto id = newId();
  const auto hash = hashPassword(password);
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(
          db,
          "INSERT INTO accounts (id, email, phone, password_hash) VALUES (?, ?, ?, ?)",
          -1,
          &stmt,
          nullptr) != SQLITE_OK) {
    return std::nullopt;
  }
  sqlite3_bind_text(stmt, 1, id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 2, email.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 3, phone.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 4, hash.c_str(), -1, SQLITE_TRANSIENT);
  const int rc = sqlite3_step(stmt);
  sqlite3_finalize(stmt);
  if (rc != SQLITE_DONE) return std::nullopt;
  return id;
}

// A claim that outlives its account refuses the address to its real owner for the whole TTL: an
// aborted signup must give every handle back.
void releaseClaims(sw::redis::Redis& redis, const std::vector<std::string>& keys) {
  for (const auto& key : keys) redis.del(key);
}

// One SET NX claims the handle; std::nullopt means somebody else owns it.
std::optional<std::string> claimHandle(
    sw::redis::Redis& redis,
    const std::string& kind,
    const std::string& value) {
  const auto key = handleKey(kind, value);
  const bool won = redis.set(key, value, kHandleTtlSeconds, sw::redis::UpdateType::NOT_EXIST);
  if (!won) return std::nullopt;
  return key;
}

std::optional<std::vector<std::string>> claimHandles(
    sw::redis::Redis& redis,
    const std::string& email,
    const std::string& phone) {
  const auto emailKey = claimHandle(redis, "email", email);
  if (!emailKey) return std::nullopt;
  const auto phoneKey = claimHandle(redis, "phone", phone);
  if (!phoneKey) {
    releaseClaims(redis, {*emailKey}); // the refusal must not keep the first handle
    return std::nullopt;
  }
  return std::vector<std::string>{*emailKey, *phoneKey};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  sqlite3* db = nullptr;
  sqlite3_open("identity.db", &db);
  sqlite3_exec(db, kSchema, nullptr, nullptr, nullptr);

  httplib::Server svr;
  svr.Post("/v1/signup", [&](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto email = lower(trim(body.value("email", std::string())));
    const auto phone = trim(body.value("phone", std::string()));

    const auto claimed = claimHandles(redis, email, phone);
    if (!claimed) {
      res.status = 409;
      res.set_content(R"({"error":"handle already registered"})", "application/json");
      return;
    }
    const auto account = createAccount(db, email, phone, body.value("password", std::string()));
    if (!account) {
      releaseClaims(redis, *claimed); // the row was not written: every handle goes back
      res.status = 503;
      res.set_content(R"({"error":"signup failed, try again"})", "application/json");
      return;
    }
    res.status = 201;
    res.set_content(json{{"id", *account}, {"email", email}, {"phone", phone}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The fix is one atomic command because a claim has to be the check: \`SET NX EX\` asks "is this handle free?" and takes it in one round trip, so concurrent signups for one address produce one account. One \`handle_key\` helper protects the phone exactly like the email, and the TTL keeps an unconfirmed claim from pinning an address forever. A claim is a reservation for an account that does not exist yet, so it goes back when the insert fails.

Production identity services store the user id in the claim so a taken address traces to its account, and keep \`UNIQUE (email, phone)\` in the table as the last defence against a claim-path bug.`,
};
