import {type ChangeEvent, type FC, type ReactElement, memo, useCallback, useMemo, useState} from 'react';

import WidgetFrame, {RANGE_CLASS, SELECT_CLASS} from './frame';
import type {WidgetProps} from './index';
import {BUTTON_CLASS} from './playback';

type Side = 'buy' | 'sell';

interface Order {
  id: number;
  side: Side;
  price: number;
  qty: number;
}

interface Fill {
  price: number;
  qty: number;
  makerId: number;
  takerId: number;
}

interface Book {
  resting: Order[];
  fills: Fill[];
  nextId: number;
  event: string;
}

const MONO = 'var(--font-code), monospace';
const WIDTH = 640;
const HALF = WIDTH / 2;
const TOP = 22;
const ROW = 26;
const MAX_LEVELS = 6;
const MAX_CHIPS = 5;
const CHIP_W = 42;

const SEED: Order[] = [
  {id: 1, side: 'sell', price: 101, qty: 4},
  {id: 2, side: 'sell', price: 100, qty: 3},
  {id: 3, side: 'buy', price: 99.5, qty: 5},
  {id: 4, side: 'sell', price: 100.5, qty: 6},
  {id: 5, side: 'buy', price: 99, qty: 2},
  {id: 6, side: 'buy', price: 99.5, qty: 4},
];

const INITIAL: Book = {
  resting: SEED,
  fills: [],
  nextId: 7,
  event: 'Six resting orders. Bids sit below asks; within a price level, the earlier arrival (#) is filled first.',
};

const fmt = (p: number): string => p.toFixed(1);
const levelsOf = (orders: Order[]): number => new Set(orders.map(o => o.price)).size;

const bestOf = (orders: Order[], side: Side): string => {
  const prices = orders.filter(o => o.side === side).map(o => o.price);
  if (prices.length === 0) return 'empty';
  return fmt(side === 'buy' ? Math.max(...prices) : Math.min(...prices));
};

/** Price-time priority: the taker walks the opposite side best price first, oldest order first at each price. */
const submit = (book: Book, side: Side, price: number, qty: number): Book => {
  const id = book.nextId;
  const opposite = book.resting
    .filter(o => o.side !== side && (side === 'buy' ? o.price <= price : o.price >= price))
    .sort((x, y) => (side === 'buy' ? x.price - y.price : y.price - x.price) || x.id - y.id);
  const fills: Fill[] = [];
  const consumed = new Map<number, number>();
  let left = qty;
  for (const maker of opposite) {
    if (left === 0) break;
    const take = Math.min(left, maker.qty);
    fills.push({price: maker.price, qty: take, makerId: maker.id, takerId: id});
    consumed.set(maker.id, take);
    left -= take;
  }
  const resting = book.resting.map(o => ({...o, qty: o.qty - (consumed.get(o.id) ?? 0)})).filter(o => o.qty > 0);
  const label = `${side === 'buy' ? 'Buy' : 'Sell'} ${qty} @ ${fmt(price)} (#${id})`;
  const sideName = side === 'buy' ? 'bid' : 'ask';
  let tail = '';
  if (left > 0) {
    const sameSide = resting.filter(o => o.side === side);
    if (!sameSide.some(o => o.price === price) && levelsOf(sameSide) >= MAX_LEVELS) {
      tail = `; ${
        fills.length === 0 ? 'it is' : `the remaining ${left} is`
      } cancelled — this book is capped at ${MAX_LEVELS} ${sideName} levels and ${fmt(price)} would open a new one`;
    } else {
      resting.push({id, side, price, qty: left});
      tail =
        fills.length === 0
          ? `; it rests at ${fmt(price)} behind any earlier orders at that price`
          : `; the remaining ${left} rests at ${fmt(price)}`;
    }
  }
  const filled = fills.map(f => `${f.qty} @ ${fmt(f.price)} (order #${f.makerId})`).join(', ');
  const event =
    fills.length === 0
      ? `${label} did not cross the book (best ${side === 'buy' ? 'ask' : 'bid'} is ${bestOf(
          resting,
          side === 'buy' ? 'sell' : 'buy',
        )})${tail}.`
      : `${label} crossed the book: filled ${filled}${tail}.`;
  return {resting, fills: [...fills, ...book.fills], nextId: id + 1, event};
};

interface Level {
  price: number;
  orders: Order[];
}

const levels = (orders: Order[], side: Side): Level[] => {
  const byPrice = new Map<number, Order[]>();
  for (const o of orders) {
    if (o.side !== side) continue;
    const list = byPrice.get(o.price);
    if (list === undefined) byPrice.set(o.price, [o]);
    else list.push(o);
  }
  return [...byPrice.entries()]
    .sort((x, y) => (side === 'buy' ? y[0] - x[0] : x[0] - y[0]))
    .map(([price, list]) => ({price, orders: list.sort((x, y) => x.id - y.id)}));
};

