# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

import json
import typing


# ── Deterministic helpers ────────────────────────────────────
# Everything in this block runs identically on every validator.

def _num(d: dict, key: str, default: float = 0.0) -> float:
    """Read a numeric field from the TA payload. Never raises."""
    try:
        v = d.get(key)
        if v is None:
            return default
        s = str(v).replace(",", "").replace("%", "").replace("+", "").strip()
        if s == "" or s.upper() == "N/A":
            return default
        return float(s)
    except Exception:
        return default


def _has(d: dict, key: str) -> bool:
    """True when the TA payload actually carries a usable number."""
    try:
        v = d.get(key)
        if v is None:
            return False
        s = str(v).strip()
        return s != "" and s.upper() != "N/A"
    except Exception:
        return False


def _pick(text: str, options: list) -> str:
    """
    Reduce a model answer to one of the allowed options.
    Case-insensitive, tolerates punctuation or extra words.
    Returns "" when nothing matches.
    """
    try:
        t = str(text).strip().lower()
    except Exception:
        return ""
    for opt in options:
        if opt.lower() == t:
            return opt
    for opt in options:
        if opt.lower() in t:
            return opt
    return ""


def _score(ta: dict) -> int:
    """Deterministic 6-factor technical score, 0..6. Counts only present data."""
    price = _num(ta, "current_price")
    if price <= 0:
        return 3

    pts = 0
    total = 0

    if _has(ta, "ema50") and _has(ta, "ema200"):
        total += 1
        if _num(ta, "ema50") > _num(ta, "ema200"):
            pts += 1

    if _has(ta, "ema50"):
        total += 1
        if price > _num(ta, "ema50"):
            pts += 1

    if _has(ta, "ema200"):
        total += 1
        if price > _num(ta, "ema200"):
            pts += 1

    if _has(ta, "rsi"):
        total += 1
        if _num(ta, "rsi", 50.0) > 50.0:
            pts += 1

    if _has(ta, "macd_hist"):
        total += 1
        if _num(ta, "macd_hist") > 0:
            pts += 1

    if _has(ta, "change_24h"):
        total += 1
        if _num(ta, "change_24h") > 0:
            pts += 1

    if total == 0:
        return 3
    return int(round(pts * 6.0 / total))


def _probabilities(trend: str, confidence: str, score: int) -> dict:
    """Deterministic split, always multiples of 5, always sums to 100."""
    if confidence == "HIGH":
        edge = 25
    elif confidence == "LOW":
        edge = 10
    else:
        edge = 18

    tilt = (score - 3) * 3

    if trend == "bullish":
        bull = 40 + edge + tilt
        bear = 40 - edge - tilt
    elif trend == "bearish":
        bull = 40 - edge + tilt
        bear = 40 + edge - tilt
    else:
        bull = 35 + tilt
        bear = 35 - tilt

    if bull < 10:
        bull = 10
    if bull > 75:
        bull = 75
    if bear < 10:
        bear = 10
    if bear > 75:
        bear = 75

    bull = int(round(bull / 5.0) * 5)
    bear = int(round(bear / 5.0) * 5)
    neutral = 100 - bull - bear

    if neutral < 5:
        need = 5 - neutral
        if bull >= bear:
            bull -= need
        else:
            bear -= need
        neutral = 5

    return {"bull": bull, "bear": bear, "neutral": neutral}


