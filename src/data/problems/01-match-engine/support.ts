import {CPP_IDS_H} from '../cpp-support';

/**
 * Runtime support modules for the match-engine course: the provided price-time `Book` that step 3
 * (`from book import Book, Order` / `import {Book} from 'book'` / `import "exchange/book"` /
 * `#include "book.h"`) matches orders against.
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

/** The same `Book`, for the Go runtime: `import "exchange/book"`, then `book.New().Match(order)`. */
export const supportModulesGo: Record<string, string> = {
  'exchange/book/book.go': `// Package book is the provided limit order book: price-time priority.
//
// New().Match(order) crosses the incoming order against the resting orders of the opposite side,
// best price first and oldest first at one price, fills at the resting order's price, and rests any
// remainder. It returns one Fill per resting order it traded against, in matching order.
package book

import "fmt"

// Order is a limit order, as the gateway publishes it on the orders topic.
type Order struct {
	OrderID       string  \`json:"order_id"\`
	Symbol        string  \`json:"symbol"\`
	Side          string  \`json:"side"\`
	Price         float64 \`json:"price"\`
	Qty           int64   \`json:"qty"\`
	ClientOrderID string  \`json:"client_order_id"\`
}

// Fill is one trade: the incoming order (the taker) against one resting order.
type Fill struct {
	Symbol      string  \`json:"symbol"\`
	Price       float64 \`json:"price"\`
	Qty         int64   \`json:"qty"\`
	BuyOrderID  string  \`json:"buy_order_id"\`
	SellOrderID string  \`json:"sell_order_id"\`
	TakerSide   string  \`json:"taker_side"\`
}

// Book is one symbol's order book.
type Book struct {
	Bids []Order // best (highest) price first, oldest first within a price
	Asks []Order // best (lowest) price first, oldest first within a price
	Last float64 // the price of the last fill, 0 before the first
}

// New returns an empty book.
func New() *Book { return &Book{} }

// Bid is the best bid, 0 when there is none.
func (b *Book) Bid() float64 {
	if len(b.Bids) == 0 {
		return 0
	}
	return b.Bids[0].Price
}

// Ask is the best ask, 0 when there is none.
func (b *Book) Ask() float64 {
	if len(b.Asks) == 0 {
		return 0
	}
	return b.Asks[0].Price
}

// Top is (bid, ask, last) as the engine publishes them; 0 for an empty side or no trade yet.
func (b *Book) Top() (bid, ask, last float64) { return b.Bid(), b.Ask(), b.Last }

// Match crosses order against the book and rests what is left of it. It panics on a side other
// than BUY or SELL.
func (b *Book) Match(order Order) []Fill {
	if order.Side != "BUY" && order.Side != "SELL" {
		panic(fmt.Sprintf("book: unknown side %q", order.Side))
	}
	buying := order.Side == "BUY"
	resting := &b.Bids
	if buying {
		resting = &b.Asks
	}
	remaining := order.Qty
	var fills []Fill
	for remaining > 0 && len(*resting) > 0 {
		best := &(*resting)[0]
		crosses := order.Price <= best.Price
		if buying {
			crosses = order.Price >= best.Price
		}
		if !crosses {
			break
		}
		qty := min(remaining, best.Qty)
		buyID, sellID := best.OrderID, order.OrderID
		if buying {
			buyID, sellID = order.OrderID, best.OrderID
		}
		fills = append(fills, Fill{Symbol: order.Symbol, Price: best.Price, Qty: qty, BuyOrderID: buyID, SellOrderID: sellID, TakerSide: order.Side})
		b.Last = best.Price
		remaining -= qty
		best.Qty -= qty
		if best.Qty == 0 {
			*resting = (*resting)[1:]
		}
	}
	if remaining > 0 {
		order.Qty = remaining
		b.rest(order)
	}
	return fills
}

// rest inserts order behind every resting order at its price or better.
func (b *Book) rest(order Order) {
	side := &b.Asks
	better := func(p, q float64) bool { return p < q }
	if order.Side == "BUY" {
		side = &b.Bids
		better = func(p, q float64) bool { return p > q }
	}
	index := len(*side)
	for i, resting := range *side {
		if better(order.Price, resting.Price) {
			index = i
			break
		}
	}
	*side = append(*side, Order{})
	copy((*side)[index+1:], (*side)[index:])
	(*side)[index] = order
}
`,
};

/**
 * The C++ course headers: ids.h (step 1's new_uuid()), order_gateway.h (step 1's Order and PublishFailed,
 * which step 2's publisher includes), and the same `Book` as book.h (step 3: `books[symbol].match(order)`).
 */
