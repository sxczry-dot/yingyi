"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  videoPath: null,
  processPath: null,
  info: null,
  srtText: "",
  lines: [],
  translated: [],
  blurPoints: [],
  blurRegions: [],
  watermarkRegions: [],
  blurStrength: "standard",
  cutPoints: [],
  segmentMinutes: 15,
  subStyle: { cn_size: "medium", cn_color: "yellow", mode: "cn_only" },
  videoFilter: "none",
  filterRanges: [],
  countdownPoints: [],
  countdownSeconds: 3,
  srcLang: "auto",
  dstLang: "zh",
  outDir: null,
  editingIdx: -1,
  selectMode: false,
  selectPurpose: "region",
  playbackTime: 0,
};

let api = null;

function boot() {
  if (api) return;
  api = window.pywebview ? window.pywebview.api : null;
  if (api) init();
}

window.addEventListener("pywebviewready", boot);

let _bootTries = 0;
const _bootTimer = setInterval(() => {
  if (window.pywebview && window.pywebview.api) {
    clearInterval(_bootTimer);
    boot();
  } else if (++_bootTries > 60) {
    clearInterval(_bootTimer);
    setStatus("通信桥加载失败，请重启应用");
  }
}, 250);

const player = $("player");

/* ============ 工具函数 ============ */

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const round2 = (x) => Math.round(x * 100) / 100;

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function setStatus(text) {
  $("status-text").textContent = text;
}

function toast(msg, isError) {
  const t = document.createElement("div");
  t.textContent = msg;
  Object.assign(t.style, {
    position: "fixed",
    right: "20px",
    bottom: "48px",
    zIndex: "99",
    maxWidth: "440px",
    padding: "10px 16px",
    borderRadius: "8px",
    fontSize: "12px",
    lineHeight: "1.5",
    background: isError ? "#3a1a19" : "#241d10",
    border: `1px solid ${isError ? "#7a3b39" : "#5a451f"}`,
    color: isError ? "#f0a9a7" : "#ecd9a8",
    boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
    transition: "opacity .3s",
  });
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 300);
  }, 4000);
}

function parseSrt(content) {
  const blocks = content.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  const lines = [];
  const tsRe = /(\d+):(\d+):(\d+)[,.](\d+)/;
  const toSec = (ts) => {
    const g = ts.match(tsRe);
    if (!g) return 0;
    return +g[1] * 3600 + +g[2] * 60 + +g[3] + +g[4] / 1000;
  };
  for (const b of blocks) {
    const parts = b.trim().split("\n");
    if (parts.length < 2) continue;
    const m = parts[0].match(/^(\d+)/);
    const idx = m ? +m[1] : lines.length + 1;
    const tm = parts[1].match(/(.+?)\s*-->\s*(.+)/);
    if (!tm) continue;
    lines.push({
      index: idx,
      start: toSec(tm[1]),
      end: toSec(tm[2]),
      text: parts.slice(2).join("\n").trim(),
    });
  }
  return lines;
}

/* ============ Python 事件 ============ */

const handlers = {
  translate_progress(p) {
    $("translate-progress").classList.remove("hidden");
    $("translate-progress-fill").style.width = (p.total ? (p.done / p.total) * 100 : 0) + "%";
    $("translate-progress-text").textContent = `已翻译 ${p.done} / ${p.total} 条`;
    setStatus(`翻译中 ${p.done}/${p.total}`);
  },
  translate_done(p) {
    state.translated = p.result;
    $("translate-progress").classList.add("hidden");
    $("btn-translate").disabled = false;
    renderSubPreview();
    updateExportSummary();
    scheduleSave();
    setStatus("翻译完成");
    toast("翻译完成，可以在「字幕」页核对修改译文");
  },
  translate_error(p) {
    $("translate-progress").classList.add("hidden");
    $("btn-translate").disabled = false;
    setStatus("翻译失败");
    toast("翻译失败：" + p.message, true);
  },
  export_progress(p) {
    if (p.step === "压制中") {
      const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : 0;
      $("progress-fill").style.width = pct + "%";
      setStatus(`压制中 ${fmtTime(p.done)} / ${fmtTime(p.total)}`);
    } else {
      setStatus(p.step + "…");
    }
  },
  export_done(p) {
    state.outDir = p.dir;
    $("progress-fill").style.width = "100%";
    setStatus(`导出完成，共 ${p.count} 段`);
    $("btn-open-folder").classList.remove("hidden");
    $("btn-export").disabled = false;
    toast(`导出完成：共 ${p.count} 段，已保存到「${p.dir}」`);
  },
  export_error(p) {
    setStatus("导出失败");
    $("btn-export").disabled = false;
    toast("导出失败：" + p.message, true);
  },
};

window.__emit = (event, payload) => {
  if (handlers[event]) handlers[event](payload || {});
};

/* ============ 标签页 ============ */

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-page").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $("tab-" + tab.dataset.tab).classList.add("active");
  });
});

/* ============ 打开电影 ============ */

function toFileUrl(p) {
  const parts = p.replace(/\\/g, "/").split("/");
  const drive = parts.shift();
  return "file:///" + drive + "/" + parts.map(encodeURIComponent).join("/");
}

function loadVideo(path) {
  state.videoPath = path;
  player.src = toFileUrl(path);
  $("drop-hint").classList.add("hidden");
}

$("btn-open").addEventListener("click", async () => {
  if (!api) return;
  try {
    const path = await api.open_video();
    if (!path) return;
    state.videoPath = path;
    const norm = await api.normalize_video(path);
    state.processPath = norm.path;
    state.info = await api.analyze(norm.path);
    if (norm.offset > 0.01) {
      toast(`已自动校正时间轴（偏移 ${norm.offset.toFixed(1)} 秒）`);
    }
    state.lines = [];
    state.translated = [];
    state.blurPoints = [];
    state.cutPoints = [];
    state.outDir = null;
    state.editingIdx = -1;
    loadVideo(norm.path);
    $("time-total").textContent = fmtTime(state.info.duration);
    $("btn-export").classList.remove("hidden");
    $("btn-open-folder").classList.add("hidden");
    renderSubSource();
    restoreState();
    updateSegmentInfo();
    updateExportSummary();
    setStatus(`已打开 ${path.split(/[\\/]/).pop()}`);
  } catch (err) {
    toast("打开失败：" + err, true);
  }
});

