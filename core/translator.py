import re
import threading
import time

import requests

LANGUAGES = {
    "auto": "自动检测",
    "en": "英语",
    "zh": "中文",
    "fr": "法语",
    "de": "德语",
    "es": "西班牙语",
    "ru": "俄语",
    "ja": "日语",
    "ko": "韩语",
    "it": "意大利语",
    "pt": "葡萄牙语",
    "ar": "阿拉伯语",
    "hi": "印地语",
    "th": "泰语",
    "vi": "越南语",
    "tr": "土耳其语",
    "pl": "波兰语",
    "nl": "荷兰语",
    "sv": "瑞典语",
    "da": "丹麦语",
    "no": "挪威语",
    "fi": "芬兰语",
    "el": "希腊语",
    "cs": "捷克语",
    "ro": "罗马尼亚语",
    "hu": "匈牙利语",
    "id": "印尼语",
    "ms": "马来语",
    "uk": "乌克兰语",
    "he": "希伯来语",
    "fa": "波斯语",
    "ta": "泰米尔语",
    "bn": "孟加拉语",
    "ur": "乌尔都语",
    "sw": "斯瓦希里语",
}

TARGET_LANGUAGES = {
    "zh": "简体中文",
    "zh-tw": "繁体中文",
    "en": "英语",
    "ja": "日语",
    "ko": "韩语",
    "fr": "法语",
    "de": "德语",
    "es": "西班牙语",
    "ru": "俄语",
    "pt": "葡萄牙语",
    "ar": "阿拉伯语",
    "it": "意大利语",
    "vi": "越南语",
    "th": "泰语",
    "tr": "土耳其语",
    "hi": "印地语",
    "id": "印尼语",
    "pl": "波兰语",
    "nl": "荷兰语",
}


def build_prompt(source_lang: str, target_lang: str) -> str:
    src = "自动识别语言" if source_lang == "auto" else LANGUAGES.get(source_lang, source_lang)
    dst = TARGET_LANGUAGES.get(target_lang, target_lang)
    return (
        f"你是电影字幕翻译。把台词从{src}翻译成{dst}。要求：\n"
        "1. 只翻译台词本身，不解释，不加任何说明\n"
        "2. 口语化、自然，符合观影习惯，简短有力\n"
        "3. 人名、地名保留常见译法，专有名词可保留原文\n"
        "4. 严格逐条翻译，每条一行，行首必须带原编号 [数字]，不得合并、跳过或遗漏任何一条"
    )


class LLMTranslator:
    def __init__(self, api_key: str, base_url: str, model: str = "deepseek-chat",
                 source_lang: str = "auto", target_lang: str = "zh"):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.system_prompt = build_prompt(source_lang, target_lang)

    def _call(self, lines: list[str], context: list[tuple[str, str]] = None) -> list[str]:
        parts = []
        if context:
            ctx = "\n".join(f"原文: {en}\n译文: {zh}" for en, zh in context)
            parts.append(f"上文（已翻译，仅作语境参考，不要输出这部分）：\n{ctx}")
        parts.append("待翻译：\n" + "\n".join(f"[{i + 1}] {t}" for i, t in enumerate(lines)))
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": self.system_prompt},
                {"role": "user", "content": "\n\n".join(parts)},
            ],
            "temperature": 0.3,
            "stream": False,
        }
        resp = requests.post(
            f"{self.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=180,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        return self._parse(content, len(lines))

    @staticmethod
    def _parse(content: str, count: int) -> list[str]:
        result = [""] * count
        unnumbered = []
        for raw in content.splitlines():
            raw = raw.strip()
            if not raw:
                continue
            m = re.match(r"^\[?(\d+)\]?[.、:：)\s]*\s*(.*)$", raw)
            if m:
                idx = int(m.group(1)) - 1
                if 0 <= idx < count:
                    result[idx] = m.group(2).strip()
            else:
                unnumbered.append(raw)
        for raw in unnumbered:
            for i in range(count):
                if not result[i]:
                    result[i] = raw
                    break
        return result

    def _translate_range(self, texts, start, end, batch_size, on_progress, done_counter):
        out = []
        total = end - start
        context: list[tuple[str, str]] = []
        for i in range(start, end, batch_size):
            batch = texts[i : i + batch_size]
            for attempt in range(3):
                try:
                    result = self._call(batch, context)
                    out.extend(result)
                    context = list(zip(batch[-2:], result[-2:]))
                    break
                except Exception:
                    if attempt == 2:
                        raise
                    time.sleep(2 * (attempt + 1))
            with done_counter["lock"]:
                done_counter["done"] += len(batch)
                if on_progress:
                    on_progress(done_counter["done"], len(texts))
        return out

    def translate(self, texts: list[str], on_progress=None, batch_size: int = 60, workers: int = 3) -> list[str]:
        total = len(texts)
        if total == 0:
            return []
        if workers < 1:
            workers = 1
        if total <= batch_size:
            workers = 1
        per = -(-total // workers)
        per = -(-per // batch_size) * batch_size
        ranges = []
        start = 0
        while start < total:
            end = min(start + per, total)
            ranges.append((start, end))
            start = end
        done_counter = {"done": 0, "lock": threading.Lock()}
        results: dict[int, list[str]] = {}
        if len(ranges) == 1:
            results[0] = self._translate_range(texts, 0, total, batch_size, on_progress, done_counter)
        else:
            threads = []
            for idx, (s, e) in enumerate(ranges):
                t = threading.Thread(
                    target=lambda i, a, b: results.update(
                        {i: self._translate_range(texts, a, b, batch_size, on_progress, done_counter)}
                    ),
                    args=(idx, s, e),
                    daemon=True,
                )
                threads.append(t)
                t.start()
            for t in threads:
                t.join()
        out = []
        for i in sorted(results):
            out.extend(results[i])
        return out
