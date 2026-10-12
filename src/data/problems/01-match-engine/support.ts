/**
 * Runtime support modules for the match-engine course: the provided price-time `Book` that step 3
 * (`from book import Book, Order`) matches orders against.
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
