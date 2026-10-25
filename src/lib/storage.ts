/**
 * Durable state for /leetbuild: one record per workspace (the learner's code for one step in one
 * language), one scratchpad per course (the sketch), and one progress record (attempts per step,
 * chosen language, submission counters, last position).
 *
 * IndexedDB is the primary backend; localStorage is the fallback where IndexedDB is unavailable
 * (some private modes). Writes are debounced per record so typing does not hammer the database.
 * A page going away flushes them, stashing them first in localStorage, which writes synchronously:
 * an IndexedDB transaction may not outlive the page, and the next load applies the stash.
 */
import {type StepAttempt, type Submission, HISTORY_LENGTH} from './scoring';
import {type Scratchpad, normalizeShapes} from './scratchpad';
import {type ActiveTimer, type TimedSession, SESSION_HISTORY} from './timer';
import {type Language, ALL_LANGUAGES, LANGUAGES} from './types';

export interface Workspace {
  code: string;
  updatedAt: number;
}

export interface Progress {
  /** Keyed by `problemId/stepId` (see `stepKey`). */
  attempts: Record<string, StepAttempt>;
  language: Language;
  /** Step last open per problem id; `/<problem>` reopens it. */
  lastStep: Record<string, string>;
  submissions: number;
  acceptedSubmissions: number;
  /** Local calendar days (`YYYY-MM-DD`) on which a step was accepted; feeds the streak. */
  activeDays: string[];
  /** Badge id → time earned. Never revoked, even if the attempts behind it are reset. */
  badges: Record<string, number>;
  /** The timed run in progress, if any (one at a time); survives reloads. */
  timer: ActiveTimer | null;
  /** Finished timed runs, oldest first. */
  sessions: TimedSession[];
  /** The name typed on a certificate, offered again next time. */
  name: string;
}

export interface Snapshot {
  progress: Progress;
  /** Keyed by `problemId/stepId/language`. */
  workspaces: Record<string, Workspace>;
  /** Keyed by problem id (`general` for the landing page's). */
  scratchpads: Record<string, Scratchpad>;
}

interface Backend {
  readAll(): Promise<Snapshot>;
  writeWorkspace(id: string, state: Workspace): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
  writeProgress(progress: Progress): Promise<void>;
  writeScratchpad(id: string, pad: Scratchpad): Promise<void>;
}

// Storage keys are stable identifiers, not branding: renaming them would orphan existing progress.
const DB_NAME = 'leetbuild';
// 2: the `scratchpads` store.
const DB_VERSION = 2;
const WORKSPACES = 'workspaces';
const PROGRESS = 'progress';
const SCRATCHPADS = 'scratchpads';
const FALLBACK_KEY = 'leetbuild:snapshot';
/** Writes a page left pending as it went away (see `ProgressStore.flush`). */
const STASH_KEY = 'leetbuild:pending';
const WRITE_DELAY_MS = 400;
const OPEN_TIMEOUT_MS = 4000;

export const EMPTY_PROGRESS: Progress = {
  attempts: {},
  language: 'python',
  lastStep: {},
  submissions: 0,
  acceptedSubmissions: 0,
  activeDays: [],
  badges: {},
  timer: null,
  sessions: [],
  name: '',
};

export function workspaceKey(problemId: string, stepId: string, language: Language): string {
  return `${problemId}/${stepId}/${language}`;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  const {promise, resolve, reject} = Promise.withResolvers<T>();
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  return promise;
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  const {promise, resolve, reject} = Promise.withResolvers<void>();
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  return promise;
}

class IdbBackend implements Backend {
  constructor(private readonly db: IDBDatabase) {}

