/**
 * In-memory Kafka for the TypeScript runtime, behind a kafkajs-shaped client: topics with
 * partitions, key hashing, consumer groups with committed offsets, delivery acknowledgements that
 * can stall, be lost or vanish in a failover, and auto-commit on a background timer — the same
 * BROKER semantics the Python runtime models, so a check grades the same property in both.
 *
 * kafkajs as the courses meet it: `new Kafka({brokers})`, `producer.connect()/send({topic, messages,
 * acks})`, `consumer.subscribe({topic, fromBeginning})`, `consumer.run({eachMessage, autoCommit})`,
 * `consumer.commitOffsets([...])`, `heartbeat`, `pause/resume`. `send` resolves when the broker has
 * acknowledged every record (or rejects after `timeout`); with `acks: 0` it resolves at once.
 */
import {type Bytes, Buffer} from './buffer';
import {CLOCK} from './clock';

export interface KafkaRecord {
  topic: string;
  partition: number;
  offset: number;
  key: Bytes | null;
  value: Bytes | null;
  headers: Record<string, Bytes>;
  timestamp: number;
  seq: number;
}

/** How long a record acknowledged by the leader alone (acks 0/1) stays only on the leader. */
export const REPLICATION_LAG_MS = 100;

export const toBytes = (v: unknown): Bytes | null =>
  v === null || v === undefined
    ? null
    : v instanceof Uint8Array
    ? Buffer.from(v)
    : Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));
export const toText = (v: Uint8Array | null): string | null => (v === null ? null : Buffer.from(v).toString('utf8'));

const crc32 = (bytes: Uint8Array): number => {
  let crc = -1;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
};

export class KafkaJSError extends Error {
  retriable: boolean;
  constructor(message: string, retriable = false) {
    super(message);
    this.name = 'KafkaJSError';
    this.retriable = retriable;
  }
}

export class Broker {
  topics = new Map<string, KafkaRecord[][]>();
  committed = new Map<string, number>();
  events: unknown[][] = [];
  seq = 0;
  /** Topic → how many of the next produces fail with a delivery error. */
  failing = new Map<string, number>();
  /** Topic (or '*') → virtual time the broker acknowledges produces again (Infinity: until resumed). */
  stalls = new Map<string, number>();
  ackLosses = new Map<string, number>();
  unreplicated: {record: KafkaRecord; at: number}[] = [];
  consumers: Consumer[] = [];
  commitHooks: ((group: string, offsets: Map<string, number>) => void)[] = [];
  subscribeHooks: ((group: string, topics: string[]) => void)[] = [];
  stopWhenDrained = true;
  private readonly defaultPartitions = 3;

  reset(): void {
    // A consumer still looping from the previous check must stop polling the fresh world.
    for (const consumer of this.consumers) consumer.close();
    this.topics.clear();
    this.committed.clear();
    this.events = [];
    this.seq = 0;
    this.failing.clear();
    this.stalls.clear();
    this.ackLosses.clear();
    this.unreplicated = [];
    this.consumers = [];
    this.commitHooks = [];
    this.subscribeHooks = [];
    this.stopWhenDrained = true;
  }

  // ---- topics ------------------------------------------------------------------------------------
  createTopic(topic: string, partitions?: number): void {
    if (!this.topics.has(topic))
      this.topics.set(
        topic,
        Array.from({length: partitions ?? this.defaultPartitions}, () => []),
      );
  }

  /** The topic's partition logs, creating the topic on first use. */
  partitions(topic: string): KafkaRecord[][] {
    const existing = this.topics.get(topic);
    if (existing !== undefined) return existing;
    const created: KafkaRecord[][] = Array.from({length: this.defaultPartitions}, () => []);
    this.topics.set(topic, created);
    return created;
  }

  partitionFor(topic: string, key: Uint8Array | null): number {
    const n = this.partitions(topic).length;
    return key === null ? this.seq % n : crc32(key) % n;
  }

  produce(
    topic: string,
    key: unknown,
    value: unknown,
    headers: Record<string, unknown> = {},
    partition?: number,
  ): KafkaRecord {
    this.createTopic(topic);
    const k = toBytes(key);
    const p = partition === undefined || partition < 0 ? this.partitionFor(topic, k) : partition;
    const log = this.partitions(topic)[p];
    this.seq += 1;
    const record: KafkaRecord = {
      topic,
      partition: p,
      offset: log.length,
      key: k,
      value: toBytes(value),
      headers: Object.fromEntries(Object.entries(headers).map(([h, v]) => [h, toBytes(v) ?? Buffer.alloc(0)])),
      timestamp: CLOCK.now(),
      seq: this.seq,
    };
    log.push(record);
    this.events.push(['produce', topic, p, record.offset]);
    return record;
  }

