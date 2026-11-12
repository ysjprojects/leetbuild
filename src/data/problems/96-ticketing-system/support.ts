/**
 * Hand-written support modules the ticketing-system steps import but no step builds: `tickets.store`,
 * the ticket store (the course's stand-in for the ticket database, kept in Redis hashes). Tickets,
 * their notes, the per-ticket note index the timeline pages over, and the CRM outbox step 3 drains.
 * The five languages keep the same keys and scripts, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'tickets/__init__.py': '',
  'tickets/store.py': `"""
The ticket store (provided), kept in Redis hashes. ticket:{id} holds id, requester_id, subject,
state (open, pending, resolved or closed) and closed_at (Unix seconds, "" unless closed). note:{id}
holds id, ticket_id, seq, author, visibility (public or internal) and body; ticket:{id}:notes indexes
a ticket's notes by seq. crm:outbox holds the notes the CRM has not taken yet (by seq), crm:synced
the ones it has, crm:quarantine the ones it refused, with the reason. A ticket is a dict whose
closed_at is an int or None; a note is a dict whose seq is an int.
"""
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OUTBOX = "crm:outbox"
SYNCED = "crm:synced"
QUARANTINED = "crm:quarantine"

# Moves the ticket from ARGV[1] to ARGV[2] only if it is still in ARGV[1]; ARGV[3] is the new closed_at.
TRANSITION_LUA = """
if redis.call('HGET', KEYS[1], 'state') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'state', ARGV[2], 'closed_at', ARGV[3])
return 1
"""
# The note row, the ticket's index and (when a third key is given) the CRM outbox, in one script.
NOTE_LUA = """
redis.call('HSET', KEYS[1], 'id', ARGV[1], 'ticket_id', ARGV[2], 'seq', ARGV[3], 'author', ARGV[4], 'visibility', ARGV[5], 'body', ARGV[6])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
if #KEYS == 3 then redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1]) end
return 1
"""
_transition = r.register_script(TRANSITION_LUA)
_write_note = r.register_script(NOTE_LUA)


def ticket_key(ticket_id: str) -> str:
    return f"ticket:{ticket_id}"


def note_key(note_id: str) -> str:
    return f"note:{note_id}"


def notes_key(ticket_id: str) -> str:
    return f"ticket:{ticket_id}:notes"


def create_ticket(requester_id: str, subject: str) -> dict:
    """A new open ticket of the requester; returns it."""
    ticket_id = f"T-{r.incr('ticket:seq')}"
    r.hset(
        ticket_key(ticket_id),
        mapping={"id": ticket_id, "requester_id": requester_id, "subject": subject, "state": "open", "closed_at": ""},
    )
    return get_ticket(ticket_id)


def get_ticket(ticket_id: str) -> dict | None:
    """The ticket, or None."""
    raw = r.hgetall(ticket_key(ticket_id))
    if not raw:
        return None
    closed_at = raw.get("closed_at", "")
    return {
        "id": raw["id"],
        "requester_id": raw["requester_id"],
        "subject": raw["subject"],
        "state": raw["state"],
        "closed_at": int(closed_at) if closed_at else None,
    }


def transition(ticket_id: str, from_state: str, to_state: str) -> bool:
    """Move the ticket to to_state if it is still in from_state (one Lua script): closed_at is stamped
    when it closes and cleared when it leaves closed. False when another writer moved it first."""
    closed_at = str(int(time.time())) if to_state == "closed" else ""
    return _transition(keys=[ticket_key(ticket_id)], args=[from_state, to_state, closed_at]) == 1


def get_note(note_id: str) -> dict | None:
    """The note, or None."""
    raw = r.hgetall(note_key(note_id))
    if not raw:
        return None
    return {**raw, "seq": int(raw["seq"])}


def _note(ticket_id: str, author: str, visibility: str, body: str, outbox: bool) -> dict:
    seq = r.incr("note:seq")
    note_id = f"N-{seq}"
    keys = [note_key(note_id), notes_key(ticket_id)] + ([OUTBOX] if outbox else [])
    _write_note(keys=keys, args=[note_id, ticket_id, seq, author, visibility, body])
    return get_note(note_id)


def append_note(ticket_id: str, author: str, visibility: str, body: str) -> dict:
    """The note row and the ticket's index; nothing for the CRM. Returns the note."""
    return _note(ticket_id, author, visibility, body, outbox=False)


def commit_note(ticket_id: str, author: str, visibility: str, body: str) -> dict:
    """The note row, the ticket's index and its crm:outbox entry in one script: the note and the
    promise to sync it commit together. Returns the note."""
    return _note(ticket_id, author, visibility, body, outbox=True)


def pending_syncs() -> list[dict]:
    """The notes in crm:outbox, oldest first."""
    return [n for n in (get_note(i) for i in r.zrange(OUTBOX, 0, -1)) if n is not None]


def mark_synced(note_id: str) -> None:
    """The CRM took the note: it leaves the outbox for crm:synced."""
    r.zrem(OUTBOX, note_id)
    r.sadd(SYNCED, note_id)


def quarantine(note_id: str, reason: str) -> None:
    """The CRM refused the note: it leaves the outbox for crm:quarantine, with the reason."""
    r.zrem(OUTBOX, note_id)
    r.hset(QUARANTINED, note_id, reason)


def page(ticket_id: str, before_seq: int | None, limit: int) -> list[dict]:
    """Up to limit notes of the ticket with seq < before_seq (None: from the newest), newest first:
    a keyset page."""
    top = "+inf" if before_seq is None else f"({before_seq}"
    ids = r.zrevrangebyscore(notes_key(ticket_id), top, "-inf", start=0, num=limit)
    return [n for n in (get_note(i) for i in ids) if n is not None]


def page_at(ticket_id: str, offset: int, limit: int) -> list[dict]:
    """limit notes of the ticket from row offset, newest first."""
    ids = r.zrevrange(notes_key(ticket_id), offset, offset + limit - 1)
    return [n for n in (get_note(i) for i in ids) if n is not None]
`,
};

export const supportModulesTs: Record<string, string> = {
  'tickets/store.ts': `/**
 * The ticket store (provided), kept in Redis hashes. ticket:{id} holds id, requester_id, subject,
 * state (open, pending, resolved or closed) and closed_at (Unix seconds, "" unless closed). note:{id}
 * holds id, ticket_id, seq, author, visibility (public or internal) and body; ticket:{id}:notes
 * indexes a ticket's notes by seq. crm:outbox holds the notes the CRM has not taken yet (by seq),
 * crm:synced the ones it has, crm:quarantine the ones it refused, with the reason.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX = 'crm:outbox';
export const SYNCED = 'crm:synced';
export const QUARANTINED = 'crm:quarantine';

export interface Ticket {
  id: string;
  requester_id: string;
  subject: string;
  state: string;
  /** Unix seconds; null unless closed. */
  closed_at: number | null;
}