  static open(): Promise<IdbBackend> {
    const {promise, resolve, reject} = Promise.withResolvers<IdbBackend>();
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WORKSPACES)) db.createObjectStore(WORKSPACES);
      if (!db.objectStoreNames.contains(PROGRESS)) db.createObjectStore(PROGRESS);
      if (!db.objectStoreNames.contains(SCRATCHPADS)) db.createObjectStore(SCRATCHPADS);
    };
    req.onsuccess = () => resolve(new IdbBackend(req.result));
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    return promise;
  }

  async readAll(): Promise<Snapshot> {
    const tx = this.db.transaction([WORKSPACES, PROGRESS, SCRATCHPADS], 'readonly');
    const store = tx.objectStore(WORKSPACES);
    const pads = tx.objectStore(SCRATCHPADS);
    const [keys, values, progress, padKeys, padValues] = await Promise.all([
      request(store.getAllKeys()),
      request(store.getAll()),
      request(tx.objectStore(PROGRESS).get('progress')),
      request(pads.getAllKeys()),
      request(pads.getAll()),
    ]);
    const raw: Record<string, unknown> = {};
    keys.forEach((key, i) => {
      raw[String(key)] = values[i];
    });
    const scratchpads: Record<string, Scratchpad> = {};
    padKeys.forEach((key, i) => {
      scratchpads[String(key)] = normalizeScratchpad(padValues[i]);
    });
    return {progress: normalizeProgress(progress), workspaces: normalizeWorkspaces(raw), scratchpads};
  }

  async writeWorkspace(id: string, state: Workspace): Promise<void> {
    const tx = this.db.transaction(WORKSPACES, 'readwrite');
    tx.objectStore(WORKSPACES).put(state, id);
    await transactionDone(tx);
  }

  async deleteWorkspace(id: string): Promise<void> {
    const tx = this.db.transaction(WORKSPACES, 'readwrite');
    tx.objectStore(WORKSPACES).delete(id);
    await transactionDone(tx);
  }

  async writeProgress(progress: Progress): Promise<void> {
    const tx = this.db.transaction(PROGRESS, 'readwrite');
    tx.objectStore(PROGRESS).put(progress, 'progress');
    await transactionDone(tx);
  }

  async writeScratchpad(id: string, pad: Scratchpad): Promise<void> {
    const tx = this.db.transaction(SCRATCHPADS, 'readwrite');
    tx.objectStore(SCRATCHPADS).put(pad, id);
    await transactionDone(tx);
  }
}

/** Whole snapshot as one JSON value; only used when IndexedDB cannot be opened. */
class LocalStorageBackend implements Backend {
  private snapshot: Snapshot = {progress: {...EMPTY_PROGRESS}, workspaces: {}, scratchpads: {}};

  async readAll(): Promise<Snapshot> {
    try {
      const raw = window.localStorage.getItem(FALLBACK_KEY);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as Partial<Snapshot>;
        const scratchpads: Record<string, Scratchpad> = {};
        for (const [id, pad] of Object.entries(parsed.scratchpads ?? {})) scratchpads[id] = normalizeScratchpad(pad);
        this.snapshot = {
          progress: normalizeProgress(parsed.progress),
          workspaces: normalizeWorkspaces(parsed.workspaces),
          scratchpads,
        };
      }
    } catch {
      // unreadable or unavailable: start empty
    }
    return {
      progress: {...this.snapshot.progress},
      workspaces: {...this.snapshot.workspaces},
      scratchpads: {...this.snapshot.scratchpads},
    };
  }

  async writeWorkspace(id: string, state: Workspace): Promise<void> {
    this.snapshot.workspaces[id] = state;
    this.persist();
  }

  async deleteWorkspace(id: string): Promise<void> {
    delete this.snapshot.workspaces[id];
    this.persist();
  }

  async writeProgress(progress: Progress): Promise<void> {
    this.snapshot.progress = progress;
    this.persist();
  }

  async writeScratchpad(id: string, pad: Scratchpad): Promise<void> {
    this.snapshot.scratchpads[id] = pad;
    this.persist();
  }

  private persist(): void {
    try {
      window.localStorage.setItem(FALLBACK_KEY, JSON.stringify(this.snapshot));
    } catch {
      // quota exceeded or storage disabled: keep going in memory
    }
  }
}

/** A language a record may carry (a CUDA step's attempt included). */
const isLanguage = (v: unknown): v is Language => typeof v === 'string' && ALL_LANGUAGES.includes(v as Language);
/** A language the learner can pick in the header — the stored preference is always one of these. */
const isSelectable = (v: unknown): v is Language => typeof v === 'string' && LANGUAGES.includes(v as Language);

