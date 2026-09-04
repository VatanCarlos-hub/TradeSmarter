// Alpha Signal — TA Edge Function
// Runs server-side on Vercel. Never visible in browser DevTools.
//
// Fixes in this version:
//  A) Support/resistance were asymmetric and unrealistically far away.
//     - Supports now also consider EMA50/EMA200 when price trades above them
//       (resistances already did this), so both sides are treated the same way.
//     - Swing detection runs twice: a wide pass (n=5) for major structure and a
//       narrow pass (n=2) over the most recent candles, so fresh lows/highs
//       created during a strong move are not ignored.
//     - The minimum distance filter is now much tighter for the FIRST level
//       (md * 0.35) so a nearby, genuinely relevant level is not skipped.
//     - Levels are ranked by proximity to price, nearest first.
//  B) Candle window: every timeframe fetches 300 candles, so EMA200 is
//     computable on weekly and monthly (previously 100 -> silently wrong).
//  C) calcEMA returns null instead of a wrong value when history is too short.
//  D) 24h change comes from Binance's 24hr ticker, so it is a real 24h figure
//     on every timeframe, plus a separate interval-specific change.

export const config = { runtime: 'edge' };

const BINANCE_BASE = 'https://api.binance.com/api/v3';
const BINANCE_FUTURES = 'https://fapi.binance.com/fapi/v1';

const SYMBOLS = {
  BTC:'BTCUSDT',ETH:'ETHUSDT',XRP:'XRPUSDT',SOL:'SOLUSDT',
  BNB:'BNBUSDT',DOGE:'DOGEUSDT',ADA:'ADAUSDT',AVAX:'AVAXUSDT',
  SUI:'SUIUSDT',TAO:'TAOUSDT',HYPE:'HYPEUSDT'
};

const INTERVALS = {
  '1h':'1h','2h':'2h','4h':'4h','8h':'8h',
  '12h':'12h','1d':'1d','1w':'1w','1m':'1M'
};

const HTF_MAP = {
  '1h':'4h','2h':'4h','4h':'1d','8h':'1d',
  '12h':'1d','1d':'1w','1w':'1m','1m':'1m'
};

// Minimum separation between price and a level, per timeframe.
const MIN_DIST = {
  '1h':0.008,'2h':0.012,'4h':0.018,'8h':0.024,
  '12h':0.030,'1d':0.045,'1w':0.07,'1m':0.10
};

const CANDLES_PER_24H = { '1h':24, '2h':12, '4h':6, '8h':3, '12h':2, '1d':1 };
const CANDLE_LIMIT = 300;
const MIN_CANDLES = 40;

// ── Math helpers ─────────────────────────────────────────────
function calcEMA(closes, period) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const k12 = 2 / 13, k26 = 2 / 27;
  let e12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
  let e26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
  for (let i = 12; i <= 25; i++) e12 = closes[i] * k12 + e12 * (1 - k12);
  const ms = [e12 - e26];
  for (let i = 26; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
    e26 = closes[i] * k26 + e26 * (1 - k26);
    ms.push(e12 - e26);
  }
  const macdLine = ms[ms.length - 1];
  const signal = calcEMA(ms, 9);
  if (signal === null) return null;
  return { macdLine, signal, histogram: macdLine - signal };
}

function calcATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

// Swing detection over a slice, with a configurable lookback.
function swings(highs, lows, n, fromIdx) {
  const sup = [], res = [];
  const start = Math.max(n, fromIdx || n);
  for (let i = start; i < lows.length - n; i++) {
    const w = lows.slice(i - n, i + n + 1);
    if (lows[i] === Math.min(...w)) sup.push(lows[i]);
  }
  for (let i = start; i < highs.length - n; i++) {
    const w = highs.slice(i - n, i + n + 1);
    if (highs[i] === Math.max(...w)) res.push(highs[i]);
  }
  return { sup, res };
}

// Merge levels that sit within `tol` of each other, keep the strongest.
function dedupe(levels, tol) {
  const out = [];
  for (const lv of levels) {
    let merged = false;
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(out[i] - lv) / lv < tol) { merged = true; break; }
    }
    if (!merged) out.push(lv);
  }
  return out;
}

