"use strict";

/* =========================================================
 * 剣道ムービーコーチ
 * 全処理はブラウザ内で完結（動画・音声の外部送信なし）
 * ========================================================= */

const $ = (id) => document.getElementById(id);

const video = $("video");
const subOverlay = $("subOverlay");
const seekBar = $("seekBar");
const timeLabel = $("timeLabel");
const playBtn = $("playBtn");

const state = {
  step: 1,
  videoLoaded: false,
  duration: 0,
  segments: [],   // {id, start, buffer, url, createdAt}
  subtitles: [],  // {id, start, end, text, segId}
  nextId: 1,
  volumes: { original: 1.0, comment: 1.0 },
};

/* ---------------- ユーティリティ ---------------- */

function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
function fmtTimeShort(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t - m * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function parseTime(str) {
  str = String(str).trim();
  if (!str) return NaN;
  if (str.includes(":")) {
    const [m, s] = str.split(":");
    return Number(m) * 60 + Number(s);
  }
  return Number(str);
}
function segEnd(seg) {
  return seg.start + (seg.buffer ? seg.buffer.duration : 0);
}

/* ---------------- ステップ切り替え ---------------- */

function goStep(n) {
  if (exporting) return;
  if (n !== 2) releaseMic();
  state.step = n;
  for (let i = 1; i <= 4; i++) {
    $("step" + i).hidden = i !== n;
    const btn = document.querySelector(`.stepBtn[data-step="${i}"]`);
    btn.classList.toggle("active", i === n);
  }
  window.scrollTo({ top: 0 });
  if (n === 3) renderSubList();
  if (n === 2) renderSegList();
}

document.querySelectorAll(".stepBtn").forEach((btn) => {
  btn.addEventListener("click", () => goStep(Number(btn.dataset.step)));
});

function unlockSteps() {
  document.querySelectorAll(".stepBtn").forEach((b) => (b.disabled = false));
}

$("toStep2").addEventListener("click", () => goStep(2));
$("toStep3").addEventListener("click", () => { stopRecordingIfActive(); goStep(3); });
$("toStep4").addEventListener("click", () => goStep(4));

/* ---------------- Step 1: 動画読み込み ---------------- */

$("fileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  loadVideoFile(file);
});

function loadVideoFile(file) {
  const warn = $("fileWarn");
  warn.hidden = true;
  const warnings = [];
  if (file.size > 100 * 1024 * 1024) {
    warnings.push(`ファイルが${(file.size / 1048576).toFixed(0)}MBあります（推奨100MB以下）。動作が不安定になる可能性があります。`);
  }

  // 前の動画の作業内容をクリア
  stopComments();
  state.segments.forEach((s) => URL.revokeObjectURL(s.url));
  state.segments = [];
  state.subtitles = [];

  const url = URL.createObjectURL(file);
  video.src = url;
  video.load();

  video.onloadedmetadata = () => {
    state.duration = video.duration;
    state.videoLoaded = true;
    seekBar.max = video.duration;

    if (video.duration > 5 * 60 + 5) {
      warnings.push(`動画が${fmtTimeShort(video.duration)}あります（推奨5分以内）。書き出しに同じ時間がかかります。`);
    }
    if (video.videoHeight > 1080 && video.videoWidth > 1080) {
      warnings.push("解像度が1080pを超えています。書き出し時に1080pへ縮小されます。");
    }
    if (warnings.length) {
      warn.innerHTML = "⚠️ " + warnings.join("<br>⚠️ ");
      warn.hidden = false;
    }

    $("videoInfo").innerHTML =
      `<b>${file.name}</b><br>` +
      `長さ: ${fmtTimeShort(video.duration)}　サイズ: ${(file.size / 1048576).toFixed(1)}MB<br>` +
      `解像度: ${video.videoWidth}×${video.videoHeight}`;
    $("videoInfo").hidden = false;
    $("videoWrap").hidden = false;
    $("toStep2").hidden = false;
    unlockSteps();
    updateTransport();
    renderSegTimeline();
  };
  video.onerror = () => {
    warn.textContent = "⚠️ この動画を再生できません。MP4/MOV形式か確認してください。";
    warn.hidden = false;
  };
}

/* ---------------- 共通トランスポート ---------------- */

let seeking = false;

playBtn.addEventListener("click", async () => {
  if (!state.videoLoaded || exporting) return;
  if (video.paused) {
    await ensureAudioGraph();
    if (video.currentTime >= state.duration - 0.05) video.currentTime = 0;
    video.play();
  } else {
    video.pause();
  }
});

seekBar.addEventListener("input", () => {
  if (exporting || recState.active) { seekBar.value = video.currentTime; return; }
  seeking = true;
  video.currentTime = Number(seekBar.value);
});
seekBar.addEventListener("change", () => { seeking = false; });