const normalizeScratchpad = (value: unknown): Scratchpad => {
  const pad = typeof value === 'object' && value !== null ? (value as Partial<Scratchpad>) : {};
  return {shapes: normalizeShapes(pad.shapes), updatedAt: typeof pad.updatedAt === 'number' ? pad.updatedAt : 0};
};

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Stored workspaces are cast into the editor, so a malformed record is dropped (the step falls back to its starter). */
const normalizeWorkspaces = (value: unknown): Record<string, Workspace> => {
  if (typeof value !== 'object' || value === null) return {};
  const workspaces: Record<string, Workspace> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'object' || item === null) continue;
    const w = item as Partial<Workspace>;
    if (typeof w.code !== 'string' || typeof w.updatedAt !== 'number' || !Number.isFinite(w.updatedAt)) continue;
    workspaces[key] = {code: w.code, updatedAt: w.updatedAt};
  }
  return workspaces;
};

const normalizeHistory = (value: unknown): Submission[] => {
  if (!Array.isArray(value)) return [];
  const history: Submission[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const s = item as Partial<Submission>;
    if (typeof s.at !== 'number' || !isLanguage(s.language) || !isCount(s.passed) || !isCount(s.total)) continue;
    const submission: Submission = {
      at: s.at,
      language: s.language,
      passed: s.passed,
      total: s.total,
      accepted: s.accepted === true,
    };
    if (typeof s.code === 'string') submission.code = s.code;
    history.push(submission);
  }
  return history.slice(-HISTORY_LENGTH);
};

/**
 * Attempts are read straight into scoring and the submissions list, so a record from an older
 * schema or a partial write is repaired here: a missing `hints`/`wrong` would score NaN, and a
 * non-array `history` would throw while rendering.
 */
const normalizeAttempts = (value: unknown): Record<string, StepAttempt> => {
  if (typeof value !== 'object' || value === null) return {};
  const attempts: Record<string, StepAttempt> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'object' || item === null) continue;
    const a = item as Partial<StepAttempt>;
    attempts[key] = {
      status: a.status === 'accepted' || a.status === 'revealed' ? a.status : 'open',
      hints: isCount(a.hints) ? Math.floor(a.hints) : 0,
      wrong: isCount(a.wrong) ? Math.floor(a.wrong) : 0,
      language: isLanguage(a.language) ? a.language : null,
      solvedAt: typeof a.solvedAt === 'number' && Number.isFinite(a.solvedAt) ? a.solvedAt : null,
      history: normalizeHistory(a.history),
    };
  }
  return attempts;
};

const normalizeTimer = (value: unknown): ActiveTimer | null => {
  if (typeof value !== 'object' || value === null) return null;
  const t = value as Partial<ActiveTimer>;
  if (typeof t.problemId !== 'string' || typeof t.startedAt !== 'number' || typeof t.budget !== 'number') return null;
  return {
    problemId: t.problemId,
    startedAt: t.startedAt,
    budget: t.budget,
    overtime: t.overtime === true,
    language: isLanguage(t.language) ? t.language : 'python',
  };
};

const normalizeSessions = (value: unknown): TimedSession[] => {
  if (!Array.isArray(value)) return [];
  const sessions: TimedSession[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const s = item as Partial<TimedSession>;
    if (typeof s.problemId !== 'string' || typeof s.startedAt !== 'number' || typeof s.elapsed !== 'number') continue;
    sessions.push({
      problemId: s.problemId,
      startedAt: s.startedAt,
      budget: typeof s.budget === 'number' ? s.budget : 0,
      elapsed: s.elapsed,
      accepted: typeof s.accepted === 'number' ? s.accepted : 0,
      revealed: typeof s.revealed === 'number' ? s.revealed : 0,
      total: typeof s.total === 'number' ? s.total : 0,
      language: isLanguage(s.language) ? s.language : 'python',
      outcome: s.outcome === 'completed' || s.outcome === 'expired' ? s.outcome : 'ended',
      counted: s.counted === true,
    });
  }
  return sessions.slice(-SESSION_HISTORY);
};

