import glob
import json
import os
import re
import shutil
import struct
import subprocess
import sys


def _exe_dir():
    return os.path.dirname(os.path.abspath(sys.executable if hasattr(sys, "frozen") else __file__))


def _resolve(tool: str) -> str:
    for root in (_exe_dir(), os.getcwd()):
        p = os.path.join(root, tool + ".exe")
        if os.path.isfile(p):
            return p
    found = shutil.which(tool)
    if found:
        return found
    for root in (
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Packages"),
        os.path.join(os.environ.get("PROGRAMFILES", "C:\\Program Files"), "FFmpeg"),
    ):
        if not os.path.isdir(root):
            continue
        for p in glob.glob(os.path.join(root, "**", tool + ".exe"), recursive=True):
            return p
    return tool


def ffmpeg_available() -> bool:
    return shutil.which(FFMPEG) is not None or os.path.isfile(FFMPEG)


FFMPEG = _resolve("ffmpeg")
FFPROBE = _resolve("ffprobe")

HW_ENCODER_NAMES = {
    "h264_nvenc": "NVIDIA 显卡加速",
    "h264_amf": "AMD 显卡加速",
    "h264_qsv": "Intel 核显加速",
}

BLUR_RADIUS = {"light": 8, "standard": 24, "heavy": 60}

FILTERS = {
    "none": None,
    "no_blood_soft": "huesaturation=colors=r:saturation=-1:intensity=-0.5:lightness=1",
    "no_blood_strong": "huesaturation=colors=r:saturation=-1:intensity=-1:lightness=0",
    "bw": "hue=s=0",
}

FONT_MSYH = "C:/Windows/Fonts/msyh.ttc"

SIZES = {"small": (46, 40), "medium": (52, 46), "large": (30, 54)}

COLORS = {
    "yellow": "&H004AD5FF",
    "white": "&H00FFFFFF",
    "green": "&H0040D86E",
}


def _run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-2000:] or f"命令失败: {' '.join(cmd[:3])}")
    return r


def probe(path: str) -> dict:
    r = _run([FFPROBE, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path])
    return json.loads(r.stdout)


def video_info(path: str) -> dict:
    p = probe(path)
    vs = next((s for s in p["streams"] if s["codec_type"] == "video"), None)
    if not vs:
        raise RuntimeError("没有找到视频流")
    subs = []
    for s in p["streams"]:
        if s["codec_type"] == "subtitle":
            subs.append(
                {
                    "index": s["index"],
                    "codec": s["codec_name"],
                    "language": s.get("tags", {}).get("language", ""),
                    "title": s.get("tags", {}).get("title", ""),
                }
            )
    fps = 24.0
    rate = vs.get("r_frame_rate", "")
    if rate and "/" in rate:
        num, _, den = rate.partition("/")
        try:
            if float(den):
                fps = float(num) / float(den)
        except ValueError:
            pass
    start_time = 0.0
    try:
        start_time = float(vs.get("start_time", 0) or 0)
    except (TypeError, ValueError):
        start_time = 0.0
    as_ = next((s for s in p["streams"] if s["codec_type"] == "audio"), None)
    audio_codec = ""
    audio_channels = 0
    if as_:
        audio_codec = as_.get("codec_name", "")
        try:
            audio_channels = int(as_.get("channels", 0) or 0)
        except (TypeError, ValueError):
            audio_channels = 0
    return {
        "width": vs["width"],
        "height": vs["height"],
        "duration": float(p["format"].get("duration", 0)),
        "fps": round(fps, 3),
        "start_time": start_time,
        "subtitles": subs,
        "color_transfer": vs.get("color_transfer", "") or "",
        "color_primaries": vs.get("color_primaries", "") or "",
        "audio_codec": audio_codec,
        "audio_channels": audio_channels,
    }


def extract_subtitle(path: str, stream_index: int, out_srt: str):
    _run([FFMPEG, "-y", "-i", path, "-map", f"0:{stream_index}", out_srt])


