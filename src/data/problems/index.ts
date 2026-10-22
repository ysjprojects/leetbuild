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
import {embeddingServiceProblem} from './23-embedding-service/index';
import {vectorSearchProblem} from './24-vector-search/index';
import {promptRegistryProblem} from './25-prompt-registry/index';
import {costMeterProblem} from './26-cost-meter/index';
import {feedbackCollectorProblem} from './27-feedback-collector/index';
import {distillationPipelineProblem} from './28-distillation-pipeline/index';
import {batchInferenceProblem} from './29-batch-inference/index';
import {multimodalIngestProblem} from './30-multimodal-ingest/index';
import {voiceAgentProblem} from './31-voice-agent/index';
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
import {ticketingSystemProblem} from './96-ticketing-system/index';
import {formServiceProblem} from './97-form-service/index';
import {approvalWorkflowProblem} from './98-approval-workflow/index';
import {mapsRoutingProblem} from './99-maps-routing/index';
import {fleetTrackingProblem} from './100-fleet-tracking/index';
import {telemetryIngestProblem} from './101-telemetry-ingest/index';
import {iotHubProblem} from './102-iot-hub/index';
import {gameMatchmakingProblem} from './103-game-matchmaking/index';
import {mediaTranscoderProblem} from './104-media-transcoder/index';
import {autocompleteServiceProblem} from './105-autocomplete-service/index';
import {dedupeServiceProblem} from './106-dedupe-service/index';
import {secretsRotationProblem} from './107-secrets-rotation/index';
import {identityServiceProblem} from './108-identity-service/index';
import {permissionServiceProblem} from './109-permission-service/index';
import {usageMeteringProblem} from './110-usage-metering/index';
import {resumableUploadProblem} from './111-resumable-upload/index';
import {invoiceServiceProblem} from './112-invoice-service/index';
import {shipmentTrackingProblem} from './113-shipment-tracking/index';
import {returnsProcessingProblem} from './114-returns-processing/index';
import {adServingProblem} from './115-ad-serving/index';
import {realtimeBiddingProblem} from './116-realtime-bidding/index';
import {dynamicPricingProblem} from './117-dynamic-pricing/index';
import {copilotContextProblem} from './118-copilot-context/index';
import {aiFirewallProblem} from './119-ai-firewall/index';
import {textToSqlProblem} from './120-text-to-sql/index';
import {supportAutomationProblem} from './121-support-automation/index';
import {dataClassificationProblem} from './122-data-classification/index';
import {researchOrchestratorProblem} from './123-research-orchestrator/index';
import {merchantAgentProblem} from './124-merchant-agent/index';
import {fairHousingGuardrailProblem} from './125-fair-housing-guardrail/index';
import {catalogEnrichmentProblem} from './126-catalog-enrichment/index';
import {promptDefenceProblem} from './127-prompt-defence/index';
import {redisFixedWindowLimitProblem} from './128-redis-fixed-window-limit/index';
import {redisSessionStoreProblem} from './129-redis-session-store/index';
import {redisLeaderboardProblem} from './130-redis-leaderboard/index';
import {redisLeaseLockProblem} from './131-redis-lease-lock/index';
import {redisCacheAsideProblem} from './132-redis-cache-aside/index';
import {redisSlidingWindowLuaProblem} from './133-redis-sliding-window-lua/index';
import {redisTokenBucketLuaProblem} from './134-redis-token-bucket-lua/index';
import {redisReliableQueueProblem} from './135-redis-reliable-queue/index';
import {redisDelayedJobsProblem} from './136-redis-delayed-jobs/index';
import {redisGeoPresenceProblem} from './137-redis-geo-presence/index';
import {kafkaKeyedProducerProblem} from './138-kafka-keyed-producer/index';
import {kafkaCommitAfterProcessingProblem} from './139-kafka-commit-after-processing/index';
import {kafkaBatchConsumerProblem} from './140-kafka-batch-consumer/index';
import {kafkaIdempotentProducerProblem} from './141-kafka-idempotent-producer/index';
import {kafkaRetryDlqProblem} from './142-kafka-retry-dlq/index';
import {kafkaBackpressurePauseProblem} from './143-kafka-backpressure-pause/index';
import {kafkaReplayFromOffsetProblem} from './144-kafka-replay-from-offset/index';
import {kafkaTumblingWindowProblem} from './145-kafka-tumbling-window/index';
import {kafkaOffsetWatermarkProblem} from './146-kafka-offset-watermark/index';
import {kafkaConsumeTransformProduceProblem} from './147-kafka-consume-transform-produce/index';
import {kafkaAsyncAckTrackingProblem} from './148-kafka-async-ack-tracking/index';
import {kafkaTieredRetryDelaysProblem} from './149-kafka-tiered-retry-delays/index';
import {kafkaChangelogRestoreProblem} from './150-kafka-changelog-restore/index';
import {kafkaOrderedMergeWatermarkProblem} from './151-kafka-ordered-merge-watermark/index';
import {kafkaGracefulShutdownProblem} from './152-kafka-graceful-shutdown/index';
import {ptStableSoftmaxProblem} from './153-pt-stable-softmax/index';
import {ptSgdMomentumProblem} from './154-pt-sgd-momentum/index';
import {ptLayernormRmsnormProblem} from './155-pt-layernorm-rmsnorm/index';
import {ptAdamwProblem} from './156-pt-adamw/index';
import {ptRopeProblem} from './157-pt-rope/index';
import {ptCausalAttentionProblem} from './158-pt-causal-attention/index';
import {ptGpt2BlockProblem} from './159-pt-gpt2-block/index';
import {ptLrScheduleClipProblem} from './160-pt-lr-schedule-clip/index';
import {ptBpeTokenizerProblem} from './161-pt-bpe-tokenizer/index';
import {ptGpt2Problem} from './162-pt-gpt2/index';
import {ptFlashAttentionTiledProblem} from './163-pt-flash-attention-tiled/index';
import {ptDdpmProblem} from './164-pt-ddpm/index';
import {ptLoraProblem} from './165-pt-lora/index';
import {ptMixedPrecisionProblem} from './166-pt-mixed-precision/index';
import {ptMoeRouterProblem} from './167-pt-moe-router/index';
import {cudaVectorAddProblem} from './168-cuda-vector-add/index';
import {cudaFusedGeluProblem} from './169-cuda-fused-gelu/index';
import {cudaReductionProblem} from './170-cuda-reduction/index';
import {cudaTiledMatmulProblem} from './171-cuda-tiled-matmul/index';
import {cudaRowSoftmaxProblem} from './172-cuda-row-softmax/index';
import {cudaLayernormWelfordProblem} from './173-cuda-layernorm-welford/index';
import {cudaFlashAttentionProblem} from './174-cuda-flash-attention/index';
import {cudaWmmaMatmulProblem} from './175-cuda-wmma-matmul/index';
import {cudaPrefixScanProblem} from './176-cuda-prefix-scan/index';
import {cudaStreamsOverlapProblem} from './177-cuda-streams-overlap/index';