function normalizeProgress(value: unknown): Progress {
  if (typeof value !== 'object' || value === null)
    return {...EMPTY_PROGRESS, attempts: {}, lastStep: {}, activeDays: [], badges: {}, sessions: []};
  const p = value as Partial<Progress>;
  return {
    attempts: normalizeAttempts(p.attempts),
    language: isSelectable(p.language) ? p.language : 'python',
    lastStep: typeof p.lastStep === 'object' && p.lastStep !== null ? p.lastStep : {},
    submissions: typeof p.submissions === 'number' ? p.submissions : 0,
    acceptedSubmissions: typeof p.acceptedSubmissions === 'number' ? p.acceptedSubmissions : 0,
    activeDays: Array.isArray(p.activeDays) ? p.activeDays.filter((d): d is string => typeof d === 'string') : [],
    badges: typeof p.badges === 'object' && p.badges !== null ? p.badges : {},
    timer: normalizeTimer(p.timer),
    sessions: normalizeSessions(p.sessions),
    name: typeof p.name === 'string' ? p.name : '',
  };
}

/**
 * The stash: records by key (`workspace:<id>`, `progress`, `scratchpad:<id>`; null for a deleted
 * workspace) that a page going away had not yet written. Each leaves it once the database has it.
 */
const readStash = (raw: string | null): Record<string, unknown> => {
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const stashGet = (): Record<string, unknown> => {
  try {
    return readStash(window.localStorage.getItem(STASH_KEY));
  } catch {
    return {};
  }
};

const stashPut = (records: Record<string, unknown>): void => {
  try {
    if (Object.keys(records).length === 0) window.localStorage.removeItem(STASH_KEY);
    else window.localStorage.setItem(STASH_KEY, JSON.stringify(records));
  } catch {
    // storage full or disabled: the IndexedDB write is all there is
  }
};

/** Drop `key` from the stash: the database has the record now (or a newer one). */
const unstash = (key: string): void => {
  try {
    const raw = window.localStorage.getItem(STASH_KEY);
    if (raw === null) return;
    const records = readStash(raw);
    if (!(key in records)) return;
    delete records[key];
    stashPut(records);
  } catch {
    // storage disabled: nothing was stashed
  }
};

export class ProgressStore {
  private backend: Promise<Backend>;
  private loading: Promise<Snapshot> | null = null;
  /** The snapshot `load()` resolved with; saves update it so a remount sees the latest state. */
  private snapshot: Snapshot | null = null;
  /** Writes waiting out the debounce, by record key, with the record each writes (null: a deletion). */
  private readonly pending = new Map<string, {timer: number; run: () => Promise<void>; value: unknown}>();
  /** Writes started and not yet confirmed by the database, by record key. */
  private readonly inflight = new Map<string, {value: unknown}>();

  constructor() {
    this.backend =
      typeof indexedDB === 'undefined'
        ? Promise.resolve(new LocalStorageBackend())
        : ProgressStore.openIdb().catch(() => new LocalStorageBackend());
    if (typeof window !== 'undefined') {
      // The page may be going away: what is pending is stashed as well as written (see `flush`).
      window.addEventListener('pagehide', () => void this.flush(true));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void this.flush(true);
      });
    }
  }

  /**
   * An `open` can hang indefinitely (a pending deleteDatabase, a version change held by another
   * tab); the page must not sit on "restoring your progress…" for that, so the open is raced
   * against a timeout and loses to the localStorage fallback.
   */
  private static openIdb(): Promise<Backend> {
    return new Promise<Backend>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('IndexedDB open timed out')), OPEN_TIMEOUT_MS);
      IdbBackend.open().then(
        backend => {
          window.clearTimeout(timer);
          resolve(backend);
        },
        error => {
          window.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * Read everything once; concurrent callers (strict-mode double mounts) share the read, and later
   * callers (client-side navigation back to the page) get the snapshot including every save. What
   * a page stashed as it went away is applied over it, and written through.
   */
  load(): Promise<Snapshot> {
    if (this.loading === null) {
      this.loading = this.backend
        .then(b => b.readAll())
        .then(snapshot => {
          this.snapshot = snapshot;
          this.restoreStash(snapshot);
          return snapshot;
        });
    }
    return this.loading;
  }

  saveWorkspace(id: string, state: Workspace): void {
    if (this.snapshot !== null) this.snapshot.workspaces[id] = state;
    this.schedule(`workspace:${id}`, state, async () => (await this.backend).writeWorkspace(id, state));
  }

  /** Forget a saved workspace so the step reopens with its starter. */
  deleteWorkspace(id: string): void {
    if (this.snapshot !== null) delete this.snapshot.workspaces[id];
    this.schedule(`workspace:${id}`, null, async () => (await this.backend).deleteWorkspace(id));
  }

  saveProgress(progress: Progress): void {
    if (this.snapshot !== null) this.snapshot.progress = progress;
    this.schedule('progress', progress, async () => (await this.backend).writeProgress(progress));
  }

  saveScratchpad(id: string, pad: Scratchpad): void {
    if (this.snapshot !== null) this.snapshot.scratchpads[id] = pad;
    this.schedule(`scratchpad:${id}`, pad, async () => (await this.backend).writeScratchpad(id, pad));
  }

  /**
   * Run every pending write now. A page going away cannot count on them, nor on the writes already
   * running: an IndexedDB transaction still open when the page unloads is aborted. With `stash`,
   * the records of both are first kept in localStorage, which writes synchronously; the next load
   * applies them.
   */
  async flush(stash = false): Promise<void> {
    const runs = Array.from(this.pending);
    for (const [, p] of runs) window.clearTimeout(p.timer);
    this.pending.clear();
    if (stash && runs.length + this.inflight.size > 0) {
      const running = Array.from(this.inflight, ([key, write]) => [key, write.value]);
      const waiting = runs.map(([key, p]) => [key, p.value]);
      stashPut({...stashGet(), ...Object.fromEntries(running), ...Object.fromEntries(waiting)});
    }
    await Promise.all(runs.map(([key, p]) => this.write(key, p.value, p.run)));
  }

  private schedule(key: string, value: unknown, run: () => Promise<void>): void {
    const existing = this.pending.get(key);
    if (existing !== undefined) window.clearTimeout(existing.timer);
    const timer = window.setTimeout(() => {
      this.pending.delete(key);
      void this.write(key, value, run);
    }, WRITE_DELAY_MS);
    this.pending.set(key, {timer, run, value});
  }

  /**
   * One write, in flight until the database has it; then a stashed copy of the record is obsolete,
   * unless a newer write of it has started since (the stash may hold that one).
   */
  private async write(key: string, value: unknown, run: () => Promise<void>): Promise<void> {
    const write = {value};
    this.inflight.set(key, write);
    try {
      await run();
      if (this.inflight.get(key) !== write) return;
      this.inflight.delete(key);
      unstash(key);
    } catch {
      // kept in memory, and in the stash if it was stashed
      if (this.inflight.get(key) === write) this.inflight.delete(key);
    }
  }

  /**
   * Apply what a page stashed as it went away, and write it through. A workspace or scratchpad is
   * applied unless the database holds a newer one (another tab saved since); progress has no time,
   * but any tab's write of it clears the stashed copy.
   */
  private restoreStash(snapshot: Snapshot): void {
    for (const [key, value] of Object.entries(stashGet())) {
      if (key === 'progress') {
        this.saveProgress(normalizeProgress(value));
      } else if (key.startsWith('workspace:')) {
        const id = key.slice('workspace:'.length);
        const state = value === null ? null : normalizeWorkspaces({[id]: value})[id];
        const current = snapshot.workspaces[id];
        if (state === null) this.deleteWorkspace(id);
        else if (state !== undefined && (current === undefined || state.updatedAt >= current.updatedAt)) {
          this.saveWorkspace(id, state);
        } else unstash(key);
      } else if (key.startsWith('scratchpad:')) {
        const id = key.slice('scratchpad:'.length);
        const pad = normalizeScratchpad(value);
        const current = snapshot.scratchpads[id];
        if (current === undefined || pad.updatedAt >= current.updatedAt) this.saveScratchpad(id, pad);
        else unstash(key);
      } else unstash(key);
    }
  }
}

let singleton: ProgressStore | null = null;

export function getProgressStore(): ProgressStore {
  if (singleton === null) singleton = new ProgressStore();
  return singleton;
}