// ── Main handler ─────────────────────────────────────────────
export default async function handler(req) {
  const url = new URL(req.url);
  const coin = (url.searchParams.get('coin') || 'BTC').toUpperCase().trim();
  const tf   = (url.searchParams.get('tf')   || '4h').toLowerCase().trim();

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 's-maxage=25, stale-while-revalidate=10',
  };

  if (!SYMBOLS[coin]) {
    return new Response(JSON.stringify({ error: 'Unknown coin: ' + coin }), { status: 400, headers });
  }
  if (!INTERVALS[tf]) {
    return new Response(JSON.stringify({ error: 'Unknown timeframe: ' + tf }), { status: 400, headers });
  }

  try {
    const sym      = SYMBOLS[coin];
    const interval = INTERVALS[tf];
    const md       = MIN_DIST[tf] || 0.025;

    const [klines, fgRes, htfKlines, fundingRes, tickerRes] = await Promise.allSettled([
      fetch(`${BINANCE_BASE}/klines?symbol=${sym}&interval=${interval}&limit=${CANDLE_LIMIT}`).then(r => r.json()),
      fetch('https://api.alternative.me/fng/?limit=1').then(r => r.json()),
      (HTF_MAP[tf] !== tf)
        ? fetch(`${BINANCE_BASE}/klines?symbol=${sym}&interval=${INTERVALS[HTF_MAP[tf]]}&limit=120`).then(r => r.json())
        : Promise.resolve(null),
      ['BTC','ETH','SOL','BNB','XRP','TAO','HYPE'].includes(coin)
        ? fetch(`${BINANCE_FUTURES}/premiumIndex?symbol=${sym}`).then(r => r.json())
        : Promise.resolve(null),
      fetch(`${BINANCE_BASE}/ticker/24hr?symbol=${sym}`).then(r => r.json()),
    ]);

    const candles = (klines.status === 'fulfilled' && Array.isArray(klines.value)) ? klines.value : null;
    if (!candles || candles.length < MIN_CANDLES) {
      return new Response(JSON.stringify({ error: 'Insufficient candle data' }), { status: 502, headers });
    }

    const highs   = candles.map(k => parseFloat(k[2]));
    const lows    = candles.map(k => parseFloat(k[3]));
    const closes  = candles.map(k => parseFloat(k[4]));
    const volumes = candles.map(k => parseFloat(k[5]));
    const n       = closes.length;

    const price   = closes[n - 1];
    const rsi     = calcRSI(closes, 14);
    const ema50   = calcEMA(closes, 50);
    const ema200  = calcEMA(closes, 200);
    const macdR   = calcMACD(closes);
    const atr     = calcATR(highs, lows, closes, 14);
    const atrPct  = atr === null ? null : (atr / price * 100);

    const curVol      = volumes[n - 2];
    const avgVol      = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const volRatioRaw = avgVol > 0 ? curVol / avgVol : 0;
    const volRatio    = (volRatioRaw * 100).toFixed(0);

    // ── Support / resistance ───────────────────────────────
    // Wide pass for major structure, narrow pass for recent structure.
    const wide   = swings(highs, lows, 5, 5);
    const recent = swings(highs, lows, 2, Math.max(2, n - 40));

    // Candidate pools: swings from both passes, plus EMAs on the correct side.
    let supCand = wide.sup.concat(recent.sup).filter(v => v < price);
    let resCand = wide.res.concat(recent.res).filter(v => v > price);

    // EMAs act as support when price is above them, as resistance when below.
    if (ema50 !== null) {
      if (ema50 < price) supCand.push(ema50); else resCand.push(ema50);
    }
    if (ema200 !== null) {
      if (ema200 < price) supCand.push(ema200); else resCand.push(ema200);
    }

    // Minimum separation: tight for the first level, wider for the second.
    const near = md * 0.35;
    const far  = md * 1.10;

    // Nearest first.
    supCand = dedupe(supCand.sort((a, b) => b - a), md * 0.30);
    resCand = dedupe(resCand.sort((a, b) => a - b), md * 0.30);

    const s1 = supCand.find(v => v <= price * (1 - near)) || price * (1 - md);
    const s2 = supCand.find(v => v <= s1 * (1 - far))     || s1 * (1 - md);
    const r1 = resCand.find(v => v >= price * (1 + near)) || price * (1 + md);
    const r2 = resCand.find(v => v >= r1 * (1 + far))     || r1 * (1 + md);

    // Scenario targets follow the same levels, so the card stays consistent.
    const bt1 = r1, bt2 = r2;
    const dt1 = s1, dt2 = s2;

    // ── 24h change (real, timeframe-independent) ───────────
    let change24h = 'N/A', change24hSource = 'unavailable';
    if (tickerRes.status === 'fulfilled' && tickerRes.value && tickerRes.value.priceChangePercent !== undefined) {
      change24h = parseFloat(tickerRes.value.priceChangePercent).toFixed(2);
      change24hSource = 'binance_24hr_ticker';
    } else if (CANDLES_PER_24H[tf] && n > CANDLES_PER_24H[tf]) {
      const ago = closes[n - 1 - CANDLES_PER_24H[tf]];
      change24h = ((price - ago) / ago * 100).toFixed(2);
      change24hSource = 'candles_' + CANDLES_PER_24H[tf] + 'x' + tf;
    }

    const prevClose      = closes[n - 2];
    const changeInterval = ((price - prevClose) / prevClose * 100).toFixed(2);

    const recentMove = Math.abs(closes[n - 1] - closes[n - 11]) / price * 100;
    const isRanging  = atrPct === null ? false : recentMove < atrPct * 0.6;

    // ── Fear & Greed ───────────────────────────────────────
    let fearGreedVal = '50', fearGreedLabel = 'Neutral', fgOk = false;
    if (fgRes.status === 'fulfilled' && fgRes.value?.data?.[0]) {
      fearGreedVal   = fgRes.value.data[0].value;
      fearGreedLabel = fgRes.value.data[0].value_classification;
      fgOk = true;
    }

    // ── Funding Rate ───────────────────────────────────────
    let fundingRate = 'N/A', fundingLabel = 'N/A', fundOk = false;
    if (fundingRes.status === 'fulfilled' && fundingRes.value?.lastFundingRate) {
      const fr = parseFloat(fundingRes.value.lastFundingRate) * 100;
      fundingRate  = fr.toFixed(4);
      fundingLabel = fr > 0.05 ? 'Overheated Longs' : fr < -0.05 ? 'Overheated Shorts' : 'Neutral';
      fundOk = true;
    }

    // ── Higher Timeframe ───────────────────────────────────
    let htfTrend = 'neutral', htfLabel = 'N/A', htfOk = false;
    if (htfKlines.status === 'fulfilled' && Array.isArray(htfKlines.value) && htfKlines.value.length >= 50) {
      const hc   = htfKlines.value.map(k => parseFloat(k[4]));
      const he20 = calcEMA(hc, 20);
      const he50 = calcEMA(hc, 50);
      if (he20 !== null && he50 !== null) {
        const hp = hc[hc.length - 1];
        htfTrend = (hp > he20 && he20 > he50) ? 'bullish'
                 : (hp < he20 && he20 < he50) ? 'bearish' : 'neutral';
        htfLabel = `${HTF_MAP[tf].toUpperCase()} trend: ${htfTrend} (EMA20 $${he20.toFixed(2)} / EMA50 $${he50.toFixed(2)})`;
        htfOk = true;
      }
    }

    // ── helpers ────────────────────────────────────────────
    const pct = (a, b) => (((a - b) / b) * 100).toFixed(2);
    const numOrNA = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v)) ? 'N/A' : v.toFixed(d);

    const emaCross =
      (ema50 === null || ema200 === null)
        ? 'N/A (not enough history on this timeframe)'
        : (ema50 > ema200 ? 'Golden cross, EMA50 above EMA200'
                          : 'Death cross, EMA50 below EMA200');

    const ta = {
      current_price:   price.toFixed(2),
      support_1:       s1.toFixed(2),
      support_2:       s2.toFixed(2),
      resistance_1:    r1.toFixed(2),
      resistance_2:    r2.toFixed(2),
      bull_target_1:   bt1.toFixed(2),
      bull_target_2:   bt2.toFixed(2),
      bear_target_1:   dt1.toFixed(2),
      bear_target_2:   dt2.toFixed(2),
      bull_gain_1:     '+' + pct(bt1, price) + '%',
      bull_gain_2:     '+' + pct(bt2, price) + '%',
      bear_loss_1:     pct(dt1, price) + '%',
      bear_loss_2:     pct(dt2, price) + '%',
      volume_ratio:    volRatioRaw.toFixed(3),
      rsi:             numOrNA(rsi, 1),
      ema50:           numOrNA(ema50, 2),
      ema200:          numOrNA(ema200, 2),
      ema_cross:       emaCross,
      macd:            macdR ? macdR.macdLine.toFixed(4)  : 'N/A',
      macd_signal:     macdR ? macdR.signal.toFixed(4)    : 'N/A',
      macd_hist:       macdR ? macdR.histogram.toFixed(4) : 'N/A',
      macd_status:     macdR
                         ? (macdR.histogram > 0 ? 'Histogram positive' : 'Histogram negative')
                         : 'N/A',
      volume:          curVol.toFixed(0),
      volume_avg20:    avgVol.toFixed(0),
      volume_vs_avg:   volRatio + '% of 20-period average',
      change_24h:      change24h,
      change_24h_source: change24hSource,
      change_interval: changeInterval,
      change_interval_label: tf.toUpperCase() + ' change',
      atr:             numOrNA(atr, 4),
      atr_pct:         numOrNA(atrPct, 2),
      is_ranging:      isRanging ? 'true' : 'false',
      market_regime:   isRanging ? 'ranging market' : 'trending market',
      price_vs_ema50:  ema50  === null ? 'N/A' : pct(price, ema50)  + '% from EMA50',
      price_vs_ema200: ema200 === null ? 'N/A' : pct(price, ema200) + '% from EMA200',
      fear_greed_value: fearGreedVal,
      fear_greed_label: fearGreedLabel,
      funding_rate:    fundingRate,
      funding_label:   fundingLabel,
      htf_trend:       htfTrend,
      htf_label:       htfLabel,
      candles_used:    n,
      timeframe:       tf,
      _ema50Ok:  ema50  !== null,
      _ema200Ok: ema200 !== null,
      _fgOk:     fgOk,
      _fundOk:   fundOk,
      _htfOk:    htfOk,
    };

    return new Response(JSON.stringify(ta), { status: 200, headers });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'TA computation failed: ' + err.message }),
      { status: 500, headers }
    );
  }
}