  /** Put records from other producers on a topic: redeliveries, duplicates, poison messages. */
  seed(
    topic: string,
    options: {key?: unknown; value?: unknown; headers?: Record<string, unknown>; partition?: number},
  ): KafkaRecord {
    return this.produce(topic, options.key, options.value, options.headers, options.partition);
  }

  /** The next `times` produces to `topic` fail with a delivery error. */
  failNext(topic: string, times = 1): void {
    this.failing.set(topic, (this.failing.get(topic) ?? 0) + times);
  }

  /** The broker stops acknowledging produces (to `topic`, or every topic) — a dead or partitioned cluster. */
  stall(topic: string | null = null, seconds: number | null = null): void {
    this.stalls.set(topic ?? '*', seconds === null ? Infinity : CLOCK.now() + seconds * 1000);
  }

  resume(topic: string | null = null): void {
    if (topic === null) this.stalls.clear();
    else this.stalls.delete(topic);
  }

  stalledUntil(topic: string): number | null {
    const now = CLOCK.now();
    const candidates = [this.stalls.get('*'), this.stalls.get(topic)].filter(
      (t): t is number => t !== undefined && t > now,
    );
    return candidates.length === 0 ? null : Math.max(...candidates);
  }

  /** The next `times` produce requests are written but their acknowledgement is lost: the producer retries. */
  loseAcks(topic: string, times = 1): void {
    this.ackLosses.set(topic, (this.ackLosses.get(topic) ?? 0) + times);
  }

  /** The partition leader fails: records acknowledged by the leader alone (acks 0/1) in the last 100 ms are lost. */
  failover(topic: string | null = null): void {
    const now = CLOCK.now();
    const lost = this.unreplicated.filter(
      u => (topic === null || u.record.topic === topic) && now - u.at < REPLICATION_LAG_MS,
    );
    for (const {record} of lost) {
      const log = this.partitions(record.topic)[record.partition];
      const i = log.indexOf(record);
      if (i !== -1) log.splice(i, 1);
    }
    for (const name of new Set(lost.map(l => l.record.topic)))
      for (const log of this.partitions(name)) log.forEach((r, i) => (r.offset = i));
    this.unreplicated = this.unreplicated.filter(u => !lost.includes(u));
    this.events.push(['failover', topic, lost.length]);
  }

  records(topic: string): KafkaRecord[] {
    return [...(this.topics.get(topic) ?? [])].flat().sort((a, b) => a.seq - b.seq);
  }

  values(topic: string): (string | null)[] {
    return this.records(topic).map(r => toText(r.value));
  }

  keys(topic: string): (string | null)[] {
    return this.records(topic).map(r => toText(r.key));
  }

  endOffset(topic: string, partition: number): number {
    return this.partitions(topic)[partition].length;
  }

  // ---- groups ------------------------------------------------------------------------------------
  commit(group: string, offsets: Map<string, number>): void {
    for (const [tp, offset] of offsets) this.committed.set(`${group}|${tp}`, offset);
    this.events.push(['commit', group, Object.fromEntries(offsets)]);
    for (const hook of this.commitHooks) hook(group, offsets);
  }

  committedOffset(group: string, topic: string, partition: number): number | null {
    return this.committed.get(`${group}|${topic}|${partition}`) ?? null;
  }

  commits(group?: string): Record<string, number>[] {
    return this.events
      .filter(e => e[0] === 'commit' && (group === undefined || e[1] === group))
      .map(e => e[2] as Record<string, number>);
  }

  /** Records of `topic` the group has not committed. */
  lag(group: string, topic: string): number {
    return this.partitions(topic).reduce(
      (sum, log, p) => sum + log.length - (this.committedOffset(group, topic, p) ?? 0),
      0,
    );
  }

  /** Observe commits as they happen: snapshot other state to prove the commit came after the work. */
  onCommit(hook: (group: string, offsets: Map<string, number>) => void): void {
    this.commitHooks.push(hook);
  }

  /** Run `hook(group, topics)` when a consumer subscribes: act (seed, publish) once the learner's consumer is listening. */
  onSubscribe(hook: (group: string, topics: string[]) => void): void {
    this.subscribeHooks.push(hook);
  }
}

export const BROKER = new Broker();

// ---- the kafkajs surface -------------------------------------------------------------------------

export interface Message {
  key?: string | Uint8Array | null;
  value: string | Uint8Array | null;
  headers?: Record<string, string | Uint8Array>;
  partition?: number;
  timestamp?: string;
}