video.addEventListener("play", () => {
  playBtn.textContent = "⏸";
  if (!exporting && !recState.pendingRec && !recState.active) scheduleCommentsFrom(video.currentTime);
});
video.addEventListener("pause", () => {
  playBtn.textContent = "▶";
  stopComments();
  if (recState.active) stopRecording();
});
video.addEventListener("seeked", () => {
  if (!video.paused && !exporting && !recState.pendingRec && !recState.active) {
    scheduleCommentsFrom(video.currentTime);
  }
  updateTransport();
});
video.addEventListener("ended", () => {
  if (recState.active) stopRecording();
});
video.addEventListener("timeupdate", updateTransport);

function updateTransport() {
  if (!seeking) seekBar.value = video.currentTime;
  timeLabel.textContent = `${fmtTimeShort(video.currentTime)} / ${fmtTimeShort(state.duration)}`;
  updateSubOverlay();
}

function updateSubOverlay() {
  const t = video.currentTime;
  let text = "";
  if (recState.active && recState.interimText) {
    text = recState.interimText;
  } else {
    const sub = state.subtitles.find((s) => t >= s.start && t <= s.end);
    if (sub) text = sub.text;
  }
  if (subOverlay.textContent !== text) subOverlay.textContent = text;
}

setInterval(updateSubOverlay, 100);

// 字幕プレビューの文字サイズを設定に合わせる
function applyOverlaySize() {
  const hPx = video.clientHeight || 200;
  const px = Math.max(13, Math.round(hPx * Number($("subSize").value)));
  subOverlay.style.fontSize = px + "px";
}
$("subSize").addEventListener("change", applyOverlaySize);
window.addEventListener("resize", applyOverlaySize);
video.addEventListener("loadeddata", applyOverlaySize);

/* ---------------- Web Audio グラフ ---------------- */

const audio = {
  ctx: null,
  mediaSrc: null,
  origGain: null,
  commentGain: null,
  mix: null,
  streamDest: null,
};

async function ensureAudioGraph() {
  if (!audio.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new AC();
    audio.mediaSrc = audio.ctx.createMediaElementSource(video);
    audio.origGain = audio.ctx.createGain();
    audio.commentGain = audio.ctx.createGain();
    audio.mix = audio.ctx.createGain();
    audio.streamDest = audio.ctx.createMediaStreamDestination();
    audio.mediaSrc.connect(audio.origGain).connect(audio.mix);
    audio.commentGain.connect(audio.mix);
    audio.mix.connect(audio.ctx.destination);
    audio.mix.connect(audio.streamDest);
    applyVolumes();
  }
  if (audio.ctx.state === "suspended") await audio.ctx.resume();
}

function applyVolumes() {
  if (!audio.ctx) return;
  // 録音中は「録音中の試合の音量」スライダー、それ以外はミックス設定を使う
  audio.origGain.gain.value = recState.active
    ? Number($("recOrigVol").value) / 100
    : state.volumes.original;
  audio.commentGain.gain.value = state.volumes.comment;
}

$("recOrigVol").addEventListener("input", () => {
  $("recOrigVolLabel").textContent = $("recOrigVol").value + "%";
  applyVolumes();
});

/* --- コメント音声のスケジュール再生（プレビュー・書き出し共用） --- */

let activeSources = [];

function scheduleCommentsFrom(videoTime) {
  stopComments();
  if (!audio.ctx || state.segments.length === 0) return;
  const now = audio.ctx.currentTime + 0.05;

  for (const seg of state.segments) {
    if (!seg.buffer) continue;
    const e = segEnd(seg);
    if (e <= videoTime + 0.02) continue;

    const src = audio.ctx.createBufferSource();
    src.buffer = seg.buffer;
    const g = audio.ctx.createGain();
    src.connect(g).connect(audio.commentGain);

    const offset = Math.max(0, videoTime - seg.start);
    const when = seg.start > videoTime ? now + (seg.start - videoTime) : now;

    // 自動音量補正を基準ゲインとして適用
    const base = seg.gain || 1;
    // 新しい録音が優先：後から録った区間と重なる部分はミュート
    g.gain.setValueAtTime(base, now);
    for (const other of state.segments) {
      if (other.createdAt <= seg.createdAt || !other.buffer) continue;
      const os = Math.max(other.start, seg.start);
      const oe = Math.min(segEnd(other), e);
      if (oe <= os) continue;
      const tOn = now + (os - videoTime);
      const tOff = now + (oe - videoTime);
      if (tOff <= now) continue;
      g.gain.setValueAtTime(0, Math.max(now, tOn));
      g.gain.setValueAtTime(base, tOff);
    }

    src.start(when, offset);
    activeSources.push(src);
  }
}

function stopComments() {
  for (const src of activeSources) {
    try { src.stop(); } catch (_) {}
  }
  activeSources = [];
}

