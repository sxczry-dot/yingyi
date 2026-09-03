import re
from dataclasses import dataclass


@dataclass
class SubtitleLine:
    index: int
    start: float
    end: float
    text: str


_TS = re.compile(r"(\d+):(\d+):(\d+)[,.](\d+)")


def _to_seconds(ts: str) -> float:
    m = _TS.search(ts)
    if not m:
        return 0.0
    h, mi, s, ms = (int(g) for g in m.groups())
    return h * 3600 + mi * 60 + s + ms / 1000


def _fmt(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, rem = divmod(ms, 3600000)
    mi, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02}:{mi:02}:{s:02},{ms:03}"


def parse_srt(content: str) -> list[SubtitleLine]:
    blocks = re.split(r"\n\s*\n", content.replace("\r\n", "\n").strip())
    lines = []
    for b in blocks:
        parts = b.strip().splitlines()
        if len(parts) < 2:
            continue
        m = re.match(r"(\d+)", parts[0])
        idx = int(m.group(1)) if m else len(lines) + 1
        tm = re.search(r"(.+?)\s*-->\s*(.+)", parts[1])
        if not tm:
            continue
        text = "\n".join(parts[2:]).strip()
        text = re.sub(r"\{\\[^}]*\}", "", text).strip()
        lines.append(SubtitleLine(idx, _to_seconds(tm.group(1)), _to_seconds(tm.group(2)), text))
    return lines


_ASS_TAG = re.compile(r"\{\\[^}]*\}")
_BRACKET = re.compile(r"\[[^\]]{1,60}\]")
_PAREN = re.compile(r"\([^)]{1,40}\)")
_SPEAKER = re.compile(r"^[-–—\s]*[A-ZÀ-Ü][A-Z0-9À-Ü '\-.]{1,19}[:：]\s*", re.M)


def filter_line(text: str) -> str:
    """过滤字幕行里的音效描写、ASS 残留标签和人名标注，返回清理后的文本（整行被过滤时返回空串）"""
    text = _ASS_TAG.sub("", text)
    text = _BRACKET.sub("", text)
    text = _PAREN.sub("", text)
    text = _SPEAKER.sub("", text)
    out = []
    for t in text.split("\n"):
        t = re.sub(r"^[-–—]\s*", "", t.strip())
        t = re.sub(r"[ \t]{2,}", " ", t)
        if t:
            out.append(t)
    return "\n".join(out).strip()


def to_srt(lines: list[SubtitleLine]) -> str:
    out = []
    for i, l in enumerate(lines, 1):
        out.append(f"{i}\n{_fmt(l.start)} --> {_fmt(l.end)}\n{l.text}\n")
    return "\n".join(out)