export interface ProducerRecordInput {
  topic: string;
  messages: Message[];
  acks?: number;
  timeout?: number;
}

export interface RecordMetadata {
  topicName: string;
  partition: number;
  baseOffset: string;
  errorCode: number;
}

export interface KafkaConfig {
  [key: string]: unknown;
  clientId?: string;
  brokers: string[];
}

export interface ProducerConfig {
  [key: string]: unknown;
  idempotent?: boolean;
  allowAutoTopicCreation?: boolean;
  /** How long an unacknowledged record waits before it fails (librdkafka's message.timeout.ms; kafkajs: send's `timeout`). */
  messageTimeoutMs?: number;
}

export class Kafka {
  constructor(readonly config: KafkaConfig) {
    BROKER.events.push(['client', config.clientId ?? null, config.brokers]);
  }

  producer(config: ProducerConfig = {}): Producer {
    return new Producer(config);
  }

  consumer(config: ConsumerConfig): Consumer {
    return new Consumer(config);
  }

  admin(): Admin {
    return new Admin();
  }
}

export class Admin {
  async connect(): Promise<void> {
    // the broker is in this process: nothing to connect to
  }
  async disconnect(): Promise<void> {
    // nothing was connected
  }
  async createTopics(options: {topics: {topic: string; numPartitions?: number}[]}): Promise<boolean> {
    for (const t of options.topics) BROKER.createTopic(t.topic, t.numPartitions);
    return true;
  }
  async listTopics(): Promise<string[]> {
    return [...BROKER.topics.keys()];
  }
}

/**
 * kafkajs's producer: `send` resolves once every record is acknowledged. While the broker is stalled
 * it waits on the virtual clock — `timeout` (default 30 s) then rejects with a retriable
 * KafkaJSError, as kafkajs's request timeout does — so a send without a deadline on a dead broker
 * costs what it costs in production. `acks: 0` resolves immediately and the record is gone;
 * `acks: 1` survives a lost ack but not a leader failover; `acks: -1` (all, the default) survives.
 * `idempotent: true` requires acks all and makes a lost-ack retry write once instead of twice.
 */
export class Producer {
  private connected = false;
  private readonly idempotent: boolean;
  private readonly messageTimeoutMs: number;

  constructor(readonly config: ProducerConfig) {
    this.idempotent = config.idempotent === true;
    this.messageTimeoutMs = typeof config.messageTimeoutMs === 'number' ? config.messageTimeoutMs : 30_000;
  }