/* ---------------- Step 2: 録音 ---------------- */

const recState = {
  active: false,
  pendingRec: false,
  micStream: null,
  recorder: null,
  chunks: [],
  segStart: 0,
  segId: 0,
  recog: null,
  recogGotResult: false,
  interimText: "",
  utterStart: null,
  timer: null,
};

function pickAudioMime() {
  const cands = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  for (const c of cands) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

$("recBtn").addEventListener("click", async () => {
  if (recState.active) {
    stopRecording();
  } else {
    await startRecording();
  }
});

async function startRecording() {
  if (!state.videoLoaded) return;
  recState.pendingRec = true;
  try {
    if (video.currentTime >= state.duration - 0.05) video.currentTime = 0;

    // iOS対策: タップの効力（user activation）が切れる前に、
    // 再生開始とAudioContextの作成/再開を先に行う。
    // getUserMediaを待ってからplay()すると、iOS Safariでは再生が却下される。
    const graphPromise = ensureAudioGraph();
    let playError = null;
    const playPromise = video.play().catch((e) => { playError = e; });
    await graphPromise;

    try {
      if (!recState.micStream || !recState.micStream.active) {
        recState.micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      }
    } catch (err) {
      video.pause();
      alert("マイクを使用できません。Safariの設定でマイクを許可してください。\n" + err.message);
      return;
    }

    await playPromise;
    // マイク許可ダイアログなどで一時停止された場合は再開する
    // （一度タップで再生済みのため、2回目以降のplay()は許可される）
    if (video.paused || playError) {
      playError = null;
      try { await video.play(); } catch (e) { playError = e; }
    }
    if (playError || video.paused) {
      alert("動画の再生を開始できませんでした。もう一度「録音スタート」を押してください。");
      return;
    }

    recState.segId = state.nextId++;
    recState.segStart = video.currentTime;
    recState.chunks = [];
    recState.recogGotResult = false;
    recState.interimText = "";

    const mime = pickAudioMime();
    recState.recorder = new MediaRecorder(recState.micStream, mime ? { mimeType: mime } : undefined);
    recState.recorder.ondataavailable = (e) => { if (e.data.size) recState.chunks.push(e.data); };
    recState.recorder.onstop = onRecorderStopped;

    recState.active = true;
    applyVolumes();
    stopComments(); // 録音中は既存コメントを鳴らさない
    recState.recorder.start();
    if ($("useRecog").checked) startRecognition();
  } finally {
    recState.pendingRec = false;
  }

  $("recBtn").textContent = "■ 録音ストップ";
  $("recBtn").classList.add("stop");
  $("recBadge").hidden = false;
  $("liveRecog").hidden = !$("useRecog").checked;
  $("liveRecog").textContent = "（話すとここに認識結果が出ます）";

  const t0 = Date.now();
  recState.timer = setInterval(() => {
    $("recTime").textContent = fmtTimeShort((Date.now() - t0) / 1000);
  }, 500);
}

function stopRecording() {
  if (!recState.active) return;
  recState.active = false;
  clearInterval(recState.timer);
  stopRecognition();
  if (recState.recorder && recState.recorder.state !== "inactive") {
    recState.recorder.stop();
  }
  if (!video.paused) video.pause();
  applyVolumes();

  $("recBtn").textContent = "● 録音スタート";
  $("recBtn").classList.remove("stop");
  $("recBadge").hidden = true;
  $("liveRecog").hidden = true;
  recState.interimText = "";
}

function stopRecordingIfActive() {
  if (recState.active) stopRecording();
}

function releaseMic() {
  stopRecordingIfActive();
  if (recState.micStream) {
    recState.micStream.getTracks().forEach((t) => t.stop());
    recState.micStream = null;
  }
}

async function onRecorderStopped() {
  const blob = new Blob(recState.chunks, { type: recState.recorder.mimeType || "audio/mp4" });
  recState.chunks = [];
  if (blob.size < 200) {
    warnRecogConflict("録音データが空でした。音声認識との競合の可能性があります。「音声認識」をオフにして録音をお試しください。");
    return;
  }
  let buffer;
  try {
    const arr = await blob.arrayBuffer();
    buffer = await audio.ctx.decodeAudioData(arr);
  } catch (err) {
    alert("録音音声の読み込みに失敗しました: " + err.message);
    return;
  }

  // 無音チェック（音声認識との競合検出）
  const ch = buffer.getChannelData(0);
  let sum = 0;
  const step = Math.max(1, Math.floor(ch.length / 10000));
  for (let i = 0; i < ch.length; i += step) sum += ch[i] * ch[i];
  const rms = Math.sqrt(sum / (ch.length / step));
  if (rms < 0.0005 && recState.recogGotResult) {
    warnRecogConflict("録音がほぼ無音でした。お使いのiOSでは音声認識とマイク録音が同時に使えない可能性があります。「音声認識」をオフにして録音し、字幕はStep 3で手入力してください。");
  }

  const seg = {
    id: recState.segId,
    start: recState.segStart,
    buffer,
    gain: normalizeGain(buffer),
    url: URL.createObjectURL(blob),
    createdAt: Date.now(),
  };

  // この録音で完全に上書きされた古い字幕を削除
  const e = segEnd(seg);
  state.subtitles = state.subtitles.filter((sub) => {
    if (sub.segId === seg.id) return true;
    const mid = (sub.start + sub.end) / 2;
    return !(mid >= seg.start && mid <= e);
  });

  state.segments.push(seg);
  state.segments.sort((a, b) => a.start - b.start);
  renderSegList();
}

// 話し声のRMSから、聞きやすい音量へ引き上げる自動補正ゲインを求める
function normalizeGain(buffer) {
  const d = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(d.length / 20000));
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += step) {
    const v = Math.abs(d[i]);
    if (v > 0.004) { sum += v * v; n++; }
  }
  if (!n) return 1;
  const rms = Math.sqrt(sum / n);
  return Math.min(8, Math.max(1, 0.12 / rms));
}