/* ============ 状态保存与恢复 ============ */

let saveTimer = null;

function scheduleSave() {
  if (!state.videoPath || !api) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.save_state(state.videoPath, {
      srt: state.srtText,
      translated: state.translated,
      blur_points: state.blurPoints,
      blur_regions: state.blurRegions,
      watermark_regions: state.watermarkRegions,
      blur_strength: state.blurStrength,
      cut_points: state.cutPoints,
      segment_minutes: state.segmentMinutes,
      sub_style: state.subStyle,
      video_filter: state.videoFilter,
      filter_ranges: state.filterRanges,
      countdown_points: state.countdownPoints,
      countdown_seconds: state.countdownSeconds,
      playback_time: state.playbackTime,
      src_lang: state.srcLang,
      dst_lang: state.dstLang,
    });
  }, 600);
}

async function restoreState() {
  if (!api) return;
  const saved = await api.load_state(state.videoPath);
  if (!saved) return;
  if (saved.srt) {
    state.srtText = saved.srt;
    state.lines = parseSrt(saved.srt);
    $("translate-status").textContent = `已加载 ${state.lines.length} 条字幕（上次记录）`;
    $("btn-translate").classList.remove("hidden");
  }
  state.translated = saved.translated || [];
  state.blurPoints = saved.blur_points || [];
  state.blurRegions = saved.blur_regions || [];
  state.watermarkRegions = saved.watermark_regions || [];
  state.blurStrength = saved.blur_strength || "standard";
  state.cutPoints = saved.cut_points || [];
  state.segmentMinutes = saved.segment_minutes || 15;
  state.subStyle = saved.sub_style || { cn_size: "medium", cn_color: "yellow", mode: "cn_only" };
  if (!state.subStyle.mode) state.subStyle.mode = "cn_only";
  state.videoFilter = saved.video_filter || "none";
  state.filterRanges = saved.filter_ranges || [];
  state.countdownPoints = saved.countdown_points || [];
  state.countdownSeconds = saved.countdown_seconds || 3;
  state.playbackTime = saved.playback_time || 0;
  state.srcLang = saved.src_lang || "auto";
  state.dstLang = saved.dst_lang || "zh";
  $("select-src-lang").value = state.srcLang;
  $("select-dst-lang").value = state.dstLang;
  $("segment-minutes").value = state.segmentMinutes;
  $("countdown-seconds").value = state.countdownSeconds;
  setRadio("blur-strength", state.blurStrength);
  setRadio("cn-size", state.subStyle.cn_size);
  setRadio("cn-color", state.subStyle.cn_color);
  setRadio("sub-mode", state.subStyle.mode || "cn_only");
  setRadio("video-filter", state.videoFilter);
  renderFilters();
  renderCountdowns();
  renderSubPreview();
  renderBlur();
  renderCutPoints();
  updateSegmentInfo();
  updateExportSummary();
  toast("已恢复上次的字幕、译文和设置");
}

function setRadio(name, value) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((r) => {
    r.checked = r.value === value;
  });
}

/* ============ 播放器 ============ */

$("btn-play").addEventListener("click", () => {
  if (!state.videoPath) {
    toast("请先打开电影", true);
    return;
  }
  if (player.paused) player.play().catch(() => {});
  else player.pause();
});

const SEEK_STEP = 15;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function seekBy(delta) {
  const dur = player.duration || (state.info ? state.info.duration : 0);
  if (!dur) {
    toast("请先打开电影", true);
    return;
  }
  player.currentTime = Math.min(dur, Math.max(0, player.currentTime + delta));
  updateTimeline();
}

$("btn-back").addEventListener("click", () => seekBy(-SEEK_STEP));
$("btn-forward").addEventListener("click", () => seekBy(SEEK_STEP));

/* ============ 倍速播放 ============ */

let speedIdx = 2;

function fmtSpeed(x) {
  return (Number.isInteger(x) ? x : x) + "x";
}

$("btn-speed").addEventListener("click", () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  player.playbackRate = SPEEDS[speedIdx];
  $("btn-speed").textContent = fmtSpeed(SPEEDS[speedIdx]);
});

/* ============ 音量 ============ */

$("vol-slider").addEventListener("input", () => {
  player.volume = parseFloat($("vol-slider").value);
  player.muted = player.volume === 0;
});

/* ============ 全屏 ============ */

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    $("video-wrap").requestFullscreen().catch(() => {});
  }
}

$("btn-fullscreen").addEventListener("click", toggleFullscreen);

/* ============ 点击时间跳转 ============ */

function openTimeInput() {
  const dur = player.duration || (state.info ? state.info.duration : 0);
  if (!dur) {
    toast("请先打开电影", true);
    return;
  }
  $("time-now").classList.add("hidden");
  const input = $("time-input");
  input.classList.remove("hidden");
  input.value = "";
  input.focus();
}

$("time-now").addEventListener("click", openTimeInput);

$("btn-goto").addEventListener("click", openTimeInput);

function parseTimeInput(text) {
  text = text.trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return parseFloat(text);
  const parts = text.split(":");
  if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseFloat(parts[1] || 0);
  if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2] || 0);
  }
  return null;
}

function commitTimeInput() {
  const input = $("time-input");
  input.classList.add("hidden");
  $("time-now").classList.remove("hidden");
  const t = parseTimeInput(input.value);
  if (t === null) return;
  const dur = player.duration || (state.info ? state.info.duration : 0);
  player.currentTime = Math.min(dur, Math.max(0, t));
  updateTimeline();
}

