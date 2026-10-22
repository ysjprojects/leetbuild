import type {FC} from 'react';

import type {WidgetRenderer} from '../Markdown';
import AttentionHeatmap from './AttentionHeatmap';
import BankConflicts from './BankConflicts';
import BpeMerges from './BpeMerges';
import CacheAside from './CacheAside';
import Coalescing from './Coalescing';
import ConsumerGroups from './ConsumerGroups';
import CudaGrid from './CudaGrid';
import DeadlineRetry from './DeadlineRetry';
import DeliverySemantics from './DeliverySemantics';
import DiffusionNoise from './DiffusionNoise';
import DpoLoss from './DpoLoss';
import FloatFormats from './FloatFormats';
import GqaHeads from './GqaHeads';
import GradClip from './GradClip';
import GrpcStreams from './GrpcStreams';
import GrpoAdvantages from './GrpoAdvantages';
import HttpLifecycle from './HttpLifecycle';
import Idempotency from './Idempotency';
import Int4Quant from './Int4Quant';
import KafkaPartitions from './KafkaPartitions';
import KvCache from './KvCache';
import LoraRank from './LoraRank';
import LrSchedule from './LrSchedule';
import ModelSize from './ModelSize';
import MoeRouting from './MoeRouting';
import NormCompare from './NormCompare';
import Nvfp4Block from './Nvfp4Block';
import OnlineSoftmax from './OnlineSoftmax';
import OptimizerPaths from './OptimizerPaths';
import OrderBook from './OrderBook';
import Outbox from './Outbox';
import PagedKv from './PagedKv';
import PercentRollout from './PercentRollout';
import Roofline from './Roofline';
import RopeRotation from './RopeRotation';
import Sampling from './Sampling';
import ScanSweep from './ScanSweep';
import SequencePacking from './SequencePacking';
import SoftmaxStability from './SoftmaxStability';
import SpeculativeDecoding from './SpeculativeDecoding';
import StatusCodes from './StatusCodes';
import StochasticRounding from './StochasticRounding';
import StreamTimeline from './StreamTimeline';
import TensorParallel from './TensorParallel';
import TiledMatmul from './TiledMatmul';
import TokenBucket from './TokenBucket';
import VarianceCancellation from './VarianceCancellation';
import WarpReduce from './WarpReduce';
import ZeroMemory from './ZeroMemory';

/** Every widget receives the JSON object written after its name in `:::widget name {...}`. */
export interface WidgetProps {
  params: Record<string, unknown>;
}

/** Names must match src/leetbuild/widgets.ts (the catalog problem authors see). */
export const WIDGET_COMPONENTS: Record<string, FC<WidgetProps>> = {
  'http-lifecycle': HttpLifecycle,
  'status-codes': StatusCodes,
  idempotency: Idempotency,
  'grpc-streams': GrpcStreams,
  'deadline-retry': DeadlineRetry,
  'kafka-partitions': KafkaPartitions,
  'consumer-groups': ConsumerGroups,
  'delivery-semantics': DeliverySemantics,
  'cache-aside': CacheAside,
  'token-bucket': TokenBucket,
  outbox: Outbox,
  'order-book': OrderBook,
  'percent-rollout': PercentRollout,
  // deep learning
  'softmax-stability': SoftmaxStability,
  sampling: Sampling,
  'attention-heatmap': AttentionHeatmap,
  'online-softmax': OnlineSoftmax,
  'kv-cache': KvCache,
  'paged-kv': PagedKv,
  'rope-rotation': RopeRotation,
  'model-size': ModelSize,
  'optimizer-paths': OptimizerPaths,
  'lr-schedule': LrSchedule,
  'grad-clip': GradClip,
  'norm-compare': NormCompare,
  'variance-cancellation': VarianceCancellation,
  'float-formats': FloatFormats,
  'bpe-merges': BpeMerges,
  'diffusion-noise': DiffusionNoise,
  'lora-rank': LoraRank,
  'moe-routing': MoeRouting,
  'dpo-loss': DpoLoss,
  'sequence-packing': SequencePacking,
  'int4-quant': Int4Quant,
  'nvfp4-block': Nvfp4Block,
  'stochastic-rounding': StochasticRounding,
  'speculative-decoding': SpeculativeDecoding,
  'grpo-advantages': GrpoAdvantages,
  'gqa-heads': GqaHeads,
  'zero-memory': ZeroMemory,
  'tensor-parallel': TensorParallel,
  'cuda-grid': CudaGrid,
  coalescing: Coalescing,
  roofline: Roofline,
  'warp-reduce': WarpReduce,
  'bank-conflicts': BankConflicts,
  'scan-sweep': ScanSweep,
  'tiled-matmul': TiledMatmul,
  'stream-timeline': StreamTimeline,
};

export const renderWidget: WidgetRenderer = (name, params) => {
  const Component = WIDGET_COMPONENTS[name];
  if (Component === undefined) {
    return (
      <div className="border-danger-400/60 text-danger-200 rounded-lg border border-dashed p-3 text-[12px]">
        unknown widget: {name}
      </div>
    );
  }
  return <Component params={params} />;
};
