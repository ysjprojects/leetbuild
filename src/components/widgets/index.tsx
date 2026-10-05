import type {FC} from 'react';

import type {WidgetRenderer} from '../Markdown';
import CacheAside from './CacheAside';
import ConsumerGroups from './ConsumerGroups';
import DeadlineRetry from './DeadlineRetry';
import DeliverySemantics from './DeliverySemantics';
import GrpcStreams from './GrpcStreams';
import HttpLifecycle from './HttpLifecycle';
import Idempotency from './Idempotency';
import KafkaPartitions from './KafkaPartitions';
import OrderBook from './OrderBook';
import Outbox from './Outbox';
import StatusCodes from './StatusCodes';
import TokenBucket from './TokenBucket';

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