  async connect(): Promise<void> {
    this.connected = true;
    BROKER.events.push(['producer', this.idempotent]);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(input: ProducerRecordInput): Promise<RecordMetadata[]> {
    if (!this.connected) throw new KafkaJSError('The producer is disconnected');
    const acks = input.acks ?? -1;
    if (this.idempotent && acks !== -1) throw new KafkaJSError('Idempotent producer requires acks: -1 (all)');
    const timeout = input.timeout ?? this.messageTimeoutMs;
    const out: RecordMetadata[] = [];
    for (const message of input.messages) {
      const failing = BROKER.failing.get(input.topic) ?? 0;
      if (failing > 0) {
        BROKER.failing.set(input.topic, failing - 1);
        BROKER.events.push(['produce-failed', input.topic]);
        throw new KafkaJSError('The request timed out', true);
      }
      const stalledUntil = BROKER.stalledUntil(input.topic);
      if (stalledUntil !== null) {
        if (acks === 0) {
          // acks=0: nobody waits for the broker — the send succeeds and the record is gone.
          BROKER.events.push(['produce-lost', input.topic]);
          out.push({topicName: input.topic, partition: 0, baseOffset: '-1', errorCode: 0});
          continue;
        }
        BROKER.events.push(['produce-stalled', input.topic]);
        const waited = await this.waitForBroker(input.topic, timeout);
        if (!waited) throw new KafkaJSError(`The request timed out after ${timeout} ms`, true);
      }
      const record = this.write(input.topic, message, acks);
      out.push({topicName: input.topic, partition: record.partition, baseOffset: String(record.offset), errorCode: 0});
    }
    return out;
  }

  /**
   * Wait until the broker answers again or `timeout` ms have passed; true if it answered. The wait is
   * a virtual sleep: a caller that awaits the send pays for it, a fire-and-forget send does not.
   */
  private async waitForBroker(topic: string, timeout: number): Promise<boolean> {
    const deadline = CLOCK.now() + timeout;
    for (;;) {
      const until = BROKER.stalledUntil(topic);
      if (until === null) return true;
      const next = Math.min(until === Infinity ? deadline : until, deadline);
      if (next > CLOCK.now()) await CLOCK.sleep(next - CLOCK.now());
      else await new Promise<void>(resolve => queueMicrotask(resolve));
      if (BROKER.stalledUntil(topic) === null) return true;
      if (CLOCK.now() >= deadline) return false;
    }
  }

  private write(topic: string, message: Message, acks: number): KafkaRecord {
    const headers = message.headers ?? {};
    let record = BROKER.produce(topic, message.key ?? null, message.value, headers, message.partition);
    if (acks !== -1) BROKER.unreplicated.push({record, at: CLOCK.now()});
    const lost = BROKER.ackLosses.get(topic) ?? 0;
    if (lost > 0) {
      BROKER.ackLosses.set(topic, lost - 1);
      BROKER.events.push(['ack-lost', topic]);
      if (!this.idempotent) {
        // The retry of a write whose ack was lost is written again.
        record = BROKER.produce(topic, message.key ?? null, message.value, headers, message.partition);
        if (acks !== -1) BROKER.unreplicated.push({record, at: CLOCK.now()});
      }
    }
    return record;
  }
}

export interface ConsumerConfig {
  /** kafkajs: `fromBeginning` is given at subscribe time; auto-commit is given at run time. */
  [key: string]: unknown;
  groupId: string;
}

export interface KafkaMessage {
  key: Bytes | null;
  value: Bytes | null;
  headers: Record<string, Bytes>;
  offset: string;
  timestamp: string;
  partition: number;
}

export interface EachMessagePayload {
  topic: string;
  partition: number;
  message: KafkaMessage;
  heartbeat: () => Promise<void>;
  pause: () => () => void;
}

export interface RunConfig {
  eachMessage: (payload: EachMessagePayload) => Promise<void>;
  /** kafkajs's default is true: offsets are committed on a timer (autoCommitInterval, 5 s) and after each message batch resolves. */
  autoCommit?: boolean;
  autoCommitInterval?: number | null;
  autoCommitThreshold?: number | null;
}

/**
 * kafkajs's consumer. `run()` delivers every record of the subscribed topics to `eachMessage`, one
 * at a time per the broker's round-robin, and returns when the topics are drained (the runtime stops
 * the loop the way `yarn verify` and the harness expect). With `autoCommit` (the default) the offset
 * of a delivered message is *resolved* and committed on the interval timer and when `run` finishes —
 * so a slow failing handler can have its message committed underneath it, as in production. With
 * `autoCommit: false` only `commitOffsets` commits.
 */
export class Consumer {
  readonly groupId: string;
  /** The `run()` configuration, for the harness: whether offsets auto-commit and on what interval (ms). */
  autoCommit = true;
  autoCommitInterval = 5000;
  private assignment: {topic: string; partition: number}[] = [];
  private positions = new Map<string, number>();
  private resolved = new Map<string, number>();
  private lastAutoCommit = CLOCK.now();
  private running = false;
  private closed = false;
  private rr = 0;
  private paused = new Set<string>();

  constructor(readonly config: ConsumerConfig) {
    this.groupId = config.groupId;
    BROKER.consumers.push(this);
    BROKER.events.push(['consumer', this.groupId]);
  }

  async connect(): Promise<void> {
    // the broker is in this process: nothing to connect to
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.running = false;
    if (this.autoCommit) this.doAutoCommit();
    BROKER.events.push(['close', this.groupId]);
  }

  async subscribe(options: {
    topic: string | string[] | RegExp;
    topics?: string[];
    fromBeginning?: boolean;
  }): Promise<void> {
    const names = options.topics ?? (Array.isArray(options.topic) ? options.topic : [options.topic]);
    for (const t of names) {
      if (t instanceof RegExp) throw new KafkaJSError('RegExp subscriptions are not available in this runtime');
      BROKER.createTopic(t);
      for (let p = 0; p < BROKER.partitions(t).length; p++) {
        this.assignment.push({topic: t, partition: p});
        const committed = BROKER.committedOffset(this.groupId, t, p);
        this.positions.set(`${t}|${p}`, committed ?? (options.fromBeginning ? 0 : BROKER.endOffset(t, p)));
      }
    }
    BROKER.events.push(['subscribe', this.groupId, names]);
    for (const hook of [...BROKER.subscribeHooks])
      hook(
        this.groupId,
        names.filter((t): t is string => typeof t === 'string'),
      );
  }

