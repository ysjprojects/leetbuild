/**
 * Kafka for the C++ runtime: the broker every language's checks share (../ts/kafka.ts BROKER), as
 * the librdkafka model (cppruntime/include/librdkafka, cppruntime/src/kafka.cpp) and the harness's
 * ctx.Kafka (cppruntime/src/harness_kafka.cpp) reach it.
 *
 * The clients' state lives here, as librdkafka keeps it on its own threads: a producer's records in
 * flight (waiting for a stalled broker, failing after message.timeout.ms) and its delivery reports
 * until the application serves them in poll()/flush(); a consumer's group membership and assignment
 * (range assignor, rebalanced as members join and leave), positions, stored offsets, paused
 * partitions and the auto-commit timer (enable.auto.commit, every auto.commit.interval.ms of virtual
 * time). The C++ side only waits: on the virtual clock, for the time a reply says something may
 * change, or until another of its calls changed the broker. Semantics follow the Go runtime's
 * confluent-kafka-go model (goruntime/models/confluent), which models the same librdkafka.
 *
 * Keys, values and header values are bytes: they cross the JSON bridge as base64 (null: no key, a
 * tombstone) and live in the broker as Buffers, as the TypeScript runtime's do.
 */
import {type Bytes, Buffer} from '../ts/buffer';
import {CLOCK} from '../ts/clock';
import {type KafkaRecord, BROKER} from '../ts/kafka';
import type {Bridge, BridgeWorld} from './bridge';

/** librdkafka's error codes (rd_kafka_resp_err_t) the model reports. */
const ERR = {
  NO_ERROR: 0,
  MSG_TIMED_OUT: -192,
  UNKNOWN_PARTITION: -190,
  QUEUE_FULL: -184,
  STATE: -172,
  NO_OFFSET: -168,
  PURGE_QUEUE: -152,
  PURGE_INFLIGHT: -151,
} as const;

/** librdkafka's logical offsets. */
const OFFSET = {BEGINNING: -2, END: -1, STORED: -1000, INVALID: -1001, TAIL_BASE: -2000} as const;

const PURGE = {QUEUE: 1, INFLIGHT: 2} as const;

/** Bytes on the bridge: base64, null for none. */
type Wire = string | null;
const fromWire = (b64: Wire): Bytes | null => (b64 === null ? null : Buffer.from(b64, 'base64'));
const toWire = (bytes: Uint8Array | null): Wire => (bytes === null ? null : Buffer.from(bytes).toString('base64'));

type Headers = [string, Bytes][];
type WireHeaders = [string, string][];
type Conf = Record<string, string>;

interface TopicPartition {
  topic: string;
  partition: number;
  offset?: number;
}

/** A record as the C++ side reads it. */
interface WireRecord {
  topic: string;
  partition: number;
  offset: number;
  key: Wire;
  value: Wire;
  headers: WireHeaders;
  timestamp: number;
  seq: number;
}

const tpKey = (topic: string, partition: number): string => `${topic}|${partition}`;
const splitKey = (key: string): {topic: string; partition: number} => {
  const at = key.lastIndexOf('|');
  return {topic: key.slice(0, at), partition: Number(key.slice(at + 1))};
};

const wire = (r: KafkaRecord): WireRecord => ({
  topic: r.topic,
  partition: r.partition,
  offset: r.offset,
  key: toWire(r.key),
  value: toWire(r.value),
  headers: Object.entries(r.headers).map(([k, v]): [string, string] => [k, toWire(v) ?? '']),
  timestamp: r.timestamp,
  seq: r.seq,
});

const bool = (conf: Conf, fallback: boolean, ...names: string[]): boolean => {
  for (const name of names) {
    const v = conf[name]?.trim().toLowerCase();
    if (v !== undefined) return v === 'true' || v === '1';
  }
  return fallback;
};