export const supportModulesCpp: Record<string, string> = {
  'ids.h': CPP_IDS_H,
  'order_gateway.h': `// The order gateway's types (step 1, provided): Order, PublishFailed, and to_json(order), the order as JSON.
#pragma once

#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>

struct Order {
  std::string order_id, symbol, side, client_order_id;
  double price;
  long qty;
};

// Thrown by publish_order when Kafka does not acknowledge the order.
struct PublishFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Hands the order to the engine: returns once Kafka acknowledged it, throws PublishFailed otherwise.
void publish_order(const Order& order);

// The order as the orders topic carries it: {"order_id", "symbol", "side", "price", "qty", "client_order_id"}.
inline std::string to_json(const Order& order) {
  return nlohmann::json{{"order_id", order.order_id}, {"symbol", order.symbol}, {"side", order.side},
                        {"price", order.price}, {"qty", order.qty}, {"client_order_id", order.client_order_id}}
      .dump();
}
`,
  'book.h': `// The provided limit order book: price-time priority.
//
// Book::match(order) crosses the incoming order against the resting orders of the opposite side,
// best price first and oldest first at one price, fills at the resting order's price, and rests any
// remainder. It returns one Fill per resting order it traded against, in matching order.
#pragma once

#include <algorithm>
#include <cstddef>
#include <nlohmann/json.hpp>
#include <optional>
#include <stdexcept>
#include <string>
#include <tuple>
#include <vector>

// A limit order, as the gateway publishes it on the orders topic.
struct Order {
  std::string order_id, symbol, side, client_order_id;
  double price = 0;
  long qty = 0;

  // The order a record's value holds; nullopt unless it is a JSON object of an order with a symbol.
  static std::optional<Order> parse(const std::string& value) {
    const auto j = nlohmann::json::parse(value, nullptr, false);
    if (!j.is_object()) return std::nullopt;
    Order order;
    try {
      order.order_id = j.value("order_id", "");
      order.symbol = j.value("symbol", "");
      order.side = j.value("side", "");
      order.client_order_id = j.value("client_order_id", "");
      order.price = j.value("price", 0.0);
      order.qty = j.value("qty", 0L);
    } catch (const nlohmann::json::exception&) {
      return std::nullopt;  // a field of the wrong type
    }
    if (order.symbol.empty()) return std::nullopt;
    return order;
  }
};

// One trade: the incoming order (the taker) against one resting order.
struct Fill {
  std::string symbol;
  double price = 0;
  long qty = 0;
  std::string buy_order_id, sell_order_id, taker_side;

  // The trade as the trades topic carries it: {"symbol", "price", "qty", "buy_order_id", "sell_order_id", "taker_side"}.
  std::string to_json() const {
    return nlohmann::json{{"symbol", symbol},
                          {"price", price},
                          {"qty", qty},
                          {"buy_order_id", buy_order_id},
                          {"sell_order_id", sell_order_id},
                          {"taker_side", taker_side}}
        .dump();
  }
};

// One symbol's order book.
class Book {
 public:
  std::vector<Order> bids;  // best (highest) price first, oldest first within a price
  std::vector<Order> asks;  // best (lowest) price first, oldest first within a price
  double last = 0;          // the price of the last fill, 0 before the first

  // The best bid, 0 when there is none.
  double bid() const { return bids.empty() ? 0 : bids.front().price; }
  // The best ask, 0 when there is none.
  double ask() const { return asks.empty() ? 0 : asks.front().price; }
  // (bid, ask, last) as the engine publishes them; 0 for an empty side or no trade yet.
  std::tuple<double, double, double> top() const { return {bid(), ask(), last}; }

  // Cross order against the book and rest what is left of it. Throws std::invalid_argument on a side
  // other than BUY or SELL.
  std::vector<Fill> match(const Order& order) {
    if (order.side != "BUY" && order.side != "SELL") throw std::invalid_argument("book: unknown side \\"" + order.side + "\\"");
    const bool buying = order.side == "BUY";
    std::vector<Order>& resting = buying ? asks : bids;
    long remaining = order.qty;
    std::vector<Fill> fills;
    while (remaining > 0 && !resting.empty()) {
      Order& best = resting.front();
      const bool crosses = buying ? order.price >= best.price : order.price <= best.price;
      if (!crosses) break;
      const long qty = std::min(remaining, best.qty);
      fills.push_back(Fill{order.symbol, best.price, qty, buying ? order.order_id : best.order_id,
                           buying ? best.order_id : order.order_id, order.side});
      last = best.price;
      remaining -= qty;
      best.qty -= qty;
      if (best.qty == 0) resting.erase(resting.begin());
    }
    if (remaining > 0) {
      Order rest = order;
      rest.qty = remaining;
      rest_order(rest);
    }
    return fills;
  }

 private:
  // Insert order behind every resting order at its price or better.
  void rest_order(const Order& order) {
    const bool buying = order.side == "BUY";
    std::vector<Order>& side = buying ? bids : asks;
    std::size_t index = side.size();
    for (std::size_t i = 0; i < side.size(); i++) {
      if (buying ? order.price > side[i].price : order.price < side[i].price) {
        index = i;
        break;
      }
    }
    side.insert(side.begin() + static_cast<std::ptrdiff_t>(index), order);
  }
};
`,
};
