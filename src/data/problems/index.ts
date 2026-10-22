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
import {knowledgeGraphProblem} from './40-knowledge-graph/index';
import {quotaBrokerProblem} from './41-quota-broker/index';
import {modelAuditProblem} from './42-model-audit/index';
import {promptCacheProblem} from './43-prompt-cache/index';
import {toolRegistryProblem} from './44-tool-registry/index';
import {visionInferenceProblem} from './45-vision-inference/index';
import {transcriptionServiceProblem} from './46-transcription-service/index';
import {translationServiceProblem} from './47-translation-service/index';
import {contentClassifierProblem} from './48-content-classifier/index';
import {labelingServiceProblem} from './49-labeling-service/index';
import {datasetRegistryProblem} from './50-dataset-registry/index';
import {trainingSchedulerProblem} from './51-training-scheduler/index';
import {gpuSchedulerProblem} from './52-gpu-scheduler/index';
import {modelRegistryProblem} from './53-model-registry/index';
import {checkpointStoreProblem} from './54-checkpoint-store/index';
import {featureStoreProblem} from './55-feature-store/index';
import {driftMonitorProblem} from './56-drift-monitor/index';
import {shadowEvalProblem} from './57-shadow-eval/index';
import {promptFirewallProblem} from './58-prompt-firewall/index';
import {citationStoreProblem} from './59-citation-store/index';
import {rerankerServiceProblem} from './60-reranker-service/index';
import {summarizerServiceProblem} from './61-summarizer-service/index';
import {semanticCacheProblem} from './62-semantic-cache/index';
import {humanReviewQueueProblem} from './63-human-review-queue/index';
import {fineTuneOrchestratorProblem} from './64-fine-tune-orchestrator/index';
import {redTeamRunnerProblem} from './65-red-team-runner/index';
import {sandboxRunnerProblem} from './66-sandbox-runner/index';
import {syntheticDataProblem} from './67-synthetic-data/index';
import {browserAgentProblem} from './68-browser-agent/index';
import {bookingEngineProblem} from './69-booking-engine/index';
import {inventoryServiceProblem} from './70-inventory-service/index';
import {refundServiceProblem} from './71-refund-service/index';
import {productSearchProblem} from './72-product-search/index';
import {sessionStoreProblem} from './73-session-store/index';
import {metricsPipelineProblem} from './74-metrics-pipeline/index';
import {logIndexerProblem} from './75-log-indexer/index';
import {traceCollectorProblem} from './76-trace-collector/index';
import {jobQueueProblem} from './77-job-queue/index';
import {workflowEngineProblem} from './78-workflow-engine/index';
import {cronSchedulerProblem} from './79-cron-scheduler/index';
import {featureFlagsProblem} from './80-feature-flags/index';
import {experimentsPlatformProblem} from './81-experiments-platform/index';
import {fraudScoringProblem} from './82-fraud-scoring/index';
import {kycVerificationProblem} from './83-kyc-verification/index';
import {productCatalogProblem} from './84-product-catalog/index';
import {warehouseLoaderProblem} from './85-warehouse-loader/index';
import {cdcStreamerProblem} from './86-cdc-streamer/index';
import {replicatorProblem} from './87-replicator/index';
import {cdnPurgeProblem} from './88-cdn-purge/index';
import {serviceDiscoveryProblem} from './89-service-discovery/index';
import {emailDeliveryProblem} from './90-email-delivery/index';
import {calendarServiceProblem} from './91-calendar-service/index';
import {fileStorageProblem} from './92-file-storage/index';
import {syncEngineProblem} from './93-sync-engine/index';
import {commentsServiceProblem} from './94-comments-service/index';
import {subscriptionBillingProblem} from './95-subscription-billing/index';

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
  knowledgeGraphProblem,
  quotaBrokerProblem,
  modelAuditProblem,
  promptCacheProblem,
  toolRegistryProblem,
  visionInferenceProblem,
  transcriptionServiceProblem,
  translationServiceProblem,
  contentClassifierProblem,
  labelingServiceProblem,
  datasetRegistryProblem,
  trainingSchedulerProblem,
  gpuSchedulerProblem,
  modelRegistryProblem,
  checkpointStoreProblem,
  featureStoreProblem,
  driftMonitorProblem,
  shadowEvalProblem,
  promptFirewallProblem,
  citationStoreProblem,
  rerankerServiceProblem,
  summarizerServiceProblem,
  semanticCacheProblem,
  humanReviewQueueProblem,
  fineTuneOrchestratorProblem,
  redTeamRunnerProblem,
  sandboxRunnerProblem,
  syntheticDataProblem,
  browserAgentProblem,
  bookingEngineProblem,
  inventoryServiceProblem,
  refundServiceProblem,
  productSearchProblem,
  sessionStoreProblem,
  metricsPipelineProblem,
  logIndexerProblem,
  traceCollectorProblem,
  jobQueueProblem,
  workflowEngineProblem,
  cronSchedulerProblem,
  featureFlagsProblem,
  experimentsPlatformProblem,
  fraudScoringProblem,
  kycVerificationProblem,
  productCatalogProblem,
  warehouseLoaderProblem,
  cdcStreamerProblem,
  replicatorProblem,
  cdnPurgeProblem,
  serviceDiscoveryProblem,
  emailDeliveryProblem,
  calendarServiceProblem,
  fileStorageProblem,
  syncEngineProblem,
  commentsServiceProblem,
  subscriptionBillingProblem,
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
