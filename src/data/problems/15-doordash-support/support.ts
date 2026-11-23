/**
 * Hand-written support modules the support-assistant steps import but no step builds — the
 * `assistant` package: deterministic embeddings (`embed`), chunking (`chunk`), the knowledge base
 * (`kb`), the prompt format (`prompt`), the stand-in model and judge the harness serves (`model`),
 * the database handle and schema (`db`) and the addresses and limits everything agrees on
 * (`config`). The Python and TypeScript versions compute the same numbers from the same text, so a
 * nearest neighbour or a judge score is the same in both runtimes.
 */
import {CPP_DIGEST_H} from '../cpp-support';

const ARTICLES: {id: string; title: string; body: string}[] = [
  {
    id: 'pay',
    title: 'When and how Dashers are paid',
    body: 'Dasher earnings for a week are paid out every Monday by direct deposit and usually arrive within two to three business days, depending on the bank. Fast Pay lets a Dasher cash out once per day for a small fee, as long as the account has been active for two weeks and at least twenty-five deliveries have been completed. Earnings from a delivery appear in the app as soon as the order is marked delivered. If a payout is missing after five business days, check the bank details on file before contacting support.',
  },
  {
    id: 'tips',
    title: 'Tips and how they reach the Dasher',
    body: 'Customers can tip when they order or after the delivery, and Dashers keep one hundred percent of every tip. A tip added after delivery shows up in the earnings breakdown within a few hours, under the delivery it belongs to. Tips are included in the weekly payout and in Fast Pay. Base pay and promotions never replace a tip; they are added on top of it.',
  },
  {
    id: 'undeliverable',
    title: 'Customer unavailable or order cannot be delivered',
    body: 'When a customer does not answer at the door, the Dasher should call and text them through the app and then start the ten-minute timer. If the timer runs out, the app allows the order to be marked as undeliverable and the Dasher is still paid in full for the delivery. Food that cannot be delivered may be kept or disposed of; it should never be returned to the store. Deliveries marked undeliverable do not affect the completion rate.',
  },
  {
    id: 'login',
    title: 'Trouble signing in to the Dasher app',
    body: 'If the Dasher app will not sign in, first update it to the latest version and check that the phone has a data connection. Use the Forgot Password link to reset a password; the reset email can take a few minutes and may land in spam. An account locked after too many attempts unlocks on its own after thirty minutes. Two-factor codes are sent by text message to the number on the account, so an old phone number must be updated before signing in again.',
  },
  {
    id: 'scheduling',
    title: 'Scheduling a dash and Dash Now',
    body: 'Dashers can schedule time slots up to six days ahead in the Schedule tab, and slots open at three in the afternoon local time each day. When a zone is busy enough it shows Dash Now, which lets a Dasher start without a scheduled slot. A scheduled dash that is not started within thirty minutes of its start time is released to other Dashers. Scheduled time can be extended from the app while dashing as long as the zone still has room.',
  },
  {
    id: 'ratings',
    title: 'Customer ratings and completion rate',
    body: 'The customer rating is the average of the last one hundred ratings from customers, and the completion rate is the share of accepted deliveries that were completed over the last one hundred accepted. Declining an offer before accepting it does not affect the completion rate; unassigning after accepting does. A completion rate below eighty percent or a customer rating below 4.2 can lead to deactivation after a warning. Ratings older than the last hundred deliveries fall away on their own.',
  },
  {
    id: 'deactivation',
    title: 'Appealing a deactivation',
    body: 'A deactivated Dasher receives an email naming the policy that applied and a link to the appeal form. Appeals are reviewed by a person within about a week, and the decision is sent by email. Deactivations for low completion rate or low customer rating can be appealed once; deactivations for fraud or safety violations are reviewed case by case. Supporting evidence such as screenshots or delivery photos can be attached to the appeal form.',
  },
  {
    id: 'red-card',
    title: 'The Red Card and declined payments',
    body: 'The Red Card is only used for orders the app marks as Shop and Pay or Pay with Red Card; it is never used for a Dasher\u2019s own purchases. If the card is declined at checkout, confirm that the items in the cart match the order and that the total is within the amount shown in the app, then try again. A card that is still declined should be reported through the Dasher app so the order can be reassigned or paid another way. The Dasher is paid for the time spent even when the order is cancelled at checkout.',
  },
  {
    id: 'vehicle',
    title: 'Vehicles, insurance and what the Dasher needs to carry',
    body: 'Dashers can deliver by car, scooter, bicycle or on foot depending on the market, and the vehicle type can be changed in the app before a dash starts. Dashers who drive must keep their own auto insurance as required by their state; occupational accident insurance covers medical costs for injuries during an active delivery at no cost to the Dasher. An insulated bag is required for restaurant deliveries and can be ordered from the Dasher store.',
  },
  {
    id: 'referrals',
    title: 'Referral bonuses',
    body: 'A Dasher can refer a friend from the Refer tab, and both receive the bonus once the new Dasher completes the required number of deliveries within the stated window, usually thirty days. The bonus amount and the delivery requirement depend on the market and are shown on the referral page before the invitation is sent. Referral bonuses are paid with the regular weekly payout and are not eligible for Fast Pay.',
  },
];

const articlesPy = ARTICLES.map(
  a => `    {"id": ${JSON.stringify(a.id)}, "title": ${JSON.stringify(a.title)}, "body": ${JSON.stringify(a.body)}},`,
).join('\n');
const articlesTs = ARTICLES.map(
  a => `  {id: ${JSON.stringify(a.id)}, title: ${JSON.stringify(a.title)}, body: ${JSON.stringify(a.body)}},`,
).join('\n');

