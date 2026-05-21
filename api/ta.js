// Alpha Signal — TA Edge Function
// Runs server-side on Vercel. Never visible in browser DevTools.

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

const MIN_DIST = {
  '1h':0.008,'2h':0.012,'4h':0.018,'8h':0.024,
  '12h':0.030,'1d':0.045,'1w':0.07,'1m':0.10
};

// ── Math helpers ─────────────────────────────────────────────
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
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
  return { macdLine, signal, histogram: macdLine - signal };
}

function calcATR(highs, lows, closes, period = 14) {
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

function findSwingHighsLows(highs, lows, n = 5) {
  const supports = [], resistances = [];
  for (let i = n; i < lows.length - n; i++) {
    const sl = lows.slice(i - n, i + n + 1);
    if (lows[i] === Math.min(...sl)) supports.push(lows[i]);
  }
  for (let i = n; i < highs.length - n; i++) {
    const sh = highs.slice(i - n, i + n + 1);
    if (highs[i] === Math.max(...sh)) resistances.push(highs[i]);
  }
  supports.sort((a, b) => b - a);
  resistances.sort((a, b) => a - b);
  return { supports, resistances };
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

  // Validate
  if (!SYMBOLS[coin]) {
    return new Response(JSON.stringify({ error: 'Unknown coin: ' + coin }), { status: 400, headers });
  }

  try {
    const sym      = SYMBOLS[coin];
    const interval = INTERVALS[tf] || '4h';
    const limit    = (tf === '1w' || tf === '1m') ? 100 : 200;
    const md       = MIN_DIST[tf] || 0.025;

    // ── Fetch in parallel ──────────────────────────────────
    const [klines, fgRes, htfKlines, fundingRes] = await Promise.allSettled([
      fetch(`${BINANCE_BASE}/klines?symbol=${sym}&interval=${interval}&limit=${limit}`).then(r => r.json()),
      fetch('https://api.alternative.me/fng/?limit=1').then(r => r.json()),
      (HTF_MAP[tf] !== tf)
        ? fetch(`${BINANCE_BASE}/klines?symbol=${sym}&interval=${INTERVALS[HTF_MAP[tf]]}&limit=60`).then(r => r.json())
        : Promise.resolve(null),
      ['BTC','ETH','SOL','BNB','XRP','TAO','HYPE'].includes(coin)
        ? fetch(`${BINANCE_FUTURES}/premiumIndex?symbol=${sym}`).then(r => r.json())
        : Promise.resolve(null),
    ]);

    const candles = klines.status === 'fulfilled' ? klines.value : null;
    if (!candles || candles.length < 30) {
      return new Response(JSON.stringify({ error: 'Insufficient candle data' }), { status: 502, headers });
    }

    // ── Parse candles ─────────────────────────────────────
    const highs   = candles.map(k => parseFloat(k[2]));
    const lows    = candles.map(k => parseFloat(k[3]));
    const closes  = candles.map(k => parseFloat(k[4]));
    const volumes = candles.map(k => parseFloat(k[5]));

    const price   = closes[closes.length - 1];
    const rsi     = calcRSI(closes, 14);
    const ema50   = calcEMA(closes, 50);
    const ema200  = calcEMA(closes, 200);
    const macdR   = calcMACD(closes);
    const atr     = calcATR(highs, lows, closes, 14);
    const atrPct  = (atr / price * 100);

    // Volume (last completed candle)
    const curVol     = volumes[volumes.length - 2];
    const avgVol     = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const volRatioRaw = curVol / avgVol;
    const volRatio   = (volRatioRaw * 100).toFixed(0);

    // S/R Levels
    const swingN = candles.length < 50 ? 3 : 5;
    const { supports, resistances } = findSwingHighsLows(highs, lows, swingN);

    const s1 = supports.find(s => s <= price * (1 - md)) || price * (1 - md * 1.4);
    let   s2 = supports.find(s => s <= price * (1 - md * 1.8)) || s1 * (1 - md * 0.9);

    let emaR1 = null, emaR2 = null;
    if (ema50  > price * (1 + md * 0.5)) emaR1 = ema50;
    if (ema200 > price * (1 + md * 0.5)) {
      if (emaR1 && ema200 > emaR1 * (1 + md * 0.3)) emaR2 = ema200;
      else if (!emaR1) emaR1 = ema200;
    }

    const r1Swing = resistances.find(r => r >= price * (1 + md));
    const r2Swing = r1Swing ? resistances.find(r => r >= r1Swing * (1 + md * 0.5)) : null;
    const maxR2   = price * (tf === '1w' ? 1.55 : tf === '1m' ? 1.80 : 1.35);
    const r1      = (emaR1 && r1Swing) ? Math.min(emaR1, r1Swing) : (emaR1 || r1Swing || price * (1 + md * 1.4));
    const r2Cands = [emaR2, r2Swing].filter(x => x && x >= r1 * (1 + md) && x <= maxR2);
    const r2      = r2Cands.length > 0 ? Math.min(...r2Cands) : Math.min(r1 * (1 + md * 1.5), maxR2);

    const minS2 = price * (tf === '1w' ? 0.55 : tf === '1m' ? 0.45 : 0.65);
    if (s2 >= s1 * (1 - md * 0.3)) s2 = s1 * (1 - md * 1.0);
    if (s2 < minS2) s2 = Math.max(s2, minS2);

    const dt1 = s2;
    const dt2 = supports.find(s => s < s2 * (1 - md * 0.3)) || s2 * (1 - md * 1.0);
    const bt1 = r1, bt2 = r2;

    // 24h change
    const price24hAgo = closes[closes.length - 24] || closes[0];
    const change24h   = ((price - price24hAgo) / price24hAgo * 100).toFixed(2);

    // Ranging detection
    const recentMove = Math.abs(closes[closes.length - 1] - closes[closes.length - 11]) / price * 100;
    const isRanging  = recentMove < atrPct * 0.6;

    // ── Fear & Greed ───────────────────────────────────────
    let fearGreedVal = '50', fearGreedLabel = 'Neutral', fgOk = false;
    if (fgRes.status === 'fulfilled' && fgRes.value?.data?.[0]) {
      fearGreedVal  = fgRes.value.data[0].value;
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
    if (htfKlines.status === 'fulfilled' && htfKlines.value && htfKlines.value.length >= 30) {
      const hc   = htfKlines.value.map(k => parseFloat(k[4]));
      const he20 = calcEMA(hc, 20);
      const he50 = calcEMA(hc, 50);
      const hp   = hc[hc.length - 1];
      htfTrend = (hp > he20 && he20 > he50) ? 'bullish'
               : (hp < he20 && he20 < he50) ? 'bearish' : 'neutral';
      htfLabel = `${HTF_MAP[tf].toUpperCase()} trend: ${htfTrend} (EMA20 $${he20.toFixed(2)} / EMA50 $${he50.toFixed(2)})`;
      htfOk = true;
    }

    // ── pct helper ─────────────────────────────────────────
    const pct = (a, b) => (((a - b) / b) * 100).toFixed(2);

    // ── Response ───────────────────────────────────────────
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
      rsi:             rsi.toFixed(1),
      ema50:           ema50.toFixed(2),
      ema200:          ema200.toFixed(2),
      ema_cross:       ema50 > ema200
                         ? 'EMA50 above EMA200 (golden cross — bullish)'
                         : 'EMA50 below EMA200 (death cross — bearish)',
      macd:            macdR.macdLine.toFixed(4),
      macd_signal:     macdR.signal.toFixed(4),
      macd_hist:       macdR.histogram.toFixed(4),
      macd_status:     macdR.histogram > 0
                         ? 'Histogram positive (bullish momentum)'
                         : 'Histogram negative (bearish momentum)',
      volume:          curVol.toFixed(0),
      volume_avg20:    avgVol.toFixed(0),
      volume_vs_avg:   volRatio + '% of 20-period average',
      change_24h:      change24h,
      atr:             atr.toFixed(4),
      atr_pct:         atrPct.toFixed(2),
      is_ranging:      isRanging ? 'true' : 'false',
      market_regime:   isRanging ? 'ranging market' : 'trending market',
      price_vs_ema50:  pct(price, ema50) + '% from EMA50',
      price_vs_ema200: pct(price, ema200) + '% from EMA200',
      fear_greed_value: fearGreedVal,
      fear_greed_label: fearGreedLabel,
      funding_rate:    fundingRate,
      funding_label:   fundingLabel,
      htf_trend:       htfTrend,
      htf_label:       htfLabel,
      // Data quality flags for frontend
      _fgOk:   fgOk,
      _fundOk: fundOk,
      _htfOk:  htfOk,
    };

    return new Response(JSON.stringify(ta), { status: 200, headers });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'TA computation failed: ' + err.message }),
      { status: 500, headers }
    );
  }
}