class AlphaSignal(gl.Contract):
    # One JSON blob per user: {"_count": n, "BTC|4h": {...}, "ETH|1d": {...}}
    # Results are keyed by (user, coin, timeframe) and carry an incrementing
    # request_id, so the client can never be served an older analysis.
    results: TreeMap[Address, str]

    def __init__(self):
        pass

    @gl.public.write
    def request_analysis(self, coin: str, tf: str, ta_json: str, lang: str) -> str:
        coin_local = coin.upper().strip()
        tf_local = tf.lower().strip()
        sender = gl.message.sender_address

        ta = {}
        try:
            loaded = json.loads(ta_json) if ta_json else {}
            if isinstance(loaded, dict):
                ta = loaded
        except Exception:
            ta = {}

        blob = {}
        try:
            raw_blob = self.results[sender]
            if raw_blob:
                prev = json.loads(raw_blob)
                if isinstance(prev, dict):
                    blob = prev
        except Exception:
            blob = {}

        request_id = int(blob.get("_count", 0)) + 1

        score = _score(ta)
        price = _num(ta, "current_price")
        rsi = _num(ta, "rsi", 50.0)
        macd_hist = _num(ta, "macd_hist")
        ema50 = _num(ta, "ema50")
        ema200 = _num(ta, "ema200")
        change_24h = _num(ta, "change_24h")
        vol_ratio = _num(ta, "volume_ratio", 1.0)
        htf_trend = str(ta.get("htf_trend", "neutral"))
        is_ranging = str(ta.get("is_ranging", "false")).lower() == "true"

        facts = (
            f"Asset: {coin_local}\n"
            f"Timeframe: {tf_local}\n"
            f"Price: {price}\n"
            f"RSI(14): {rsi}\n"
            f"MACD histogram: {macd_hist}\n"
            f"EMA50: {ema50}\n"
            f"EMA200: {ema200}\n"
            f"24h change percent: {change_24h}\n"
            f"Volume vs 20-period average (ratio): {vol_ratio}\n"
            f"Higher timeframe trend: {htf_trend}\n"
            f"Ranging market: {is_ranging}\n"
            f"Deterministic bullish-factor score (0 to 6): {score}\n"
        )

        # ── Jury call 1: trend ──────────────────────────────
        # ONE word from three fixed options. The smallest possible
        # non-deterministic surface, which is what lets independent
        # validator models actually agree under the Equivalence Principle.
        def judge_trend() -> str:
            prompt = (
                "You are one juror on a panel of technical analysts.\n"
                "Read the indicator readings and decide the market direction.\n\n"
                f"{facts}\n"
                "Decision rules, apply strictly and in order:\n"
                "- If the score is 5 or 6, answer bullish.\n"
                "- If the score is 0 or 1, answer bearish.\n"
                "- If the score is 2, 3 or 4, answer neutral.\n\n"
                "Reply with EXACTLY ONE lowercase word and nothing else: "
                "bullish or bearish or neutral"
            )
            raw = gl.nondet.exec_prompt(prompt)
            picked = _pick(raw, ["bullish", "bearish", "neutral"])
            if picked == "":
                if score >= 5:
                    return "bullish"
                if score <= 1:
                    return "bearish"
                return "neutral"
            return picked

        trend = gl.eq_principle.strict_eq(judge_trend)

        # ── Jury call 2: confidence ─────────────────────────
        def judge_confidence() -> str:
            prompt = (
                "You are one juror on a panel of technical analysts.\n"
                "Rate how strong and internally consistent this setup is.\n\n"
                f"{facts}\n"
                "Decision rules, apply strictly and in order:\n"
                "- If ranging market is True, answer LOW.\n"
                "- Else if the score is 0, 1, 5 or 6, answer HIGH.\n"
                "- Else answer MEDIUM.\n\n"
                "Reply with EXACTLY ONE word in capitals and nothing else: "
                "HIGH or MEDIUM or LOW"
            )
            raw = gl.nondet.exec_prompt(prompt)
            picked = _pick(raw, ["HIGH", "MEDIUM", "LOW"])
            if picked == "":
                if is_ranging:
                    return "LOW"
                if score in (0, 1, 5, 6):
                    return "HIGH"
                return "MEDIUM"
            return picked

        confidence = gl.eq_principle.strict_eq(judge_confidence)

        # ── Everything below is computed, not generated ─────
        probs = _probabilities(trend, confidence, score)

        if _has(ta, "rsi"):
            if rsi > 70:
                rsi_txt = "Overbought at " + str(rsi)
            elif rsi < 30:
                rsi_txt = "Oversold at " + str(rsi)
            else:
                rsi_txt = "Neutral at " + str(rsi)
        else:
            rsi_txt = "unavailable"

        if _has(ta, "macd_hist"):
            macd_txt = "Positive momentum" if macd_hist > 0 else "Negative momentum"
        else:
            macd_txt = "unavailable"

        if _has(ta, "ema50") and _has(ta, "ema200"):
            ema_txt = ("Golden cross, EMA50 above EMA200" if ema50 > ema200
                       else "Death cross, EMA50 below EMA200")
        elif _has(ta, "ema50"):
            ema_txt = "Price above EMA50" if price > ema50 else "Price below EMA50"
        else:
            ema_txt = "unavailable"

        if _has(ta, "volume_ratio"):
            if vol_ratio > 1.3:
                vol_txt = "Above average volume"
            elif vol_ratio < 0.7:
                vol_txt = "Below average volume"
            else:
                vol_txt = "Average volume"
        else:
            vol_txt = "unavailable"

        if trend == "bullish":
            reason = "Majority of indicators point up, score " + str(score) + "/6"
            insight = "Bullish structure with " + confidence.lower() + " conviction"
            verdict = ("Indicators favour the upside on " + tf_local
                       + " with " + confidence.lower() + " confidence")
        elif trend == "bearish":
            reason = "Majority of indicators point down, score " + str(score) + "/6"
            insight = "Bearish structure with " + confidence.lower() + " conviction"
            verdict = ("Indicators favour the downside on " + tf_local
                       + " with " + confidence.lower() + " confidence")
        else:
            reason = "Indicators are mixed, score " + str(score) + "/6"
            insight = "No clear edge in either direction right now"
            verdict = "No decisive edge on " + tf_local + ", indicators are mixed"

        if is_ranging:
            insight = "Ranging market, treat signals with caution"

        result = {
            "coin": coin_local,
            "tf": tf_local,
            "trend": trend,
            "trend_reason": reason,
            "key_insight": insight,
            "verdict": verdict,
            "confidence": confidence,
            "signal_score": str(score) + "/6",
            "bull_probability": probs["bull"],
            "bear_probability": probs["bear"],
            "neutral_probability": probs["neutral"],
            "bull_condition": "Reclaim resistance 1 on above-average volume",
            "bear_condition": "Lose support 1 on above-average volume",
            "rsi_interpretation": rsi_txt,
            "macd_interpretation": macd_txt,
            "ema_interpretation": ema_txt,
            "volume_interpretation": vol_txt,
            "is_ranging": "true" if is_ranging else "false",
            "request_id": request_id,
        }

        blob["_count"] = request_id
        blob[coin_local + "|" + tf_local] = result
        self.results[sender] = json.dumps(blob)
        return json.dumps(result)

    @gl.public.view
    def get_result(self, user_address: str, coin: str, tf: str) -> str:
        key = coin.upper().strip() + "|" + tf.lower().strip()
        try:
            raw_blob = self.results[Address(user_address)]
            if not raw_blob:
                return ""
            blob = json.loads(raw_blob)
            if not isinstance(blob, dict):
                return ""
            entry = blob.get(key)
            if entry is None:
                return ""
            return json.dumps(entry)
        except Exception:
            return ""