export const supportModules: Record<string, string> = {
  'assistant/__init__.py': '',
  'assistant/config.py': `"""Addresses, topics and limits every step of the assistant agrees on."""
# The stand-in model server (served by the harness) at two addresses, and the LLM judge.
LLM_LARGE = "llm-large:50051"
LLM_SMALL = "llm-small:50051"
JUDGE = "judge:50051"
# Kafka: one record per answered turn, keyed by session; the offline judge's consumer group.
TOPIC = "support-conversations"
GROUP = "quality-judge"
# Redis
HISTORY_TTL_S = 86400
CACHE_TTL_S = 3600
RATE_LIMIT_PER_MINUTE = 20
# Retrieval and generation
TOP_K = 4
MAX_TOKENS = 120
DEADLINE_S = 2.0
MIN_SIMILARITY = 0.3
HANDOFF_TEXT = "I've passed this to a support agent, who will follow up with you shortly."
`,
  'assistant/embed.py': `"""
Deterministic text embeddings for the course: a TF-IDF vector over the knowledge base's vocabulary
(each word a dimension, weighted by how rare it is across the KB's chunks; words the KB never saw
share a hashed band at the end), L2-normalised, 512 dimensions. Not a language model — a stand-in
with the properties retrieval relies on: the same text always gives the same vector, texts sharing
rare words land close together (cosine), and function words count for nothing. \`to_pgvector\` writes
a vector the way pgvector reads it: "[0.1,0.2,...]".
"""
import math
import re

from . import chunk as _chunk
from . import kb as _kb

DIM = 512
_WORD = re.compile(r"[a-z0-9]+")
# Function words carry no topic; without them a question's vector points at its subject, as a real embedding's would.
STOP_WORDS = frozenset(
    "a an and are as at be been but by can could did do does for from get got had has have he her his how i if in is it its me my no not of on or our she so that the their them they this to up us was we were what when where which who will with would you your".split()
)


def tokenize(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in STOP_WORDS]


def count_tokens(text: str) -> int:
    return len(tokenize(text))


def _fnv1a(s: str) -> int:
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


# The vocabulary and document frequencies come from the KB's chunks, so every process computes the same vector.
_CHUNKS = [c for a in _kb.ARTICLES for c in _chunk.chunk(a["body"])]
_DF: dict[str, int] = {}
for _text in _CHUNKS:
    for _w in set(tokenize(_text)):
        _DF[_w] = _DF.get(_w, 0) + 1
VOCAB = sorted(_DF)
_INDEX = {w: i for i, w in enumerate(VOCAB)}
_N = len(_CHUNKS)


def idf(word: str) -> float:
    """log(1 + N/df): a word in every chunk weighs little, a word in one weighs most; an unseen word most of all."""
    return math.log(1 + _N / _DF.get(word, 0.5))


def _slot(word: str) -> int:
    i = _INDEX.get(word)
    return i if i is not None else len(VOCAB) + _fnv1a(word) % (DIM - len(VOCAB))


def embed(text: str) -> list[float]:
    v = [0.0] * DIM
    for tok in tokenize(text):
        v[_slot(tok)] += idf(tok)
    norm = math.sqrt(sum(x * x for x in v))
    if norm == 0:
        return v
    return [round(x / norm, 6) for x in v]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def to_pgvector(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


def from_pgvector(s: str) -> list[float]:
    return [float(x) for x in s.strip("[]").split(",") if x]
`,
  'assistant/chunk.py': `"""Fixed-size word windows with overlap: the chunking every step and the harness agree on."""

CHUNK_WORDS = 48
OVERLAP_WORDS = 12


def chunk(text: str, size: int = CHUNK_WORDS, overlap: int = OVERLAP_WORDS) -> list[str]:
    words = text.split()
    if not words:
        return []
    step = size - overlap
    out = []
    start = 0
    while True:
        out.append(" ".join(words[start : start + size]))
        if start + size >= len(words):
            break
        start += step
    return out
`,
  'assistant/kb.py': `"""The support knowledge base: ten short articles. Chunk ids are "<article>-<position>"."""

ARTICLES: list[dict] = [
${articlesPy}
]


def article(article_id: str) -> dict | None:
    for a in ARTICLES:
        if a["id"] == article_id:
            return a
    return None
`,
  'assistant/prompt.py': `"""
The one prompt format: instructions, the retrieved chunks as "[kb:<id>] <text>" lines, the
conversation so far, then the question. The stand-in model reads chunk ids from these lines, which
is what lets a check tell a grounded answer from an invented one.
"""

INSTRUCTIONS = (
    "You are a Dasher support assistant. Answer only from the context below and cite the chunks you "
    "use as [kb:<id>]. If the context does not answer the question, say so."
)


def build_prompt(question: str, chunks: list[dict], history: list[dict] | None = None) -> str:
    lines = [INSTRUCTIONS, "", "Context:"]
    for c in chunks:
        lines.append(f"[kb:{c['id']}] {c['text']}")
    lines.append("")
    lines.append("History:")
    for turn in history or []:
        lines.append(f"{turn['role']}: {turn['text']}")
    lines.append("")
    lines.append(f"Question: {question}")
    lines.append("Answer:")
    return "\\n".join(lines)


def cited_ids(answer: str) -> list[str]:
    """Chunk ids an answer cites, in order, without duplicates."""
    import re

    out: list[str] = []
    for m in re.finditer(r"\\[kb:([^\\]]+)\\]", answer):
        if m.group(1) not in out:
            out.append(m.group(1))
    return out
`,
  'assistant/model.py': `"""
The stand-in for the model server and the LLM judge. The harness serves these over gRPC (Llm at
llm-large:50051 / llm-small:50051, Judge at judge:50051); the learner's code never calls them
directly. Deterministic on purpose: the course grades what the system around a model does — grounds
it, bounds it, times it out, judges it, escalates — never the prose.

complete(prompt, max_tokens, mode):
  "faithful"     cites the first two context chunks and answers with the first sentence of the top one
  "hallucinate"  invents a policy and cites a chunk that was never retrieved ([kb:policy-404])
  "verbose"      the faithful answer followed by filler, so max_tokens has to cut it
  With no context chunks in the prompt the model says the documentation does not cover it (no citation).
"""
import re

_CHUNK_LINE = re.compile(r"^\\[kb:([^\\]]+)\\]\\s*(.*)$", re.MULTILINE)
_CITE = re.compile(r"\\[kb:([^\\]]+)\\]")
_RISKY = re.compile(r"guarantee|promise|lawsuit|legal action", re.IGNORECASE)

NO_CONTEXT_TEXT = "The documentation available to me does not cover this; a support agent can help."


def _first_sentence(text: str) -> str:
    m = re.search(r"[^.!?]*[.!?]", text)
    return (m.group(0) if m else text).strip()


def tokens(text: str) -> list[str]:
    """The text as the model streams it: words, each but the last carrying its trailing space."""
    words = text.split()
    return [w + (" " if i < len(words) - 1 else "") for i, w in enumerate(words)]


def truncate(text: str, max_tokens: int) -> str:
    words = text.split()
    return " ".join(words[:max_tokens]) if max_tokens > 0 else ""


def complete(prompt: str, max_tokens: int, mode: str = "faithful") -> str:
    chunks = _CHUNK_LINE.findall(prompt)
    if mode == "hallucinate":
        text = "Your issue will be resolved within 7 days, guaranteed [kb:policy-404]."
    elif not chunks:
        text = NO_CONTEXT_TEXT
    else:
        cites = "".join(f"[kb:{cid}]" for cid, _ in chunks[:2])
        text = f"Based on {cites}: {_first_sentence(chunks[0][1])}"
        if mode == "verbose":
            text += " " + " ".join(["Additionally, please note that this may vary by market and over time."] * 40)
    return truncate(text, max_tokens)


def evaluate(question: str, answer: str, context_ids: list[str]) -> dict:
    """The judge's rubric: groundedness (citations within the context), coherence (length), compliance (no promises)."""
    cited = _CITE.findall(answer)
    if not cited:
        groundedness = 0.0
    else:
        groundedness = sum(1 for c in cited if c in context_ids) / len(cited)
    words = len(answer.split())
    coherence = 1.0 if 3 <= words <= 160 else 0.4
    compliance = 0.0 if _RISKY.search(answer) else 1.0
    return {
        "groundedness": round(groundedness, 3),
        "coherence": coherence,
        "compliance": compliance,
        "pass": groundedness >= 0.8 and coherence >= 0.8 and compliance >= 0.8,
    }
`,
  'assistant/db.py': `"""
The assistant's Postgres (PGlite with pgvector): \`await db.execute(sql, params)\` for one statement,
\`async with db.transaction() as cur:\` for several; %s placeholders; dict rows. SCHEMA is what the
harness applies before a check.

Tables:
    kb_chunks      (id text primary key, article text, position int, text text, embedding vector(512))
    quality_scores (session_id text, turn int, groundedness real, coherence real, compliance real, pass boolean,
                    primary key (session_id, turn))
"""
from leetbuild.db import DB as db

SCHEMA = """
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE kb_chunks (
  id text PRIMARY KEY,
  article text NOT NULL,
  position int NOT NULL,
  text text NOT NULL,
  embedding vector(512) NOT NULL
);
CREATE TABLE quality_scores (
  session_id text NOT NULL,
  turn int NOT NULL,
  groundedness real NOT NULL,
  coherence real NOT NULL,
  compliance real NOT NULL,
  pass boolean NOT NULL,
  PRIMARY KEY (session_id, turn)
);
"""

__all__ = ["db", "SCHEMA"]
`,
};