function warnRecogConflict(msg) {
  const box = $("recogWarn");
  box.textContent = "⚠️ " + msg;
  box.hidden = false;
}

/* --- 録音区間リスト --- */

function renderSegList() {
  const ul = $("segList");
  ul.innerHTML = "";
  if (state.segments.length === 0) {
    ul.innerHTML = '<li class="empty">まだ録音がありません</li>';
  } else {
    for (const seg of state.segments) {
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = "segRow";
      const info = document.createElement("span");
      info.className = "segInfo";
      info.textContent = `${fmtTime(seg.start)} 〜 ${fmtTime(segEnd(seg))}（${seg.buffer.duration.toFixed(1)}秒）`;
      const play = document.createElement("button");
      play.textContent = "▶";
      play.onclick = async () => {
        await ensureAudioGraph();
        video.currentTime = seg.start;
        video.play();
      };
      const del = document.createElement("button");
      del.textContent = "削除";
      del.className = "del";
      del.onclick = () => {
        if (!confirm("この録音と、その字幕を削除しますか？")) return;
        URL.revokeObjectURL(seg.url);
        state.segments = state.segments.filter((s) => s.id !== seg.id);
        state.subtitles = state.subtitles.filter((s) => s.segId !== seg.id);
        renderSegList();
      };
      row.append(info, play, del);
      li.appendChild(row);
      ul.appendChild(li);
    }
  }
  renderSegTimeline();
}

function renderSegTimeline() {
  const tl = $("segTimeline");
  tl.innerHTML = "";
  if (!state.duration) return;
  for (const seg of state.segments) {
    const div = document.createElement("div");
    div.className = "seg";
    div.style.left = (seg.start / state.duration) * 100 + "%";
    div.style.width = Math.max(0.5, ((segEnd(seg) - seg.start) / state.duration) * 100) + "%";
    tl.appendChild(div);
  }
}

/* ---------------- 音声認識（Web Speech API） ---------------- */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) {
  $("recogRow").innerHTML =
    '<div class="warnBox">このブラウザは音声認識（Web Speech API）に対応していません。字幕はStep 3で手入力できます。</div>';
}

function startRecognition() {
  if (!SR) return;
  const recog = new SR();
  recog.lang = "ja-JP";
  recog.continuous = true;
  recog.interimResults = true;

  recog.onresult = (e) => {
    recState.recogGotResult = true;
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      let text = res[0].transcript.trim();
      if (res.isFinal) {
        if (text) {
          text = applyKendoDict(text);
          const end = video.currentTime;
          const start = recState.utterStart != null
            ? recState.utterStart
            : Math.max(recState.segStart, end - Math.max(1.5, text.length * 0.18));
          state.subtitles.push({
            id: state.nextId++,
            start: Math.max(0, start),
            end: Math.max(start + 0.8, end),
            text,
            segId: recState.segId,
          });
          state.subtitles.sort((a, b) => a.start - b.start);
        }
        recState.utterStart = null;
      } else {
        if (recState.utterStart == null && text) {
          recState.utterStart = Math.max(recState.segStart, video.currentTime - 0.7);
        }
        interim += text;
      }
    }
    recState.interimText = interim;
    $("liveRecog").textContent = interim || "（認識待ち…）";
  };

  recog.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      warnRecogConflict("音声認識が許可されませんでした。字幕はStep 3で手入力できます。");
      $("useRecog").checked = false;
      recState.recog = null;
    }
  };

  // 無音などで勝手に止まったら録音中は再起動する
  recog.onend = () => {
    if (recState.active && $("useRecog").checked && recState.recog === recog) {
      setTimeout(() => {
        if (recState.active && recState.recog === recog) {
          try { recog.start(); } catch (_) {}
        }
      }, 150);
    }
  };

  recState.recog = recog;
  try { recog.start(); } catch (_) {}
}