$("time-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") commitTimeInput();
  if (e.key === "Escape") {
    $("time-input").classList.add("hidden");
    $("time-now").classList.remove("hidden");
  }
});

$("time-input").addEventListener("blur", commitTimeInput);

/* ============ 键盘快捷键 ============ */

function frameStep() {
  const fps = (state.info && state.info.fps) || 24;
  return 1 / fps;
}

document.addEventListener("keydown", (e) => {
  const tag = (document.activeElement || {}).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  switch (e.key) {
    case "ArrowLeft":
      e.preventDefault();
      seekBy(e.ctrlKey ? -frameStep() : -SEEK_STEP);
      break;
    case "ArrowRight":
      e.preventDefault();
      seekBy(e.ctrlKey ? frameStep() : SEEK_STEP);
      break;
    case " ":
      e.preventDefault();
      if (!state.videoPath) return;
      if (player.paused) player.play().catch(() => {});
      else player.pause();
      break;
    case "Home":
      e.preventDefault();
      seekBy(-player.currentTime);
      break;
    case "End":
      e.preventDefault();
      seekBy((player.duration || 0) - player.currentTime);
      break;
    case "ArrowUp":
      e.preventDefault();
      player.volume = Math.min(1, player.volume + 0.1);
      $("vol-slider").value = player.volume;
      player.muted = false;
      break;
    case "ArrowDown":
      e.preventDefault();
      player.volume = Math.max(0, player.volume - 0.1);
      $("vol-slider").value = player.volume;
      player.muted = player.volume === 0;
      break;
    case "m":
    case "M":
      player.muted = !player.muted;
      toast(player.muted ? "已静音" : "已取消静音");
      break;
    case "f":
    case "F":
      toggleFullscreen();
      break;
    case "g":
    case "G":
      e.preventDefault();
      openTimeInput();
      break;
  }
});

player.addEventListener("play", () => {
  $("btn-play").innerHTML = '<span class="icon-pause"></span>';
});

player.addEventListener("pause", () => {
  $("btn-play").innerHTML = '<span class="icon-play"></span>';
});

player.addEventListener("loadedmetadata", () => {
  $("time-total").textContent = fmtTime(player.duration || 0);
  if (state.playbackTime > 1) {
    player.currentTime = Math.min(state.playbackTime, player.duration || 0);
    setStatus(`已恢复到上次播放位置 ${fmtTime(state.playbackTime)}`);
  } else {
    setStatus("电影已加载");
  }
  updateTimeline();
  renderMarkers();
  renderCutPoints();
  renderFilters();
  renderCountdowns();
});

player.addEventListener("error", () => {
  setStatus("视频加载失败");
  toast("视频加载失败，请把电影放到英文路径下重试", true);
});

let lastPosSave = 0;

player.addEventListener("timeupdate", () => {
  $("time-now").textContent = fmtTime(player.currentTime);
  if (!dragging) updateTimeline();
  const now = Date.now();
  if (now - lastPosSave > 30000 && player.currentTime > 1) {
    lastPosSave = now;
    state.playbackTime = player.currentTime;
    scheduleSave();
  }
});

player.addEventListener("progress", () => {
  if (player.buffered.length) {
    const end = player.buffered.end(player.buffered.length - 1);
    $("timeline-buffered").style.width = ((end / (player.duration || 1)) * 100) + "%";
  }
});

/* ============ 时间轴 ============ */

let dragging = false;
let wasPlaying = false;

function updateTimeline() {
  const dur = player.duration || (state.info ? state.info.duration : 0);
  if (!dur) return;
  const pct = (player.currentTime / dur) * 100;
  $("timeline-played").style.width = pct + "%";
  $("timeline-thumb").style.left = pct + "%";
}

function renderMarkers() {
  const dur = player.duration || (state.info ? state.info.duration : 0);
  if (!dur) return;
  let html = "";
  state.blurPoints.forEach(([s, e]) => {
    html += `<div class="blur-marker" style="left:${(s / dur) * 100}%;width:${Math.max(0.3, ((e - s) / dur) * 100)}%"></div>`;
  });
  state.blurRegions.forEach((r) => {
    r.times.forEach(([s, e]) => {
      html += `<div class="blur-marker region" style="left:${(s / dur) * 100}%;width:${Math.max(0.3, ((e - s) / dur) * 100)}%"></div>`;
    });
  });
  $("timeline-markers").innerHTML = html;
}

function seekTo(clientX) {
  const dur = player.duration || (state.info ? state.info.duration : 0);
  if (!dur) return;
  const rect = $("timeline").getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  player.currentTime = pct * dur;
  updateTimeline();
}

$("timeline").addEventListener("pointerdown", (e) => {
  dragging = true;
  wasPlaying = !player.paused;
  player.pause();
  seekTo(e.clientX);
  $("timeline").setPointerCapture(e.pointerId);
});

$("timeline").addEventListener("pointermove", (e) => {
  if (dragging) seekTo(e.clientX);
});

$("timeline").addEventListener("pointerup", () => {
  if (!dragging) return;
  dragging = false;
  if (wasPlaying) player.play().catch(() => {});
});

/* ============ 字幕 ============ */

function renderSubSource() {
  const box = $("sub-source");
  const pickBtn = $("btn-pick-srt");
  const streams = (state.info && state.info.subtitles) || [];
  if (!streams.length) {
    box.innerHTML = '<p class="muted">没有检测到内嵌字幕，请手动选择字幕文件</p>';
    pickBtn.classList.remove("hidden");
    return;
  }
  const lang = (s) => s.language || s.title || "未知";
  const opts = streams
    .map((s) => `<option value="${s.index}">字幕轨 #${s.index}（${lang(s)}）</option>`)
    .join("");
  box.innerHTML = `<select id="sub-stream" class="stream-select">${opts}</select>`;
  const sel = $("sub-stream");
  const engIdx = streams.findIndex((s) => /^en/i.test(s.language));
  sel.selectedIndex = engIdx >= 0 ? engIdx : 0;
  sel.addEventListener("change", () => extractStream(+sel.value));
  extractStream(+sel.value);
}