export interface Note {
  id: string;
  ticket_id: string;
  seq: number;
  author: string;
  visibility: string;
  body: string;
}

/** Moves the ticket from ARGV[1] to ARGV[2] only if it is still in ARGV[1]; ARGV[3] is the new closed_at. */
export const TRANSITION_LUA = \`
if redis.call('HGET', KEYS[1], 'state') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'state', ARGV[2], 'closed_at', ARGV[3])
return 1
\`;
/** The note row, the ticket's index and (when a third key is given) the CRM outbox, in one script. */
export const NOTE_LUA = \`
redis.call('HSET', KEYS[1], 'id', ARGV[1], 'ticket_id', ARGV[2], 'seq', ARGV[3], 'author', ARGV[4], 'visibility', ARGV[5], 'body', ARGV[6])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
if #KEYS == 3 then redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1]) end
return 1
\`;

export const ticketKey = (ticketId: string): string => \`ticket:\${ticketId}\`;
export const noteKey = (noteId: string): string => \`note:\${noteId}\`;
export const notesKey = (ticketId: string): string => \`ticket:\${ticketId}:notes\`;

/** A new open ticket of the requester; returns it. */
export async function createTicket(requesterId: string, subject: string): Promise<Ticket> {
  const ticketId = \`T-\${await redis.incr('ticket:seq')}\`;
  await redis.hset(ticketKey(ticketId), {id: ticketId, requester_id: requesterId, subject, state: 'open', closed_at: ''});
  return (await getTicket(ticketId)) as Ticket;
}

/** The ticket, or null. */
export async function getTicket(ticketId: string): Promise<Ticket | null> {
  const raw = await redis.hgetall(ticketKey(ticketId));
  if (Object.keys(raw).length === 0) return null;
  return {
    id: raw.id,
    requester_id: raw.requester_id,
    subject: raw.subject,
    state: raw.state,
    closed_at: raw.closed_at ? Number(raw.closed_at) : null,
  };
}

/**
 * Move the ticket to toState if it is still in fromState (one Lua script): closed_at is stamped when
 * it closes and cleared when it leaves closed. false when another writer moved it first.
 */
export async function transition(ticketId: string, fromState: string, toState: string): Promise<boolean> {
  const closedAt = toState === 'closed' ? String(Math.floor(Date.now() / 1000)) : '';
  return (await redis.eval(TRANSITION_LUA, 1, ticketKey(ticketId), fromState, toState, closedAt)) === 1;
}

/** The note, or null. */
export async function getNote(noteId: string): Promise<Note | null> {
  const raw = await redis.hgetall(noteKey(noteId));
  if (Object.keys(raw).length === 0) return null;
  return {id: raw.id, ticket_id: raw.ticket_id, seq: Number(raw.seq), author: raw.author, visibility: raw.visibility, body: raw.body};
}

async function notesOf(ids: string[]): Promise<Note[]> {
  const notes: Note[] = [];
  for (const id of ids) {
    const note = await getNote(id);
    if (note !== null) notes.push(note);
  }
  return notes;
}

async function writeNote(ticketId: string, author: string, visibility: string, body: string, outbox: boolean): Promise<Note> {
  const seq = await redis.incr('note:seq');
  const noteId = \`N-\${seq}\`;
  const keys = [noteKey(noteId), notesKey(ticketId), ...(outbox ? [OUTBOX] : [])];
  await redis.eval(NOTE_LUA, keys.length, ...keys, noteId, ticketId, String(seq), author, visibility, body);
  return (await getNote(noteId)) as Note;
}

/** The note row and the ticket's index; nothing for the CRM. Returns the note. */
export async function appendNote(ticketId: string, author: string, visibility: string, body: string): Promise<Note> {
  return writeNote(ticketId, author, visibility, body, false);
}

/** The note row, the ticket's index and its crm:outbox entry in one script: the note and the promise to sync it commit together. */
export async function commitNote(ticketId: string, author: string, visibility: string, body: string): Promise<Note> {
  return writeNote(ticketId, author, visibility, body, true);
}

/** The notes in crm:outbox, oldest first. */
export async function pendingSyncs(): Promise<Note[]> {
  return notesOf(await redis.zrange(OUTBOX, 0, -1));
}

/** The CRM took the note: it leaves the outbox for crm:synced. */
export async function markSynced(noteId: string): Promise<void> {
  await redis.zrem(OUTBOX, noteId);
  await redis.sadd(SYNCED, noteId);
}

/** The CRM refused the note: it leaves the outbox for crm:quarantine, with the reason. */
export async function quarantine(noteId: string, reason: string): Promise<void> {
  await redis.zrem(OUTBOX, noteId);
  await redis.hset(QUARANTINED, noteId, reason);
}

/** Up to limit notes of the ticket with seq < beforeSeq (null: from the newest), newest first: a keyset page. */
export async function page(ticketId: string, beforeSeq: number | null, limit: number): Promise<Note[]> {
  const top = beforeSeq === null ? '+inf' : \`(\${beforeSeq}\`;
  return notesOf(await redis.zrevrangebyscore(notesKey(ticketId), top, '-inf', 'LIMIT', 0, limit));
}

/** limit notes of the ticket from row offset, newest first. */
export async function pageAt(ticketId: string, offset: number, limit: number): Promise<Note[]> {
  return notesOf(await redis.zrevrange(notesKey(ticketId), offset, offset + limit - 1));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'tickets/store/store.go': `// Package store is the ticket store (provided), kept in Redis hashes. ticket:{id} holds id,