function stopRecognition() {
  if (recState.recog) {
    const r = recState.recog;
    recState.recog = null;
    try { r.stop(); } catch (_) {}
  }
}

/* ---------------- Step 3: 字幕編集 ---------------- */

function renderSubList() {
  const ul = $("subList");
  ul.innerHTML = "";
  if (state.subtitles.length === 0) {
    ul.innerHTML = '<li class="empty">字幕がありません。下のボタンで追加できます。</li>';
    return;
  }
  state.subtitles.sort((a, b) => a.start - b.start);
  for (const sub of state.subtitles) {
    const li = document.createElement("li");
    const wrap = document.createElement("div");
    wrap.className = "subRow";

    const timeRow = document.createElement("div");
    timeRow.className = "timeRow";
    const inStart = document.createElement("input");
    inStart.type = "text";
    inStart.className = "timeIn";
    inStart.value = fmtTime(sub.start);
    inStart.onchange = () => {
      const v = parseTime(inStart.value);
      if (isFinite(v)) sub.start = Math.max(0, Math.min(v, state.duration));
      inStart.value = fmtTime(sub.start);
    };
    const tilde = document.createElement("span");
    tilde.className = "tilde";
    tilde.textContent = "〜";
    const inEnd = document.createElement("input");
    inEnd.type = "text";
    inEnd.className = "timeIn";
    inEnd.value = fmtTime(sub.end);
    inEnd.onchange = () => {
      const v = parseTime(inEnd.value);
      if (isFinite(v)) sub.end = Math.max(sub.start + 0.3, Math.min(v, state.duration));
      inEnd.value = fmtTime(sub.end);
    };
    const play = document.createElement("button");
    play.textContent = "▶";
    play.onclick = async () => {
      await ensureAudioGraph();
      video.currentTime = Math.max(0, sub.start - 0.5);
      video.play();
    };
    const del = document.createElement("button");
    del.textContent = "削除";
    del.className = "del";
    del.onclick = () => {
      state.subtitles = state.subtitles.filter((s) => s.id !== sub.id);
      renderSubList();
    };
    timeRow.append(inStart, tilde, inEnd, play, del);

    const ta = document.createElement("textarea");
    ta.value = sub.text;
    ta.oninput = () => { sub.text = ta.value; };
    let taOrig = sub.text;
    ta.addEventListener("focus", () => { taOrig = ta.value; });
    ta.addEventListener("change", () => {
      sub.text = ta.value; // 登録の選択にかかわらず修正は必ず反映
      offerDictRule(taOrig, ta.value, wrap);
      taOrig = ta.value;
    });

    wrap.append(timeRow, ta);
    li.appendChild(wrap);
    ul.appendChild(li);
  }
}

$("addSubBtn").addEventListener("click", () => {
  const t = video.currentTime;
  state.subtitles.push({
    id: state.nextId++,
    start: t,
    end: Math.min(t + 3, state.duration),
    text: "",
    segId: null,
  });
  renderSubList();
});

/* ---------------- 剣道用語の自動補正辞書 ---------------- */

// 既定の補正ルール（誤認識されやすい語 → 剣道用語）。順に適用される。
const KENDO_DICT_DEFAULT = [
  ["麺", "面"],
  ["メーン", "メン"],
  ["美味しい", "惜しい"],
  ["おいしい", "惜しい"],
  ["中断", "中段"],
  ["冗談", "上段"],
  ["斬新", "残心"],
  ["残身", "残心"],
  ["銅", "胴"],
  ["危険体", "気剣体"],
  ["危険隊", "気剣体"],
  ["打とつ", "打突"],
  ["ダトツ", "打突"],
  ["擦り足", "すり足"],
  ["スリ足", "すり足"],
  ["切返し", "切り返し"],
  ["出ごて", "出小手"],
  ["でごて", "出小手"],
  ["つば競り合い", "鍔迫り合い"],
  ["ツバゼリ合い", "鍔迫り合い"],
  ["つばぜりあい", "鍔迫り合い"],
  ["つばぜり合い", "鍔迫り合い"],
  ["恵子", "稽古"],
  ["そんきょ", "蹲踞"],
  ["ソンキョ", "蹲踞"],
  ["せいがん", "正眼"],
  ["きりかえし", "切り返し"],
  ["じげいこ", "地稽古"],
  ["自稽古", "地稽古"],
  ["かかり稽古", "掛かり稽古"],
  ["すぶり", "素振り"],
  ["ぬきどう", "抜き胴"],
  ["かえしどう", "返し胴"],
  ["ひきめん", "引き面"],
  ["あいめん", "相面"],
  ["でばな", "出ばな"],
  ["おうじわざ", "応じ技"],
  ["応じわざ", "応じ技"],
  ["しかけわざ", "仕掛け技"],
  ["仕掛けわざ", "仕掛け技"],
  ["コテ", "小手"],
  ["ツキ", "突き"],
  ["剣線", "剣先"],
  ["けんせん", "剣先"],
  ["一則一刀", "一足一刀"],
  ["いっそくいっとう", "一足一刀"],
  ["有効だとつ", "有効打突"],
];