const OrderBook: FC<WidgetProps> = memo(() => {
  const [book, setBook] = useState<Book>(INITIAL);
  const [side, setSide] = useState<Side>('buy');
  const [price, setPrice] = useState(100.5);
  const [qty, setQty] = useState(5);

  const onSide = useCallback((e: ChangeEvent<HTMLSelectElement>) => setSide(e.target.value as Side), []);
  const onPrice = useCallback((e: ChangeEvent<HTMLInputElement>) => setPrice(Number(e.target.value)), []);
  const onQty = useCallback((e: ChangeEvent<HTMLInputElement>) => setQty(Number(e.target.value)), []);
  const onAdd = useCallback(() => setBook(b => submit(b, side, price, qty)), [price, qty, side]);
  const onReset = useCallback(() => setBook(INITIAL), []);

  const bids = useMemo(() => levels(book.resting, 'buy'), [book.resting]);
  const asks = useMemo(() => levels(book.resting, 'sell'), [book.resting]);

  const controls = useMemo(
    () => (
      <>
        <select aria-label="side" className={SELECT_CLASS} onChange={onSide} value={side}>
          <option value="buy">buy</option>
          <option value="sell">sell</option>
        </select>
        <label className="flex items-center gap-1.5">
          <span className="text-plum-300">price</span>
          <input
            aria-label="limit price"
            className={RANGE_CLASS}
            max={102}
            min={98}
            onChange={onPrice}
            step={0.5}
            type="range"
            value={price}
          />
          <span className="font-code tabular-nums text-cream">{fmt(price)}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-plum-300">qty</span>
          <input
            aria-label="quantity"
            className={RANGE_CLASS}
            max={10}
            min={1}
            onChange={onQty}
            step={1}
            type="range"
            value={qty}
          />
          <span className="font-code tabular-nums text-cream">{qty}</span>
        </label>
        <button className={BUTTON_CLASS} onClick={onAdd} type="button">
          Add order
        </button>
        <button className={BUTTON_CLASS} onClick={onReset} type="button">
          Reset
        </button>
      </>
    ),
    [onAdd, onPrice, onQty, onReset, onSide, price, qty, side],
  );

  const rows = Math.max(bids.length, asks.length, 1);
  const height = TOP + rows * ROW + 6;
  const crosses =
    side === 'buy' ? asks.length > 0 && price >= asks[0].price : bids.length > 0 && price <= bids[0].price;

  const renderSide = (lvls: Level[], x0: number, tone: string): ReactElement[] =>
    lvls.map((lvl, i) => {
      const y = TOP + i * ROW;
      const highlight = i === 0;
      return (
        <g key={lvl.price}>
          <text
            fill={highlight ? '#fbf6ff' : '#d6c6f5'}
            fontFamily={MONO}
            fontSize={11}
            fontWeight={highlight ? 700 : 400}
            x={x0}
            y={y + 16}>
            {fmt(lvl.price)}
          </text>
          {lvl.orders.slice(0, MAX_CHIPS).map((o, j) => (
            <g key={o.id}>
              <rect
                fill={highlight && j === 0 ? tone : '#2b144d'}
                height={18}
                rx={3}
                stroke={tone}
                strokeWidth={0.75}
                width={CHIP_W - 4}
                x={x0 + 44 + j * CHIP_W}
                y={y + 3}
              />
              <text
                fill={highlight && j === 0 ? '#2b144d' : '#d6c6f5'}
                fontFamily={MONO}
                fontSize={9}
                textAnchor="middle"
                x={x0 + 44 + j * CHIP_W + (CHIP_W - 4) / 2}
                y={y + 15}>
                {o.qty} #{o.id}
              </text>
            </g>
          ))}
          {lvl.orders.length > MAX_CHIPS ? (
            <text fill="#a78bfa" fontFamily={MONO} fontSize={9} x={x0 + 44 + MAX_CHIPS * CHIP_W} y={y + 15}>
              +{lvl.orders.length - MAX_CHIPS}
            </text>
          ) : null}
        </g>
      );
    });

  const readout = useMemo(
    () => (
      <>
        {book.event}{' '}
        {crosses ? (
          <span className="text-candy-200">
            Your next {side} at {fmt(price)} crosses the {side === 'buy' ? 'best ask' : 'best bid'} and will fill.
          </span>
        ) : null}
      </>
    ),
    [book.event, crosses, price, side],
  );

  return (
    <WidgetFrame controls={controls} readout={readout} title="limit order book: price-time priority">
      <svg className="w-full" role="img" viewBox={`0 0 ${WIDTH} ${height}`}>
        <title>Bids and asks by price level, each level a FIFO queue of orders</title>
        <text fill="#34d399" fontFamily={MONO} fontSize={9} x={8} y={12}>
          BIDS (buy, best first) — price · qty #arrival
        </text>
        <text fill="#fb7185" fontFamily={MONO} fontSize={9} x={HALF + 8} y={12}>
          ASKS (sell, best first)
        </text>
        <line stroke="rgba(58,29,104,0.9)" strokeDasharray="2 3" x1={HALF} x2={HALF} y1={4} y2={height - 2} />
        {renderSide(bids, 8, '#34d399')}
        {renderSide(asks, HALF + 8, '#fb7185')}
        {bids.length === 0 ? (
          <text fill="#a78bfa" fontFamily={MONO} fontSize={9} x={8} y={TOP + 16}>
            no bids
          </text>
        ) : null}
        {asks.length === 0 ? (
          <text fill="#a78bfa" fontFamily={MONO} fontSize={9} x={HALF + 8} y={TOP + 16}>
            no asks
          </text>
        ) : null}
      </svg>
      <div className="mt-2 font-code text-[10px] text-plum-200">
        <div className="text-plum-300">fills (newest first)</div>
        {book.fills.length === 0 ? (
          <div className="text-plum-400">
            none yet — add a buy at or above the best ask, or a sell at or below the best bid
          </div>
        ) : (
          book.fills.slice(0, 6).map((f, i) => (
            <div key={`${f.takerId}-${f.makerId}-${i}`}>
              <span className="text-cream">{f.qty}</span> @ <span className="text-cream">{fmt(f.price)}</span> · taker #
              {f.takerId} vs maker #{f.makerId}
            </div>
          ))
        )}
      </div>
    </WidgetFrame>
  );
});
OrderBook.displayName = 'OrderBook';

export default OrderBook;