// requester_id, subject, state (open, pending, resolved or closed) and closed_at (Unix seconds, ""
// unless closed). note:{id} holds id, ticket_id, seq, author, visibility (public or internal) and
// body; ticket:{id}:notes indexes a ticket's notes by seq. crm:outbox holds the notes the CRM has
// not taken yet (by seq), crm:synced the ones it has, crm:quarantine the ones it refused, with the
// reason.
package store

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	Outbox      = "crm:outbox"
	Synced      = "crm:synced"
	Quarantined = "crm:quarantine"
)

// Ticket is one ticket; ClosedAt is Unix seconds, 0 unless closed.
type Ticket struct {
	ID          string \`json:"id"\`
	RequesterID string \`json:"requester_id"\`
	Subject     string \`json:"subject"\`
	State       string \`json:"state"\`
	ClosedAt    int64  \`json:"closed_at"\`
}

// Note is one note of a ticket.
type Note struct {
	ID         string \`json:"id"\`
	TicketID   string \`json:"ticket_id"\`
	Seq        int64  \`json:"seq"\`
	Author     string \`json:"author"\`
	Visibility string \`json:"visibility"\`
	Body       string \`json:"body"\`
}

// transitionScript moves the ticket from ARGV[1] to ARGV[2] only if it is still in ARGV[1]; ARGV[3] is the new closed_at.
var transitionScript = redis.NewScript(\`
if redis.call('HGET', KEYS[1], 'state') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'state', ARGV[2], 'closed_at', ARGV[3])
return 1
\`)

// noteScript writes the note row, the ticket's index and (when a third key is given) the CRM outbox.
var noteScript = redis.NewScript(\`
redis.call('HSET', KEYS[1], 'id', ARGV[1], 'ticket_id', ARGV[2], 'seq', ARGV[3], 'author', ARGV[4], 'visibility', ARGV[5], 'body', ARGV[6])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
if #KEYS == 3 then redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1]) end
return 1
\`)

func TicketKey(ticketID string) string { return "ticket:" + ticketID }
func NoteKey(noteID string) string     { return "note:" + noteID }
func NotesKey(ticketID string) string  { return "ticket:" + ticketID + ":notes" }

// CreateTicket makes a new open ticket of the requester and returns it.
func CreateTicket(ctx context.Context, requesterID, subject string) *Ticket {
	ticketID := fmt.Sprintf("T-%d", rdb.Incr(ctx, "ticket:seq").Val())
	rdb.HSet(ctx, TicketKey(ticketID), map[string]any{"id": ticketID, "requester_id": requesterID, "subject": subject, "state": "open", "closed_at": ""})
	return GetTicket(ctx, ticketID)
}

// GetTicket is the ticket, or nil.
func GetTicket(ctx context.Context, ticketID string) *Ticket {
	raw := rdb.HGetAll(ctx, TicketKey(ticketID)).Val()
	if len(raw) == 0 {
		return nil
	}
	closedAt, _ := strconv.ParseInt(raw["closed_at"], 10, 64)
	return &Ticket{ID: raw["id"], RequesterID: raw["requester_id"], Subject: raw["subject"], State: raw["state"], ClosedAt: closedAt}
}

// Transition moves the ticket to to if it is still in from (one Lua script): closed_at is stamped
// when it closes and cleared when it leaves closed. false when another writer moved it first.
func Transition(ctx context.Context, ticketID, from, to string) (bool, error) {
	closedAt := ""
	if to == "closed" {
		closedAt = strconv.FormatInt(time.Now().Unix(), 10)
	}
	moved, err := transitionScript.Run(ctx, rdb, []string{TicketKey(ticketID)}, from, to, closedAt).Int64()
	return moved == 1, err
}

// GetNote is the note, or nil.
func GetNote(ctx context.Context, noteID string) *Note {
	raw := rdb.HGetAll(ctx, NoteKey(noteID)).Val()
	if len(raw) == 0 {
		return nil
	}
	seq, _ := strconv.ParseInt(raw["seq"], 10, 64)
	return &Note{ID: raw["id"], TicketID: raw["ticket_id"], Seq: seq, Author: raw["author"], Visibility: raw["visibility"], Body: raw["body"]}
}

func notesOf(ctx context.Context, ids []string) []Note {
	notes := []Note{}
	for _, id := range ids {
		if note := GetNote(ctx, id); note != nil {
			notes = append(notes, *note)
		}
	}
	return notes
}

func writeNote(ctx context.Context, ticketID, author, visibility, body string, outbox bool) (*Note, error) {
	seq, err := rdb.Incr(ctx, "note:seq").Result()
	if err != nil {
		return nil, err
	}
	noteID := fmt.Sprintf("N-%d", seq)
	keys := []string{NoteKey(noteID), NotesKey(ticketID)}
	if outbox {
		keys = append(keys, Outbox)
	}
	if err := noteScript.Run(ctx, rdb, keys, noteID, ticketID, seq, author, visibility, body).Err(); err != nil {
		return nil, err
	}
	return GetNote(ctx, noteID), nil
}

// AppendNote writes the note row and the ticket's index; nothing for the CRM. It returns the note.
func AppendNote(ctx context.Context, ticketID, author, visibility, body string) (*Note, error) {
	return writeNote(ctx, ticketID, author, visibility, body, false)
}

// CommitNote writes the note row, the ticket's index and its crm:outbox entry in one script: the
// note and the promise to sync it commit together. It returns the note.
func CommitNote(ctx context.Context, ticketID, author, visibility, body string) (*Note, error) {
	return writeNote(ctx, ticketID, author, visibility, body, true)
}

// PendingSyncs is the notes in crm:outbox, oldest first.
func PendingSyncs(ctx context.Context) []Note {
	return notesOf(ctx, rdb.ZRange(ctx, Outbox, 0, -1).Val())
}

// MarkSynced records that the CRM took the note: it leaves the outbox for crm:synced.
func MarkSynced(ctx context.Context, noteID string) {
	rdb.ZRem(ctx, Outbox, noteID)
	rdb.SAdd(ctx, Synced, noteID)
}

// Quarantine records that the CRM refused the note: it leaves the outbox for crm:quarantine, with the reason.
func Quarantine(ctx context.Context, noteID, reason string) {
	rdb.ZRem(ctx, Outbox, noteID)
	rdb.HSet(ctx, Quarantined, noteID, reason)
}

// Page is up to limit notes of the ticket with seq < beforeSeq (0: from the newest), newest first: a keyset page.
func Page(ctx context.Context, ticketID string, beforeSeq int64, limit int) []Note {
	top := "+inf"
	if beforeSeq > 0 {
		top = fmt.Sprintf("(%d", beforeSeq)
	}
	ids := rdb.ZRevRangeByScore(ctx, NotesKey(ticketID), &redis.ZRangeBy{Max: top, Min: "-inf", Offset: 0, Count: int64(limit)}).Val()
	return notesOf(ctx, ids)
}

// PageAt is limit notes of the ticket from row offset, newest first.
func PageAt(ctx context.Context, ticketID string, offset, limit int) []Note {
	return notesOf(ctx, rdb.ZRevRange(ctx, NotesKey(ticketID), int64(offset), int64(offset+limit-1)).Val())
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'tickets/store.h': `// The ticket store (provided), kept in Redis hashes. ticket:{id} holds id, requester_id, subject,
// state (open, pending, resolved or closed) and closed_at (Unix seconds, "" unless closed). note:{id}
// holds id, ticket_id, seq, author, visibility (public or internal) and body; ticket:{id}:notes
// indexes a ticket's notes by seq. crm:outbox holds the notes the CRM has not taken yet (by seq),
// crm:synced the ones it has, crm:quarantine the ones it refused, with the reason. toJson gives a
// ticket or a note as the API answers it.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

inline const std::string kOutbox = "crm:outbox";
inline const std::string kSynced = "crm:synced";
inline const std::string kQuarantined = "crm:quarantine";

// closed_at is Unix seconds, 0 unless closed.
struct Ticket {
  std::string id;
  std::string requester_id;
  std::string subject;
  std::string state;
  long long closed_at = 0;
};

struct Note {
  std::string id;
  std::string ticket_id;
  long long seq = 0;
  std::string author;
  std::string visibility;
  std::string body;
};

// Moves the ticket from ARGV[1] to ARGV[2] only if it is still in ARGV[1]; ARGV[3] is the new closed_at.
inline const std::string kTransitionLua = R"lua(
if redis.call('HGET', KEYS[1], 'state') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'state', ARGV[2], 'closed_at', ARGV[3])
return 1
)lua";

