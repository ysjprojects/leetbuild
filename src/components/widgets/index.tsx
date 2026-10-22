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
import FloatFormats from './FloatFormats';
import GradClip from './GradClip';
import GrpcStreams from './GrpcStreams';
import HttpLifecycle from './HttpLifecycle';
import Idempotency from './Idempotency';
import KafkaPartitions from './KafkaPartitions';
import KvCache from './KvCache';
import LoraRank from './LoraRank';
import LrSchedule from './LrSchedule';
import ModelSize from './ModelSize';
import MoeRouting from './MoeRouting';
import NormCompare from './NormCompare';
import OnlineSoftmax from './OnlineSoftmax';
import OptimizerPaths from './OptimizerPaths';
import OrderBook from './OrderBook';
import Outbox from './Outbox';
import PercentRollout from './PercentRollout';
import Roofline from './Roofline';
import RopeRotation from './RopeRotation';
import Sampling from './Sampling';
import ScanSweep from './ScanSweep';
import SoftmaxStability from './SoftmaxStability';
import StatusCodes from './StatusCodes';
import StreamTimeline from './StreamTimeline';
import TiledMatmul from './TiledMatmul';
import TokenBucket from './TokenBucket';
import VarianceCancellation from './VarianceCancellation';
import WarpReduce from './WarpReduce';

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