function parseUserDict(text) {
  const rules = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.split(/→|⇒|,|，|\t/);
    if (m.length >= 2) {
      const from = m[0].trim(), to = m[1].trim();
      if (from && to && from !== to) rules.push([from, to]);
    }
  }
  return rules;
}

const toKatakana = (s) => s.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
const toHiragana = (s) => s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));

// ユーザー登録の単語（{w: 単語, r: 読みがな}）
let userWords = [];
try { userWords = JSON.parse(localStorage.getItem("kendoWordsUser") || "[]"); } catch (_) {}
function saveUserWords() {
  try { localStorage.setItem("kendoWordsUser", JSON.stringify(userWords)); } catch (_) {}
}

function getDict() {
  const rules = [];
  // 1) 登録単語: 読みがな（ひらがな・カタカナ両方）→ 単語
  for (const { w, r } of userWords) {
    if (!w || !r) continue;
    const hira = toHiragana(r);
    const kata = toKatakana(r);
    if (hira !== w) rules.push([hira, w]);
    if (kata !== w && kata !== hira) rules.push([kata, w]);
  }
  // 2) 直接補正ルール（誤→正）
  rules.push(...parseUserDict($("dictUser").value));
  // 3) 組み込みルール
  rules.push(...KENDO_DICT_DEFAULT);
  // 長いパターンから先に適用（部分一致による誤置換を防ぐ）
  rules.sort((a, b) => b[0].length - a[0].length);
  return rules;
}

function applyKendoDict(text) {
  for (const [from, to] of getDict()) text = text.split(from).join(to);
  return text;
}

function renderDictList() {
  const ul = $("dictList");
  ul.innerHTML = "";
  if (userWords.length === 0) {
    ul.innerHTML = '<li class="empty">登録された単語はまだありません</li>';
    return;
  }
  userWords.forEach((entry, idx) => {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "segRow";
    const info = document.createElement("span");
    info.className = "segInfo";
    info.textContent = `${entry.w}（${entry.r}）`;
    const edit = document.createElement("button");
    edit.textContent = "編集";
    edit.onclick = () => {
      // 入力欄に戻して編集→「＋追加」で再登録
      $("dictWord").value = entry.w;
      $("dictReading").value = entry.r;
      userWords.splice(idx, 1);
      saveUserWords();
      renderDictList();
      $("dictWord").focus();
    };
    const del = document.createElement("button");
    del.textContent = "削除";
    del.className = "del";
    del.onclick = () => {
      userWords.splice(idx, 1);
      saveUserWords();
      renderDictList();
    };
    row.append(info, edit, del);
    li.appendChild(row);
    ul.appendChild(li);
  });
}

$("dictAddBtn").addEventListener("click", () => {
  const w = $("dictWord").value.trim();
  const r = $("dictReading").value.trim();
  if (!w || !r) {
    alert("単語と読みがなの両方を入力してください。");
    return;
  }
  if (!/^[ぁ-ゖァ-ヶー・\s]+$/.test(r)) {
    alert("読みがなは、ひらがな・カタカナで入力してください。");
    return;
  }
  const i = userWords.findIndex((e) => e.w === w);
  if (i >= 0) userWords[i] = { w, r };
  else userWords.push({ w, r });
  saveUserWords();
  renderDictList();
  $("dictWord").value = "";
  $("dictReading").value = "";
});

renderDictList();

// 組み込みルールの一覧表示
for (const [from, to] of KENDO_DICT_DEFAULT) {
  const li = document.createElement("li");
  li.textContent = `${from} → ${to}`;
  $("dictBuiltinList").appendChild(li);
}

// 字幕の手動修正から補正ルールを抽出する
// 前後の共通部分を除いた「変わった箇所」を誤→正のペアとして取り出す
function extractCorrection(before, after) {
  if (before === after) return null;
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (
    s < before.length - p && s < after.length - p &&
    before[before.length - 1 - s] === after[after.length - 1 - s]
  ) s++;
  const from = before.slice(p, before.length - s).trim();
  const to = after.slice(p, after.length - s).trim();
  if (!from || !to || from === to) return null;
  if (from.length > 9 || to.length > 9) return null; // 10文字以上の変更は文の書き換えとみなす
  if (from.includes("\n") || to.includes("\n")) return null;
  return [from, to];
}

