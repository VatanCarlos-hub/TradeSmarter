# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

import json
import typing


class AlphaSignal(gl.Contract):
    # One JSON blob per user, keyed by asset|timeframe, plus a per-user request counter:
    #   {"_count": 7, "BTC|4h": {...result...}, "ETH|1d": {...result...}, ...}
    #
    # Fixes the reviewer's point: results are no longer stored only by sender.
    # Every analysis is stored under its own (coin, timeframe) key, and every
    # result carries a strictly increasing request_id for that user, so:
    #   - get_result(user, coin, tf) can only return the analysis for THAT asset
    #     and THAT timeframe, never another one;
    #   - the client reads the previous request_id before submitting and accepts
    #     a polled result only if its request_id is greater, so it is guaranteed
    #     to be the newly requested analysis and not an older one.
    #
    # Storage stays a single Address-keyed TreeMap (the only shape verified to
    # load in Studio), so no new storage types are introduced.
    results: TreeMap[Address, str]

    def __init__(self):
        pass

    @gl.public.write
    def request_analysis(self, coin: str, tf: str, ta_json: str, lang: str) -> str:
        coin_local = coin.upper().strip()
        tf_local = tf.lower().strip()
        lang_local = lang if lang else "en"
        ta_local = ta_json
        sender = gl.message.sender_address

        # Load this user's existing blob (or start fresh).
        blob = {}
        try:
            raw_blob = self.results[sender]
            if raw_blob:
                loaded = json.loads(raw_blob)
                if isinstance(loaded, dict):
                    blob = loaded
        except Exception:
            blob = {}

        request_id = int(blob.get("_count", 0)) + 1

        def run_jury() -> typing.Any:
            task = f"""
You are an AI jury of crypto technical analysts. You are given already-computed
technical analysis data for {coin_local} on the {tf_local} timeframe.

Technical analysis data (JSON):
{ta_local}
End of data.

Interpret this data and return a probabilistic trading signal.
Write every human-readable text field in this language code: {lang_local}.

Respond ONLY with a valid JSON object, no markdown fences, no text before or
after it, with EXACTLY these keys:
{{
  "coin": "{coin_local}",
  "tf": "{tf_local}",
  "trend": "bullish" or "bearish" or "neutral",
  "trend_reason": "one short sentence",
  "key_insight": "one short sentence, the single most important takeaway",
  "verdict": "one clear sentence of overall judgment",
  "confidence": "HIGH" or "MEDIUM" or "LOW",
  "signal_score": "a short score string, e.g. 6/10",
  "bull_probability": integer,
  "bear_probability": integer,
  "neutral_probability": integer,
  "bull_condition": "what would confirm the bull case",
  "bear_condition": "what would confirm the bear case",
  "rsi_interpretation": "short reading of RSI",
  "macd_interpretation": "short reading of MACD",
  "ema_interpretation": "short reading of the EMAs / cross",
  "volume_interpretation": "short reading of volume",
  "is_ranging": "true" or "false"
}}

Rules:
- "coin" MUST be exactly "{coin_local}" and "tf" MUST be exactly "{tf_local}".
- bull_probability + bear_probability + neutral_probability MUST sum to 100.
- If a data field is "N/A" or flagged as unavailable (for example ema200 on a
  timeframe with too little history), do NOT invent a value for it. Say in the
  matching interpretation field that it is unavailable and base the verdict on
  the indicators that are present.
- Output must be parseable by a strict JSON parser with no errors.
"""
            raw = gl.nondet.exec_prompt(task).replace("```json", "").replace("```", "")
            parsed = json.loads(raw)
            parsed["coin"] = coin_local
            parsed["tf"] = tf_local
            return parsed

        # The verdict is SUBJECTIVE -> comparative equivalence, not strict_eq:
        # validators must agree the outputs MEAN the same, not be byte-identical.
        result = gl.eq_principle.prompt_comparative(
            run_jury,
            task=(
                "The two outputs must agree on the same trend "
                "(bullish/bearish/neutral), a similar confidence level, and a "
                "probability split within about 10 percent of each other. "
                "Exact wording of the text fields may differ."
            ),
        )

        # Hard guarantees the client relies on.
        result["coin"] = coin_local
        result["tf"] = tf_local
        result["request_id"] = request_id

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