  /** Deliver until the subscribed topics are drained (or `stop()`); rejects with the handler's error. */
  async run(config: RunConfig): Promise<void> {
    this.autoCommit = config.autoCommit !== false;
    if (typeof config.autoCommitInterval === 'number') this.autoCommitInterval = config.autoCommitInterval;
    this.running = true;
    this.lastAutoCommit = CLOCK.now();
    try {
      while (this.running && !this.closed) {
        const next = this.next();
        if (next === null) {
          if (BROKER.stopWhenDrained) break;
          await CLOCK.sleep(100);
          continue;
        }
        const {topic, partition, record} = next;
        this.positions.set(`${topic}|${partition}`, record.offset + 1);
        BROKER.events.push(['deliver', this.groupId, topic, partition, record.offset]);
        await config.eachMessage({
          topic,
          partition,
          message: {
            key: record.key,
            value: record.value,
            headers: record.headers,
            offset: String(record.offset),
            timestamp: String(record.timestamp),
            partition,
          },
          heartbeat: async () => undefined,
          pause: () => {
            this.paused.add(`${topic}|${partition}`);
            return () => this.paused.delete(`${topic}|${partition}`);
          },
        });
        // kafkajs resolves the offset once eachMessage resolves; auto-commit commits resolved offsets.
        if (this.autoCommit) this.resolved.set(`${topic}|${partition}`, record.offset + 1);
        await new Promise<void>(resolve => queueMicrotask(resolve));
      }
    } finally {
      if (this.autoCommit) this.doAutoCommit();
    }
  }

  stop(): void {
    this.running = false;
  }

  /** @internal the world was reset underneath this consumer: stop without committing. */
  close(): void {
    this.closed = true;
    this.running = false;
  }

  /** kafkajs: `[{topic, partition, offset}]`, offset being the NEXT offset to read (as a string). */
  async commitOffsets(offsets: {topic: string; partition: number; offset: string | number}[]): Promise<void> {
    if (this.closed) throw new KafkaJSError('The consumer is disconnected');
    const target = new Map(offsets.map(o => [`${o.topic}|${o.partition}`, Number(o.offset)]));
    BROKER.commit(this.groupId, target);
    BROKER.events.push(['manual-commit', this.groupId]);
  }

  async committed(topic: string, partition: number): Promise<number | null> {
    return BROKER.committedOffset(this.groupId, topic, partition);
  }

  pause(topics: {topic: string; partitions?: number[]}[]): void {
    for (const t of topics)
      for (const p of t.partitions ?? [...Array(BROKER.topics.get(t.topic)?.length ?? 0).keys()])
        this.paused.add(`${t.topic}|${p}`);
  }

  resume(topics: {topic: string; partitions?: number[]}[]): void {
    for (const t of topics)
      for (const p of t.partitions ?? [...Array(BROKER.topics.get(t.topic)?.length ?? 0).keys()])
        this.paused.delete(`${t.topic}|${p}`);
  }

  seek(options: {topic: string; partition: number; offset: string | number}): void {
    this.positions.set(`${options.topic}|${options.partition}`, Number(options.offset));
  }

  on(): void {
    // event listeners are accepted and ignored
  }

  /** The background auto-commit timer, driven by the clock: commits resolved offsets every interval. */
  tick(): void {
    if (!this.autoCommit || !this.running || this.closed) return;
    if (CLOCK.now() - this.lastAutoCommit >= this.autoCommitInterval) this.doAutoCommit();
  }

  private doAutoCommit(): void {
    this.lastAutoCommit = CLOCK.now();
    const due = new Map<string, number>();
    for (const [tp, offset] of this.resolved) {
      const [topic, partition] = tp.split('|');
      if (BROKER.committedOffset(this.groupId, topic, Number(partition)) !== offset) due.set(tp, offset);
    }
    if (due.size > 0) {
      BROKER.commit(this.groupId, due);
      BROKER.events.push(['auto-commit', this.groupId]);
    }
  }

  private next(): {topic: string; partition: number; record: KafkaRecord} | null {
    const n = this.assignment.length;
    for (let i = 0; i < n; i++) {
      const tp = this.assignment[(this.rr + i) % n];
      const key = `${tp.topic}|${tp.partition}`;
      if (this.paused.has(key)) continue;
      const pos = this.positions.get(key) ?? 0;
      const log = BROKER.partitions(tp.topic)[tp.partition];
      if (pos < log.length) {
        this.rr = (this.rr + i + 1) % n;
        return {topic: tp.topic, partition: tp.partition, record: log[pos]};
      }
    }
    return null;
  }
}

CLOCK.onAdvance(() => {
  for (const consumer of BROKER.consumers) consumer.tick();
});
