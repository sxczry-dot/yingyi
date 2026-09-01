import hashlib
import json
import os

from . import ffmpeg_tools as ft
from .subtitle import SubtitleLine, to_srt


class Project:
    def __init__(self, video_path: str):
        self.video_path = video_path
        self.source_path = video_path
        self.name = os.path.splitext(os.path.basename(video_path))[0]
        self.base_dir = os.path.dirname(os.path.abspath(video_path))
        self.work_dir = os.path.join(self.base_dir, self.name + "_导出")
        self.duration = 0.0
        self.subtitle_lines: list[SubtitleLine] = []
        self.translated_texts: list[str] = []
        self.blur_points: list[tuple[float, float]] = []
        self.blur_regions: list[dict] = []
        self.blur_strength = "standard"
        self.cut_points: list[float] = []
        self.segment_minutes = 15
        self.sub_style: dict = {}
        self.video_filter = "none"
        self.filter_ranges: list[tuple[float, float]] = []
        self.countdown_points: list[float] = []
        self.countdown_seconds = 3
        self.video_height = 0
        self.watermark_regions: list[dict] = []
        self.time_offset = 0.0
        self.encoder = None
        self.is_hdr = False
        self.audio_codec = ""

    def prepare(self):
        os.makedirs(self.work_dir, exist_ok=True)

    def settings_fingerprint(self) -> str:
        payload = {
            "blur_points": self.blur_points,
            "blur_regions": self.blur_regions,
            "blur_strength": self.blur_strength,
            "cut_points": self.cut_points,
            "filter": self.video_filter,
            "filter_ranges": self.filter_ranges,
            "countdown_points": self.countdown_points,
            "countdown_seconds": self.countdown_seconds,
            "watermark_regions": self.watermark_regions,
            "sub_lines": len(self.subtitle_lines),
            "sub_head": [l.text[:40] for l in self.subtitle_lines[:10]],
            "sub_style": self.sub_style,
            "duration": round(self.duration, 1),
            "video_path": self.video_path,
            "is_hdr": self.is_hdr,
            "audio_codec": self.audio_codec,
        }
        return hashlib.md5(
            json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()[:12]


def _reuse_full(full_path: str, project: Project) -> bool:
    fp_file = full_path + ".指纹"
    try:
        with open(fp_file, encoding="utf-8") as f:
            saved = f.read().strip()
    except OSError:
        return False
    if saved != project.settings_fingerprint():
        return False
    try:
        return abs(ft.video_info(full_path)["duration"] - project.duration) < 2
    except Exception:
        return False


def process(project: Project, on_step=None) -> list[str]:
    def step(name, done, total):
        if on_step:
            on_step(name, done, total)

    off = project.time_offset

    def shift(points):
        return [(s + off, e + off) for s, e in points]

    subtitle_lines = [
        SubtitleLine(l.index, l.start + off, l.end + off, l.text) for l in project.subtitle_lines
    ]

    project.prepare()
    ass_path = None
    if subtitle_lines and project.translated_texts:
        step("合成字幕", 0, 1)
        ass_path = os.path.join(project.work_dir, "_双语字幕.ass")
        ft.build_bilingual_ass(
            subtitle_lines, project.translated_texts, ass_path, style=project.sub_style
        )

        zh_lines = [
            SubtitleLine(
                i,
                l.start,
                l.end,
                project.translated_texts[i - 1] if i - 1 < len(project.translated_texts) else "",
            )
            for i, l in enumerate(subtitle_lines, 1)
        ]
        with open(os.path.join(project.work_dir, "_中文字幕.srt"), "w", encoding="utf-8-sig") as f:
            f.write(to_srt(zh_lines))

    seg_seconds = project.segment_minutes * 60
    full = os.path.join(project.work_dir, "_完整成片.mp4")
    step("压制中", 0, max(project.duration, 1))

    def cb(t):
        step("压制中", t, max(project.duration, 1))

    shifted_regions = []
    for r in project.blur_regions:
        shifted_regions.append({**r, "times": shift(r.get("times", []))})

    if not _reuse_full(full, project):
        ft.encode_with_effects(
            project.source_path,
            full,
            ass_path=ass_path,
            blur_points=shift(project.blur_points),
            blur_regions=shifted_regions,
            blur_strength=project.blur_strength,
            filter_name=project.video_filter,
            filter_ranges=shift(project.filter_ranges),
            countdown_points=[t + off for t in project.countdown_points],
            countdown_seconds=project.countdown_seconds,
            video_height=project.video_height,
            watermark_regions=project.watermark_regions,
            force_key_times=[t + off for t in sorted(set(project.cut_points))] or None,
            encoder=project.encoder,
            on_progress=cb,
            is_hdr=project.is_hdr,
            audio_codec=project.audio_codec,
        )
    else:
        step("复用上次成品", 1, 1)
    with open(full + ".指纹", "w", encoding="utf-8") as f:
        f.write(project.settings_fingerprint())

    step("切段中", 0, 1)
    if project.cut_points:
        parts = ft.split_segments(full, project.work_dir, cut_points=project.cut_points)
    else:
        parts = ft.split_segments(full, project.work_dir, segment_seconds=seg_seconds)
    step("完成", 1, 1)
    return parts
