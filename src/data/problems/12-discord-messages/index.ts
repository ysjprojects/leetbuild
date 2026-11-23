import {DISCORD} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {protoFiles, protoModules} from './proto';
import {postMessageStep} from './steps/1-post-message';
import {readMessagesStep} from './steps/2-read-messages';
import {dataServiceStep} from './steps/3-data-service';
import {channelRoutingStep} from './steps/4-channel-routing';
import {messageEventsStep} from './steps/5-message-events';
import {hotChannelsStep} from './steps/6-hot-channels';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesTs} from './support';

/**
 * Discord's message store, from the two posts that describe it: snowflake ids and (channel, bucket)
 * partitions → a page read that walks buckets backwards → a gRPC data service that coalesces
 * identical concurrent reads → consistent-hash routing so one channel's reads land on one instance →
 * message events through Kafka into per-channel state in Redis → the newest page of a hot channel
 * cached write-through in a Redis list.
 */
export const discordMessagesProblem: Problem = {
  id: 'discord-messages',
  title: 'Message Storage',
  tagline:
    "Discord's trillion-message store — snowflake ids, time-bucketed partitions, a data service that coalesces identical reads and routes by channel, events to Kafka, hot channels in Redis.",
  difficulty: 'hard',
  concepts: ['http', 'grpc', 'kafka', 'redis'],
  minutes: 110,
  company: DISCORD,
  sources: [
    {
      title: 'How Discord Stores Trillions of Messages',
      url: 'https://discord.com/blog/how-discord-stores-trillions-of-messages',
      by: 'Bo Ingram',
      date: '2023-03-06',
      takes:
        'The data services in front of the database — request coalescing so concurrent identical reads become one query, and consistent-hash routing so every request for a channel lands on one instance — built here as steps 3 and 4.',
    },
    {
      title: 'How Discord Stores Billions of Messages',
      url: 'https://discord.com/blog/how-discord-stores-billions-of-messages',
      by: 'Stanislav Vishnevskiy',
      date: '2017-01-13',
      takes:
        'The schema: messages keyed by (channel_id, bucket, message_id) with snowflake ids and 10-day buckets, read by walking buckets backwards from the newest while remembering the empty ones — steps 1 and 2.',
    },
  ],
  statement: `# Message Storage

Every message ever sent has to be kept, and the newest fifty of any channel have to come back in a few
milliseconds whether the channel has three messages or three hundred million — while a goal in a
World Cup final makes a million people open the same channel at once.

## The real system

Discord's message store: a Cassandra cluster that grew from 12 nodes in 2017 to 177 by 2022, then a
ScyllaDB cluster of 72, trillions of rows, fronted by Rust data services. Around it: full-text search,
mentions and pins that jump into a year-old history, edits and deletes with tombstone budgets, and a
migration of every row with no downtime.

## From the source

*How Discord Stores Billions of Messages* (2017) explains the schema that still holds: every id is a
snowflake, so sorting by id sorts by time, and messages are partitioned by \`(channel_id, bucket)\`
where a bucket is a 10-day window of snowflake time — one channel's recent history sits together on
disk. Reading a page means starting at the bucket of the newest wanted message and walking older
buckets until the page is full, which is cheap for busy channels and a chain of empty reads for quiet
ones; the fix was to remember which buckets of a channel are empty. Steps 1 and 2 rebuild the ids, the
buckets, and that walk.

*How Discord Stores Trillions of Messages* (2023) is about what stands in front of the database: hot
partitions, when a popular channel's reads pile onto one node and drag the whole cluster's latency
with them. Discord put gRPC **data services** between the API and the database with one trick —
**request coalescing**: identical concurrent queries subscribe to one in-flight database read — and
one supporting trick, **consistent-hash routing** by channel id, so every request for a channel reaches
the same instance and has something to coalesce with. Steps 3 and 4 rebuild both. Steps 5 and 6 add
what the posts leave implicit: the event stream that fans a stored message out, and the cache that
keeps a hot channel's newest page out of the database altogether.

## What you build here

One API, **messages-api**, three **data-service** instances, a **channel-state** worker, Postgres,
Redis and Kafka:

1. \`POST /channels/{id}/messages\` minting a **snowflake** id, deriving its 10-day **bucket**, and
   inserting into \`(channel_id, bucket, message_id)\` — **201** with the id as a string.
2. \`GET /channels/{id}/messages?before=&limit=\` reading newest-first and **walking buckets
   backwards** to the channel's creation bucket, remembering the empty ones.
3. A \`MessageData.GetMessages\` gRPC **data service** that **coalesces** identical concurrent requests
   into one database read shared by every caller.
4. The API's client side: a **consistent hash ring** of data-service instances with virtual nodes, so
   one channel's reads always hit one instance, under a **300 ms** deadline.
5. One \`message-events\` record per stored message, **keyed by channel**, and a consumer in group
   \`channel-state\` keeping \`channel:{id}\` (last message id, count) in Redis, committing after the write.
6. The newest page of a hot channel in a Redis list, **write-through** on \`POST\` (\`LPUSH\`, \`LTRIM 0 99\`,
   \`EXPIRE 300\`) and served by \`GET\` when it holds the whole page.

## Left out on purpose

Edits and deletes (and the tombstones they cost), permissions and rate limits, search, attachments, the
gateway that pushes messages to connected clients, replication across data centres, and the migration
itself. The six mechanisms above are the ones that decide whether the store survives the next big
channel.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'POST · GET /channels/{id}/messages', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'messages-api', sub: 'HTTPS :8443 · hash ring', x: 24, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'recent:{channel} · channel:{id}', x: 46, y: 12},
      {id: 'data', kind: 'grpc', label: 'data-service ×3', sub: 'GetMessages · coalesced', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'message-events', sub: 'key = channel id', x: 46, y: 88},
      {id: 'db', kind: 'db', label: 'messages', sub: '(channel_id, bucket) · message_id', x: 68, y: 50},
      {id: 'worker', kind: 'service', label: 'channel-state', sub: 'consumer group', x: 68, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'data', kind: 'grpc', label: 'GetMessages · ring(channel_id)'},
      {from: 'api', to: 'db', kind: 'plain', label: 'INSERT'},
      {from: 'data', to: 'db', kind: 'plain', label: 'SELECT one bucket'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'LRANGE · LPUSH'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce'},
      {from: 'kafka', to: 'worker', kind: 'kafka', label: 'consume'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'HSET · HINCRBY'},
    ],
  },
  steps: [postMessageStep, readMessagesStep, dataServiceStep, channelRoutingStep, messageEventsStep, hotChannelsStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
  },
  learn,
};
