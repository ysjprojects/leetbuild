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

/**
 * Problem order on the list page: the core courses easy first, then medium, then hard; then the
 * company-tagged courses (derived from engineering blogs, see `Problem.company`) in the same order.
 */
export const problems: Problem[] = [
  urlShortenerProblem,
  edgeGatewayProblem,
  imageCacheProblem,
  liveChatProblem,
  notificationsProblem,
  matchEngineProblem,
  merchantPaymentsProblem,
  flashSaleProblem,
  newsFeedProblem,
  rideDispatchProblem,
  redditPlaceProblem,
  netflixCountersProblem,
  discordMessagesProblem,
  stripeLedgerProblem,
];
