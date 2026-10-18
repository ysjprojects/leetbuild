/**
 * Runtime support modules for the match-engine course: the provided price-time `Book` that step 3
 * (`from book import Book, Order` / `import {Book} from 'book'`) matches orders against.
 */
export const supportModules: Record<string, string> = {
  'book.py': `"""
The provided limit order book: price-time priority.

Book().match(order) crosses the incoming order against the resting orders of the opposite side,
best price first and oldest first at one price, fills at the resting order's price, and rests any
remainder. It returns one Fill per resting order it traded against, in matching order.
"""
from dataclasses import dataclass


@dataclass
class Order:
    order_id: str
    symbol: str
    side: str
    price: float
    qty: int
    client_order_id: str


@dataclass
class Fill:
    symbol: str
    price: float
    qty: int
    buy_order_id: str
    sell_order_id: str
    taker_side: str


class Book:
    def __init__(self) -> None:
        self.bids: list[Order] = []  # best (highest) price first, oldest first within a price
        self.asks: list[Order] = []  # best (lowest) price first, oldest first within a price
        self.last: float = 0.0

    @property
    def bid(self) -> float:
        return self.bids[0].price if self.bids else 0.0

    @property
    def ask(self) -> float:
        return self.asks[0].price if self.asks else 0.0

    def top(self) -> tuple[float, float, float]:
        """(bid, ask, last) as the engine publishes them; 0 for an empty side or no trade yet."""
        return self.bid, self.ask, self.last

    def match(self, order: Order) -> list[Fill]:
        if order.side not in ("BUY", "SELL"):
            raise ValueError(f"unknown side {order.side!r}")
        buying = order.side == "BUY"
        resting = self.asks if buying else self.bids
        remaining = order.qty
        fills: list[Fill] = []
        while remaining > 0 and resting:
            best = resting[0]
            crosses = order.price >= best.price if buying else order.price <= best.price
            if not crosses:
                break
            qty = min(remaining, best.qty)
            buy_id, sell_id = (order.order_id, best.order_id) if buying else (best.order_id, order.order_id)
            fills.append(Fill(order.symbol, best.price, qty, buy_id, sell_id, order.side))
            self.last = best.price
            remaining -= qty
            best.qty -= qty
            if best.qty == 0:
                resting.pop(0)
        if remaining > 0:
            self._rest(Order(order.order_id, order.symbol, order.side, order.price, remaining, order.client_order_id))
        return fills

    def _rest(self, order: Order) -> None:
        side = self.bids if order.side == "BUY" else self.asks
        better = (lambda a, b: a > b) if order.side == "BUY" else (lambda a, b: a < b)
        index = len(side)
        for i, resting in enumerate(side):
            if better(order.price, resting.price):
                index = i
                break
        side.insert(index, order)
`,
};

/** The same `Book`, for the TypeScript runtime: `import {Book, type Order, type Fill} from 'book'`. */
export const supportModulesTs: Record<string, string> = {
  'book.ts': `/**
 * The provided limit order book: price-time priority.
 *
 * new Book().match(order) crosses the incoming order against the resting orders of the opposite
 * side, best price first and oldest first at one price, fills at the resting order's price, and
 * rests any remainder. It returns one Fill per resting order it traded against, in matching order.
 */
export interface Order {
  order_id: string;
  symbol: string;
  side: string;
  price: number;
  qty: number;
  client_order_id: string;
}

export interface Fill {
  symbol: string;
  price: number;
  qty: number;
  buy_order_id: string;
  sell_order_id: string;
  taker_side: string;
}

export class Book {
  /** Best (highest) price first, oldest first within a price. */
  bids: Order[] = [];
  /** Best (lowest) price first, oldest first within a price. */
  asks: Order[] = [];
  last = 0;

  get bid(): number {
    return this.bids.length > 0 ? this.bids[0].price : 0;
  }

  get ask(): number {
    return this.asks.length > 0 ? this.asks[0].price : 0;
  }

  /** [bid, ask, last] as the engine publishes them; 0 for an empty side or no trade yet. */
  top(): [number, number, number] {
    return [this.bid, this.ask, this.last];
  }

  match(order: Order): Fill[] {
    if (order.side !== 'BUY' && order.side !== 'SELL') throw new Error(\`unknown side \${JSON.stringify(order.side)}\`);
    const buying = order.side === 'BUY';
    const resting = buying ? this.asks : this.bids;
    let remaining = order.qty;
    const fills: Fill[] = [];
    while (remaining > 0 && resting.length > 0) {
      const best = resting[0];
      const crosses = buying ? order.price >= best.price : order.price <= best.price;
      if (!crosses) break;
      const qty = Math.min(remaining, best.qty);
      const [buyId, sellId] = buying ? [order.order_id, best.order_id] : [best.order_id, order.order_id];
      fills.push({
        symbol: order.symbol,
        price: best.price,
        qty,
        buy_order_id: buyId,
        sell_order_id: sellId,
        taker_side: order.side,
      });
      this.last = best.price;
      remaining -= qty;
      best.qty -= qty;
      if (best.qty === 0) resting.shift();
    }
    if (remaining > 0) this.rest({...order, qty: remaining});
    return fills;
  }

  private rest(order: Order): void {
    const side = order.side === 'BUY' ? this.bids : this.asks;
    const better = order.side === 'BUY' ? (a: number, b: number) => a > b : (a: number, b: number) => a < b;
    let index = side.length;
    for (let i = 0; i < side.length; i++) {
      if (better(order.price, side[i].price)) {
        index = i;
        break;
      }
    }
    side.splice(index, 0, order);
  }
}
`,
};