const integer = (conf: Conf, fallback: number, ...names: string[]): number => {
  for (const name of names) {
    const v = conf[name];
    if (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return fallback;
};

// ---- producers ---------------------------------------------------------------------------------

interface Outgoing {
  msg: number;
  topic: string;
  partition: number;
  key: Bytes | null;
  value: Bytes | null;
  headers: Headers;
  timestamp: number;
  /** When it was produced: message.timeout.ms counts from here. */
  at: number;
}

interface Report {
  msg: number;
  err: number;
  partition: number;
  offset: number;
  timestamp: number;
  /** librdkafka's Message::Status: 0 not persisted, 1 possibly persisted, 2 persisted. */
  status: number;
}

class CppProducer {
  readonly acks: number;
  readonly idempotent: boolean;
  readonly timeoutMs: number;
  readonly maxMessages: number;
  /** Records waiting for the broker (a stall, or an earlier record of the same topic still waiting). */
  inflight: Outgoing[] = [];
  /** Delivery reports the application has not served yet (poll/flush). */
  reports: Report[] = [];
  closed = false;

  constructor(conf: Conf) {
    const acks = (conf.acks ?? conf['request.required.acks'] ?? 'all').trim().toLowerCase();
    this.acks = acks === '0' ? 0 : acks === '1' ? 1 : -1;
    this.idempotent = bool(conf, false, 'enable.idempotence');
    this.timeoutMs = integer(conf, 300_000, 'message.timeout.ms', 'delivery.timeout.ms');
    this.maxMessages = integer(conf, 100_000, 'queue.buffering.max.messages');
    BROKER.events.push(['producer', this.idempotent, 'librdkafka']);
  }

  outq(): number {
    return this.inflight.length + this.reports.length;
  }

  produce(m: Outgoing): number {
    this.settle();
    if (this.outq() >= this.maxMessages) return ERR.QUEUE_FULL;
    if (m.partition !== -1 && (m.partition < 0 || m.partition >= BROKER.partitions(m.topic).length))
      return ERR.UNKNOWN_PARTITION;
    BROKER.createTopic(m.topic);
    const failing = BROKER.failing.get(m.topic) ?? 0;
    if (failing > 0) {
      BROKER.failing.set(m.topic, failing - 1);
      BROKER.events.push(['produce-failed', m.topic]);
      this.report(m, ERR.MSG_TIMED_OUT, null, 1);
      return ERR.NO_ERROR;
    }
    const stalled = BROKER.stalledUntil(m.topic) !== null;
    if (stalled || this.inflight.some(o => o.topic === m.topic)) {
      if (stalled && this.acks === 0) {
        // acks=0: nobody waits for the broker — the report says delivered and the record is gone.
        BROKER.events.push(['produce-lost', m.topic]);
        this.reports.push({
          msg: m.msg,
          err: ERR.NO_ERROR,
          partition: m.partition,
          offset: OFFSET.INVALID,
          timestamp: m.timestamp,
          status: 1,
        });
        return ERR.NO_ERROR;
      }
      this.inflight.push(m);
      BROKER.events.push(['produce-stalled', m.topic]);
      return ERR.NO_ERROR;
    }
    this.report(m, ERR.NO_ERROR, this.write(m), 2);
    return ERR.NO_ERROR;
  }

  /** Deliver the records the broker accepts again; fail those past message.timeout.ms. */
  settle(): void {
    if (this.closed || this.inflight.length === 0) return;
    const now = CLOCK.now();
    const blocked = new Set<string>();
    const keep: Outgoing[] = [];
    for (const m of this.inflight) {
      if (BROKER.stalledUntil(m.topic) === null && !blocked.has(m.topic)) {
        this.report(m, ERR.NO_ERROR, this.write(m), 2);
      } else if (now - m.at >= this.timeoutMs) {
        BROKER.events.push(['produce-timed-out', m.topic]);
        this.report(m, ERR.MSG_TIMED_OUT, null, 1);
      } else {
        blocked.add(m.topic);
        keep.push(m);
      }
    }
    this.inflight = keep;
  }

  /** When the next record in flight may change (a stall ending, a message timing out); null: never by itself. */
  wake(): number | null {
    let wake: number | null = null;
    for (const m of this.inflight) {
      const until = BROKER.stalledUntil(m.topic);
      for (const t of [m.at + this.timeoutMs, until])
        if (t !== null && Number.isFinite(t) && (wake === null || t < wake)) wake = t;
    }
    return wake;
  }

  /** The first record waiting per topic is in flight (sent, unacknowledged); the ones behind it are queued. */
  purge(flags: number): void {
    const seen = new Set<string>();
    const keep: Outgoing[] = [];
    for (const m of this.inflight) {
      const inFlight = !seen.has(m.topic);
      seen.add(m.topic);
      const purged = inFlight ? (flags & PURGE.INFLIGHT) !== 0 : (flags & PURGE.QUEUE) !== 0;
      if (!purged) {
        keep.push(m);
        continue;
      }
      const err = inFlight ? ERR.PURGE_INFLIGHT : ERR.PURGE_QUEUE;
      this.reports.push({
        msg: m.msg,
        err,
        partition: m.partition,
        offset: OFFSET.INVALID,
        timestamp: m.timestamp,
        status: inFlight ? 1 : 0,
      });
    }
    this.inflight = keep;
  }

  /** The broker accepts a record: acks 0/1 leave it unreplicated; a lost ack makes the producer retry. */
  private write(m: Outgoing): KafkaRecord {
    const headers = Object.fromEntries(m.headers);
    const append = (): KafkaRecord => {
      const record = BROKER.produce(m.topic, m.key, m.value, headers, m.partition < 0 ? undefined : m.partition);
      if (m.timestamp > 0) record.timestamp = m.timestamp;
      if (this.acks !== -1) BROKER.unreplicated.push({record, at: CLOCK.now()});
      return record;
    };
    let record = append();
    const lost = BROKER.ackLosses.get(m.topic) ?? 0;
    if (lost > 0) {
      BROKER.ackLosses.set(m.topic, lost - 1);
      BROKER.events.push(['ack-lost', m.topic]);
      // The retry of a write whose ack was lost is written again, unless the producer is idempotent.
      if (!this.idempotent) record = append();
    }
    return record;
  }

  private report(m: Outgoing, err: number, record: KafkaRecord | null, status: number): void {
    this.reports.push({
      msg: m.msg,
      err,
      partition: record?.partition ?? m.partition,
      offset: record?.offset ?? OFFSET.INVALID,
      timestamp: record?.timestamp ?? m.timestamp,
      status,
    });
  }
}

// ---- consumers ---------------------------------------------------------------------------------

interface Group {
  members: CppConsumer[];
  generation: number;
  /** The subscribed topics that existed at the last rebalance: one created since triggers another. */
  topics: Set<string>;
}

interface Membership {
  generation: number;
  partitions: TopicPartition[];
  /** Each partition's end offset when it was assigned: where a member starting at the latest offset begins. */
  ends: Map<string, number>;
}

class CppConsumer {
  readonly group: string;
  readonly autoCommit: boolean;
  readonly autoStore: boolean;
  readonly intervalMs: number;
  readonly earliest: boolean;
  readonly eof: boolean;
  subscription: string[] = [];
  /** Subscribed topics that did not exist yet at subscribe time: once created, a latest start is their beginning. */
  missingAtSubscribe = new Set<string>();
  /** The group's assignment to this member (subscribed), null when not a member. */
  member: Membership | null = null;
  /** The generation this consumer last took its assignment from. */
  generation = 0;
  assigned: TopicPartition[] = [];
  positions = new Map<string, number>();
  stored = new Map<string, number>();
  paused = new Set<string>();
  atEOF = new Set<string>();
  rr = 0;
  closed = false;
  lastAutoCommit = CLOCK.now();
  /** Auto-commit outcomes for the application's offset_commit_cb, served in its next poll. */
  commitResults: {err: number; offsets: TopicPartition[]}[] = [];

  constructor(readonly id: number, readonly config: Conf, readonly rebalanceCb: boolean, readonly commitCb: boolean) {
    this.group = config['group.id'];
    this.autoCommit = bool(config, true, 'enable.auto.commit');
    this.autoStore = bool(config, true, 'enable.auto.offset.store');
    this.intervalMs = integer(config, 5000, 'auto.commit.interval.ms');
    this.eof = bool(config, false, 'enable.partition.eof');
    const reset = (config['auto.offset.reset'] ?? 'latest').trim().toLowerCase();
    this.earliest = reset === 'smallest' || reset === 'earliest' || reset === 'beginning';
    BROKER.events.push(['consumer', this.group, 'librdkafka']);
  }

  /** Where an assigned partition starts: the offset asked for, else the group's committed offset, else auto.offset.reset. */
  start(topic: string, partition: number, offset: number = OFFSET.STORED): number {
    const end = BROKER.endOffset(topic, partition);
    if (offset >= 0) return offset;
    if (offset === OFFSET.BEGINNING) return 0;
    if (offset === OFFSET.END) return end;
    if (offset <= OFFSET.TAIL_BASE) return Math.max(0, end - (OFFSET.TAIL_BASE - offset));
    const committed = BROKER.committedOffset(this.group, topic, partition);
    if (committed !== null) return committed;
    if (this.earliest) return 0;
    return this.member?.ends.get(tpKey(topic, partition)) ?? end;
  }

  assign(partitions: TopicPartition[]): void {
    this.assigned = [];
    this.positions = new Map();
    for (const p of partitions) {
      BROKER.createTopic(p.topic);
      this.assigned.push({topic: p.topic, partition: p.partition});
      this.positions.set(tpKey(p.topic, p.partition), this.start(p.topic, p.partition, p.offset ?? OFFSET.STORED));
    }
  }

  incrementalAssign(partitions: TopicPartition[]): void {
    for (const p of partitions) {
      const key = tpKey(p.topic, p.partition);
      if (!this.owns(p.topic, p.partition)) this.assigned.push({topic: p.topic, partition: p.partition});
      this.positions.set(key, this.start(p.topic, p.partition, p.offset ?? OFFSET.STORED));
    }
  }

  incrementalUnassign(partitions: TopicPartition[]): void {
    const gone = new Set(partitions.map(p => tpKey(p.topic, p.partition)));
    this.assigned = this.assigned.filter(tp => !gone.has(tpKey(tp.topic, tp.partition)));
    for (const key of gone) this.positions.delete(key);
  }

  owns(topic: string, partition: number): boolean {
    return this.assigned.some(tp => tp.topic === topic && tp.partition === partition);
  }

  /** The next record round-robin over the unpaused assigned partitions (or a partition EOF when enabled). */
  next(): {message: WireRecord} | {eof: TopicPartition} | null {
    const n = this.assigned.length;
    for (let i = 0; i < n; i++) {
      const tp = this.assigned[(this.rr + i) % n];
      const key = tpKey(tp.topic, tp.partition);
      if (this.paused.has(key)) continue;
      let pos = this.positions.get(key);
      if (pos === undefined) {
        pos = this.start(tp.topic, tp.partition);
        this.positions.set(key, pos);
      }
      const log = BROKER.partitions(tp.topic)[tp.partition];
      if (log === undefined || pos >= log.length || pos < 0) continue;
      const record = log[pos];
      this.rr = (this.rr + i + 1) % n;
      this.positions.set(key, pos + 1);
      this.atEOF.delete(key);
      if (this.autoStore) this.stored.set(key, pos + 1);
      BROKER.events.push(['deliver', this.group, tp.topic, tp.partition, record.offset]);
      return {message: wire(record)};
    }
    if (this.eof) {
      for (const tp of this.assigned) {
        const key = tpKey(tp.topic, tp.partition);
        if (this.paused.has(key) || this.atEOF.has(key)) continue;
        const pos = this.positions.get(key) ?? 0;
        if (pos >= BROKER.endOffset(tp.topic, tp.partition)) {
          this.atEOF.add(key);
          return {eof: {topic: tp.topic, partition: tp.partition, offset: pos}};
        }
      }
    }
    return null;
  }

  /** The auto-commit: the stored offsets the group has not committed yet. */
  commitStored(): void {
    this.lastAutoCommit = CLOCK.now();
    const due = new Map<string, number>();
    for (const [key, offset] of this.stored) {
      const {topic, partition} = splitKey(key);
      if (BROKER.committedOffset(this.group, topic, partition) !== offset) due.set(key, offset);
    }
    if (due.size === 0) return;
    BROKER.commit(this.group, due);
    BROKER.events.push(['auto-commit', this.group]);
    if (this.commitCb)
      this.commitResults.push({err: ERR.NO_ERROR, offsets: [...due].map(([k, offset]) => ({...splitKey(k), offset}))});
  }

  /** The auto-commit timer, driven by the clock. */
  tick(): void {
    if (this.closed || !this.autoCommit || this.intervalMs <= 0) return;
    if (CLOCK.now() - this.lastAutoCommit >= this.intervalMs) this.commitStored();
  }

  info(): unknown {
    return {
      client: 'librdkafka',
      group: this.group,
      topics: this.subscription,
      autoCommit: this.autoCommit,
      autoCommitInterval: this.intervalMs,
      config: this.config,
      assignment: this.assigned.map(tp => ({topic: tp.topic, partition: tp.partition})),
      closed: this.closed,
    };
  }
}

/** One program's clients, ticked by the clock while the program runs. */
interface Clients {
  producers: Map<number, CppProducer>;
  consumers: Map<number, CppConsumer>;
}

const LIVE = new Set<Clients>();

CLOCK.onAdvance(() => {
  for (const clients of LIVE) {
    for (const producer of clients.producers.values()) producer.settle();
    for (const consumer of clients.consumers.values()) consumer.tick();
  }
});

/** The events of the broker's log as the C++ harness reads them (Go's KafkaEvent). */
const eventOf = (e: unknown[]): Record<string, unknown> => {
  const [kind] = e as [string];
  const out: Record<string, unknown> = {kind};
  switch (kind) {
    case 'produce':
    case 'seed':
      Object.assign(out, {topic: e[1], partition: e[2], offset: e[3]});
      break;
    case 'produce-failed':
    case 'produce-stalled':
    case 'produce-lost':
    case 'produce-timed-out':
    case 'ack-lost':
      out.topic = e[1];
      break;
    case 'failover':
      Object.assign(out, {topic: e[1] ?? '', lost: e[2]});
      break;
    case 'producer':
      out.client = e[2] ?? 'kafkajs';
      break;
    case 'consumer':
      Object.assign(out, {group: e[1], client: e[2] ?? 'kafkajs'});
      break;
    case 'subscribe':
      Object.assign(out, {group: e[1], topics: e[2]});
      break;
    case 'deliver':
      Object.assign(out, {group: e[1], topic: e[2], partition: e[3], offset: e[4]});
      break;
    case 'commit':
      Object.assign(out, {group: e[1], offsets: e[2]});
      break;
    case 'manual-commit':
    case 'auto-commit':
    case 'close':
      out.group = e[1];
      break;
    default:
      break;
  }
  return out;
};

export function kafkaBridge(world: BridgeWorld): Bridge {
  const clients: Clients = {producers: new Map(), consumers: new Map()};
  LIVE.add(clients);
  /** Consumers in creation order, closed ones included (the harness's Consumers()). */
  const created: CppConsumer[] = [];
  const groups = new Map<string, Group>();
  let nextId = 1;
  /** Inside a synchronous call from the program: a hook runs on the calling thread, before the call returns. */
  let depth = 0;
  /** The arguments of the hook running now (a C++ invocable reads them back). */
  const hookArgs: unknown[] = [];

  const producer = (id: number): CppProducer => {
    const p = clients.producers.get(id);
    if (p === undefined) throw new Error(`no Kafka producer ${id}`);
    return p;
  };
  const consumer = (id: number): CppConsumer => {
    const c = clients.consumers.get(id);
    if (c === undefined) throw new Error(`no Kafka consumer ${id}`);
    return c;
  };

  const settleProducers = (): void => {
    for (const p of clients.producers.values()) p.settle();
  };

  /** The group's members split every subscribed topic's partitions: contiguous ranges in join order (the range assignor). */
  const rebalance = (id: string): void => {
    const group = groups.get(id);
    if (group === undefined) return;
    group.generation += 1;
    const assignments = new Map<CppConsumer, TopicPartition[]>(group.members.map(m => [m, []]));
    // A subscription to a topic that does not exist assigns nothing of it (allow.auto.create.topics
    // is off for consumers): the group rebalances once the topic is created.
    const topics = [...new Set(group.members.flatMap(m => m.subscription))].filter(t => BROKER.topics.has(t));
    group.topics = new Set(topics);
    for (const topic of topics) {
      const members = group.members.filter(m => m.subscription.includes(topic));
      const n = BROKER.partitions(topic).length;
      const each = Math.floor(n / members.length);
      const extra = n % members.length;
      let p = 0;
      members.forEach((m, i) => {
        const count = each + (i < extra ? 1 : 0);
        for (let k = 0; k < count; k++, p++) assignments.get(m)?.push({topic, partition: p});
      });
    }
    for (const m of group.members) {
      const partitions = assignments.get(m) ?? [];
      m.member = {
        generation: group.generation,
        partitions,
        ends: new Map(
          partitions.map((tp): [string, number] => [
            tpKey(tp.topic, tp.partition),
            m.missingAtSubscribe.has(tp.topic) ? 0 : BROKER.endOffset(tp.topic, tp.partition),
          ]),
        ),
      };
    }
  };

  const leave = (c: CppConsumer): void => {
    if (c.member === null) return;
    c.member = null;
    const group = groups.get(c.group);
    if (group === undefined) return;
    group.members = group.members.filter(m => m !== c);
    rebalance(c.group);
  };

  const close = (c: CppConsumer): void => {
    if (c.closed) return;
    if (c.autoCommit) c.commitStored();
    c.closed = true;
    leave(c);
    BROKER.events.push(['close', c.group]);
  };

  const commit = (c: CppConsumer, offsets: TopicPartition[], kind: string): number => {
    const target = new Map<string, number>();
    for (const o of offsets)
      if (o.offset !== undefined && o.offset >= 0) target.set(tpKey(o.topic, o.partition), o.offset);
    if (target.size === 0) return ERR.NO_OFFSET;
    BROKER.commit(c.group, target);
    BROKER.events.push([kind, c.group]);
    return ERR.NO_ERROR;
  };

  /** A harness hook: on the calling thread inside a call of the program's, else on a thread of its own. */
  const hook =
    (invoke: number, deliver: number) =>
    (args: unknown): void => {
      if (!world.live()) return;
      if (depth > 0) {
        hookArgs.push(args);
        try {
          world.invoke(invoke);
        } finally {
          hookArgs.pop();
        }
      } else {
        world.deliver(deliver, JSON.stringify(args));
      }
    };

  const calls: Record<string, (request: never) => unknown> = {
    // ---- producers
    'kafka.producer.new': ({conf}: {conf: Conf}): number => {
      const id = nextId++;
      clients.producers.set(id, new CppProducer(conf));
      return id;
    },
    'kafka.producer.produce': (
      m: Omit<Outgoing, 'at' | 'key' | 'value' | 'headers'> & {
        id: number;
        key: Wire;
        value: Wire;
        headers: WireHeaders;
      },
    ): number => {
      const p = producer(m.id);
      return p.produce({
        ...m,
        key: fromWire(m.key),
        value: fromWire(m.value),
        headers: m.headers.map(([k, v]): [string, Bytes] => [k, fromWire(v) ?? Buffer.alloc(0)]),
        at: CLOCK.now(),
      });
    },
    // The reports to serve now, what is still queued, and when something may change by itself.
    'kafka.producer.poll': ({id}: {id: number}): unknown => {
      const p = producer(id);
      p.settle();
      const reports = p.reports;
      p.reports = [];
      return {reports, outq: p.outq(), wake: p.wake()};
    },
    'kafka.producer.outq': ({id}: {id: number}): number => {
      const p = producer(id);
      p.settle();
      return p.outq();
    },
    'kafka.producer.flush': (): void => {
      BROKER.events.push(['flush']);
    },
    'kafka.producer.purge': ({id, flags}: {id: number; flags: number}): void => producer(id).purge(flags),
    'kafka.producer.close': ({id}: {id: number}): void => {
      const p = clients.producers.get(id);
      if (p === undefined) return;
      p.closed = true;
      clients.producers.delete(id);
    },

    // ---- consumers
    'kafka.consumer.new': ({
      conf,
      rebalanceCb,
      commitCb,
    }: {
      conf: Conf;
      rebalanceCb: boolean;
      commitCb: boolean;
    }): number => {
      const id = nextId++;
      const c = new CppConsumer(id, conf, rebalanceCb, commitCb);
      clients.consumers.set(id, c);
      created.push(c);
      return id;
    },
    'kafka.consumer.subscribe': ({id, topics}: {id: number; topics: string[]}): number => {
      const c = consumer(id);
      if (c.closed) return ERR.STATE;
      leave(c);
      c.missingAtSubscribe = new Set(topics.filter(t => !BROKER.topics.has(t)));
      c.subscription = [...topics];
      c.generation = 0;
      c.member = {generation: 0, partitions: [], ends: new Map()};
      const group = groups.get(c.group) ?? {members: [], generation: 0, topics: new Set<string>()};
      groups.set(c.group, group);
      group.members.push(c);
      rebalance(c.group);
      BROKER.events.push(['subscribe', c.group, [...topics]]);
      for (const h of [...BROKER.subscribeHooks]) h(c.group, [...topics]);
      return ERR.NO_ERROR;
    },
    'kafka.consumer.unsubscribe': ({id}: {id: number}): number => {
      const c = consumer(id);
      leave(c);
      c.subscription = [];
      c.assigned = [];
      return ERR.NO_ERROR;
    },
    'kafka.consumer.subscription': ({id}: {id: number}): string[] => consumer(id).subscription,
    'kafka.consumer.assign': ({id, partitions}: {id: number; partitions: TopicPartition[]}): number => {
      consumer(id).assign(partitions);
      return ERR.NO_ERROR;
    },
    'kafka.consumer.unassign': ({id}: {id: number}): number => {
      const c = consumer(id);
      c.assigned = [];
      c.positions = new Map();
      return ERR.NO_ERROR;
    },
    'kafka.consumer.incrementalAssign': ({id, partitions}: {id: number; partitions: TopicPartition[]}): number => {
      consumer(id).incrementalAssign(partitions);
      return ERR.NO_ERROR;
    },
    'kafka.consumer.incrementalUnassign': ({id, partitions}: {id: number; partitions: TopicPartition[]}): number => {
      consumer(id).incrementalUnassign(partitions);
      return ERR.NO_ERROR;
    },
    'kafka.consumer.assignment': ({id}: {id: number}): TopicPartition[] => consumer(id).assigned,
    // The next thing consume() returns: a rebalance for the application's rebalance_cb, a record, a
    // partition EOF, or nothing yet; and the auto-commit outcomes for its offset_commit_cb.
    'kafka.consumer.poll': ({id}: {id: number}): unknown => {
      const c = consumer(id);
      const commits = c.commitResults;
      c.commitResults = [];
      if (c.closed) return {closed: true, commits};
      c.tick();
      const group = groups.get(c.group);
      if (
        c.member !== null &&
        group !== undefined &&
        c.subscription.some(t => BROKER.topics.has(t) && !group.topics.has(t))
      )
        rebalance(c.group);
      if (c.member !== null && c.member.generation !== c.generation) {
        c.generation = c.member.generation;
        const assigned = c.member.partitions.map(tp => ({...tp, offset: OFFSET.STORED}));
        if (c.rebalanceCb) {
          return {rebalance: {revoked: c.assigned.map(tp => ({...tp, offset: OFFSET.INVALID})), assigned}, commits};
        }
        c.assign(assigned);
      }
      return {...c.next(), commits};
    },
    'kafka.consumer.commit': ({id, offsets}: {id: number; offsets: TopicPartition[] | null}): number => {
      const c = consumer(id);
      if (c.closed) return ERR.STATE;
      const list =
        offsets ??
        c.assigned.flatMap(tp => {
          const stored = c.stored.get(tpKey(tp.topic, tp.partition));
          return stored === undefined ? [] : [{...tp, offset: stored}];
        });
      return commit(c, list, 'manual-commit');
    },
    // Offsets stored for the next commit; the commit of the current assignment's stored offsets.
    'kafka.consumer.store': ({id, offsets}: {id: number; offsets: TopicPartition[]}): number => {
      const c = consumer(id);
      for (const o of offsets)
        if (o.offset !== undefined && o.offset >= 0) c.stored.set(tpKey(o.topic, o.partition), o.offset);
      return ERR.NO_ERROR;
    },
    'kafka.consumer.stored': ({id}: {id: number}): TopicPartition[] => {
      const c = consumer(id);
      return c.assigned.flatMap(tp => {
        const stored = c.stored.get(tpKey(tp.topic, tp.partition));
        return stored === undefined ? [] : [{...tp, offset: stored}];
      });
    },
    'kafka.consumer.committed': ({id, partitions}: {id: number; partitions: TopicPartition[]}): TopicPartition[] => {
      const c = consumer(id);
      return partitions.map(tp => ({
        ...tp,
        offset: BROKER.committedOffset(c.group, tp.topic, tp.partition) ?? OFFSET.INVALID,
      }));
    },
    'kafka.consumer.position': ({id, partitions}: {id: number; partitions: TopicPartition[]}): TopicPartition[] => {
      const c = consumer(id);
      return partitions.map(tp => ({...tp, offset: c.positions.get(tpKey(tp.topic, tp.partition)) ?? OFFSET.INVALID}));
    },
    'kafka.consumer.seek': ({id, topic, partition, offset}: {id: number} & Required<TopicPartition>): number => {
      const c = consumer(id);
      if (!c.owns(topic, partition)) return ERR.UNKNOWN_PARTITION;
      const key = tpKey(topic, partition);
      c.positions.set(key, c.start(topic, partition, offset));
      c.atEOF.delete(key);
      return ERR.NO_ERROR;
    },
    'kafka.consumer.pause': ({
      id,
      partitions,
      pause,
    }: {
      id: number;
      partitions: TopicPartition[];
      pause: boolean;
    }): number => {
      const c = consumer(id);
      for (const tp of partitions) {
        const key = tpKey(tp.topic, tp.partition);
        if (pause) c.paused.add(key);
        else c.paused.delete(key);
      }
      return ERR.NO_ERROR;
    },
    'kafka.consumer.close': ({id}: {id: number}): number => {
      const c = consumer(id);
      if (c.closed) return ERR.STATE;
      close(c);
      return ERR.NO_ERROR;
    },
    // The destructor: a consumer that was not closed is closed (librdkafka's rd_kafka_destroy).
    'kafka.consumer.destroy': ({id}: {id: number}): void => {
      const c = clients.consumers.get(id);
      if (c === undefined) return;
      close(c);
      clients.consumers.delete(id);
    },

    // ---- the cluster, for clients and the harness
    'kafka.partitions': (topic: string): number => BROKER.partitions(topic).length,
    'kafka.watermarks': ({topic, partition}: {topic: string; partition: number}): unknown => {
      const n = BROKER.partitions(topic).length;
      if (partition < 0 || partition >= n)
        return {err: ERR.UNKNOWN_PARTITION, low: OFFSET.INVALID, high: OFFSET.INVALID};
      return {err: ERR.NO_ERROR, low: 0, high: BROKER.endOffset(topic, partition)};
    },

    // ---- the harness
    'kafka.createTopic': ({topic, partitions}: {topic: string; partitions: number}): void =>
      BROKER.createTopic(topic, partitions > 0 ? partitions : undefined),
    'kafka.topics': (): string[] => [...BROKER.topics.keys()],
    'kafka.partitionFor': ({topic, key}: {topic: string; key: Wire}): number =>
      BROKER.partitionFor(topic, fromWire(key)),
    'kafka.seed': ({
      topic,
      partition,
      key,
      value,
      headers,
    }: {
      topic: string;
      partition: number;
      key: Wire;
      value: Wire;
      headers: WireHeaders;
    }): WireRecord =>
      wire(
        BROKER.seed(topic, {
          key: fromWire(key),
          value: fromWire(value),
          headers: Object.fromEntries(headers.map(([k, v]) => [k, fromWire(v)])),
          partition: partition < 0 ? undefined : partition,
        }),
      ),
    'kafka.records': (topic: string): WireRecord[] => BROKER.records(topic).map(wire),
    'kafka.endOffset': ({topic, partition}: {topic: string; partition: number}): number =>
      BROKER.endOffset(topic, partition),
    'kafka.lag': ({group, topic}: {group: string; topic: string}): number => BROKER.lag(group, topic),
    'kafka.committed': ({group, topic, partition}: {group: string; topic: string; partition: number}): number | null =>
      BROKER.committedOffset(group, topic, partition),
    'kafka.commits': (group: string): Record<string, number>[] => BROKER.commits(group === '' ? undefined : group),
    'kafka.commit': ({group, offsets}: {group: string; offsets: Record<string, number>}): void =>
      BROKER.commit(group, new Map(Object.entries(offsets))),
    'kafka.onCommit': ({invoke, deliver}: {invoke: number; deliver: number}): void => {
      const run = hook(invoke, deliver);
      BROKER.onCommit((group, offsets) => run({group, offsets: Object.fromEntries(offsets)}));
    },
    'kafka.onSubscribe': ({invoke, deliver}: {invoke: number; deliver: number}): void => {
      const run = hook(invoke, deliver);
      BROKER.onSubscribe((group, topics) => run({group, topics}));
    },
    'kafka.hookArgs': (): unknown => hookArgs[hookArgs.length - 1] ?? null,
    'kafka.failNext': ({topic, times}: {topic: string; times: number}): void => BROKER.failNext(topic, times),
    'kafka.stall': ({topic, seconds}: {topic: string; seconds: number | null}): void =>
      BROKER.stall(topic === '' ? null : topic, seconds),
    'kafka.resume': (topic: string): void => {
      BROKER.resume(topic === '' ? null : topic);
      settleProducers();
    },
    'kafka.loseAcks': ({topic, times}: {topic: string; times: number}): void => BROKER.loseAcks(topic, times),
    'kafka.failover': (topic: string): number => {
      BROKER.failover(topic === '' ? null : topic);
      const last = BROKER.events[BROKER.events.length - 1];
      return Number(last[2] ?? 0);
    },
    'kafka.events': (kinds: string[]): Record<string, unknown>[] =>
      BROKER.events.filter(e => kinds.length === 0 || kinds.includes(e[0] as string)).map(eventOf),
    'kafka.consumers': (): unknown[] => created.map(c => c.info()),
  };

  // Every call is the program's: a hook it triggers runs on its thread, before the call returns.
  const wrapped = Object.fromEntries(
    Object.entries(calls).map(([op, handler]) => [
      op,
      (request: never): unknown => {
        depth += 1;
        try {
          return handler(request);
        } finally {
          depth -= 1;
        }
      },
    ]),
  );

  return {
    calls: wrapped,
    stop: async () => {
      LIVE.delete(clients);
      for (const p of clients.producers.values()) p.closed = true;
      for (const c of clients.consumers.values()) c.closed = true;
    },
  };
}