// 字幕修正の直下に「辞書に登録しますか？」のバーを出す。
// どちらを選んでも修正テキストには触れず、画面もスクロールしない。
function offerDictRule(before, after, host) {
  const pair = extractCorrection(before, after);
  if (!pair) return;
  const [from, to] = pair;
  if (applyKendoDict(from) === to) return; // すでに辞書で直る修正は聞かない
  const old = host.querySelector(".dictOffer");
  if (old) old.remove(); // 続けて直した場合は最新の提案だけ表示

  const box = document.createElement("div");
  box.className = "dictOffer";
  const msg = document.createElement("span");
  msg.textContent = `「${from}」→「${to}」を辞書に登録しますか？`;
  const yes = document.createElement("button");
  yes.textContent = "登録する";
  yes.onclick = () => {
    const cur = $("dictUser").value.trim();
    $("dictUser").value = (cur ? cur + "\n" : "") + `${from}→${to}`;
    try { localStorage.setItem("kendoDictUser", $("dictUser").value); } catch (_) {}
    box.remove();
  };
  const no = document.createElement("button");
  no.textContent = "登録しない";
  no.className = "no";
  no.onclick = () => box.remove();
  box.append(msg, yes, no);
  host.appendChild(box);
}

// 直接補正ルールも端末に保存
try {
  $("dictUser").value = localStorage.getItem("kendoDictUser") || "";
} catch (_) {}
$("dictUser").addEventListener("input", () => {
  try { localStorage.setItem("kendoDictUser", $("dictUser").value); } catch (_) {}
});

$("dictApplyBtn").addEventListener("click", () => {
  let changed = 0;
  for (const sub of state.subtitles) {
    const fixed = applyKendoDict(sub.text);
    if (fixed !== sub.text) { sub.text = fixed; changed++; }
  }
  renderSubList();
  alert(changed ? `${changed}件の字幕を補正しました。` : "補正対象はありませんでした。");
});

/* ---------------- Step 4: 書き出し ---------------- */

$("origVol").addEventListener("input", () => {
  state.volumes.original = Number($("origVol").value) / 100;
  $("origVolLabel").textContent = $("origVol").value + "%";
  applyVolumes();
});
$("commentVol").addEventListener("input", () => {
  state.volumes.comment = Number($("commentVol").value) / 100;
  $("commentVolLabel").textContent = $("commentVol").value + "%";
  applyVolumes();
});

let exporting = false;
let exportRec = null;
let exportDrawTimer = null;
let wakeLock = null;

function pickVideoMime() {
  const cands = [
    'video/mp4;codecs="avc1.640028,mp4a.40.2"',
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    "video/mp4",
    'video/webm;codecs="h264,opus"',
    'video/webm;codecs="vp9,opus"',
    "video/webm",
  ];
  for (const c of cands) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

$("exportBtn").addEventListener("click", startExport);
$("cancelExportBtn").addEventListener("click", () => stopExport(true));

async function startExport() {
  if (exporting || !state.videoLoaded) return;
  await ensureAudioGraph();
  stopComments();
  video.pause();

  const canvas = $("exportCanvas");
  let w = video.videoWidth, h = video.videoHeight;
  const cap = $("exportRes").value === "720" ? 720 : 1080;
  const shortSide = Math.min(w, h);
  if (shortSide > cap) {
    const scale = cap / shortSide;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  w -= w % 2; h -= h % 2;
  canvas.width = w;
  canvas.height = h;
  const cctx = canvas.getContext("2d");

  const mime = pickVideoMime();
  if (!mime) {
    alert("このブラウザは動画の書き出し（MediaRecorder）に対応していません。");
    return;
  }

  const canvasStream = canvas.captureStream(30);
  const mixed = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...audio.streamDest.stream.getAudioTracks(),
  ]);
  const chunks = [];
  exportRec = new MediaRecorder(mixed, {
    mimeType: mime,
    videoBitsPerSecond: cap === 720 ? 5_000_000 : 8_000_000,
  });
  exportRec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  exportRec.onstop = () => finishExport(chunks, mime, canvasStream);

  // 画面スリープ防止
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) {}

  exporting = true;
  $("exportBtn").disabled = true;
  $("exportProgress").hidden = false;
  $("exportResult").hidden = true;
  subOverlay.textContent = "";

  if (video.currentTime > 0.01) {
    video.currentTime = 0;
    await new Promise((r) => {
      const h2 = () => { video.removeEventListener("seeked", h2); r(); };
      video.addEventListener("seeked", h2);
      setTimeout(r, 2000);
    });
  }

  exportRec.start(1000);
  try {
    await video.play();
  } catch (err) {
    alert("再生を開始できませんでした: " + err.message);
    stopExport(true);
    return;
  }
  scheduleCommentsFrom(0);

  const fontSize = Math.round(h * Number($("subSize").value));
  const drawFrame = () => {
    if (!exporting) return;
    cctx.drawImage(video, 0, 0, w, h);
    drawSubtitle(cctx, w, h, fontSize, video.currentTime);
    const pct = Math.min(100, (video.currentTime / state.duration) * 100);
    $("progressBar").style.width = pct + "%";
    $("progressText").textContent = `書き出し中… ${pct.toFixed(0)}%（${fmtTimeShort(video.currentTime)} / ${fmtTimeShort(state.duration)}）`;
  };
  // rAFが間引かれる環境でも確実に描画されるよう、rAFとタイマーを併用
  const rafLoop = () => {
    if (!exporting) return;
    drawFrame();
    requestAnimationFrame(rafLoop);
  };
  requestAnimationFrame(rafLoop);
  exportDrawTimer = setInterval(drawFrame, 33);

  const onEnded = () => {
    video.removeEventListener("ended", onEnded);
    if (exporting) setTimeout(() => stopExport(false), 300);
  };
  video.addEventListener("ended", onEnded);
}

