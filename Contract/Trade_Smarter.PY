# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

import json
import typing


class AlphaSignal(gl.Contract):
    # Latest analysis result per user, stored as a JSON string.
    # (Address-keyed TreeMap — verified pattern from user_storage.py)
    results: TreeMap[Address, str]

    def __init__(self):
        pass

    @gl.public.write
    def request_analysis(self, coin: str, tf: str, ta_json: str, lang: str) -> str:
        coin_local = coin.upper().strip()
        tf_local = tf.lower().strip()
        lang_local = lang if lang else "en"
        ta_local = ta_json

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
- "coin" MUST be exactly "{coin_local}".
- bull_probability + bear_probability + neutral_probability MUST sum to 100.
- Output must be parseable by a strict JSON parser with no errors.
"""
            raw = gl.nondet.exec_prompt(task).replace("```json", "").replace("```", "")
            parsed = json.loads(raw)
            parsed["coin"] = coin_local  # guarantee the frontend's coin-match check passes
            return parsed

        # The verdict is SUBJECTIVE -> comparative equivalence, not strict_eq.
        # >>> RUNTIME-VERIFY: only evaluated when you click "Analyze". If that run
        #     errors on this call, open wizard_of_coin.py and match its eq_principle
        #     call shape. (The schema itself no longer depends on this line.)
        result = gl.eq_principle.prompt_comparative(
            run_jury,
            task=(
                "The two outputs must agree on the same trend "
                "(bullish/bearish/neutral), a similar confidence level, and a "
                "probability split within about 10 percent of each other. "
                "Exact wording of the text fields may differ."
            ),
        )

        result_str = json.dumps(result)
        self.results[gl.message.sender_address] = result_str
        return result_str

    @gl.public.view
    def get_result(self, user_address: str, coin: str, tf: str) -> str:
        try:
            return self.results[Address(user_address)]
        except Exception:
            return ""
