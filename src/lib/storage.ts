/**
 * Durable state for /leetbuild: one record per workspace (the learner's code for one step in one
 * language) and one progress record (attempts per step, chosen language, submission counters,
 * last position).
 *
 * IndexedDB is the primary backend; localStorage is the fallback where IndexedDB is unavailable
 * (some private modes). Writes are debounced per record so typing does not hammer the database,
 * and `flush()` runs on page hide so the last edits survive navigation.
 */
import type {StepAttempt} from './scoring';
import {type Language, LANGUAGES} from './types';

export interface Workspace {
  code: string;
  updatedAt: number;
}

export interface Progress {
  /** Keyed by `problemId/stepId` (see `stepKey`). */
  attempts: Record<string, StepAttempt>;
  language: Language;
  /** Problem to reopen on the next visit; null shows the problem list. */
  lastProblem: string | null;
  /** Step last open per problem id. */
  lastStep: Record<string, string>;
  submissions: number;
  acceptedSubmissions: number;
  /** Local calendar days (`YYYY-MM-DD`) on which a step was accepted; feeds the streak. */
  activeDays: string[];
  /** Badge id → time earned. Never revoked, even if the attempts behind it are reset. */
  badges: Record<string, number>;
}

export interface Snapshot {
  progress: Progress;
  /** Keyed by `problemId/stepId/language`. */
  workspaces: Record<string, Workspace>;
}

interface Backend {
  readAll(): Promise<Snapshot>;
  writeWorkspace(id: string, state: Workspace): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
  writeProgress(progress: Progress): Promise<void>;
}

// Storage keys are stable identifiers, not branding: renaming them would orphan existing progress.
const DB_NAME = 'leetbuild';
const DB_VERSION = 1;
const WORKSPACES = 'workspaces';
const PROGRESS = 'progress';
const FALLBACK_KEY = 'leetbuild:snapshot';
const WRITE_DELAY_MS = 400;
const OPEN_TIMEOUT_MS = 4000;

export const EMPTY_PROGRESS: Progress = {
  attempts: {},
  language: 'python',
  lastProblem: null,
  lastStep: {},
  submissions: 0,
  acceptedSubmissions: 0,
  activeDays: [],
  badges: {},
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
    };
    req.onsuccess = () => resolve(new IdbBackend(req.result));
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    return promise;
  }

  async readAll(): Promise<Snapshot> {
    const tx = this.db.transaction([WORKSPACES, PROGRESS], 'readonly');
    const store = tx.objectStore(WORKSPACES);
    const [keys, values, progress] = await Promise.all([
      request(store.getAllKeys()),
      request(store.getAll()),
      request(tx.objectStore(PROGRESS).get('progress')),
    ]);
    const workspaces: Record<string, Workspace> = {};
    keys.forEach((key, i) => {
      workspaces[String(key)] = values[i] as Workspace;
    });
    return {progress: normalizeProgress(progress), workspaces};
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
}

/** Whole snapshot as one JSON value; only used when IndexedDB cannot be opened. */
class LocalStorageBackend implements Backend {
  private snapshot: Snapshot = {progress: {...EMPTY_PROGRESS}, workspaces: {}};

  async readAll(): Promise<Snapshot> {
    try {
      const raw = window.localStorage.getItem(FALLBACK_KEY);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as Partial<Snapshot>;
        this.snapshot = {progress: normalizeProgress(parsed.progress), workspaces: parsed.workspaces ?? {}};
      }
    } catch {
      // unreadable or unavailable: start empty
    }
    return {progress: {...this.snapshot.progress}, workspaces: {...this.snapshot.workspaces}};
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

  private persist(): void {
    try {
      window.localStorage.setItem(FALLBACK_KEY, JSON.stringify(this.snapshot));
    } catch {
      // quota exceeded or storage disabled: keep going in memory
    }
  }
}

function normalizeProgress(value: unknown): Progress {
  if (typeof value !== 'object' || value === null)
    return {...EMPTY_PROGRESS, attempts: {}, lastStep: {}, activeDays: [], badges: {}};
  const p = value as Partial<Progress>;
  return {
    attempts: typeof p.attempts === 'object' && p.attempts !== null ? p.attempts : {},
    language: typeof p.language === 'string' && LANGUAGES.includes(p.language) ? p.language : 'python',
    lastProblem: typeof p.lastProblem === 'string' ? p.lastProblem : null,
    lastStep: typeof p.lastStep === 'object' && p.lastStep !== null ? p.lastStep : {},
    submissions: typeof p.submissions === 'number' ? p.submissions : 0,
    acceptedSubmissions: typeof p.acceptedSubmissions === 'number' ? p.acceptedSubmissions : 0,
    activeDays: Array.isArray(p.activeDays) ? p.activeDays.filter((d): d is string => typeof d === 'string') : [],
    badges: typeof p.badges === 'object' && p.badges !== null ? p.badges : {},
  };
}

export class ProgressStore {
  private backend: Promise<Backend>;
  private loading: Promise<Snapshot> | null = null;
  /** The snapshot `load()` resolved with; saves update it so a remount sees the latest state. */
  private snapshot: Snapshot | null = null;
  private readonly pending = new Map<string, {timer: number; run: () => Promise<void>}>();

  constructor() {
    this.backend =
      typeof indexedDB === 'undefined'
        ? Promise.resolve(new LocalStorageBackend())
        : ProgressStore.openIdb().catch(() => new LocalStorageBackend());
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => void this.flush());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void this.flush();
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
   * callers (client-side navigation back to the page) get the snapshot including every save.
   */
  load(): Promise<Snapshot> {
    if (this.loading === null) {
      this.loading = this.backend
        .then(b => b.readAll())
        .then(snapshot => {
          this.snapshot = snapshot;
          return snapshot;
        });
    }
    return this.loading;
  }

  saveWorkspace(id: string, state: Workspace): void {
    if (this.snapshot !== null) this.snapshot.workspaces[id] = state;
    this.schedule(`workspace:${id}`, async () => (await this.backend).writeWorkspace(id, state));
  }

  /** Forget a saved workspace so the step reopens with its starter. */
  deleteWorkspace(id: string): void {
    if (this.snapshot !== null) delete this.snapshot.workspaces[id];
    this.schedule(`workspace:${id}`, async () => (await this.backend).deleteWorkspace(id));
  }

  saveProgress(progress: Progress): void {
    if (this.snapshot !== null) this.snapshot.progress = progress;
    this.schedule('progress', async () => (await this.backend).writeProgress(progress));
  }

  /** Run every pending write now. */
  async flush(): Promise<void> {
    const runs = Array.from(this.pending.values());
    for (const p of runs) window.clearTimeout(p.timer);
    this.pending.clear();
    await Promise.all(runs.map(p => p.run().catch(() => undefined)));
  }

  private schedule(key: string, run: () => Promise<void>): void {
    const existing = this.pending.get(key);
    if (existing !== undefined) window.clearTimeout(existing.timer);
    const timer = window.setTimeout(() => {
      this.pending.delete(key);
      void run().catch(() => undefined);
    }, WRITE_DELAY_MS);
    this.pending.set(key, {timer, run});
  }
}

let singleton: ProgressStore | null = null;

export function getProgressStore(): ProgressStore {
  if (singleton === null) singleton = new ProgressStore();
  return singleton;
}
