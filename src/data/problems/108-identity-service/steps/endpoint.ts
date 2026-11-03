import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/users: one human, one account',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db', 'redis'],
  task: `## Task

**Starting point.** The starter registers \`POST /v1/users\` with body
\`{"email": "…", "phone": "…"}\`, validates the fields, looks the raw email up in the store and
writes a user row. It serves the demo (one lowercase signup) and hides 4 flaws.

**Failure mode the checks target.** Raw string comparison makes \`Alice@x.com\` and \`alice@x.com\`
(and \`(415) 555-0100\` and \`+14155550100\`) two identities. The ignored \`Idempotency-Key\` turns every
client retry into another account, and the 409 echoes the submitted address, so an unauthenticated
caller learns which addresses have accounts.

- \`Idempotency-Key\` is required (**400**); \`email\` is at most **254** bytes with a local part and a
  dotted domain (**422**).
- Case-fold the email; for a domain in \`FOLD_ALIAS_DOMAINS\` (\`gmail.com\`, \`googlemail.com\`) also
  drop \`.\` from the local part and everything from the first \`+\`.
- Normalize \`phone\`: keep digits, drop a leading \`00\`, require **8–15** digits, canonical
  \`+<digits>\` (**422** otherwise).
- Claim the canonical phone with \`SET NX\` **before** the email lookup, then the email; a lost claim
  is **409** and a lost email claim releases the phone claim.
- Every collision answers **409** \`{"error": "signup_conflict"}\`.
- A retry with the same \`Idempotency-Key\` returns the original \`user_id\` with **200** and creates
  nothing; a new account answers **201**
  \`{"user_id": …, "email": <canonical>, "status": "pending_verification"}\`.`,
  sequence: {
    participants: ['Client', 'Identity API', 'Redis', 'users table'],
    messages: [
      {from: 'Client', to: 'Identity API', label: 'POST /v1/users · Idempotency-Key · {email, phone}', kind: 'sync'},
      {
        from: 'Identity API',
        to: 'Identity API',
        label: 'normalize email + phone · malformed is 422',
        kind: 'sync',
      },
      {from: 'Identity API', to: 'Redis', label: 'GET idem:{key}', kind: 'sync'},
      {from: 'Redis', to: 'Identity API', label: 'original user_id / none', kind: 'reply'},
      {from: 'Identity API', to: 'Redis', label: 'SET NX phone:{e164} → user_id', kind: 'sync'},
      {from: 'Identity API', to: 'Redis', label: 'SET NX email:{canonical} → user_id', kind: 'sync'},
      {from: 'Identity API', to: 'users table', label: 'INSERT user (pending_verification)', kind: 'sync'},
      {from: 'Identity API', to: 'Redis', label: 'SET idem:{key} → user_id, TTL 24h', kind: 'async'},
      {
        from: 'Identity API',
        to: 'Client',
        label: '201 created · 200 replay · 409 neutral',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/users',
      detail: 'Register the signup route on `POST /v1/users`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/users["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/users['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/users"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"users"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/users"/]},
      },
    },
    {
      id: 'normalize-email',
      title: 'Folds case and the domain alias policy before the email lookup',
      detail:
        'A named `normalize_email`/`normalizeEmail` helper case-folds the address and, for a domain in `FOLD_ALIAS_DOMAINS`, folds out dots and `+` aliases, and the canonical form — not the raw string — is what the email claim compares. The starter compares raw strings, so `Alice@x.com` and `alice@x.com` become two accounts.',
      match: {
        python: {
          all: [/def normalize_email\(/, /FOLD_ALIAS_DOMAINS/, /\.lower\(\)/, /store\.claim_email\(/],
          order: [/=\s*normalize_email\(/, /store\.claim_email\(/],
        },
        typescript: {
          all: [/function normalizeEmail\(/, /FOLD_ALIAS_DOMAINS/, /toLowerCase\(\)/, /store\.claimEmail\(/],
          order: [/=\s*normalizeEmail\(/, /store\.claimEmail\(/],
        },
        go: {
          all: [/func normalizeEmail\(/, /foldAliasDomains/, /ToLower\(/, /store\.ClaimEmail\(/],
          order: [/:=\s*normalizeEmail\(/, /store\.ClaimEmail\(/],
        },
        scala: {
          all: [/def normalizeEmail\(/, /FoldAliasDomains/, /toLowerCase/, /store\.claimEmail\(/],
          order: [/=\s*normalizeEmail\(/, /store\.claimEmail\(/],
        },
        cpp: {
          all: [/normalizeEmail\(const std::string&/, /kFoldAliasDomains/, /tolower/, /store\.claimEmail\(/],
          order: [/=\s*normalizeEmail\(/, /store\.claimEmail\(/],
        },
      },
    },
    {
      id: 'claim-phone',
      title: 'Normalizes the phone and claims it before the email lookup',
      detail:
        '`normalize_phone`/`normalizePhone` canonicalizes to E.164 with an 8–15 digit rule, and the canonical number is claimed atomically — `SET NX`, not a read-then-insert — before the email claim. The starter compares raw phone strings, so two spellings of one number become two identities.',
      match: {
        python: {
          all: [/def normalize_phone\(/, /PHONE_MIN_DIGITS/, /store\.claim_phone\(/],
          order: [/=\s*normalize_phone\(/, /store\.claim_phone\(/],
        },
        typescript: {
          all: [/function normalizePhone\(/, /PHONE_MIN_DIGITS/, /store\.claimPhone\(/],
          order: [/=\s*normalizePhone\(/, /store\.claimPhone\(/],
        },
        go: {
          all: [/func normalizePhone\(/, /phoneMinDigits/, /store\.ClaimPhone\(/],
          order: [/:=\s*normalizePhone\(/, /store\.ClaimPhone\(/],
        },
        scala: {
          all: [/def normalizePhone\(/, /PhoneMinDigits/, /store\.claimPhone\(/],
          order: [/=\s*normalizePhone\(/, /store\.claimPhone\(/],
        },
        cpp: {
          all: [/normalizePhone\(const std::string&/, /kPhoneMinDigits/, /store\.claimPhone\(/],
          order: [/=\s*normalizePhone\(/, /store\.claimPhone\(/],
        },
      },
    },
    {
      id: 'idempotency-key',
      title: 'Replays the Idempotency-Key as the original account',
      detail:
        'The `Idempotency-Key` is looked up before any claim or write; a hit answers **200** with the **original** `user_id` read back from the stored record and creates nothing, while **201** marks the request that created the account. The record is written as part of the same handler, so the retry that arrives when the confirmation mail is slow finds it. The starter ignores the header and creates a second account on every retry.',
      match: {
        python: {
          all: [
            /Idempotency-Key/,
            /store\.idempotent_get\(/,
            /store\.idempotent_put\(/,
            /stored\["user_id"\]/,
            /status_code\s*=\s*200/,
          ],
        },
        typescript: {
          all: [
            /['"]idempotency-key['"]/,
            /store\.getIdempotent\(/,
            /store\.putIdempotent\(/,
            /stored\.user_id/,
            /code\(\s*200\s*\)/,
          ],
        },
        go: {
          all: [/Idempotency-Key/, /store\.GetIdempotent\(/, /store\.PutIdempotent\(/, /stored\.UserID/, /StatusOK/],
        },
        scala: {
          all: [
            /Idempotency-Key/,
            /store\.getIdempotent\(/,
            /store\.putIdempotent\(/,
            /stored\.user_id/,
            /StatusCodes\.OK/,
          ],
        },
        cpp: {
          all: [/Idempotency-Key/, /store\.getIdempotent\(/, /store\.putIdempotent\(/, /stored->userId/, /\b200\b/],
        },
      },
    },
    {
      id: 'no-disclosure',
      title: 'Collides with one neutral 409 and creates nothing on replay',
      detail:
        'Both collisions answer **409** with the same fixed constant body (`{"error": "signup_conflict"}`) that names no field and echoes no address, and the idempotency lookup happens before the create call, so a replay writes no second row. The starter interpolates the address into its 409 (`"email … already exists"`), which turns signup into an existence oracle for unauthenticated callers.',
      match: {
        python: {
          all: [/SIGNUP_CONFLICT/, /def conflict\(/, /status_code\s*=\s*409/],
          none: [/already (exists|registered)/i],
          order: [/store\.idempotent_get\(/, /store\.create_user\(/],
        },
        typescript: {
          all: [/SIGNUP_CONFLICT/, /code\(\s*409\s*\)\.send\(SIGNUP_CONFLICT\)/],
          none: [/already (exists|registered)/i],
          order: [/store\.getIdempotent\(/, /store\.createUser\(/],
        },
        go: {
          all: [/signupConflict/, /StatusConflict/],
          none: [/already (exists|registered)/i],
          order: [/store\.GetIdempotent\(/, /store\.CreateUser\(/],
        },
        scala: {
          all: [/SignupConflict/, /StatusCodes\.Conflict/],
          none: [/already (exists|registered)/i],
          order: [/store\.getIdempotent\(/, /store\.createUser\(/],
        },
        cpp: {
          all: [/kSignupConflict/, /\b409\b/],
          none: [/already (exists|registered)/i],
          order: [/store\.getIdempotent\(/, /store\.createUser\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from fastapi.exceptions import HTTPException
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("identity")


class SignupRequest(BaseModel):
    email: str
    phone: str


class IdentityStore:
    def find_by_email(self, email: str) -> str | None:
        """The user id holding this address, if any."""
        raise NotImplementedError

    def find_by_phone(self, phone: str) -> str | None:
        """The user id holding this number, if any."""
        raise NotImplementedError

    def create_user(self, user_id: str, email: str, phone: str) -> None:
        """Insert the user row."""
        raise NotImplementedError


store = IdentityStore()


@app.post("/v1/users")
def signup(
    body: SignupRequest,
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    email = body.email.strip()
    phone = body.phone.strip()
    if store.find_by_email(email) is not None:
        raise HTTPException(status_code=409, detail=f"email {email} already exists")
    if store.find_by_phone(phone) is not None:
        raise HTTPException(status_code=409, detail=f"phone {phone} already exists")
    user_id = str(uuid.uuid4())
    store.create_user(user_id, email, phone)
    logger.info("signup user=%s email=%s", user_id, email)
    return JSONResponse(
        {"user_id": user_id, "email": email, "status": "pending_verification"}, status_code=201
    )
`,
      solution: `import logging
import re
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("identity")

# Domains whose local part folds out dots and collapses +aliases; other domains keep both.
FOLD_ALIAS_DOMAINS = {"gmail.com", "googlemail.com"}
MAX_EMAIL_BYTES = 254
PHONE_MIN_DIGITS = 8
PHONE_MAX_DIGITS = 15
SIGNUP_CONFLICT = {"error": "signup_conflict"}


class SignupRequest(BaseModel):
    email: str
    phone: str


class IdentityStore:
    """The identity index: SET NX claims, the idempotency record, then the user row."""

    def claim_phone(self, phone: str, user_id: str) -> bool:
        """SET NX the canonical number for this user; false when another account holds it."""
        raise NotImplementedError

    def release_phone(self, phone: str, user_id: str) -> None:
        """Drop our reservation when a later guard rejects the signup."""
        raise NotImplementedError

    def claim_email(self, email: str, user_id: str) -> bool:
        """SET NX the canonical address for this user; false when another account holds it."""
        raise NotImplementedError

    def create_user(self, user_id: str, email: str, phone: str) -> None:
        """Insert the user row once both claims succeeded."""
        raise NotImplementedError

    def idempotent_get(self, key: str) -> dict | None:
        """The record stored for this Idempotency-Key while its TTL holds."""
        raise NotImplementedError

    def idempotent_put(self, key: str, record: dict) -> None:
        """Store the record under this Idempotency-Key for the replay window."""
        raise NotImplementedError


store = IdentityStore()


def normalize_email(raw: str) -> str:
    """Case-fold the address; fold dots and +aliases only for domains that publish that policy."""
    local, _, domain = raw.strip().lower().partition("@")
    if domain in FOLD_ALIAS_DOMAINS:
        local = local.split("+", 1)[0].replace(".", "")
    return f"{local}@{domain}"


def normalize_phone(raw: str) -> str:
    """E.164: digits only, 8..15 of them, one leading +. The carrier recycles the rest."""
    digits = re.sub(r"[^0-9]", "", raw)
    if digits.startswith("00"):
        digits = digits[2:]
    if not PHONE_MIN_DIGITS <= len(digits) <= PHONE_MAX_DIGITS:
        raise HTTPException(status_code=422, detail="phone must carry 8..15 digits")
    return f"+{digits}"


def email_looks_valid(address: str) -> bool:
    local, sep, domain = address.strip().partition("@")
    return bool(sep) and local != "" and "." in domain and len(address.encode("utf-8")) <= MAX_EMAIL_BYTES


def conflict() -> HTTPException:
    """409 with one fixed body for every collision: no field name, no address, nothing confirmed."""
    return HTTPException(status_code=409, detail=SIGNUP_CONFLICT)


@app.post("/v1/users")
def signup(
    body: SignupRequest,
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if not email_looks_valid(body.email):
        raise HTTPException(status_code=422, detail="email must be a valid address")
    email = normalize_email(body.email)
    phone = normalize_phone(body.phone)

    stored = store.idempotent_get(idem_key)
    if stored is not None:
        logger.info("signup replay key=%s user=%s", idem_key, stored["user_id"])
        return JSONResponse(
            {"user_id": stored["user_id"], "email": email, "status": "pending_verification"},
            status_code=200,
        )

    user_id = str(uuid.uuid4())
    if not store.claim_phone(phone, user_id):
        raise conflict()
    if not store.claim_email(email, user_id):
        store.release_phone(phone, user_id)
        raise conflict()

    store.create_user(user_id, email, phone)
    store.idempotent_put(idem_key, {"user_id": user_id, "email": email})
    logger.info("signup created user=%s key=%s", user_id, idem_key)
    return JSONResponse(
        {"user_id": user_id, "email": email, "status": "pending_verification"}, status_code=201
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/users. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

interface SignupBody {
  email: string;
  phone: string;
}

app.post('/v1/users', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const idemKey = request.headers['idempotency-key'];
  const body = request.body as SignupBody;
  request.log.info({idemKey}, 'signup');
  const email = body.email.trim();
  const phone = body.phone.trim();

  const emailHolder = await store.findByEmail(email);
  if (emailHolder !== null) return reply.code(409).send({error: 'email ' + email + ' already exists'});
  const phoneHolder = await store.findByPhone(phone);
  if (phoneHolder !== null) return reply.code(409).send({error: 'phone ' + phone + ' already exists'});

  const userId = randomUUID();
  await store.createUser(userId, email, phone);
  return reply.code(201).send({user_id: userId, email, status: 'pending_verification'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/users: one human, one account — normalized, claimed, replayable. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

/** Domains whose local part folds out dots and collapses +aliases; other domains keep both. */
const FOLD_ALIAS_DOMAINS: Record<string, true> = {'gmail.com': true, 'googlemail.com': true};
const MAX_EMAIL_BYTES = 254;
const PHONE_MIN_DIGITS = 8;
const PHONE_MAX_DIGITS = 15;
/** One fixed body for every collision: no field name, no address, nothing confirmed. */
const SIGNUP_CONFLICT = {error: 'signup_conflict'};

interface SignupBody {
  email: string;
  phone: string;
}

interface IdempotentRecord {
  user_id: string;
  email: string;
}

function normalizeEmail(raw: string): string {
  const address = raw.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  let local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (FOLD_ALIAS_DOMAINS[domain] === true) local = local.split('+')[0].split('.').join('');
  return local + '@' + domain;
}

function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/[^0-9]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) return null;
  return '+' + digits;
}

function emailLooksValid(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at <= 0) return false;
  return address.slice(at + 1).includes('.') && Buffer.byteLength(address, 'utf8') <= MAX_EMAIL_BYTES;
}

app.post('/v1/users', async (request, reply) => {
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<SignupBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.email !== 'string' || typeof body.phone !== 'string')
    return reply.code(422).send({error: 'email and phone are required'});
  if (!emailLooksValid(body.email)) return reply.code(422).send({error: 'email must be a valid address'});
  const email = normalizeEmail(body.email);
  const phone = normalizePhone(body.phone);
  if (phone === null) return reply.code(422).send({error: 'phone must carry 8..15 digits'});

  const stored: IdempotentRecord | null = await store.getIdempotent(idemKey);
  if (stored !== null) {
    request.log.info({user_id: stored.user_id, idem_key: idemKey}, 'signup replay');
    return reply.code(200).send({user_id: stored.user_id, email, status: 'pending_verification'});
  }

  const userId = randomUUID();
  if (!(await store.claimPhone(phone, userId))) return reply.code(409).send(SIGNUP_CONFLICT);
  if (!(await store.claimEmail(email, userId))) {
    await store.releasePhone(phone, userId);
    return reply.code(409).send(SIGNUP_CONFLICT);
  }
  await store.createUser(userId, email, phone);
  await store.putIdempotent(idemKey, {user_id: userId, email});
  request.log.info({user_id: userId, idem_key: idemKey}, 'signup created');
  return reply.code(201).send({user_id: userId, email, status: 'pending_verification'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

type SignupRequest struct {
	Email string \`json:"email"\`
	Phone string \`json:"phone"\`
}

type IdentityStore struct{}

func (s *IdentityStore) FindByEmail(ctx context.Context, email string) (string, bool) {
	return "", false
}

func (s *IdentityStore) FindByPhone(ctx context.Context, phone string) (string, bool) {
	return "", false
}

func (s *IdentityStore) CreateUser(ctx context.Context, userID, email, phone string) error {
	return nil
}

var store = &IdentityStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func signup(rw http.ResponseWriter, r *http.Request) {
	var body SignupRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	email := body.Email
	phone := body.Phone
	if _, found := store.FindByEmail(r.Context(), email); found {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "email " + email + " already exists"})
		return
	}
	if _, found := store.FindByPhone(r.Context(), phone); found {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "phone " + phone + " already exists"})
		return
	}
	userID := uuid.NewString()
	if err := store.CreateUser(r.Context(), userID, email, phone); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("signup user=%s email=%s", userID, email)
	writeJSON(rw, http.StatusCreated, map[string]any{
		"user_id": userID, "email": email, "status": "pending_verification",
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/users", signup)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

// foldAliasDomains fold dots out of the local part and collapse +aliases; other domains keep both.
var foldAliasDomains = map[string]bool{"gmail.com": true, "googlemail.com": true}

const (
	maxEmailBytes  = 254
	phoneMinDigits = 8
	phoneMaxDigits = 15
)

// One fixed body for every collision: no field name, no address, nothing confirmed.
var signupConflict = map[string]string{"error": "signup_conflict"}

type SignupRequest struct {
	Email string \`json:"email"\`
	Phone string \`json:"phone"\`
}

type IdempotentRecord struct {
	UserID string \`json:"user_id"\`
	Email  string \`json:"email"\`
}

type IdentityStore struct{}

// ClaimPhone SET NXes the canonical number for this user; false when another account holds it.
func (s *IdentityStore) ClaimPhone(ctx context.Context, phone, userID string) (bool, error) {
	return false, nil
}

func (s *IdentityStore) ReleasePhone(ctx context.Context, phone, userID string) error {
	return nil
}

func (s *IdentityStore) ClaimEmail(ctx context.Context, email, userID string) (bool, error) {
	return false, nil
}

func (s *IdentityStore) CreateUser(ctx context.Context, userID, email, phone string) error {
	return nil
}

func (s *IdentityStore) GetIdempotent(ctx context.Context, key string) (*IdempotentRecord, error) {
	return nil, nil
}

func (s *IdentityStore) PutIdempotent(ctx context.Context, key string, record IdempotentRecord) error {
	return nil
}

var store = &IdentityStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func normalizeEmail(raw string) string {
	address := strings.ToLower(strings.TrimSpace(raw))
	at := strings.LastIndex(address, "@")
	local, domain := address[:at], address[at+1:]
	if foldAliasDomains[domain] {
		if plus := strings.Index(local, "+"); plus != -1 {
			local = local[:plus]
		}
		local = strings.ReplaceAll(local, ".", "")
	}
	return local + "@" + domain
}

func normalizePhone(raw string) (string, bool) {
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, raw)
	if strings.HasPrefix(digits, "00") {
		digits = digits[2:]
	}
	if len(digits) < phoneMinDigits || len(digits) > phoneMaxDigits {
		return "", false
	}
	return "+" + digits, true
}

func emailLooksValid(address string) bool {
	at := strings.LastIndex(address, "@")
	if at <= 0 || len(address) > maxEmailBytes {
		return false
	}
	return strings.Contains(address[at+1:], ".")
}

func signup(rw http.ResponseWriter, r *http.Request) {
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body SignupRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "invalid json"})
		return
	}
	if !emailLooksValid(body.Email) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "email must be a valid address"})
		return
	}
	email := normalizeEmail(body.Email)
	phone, ok := normalizePhone(body.Phone)
	if !ok {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "phone must carry 8..15 digits"})
		return
	}

	stored, err := store.GetIdempotent(r.Context(), idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		log.Printf("signup replay key=%s user=%s", idemKey, stored.UserID)
		writeJSON(rw, http.StatusOK, map[string]any{
			"user_id": stored.UserID, "email": email, "status": "pending_verification",
		})
		return
	}

	userID := uuid.NewString()
	claimed, err := store.ClaimPhone(r.Context(), phone, userID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if !claimed {
		writeJSON(rw, http.StatusConflict, signupConflict)
		return
	}
	claimed, err = store.ClaimEmail(r.Context(), email, userID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if !claimed {
		_ = store.ReleasePhone(r.Context(), phone, userID)
		writeJSON(rw, http.StatusConflict, signupConflict)
		return
	}
	if err := store.CreateUser(r.Context(), userID, email, phone); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if err := store.PutIdempotent(r.Context(), idemKey, IdempotentRecord{UserID: userID, Email: email}); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("signup created user=%s key=%s", userID, idemKey)
	writeJSON(rw, http.StatusCreated, map[string]any{
		"user_id": userID, "email": email, "status": "pending_verification",
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/users", signup)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class SignupRequest(email: String, phone: String)

object SignupApi {
  implicit val system: ActorSystem = ActorSystem("identity")
  implicit val signupFormat: RootJsonFormat[SignupRequest] = jsonFormat2(SignupRequest)

  val store = IdentityStore.open()

  val route: Route =
    path("v1" / "users") {
      post {
        optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
          entity(as[SignupRequest]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            val email = body.email.trim
            val phone = body.phone.trim
            store.findByEmail(email) match {
              case Some(_) =>
                complete(StatusCodes.Conflict, s"""{"error":"email $email already exists"}""")
              case None =>
                store.findByPhone(phone) match {
                  case Some(_) =>
                    complete(StatusCodes.Conflict, s"""{"error":"phone $phone already exists"}""")
                  case None =>
                    val userId = UUID.randomUUID().toString
                    store.createUser(userId, email, phone)
                    system.log.info(s"signup user=$userId email=$email")
                    complete(
                      StatusCodes.Created,
                      s"""{"user_id":"$userId","email":"$email","status":"pending_verification"}""")
                }
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
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class SignupRequest(email: String, phone: String)
final case class IdempotentRecord(user_id: String, email: String)
final case class Account(user_id: String, email: String, status: String)

object SignupApi {
  implicit val system: ActorSystem = ActorSystem("identity")
  implicit val signupFormat: RootJsonFormat[SignupRequest] = jsonFormat2(SignupRequest)
  implicit val idempotentFormat: RootJsonFormat[IdempotentRecord] = jsonFormat2(IdempotentRecord)
  implicit val accountFormat: RootJsonFormat[Account] = jsonFormat3(Account)

  val FoldAliasDomains = Set("gmail.com", "googlemail.com")
  val MaxEmailBytes = 254
  val PhoneMinDigits = 8
  val PhoneMaxDigits = 15
  // One fixed body for every collision: no field name, no address, nothing confirmed.
  val SignupConflict = """{"error":"signup_conflict"}"""

  val store = IdentityStore.open()

  def normalizeEmail(raw: String): String = {
    val address = raw.trim.toLowerCase
    val at = address.lastIndexOf('@')
    val local0 = address.substring(0, at)
    val domain = address.substring(at + 1)
    val local =
      if (FoldAliasDomains.contains(domain)) local0.takeWhile(_ != '+').replace(".", "") else local0
    s"$local@$domain"
  }

  def normalizePhone(raw: String): Either[String, String] = {
    var digits = raw.filter(_.isDigit)
    if (digits.startsWith("00")) digits = digits.substring(2)
    if (digits.length < PhoneMinDigits || digits.length > PhoneMaxDigits) Left("phone must carry 8..15 digits")
    else Right(s"+$digits")
  }

  def emailLooksValid(address: String): Boolean = {
    val at = address.lastIndexOf('@')
    at > 0 && address.substring(at + 1).contains(".") && address.getBytes("UTF-8").length <= MaxEmailBytes
  }

  val route: Route =
    path("v1" / "users") {
      post {
        optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
          entity(as[SignupRequest]) { body =>
            if (!idemOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
            } else if (!emailLooksValid(body.email)) {
              complete(StatusCodes.UnprocessableEntity, """{"error":"email must be a valid address"}""")
            } else {
              val email = normalizeEmail(body.email)
              val phoneOrError = normalizePhone(body.phone)
              phoneOrError match {
                case Left(message) =>
                  complete(StatusCodes.UnprocessableEntity, s"""{"error":"$message"}""")
                case Right(phone) =>
                  val idemKey = idemOpt.get
                  store.getIdempotent(idemKey) match {
                    case Some(stored) =>
                      system.log.info(s"signup replay key=$idemKey user=\${stored.user_id}")
                      complete(StatusCodes.OK, Account(stored.user_id, email, "pending_verification"))
                    case None =>
                      val userId = UUID.randomUUID().toString
                      if (!store.claimPhone(phone, userId)) {
                        complete(StatusCodes.Conflict, SignupConflict)
                      } else if (!store.claimEmail(email, userId)) {
                        store.releasePhone(phone, userId)
                        complete(StatusCodes.Conflict, SignupConflict)
                      } else {
                        store.createUser(userId, email, phone)
                        store.putIdempotent(idemKey, IdempotentRecord(userId, email))
                        system.log.info(s"signup created user=$userId key=$idemKey")
                        complete(StatusCodes.Created, Account(userId, email, "pending_verification"))
                      }
                  }
              }
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

#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

struct IdentityStore {
  std::optional<std::string> findByEmail(const std::string& email);
  std::optional<std::string> findByPhone(const std::string& phone);
  void createUser(const std::string& userId, const std::string& email, const std::string& phone);
};

IdentityStore store;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/users", [](const httplib::Request& req, httplib::Response& res) {
    const auto idemKey = req.get_header_value("Idempotency-Key");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("email") || !body.contains("phone")) {
      res.status = 422;
      res.set_content(R"({"error":"email and phone are required"})", "application/json");
      return;
    }
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const auto email = body["email"].get<std::string>();
    const auto phone = body["phone"].get<std::string>();
    if (store.findByEmail(email)) {
      res.status = 409;
      res.set_content(json{{"error", "email " + email + " already exists"}}.dump(), "application/json");
      return;
    }
    if (store.findByPhone(phone)) {
      res.status = 409;
      res.set_content(json{{"error", "phone " + phone + " already exists"}}.dump(), "application/json");
      return;
    }
    const auto userId = uuidString();
    store.createUser(userId, email, phone);
    std::cerr << "signup user=" << userId << " email=" << email << "\\n";
    res.status = 201;
    res.set_content(
        json{{"user_id", userId}, {"email", email}, {"status", "pending_verification"}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <iostream>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

// Domains whose local part folds out dots and collapses +aliases; other domains keep both.
const std::set<std::string> kFoldAliasDomains = {"gmail.com", "googlemail.com"};
constexpr std::size_t kMaxEmailBytes = 254;
constexpr std::size_t kPhoneMinDigits = 8;
constexpr std::size_t kPhoneMaxDigits = 15;
// One fixed body for every collision: no field name, no address, nothing confirmed.
const json kSignupConflict = {{"error", "signup_conflict"}};

struct IdempotentRecord {
  std::string userId;
  std::string email;
};

struct IdentityStore {
  bool claimPhone(const std::string& phone, const std::string& userId);
  void releasePhone(const std::string& phone, const std::string& userId);
  bool claimEmail(const std::string& email, const std::string& userId);
  void createUser(const std::string& userId, const std::string& email, const std::string& phone);
  std::optional<IdempotentRecord> getIdempotent(const std::string& key);
  void putIdempotent(const std::string& key, const IdempotentRecord& record);
};

IdentityStore store;
std::string uuidString();

std::string normalizeEmail(const std::string& raw) {
  std::string address = raw;
  while (!address.empty() && std::isspace(static_cast<unsigned char>(address.front()))) address.erase(address.begin());
  while (!address.empty() && std::isspace(static_cast<unsigned char>(address.back()))) address.pop_back();
  std::transform(address.begin(), address.end(), address.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  const auto at = address.rfind('@');
  std::string local = address.substr(0, at);
  const std::string domain = address.substr(at + 1);
  if (kFoldAliasDomains.count(domain) != 0) {
    const auto plus = local.find('+');
    if (plus != std::string::npos) local = local.substr(0, plus);
    local.erase(std::remove(local.begin(), local.end(), '.'), local.end());
  }
  return local + "@" + domain;
}

std::optional<std::string> normalizePhone(const std::string& raw) {
  std::string digits;
  for (const char c : raw)
    if (c >= '0' && c <= '9') digits.push_back(c);
  if (digits.rfind("00", 0) == 0) digits.erase(0, 2);
  if (digits.size() < kPhoneMinDigits || digits.size() > kPhoneMaxDigits) return std::nullopt;
  return "+" + digits;
}

bool emailLooksValid(const std::string& address) {
  const auto at = address.rfind('@');
  if (at == std::string::npos || at == 0) return false;
  return address.size() <= kMaxEmailBytes && address.substr(at + 1).find('.') != std::string::npos;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/users", [](const httplib::Request& req, httplib::Response& res) {
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("email") || !body["email"].is_string() || !body.contains("phone") ||
        !body["phone"].is_string()) {
      res.status = 422;
      res.set_content(R"({"error":"email and phone are required"})", "application/json");
      return;
    }
    const auto rawEmail = body["email"].get<std::string>();
    if (!emailLooksValid(rawEmail)) {
      res.status = 422;
      res.set_content(R"({"error":"email must be a valid address"})", "application/json");
      return;
    }
    const auto email = normalizeEmail(rawEmail);
    const auto phone = normalizePhone(body["phone"].get<std::string>());
    if (!phone) {
      res.status = 422;
      res.set_content(R"({"error":"phone must carry 8..15 digits"})", "application/json");
      return;
    }

    const auto stored = store.getIdempotent(idemKey);
    if (stored) {
      std::cerr << "signup replay key=" << idemKey << " user=" << stored->userId << "\\n";
      res.status = 200;
      res.set_content(
          json{{"user_id", stored->userId}, {"email", email}, {"status", "pending_verification"}}.dump(),
          "application/json");
      return;
    }

    const auto userId = uuidString();
    if (!store.claimPhone(*phone, userId)) {
      res.status = 409;
      res.set_content(kSignupConflict.dump(), "application/json");
      return;
    }
    if (!store.claimEmail(email, userId)) {
      store.releasePhone(*phone, userId);
      res.status = 409;
      res.set_content(kSignupConflict.dump(), "application/json");
      return;
    }
    store.createUser(userId, email, *phone);
    store.putIdempotent(idemKey, IdempotentRecord{userId, email});
    std::cerr << "signup created user=" << userId << " key=" << idemKey << "\\n";
    res.status = 201;
    res.set_content(
        json{{"user_id", userId}, {"email", email}, {"status", "pending_verification"}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Alice signs up as `Alice@x.com`, retries when the confirmation mail is slow, and ends up with two accounts; a stranger posting her address learns from the 409 body that she has one.',
    'The store compares the raw strings the caller sent, nothing reads `Idempotency-Key` before the write, the phone is checked with a lookup rather than a claim, and the 409 interpolates the address.',
    'Add `normalize_email` (case fold; dots and `+` only for `FOLD_ALIAS_DOMAINS`) and `normalize_phone` (E.164), look up the key first and answer 200 with the stored `user_id`, `SET NX` the phone before the email claim, and return one constant `SIGNUP_CONFLICT` body.',
  ],
  debrief: `Identity is canonical form, so \`normalize_email\` runs before any comparison, and
\`FOLD_ALIAS_DOMAINS\` is a set because dots and \`+\` are only aliases where the domain says so.
Uniqueness is a claim, not a check: \`find\` then \`create\` races, so the canonical number is
\`SET NX\`'d before the email lookup. \`Idempotency-Key\` is looked up first so a retry returns the
original \`user_id\`, and the 409 is one constant body because an interpolated address turns signup
into an enumeration oracle.

Production services keep the raw input in an audit trail and enqueue the confirmation mail after the
row commits; the strictest answer every signup with the same 202.`,
};