async function extractStream(idx) {
  try {
    setStatus("提取字幕中…");
    state.srtText = await api.extract_subtitle(state.processPath, idx);
    state.lines = parseSrt(state.srtText);
    state.translated = [];
    $("translate-status").textContent = `已加载 ${state.lines.length} 条外语字幕`;
    $("btn-translate").classList.remove("hidden");
    renderSubPreview();
    updateExportSummary();
    scheduleSave();
    setStatus("字幕提取完成");
  } catch (err) {
    toast("字幕提取失败：" + err, true);
  }
}

$("btn-pick-srt").addEventListener("click", async () => {
  try {
    const path = await api.open_srt();
    if (!path) return;
    state.srtText = await api.read_srt(path);
    state.lines = parseSrt(state.srtText);
    state.translated = [];
    $("translate-status").textContent = `已加载 ${state.lines.length} 条字幕`;
    $("btn-translate").classList.remove("hidden");
    renderSubPreview();
    updateExportSummary();
    scheduleSave();
    setStatus("字幕文件已加载");
  } catch (err) {
    toast("读取字幕失败：" + err, true);
  }
});

$("btn-translate").addEventListener("click", async () => {
  if (!state.lines.length) {
    toast("还没有字幕，请先在上方加载字幕文件", true);
    return;
  }
  const key = aiState.keys[aiState.provider] || "";
  if (!key) {
    toast("请先在设置里填写 API Key", true);
    openSettings();
    return;
  }
  state.translated = [];
  state.editingIdx = -1;
  $("btn-translate").disabled = true;
  api.start_translate(
    aiState.provider,
    aiState.keys[aiState.provider] || "",
    aiState.models[aiState.provider] || "",
    state.srcLang,
    state.dstLang,
    state.lines.map((l) => l.text)
  );
});

document.querySelectorAll(".lang-select").forEach((sel) => {
  sel.addEventListener("change", () => {
    state.srcLang = $("select-src-lang").value;
    state.dstLang = $("select-dst-lang").value;
    scheduleSave();
  });
});

function renderSubPreview() {
  const box = $("sub-preview");
  if (!state.lines.length) {
    box.innerHTML = '<p class="muted">翻译后可在这里核对和修改译文</p>';
    return;
  }
  const parts = [];
  for (let i = 0; i < state.lines.length; i++) {
    const l = state.lines[i];
    const zh = state.translated[i] || "";
    const en = esc(l.text).replace(/\n/g, "<br>");
    const zhHtml =
      i === state.editingIdx
        ? `<input class="zh-input" data-idx="${i}" value="${esc(zh)}">`
        : `<div class="zh" data-idx="${i}">${zh ? esc(zh) : '<span class="muted small">（点击填写译文）</span>'}</div>`;
    parts.push(
      `<div class="sub-item"><div class="en"><span class="idx">#${i + 1}</span>${en}</div>${zhHtml}</div>`
    );
  }
  box.innerHTML = parts.join("");
  $("sub-count").textContent = `共 ${state.lines.length} 条`;
}

function saveEdit(input) {
  if (state.editingIdx < 0) return;
  state.translated[state.editingIdx] = input.value.trim();
  state.editingIdx = -1;
  renderSubPreview();
  updateExportSummary();
  scheduleSave();
}

$("sub-preview").addEventListener("click", (e) => {
  const zh = e.target.closest(".zh");
  if (!zh) return;
  state.editingIdx = +zh.dataset.idx;
  renderSubPreview();
  const input = $("sub-preview").querySelector(".zh-input");
  if (input) {
    input.focus();
    input.select();
  }
});

$("sub-preview").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.classList.contains("zh-input")) {
    saveEdit(e.target);
    e.preventDefault();
  }
});

$("sub-preview").addEventListener(
  "blur",
  (e) => {
    if (e.target.classList.contains("zh-input")) saveEdit(e.target);
  },
  true
);

/* ============ 打码 ============ */

function blurRangeAt(t, dur) {
  const before = parseFloat($("blur-before").value) || 0;
  const after = parseFloat($("blur-after").value) || 1;
  const start = round2(Math.max(0, t - before));
  const end = round2(Math.min(dur, t + after));
  return [start, end];
}

$("btn-add-blur").addEventListener("click", () => {
  const dur = player.duration || (state.info ? state.info.duration : 0);
  if (!dur) {
    toast("请先打开电影", true);
    return;
  }
  const [start, end] = blurRangeAt(player.currentTime, dur);
  state.blurPoints.push([start, end]);
  state.blurPoints.sort((a, b) => a[0] - b[0]);
  renderBlur();
  updateExportSummary();
  scheduleSave();
  toast(`已打码：${fmtTime(start)} → ${fmtTime(end)}（前 ${round2(player.currentTime - start)} 秒、后 ${round2(end - player.currentTime)} 秒）`);
});

document.querySelectorAll('input[name="blur-strength"]').forEach((r) => {
  r.addEventListener("change", () => {
    state.blurStrength = r.value;
    scheduleSave();
  });
});

function renderBlur() {
  const box = $("blur-list");
  const items = [];
  state.blurPoints.forEach(([s, e], i) => {
    items.push(`<div class="blur-item">
      <span class="blur-time">${fmtTime(s)} → ${fmtTime(e)}</span>
      <span class="muted small">整屏 · ${round2(e - s)} 秒</span>
      <button class="blur-del" data-kind="whole" data-i="${i}">删除</button>
    </div>`);
  });
  state.blurRegions.forEach((r, i) => {
    const times = r.times.map(([s, e]) => `${fmtTime(s)}→${fmtTime(e)}`).join("、");
    items.push(`<div class="blur-item region">
      <span class="blur-time">${times}</span>
      <span class="muted small">框内 · ${r.w}×${r.h}</span>
      <button class="blur-del" data-kind="region" data-i="${i}">删除</button>
    </div>`);
  });
  box.innerHTML = items.length
    ? items.join("")
    : '<p class="muted">还没有打码点。播放到想遮住的镜头时点上面的按钮。</p>';
  const n = state.blurPoints.length + state.blurRegions.length;
  $("blur-count").textContent = n ? `共 ${n} 处` : "";
  renderMarkers();
}

