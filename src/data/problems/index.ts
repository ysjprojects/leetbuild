import type {Problem} from '@/lib/types';

import {imageCacheProblem} from './00-image-cache/index';
import {matchEngineProblem} from './01-match-engine/index';
import {merchantPaymentsProblem} from './02-merchant-payments/index';
import {edgeGatewayProblem} from './03-edge-gateway/index';
import {liveChatProblem} from './04-live-chat/index';
import {flashSaleProblem} from './05-flash-sale/index';
import {urlShortenerProblem} from './06-url-shortener/index';
import {notificationsProblem} from './07-notifications/index';
import {newsFeedProblem} from './08-news-feed/index';
import {rideDispatchProblem} from './09-ride-dispatch/index';
import {redditPlaceProblem} from './10-reddit-place/index';
import {netflixCountersProblem} from './11-netflix-counters/index';
import {discordMessagesProblem} from './12-discord-messages/index';
import {stripeLedgerProblem} from './13-stripe-ledger/index';
import {dropboxGatesProblem} from './14-dropbox-gates/index';
import {doordashSupportProblem} from './15-doordash-support/index';
import {aiGatewayProblem} from './16-ai-gateway/index';
import {ragServiceProblem} from './17-rag-service/index';
import {modelRouterProblem} from './18-model-router/index';
import {chatMemoryProblem} from './19-chat-memory/index';
import {evalHarnessProblem} from './20-eval-harness/index';
import {guardrailServiceProblem} from './21-guardrail-service/index';
import {agentOrchestratorProblem} from './22-agent-orchestrator/index';
import {embeddingServiceProblem} from './23-embedding-service/index';
import {vectorSearchProblem} from './24-vector-search/index';
import {promptRegistryProblem} from './25-prompt-registry/index';
import {costMeterProblem} from './26-cost-meter/index';
import {feedbackCollectorProblem} from './27-feedback-collector/index';
import {distillationPipelineProblem} from './28-distillation-pipeline/index';
import {batchInferenceProblem} from './29-batch-inference/index';
import {multimodalIngestProblem} from './30-multimodal-ingest/index';
import {voiceAgentProblem} from './31-voice-agent/index';
import {codeAssistantProblem} from './32-code-assistant/index';
import {sqlCopilotProblem} from './33-sql-copilot/index';
import {ticketTriageProblem} from './34-ticket-triage/index';
import {recommendationRankingProblem} from './35-recommendation-ranking/index';
import {moderationServiceProblem} from './36-moderation-service/index';
import {piiRedactorProblem} from './37-pii-redactor/index';
import {connectorHubProblem} from './38-connector-hub/index';
import {crawlIndexProblem} from './39-crawl-index/index';

/**
 * Problem order on the list page: the AI-era track first, then the classic systems track in its
 * catalogue order. Company-tagged courses (derived from engineering blogs, see `Problem.company`)
 * sit with the others of their difficulty.
 */
export const problems: Problem[] = [
  aiGatewayProblem,
  ragServiceProblem,
  modelRouterProblem,
  chatMemoryProblem,
  evalHarnessProblem,
  guardrailServiceProblem,
  agentOrchestratorProblem,
  embeddingServiceProblem,
  vectorSearchProblem,
  promptRegistryProblem,
  costMeterProblem,
  feedbackCollectorProblem,
  distillationPipelineProblem,
  batchInferenceProblem,
  multimodalIngestProblem,
  voiceAgentProblem,
  codeAssistantProblem,
  sqlCopilotProblem,
  ticketTriageProblem,
  recommendationRankingProblem,
  moderationServiceProblem,
  piiRedactorProblem,
  connectorHubProblem,
  crawlIndexProblem,
  dropboxGatesProblem,
  urlShortenerProblem,
  edgeGatewayProblem,
  imageCacheProblem,
  liveChatProblem,
  notificationsProblem,
  redditPlaceProblem,
  netflixCountersProblem,
  doordashSupportProblem,
  matchEngineProblem,
  merchantPaymentsProblem,
  flashSaleProblem,
  newsFeedProblem,
  rideDispatchProblem,
  discordMessagesProblem,
  stripeLedgerProblem,
];