// The note row, the ticket's index and (when a third key is given) the CRM outbox, in one script.
inline const std::string kNoteLua = R"lua(
redis.call('HSET', KEYS[1], 'id', ARGV[1], 'ticket_id', ARGV[2], 'seq', ARGV[3], 'author', ARGV[4], 'visibility', ARGV[5], 'body', ARGV[6])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
if #KEYS == 3 then redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1]) end
return 1
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string ticketKey(const std::string& ticket_id) { return "ticket:" + ticket_id; }
inline std::string noteKey(const std::string& note_id) { return "note:" + note_id; }
inline std::string notesKey(const std::string& ticket_id) { return "ticket:" + ticket_id + ":notes"; }

inline nlohmann::json toJson(const Ticket& t) {
  return {{"id", t.id},
          {"requester_id", t.requester_id},
          {"subject", t.subject},
          {"state", t.state},
          {"closed_at", t.closed_at ? nlohmann::json(t.closed_at) : nlohmann::json(nullptr)}};
}

inline nlohmann::json toJson(const Note& n) {
  return {{"id", n.id}, {"ticket_id", n.ticket_id}, {"seq", n.seq}, {"author", n.author}, {"visibility", n.visibility}, {"body", n.body}};
}

// The ticket, or none.
inline std::optional<Ticket> getTicket(const std::string& ticket_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(ticketKey(ticket_id));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  Ticket t{text("id"), text("requester_id"), text("subject"), text("state"), 0};
  if (!text("closed_at").empty()) t.closed_at = std::stoll(text("closed_at"));
  return t;
}