$("blur-list").addEventListener("click", (e) => {
  const btn = e.target.closest(".blur-del");
  if (!btn) return;
  if (btn.dataset.kind === "whole") state.blurPoints.splice(+btn.dataset.i, 1);
  else state.blurRegions.splice(+btn.dataset.i, 1);
  renderBlur();
  updateExportSummary();
  scheduleSave();
});

/* ============ 打码：框选模式 ============ */

document.querySelectorAll('input[name="blur-mode"]').forEach((r) => {
  r.addEventListener("change", () => {
    const v = r.value;
    $("blur-whole-panel").classList.toggle("hidden", v !== "whole");
    $("blur-region-panel").classList.toggle("hidden", v !== "region");
    $("blur-watermark-panel").classList.toggle("hidden", v !== "watermark");
    if (v !== "region" && v !== "watermark") exitSelectMode();
    if (v === "watermark") renderWatermarks();
  });
});

function renderWatermarks() {
  const box = $("watermark-list");
  if (!state.watermarkRegions.length) {
    box.innerHTML = '<p class="muted">还没有去水印区域。框选水印位置后，全片都会去除。</p>';
  } else {
    box.innerHTML = state.watermarkRegions
      .map(
        (r, i) => `
        <div class="blur-item region">
          <span class="blur-time">水印区域</span>
          <span class="muted small">${r.w}×${r.h} @ (${r.x},${r.y})</span>
          <button class="blur-del" data-i="${i}">删除</button>
        </div>`
      )
      .join("");
  }
}

$("watermark-list").addEventListener("click", (e) => {
  const btn = e.target.closest(".blur-del");
  if (!btn) return;
  state.watermarkRegions.splice(+btn.dataset.i, 1);
  renderWatermarks();
  updateExportSummary();
  scheduleSave();
});

function videoDisplayRect() {
  const el = player.getBoundingClientRect();
  const vw = player.videoWidth;
  const vh = player.videoHeight;
  if (!vw || !vh) {
    return { left: el.left, top: el.top, scale: 1, width: el.width, height: el.height, vw: 0, vh: 0 };
  }
  const scale = Math.min(el.width / vw, el.height / vh);
  const dispW = vw * scale;
  const dispH = vh * scale;
  return {
    left: el.left + (el.width - dispW) / 2,
    top: el.top + (el.height - dispH) / 2,
    scale,
    width: dispW,
    height: dispH,
    vw,
    vh,
  };
}

function exitSelectMode() {
  state.selectMode = false;
  $("select-layer").classList.add("hidden");
  $("select-box").classList.add("hidden");
}

$("btn-select-region").addEventListener("click", () => {
  const dur = player.duration || (state.info ? state.info.duration : 0);
  if (!dur) {
    toast("请先打开电影", true);
    return;
  }
  state.selectMode = true;
  state.selectPurpose = "region";
  player.pause();
  $("select-hint").textContent = "在画面上按住鼠标拖一个框，松开确认打码区域";
  $("select-layer").classList.remove("hidden");
  $("select-box").classList.add("hidden");
});

$("btn-select-watermark").addEventListener("click", () => {
  const dur = player.duration || (state.info ? state.info.duration : 0);
  if (!dur) {
    toast("请先打开电影", true);
    return;
  }
  state.selectMode = true;
  state.selectPurpose = "watermark";
  player.pause();
  $("select-hint").textContent = "框选水印的位置，松开确认（全片去除）";
  $("select-layer").classList.remove("hidden");
  $("select-box").classList.add("hidden");
});

let selStart = null;

$("select-layer").addEventListener("pointerdown", (e) => {
  if (!state.selectMode) return;
  const wrap = $("video-wrap").getBoundingClientRect();
  selStart = { x: e.clientX - wrap.left, y: e.clientY - wrap.top };
});

$("select-layer").addEventListener("pointermove", (e) => {
  if (!state.selectMode || !selStart) return;
  const wrap = $("video-wrap").getBoundingClientRect();
  const cx = e.clientX - wrap.left;
  const cy = e.clientY - wrap.top;
  const x = Math.min(selStart.x, cx);
  const y = Math.min(selStart.y, cy);
  const w = Math.abs(cx - selStart.x);
  const h = Math.abs(cy - selStart.y);
  const box = $("select-box");
  box.classList.remove("hidden");
  box.style.left = x + "px";
  box.style.top = y + "px";
  box.style.width = w + "px";
  box.style.height = h + "px";
});

