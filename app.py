import ctypes
import json
import logging
import os
import sys
import tempfile
import threading
from ctypes import wintypes

import webview

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from core import ffmpeg_tools as ft
from core.pipeline import Project, process
from core.subtitle import parse_srt
from core.translator import LLMTranslator

VERSION = "0.4.2"

PROVIDERS = {
    "deepseek": {
        "name": "DeepSeek",
        "base_url": "https://api.deepseek.com",
        "models": [
            {"id": "deepseek-v4-pro", "label": "专业版 · 最强，稍慢"},
            {"id": "deepseek-v4-flash", "label": "极速版 · 快，日常够用"},
        ],
    },
    "kimi": {
        "name": "Kimi",
        "base_url": "https://api.moonshot.cn/v1",
        "models": [
            {"id": "kimi-k3", "label": "旗舰 · 100 万字上下文"},
        ],
    },
    "glm": {
        "name": "GLM",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "models": [
            {"id": "glm-4-flash", "label": "免费 · 日常翻译够用"},
            {"id": "GLM-5.3", "label": "编程与智能体 · 100 万字上下文"},
            {"id": "GLM-5.2", "label": "长程任务 · 稳定执行"},
        ],
    },
    "qwen": {
        "name": "千问",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "models": [
            {"id": "qwen3.8-max", "label": "旗舰 · 100 万字上下文"},
            {"id": "qwen3.7-plus", "label": "中档 · 平衡"},
            {"id": "qwen3.8-flash", "label": "高速 · 便宜"},
        ],
    },
}

logging.basicConfig(
    filename=os.path.join(tempfile.gettempdir(), "yingyi.log"),
    level=logging.INFO,
    format="%(asctime)s %(message)s",
)


class _OPENFILENAME(ctypes.Structure):
    _fields_ = [
        ("lStructSize", wintypes.DWORD),
        ("hwndOwner", wintypes.HWND),
        ("hInstance", wintypes.HINSTANCE),
        ("lpstrFilter", wintypes.LPCWSTR),
        ("lpstrCustomFilter", wintypes.LPWSTR),
        ("nMaxCustFilter", wintypes.DWORD),
        ("nFilterIndex", wintypes.DWORD),
        ("lpstrFile", wintypes.LPWSTR),
        ("nMaxFile", wintypes.DWORD),
        ("lpstrFileTitle", wintypes.LPWSTR),
        ("nMaxFileTitle", wintypes.DWORD),
        ("lpstrInitialDir", wintypes.LPCWSTR),
        ("lpstrTitle", wintypes.LPCWSTR),
        ("Flags", wintypes.DWORD),
        ("nFileOffset", wintypes.WORD),
        ("nFileExtension", wintypes.WORD),
        ("lpstrDefExt", wintypes.LPCWSTR),
        ("lCustData", wintypes.LPARAM),
        ("lpfnHook", ctypes.c_void_p),
        ("lpTemplateName", wintypes.LPCWSTR),
    ]


def _pick_file(file_types):
    filter_parts = []
    for desc, pat in file_types:
        filter_parts.append(desc)
        filter_parts.append(pat.replace(" ", ";"))
    filter_str = "\0".join(filter_parts) + "\0\0"
    buf = ctypes.create_unicode_buffer(4096)
    ofn = _OPENFILENAME()
    ofn.lStructSize = ctypes.sizeof(_OPENFILENAME)
    ofn.lpstrFilter = filter_str
    ofn.lpstrFile = ctypes.cast(buf, wintypes.LPWSTR)
    ofn.nMaxFile = 4096
    ofn.lpstrTitle = "选择文件"
    ofn.Flags = 0x00080000 | 0x00001000  # 文件必须存在 | 不改变当前目录
    ok = ctypes.windll.comdlg32.GetOpenFileNameW(ctypes.byref(ofn))
    if not ok:
        return None
    return buf.value


def _check_disk_space(project):
    import shutil

    bitrate = 8e6 if project.video_height >= 2000 else 3e6
    need = project.duration * bitrate / 8 * 1.5 + 500 * 1024 * 1024
    try:
        free = shutil.disk_usage(project.work_dir).free
    except OSError:
        return
    if free < need:
        raise RuntimeError(
            f"磁盘剩余空间不足（需要约 {need / 1024**3:.0f} GB，剩余 {free / 1024**3:.0f} GB）。请清理磁盘后重试。"
        )


def _app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


CONFIG_FILE = os.path.join(_app_dir(), "映译配置.json")


def load_config():
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_config(cfg):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except OSError:
        logging.exception("配置保存失败")