// A new open ticket of the requester; returns it.
inline Ticket createTicket(const std::string& requester_id, const std::string& subject) {
  const std::string ticket_id = "T-" + std::to_string(redis().incr("ticket:seq"));
  redis().hset(ticketKey(ticket_id),
               {{"id", ticket_id}, {"requester_id", requester_id}, {"subject", subject}, {"state", "open"}, {"closed_at", ""}});
  return *getTicket(ticket_id);
}

// Move the ticket to to_state if it is still in from_state (one Lua script): closed_at is stamped
// when it closes and cleared when it leaves closed. false when another writer moved it first.
inline bool transition(const std::string& ticket_id, const std::string& from_state, const std::string& to_state) {
  const long long now =
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string closed_at = to_state == "closed" ? std::to_string(now) : "";
  return redis().eval<long long>(kTransitionLua, {ticketKey(ticket_id)}, {from_state, to_state, closed_at}) == 1;
}

// The note, or none.
inline std::optional<Note> getNote(const std::string& note_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(noteKey(note_id));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  return Note{text("id"), text("ticket_id"), std::stoll(text("seq")), text("author"), text("visibility"), text("body")};
}

inline std::vector<Note> notesOf(const std::vector<std::string>& ids) {
  std::vector<Note> notes;
  for (const std::string& id : ids) {
    if (auto note = getNote(id)) notes.push_back(*note);
  }
  return notes;
}