export const supportModulesTs: Record<string, string> = {
  'assistant/config.ts': `/** Addresses, topics and limits every step of the assistant agrees on. */
// The stand-in model server (served by the harness) at two addresses, and the LLM judge.
export const LLM_LARGE = 'llm-large:50051';
export const LLM_SMALL = 'llm-small:50051';
export const JUDGE = 'judge:50051';
// Kafka: one record per answered turn, keyed by session; the offline judge's consumer group.
export const TOPIC = 'support-conversations';
export const GROUP = 'quality-judge';
// Redis
export const HISTORY_TTL_S = 86400;
export const CACHE_TTL_S = 3600;
export const RATE_LIMIT_PER_MINUTE = 20;
// Retrieval and generation
export const TOP_K = 4;
export const MAX_TOKENS = 120;
export const DEADLINE_S = 2.0;
export const MIN_SIMILARITY = 0.3;
export const HANDOFF_TEXT = "I've passed this to a support agent, who will follow up with you shortly.";
`,
  'assistant/embed.ts': `/**
 * Deterministic text embeddings for the course: a TF-IDF vector over the knowledge base's vocabulary
 * (each word a dimension, weighted by how rare it is across the KB's chunks; words the KB never saw
 * share a hashed band at the end), L2-normalised, 512 dimensions. Not a language model — a stand-in
 * with the properties retrieval relies on: the same text always gives the same vector, texts sharing
 * rare words land close together (cosine), and function words count for nothing. \`toPgvector\` writes
 * a vector the way pgvector reads it: "[0.1,0.2,...]". The same numbers as the Python module.
 */
import {chunk} from './chunk';
import {ARTICLES} from './kb';

export const DIM = 512;

/** Function words carry no topic; without them a question's vector points at its subject, as a real embedding's would. */
export const STOP_WORDS = new Set(
  'a an and are as at be been but by can could did do does for from get got had has have he her his how i if in is it its me my no not of on or our she so that the their them they this to up us was we were what when where which who will with would you your'.split(
    ' ',
  ),
);

export const tokenize = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => !STOP_WORDS.has(w));

export const countTokens = (text: string): number => tokenize(text).length;

const encoder = new TextEncoder();

const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (const b of encoder.encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};

// The vocabulary and document frequencies come from the KB's chunks, so every process computes the same vector.
const CHUNKS = ARTICLES.flatMap(a => chunk(a.body));
const DF = new Map<string, number>();
for (const text of CHUNKS) for (const w of new Set(tokenize(text))) DF.set(w, (DF.get(w) ?? 0) + 1);
export const VOCAB = [...DF.keys()].sort();
const INDEX = new Map(VOCAB.map((w, i) => [w, i]));
const N = CHUNKS.length;

/** log(1 + N/df): a word in every chunk weighs little, a word in one weighs most; an unseen word most of all. */
export const idf = (word: string): number => Math.log(1 + N / (DF.get(word) ?? 0.5));

const slot = (word: string): number => INDEX.get(word) ?? VOCAB.length + (fnv1a(word) % (DIM - VOCAB.length));

export function embed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const tok of tokenize(text)) v[slot(tok)] += idf(tok);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return v;
  return v.map(x => Math.round((x / norm) * 1e6) / 1e6);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export const toPgvector = (v: number[]): string => '[' + v.map(x => x.toFixed(6)).join(',') + ']';

export const fromPgvector = (s: string): number[] =>
  s
    .replace(/^\\[|\\]$/g, '')
    .split(',')
    .filter(x => x !== '')
    .map(Number);
`,
  'assistant/chunk.ts': `/** Fixed-size word windows with overlap: the chunking every step and the harness agree on. */
export const CHUNK_WORDS = 48;
export const OVERLAP_WORDS = 12;

export function chunk(text: string, size = CHUNK_WORDS, overlap = OVERLAP_WORDS): string[] {
  const words = text.split(/\\s+/).filter(w => w !== '');
  if (words.length === 0) return [];
  const step = size - overlap;
  const out: string[] = [];
  let start = 0;
  for (;;) {
    out.push(words.slice(start, start + size).join(' '));
    if (start + size >= words.length) break;
    start += step;
  }
  return out;
}
`,
  'assistant/kb.ts': `/** The support knowledge base: ten short articles. Chunk ids are "<article>-<position>". */
export interface Article {
  id: string;
  title: string;
  body: string;
}

export const ARTICLES: Article[] = [
${articlesTs}
];

export const article = (id: string): Article | undefined => ARTICLES.find(a => a.id === id);
`,
  'assistant/prompt.ts': `/**
 * The one prompt format: instructions, the retrieved chunks as "[kb:<id>] <text>" lines, the
 * conversation so far, then the question. The stand-in model reads chunk ids from these lines, which
 * is what lets a check tell a grounded answer from an invented one.
 */
export interface Chunk {
  id: string;
  text: string;
  score?: number;
}

export interface Turn {
  role: 'dasher' | 'assistant';
  text: string;
}

export const INSTRUCTIONS =
  'You are a Dasher support assistant. Answer only from the context below and cite the chunks you ' +
  'use as [kb:<id>]. If the context does not answer the question, say so.';

export function buildPrompt(question: string, chunks: Chunk[], history: Turn[] = []): string {
  const lines = [INSTRUCTIONS, '', 'Context:'];
  for (const c of chunks) lines.push(\`[kb:\${c.id}] \${c.text}\`);
  lines.push('', 'History:');
  for (const turn of history) lines.push(\`\${turn.role}: \${turn.text}\`);
  lines.push('', \`Question: \${question}\`, 'Answer:');
  return lines.join('\\n');
}

/** Chunk ids an answer cites, in order, without duplicates. */
export function citedIds(answer: string): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(/\\[kb:([^\\]]+)\\]/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
`,
  'assistant/model.ts': `/**
 * The stand-in for the model server and the LLM judge. The harness serves these over gRPC (Llm at
 * llm-large:50051 / llm-small:50051, Judge at judge:50051); the learner's code never calls them
 * directly. Deterministic on purpose: the course grades what the system around a model does — grounds
 * it, bounds it, times it out, judges it, escalates — never the prose.
 *
 * complete(prompt, maxTokens, mode):
 *   'faithful'     cites the first two context chunks and answers with the first sentence of the top one
 *   'hallucinate'  invents a policy and cites a chunk that was never retrieved ([kb:policy-404])
 *   'verbose'      the faithful answer followed by filler, so maxTokens has to cut it
 *   With no context chunks in the prompt the model says the documentation does not cover it (no citation).
 */
export type Mode = 'faithful' | 'hallucinate' | 'verbose';

export const NO_CONTEXT_TEXT = 'The documentation available to me does not cover this; a support agent can help.';

const firstSentence = (text: string): string => (/[^.!?]*[.!?]/.exec(text)?.[0] ?? text).trim();

/** The text as the model streams it: words, each but the last carrying its trailing space. */
export function tokens(text: string): string[] {
  const words = text.split(/\\s+/).filter(w => w !== '');
  return words.map((w, i) => (i < words.length - 1 ? w + ' ' : w));
}

export function truncate(text: string, maxTokens: number): string {
  const words = text.split(/\\s+/).filter(w => w !== '');
  return maxTokens > 0 ? words.slice(0, maxTokens).join(' ') : '';
}

export function complete(prompt: string, maxTokens: number, mode: Mode = 'faithful'): string {
  const chunks = [...prompt.matchAll(/^\\[kb:([^\\]]+)\\]\\s*(.*)$/gm)].map(m => [m[1], m[2]] as const);
  let text: string;
  if (mode === 'hallucinate') text = 'Your issue will be resolved within 7 days, guaranteed [kb:policy-404].';
  else if (chunks.length === 0) text = NO_CONTEXT_TEXT;
  else {
    const cites = chunks
      .slice(0, 2)
      .map(([id]) => \`[kb:\${id}]\`)
      .join('');
    text = \`Based on \${cites}: \${firstSentence(chunks[0][1])}\`;
    if (mode === 'verbose')
      text += ' ' + Array(40).fill('Additionally, please note that this may vary by market and over time.').join(' ');
  }
  return truncate(text, maxTokens);
}

export interface Scores {
  groundedness: number;
  coherence: number;
  compliance: number;
  pass: boolean;
}

/** The judge's rubric: groundedness (citations within the context), coherence (length), compliance (no promises). */
export function evaluate(question: string, answer: string, contextIds: string[]): Scores {
  const cited = [...answer.matchAll(/\\[kb:([^\\]]+)\\]/g)].map(m => m[1]);
  const groundedness =
    cited.length === 0 ? 0 : Math.round((cited.filter(c => contextIds.includes(c)).length / cited.length) * 1000) / 1000;
  const words = answer.split(/\\s+/).filter(w => w !== '').length;
  const coherence = words >= 3 && words <= 160 ? 1 : 0.4;
  const compliance = /guarantee|promise|lawsuit|legal action/i.test(answer) ? 0 : 1;
  return {groundedness, coherence, compliance, pass: groundedness >= 0.8 && coherence >= 0.8 && compliance >= 0.8};
}
`,
  'assistant/db.ts': `/**
 * The assistant's Postgres (PGlite with pgvector): \`await pool.query(sql, [params])\` runs one statement
 * ($1… placeholders) and returns \`{rows, rowCount}\`; \`const client = await pool.connect()\` checks the
 * connection out for a transaction (BEGIN … COMMIT on the client, then \`client.release()\`). SCHEMA is
 * what the harness applies before a check.
 *
 * Tables:
 *     kb_chunks      (id text primary key, article text, position int, text text, embedding vector(512))
 *     quality_scores (session_id text, turn int, groundedness real, coherence real, compliance real, pass boolean,
 *                     primary key (session_id, turn))
 */
import {Pool} from 'pg';

export const pool = new Pool({connectionString: 'postgres://assistant@db/assistant'});

export const SCHEMA = \`
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE kb_chunks (
  id text PRIMARY KEY,
  article text NOT NULL,
  position int NOT NULL,
  text text NOT NULL,
  embedding vector(512) NOT NULL
);
CREATE TABLE quality_scores (
  session_id text NOT NULL,
  turn int NOT NULL,
  groundedness real NOT NULL,
  coherence real NOT NULL,
  compliance real NOT NULL,
  pass boolean NOT NULL,
  PRIMARY KEY (session_id, turn)
);
\`;
`,
};