$("select-layer").addEventListener("pointerup", (e) => {
  if (!state.selectMode || !selStart) return;
  const wrap = $("video-wrap").getBoundingClientRect();
  const cx = e.clientX - wrap.left;
  const cy = e.clientY - wrap.top;
  const mx = Math.min(selStart.x, cx);
  const my = Math.min(selStart.y, cy);
  const mw = Math.abs(cx - selStart.x);
  const mh = Math.abs(cy - selStart.y);
  selStart = null;
  if (mw < 12 || mh < 12) {
    toast("框太小了，重新拖一个", true);
    return;
  }
  const vr = videoDisplayRect();
  if (!vr.vw || !vr.vh) return;
  const x = Math.round((wrap.left + mx - vr.left) / vr.scale);
  const y = Math.round((wrap.top + my - vr.top) / vr.scale);
  const w = Math.round(mw / vr.scale);
  const h = Math.round(mh / vr.scale);
  const fx = Math.max(0, x);
  const fy = Math.max(0, y);
  const fw = Math.min(x + w, vr.vw) - fx;
  const fh = Math.min(y + h, vr.vh) - fy;
  if (fw < 8 || fh < 8) {
    toast("框超出画面了，重新拖一个", true);
    return;
  }
  if (state.selectPurpose === "watermark") {
    state.watermarkRegions.push({ x: fx, y: fy, w: fw, h: fh });
    toast(`去水印区域已添加（${fw}×${fh}），全片生效`);
    exitSelectMode();
    renderWatermarks();
    updateExportSummary();
    scheduleSave();
    return;
  }
  const dur = state.info ? state.info.duration : (player.duration || 0);
  const [s, e2] = blurRangeAt(player.currentTime, dur);
  const existing = state.blurRegions.find(
    (r) =>
      Math.abs(r.x - fx) < 4 &&
      Math.abs(r.y - fy) < 4 &&
      Math.abs(r.w - fw) < 4 &&
      Math.abs(r.h - fh) < 4
  );
  if (existing) {
    existing.times.push([s, e2]);
    toast(`已追加到同一区域（${fmtTime(s)} → ${fmtTime(e2)}）`);
  } else {
    state.blurRegions.push({ x: fx, y: fy, w: fw, h: fh, times: [[s, e2]] });
    toast(`框选打码已添加（${fmtTime(s)} → ${fmtTime(e2)}，前 ${round2(player.currentTime - s)} 秒、后 ${round2(e2 - player.currentTime)} 秒）`);
  }
  exitSelectMode();
  renderBlur();
  updateExportSummary();
  scheduleSave();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.selectMode) exitSelectMode();
});

/* ============ 滤镜 ============ */

document.querySelectorAll('input[name="video-filter"]').forEach((r) => {
  r.addEventListener("change", () => {
    state.videoFilter = r.value;
    scheduleSave();
    updateExportSummary();
  });
});

$("btn-add-filter").addEventListener("click", () => {
  const dur = player.duration || (state.info ? state.info.duration : 0);
  if (!dur) {
    toast("请先打开电影", true);
    return;
  }
  const len = parseFloat($("filter-duration").value) || 5;
  const start = round2(player.currentTime);
  const end = round2(Math.min(start + len, dur));
  if (end - start < 0.5) {
    toast("太靠近结尾了", true);
    return;
  }
  if (state.filterRanges.some(([s, e]) => Math.abs(s - start) < 0.5)) {
    toast("这里已经有滤镜段了", true);
    return;
  }
  state.filterRanges.push([start, end]);
  state.filterRanges.sort((a, b) => a[0] - b[0]);
  renderFilters();
  updateExportSummary();
  scheduleSave();
  toast(`滤镜段已添加（${fmtTime(start)} 起 ${round2(end - start)} 秒）`);
});

function renderFilters() {
  const box = $("filter-list");
  if (!state.filterRanges.length) {
    box.innerHTML = '<p class="muted">还没有滤镜段。播放到需要处理的镜头处点上面的按钮。</p>';
  } else {
    box.innerHTML = state.filterRanges
      .map(
        ([s, e], i) => `
        <div class="blur-item">
          <span class="blur-time">${fmtTime(s)} → ${fmtTime(e)}</span>
          <span class="muted small">滤镜 · ${round2(e - s)} 秒</span>
          <button class="blur-del" data-i="${i}">删除</button>
        </div>`
      )
      .join("");
  }
  const dur = player.duration || (state.info ? state.info.duration : 0);
  $("timeline-filters").innerHTML = dur
    ? state.filterRanges
        .map(([s, e]) => `<div class="filter-marker" style="left:${(s / dur) * 100}%;width:${Math.max(0.3, ((e - s) / dur) * 100)}%"></div>`)
        .join("")
    : "";
}

$("filter-list").addEventListener("click", (e) => {
  const btn = e.target.closest(".blur-del");
  if (!btn) return;
  state.filterRanges.splice(+btn.dataset.i, 1);
  renderFilters();
  updateExportSummary();
  scheduleSave();
});

/* ============ 倒计时 ============ */

$("btn-add-countdown").addEventListener("click", () => {
  const dur = player.duration || (state.info ? state.info.duration : 0);
  if (!dur) {
    toast("请先打开电影", true);
    return;
  }
  const t = round2(player.currentTime);
  const sec = parseInt($("countdown-seconds").value, 10) || 3;
  if (t < sec + 0.5) {
    toast("太靠近开头了，倒计时放不下", true);
    return;
  }
  if (state.countdownPoints.some((p) => Math.abs(p - t) < 5)) {
    toast("5 秒内已经有倒计时点了", true);
    return;
  }
  state.countdownPoints.push(t);
  state.countdownPoints.sort((a, b) => a - b);
  renderCountdowns();
  updateExportSummary();
  scheduleSave();
  toast(`倒计时已添加（${fmtTime(t - sec)} 出现 3-2-1，${fmtTime(t)} 场景出现）`);
});

function renderCountdowns() {
  const box = $("countdown-list");
  const sec = state.countdownSeconds;
  if (!state.countdownPoints.length) {
    box.innerHTML = '<p class="muted">还没有倒计时点。播放到恐怖场景出现的那一刻，暂停后点上面的按钮。</p>';
  } else {
    box.innerHTML = state.countdownPoints
      .map(
        (t, i) => `
        <div class="blur-item">
          <span class="blur-time">${fmtTime(t - sec)} → ${fmtTime(t)}</span>
          <span class="muted small">场景在 ${fmtTime(t)}</span>
          <button class="blur-del" data-i="${i}">删除</button>
        </div>`
      )
      .join("");
  }
  $("countdown-count").textContent = state.countdownPoints.length ? `共 ${state.countdownPoints.length} 个` : "";
  const dur = player.duration || (state.info ? state.info.duration : 0);
  $("timeline-countdowns").innerHTML = dur
    ? state.countdownPoints
        .map((t) => `<div class="countdown-marker" style="left:${((t - sec) / dur) * 100}%;width:${Math.max(0.3, (sec / dur) * 100)}%"></div>`)
        .join("")
    : "";
}