inline Note writeNote(const std::string& ticket_id, const std::string& author, const std::string& visibility,
                      const std::string& body, bool outbox) {
  const long long seq = redis().incr("note:seq");
  const std::string note_id = "N-" + std::to_string(seq);
  std::vector<std::string> keys = {noteKey(note_id), notesKey(ticket_id)};
  if (outbox) keys.push_back(kOutbox);
  const std::vector<std::string> args = {note_id, ticket_id, std::to_string(seq), author, visibility, body};
  redis().eval<long long>(kNoteLua, keys, args);
  return *getNote(note_id);
}

// The note row and the ticket's index; nothing for the CRM. Returns the note.
inline Note appendNote(const std::string& ticket_id, const std::string& author, const std::string& visibility,
                       const std::string& body) {
  return writeNote(ticket_id, author, visibility, body, false);
}

// The note row, the ticket's index and its crm:outbox entry in one script: the note and the promise
// to sync it commit together. Returns the note.
inline Note commitNote(const std::string& ticket_id, const std::string& author, const std::string& visibility,
                       const std::string& body) {
  return writeNote(ticket_id, author, visibility, body, true);
}

// The notes in crm:outbox, oldest first.
inline std::vector<Note> pendingSyncs() { return notesOf(redis().zrange(kOutbox, 0, -1)); }