def normalize_timebase(path: str, out_path: str):
    p = probe(path)
    off = 0.0
    try:
        vs = next(s for s in p["streams"] if s["codec_type"] == "video")
        off = float(vs.get("start_time", 0) or 0)
    except (StopIteration, TypeError, ValueError):
        off = 0.0
    if off > 0.01:
        _run(
            [
                FFMPEG, "-y", "-output_ts_offset", f"-{off:.3f}",
                "-i", path, "-map", "0", "-c", "copy",
                out_path,
            ]
        )
        return off
    return 0.0


def detect_hw_encoder():
    try:
        out = _run([FFMPEG, "-hide_banner", "-encoders"]).stdout
    except RuntimeError:
        return None
    candidates = []
    if "h264_nvenc" in out:
        candidates.append(("h264_nvenc", ["-preset", "p4", "-cq", "21", "-b:v", "0"]))
    if "h264_amf" in out:
        candidates.append(("h264_amf", ["-quality", "quality", "-rc", "cqp", "-qp_i", "21", "-qp_p", "23"]))
    if "h264_qsv" in out:
        candidates.append(("h264_qsv", ["-global_quality", "21", "-forced_idr", "1"]))
    for name, args in candidates:
        test = [
            FFMPEG, "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc=duration=0.5:size=320x240:rate=25",
            "-c:v", name, *args, "-f", "null", "-",
        ]
        r = subprocess.run(test, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode == 0:
            return name, args
    return None


def _ass_time(t: float) -> str:
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    return f"{h}:{m:02}:{s:05.2f}"


def _ass_text(text: str) -> str:
    text = re.sub(r"</?[a-zA-Z]+>", "", text)
    return text.replace("\\", "＼").replace("{", "｛").replace("}", "｝").replace("\n", "\\N")


def _ass_header(style: dict) -> str:
    en_size, cn_size = SIZES.get(style.get("cn_size", "medium"), SIZES["medium"])
    cn_color = COLORS.get(style.get("cn_color", "yellow"), COLORS["yellow"])
    cn_only = style.get("mode", "cn_only") == "cn_only"
    cn_margin = 42 if cn_only else 115
    return f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: EN,Microsoft YaHei,{en_size},&H00FFFFFF,&H00FFFFFF,&H00101010,&H96000000,0,0,0,0,100,100,0,0,1,2,1,2,30,30,42,1
Style: CN,Microsoft YaHei,{cn_size},{cn_color},{cn_color},&H00101010,&H96000000,0,0,0,0,100,100,0,0,1,2,1,2,30,30,{cn_margin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def build_bilingual_ass(lines, translated: list[str], out_path: str, style: dict = None):
    style = style or {}
    cn_only = style.get("mode", "cn_only") == "cn_only"
    parts = [_ass_header(style)]
    for i, line in enumerate(lines):
        start, end = _ass_time(line.start), _ass_time(line.end)
        if not cn_only:
            parts.append(f"Dialogue: 0,{start},{end},EN,,0,0,0,,{_ass_text(line.text)}")
        cn = translated[i] if i < len(translated) else ""
        if cn.strip():
            parts.append(f"Dialogue: 0,{start},{end},CN,,0,0,0,,{_ass_text(cn)}")
    with open(out_path, "w", encoding="utf-8-sig") as f:
        f.write("\n".join(parts))


def _esc_filter_path(path: str) -> str:
    return path.replace("\\", "/").replace(":", "\\:")


def _fmt_key(t: float) -> str:
    ms = int(round(t * 1000))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02}:{m:02}:{s:02}.{ms:03}"


def _even(n: int) -> int:
    return max(2, n // 2 * 2)


def _time_expr(times):
    return "+".join(f"between(t,{s:.3f},{e:.3f})" for s, e in times)


def _countdown_filters(points, seconds, video_height):
    parts = []
    if not points or seconds <= 0:
        return parts
    fontsize = max(48, (video_height or 1080) // 10)
    border = max(4, fontsize // 14)
    for t in points:
        for i in range(int(seconds), 0, -1):
            s = t - i
            e = t - i + 1
            parts.append(
                f"drawtext=fontfile='{_esc_filter_path(FONT_MSYH)}':text='{i}':"
                f"fontsize={fontsize}:fontcolor=0xFF5A52:borderw={border}:bordercolor=black:"
                f"shadowx=3:shadowy=3:shadowcolor=black@0.7:"
                f"x=80:y=h-{fontsize * 2}:enable='between(t,{s:.3f},{e:.3f})'"
            )
    return parts


def run_with_progress(cmd, on_progress=None):
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    for raw in proc.stdout:
        line = raw.strip()
        if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            try:
                on_progress(int(line.split("=", 1)[1]) / 1e6)
            except (ValueError, TypeError):
                pass
    proc.wait()
    if proc.returncode != 0:
        err = proc.stderr.read()
        raise RuntimeError(err[-2000:] if err else "编码失败")


HDR_FILTER = (
    "libplacebo=tonemapping=bt.2446a:color_primaries=bt709:"
    "color_trc=bt709:gamut_mode=clip,format=yuv420p"
)

HDR_FILTER_CPU = (
    "zscale=t=linear:npl=100,format=gbrpf32le,"
    "zscale=p=bt709,tonemap=hable:desat=0,"
    "zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
)


def encode_with_effects(
    src,
    out_path,
    ass_path=None,
    blur_points=None,
    blur_regions=None,
    blur_strength="standard",
    filter_name="none",
    filter_ranges=None,
    countdown_points=None,
    countdown_seconds=3,
    video_height=None,
    watermark_regions=None,
    force_key_times=None,
    encoder=None,
    on_progress=None,
    is_hdr=False,
    audio_codec="",
):
    blur_points = blur_points or []
    blur_regions = [r for r in (blur_regions or []) if r.get("times")]
    filter_ranges = filter_ranges or []
    countdown_points = countdown_points or []
    watermark_regions = watermark_regions or []
    wm_str = None
    if watermark_regions:
        wm_str = ",".join(
            f"delogo=x={_even(int(r['x']))}:y={_even(int(r['y']))}:w={_even(int(r['w']))}:h={_even(int(r['h']))}"
            for r in watermark_regions
        )
    radius = BLUR_RADIUS.get(blur_strength, 24)
    pre = HDR_FILTER if is_hdr else None
    tail = []
    if wm_str and not blur_regions:
        tail.append(wm_str)
    if blur_points:
        tail.append(f"boxblur={radius}:1:enable='{_time_expr(blur_points)}'")
    f = FILTERS.get(filter_name)
    if f and filter_ranges:
        f += f":enable='{_time_expr(filter_ranges)}'"
        tail.append(f)
    if ass_path:
        tail.append(f"subtitles=filename='{_esc_filter_path(ass_path)}'")
    tail.extend(_countdown_filters(countdown_points, countdown_seconds, video_height))
    if pre:
        tail.insert(0, pre)
    tail_str = ",".join(tail) if tail else "null"

    if not blur_regions:
        cmd = [
            FFMPEG, "-y", "-i", src,
            "-vf", tail_str,
        ]
    else:
        fc = []
        head = f"[0:v]{pre}[h0]" if pre else "[0:v]"
        if wm_str:
            fc.append(f"{head}{wm_str}[d0]")
            fc.append(f"[d0]split={len(blur_regions) + 1}[base]" + "".join(f"[r{i}]" for i in range(len(blur_regions))))
        else:
            fc.append(f"{head}split={len(blur_regions) + 1}[base]" + "".join(f"[r{i}]" for i in range(len(blur_regions))))
        for i, reg in enumerate(blur_regions):
            x = _even(int(reg["x"]))
            y = _even(int(reg["y"]))
            w = _even(int(reg["w"]))
            h = _even(int(reg["h"]))
            fc.append(f"[r{i}]crop={w}:{h}:{x}:{y},boxblur={radius}:1[rc{i}]")
        prev = "[base]"
        for i, reg in enumerate(blur_regions):
            x = _even(int(reg["x"]))
            y = _even(int(reg["y"]))
            out = f"[m{i}]" if i < len(blur_regions) - 1 else "[vout]"
            fc.append(f"{prev}[rc{i}]overlay={x}:{y}:enable='{_time_expr(reg.get('times', []))}'{out}")
            prev = f"[m{i}]"
        fc.append(f"[vout]{tail_str}[vout2]")
        cmd = [
            FFMPEG, "-y", "-i", src,
            "-filter_complex", ";".join(fc),
            "-map", "[vout2]",
            "-map", "0:a?",
        ]
    if force_key_times:
        cmd += ["-force_key_frames", ",".join(_fmt_key(t) for t in force_key_times)]
    if encoder:
        name, args = encoder
        cmd += ["-c:v", name, *args]
    else:
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "19"]
    # 每 2 秒一个关键帧：切段时切口最多偏 2 秒（配合切点强制关键帧可达 0 偏差）
    cmd += ["-g", "48"]
    if audio_codec in ("aac", "mp3"):
        cmd += ["-c:a", "copy"]
    elif audio_codec:
        cmd += ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]
    else:
        cmd += ["-c:a", "copy"]
    cmd += [
        "-progress", "pipe:1", "-nostats", "-loglevel", "error",
        out_path,
    ]
    if is_hdr:
        try:
            run_with_progress(cmd, on_progress)
        except RuntimeError:
            # libplacebo 不可用时回退 CPU 色调映射
            fallback = [HDR_FILTER_CPU if x == HDR_FILTER else x for x in cmd]
            for i, x in enumerate(fallback):
                if isinstance(x, str) and HDR_FILTER in x and HDR_FILTER_CPU not in x:
                    fallback[i] = x.replace(HDR_FILTER, HDR_FILTER_CPU)
            run_with_progress(fallback, on_progress)
    else:
        run_with_progress(cmd, on_progress)


def _fix_mvhd_duration(path: str) -> bool:
    dur_sec = video_info(path)["duration"]
    try:
        with open(path, "r+b") as f:
            f.seek(0, 2)
            size = f.tell()
            chunk = min(4 * 1024 * 1024, size)
            f.seek(size - chunk)
            data = f.read(chunk)
            idx = data.find(b"mvhd")
            if idx < 0:
                f.seek(0)
                data = f.read(chunk)
                idx = data.find(b"mvhd")
                if idx < 0:
                    return False
                pos = idx
            else:
                pos = size - chunk + idx
            f.seek(pos + 4)
            version = f.read(1)[0]
            ts_pos = pos + 4 + 1 + 3 + (16 if version == 1 else 8)
            f.seek(ts_pos)
            ts = struct.unpack(">I", f.read(4))[0]
            new_dur = int(round(dur_sec * ts))
            f.seek(ts_pos + 4)
            if version == 1:
                f.write(struct.pack(">Q", new_dur))
            else:
                f.write(struct.pack(">I", new_dur))
        return True
    except OSError:
        return False


def split_segments(full_path: str, out_dir: str, segment_seconds: int = None, cut_points=None):
    os.makedirs(out_dir, exist_ok=True)
    for stale in os.listdir(out_dir):
        if re.match(r"part_\d+\.mp4$", stale):
            os.remove(os.path.join(out_dir, stale))
    if cut_points:
        dur = video_info(full_path)["duration"]
        bounds = [0.0] + [float(t) for t in sorted(set(cut_points))] + [dur]
        parts = []
        for i, (a, b) in enumerate(zip(bounds, bounds[1:]), 1):
            if b - a < 0.5:
                continue
            out = os.path.join(out_dir, f"part_{i:03d}.mp4")
            # -ss 放在 -i 之前：视频音频从同一关键帧起切，物理同步（不依赖 edit list）；
            # 成片按 -g 48（2 秒）和切点强制关键帧编码，切口偏差 ≤2 秒
            _run(
                [
                    FFMPEG, "-y", "-ss", f"{a:.3f}", "-i", full_path,
                    "-t", f"{b - a:.3f}", "-map", "0", "-c", "copy",
                    out,
                ]
            )
            _fix_mvhd_duration(out)
            parts.append(out)
        return parts
    pattern = os.path.join(out_dir, "part_%03d.mp4")
    _run(
        [
            FFMPEG, "-y", "-i", full_path,
            "-map", "0", "-c", "copy",
            "-f", "segment", "-segment_time", str(segment_seconds),
            "-reset_timestamps", "1",
            pattern,
        ]
    )
    parts = sorted(f for f in os.listdir(out_dir) if re.match(r"part_\d+\.mp4", f))
    full_parts = [os.path.join(out_dir, p) for p in parts]
    for p in full_parts:
        _fix_mvhd_duration(p)
    return full_parts