$("countdown-list").addEventListener("click", (e) => {
  const btn = e.target.closest(".blur-del");
  if (!btn) return;
  state.countdownPoints.splice(+btn.dataset.i, 1);
  renderCountdowns();
  updateExportSummary();
  scheduleSave();
});

$("countdown-seconds").addEventListener("input", () => {
  state.countdownSeconds = parseInt($("countdown-seconds").value, 10) || 3;
  renderCountdowns();
  scheduleSave();
});

/* ============ 切段：手动切点 ============ */

$("btn-add-cut").addEventListener("click", () => {
  const dur = player.duration || (state.info ? state.info.duration : 0);
  if (!dur) {
    toast("请先打开电影", true);
    return;
  }
  const t = round2(player.currentTime);
  if (t < 2 || dur - t < 2) {
    toast("太靠近头尾了，不能在这里切", true);
    return;
  }
  if (state.cutPoints.some((c) => Math.abs(c - t) < 2)) {
    toast("这里附近已经有切点了", true);
    return;
  }
  state.cutPoints.push(t);
  state.cutPoints.sort((a, b) => a - b);
  renderCutPoints();
  updateSegmentInfo();
  updateExportSummary();
  scheduleSave();
  toast(`已在 ${fmtTime(t)} 设切点`);
});

function renderCutPoints() {
  const box = $("cut-list");
  if (!state.cutPoints.length) {
    box.innerHTML = '<p class="muted">还没有切点</p>';
  } else {
    box.innerHTML = state.cutPoints
      .map(
        (t, i) => `
        <div class="blur-item">
          <span class="blur-time">${fmtTime(t)}</span>
          <span class="muted small">第 ${i + 1} 个切点</span>
          <button class="blur-del" data-i="${i}">删除</button>
        </div>`
      )
      .join("");
  }
  const dur = player.duration || (state.info ? state.info.duration : 0);
  $("timeline-cuts").innerHTML = dur
    ? state.cutPoints
        .map((t) => `<div class="cut-marker" style="left:${(t / dur) * 100}%"></div>`)
        .join("")
    : "";
}

$("cut-list").addEventListener("click", (e) => {
  const btn = e.target.closest(".blur-del");
  if (!btn) return;
  state.cutPoints.splice(+btn.dataset.i, 1);
  renderCutPoints();
  updateSegmentInfo();
  updateExportSummary();
  scheduleSave();
});

document.querySelectorAll('input[name="seg-mode"]').forEach((r) => {
  r.addEventListener("change", () => {
    const manual = r.value === "manual";
    $("seg-auto-panel").classList.toggle("hidden", manual);
    $("seg-manual-panel").classList.toggle("hidden", !manual);
    updateSegmentInfo();
    updateExportSummary();
  });
});

/* ============ 字幕样式 ============ */

document.querySelectorAll('input[name="cn-size"]').forEach((r) => {
  r.addEventListener("change", () => {
    state.subStyle.cn_size = r.value;
    scheduleSave();
  });
});

document.querySelectorAll('input[name="cn-color"]').forEach((r) => {
  r.addEventListener("change", () => {
    state.subStyle.cn_color = r.value;
    scheduleSave();
  });
});

document.querySelectorAll('input[name="sub-mode"]').forEach((r) => {
  r.addEventListener("change", () => {
    state.subStyle.mode = r.value;
    scheduleSave();
  });
});

/* ============ 切段 ============ */

function updateSegmentInfo() {
  const dur = state.info ? state.info.duration : 0;
  if (!dur) {
    $("segment-info").textContent = "打开电影后显示预计段数";
    return;
  }
  const manual = document.querySelector('input[name="seg-mode"]:checked').value === "manual";
  if (manual) {
    $("segment-info").textContent = state.cutPoints.length
      ? `电影时长 ${fmtTime(dur)}，已设 ${state.cutPoints.length} 个切点，预计切出 ${state.cutPoints.length + 1} 段`
      : `电影时长 ${fmtTime(dur)}，还没有设切点`;
  } else {
    const count = Math.ceil(dur / (state.segmentMinutes * 60));
    $("segment-info").textContent =
      `电影时长 ${fmtTime(dur)}，按每段 ${state.segmentMinutes} 分钟计算，预计切出 ${count} 段`;
  }
}

$("segment-minutes").addEventListener("input", () => {
  state.segmentMinutes = parseInt($("segment-minutes").value, 10) || 15;
  updateSegmentInfo();
  updateExportSummary();
  scheduleSave();
});

/* ============ 导出 ============ */