function drawSubtitle(cctx, w, h, fontSize, t) {
  const sub = state.subtitles.find((s) => t >= s.start && t <= s.end);
  if (!sub || !sub.text) return;
  cctx.font = `700 ${fontSize}px -apple-system, "Hiragino Sans", sans-serif`;
  cctx.textAlign = "center";
  cctx.textBaseline = "bottom";
  cctx.lineJoin = "round";

  const maxWidth = w * 0.92;
  const lines = [];
  let cur = "";
  for (const ch of sub.text) {
    if (ch === "\n") { lines.push(cur); cur = ""; continue; }
    if (cctx.measureText(cur + ch).width > maxWidth && cur) {
      lines.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) lines.push(cur);
  const shown = lines.slice(0, 3);

  const lineH = fontSize * 1.3;
  let y = h * 0.95 - (shown.length - 1) * lineH;
  for (const line of shown) {
    cctx.lineWidth = fontSize * 0.22;
    cctx.strokeStyle = "rgba(0,0,0,0.9)";
    cctx.strokeText(line, w / 2, y);
    cctx.fillStyle = "#ffffff";
    cctx.fillText(line, w / 2, y);
    y += lineH;
  }
}

function stopExport(cancelled) {
  if (!exporting) return;
  exporting = false;
  clearInterval(exportDrawTimer);
  exportDrawTimer = null;
  video.pause();
  stopComments();
  if (wakeLock) { try { wakeLock.release(); } catch (_) {} wakeLock = null; }
  if (cancelled) {
    if (exportRec && exportRec.state !== "inactive") {
      exportRec.onstop = null;
      exportRec.stop();
    }
    exportRec = null;
    $("exportProgress").hidden = true;
    $("exportBtn").disabled = false;
  } else {
    if (exportRec && exportRec.state !== "inactive") exportRec.stop();
  }
}

function finishExport(chunks, mime, canvasStream) {
  canvasStream.getTracks().forEach((t) => t.stop());
  $("exportProgress").hidden = true;
  $("exportBtn").disabled = false;

  const isMp4 = mime.startsWith("video/mp4");
  const ext = isMp4 ? "mp4" : "webm";
  const blob = new Blob(chunks, { type: isMp4 ? "video/mp4" : "video/webm" });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const name = `kendo_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}.${ext}`;
  const file = new File([blob], name, { type: blob.type });

  const box = $("exportResult");
  box.innerHTML = "";
  const info = document.createElement("p");
  info.innerHTML = `✅ 書き出し完了（${(blob.size / 1048576).toFixed(1)}MB / ${ext.toUpperCase()}形式)`;
  box.appendChild(info);

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    const shareBtn = document.createElement("button");
    shareBtn.className = "bigBtn primary";
    shareBtn.textContent = "📱 写真アプリに保存（共有シート）";
    shareBtn.onclick = async () => {
      try {
        await navigator.share({ files: [file] });
      } catch (_) {}
    };
    box.appendChild(shareBtn);
  }

  const a = document.createElement("a");
  a.className = "dlLink";
  a.href = url;
  a.download = name;
  a.textContent = "⬇ ファイルをダウンロード";
  box.appendChild(a);

  if (!isMp4) {
    const warn = document.createElement("p");
    warn.className = "warnBox";
    warn.textContent = "⚠️ このブラウザではWebM形式で書き出されました。iPhoneの写真アプリに保存するには、iPhoneのSafariで書き出してください（MP4になります）。";
    box.appendChild(warn);
  }
  box.hidden = false;
  exportRec = null;
}

/* ---------------- ページ離脱ガード ---------------- */

window.addEventListener("beforeunload", (e) => {
  if (state.segments.length > 0 || exporting) {
    e.preventDefault();
    e.returnValue = "";
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && recState.active) stopRecording();
});