def fonts_dir():
    cand = os.path.join(_app_dir(), "fonts")
    return cand if os.path.isdir(cand) else None


class Api:
    def __init__(self):
        self._window = None

    def attach(self, window):
        self._window = window

    def _emit(self, event, payload=None):
        if not self._window:
            return
        try:
            self._window.evaluate_js(
                f"window.__emit({json.dumps(event)}, {json.dumps(payload, ensure_ascii=False)})"
            )
        except Exception:
            logging.exception("emit 失败: %s", event)

    def get_version(self):
        logging.info("get_version 被调用")
        return VERSION

    def open_video(self):
        logging.info("open_video 被调用（打开文件对话框）")
        return _pick_file(
            [("视频文件", "*.mp4 *.mkv *.avi *.mov *.ts *.m4v *.flv"), ("所有文件", "*.*")]
        )

    def open_srt(self):
        logging.info("open_srt 被调用（打开文件对话框）")
        return _pick_file([("字幕文件", "*.srt *.ass *.ssa *.txt"), ("所有文件", "*.*")])

    def get_providers(self):
        return [
            {"id": pid, "name": p["name"], "models": p["models"]}
            for pid, p in PROVIDERS.items()
        ]

    def get_ai_settings(self):
        cfg = load_config()
        keys = cfg.get("api_keys", {})
        if not keys and cfg.get("api_key"):
            keys = {"deepseek": cfg["api_key"]}
        return {
            "provider": cfg.get("provider", "deepseek"),
            "keys": keys,
            "models": cfg.get("models", {}),
        }

    def set_ai_settings(self, settings):
        cfg = load_config()
        cfg["provider"] = settings.get("provider", "deepseek")
        keys = {}
        for pid, key in (settings.get("keys") or {}).items():
            if key and key.strip():
                keys[pid] = key.strip()
        cfg["api_keys"] = keys
        models = {}
        for pid, m in (settings.get("models") or {}).items():
            if m and m.strip():
                models[pid] = m.strip()
        cfg["models"] = models
        save_config(cfg)

    def analyze(self, path):
        logging.info("analyze 被调用: %s", path)
        return ft.video_info(path)

    def normalize_video(self, path):
        logging.info("normalize_video 被调用: %s", path)
        try:
            info = ft.video_info(path)
        except Exception:
            return {"path": path, "offset": 0}
        if (info.get("start_time", 0) or 0) <= 0.01:
            return {"path": path, "offset": 0}
        import hashlib

        try:
            st = os.stat(path)
            stamp = f"{path}|{st.st_mtime}|{st.st_size}"
        except OSError:
            stamp = path
        key = hashlib.md5(stamp.encode("utf-8")).hexdigest()[:12]
        norm = os.path.join(tempfile.gettempdir(), f"yingyi_norm_{key}.mp4")
        if not os.path.exists(norm):
            logging.info("生成时间归零副本: %s", norm)
            ft.normalize_timebase(path, norm)
        return {"path": norm, "offset": info["start_time"]}

    def extract_subtitle(self, path, stream_index):
        logging.info("extract_subtitle 被调用: %s 轨 %s", path, stream_index)
        out = os.path.join(tempfile.gettempdir(), f"yingyi_sub_{os.getpid()}.srt")
        ft.extract_subtitle(path, stream_index, out)
        with open(out, encoding="utf-8", errors="replace") as f:
            return f.read()

    def read_srt(self, path):
        logging.info("read_srt 被调用: %s", path)
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()

    def save_state(self, video_path, state):
        cache_path = video_path + ".yingyi.json"
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)

    def load_state(self, video_path):
        cache_path = video_path + ".yingyi.json"
        try:
            with open(cache_path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _ensure_hw(self):
        if not hasattr(self, "_hw"):
            enc = ft.detect_hw_encoder()
            if enc:
                self._hw = {
                    "available": True,
                    "name": ft.HW_ENCODER_NAMES.get(enc[0], enc[0]),
                    "encoder": enc[0],
                    "args": enc[1],
                }
            else:
                self._hw = {"available": False}
        return self._hw

    def get_hw_info(self):
        hw = self._ensure_hw()
        return {"available": hw["available"], "name": hw.get("name", "")}

    def start_translate(self, provider, api_key, model, src_lang, dst_lang, texts):
        def work():
            try:
                p = PROVIDERS.get(provider, PROVIDERS["deepseek"])
                self._emit("translate_progress", {"done": 0, "total": len(texts)})
                translator = LLMTranslator(
                    api_key,
                    p["base_url"],
                    model or p["models"][0]["id"],
                    source_lang=src_lang or "auto",
                    target_lang=dst_lang or "zh",
                )
                result = translator.translate(
                    texts,
                    on_progress=lambda done, total: self._emit(
                        "translate_progress", {"done": done, "total": total}
                    ),
                )
                self._emit("translate_done", {"result": result})
            except Exception as e:
                logging.exception("翻译失败")
                self._emit("translate_error", {"message": str(e)})

        threading.Thread(target=work, daemon=True).start()

    def get_languages(self):
        from core.translator import LANGUAGES, TARGET_LANGUAGES

        return {"source": LANGUAGES, "target": TARGET_LANGUAGES}

    def start_export(self, spec):
        def work():
            try:
                if not ft.ffmpeg_available():
                    self._emit(
                        "export_error",
                        {"message": "找不到 FFmpeg 视频引擎。请把 ffmpeg.exe 和 ffprobe.exe 放到映译.exe 旁边，或安装 FFmpeg。"},
                    )
                    return
                logging.info(
                    "导出开始: 打码点=%d 区域=%d 水印=%d 切点=%d 倒计时=%d 滤镜=%s 强度=%s",
                    len(spec.get("blur_points", [])),
                    len(spec.get("blur_regions", [])),
                    len(spec.get("watermark_regions", [])),
                    len(spec.get("cut_points", [])),
                    len(spec.get("countdown_points", [])),
                    spec.get("video_filter"),
                    spec.get("blur_strength"),
                )
                hw = self._ensure_hw()
                logging.info("编码器: %s", hw)
                project = Project(spec["video_path"])
                project.source_path = spec.get("process_path") or spec["video_path"]
                project.duration = float(spec.get("duration", 0))
                project.subtitle_lines = parse_srt(spec.get("srt", ""))
                project.translated_texts = list(spec.get("translated", []))
                project.blur_points = [tuple(p) for p in spec.get("blur_points", [])]
                project.blur_regions = list(spec.get("blur_regions", []))
                project.blur_strength = spec.get("blur_strength", "standard")
                project.cut_points = [float(t) for t in spec.get("cut_points", [])]
                project.segment_minutes = float(spec.get("segment_minutes", 15))
                project.sub_style = dict(spec.get("sub_style", {}))
                project.video_filter = spec.get("video_filter", "none")
                project.filter_ranges = [tuple(r) for r in spec.get("filter_ranges", [])]
                project.countdown_points = [float(t) for t in spec.get("countdown_points", [])]
                project.countdown_seconds = int(spec.get("countdown_seconds", 3))
                project.video_height = int(spec.get("video_height", 0))
                project.watermark_regions = list(spec.get("watermark_regions", []))
                project.time_offset = float(spec.get("video_start_time", 0) or 0)
                project.is_hdr = spec.get("is_hdr", False)
                project.audio_codec = spec.get("audio_codec", "")
                _check_disk_space(project)
                if hw["available"]:
                    project.encoder = (hw["encoder"], hw["args"])

                def on_step(name, done, total):
                    logging.info("导出步骤 %s: %s/%s", name, done, total)
                    self._emit("export_progress", {"step": name, "done": done, "total": total})

                parts = process(project, on_step=on_step)
                logging.info("导出完成: %d 段", len(parts))
                self._emit(
                    "export_done",
                    {"parts": parts, "dir": project.work_dir, "count": len(parts)},
                )
                try:
                    os.startfile(project.work_dir)
                except OSError:
                    logging.exception("打开输出文件夹失败")
            except Exception as e:
                logging.exception("导出失败")
                self._emit("export_error", {"message": str(e)})

        threading.Thread(target=work, daemon=True).start()

    def open_folder(self, path):
        os.startfile(path)


_mutex_handle = None


def _acquire_single_instance():
    global _mutex_handle
    kernel32 = ctypes.windll.kernel32
    _mutex_handle = kernel32.CreateMutexW(None, False, "YingYi_SingleInstance")
    if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        ctypes.windll.user32.MessageBoxW(
            None, "映译已经在运行了。\n请查看任务栏或屏幕上已有的映译窗口。", "映译", 0x40
        )
        sys.exit(0)


def main():
    _acquire_single_instance()
    api = Api()
    page_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web", "index.html")
    page_url = "file:///" + page_path.replace("\\", "/")
    window = webview.create_window(
        "映译",
        page_url,
        js_api=api,
        width=1380,
        height=880,
        min_size=(1100, 720),
        background_color="#0b0908",
    )
    api.attach(window)
    webview.start(debug=False)


if __name__ == "__main__":
    main()