const articlesGo = ARTICLES.map(
  a => `	{ID: ${JSON.stringify(a.id)}, Title: ${JSON.stringify(a.title)}, Body: ${JSON.stringify(a.body)}},`,
).join('\n');

/** The Go twins: the same `assistant` packages, computing the same numbers from the same text. */
export const supportModulesGo: Record<string, string> = {
  'assistant/config/config.go': `// Package config holds the addresses, topics and limits every step of the assistant agrees on.
package config

// The stand-in model server (served by the harness) at two addresses, and the LLM judge.
const (
	LLMLarge = "llm-large:50051"
	LLMSmall = "llm-small:50051"
	Judge    = "judge:50051"
)

// Kafka: one record per answered turn, keyed by session; the offline judge's consumer group.
const (
	Topic = "support-conversations"
	Group = "quality-judge"
)

// Redis. The TTLs are in seconds.
const (
	HistoryTTL         = 86400
	CacheTTL           = 3600
	RateLimitPerMinute = 20
)

// Retrieval and generation.
const (
	TopK          = 4
	MaxTokens     = 120
	DeadlineS     = 2.0
	MinSimilarity = 0.3
	HandoffText   = "I've passed this to a support agent, who will follow up with you shortly."
)
`,
  'assistant/embed/embed.go': `// Package embed computes deterministic text embeddings for the course: a TF-IDF vector over the
// knowledge base's vocabulary (each word a dimension, weighted by how rare it is across the KB's
// chunks; words the KB never saw share a hashed band at the end), L2-normalised, 512 dimensions. Not
// a language model — a stand-in with the properties retrieval relies on: the same text always gives
// the same vector, texts sharing rare words land close together (Cosine), and function words count
// for nothing. ToPgvector writes a vector the way pgvector reads it: "[0.1,0.2,...]". The same
// numbers as the Python and TypeScript modules.
package embed

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"assistant/chunk"
	"assistant/kb"
)

// Dim is the length of every vector.
const Dim = 512

// StopWords carry no topic; without them a question's vector points at its subject, as a real embedding's would.
var StopWords = map[string]bool{}

var word = regexp.MustCompile(\`[a-z0-9]+\`)

// Vocab is every word of the KB's chunks, sorted: the first len(Vocab) dimensions.
var Vocab []string

var (
	df    = map[string]int{}
	index = map[string]int{}
	n     int
)

// The vocabulary and document frequencies come from the KB's chunks, so every process computes the same vector.
func init() {
	for _, w := range strings.Fields("a an and are as at be been but by can could did do does for from get got had has have he her his how i if in is it its me my no not of on or our she so that the their them they this to up us was we were what when where which who will with would you your") {
		StopWords[w] = true
	}
	for _, a := range kb.Articles {
		for _, text := range chunk.Chunk(a.Body) {
			n++
			seen := map[string]bool{}
			for _, w := range Tokenize(text) {
				if !seen[w] {
					seen[w] = true
					df[w]++
				}
			}
		}
	}
	for w := range df {
		Vocab = append(Vocab, w)
	}
	sort.Strings(Vocab)
	for i, w := range Vocab {
		index[w] = i
	}
}

// Tokenize is the text's lower-cased words, stop words left out.
func Tokenize(text string) []string {
	var out []string
	for _, w := range word.FindAllString(strings.ToLower(text), -1) {
		if !StopWords[w] {
			out = append(out, w)
		}
	}
	return out
}

// CountTokens is len(Tokenize(text)).
func CountTokens(text string) int { return len(Tokenize(text)) }

// IDF is log(1 + N/df): a word in every chunk weighs little, a word in one weighs most; an unseen word most of all.
func IDF(w string) float64 {
	d := 0.5
	if c, ok := df[w]; ok {
		d = float64(c)
	}
	return math.Log(1 + float64(n)/d)
}

func fnv1a(s string) uint32 {
	h := uint32(0x811c9dc5)
	for _, b := range []byte(s) {
		h ^= uint32(b)
		h *= 0x01000193
	}
	return h
}

func slot(w string) int {
	if i, ok := index[w]; ok {
		return i
	}
	return len(Vocab) + int(fnv1a(w)%uint32(Dim-len(Vocab)))
}

// Embed is the text's unit vector, each component rounded to 6 decimals (all zeros for a text of stop words).
func Embed(text string) []float64 {
	v := make([]float64, Dim)
	for _, tok := range Tokenize(text) {
		v[slot(tok)] += IDF(tok)
	}
	norm := 0.0
	for _, x := range v {
		norm += x * x
	}
	norm = math.Sqrt(norm)
	if norm == 0 {
		return v
	}
	for i, x := range v {
		v[i] = math.Round(x/norm*1e6) / 1e6
	}
	return v
}

// Cosine is the cosine similarity of a and b, 0 when either is all zeros.
func Cosine(a, b []float64) float64 {
	dot, na, nb := 0.0, 0.0, 0.0
	for i := 0; i < len(a) && i < len(b); i++ {
		dot += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}

// ToPgvector writes v as pgvector's text form, "[0.100000,0.200000,...]"; cast it with ::vector.
func ToPgvector(v []float64) string {
	parts := make([]string, len(v))
	for i, x := range v {
		parts[i] = strconv.FormatFloat(x, 'f', 6, 64)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// FromPgvector reads pgvector's text form back.
func FromPgvector(s string) []float64 {
	var out []float64
	for _, x := range strings.Split(strings.Trim(s, "[]"), ",") {
		if x == "" {
			continue
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		if err != nil {
			return nil
		}
		out = append(out, f)
	}
	return out
}
`,
  'assistant/chunk/chunk.go': `// Package chunk cuts text into fixed-size word windows with overlap: the chunking every step and the harness agree on.
package chunk

import "strings"

// A chunk is ChunkWords words; consecutive chunks share OverlapWords of them.
const (
	ChunkWords   = 48
	OverlapWords = 12
)

// Chunk is text's windows of ChunkWords words, each starting ChunkWords-OverlapWords after the previous; none for an empty text.
func Chunk(text string) []string {
	words := strings.Fields(text)
	if len(words) == 0 {
		return nil
	}
	var out []string
	for start := 0; ; start += ChunkWords - OverlapWords {
		end := start + ChunkWords
		if end > len(words) {
			end = len(words)
		}
		out = append(out, strings.Join(words[start:end], " "))
		if start+ChunkWords >= len(words) {
			return out
		}
	}
}
`,
  'assistant/kb/kb.go': `// Package kb is the support knowledge base: ten short articles. Chunk ids are "<article>-<position>".
package kb

// Article is one page of the knowledge base.
type Article struct {
	ID    string
	Title string
	Body  string
}

// Articles is the whole knowledge base.
var Articles = []Article{
${articlesGo}
}

// Find is the article with this id, and whether there is one.
func Find(id string) (Article, bool) {
	for _, a := range Articles {
		if a.ID == id {
			return a, true
		}
	}
	return Article{}, false
}
`,
  'assistant/prompt/prompt.go': `// Package prompt is the one prompt format: instructions, the retrieved chunks as "[kb:<id>] <text>"
// lines, the conversation so far, then the question. The stand-in model reads chunk ids from these
// lines, which is what lets a check tell a grounded answer from an invented one.
package prompt

import (
	"regexp"
	"strings"
)

// Chunk is a retrieved piece of the knowledge base: its id, its text and how close it was to the question.
type Chunk struct {
	ID    string  \`json:"id"\`
	Text  string  \`json:"text"\`
	Score float64 \`json:"score,omitempty"\`
}

// Turn is one message of a conversation; Role is "dasher" or "assistant".
type Turn struct {
	Role string \`json:"role"\`
	Text string \`json:"text"\`
}

// Instructions open every prompt.
const Instructions = "You are a Dasher support assistant. Answer only from the context below and cite the chunks you " +
	"use as [kb:<id>]. If the context does not answer the question, say so."

// Build is the prompt for question, grounded in chunks, after history.
func Build(question string, chunks []Chunk, history []Turn) string {
	lines := []string{Instructions, "", "Context:"}
	for _, c := range chunks {
		lines = append(lines, "[kb:"+c.ID+"] "+c.Text)
	}
	lines = append(lines, "", "History:")
	for _, t := range history {
		lines = append(lines, t.Role+": "+t.Text)
	}
	lines = append(lines, "", "Question: "+question, "Answer:")
	return strings.Join(lines, "\\n")
}

var cite = regexp.MustCompile(\`\\[kb:([^\\]]+)\\]\`)

// CitedIds is the chunk ids an answer cites, in order, without duplicates.
func CitedIds(answer string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, m := range cite.FindAllStringSubmatch(answer, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			out = append(out, m[1])
		}
	}
	return out
}
`,
  'assistant/model/model.go': `// Package model is the stand-in for the model server and the LLM judge. The harness serves these over
// gRPC (Llm at llm-large:50051 / llm-small:50051, Judge at judge:50051); the learner's code never
// calls them directly. Deterministic on purpose: the course grades what the system around a model
// does — grounds it, bounds it, times it out, judges it, escalates — never the prose.
//
// Complete(prompt, maxTokens, mode):
//
//	"faithful"     cites the first two context chunks and answers with the first sentence of the top one
//	"hallucinate"  invents a policy and cites a chunk that was never retrieved ([kb:policy-404])
//	"verbose"      the faithful answer followed by filler, so maxTokens has to cut it
//
// With no context chunks in the prompt the model says the documentation does not cover it (no citation).
package model

import (
	"math"
	"regexp"
	"strings"
)

// NoContextText is the answer to a prompt without context chunks.
const NoContextText = "The documentation available to me does not cover this; a support agent can help."

var (
	chunkLine = regexp.MustCompile(\`(?m)^\\[kb:([^\\]]+)\\]\\s*(.*)$\`)
	cite      = regexp.MustCompile(\`\\[kb:([^\\]]+)\\]\`)
	risky     = regexp.MustCompile(\`(?i)guarantee|promise|lawsuit|legal action\`)
	sentence  = regexp.MustCompile(\`[^.!?]*[.!?]\`)
)

func firstSentence(text string) string {
	if m := sentence.FindString(text); m != "" {
		return strings.TrimSpace(m)
	}
	return strings.TrimSpace(text)
}

// Tokens is the text as the model streams it: words, each but the last carrying its trailing space.
func Tokens(text string) []string {
	words := strings.Fields(text)
	out := make([]string, len(words))
	for i, w := range words {
		if i < len(words)-1 {
			w += " "
		}
		out[i] = w
	}
	return out
}

// Truncate keeps the first maxTokens words of text.
func Truncate(text string, maxTokens int) string {
	if maxTokens <= 0 {
		return ""
	}
	words := strings.Fields(text)
	if maxTokens < len(words) {
		words = words[:maxTokens]
	}
	return strings.Join(words, " ")
}

// Complete is the model's answer to prompt, at most maxTokens words.
func Complete(prompt string, maxTokens int, mode string) string {
	chunks := chunkLine.FindAllStringSubmatch(prompt, -1)
	var text string
	switch {
	case mode == "hallucinate":
		text = "Your issue will be resolved within 7 days, guaranteed [kb:policy-404]."
	case len(chunks) == 0:
		text = NoContextText
	default:
		cites := ""
		for i, c := range chunks {
			if i < 2 {
				cites += "[kb:" + c[1] + "]"
			}
		}
		text = "Based on " + cites + ": " + firstSentence(chunks[0][2])
		if mode == "verbose" {
			filler := make([]string, 40)
			for i := range filler {
				filler[i] = "Additionally, please note that this may vary by market and over time."
			}
			text += " " + strings.Join(filler, " ")
		}
	}
	return Truncate(text, maxTokens)
}

// Scores is the judge's verdict.
type Scores struct {
	Groundedness float64
	Coherence    float64
	Compliance   float64
	Pass         bool
}

// Evaluate is the judge's rubric: groundedness (citations within the context), coherence (length), compliance (no promises).
func Evaluate(question, answer string, contextIDs []string) Scores {
	allowed := map[string]bool{}
	for _, id := range contextIDs {
		allowed[id] = true
	}
	cited := cite.FindAllStringSubmatch(answer, -1)
	groundedness := 0.0
	if len(cited) > 0 {
		in := 0
		for _, c := range cited {
			if allowed[c[1]] {
				in++
			}
		}
		groundedness = math.Round(float64(in)/float64(len(cited))*1000) / 1000
	}
	coherence := 0.4
	if words := len(strings.Fields(answer)); words >= 3 && words <= 160 {
		coherence = 1
	}
	compliance := 1.0
	if risky.MatchString(answer) {
		compliance = 0
	}
	return Scores{
		Groundedness: groundedness,
		Coherence:    coherence,
		Compliance:   compliance,
		Pass:         groundedness >= 0.8 && coherence >= 0.8 && compliance >= 0.8,
	}
}
`,
  'assistant/db/db.go': `// Package db is the assistant's Postgres (with pgvector), through database/sql and lib/pq: Pool.ExecContext
// runs one statement (autocommit), Pool.QueryContext returns rows, Pool.BeginTx checks a connection out
// for a transaction (tx.Commit(), or tx.Rollback()). Statements use $1…$n placeholders. Schema is what
// the harness applies before a check.
//
// Tables:
//
//	kb_chunks      (id text primary key, article text, position int, text text, embedding vector(512))
//	quality_scores (session_id text, turn int, groundedness real, coherence real, compliance real, pass boolean,
//	                primary key (session_id, turn))
package db

import (
	"database/sql"

	_ "github.com/lib/pq"
)

// Pool is the assistant's connection pool.
var Pool = open()

func open() *sql.DB {
	pool, err := sql.Open("postgres", "postgres://assistant@db/assistant?sslmode=disable")
	if err != nil {
		panic(err)
	}
	return pool
}

// Schema creates the assistant's tables.
const Schema = \`
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE kb_chunks (
  id text PRIMARY KEY,
  article text NOT NULL,
  position int NOT NULL,
  text text NOT NULL,
  embedding vector(512) NOT NULL
);
CREATE TABLE quality_scores (
  session_id text NOT NULL,
  turn int NOT NULL,
  groundedness real NOT NULL,
  coherence real NOT NULL,
  compliance real NOT NULL,
  pass boolean NOT NULL,
  PRIMARY KEY (session_id, turn)
);
\`
`,
};