/**
 * Problem order on the list page: the classic systems track first, in its catalogue order, then the
 * deep-learning track (PyTorch, then CUDA, each by difficulty), then the AI-era track in the order
 * its courses were added (the directory numbers). The list's track tabs show each on its own; "All
 * topics" shows this order. Company-tagged courses (derived from engineering blogs, see
 * `Problem.company`) and the single-topic drills (one concept, one step) sit with the courses of
 * their difficulty, after them.
 */
export const problems: Problem[] = [
  dropboxGatesProblem,
  urlShortenerProblem,
  edgeGatewayProblem,
  redisFixedWindowLimitProblem,
  redisSessionStoreProblem,
  kafkaKeyedProducerProblem,
  kafkaCommitAfterProcessingProblem,
  kafkaBatchConsumerProblem,
  imageCacheProblem,
  liveChatProblem,
  notificationsProblem,
  redditPlaceProblem,
  netflixCountersProblem,
  doordashSupportProblem,
  redisLeaderboardProblem,
  redisLeaseLockProblem,
  redisCacheAsideProblem,
  kafkaIdempotentProducerProblem,
  kafkaRetryDlqProblem,
  kafkaBackpressurePauseProblem,
  kafkaReplayFromOffsetProblem,
  kafkaTumblingWindowProblem,
  kafkaOffsetWatermarkProblem,
  matchEngineProblem,
  merchantPaymentsProblem,
  flashSaleProblem,
  newsFeedProblem,
  rideDispatchProblem,
  discordMessagesProblem,
  stripeLedgerProblem,
  redisSlidingWindowLuaProblem,
  redisTokenBucketLuaProblem,
  redisReliableQueueProblem,
  redisDelayedJobsProblem,
  redisGeoPresenceProblem,
  kafkaConsumeTransformProduceProblem,
  kafkaAsyncAckTrackingProblem,
  kafkaTieredRetryDelaysProblem,
  kafkaChangelogRestoreProblem,
  kafkaOrderedMergeWatermarkProblem,
  kafkaGracefulShutdownProblem,
  ptStableSoftmaxProblem,
  ptSgdMomentumProblem,
  ptLayernormRmsnormProblem,
  ptAdamwProblem,
  ptRopeProblem,
  ptCausalAttentionProblem,
  ptGpt2BlockProblem,
  ptLrScheduleClipProblem,
  ptBpeTokenizerProblem,
  ptGpt2Problem,
  ptFlashAttentionTiledProblem,
  ptDdpmProblem,
  ptLoraProblem,
  ptMixedPrecisionProblem,
  ptMoeRouterProblem,
  cudaVectorAddProblem,
  cudaFusedGeluProblem,
  cudaReductionProblem,
  cudaTiledMatmulProblem,
  cudaRowSoftmaxProblem,
  cudaLayernormWelfordProblem,
  cudaFlashAttentionProblem,
  cudaWmmaMatmulProblem,
  cudaPrefixScanProblem,
  cudaStreamsOverlapProblem,
  aiGatewayProblem,
  ragServiceProblem,
  modelRouterProblem,
  chatMemoryProblem,
  evalHarnessProblem,
  embeddingServiceProblem,
  vectorSearchProblem,
  promptRegistryProblem,
  costMeterProblem,
  feedbackCollectorProblem,
  distillationPipelineProblem,
  batchInferenceProblem,
  multimodalIngestProblem,
  voiceAgentProblem,
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
  ticketingSystemProblem,
  formServiceProblem,
  approvalWorkflowProblem,
  mapsRoutingProblem,
  fleetTrackingProblem,
  telemetryIngestProblem,
  iotHubProblem,
  gameMatchmakingProblem,
  mediaTranscoderProblem,
  autocompleteServiceProblem,
  dedupeServiceProblem,
  secretsRotationProblem,
  identityServiceProblem,
  permissionServiceProblem,
  usageMeteringProblem,
  resumableUploadProblem,
  invoiceServiceProblem,
  shipmentTrackingProblem,
  returnsProcessingProblem,
  adServingProblem,
  realtimeBiddingProblem,
  dynamicPricingProblem,
  copilotContextProblem,
  aiFirewallProblem,
  textToSqlProblem,
  supportAutomationProblem,
  dataClassificationProblem,
  researchOrchestratorProblem,
  merchantAgentProblem,
  fairHousingGuardrailProblem,
  catalogEnrichmentProblem,
  promptDefenceProblem,
];