// The CRM took the note: it leaves the outbox for crm:synced.
inline void markSynced(const std::string& note_id) {
  redis().zrem(kOutbox, note_id);
  redis().sadd(kSynced, note_id);
}

// The CRM refused the note: it leaves the outbox for crm:quarantine, with the reason.
inline void quarantine(const std::string& note_id, const std::string& reason) {
  redis().zrem(kOutbox, note_id);
  redis().hset(kQuarantined, note_id, reason);
}

// Up to limit notes of the ticket with seq < before_seq (0: from the newest), newest first: a keyset page.
inline std::vector<Note> page(const std::string& ticket_id, long long before_seq, long long limit) {
  const std::string top = before_seq > 0 ? "(" + std::to_string(before_seq) : "+inf";
  return notesOf(redis().command<std::vector<std::string>>("ZREVRANGEBYSCORE", notesKey(ticket_id), top, "-inf", "LIMIT",
                                                           "0", std::to_string(limit)));
}

// limit notes of the ticket from row offset, newest first.
inline std::vector<Note> pageAt(const std::string& ticket_id, long long offset, long long limit) {
  return notesOf(redis().zrevrange(notesKey(ticket_id), offset, offset + limit - 1));
}

}  // namespace store
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('tickets', 'Store')]: `package tickets

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The ticket store (provided), kept in Redis hashes. ticket:{id} holds id, requester_id, subject,
 * state (open, pending, resolved or closed) and closed_at (Unix seconds, "" unless closed). note:{id}
 * holds id, ticket_id, seq, author, visibility (public or internal) and body; ticket:{id}:notes
 * indexes a ticket's notes by seq. crm:outbox holds the notes the CRM has not taken yet (by seq),
 * crm:synced the ones it has, crm:quarantine the ones it refused, with the reason. toJson gives a
 * ticket or a note as the API answers it.
 */
object Store {
  final case class Ticket(id: String, requesterId: String, subject: String, state: String, closedAt: Option[Long])
  final case class Note(id: String, ticketId: String, seq: Long, author: String, visibility: String, body: String)

  val Outbox = "crm:outbox"
  val Synced = "crm:synced"
  val Quarantined = "crm:quarantine"

  val jedis = new JedisPooled("redis", 6379)

  /** Moves the ticket from ARGV[1] to ARGV[2] only if it is still in ARGV[1]; ARGV[3] is the new closed_at. */
  val TransitionLua: String =
    """if redis.call('HGET', KEYS[1], 'state') ~= ARGV[1] then return 0 end
      |redis.call('HSET', KEYS[1], 'state', ARGV[2], 'closed_at', ARGV[3])
      |return 1
      |""".stripMargin

  /** The note row, the ticket's index and (when a third key is given) the CRM outbox, in one script. */
  val NoteLua: String =
    """redis.call('HSET', KEYS[1], 'id', ARGV[1], 'ticket_id', ARGV[2], 'seq', ARGV[3], 'author', ARGV[4], 'visibility', ARGV[5], 'body', ARGV[6])
      |redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
      |if #KEYS == 3 then redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1]) end
      |return 1
      |""".stripMargin

  def ticketKey(ticketId: String): String = s"ticket:$ticketId"
  def noteKey(noteId: String): String = s"note:$noteId"
  def notesKey(ticketId: String): String = s"ticket:$ticketId:notes"

  def toJson(t: Ticket): JsObject = JsObject(
    "id" -> JsString(t.id), "requester_id" -> JsString(t.requesterId), "subject" -> JsString(t.subject),
    "state" -> JsString(t.state), "closed_at" -> t.closedAt.map(JsNumber(_)).getOrElse(JsNull))

  def toJson(n: Note): JsObject = JsObject(
    "id" -> JsString(n.id), "ticket_id" -> JsString(n.ticketId), "seq" -> JsNumber(n.seq), "author" -> JsString(n.author),
    "visibility" -> JsString(n.visibility), "body" -> JsString(n.body))

  /** A new open ticket of the requester; returns it. */
  def createTicket(requesterId: String, subject: String): Ticket = {
    val ticketId = s"T-\${jedis.incr("ticket:seq")}"
    jedis.hset(ticketKey(ticketId), Map("id" -> ticketId, "requester_id" -> requesterId, "subject" -> subject, "state" -> "open", "closed_at" -> "").asJava)
    getTicket(ticketId).get
  }

  /** The ticket, if any. */
  def getTicket(ticketId: String): Option[Ticket] = {
    val raw = jedis.hgetAll(ticketKey(ticketId)).asScala.toMap
    if (raw.isEmpty) None
    else Some(Ticket(raw("id"), raw("requester_id"), raw("subject"), raw("state"), raw.get("closed_at").filter(_.nonEmpty).map(_.toLong)))
  }

  /** Move the ticket to toState if it is still in fromState (one Lua script): closed_at is stamped when it closes and cleared when it leaves closed. false when another writer moved it first. */
  def transition(ticketId: String, fromState: String, toState: String): Boolean = {
    val closedAt = if (toState == "closed") (System.currentTimeMillis() / 1000).toString else ""
    jedis.eval(TransitionLua, List(ticketKey(ticketId)).asJava, List(fromState, toState, closedAt).asJava).asInstanceOf[java.lang.Long] == 1L
  }

  /** The note, if any. */
  def getNote(noteId: String): Option[Note] = {
    val raw = jedis.hgetAll(noteKey(noteId)).asScala.toMap
    if (raw.isEmpty) None else Some(Note(raw("id"), raw("ticket_id"), raw("seq").toLong, raw("author"), raw("visibility"), raw("body")))
  }

  private def notesOf(ids: java.util.List[String]): List[Note] = ids.asScala.toList.flatMap(getNote)

  private def writeNote(ticketId: String, author: String, visibility: String, body: String, outbox: Boolean): Note = {
    val seq = jedis.incr("note:seq")
    val noteId = s"N-$seq"
    val keys = List(noteKey(noteId), notesKey(ticketId)) ++ (if (outbox) List(Outbox) else Nil)
    jedis.eval(NoteLua, keys.asJava, List(noteId, ticketId, seq.toString, author, visibility, body).asJava)
    getNote(noteId).get
  }

  /** The note row and the ticket's index; nothing for the CRM. Returns the note. */
  def appendNote(ticketId: String, author: String, visibility: String, body: String): Note =
    writeNote(ticketId, author, visibility, body, outbox = false)

  /** The note row, the ticket's index and its crm:outbox entry in one script: the note and the promise to sync it commit together. */
  def commitNote(ticketId: String, author: String, visibility: String, body: String): Note =
    writeNote(ticketId, author, visibility, body, outbox = true)

  /** The notes in crm:outbox, oldest first. */
  def pendingSyncs(): List[Note] = notesOf(jedis.zrange(Outbox, 0, -1))

  /** The CRM took the note: it leaves the outbox for crm:synced. */
  def markSynced(noteId: String): Unit = {
    jedis.zrem(Outbox, noteId)
    jedis.sadd(Synced, noteId)
  }

  /** The CRM refused the note: it leaves the outbox for crm:quarantine, with the reason. */
  def quarantine(noteId: String, reason: String): Unit = {
    jedis.zrem(Outbox, noteId)
    jedis.hset(Quarantined, noteId, reason)
  }

  /** Up to limit notes of the ticket with seq < beforeSeq (None: from the newest), newest first: a keyset page. */
  def page(ticketId: String, beforeSeq: Option[Long], limit: Int): List[Note] = {
    val top = beforeSeq.map(seq => s"($seq").getOrElse("+inf")
    notesOf(jedis.zrevrangeByScore(notesKey(ticketId), top, "-inf", 0, limit))
  }

  /** limit notes of the ticket from row offset, newest first. */
  def pageAt(ticketId: String, offset: Int, limit: Int): List[Note] =
    notesOf(jedis.zrevrange(notesKey(ticketId), offset.toLong, (offset + limit - 1).toLong))
}
`,
};