function updateExportSummary() {
  const box = $("export-summary");
  if (!state.videoPath) {
    box.innerHTML = '<p class="muted">还没有任务</p>';
    return;
  }
  const manual = document.querySelector('input[name="seg-mode"]:checked').value === "manual";
  const segCount = state.info
    ? Math.ceil(state.info.duration / (state.segmentMinutes * 60))
    : 0;
  const segText = manual
    ? state.cutPoints.length
      ? `${state.cutPoints.length + 1} 段（手动切点）`
      : "未设切点"
    : `${segCount} 段 × ${state.segmentMinutes} 分钟`;
  const blurCount = state.blurPoints.length + state.blurRegions.length;
  const wmCount = state.watermarkRegions.length;
  const filterNames = {
    none: "无",
    no_blood_soft: "去血色·柔和",
    no_blood_strong: "去血色·强力",
    bw: "黑白",
  };
  const filterText =
    state.videoFilter !== "none"
      ? state.filterRanges.length
        ? `${filterNames[state.videoFilter]} ×${state.filterRanges.length}段`
        : `${filterNames[state.videoFilter]}（未设时间段）`
      : "无";
  const rows = [
    ["视频", state.videoPath.split(/[\\/]/).pop()],
    ["字幕", state.lines.length ? `${state.lines.length} 条` : "无"],
    ["翻译", state.translated.length ? "已翻译" : "未翻译"],
    ["打码", blurCount ? `${blurCount} 处` : "无"],
    ["去水印", wmCount ? `${wmCount} 处` : "无"],
    ["滤镜", filterText],
    ["倒计时", state.countdownPoints.length ? `${state.countdownPoints.length} 处` : "无"],
    ["切段", segText],
  ];
  box.innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="summary-row"><span class="summary-key">${k}</span><span class="summary-val">${esc(v)}</span></div>`
    )
    .join("");
}

$("btn-export").addEventListener("click", () => {
  if (!state.videoPath) {
    toast("请先点右上角「打开电影」", true);
    return;
  }
  if (state.translated.length && state.translated.length !== state.lines.length) {
    toast("译文条数与字幕不匹配，请重新翻译", true);
    return;
  }
  const manual = document.querySelector('input[name="seg-mode"]:checked').value === "manual";
  if (manual && !state.cutPoints.length) {
    toast("手动切点模式下还没有设切点", true);
    return;
  }
  $("btn-export").disabled = true;
  $("progress-fill").style.width = "0%";
  setStatus("准备导出…");
  api.start_export({
    video_path: state.videoPath,
    process_path: state.processPath || state.videoPath,
    duration: state.info ? state.info.duration : 0,
    is_hdr: state.info
      ? state.info.color_transfer === "smpte2084" || state.info.color_transfer === "arib-std-b67"
      : false,
    audio_codec: state.info ? state.info.audio_codec || "" : "",
    srt: state.srtText,
    translated: state.translated,
    blur_points: state.blurPoints,
    blur_regions: state.blurRegions,
    watermark_regions: state.watermarkRegions,
    blur_strength: state.blurStrength,
    cut_points: manual ? state.cutPoints : [],
    segment_minutes: state.segmentMinutes,
    sub_style: state.subStyle,
    video_filter: state.videoFilter,
    filter_ranges: state.filterRanges,
    countdown_points: state.countdownPoints,
    countdown_seconds: state.countdownSeconds,
    video_height: state.info ? state.info.height : 0,
    video_start_time: state.info ? state.info.start_time || 0 : 0,
  });
});

$("btn-open-folder").addEventListener("click", () => {
  if (state.outDir) api.open_folder(state.outDir);
});

/* ============ 设置 ============ */

async function openSettings() {
  const key = api ? await api.get_api_key() : "";
  $("input-api-key").value = key || "";
  $("modal-settings").classList.remove("hidden");
}

let aiState = { provider: "deepseek", keys: {}, models: {} };
let aiProviders = [];

async function loadAiSettings() {
  try {
    aiProviders = await api.get_providers();
    const settings = await api.get_ai_settings();
    aiState.provider = settings.provider || "deepseek";
    aiState.keys = settings.keys || {};
    aiState.models = settings.models || {};
    const sel = $("select-provider");
    sel.innerHTML = aiProviders.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
    sel.value = aiState.provider;
    renderModelOptions();
  } catch (e) {}
}

function renderModelOptions() {
  const p = aiProviders.find((x) => x.id === aiState.provider);
  if (!p) return;
  const sel = $("select-model");
  sel.innerHTML = p.models.map((m) => `<option value="${m.id}">${m.id}（${m.label}）</option>`).join("");
  const saved = aiState.models[aiState.provider];
  if (saved && p.models.some((m) => m.id === saved)) sel.value = saved;
}

function currentProviderSettings() {
  return {
    keys: aiState.keys,
    models: aiState.models,
    provider: aiState.provider,
  };
}

$("select-provider").addEventListener("change", () => {
  aiState.provider = $("select-provider").value;
  renderModelOptions();
  $("input-api-key").value = aiState.keys[aiState.provider] || "";
});

$("select-model").addEventListener("change", () => {
  aiState.models[aiState.provider] = $("select-model").value;
});

async function openSettings() {
  $("modal-settings").classList.remove("hidden");
  $("input-api-key").value = aiState.keys[aiState.provider] || "";
}

$("btn-settings").addEventListener("click", openSettings);

$("btn-close-settings").addEventListener("click", () => {
  $("modal-settings").classList.add("hidden");
});

$("btn-save-key").addEventListener("click", async () => {
  aiState.keys[aiState.provider] = $("input-api-key").value.trim();
  await api.set_ai_settings(currentProviderSettings());
  $("modal-settings").classList.add("hidden");
  toast("已保存");
});

$("link-home").addEventListener("click", (e) => {
  e.preventDefault();
});

/* ============ 启动 ============ */

async function loadLanguages() {
  try {
    const langs = await api.get_languages();
    const srcSel = $("select-src-lang");
    const dstSel = $("select-dst-lang");
    srcSel.innerHTML = Object.entries(langs.source)
      .map(([k, v]) => `<option value="${k}">${v}</option>`)
      .join("");
    dstSel.innerHTML = Object.entries(langs.target)
      .map(([k, v]) => `<option value="${k}">${v}</option>`)
      .join("");
    srcSel.value = state.srcLang;
    dstSel.value = state.dstLang;
  } catch (e) {}
}

async function init() {
  if (!api) return;
  try {
    $("app-version").textContent = await api.get_version();
  } catch (e) {}
  loadLanguages();
  loadAiSettings();
  try {
    const hw = await api.get_hw_info();
    $("hw-info").textContent = hw.available
      ? `${hw.name}（压制速度快）`
      : "CPU 压制（速度一般，建议用带独显的电脑）";
  } catch (e) {
    $("hw-info").textContent = "检测失败";
  }
  renderBlur();
  renderCutPoints();
  renderFilters();
  renderCountdowns();
  renderWatermarks();
}