const articlesCpp = ARTICLES.map(
  a => `      {${JSON.stringify(a.id)}, ${JSON.stringify(a.title)}, ${JSON.stringify(a.body)}},`,
).join('\n');

/**
 * The C++ twins: the same `assistant` modules as headers (assistant/*.h), computing the same numbers
 * from the same text; the earlier steps' interfaces later steps call (kb_search.h, generate.h,
 * guardrail.h — declarations the harness stands in for); and digest.h (SHA-256).
 */
export const supportModulesCpp: Record<string, string> = {
  'assistant/config.h': `// The addresses, topics and limits every step of the assistant agrees on, as config::k… (also
// reachable as assistant::k…).
#pragma once

#include <chrono>

namespace config {

// The stand-in model server (served by the harness) at two addresses, and the LLM judge.
inline constexpr const char* kLlmLarge = "llm-large:50051";
inline constexpr const char* kLlmSmall = "llm-small:50051";
inline constexpr const char* kJudge = "judge:50051";

// Kafka: one record per answered turn, keyed by session; the offline judge's consumer group.
inline constexpr const char* kTopic = "support-conversations";
inline constexpr const char* kGroup = "quality-judge";

// Redis. The TTLs are in seconds.
inline constexpr int kHistoryTtlS = 86400;
inline constexpr int kCacheTtlS = 3600;
inline constexpr int kRateLimitPerMinute = 20;

// Retrieval and generation.
inline constexpr int kTopK = 4;
inline constexpr int kMaxTokens = 120;
inline constexpr std::chrono::milliseconds kDeadline{2000};
inline constexpr double kMinSimilarity = 0.3;
inline constexpr const char* kHandoffText = "I've passed this to a support agent, who will follow up with you shortly.";

}  // namespace config

namespace assistant {
using namespace config;
}
`,
  'assistant/chunk.h': `// Fixed-size word windows with overlap: the chunking every step and the harness agree on.
#pragma once

#include <algorithm>
#include <cctype>
#include <string>
#include <vector>

namespace assistant {

// A chunk is kChunkWords words; consecutive chunks share kOverlapWords of them.
inline constexpr int kChunkWords = 48;
inline constexpr int kOverlapWords = 12;

// text's windows of kChunkWords words, each starting kChunkWords - kOverlapWords after the previous; none for an empty text.
inline std::vector<std::string> chunk(const std::string& text) {
  std::vector<std::string> words;
  std::string word;
  for (unsigned char c : text) {
    if (std::isspace(c)) {
      if (!word.empty()) words.push_back(word);
      word.clear();
    } else {
      word += static_cast<char>(c);
    }
  }
  if (!word.empty()) words.push_back(word);
  std::vector<std::string> out;
  if (words.empty()) return out;
  for (size_t start = 0;; start += kChunkWords - kOverlapWords) {
    const size_t end = std::min(words.size(), start + kChunkWords);
    std::string piece;
    for (size_t i = start; i < end; i++) piece += (i == start ? "" : " ") + words[i];
    out.push_back(piece);
    if (start + kChunkWords >= words.size()) return out;
  }
}

}  // namespace assistant
`,
  'assistant/kb.h': `// The support knowledge base: ten short articles. Chunk ids are "<article>-<position>".
#pragma once

#include <optional>
#include <string>
#include <vector>

namespace assistant {

// One page of the knowledge base.
struct Article {
  std::string id;
  std::string title;
  std::string body;
};

// The whole knowledge base.
inline const std::vector<Article>& articles() {
  static const std::vector<Article> all = {
${articlesCpp}
  };
  return all;
}

// The article with this id, if there is one.
inline std::optional<Article> find_article(const std::string& id) {
  for (const auto& a : articles())
    if (a.id == id) return a;
  return std::nullopt;
}

}  // namespace assistant
`,
  'assistant/embed.h': `// Deterministic text embeddings for the course: a TF-IDF vector over the knowledge base's vocabulary
// (each word a dimension, weighted by how rare it is across the KB's chunks; words the KB never saw
// share a hashed band at the end), L2-normalised, 512 dimensions. Not a language model — a stand-in
// with the properties retrieval relies on: the same text always gives the same vector, texts sharing
// rare words land close together (cosine), and function words count for nothing. to_pgvector writes
// a vector the way pgvector reads it: "[0.100000,0.200000,...]". The same numbers as the Python,
// TypeScript and Go modules.
#pragma once

#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "assistant/chunk.h"
#include "assistant/kb.h"

namespace assistant {

// The length of every vector.
inline constexpr int kDim = 512;

// Stop words carry no topic; without them a question's vector points at its subject, as a real embedding's would.
inline const std::set<std::string>& stop_words() {
  static const std::set<std::string> words = [] {
    std::set<std::string> out;
    std::istringstream in(
        "a an and are as at be been but by can could did do does for from get got had has have he her his how i if in is it its me my "
        "no not of on or our she so that the their them they this to up us was we were what when where which who will with would you your");
    for (std::string w; in >> w;) out.insert(w);
    return out;
  }();
  return words;
}

// The text's lower-cased words ([a-z0-9]+), stop words left out.
inline std::vector<std::string> tokenize(const std::string& text) {
  std::vector<std::string> out;
  std::string word;
  const auto flush = [&] {
    if (!word.empty() && stop_words().count(word) == 0) out.push_back(word);
    word.clear();
  };
  for (unsigned char c : text) {
    const char lower = static_cast<char>(std::tolower(c));
    if ((lower >= 'a' && lower <= 'z') || (lower >= '0' && lower <= '9')) word += lower;
    else flush();
  }
  flush();
  return out;
}

inline int count_tokens(const std::string& text) { return static_cast<int>(tokenize(text).size()); }

namespace embedding {

// The vocabulary and document frequencies come from the KB's chunks, so every process computes the same vector.
struct Model {
  std::map<std::string, int> df;
  std::map<std::string, int> index;
  std::vector<std::string> vocab;
  int n = 0;
};

inline const Model& model() {
  static const Model m = [] {
    Model out;
    for (const auto& a : articles()) {
      for (const auto& text : chunk(a.body)) {
        out.n++;
        std::set<std::string> seen;
        for (const auto& w : tokenize(text))
          if (seen.insert(w).second) out.df[w]++;
      }
    }
    for (const auto& [w, count] : out.df) out.vocab.push_back(w);  // a std::map iterates sorted
    for (size_t i = 0; i < out.vocab.size(); i++) out.index[out.vocab[i]] = static_cast<int>(i);
    return out;
  }();
  return m;
}

inline uint32_t fnv1a(const std::string& s) {
  uint32_t h = 0x811c9dc5u;
  for (unsigned char b : s) {
    h ^= b;
    h *= 0x01000193u;
  }
  return h;
}

inline int slot(const std::string& w) {
  const Model& m = model();
  const auto it = m.index.find(w);
  if (it != m.index.end()) return it->second;
  return static_cast<int>(m.vocab.size()) + static_cast<int>(fnv1a(w) % static_cast<uint32_t>(kDim - m.vocab.size()));
}

}  // namespace embedding

// Every word of the KB's chunks, sorted: the first vocab().size() dimensions.
inline const std::vector<std::string>& vocab() { return embedding::model().vocab; }

// log(1 + N/df): a word in every chunk weighs little, a word in one weighs most; an unseen word most of all.
inline double idf(const std::string& w) {
  const auto& m = embedding::model();
  const auto it = m.df.find(w);
  const double d = it == m.df.end() ? 0.5 : it->second;
  return std::log(1 + m.n / d);
}

// The text's unit vector, each component rounded to 6 decimals (all zeros for a text of stop words).
inline std::vector<double> embed(const std::string& text) {
  std::vector<double> v(kDim, 0.0);
  for (const auto& tok : tokenize(text)) v[embedding::slot(tok)] += idf(tok);
  double norm = 0;
  for (double x : v) norm += x * x;
  norm = std::sqrt(norm);
  if (norm == 0) return v;
  for (double& x : v) x = std::round(x / norm * 1e6) / 1e6;
  return v;
}

// The cosine similarity of a and b, 0 when either is all zeros.
inline double cosine(const std::vector<double>& a, const std::vector<double>& b) {
  double dot = 0, na = 0, nb = 0;
  for (size_t i = 0; i < a.size() && i < b.size(); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na == 0 || nb == 0) return 0;
  return dot / (std::sqrt(na) * std::sqrt(nb));
}

// v as pgvector's text form, "[0.100000,0.200000,...]"; cast it with ::vector.
inline std::string to_pgvector(const std::vector<double>& v) {
  std::string out = "[";
  char buf[32];
  for (size_t i = 0; i < v.size(); i++) {
    std::snprintf(buf, sizeof buf, "%.6f", v[i]);
    if (i > 0) out += ',';
    out += buf;
  }
  return out + "]";
}

// pgvector's text form read back.
inline std::vector<double> from_pgvector(const std::string& s) {
  std::vector<double> out;
  std::string item;
  for (char c : s) {
    if (c == '[' || c == ']' || c == ' ') continue;
    if (c == ',') {
      if (!item.empty()) out.push_back(std::strtod(item.c_str(), nullptr));
      item.clear();
    } else {
      item += c;
    }
  }
  if (!item.empty()) out.push_back(std::strtod(item.c_str(), nullptr));
  return out;
}

}  // namespace assistant
`,
  'assistant/db.h': `// The assistant's Postgres (with pgvector), through libpqxx: assistant::db() (also db::connection())
// is the connection; pqxx::work tx(assistant::db()) a transaction, tx.commit() ends it. Statements
// use $1…$n placeholders. db::kSchema is what the harness applies before a check.
//
// Tables:
//
//   kb_chunks      (id text primary key, article text, position int, text text, embedding vector(512))
//   quality_scores (session_id text, turn int, groundedness real, coherence real, compliance real, pass boolean,
//                   primary key (session_id, turn))
#pragma once

#include <pqxx/pqxx>

#include <string>

namespace db {

// The assistant's connection.
inline pqxx::connection& connection() {
  static pqxx::connection conn{"postgresql://assistant@db/assistant"};
  return conn;
}

// The assistant's tables.
inline const std::string kSchema = R"(
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE kb_chunks (
  id text PRIMARY KEY,
  article text NOT NULL,
  position int NOT NULL,
  text text NOT NULL,
  embedding vector(512) NOT NULL
);
CREATE TABLE quality_scores (
  session_id text NOT NULL,
  turn int NOT NULL,
  groundedness real NOT NULL,
  coherence real NOT NULL,
  compliance real NOT NULL,
  pass boolean NOT NULL,
  PRIMARY KEY (session_id, turn)
);
)";

}  // namespace db

namespace assistant {

inline pqxx::connection& db() { return db::connection(); }

}  // namespace assistant
`,
  'assistant/prompt.h': `// The one prompt format: instructions, the retrieved chunks as "[kb:<id>] <text>" lines, the
// conversation so far, then the question. The stand-in model reads chunk ids from these lines, which
// is what lets a check tell a grounded answer from an invented one. Also reachable as assistant::….
#pragma once

#include <set>
#include <string>
#include <vector>

namespace prompt {

// A retrieved piece of the knowledge base: its id, its text and how close it was to the question.
struct Chunk {
  std::string id;
  std::string text;
  double score = 0;
  bool operator==(const Chunk&) const = default;
};

// One message of a conversation; role is "dasher" or "assistant".
struct Turn {
  std::string role;
  std::string text;
  bool operator==(const Turn&) const = default;
};

// Instructions open every prompt.
inline constexpr const char* kInstructions =
    "You are a Dasher support assistant. Answer only from the context below and cite the chunks you "
    "use as [kb:<id>]. If the context does not answer the question, say so.";

// The prompt for question, grounded in chunks, after history.
inline std::string build_prompt(const std::string& question, const std::vector<Chunk>& chunks, const std::vector<Turn>& history) {
  std::string out = std::string(kInstructions) + "\\n\\nContext:";
  for (const auto& c : chunks) out += "\\n[kb:" + c.id + "] " + c.text;
  out += "\\n\\nHistory:";
  for (const auto& t : history) out += "\\n" + t.role + ": " + t.text;
  return out + "\\n\\nQuestion: " + question + "\\nAnswer:";
}

// The chunk ids an answer cites as [kb:<id>], in order, without duplicates.
inline std::vector<std::string> cited_ids(const std::string& answer) {
  std::vector<std::string> out;
  std::set<std::string> seen;
  size_t at = 0;
  while ((at = answer.find("[kb:", at)) != std::string::npos) {
    const size_t start = at + 4;
    const size_t end = answer.find(']', start);
    if (end == std::string::npos) break;
    if (end == start) {
      at = start;
      continue;
    }
    const std::string id = answer.substr(start, end - start);
    if (seen.insert(id).second) out.push_back(id);
    at = end + 1;
  }
  return out;
}

}  // namespace prompt

namespace assistant {
using namespace prompt;
}
`,
  'assistant/model.h': `// The stand-in for the model server and the LLM judge. The harness serves these over gRPC (Llm at
// llm-large:50051 / llm-small:50051, Judge at judge:50051); the learner's code never calls them
// directly. Deterministic on purpose: the course grades what the system around a model does —
// grounds it, bounds it, times it out, judges it, escalates — never the prose.
//
// complete(prompt, max_tokens, mode):
//   "faithful"     cites the first two context chunks and answers with the first sentence of the top one
//   "hallucinate"  invents a policy and cites a chunk that was never retrieved ([kb:policy-404])
//   "verbose"      the faithful answer followed by filler, so max_tokens has to cut it
// With no context chunks in the prompt the model says the documentation does not cover it (no citation).
#pragma once

#include <cctype>
#include <cmath>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace model {

// The answer to a prompt without context chunks.
inline constexpr const char* kNoContextText = "The documentation available to me does not cover this; a support agent can help.";

inline std::vector<std::string> fields(const std::string& text) {
  std::istringstream in(text);
  std::vector<std::string> out;
  for (std::string w; in >> w;) out.push_back(w);
  return out;
}

inline std::string trim(const std::string& s) {
  const size_t start = s.find_first_not_of(" \\t\\r\\n\\v\\f");
  if (start == std::string::npos) return "";
  return s.substr(start, s.find_last_not_of(" \\t\\r\\n\\v\\f") - start + 1);
}

// The prompt's context lines, "[kb:<id>] <text>", as (id, text).
inline std::vector<std::pair<std::string, std::string>> context_chunks(const std::string& prompt) {
  std::vector<std::pair<std::string, std::string>> out;
  std::istringstream in(prompt);
  for (std::string line; std::getline(in, line);) {
    if (line.rfind("[kb:", 0) != 0) continue;
    const size_t end = line.find(']', 4);
    if (end == std::string::npos || end == 4) continue;
    size_t text = end + 1;
    while (text < line.size() && std::isspace(static_cast<unsigned char>(line[text]))) text++;
    out.emplace_back(line.substr(4, end - 4), line.substr(text));
  }
  return out;
}

inline std::string first_sentence(const std::string& text) {
  const size_t end = text.find_first_of(".!?");
  return trim(end == std::string::npos ? text : text.substr(0, end + 1));
}

// The text as the model streams it: words, each but the last carrying its trailing space.
inline std::vector<std::string> tokens(const std::string& text) {
  auto words = fields(text);
  for (size_t i = 0; i + 1 < words.size(); i++) words[i] += " ";
  return words;
}

// The first max_tokens words of text.
inline std::string truncate(const std::string& text, int max_tokens) {
  if (max_tokens <= 0) return "";
  const auto words = fields(text);
  std::string out;
  for (size_t i = 0; i < words.size() && i < static_cast<size_t>(max_tokens); i++) out += (i == 0 ? "" : " ") + words[i];
  return out;
}

// The model's answer to prompt, at most max_tokens words.
inline std::string complete(const std::string& prompt, int max_tokens, const std::string& mode) {
  const auto chunks = context_chunks(prompt);
  std::string text;
  if (mode == "hallucinate") {
    text = "Your issue will be resolved within 7 days, guaranteed [kb:policy-404].";
  } else if (chunks.empty()) {
    text = kNoContextText;
  } else {
    std::string cites;
    for (size_t i = 0; i < chunks.size() && i < 2; i++) cites += "[kb:" + chunks[i].first + "]";
    text = "Based on " + cites + ": " + first_sentence(chunks[0].second);
    if (mode == "verbose")
      for (int i = 0; i < 40; i++) text += " Additionally, please note that this may vary by market and over time.";
  }
  return truncate(text, max_tokens);
}

// The judge's verdict.
struct Scores {
  double groundedness;
  double coherence;
  double compliance;
  bool pass;
};

// The judge's rubric: groundedness (citations within the context), coherence (length), compliance (no promises).
inline Scores evaluate(const std::string& question, const std::string& answer, const std::vector<std::string>& context_ids) {
  (void)question;
  const std::set<std::string> allowed(context_ids.begin(), context_ids.end());
  int cited = 0, in = 0;
  for (size_t at = 0; (at = answer.find("[kb:", at)) != std::string::npos;) {
    const size_t end = answer.find(']', at + 4);
    if (end == std::string::npos) break;
    if (end == at + 4) {
      at += 4;
      continue;
    }
    cited++;
    if (allowed.count(answer.substr(at + 4, end - at - 4))) in++;
    at = end + 1;
  }
  const double groundedness = cited > 0 ? std::round(static_cast<double>(in) / cited * 1000) / 1000 : 0.0;
  const size_t words = fields(answer).size();
  const double coherence = words >= 3 && words <= 160 ? 1.0 : 0.4;
  std::string lower;
  for (unsigned char c : answer) lower += static_cast<char>(std::tolower(c));
  bool risky = false;
  for (const char* w : {"guarantee", "promise", "lawsuit", "legal action"}) risky = risky || lower.find(w) != std::string::npos;
  const double compliance = risky ? 0.0 : 1.0;
  return Scores{groundedness, coherence, compliance, groundedness >= 0.8 && coherence >= 0.8 && compliance >= 0.8};
}

}  // namespace model
`,
  'kb_search.h': `// Step 2's knowledge base as later steps call it: the nearest chunks and the answer cache.
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "assistant/config.h"
#include "assistant/prompt.h"

// A retrieved chunk: id, text and score (1 - cosine distance).
using Hit = prompt::Chunk;

// A remembered answer and the chunk ids it cites.
struct CachedAnswer {
  std::string answer;
  std::vector<std::string> sources;
};

// The k chunks nearest to the question, best first.
std::vector<Hit> search(const std::string& question, int k = config::kTopK);

// The {answer, sources} remembered for this question, or nullopt.
std::optional<CachedAnswer> cached_answer(const std::string& question);

// Remember the answer under the normalised question, for config::kCacheTtlS.
void remember_answer(const std::string& question, const std::string& answer, const std::vector<std::string>& sources);
`,
  'generate.h': `// Step 3's model call as later steps call it: the answer, which model gave it and its token count.
#pragma once

#include <string>
#include <vector>

#include "assistant/prompt.h"

struct Generated {
  std::string answer;
  std::string model;
  int tokens;
};

// The model's answer: the large model with a deadline and one retry, then the small one.
Generated generate(const std::string& question, const std::vector<prompt::Chunk>& chunks, const std::vector<prompt::Turn>& history);
`,
  'guardrail.h': `// Step 4's guardrail as later steps call it: tier 1, the judge, and the answer or the handoff.
#pragma once

#include <string>
#include <vector>

#include "assistant/prompt.h"

// What check returns: tier 1's reasons, or the judge's.
struct Verdict {
  bool ok;
  double groundedness;
  std::vector<std::string> reasons;
};

// What the Dasher may see: the answer or the handoff.
struct Outcome {
  std::string answer;
  std::vector<std::string> sources;
  bool escalated;
  std::string model;
  int tokens;
};

// Why the answer fails the cheap checks (empty when it passes).
std::vector<std::string> tier1(const std::string& answer, const std::vector<prompt::Chunk>& chunks);

// Tier 1 without an RPC, then the judge.
Verdict check(const std::string& question, const std::string& answer, const std::vector<prompt::Chunk>& chunks);

// The answer the Dasher may see: generated, checked, generated once more on failure, then the handoff.
Outcome answer_or_escalate(const std::string& question, const std::vector<prompt::Chunk>& chunks, const std::vector<prompt::Turn>& history);
`,
  'digest.h': CPP_DIGEST_H,
};
