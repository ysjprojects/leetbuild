import {CLOUDFLARE} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {chatProxyStep} from './steps/1-chat-proxy';
import {keyLimitsStep} from './steps/2-key-limits';
import {promptDetectStep} from './steps/3-prompt-detect';
import {firewallEventsStep} from './steps/4-firewall-events';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Cloudflare's Firewall for AI: the WAF-style layer in front of an LLM application, as one program
 * of four files the learner debugs. The proxy finds the prompt by a configured JSON path, caps it
 * and acts on the decision → one atomic per-key window ahead of the handler → a 1–99 injection
 * score plus topic tags under a 150 ms deadline, failing closed → one idempotent event per decision
 * on a key-hashed topic, with the response scanned for card numbers and API keys first. The
 * detector and the application are gRPC stand-ins the harness serves.
 */
export const aiFirewallProblem: Problem = {
  id: 'ai-firewall',
  title: 'AI Firewall',
  tagline:
    "Cloudflare's Firewall for AI: a proxy that scores every prompt 1–99, limits every key, fails closed and redacts card numbers from the answer.",
  difficulty: 'easy',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 45,
  company: CLOUDFLARE,
  sources: [
    {
      title: 'Cloudflare announces Firewall for AI',
      url: 'https://blog.cloudflare.com/firewall-for-ai/',
      by: 'Daniele Molteni',
      date: '2024-03-04',
      takes:
        'The whole shape of the course: a WAF-style layer in front of any LLM application that finds the prompt at a configured place in the JSON body, scores it 1–99 for injection likelihood (1 the most likely) with topic tags for rules to block on, rate-limits per IP or API key against model denial of service, and runs Sensitive Data Detection on the response for card numbers and API keys — all framed by the OWASP Top 10 for LLMs.',
    },
    {
      title: 'Announcing AI Gateway: making AI applications more observable, reliable, and scalable',
      url: 'https://blog.cloudflare.com/announcing-ai-gateway/',
      by: "Michelle Chen, Yo'av Moshe",
      date: '2023-09-27',
      takes:
        'The proxy posture the firewall sits beside: one URL swap puts a layer between the app and the model provider that logs every request, applies rate limits, and — in the enterprise direction the post sketches — redacts or blocks a pasted API key before it ever reaches the provider.',
    },
  ],
  statement: `# AI Firewall

An assistant went live on a model you do not own. One caller pasted "ignore your instructions",
another sent the same prompt four thousand times, and an answer carried a card number. Nothing
stood in front of the application.

## The real system

Cloudflare's **Firewall for AI** (now AI Security for Apps) writes each prompt's injection score,
1 to 99 with 1 the most likely, into the rule field \`cf.llm.prompt.injection_score\`, so a
WAF rule like \`injection_score lt 20\` blocks, challenges or logs; its Sensitive Data Detection
ruleset scans the model's responses.

## From the source

*Cloudflare announces Firewall for AI* (Daniele Molteni, March 2024) gives this course its
mechanisms. The firewall finds the prompt in the HTTP request automatically or at a place in the
JSON body the customer configures: step 1's \`PROMPT_PATH\`. Every prompt gets a **score from 1 to
99** for the likelihood of a prompt injection, **1 the most likely**, plus **tags** from predefined
categories (offensive language, religion, sexual content, politics are the examples), and customers
write rules that block on either: step 3's threshold and tag rules. It names **model denial of
service** and answers it with rate limiting per IP address or API key: step 2's window. It
describes **Sensitive Data Detection** as a managed ruleset scanning the model's responses for
financial data such as card numbers and secrets such as API keys: step 4's redaction. The post
gives no deadline, threshold or cap; 150 ms, block below 20, 120 requests per minute and 64 KiB
are this course's choices. *Announcing AI Gateway* (Michelle Chen and Yo'av Moshe, September 2023)
adds the proxy posture: swap one URL and every model call passes through a layer that logs and
limits it.

## What you build here

One service, **aifw**, four files, one program:

1. \`firewall_api\`: \`POST /v1/chat\`. 401 without a key, a request id end to end, the prompt at
   \`PROMPT_PATH\` (400; 413 past 64 KiB), 403 on \`block\`, the provided \`forward\`, \`finish\` on
   every decision.
2. \`rate_limit\`: a middleware on that app. 120 requests per 60 s window per key in one Lua \`EVAL\`,
   429 with \`Retry-After\`, ahead of the handler.
3. \`detect\`: \`decide(prompt, request_id, fail_open)\` with a 150 ms deadline; block below 20 or on
   a forbidden tag; fail closed.
4. \`events\`: \`finish(…)\`: one idempotent \`ai.firewall.events\` record keyed by the key's SHA-256,
   the response redacted first.

## Left out on purpose

The detector model, bot and attack scores, per-IP limits, custom fingerprints, request-phase
scanning and the rules control plane.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'POST /v1/chat · X-Api-Key', x: 8, y: 50},
      {id: 'aifw', kind: 'http', label: 'aifw', sub: 'rate_limit → firewall_api', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'aifw:rl:{key}:{window}', x: 50, y: 14},
      {id: 'guard', kind: 'grpc', label: 'PromptGuard', sub: 'Detect → score · tags', x: 50, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'ai.firewall.events', sub: 'key = sha256(api key)', x: 50, y: 86},
      {id: 'app', kind: 'grpc', label: 'LLM app', sub: 'Assistant.Chat · forward', x: 74, y: 50},
    ],
    edges: [
      {from: 'client', to: 'aifw', kind: 'http', label: 'HTTPS'},
      {from: 'aifw', to: 'redis', kind: 'redis', label: 'EVAL limit'},
      {from: 'aifw', to: 'guard', kind: 'grpc', label: 'decide · 150 ms'},
      {from: 'aifw', to: 'app', kind: 'grpc', label: 'forward when allowed'},
      {from: 'aifw', to: 'kafka', kind: 'kafka', label: 'finish · produce'},
    ],
  },
  steps: [chatProxyStep, keyLimitsStep, promptDetectStep, firewallEventsStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
