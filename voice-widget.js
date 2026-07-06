/*
 * ALEX_AGENT VOICE LINK — custom voice-agent widget for alexrussell.io.
 *
 * A single self-contained custom element (<alex-voice-widget>, Shadow DOM)
 * that replaces the old third-party embed. The pipeline:
 *
 *   mic → STT (Deepgram Nova-3 WS stream when /api/stt-token mints tokens;
 *       Web Speech API as automatic fallback) → POST /api/chat (SSE stream)
 *       → sentence splitter → POST /api/tts (raw PCM s16le mono 24 kHz)
 *       → AudioWorklet ring-buffer player → speakers
 *
 * Engineering notes:
 *   - ONE lazily-created AudioContext (target 24 kHz), unlocked inside the
 *     start-call gesture (resume + 1-frame silent buffer for iOS).
 *   - Streaming playback via an inline AudioWorklet (Blob URL) with a
 *     Float32 ring buffer; barge-in flush = 30 ms gain ramp + {type:'clear'}.
 *   - Barge-in while the agent speaks requires interim words, sustained mic
 *     RMS, and an echo guard; anything in flight is tagged with an
 *     utteranceId and stale chunks are dropped everywhere.
 *   - The assistant message kept in history after a barge-in is truncated
 *     to the sentences that actually reached the speaker (frame-counted).
 *   - Sentence-pipelined TTS with an eager first flush, so first audio
 *     lands while the model is still generating.
 *   - No Web Speech support (Firefox) or mic denied → text mode: same
 *     widget, typed input, replies still spoken.
 *   - States idle|connecting|listening|thinking|speaking drive the CSS
 *     (data-state), the canvas orb, and a window 'alexvoice:state' event.
 *   - prefers-reduced-motion → static orb + gentle CSS opacity pulse.
 *
 * Debug surface: window.__alexvoiceDebug (plain counters; harmless).
 */
(() => {
'use strict';

// ---------- CONFIG ----------
const CHAT_URL = '/api/chat';
const TTS_URL = '/api/tts';
const TARGET_RATE = 24000;      // TTS PCM sample rate (server contract)
const HISTORY_MAX = 14;         // messages kept client-side
const MSG_MAX = 1200;           // chars per message (server contract)
const TTS_MAX = 800;            // chars per TTS request (server contract)
const GREETING = "Hey, I'm Alexander's AI. Ask me anything about his work.";
// Spoken turns never show the raw STT words (mishears would read as
// glitches); the transcript shows placeholders while the LLM gets the text.
const VOICE_MSG_LABEL = 'Voice message';
const VOICE_INTERIM_LABEL = 'Listening…';
const CALL_MAX_MS = 120_000;    // voice calls end themselves after two minutes
const CALL_WARN_MS = 15_000;    // countdown turns amber for the final stretch
const CALL_RED_MS = 10_000;     // countdown turns red and pulses; stateline warns once
const ENDPOINT_MS = 900;        // Web Speech: stable interim + this much silence → commit
const DG_ENDPOINT_MS = 300;     // Deepgram endpointing: silence before speech_final ends a turn
const DG_FALLBACK_MS = 1800;    // tick safety net when Deepgram never sends speech_final
const STALE_FINAL_MS = 3000;    // engine finals matching a tick()-committed utterance are dupes this long
const BARGE_MIN_WORDS = 2;      // interim words that interrupt the agent
const BARGE_RMS = 0.08;         // sustained mic level that interrupts
const BARGE_SUSTAIN_MS = 200;   // RMS must stay hot across ticks
const TICK_MS = 120;            // housekeeping cadence (endpointing, barge RMS)

// Deepgram streaming STT (primary engine when the server mints tokens).
const STT_TOKEN_URL = '/api/stt-token';
const DG_LISTEN_URL = 'wss://api.deepgram.com/v1/listen'
    + '?model=nova-3&encoding=linear16&sample_rate=16000&channels=1'
    + '&interim_results=true&endpointing=' + DG_ENDPOINT_MS
    + '&smart_format=true&punctuate=true';
const DG_RATE = 16000;          // linear16 rate sent to Deepgram
const DG_BATCH_MS = 100;        // mic audio batched into ~100 ms frames
const DG_KEEPALIVE_MS = 8000;   // silence gap before a KeepAlive keeps the WS warm

const REDUCED = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };
const SR_CTOR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

// ---------- DEBUG SURFACE ----------
const dbg = {
    state: 'idle', mode: null, opens: 0, calls: 0,
    chatRequests: 0, chatDeltas: 0, chatChars: 0,
    ttsRequests: 0, ttsChunks: 0, ttsBytes: 0,
    framesWritten: 0, framesPlayed: 0,
    bufferedSeconds: 0, overflows: 0,
    sentencesQueued: 0, sentencesSpoken: 0,
    commits: 0, interrupts: 0, recognitionRestarts: 0,
    rateLimited: 0, errors: 0, utteranceId: 0,
    sttEngine: null, dgConnects: 0, dgReconnects: 0,
    dgFrames: 0, dgFinals: 0, dgInterims: 0,
};
window.__alexvoiceDebug = dbg;

// ---------- AUDIOWORKLET PLAYER (inlined, loaded via Blob URL) ----------
// Float32 ring buffer fed from the main thread; underrun plays silence.
// {type:'clear'} resets both pointers → sample-accurate barge-in flush.
const WORKLET_SOURCE = [
    'class AlexVoicePlayer extends AudioWorkletProcessor {',
    '  constructor() {',
    '    super();',
    '    this.cap = Math.max(1, Math.floor(sampleRate * 30));',
    '    this.buf = new Float32Array(this.cap);',
    '    this.r = 0; this.w = 0;',
    '    this.overflows = 0;',
    '    this.epoch = 0;',
    '    this.framesSinceStatus = 0;',
    '    this.statusFrames = Math.max(128, Math.floor(sampleRate / 4));',
    '    this.wasPlaying = false;',
    '    this.forceStatus = true;',
    '    this.port.onmessage = (e) => {',
    '      const d = e.data || {};',
    '      if (typeof d.epoch === "number") this.epoch = d.epoch;',
    '      if (d.type === "clear") { this.r = 0; this.w = 0; this.forceStatus = true; return; }',
    '      if (d.type === "pcm") {',
    '        const f = new Float32Array(d.buf);',
    '        const used = this.w - this.r;',
    '        const room = Math.max(0, this.cap - used);',
    '        const n = Math.min(room, f.length);',
    '        for (let i = 0; i < n; i++) {',
    '          this.buf[this.w % this.cap] = f[i];',
    '          this.w++;',
    '        }',
    '        if (n < f.length) { this.overflows += f.length - n; this.forceStatus = true; }',
    '      }',
    '    };',
    '  }',
    '  postStatus(playing) {',
    '    this.port.postMessage({ epoch: this.epoch, playing: playing, played: this.r, written: this.w, overflows: this.overflows });',
    '    this.wasPlaying = playing;',
    '    this.framesSinceStatus = 0;',
    '    this.forceStatus = false;',
    '  }',
    '  process(inputs, outputs) {',
    '    const out = outputs[0][0];',
    '    if (!out) return true;',
    '    for (let i = 0; i < out.length; i++) {',
    '      if (this.r < this.w) { out[i] = this.buf[this.r % this.cap]; this.r++; }',
    '      else { out[i] = 0; }',
    '    }',
    '    const playing = this.r < this.w;',
    '    this.framesSinceStatus += out.length;',
    '    if (this.forceStatus || playing !== this.wasPlaying || (playing && this.framesSinceStatus >= this.statusFrames)) {',
    '      this.postStatus(playing);',
    '    }',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("alex-voice-player", AlexVoicePlayer);',
].join('\n');

// ---------- AUDIOWORKLET CAPTURE (inlined, loaded via Blob URL) ----------
// Mic tap for Deepgram streaming STT: each 128-frame Float32 render quantum
// is converted to Int16 and posted to the main thread as a transferable.
// It writes no output — it hangs off a zero-gain sink purely so the render
// graph keeps pulling it.
const CAPTURE_WORKLET_SOURCE = [
    'class AlexVoiceCapture extends AudioWorkletProcessor {',
    '  process(inputs) {',
    '    const ch = inputs[0] && inputs[0][0];',
    '    if (!ch || !ch.length) return true;',
    '    const out = new Int16Array(ch.length);',
    '    for (let i = 0; i < ch.length; i++) {',
    '      const v = Math.max(-1, Math.min(1, ch[i]));',
    '      out[i] = v < 0 ? v * 32768 : v * 32767;',
    '    }',
    '    this.port.postMessage({ type: "pcm", buf: out.buffer }, [out.buffer]);',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("alex-voice-capture", AlexVoiceCapture);',
].join('\n');

// ---------- SMALL HELPERS ----------
function wordCount(s) {
    return s.trim().split(/\s+/).filter(Boolean).length;
}

function normalizedWords(s) {
    return s
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9\s]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

// Strip markdown markers / emoji so the TTS never reads "asterisk asterisk".
function cleanForTTS(t) {
    return t
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')          // [label](url) → label
        .replace(/[*_#`~]/g, '')
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Common abbreviations that end with "." but are not sentence boundaries.
const ABBREV_TAIL = /(?:^|\s)(?:dr|mr|mrs|ms|st|vs|etc|approx|e\.g|i\.e)\.$/i;

const STATE_LINES = {
    idle: '> STANDBY',
    connecting: '> CONNECTING…',
    listening: '> LISTENING…',
    thinking: '> THINKING…',
    speaking: '> SPEAKING, tap to interrupt',
};

// ---------- SHADOW DOM TEMPLATE ----------
const WIDGET_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'JetBrains Mono', 'Courier New', monospace; }
    button { cursor: pointer; }

    /* --- COLLAPSED LAUNCHER --- */
    .launcher {
        position: fixed;
        right: 20px;
        bottom: calc(20px + env(safe-area-inset-bottom, 0px));
        z-index: 9999;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 16px 10px 12px;
        border: 1px solid #0a0a0a;
        border-radius: 9999px;
        background: rgba(6, 12, 20, 0.85);
        color: #00ff41;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.14em;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        transition: transform 0.25s ease, box-shadow 0.25s ease;
    }
    .launcher:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.7);
    }
    .launcher[hidden] { display: none; }
    .launcher .mini { width: 24px; height: 24px; display: block; }
    .launcher .dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: #00ff41;
        box-shadow: 0 0 8px #00ff41;
        animation: avw-pulse 2s infinite;
    }

    /* --- EXPANDED CARD --- */
    .card {
        position: fixed;
        right: 20px;
        bottom: calc(20px + env(safe-area-inset-bottom, 0px));
        z-index: 9999;
        width: 360px;
        height: 520px;
        max-height: calc(100vh - 40px);
        max-width: calc(100vw - 24px);
        display: flex;
        flex-direction: column;
        border: 1px solid rgba(0, 255, 0, 0.25);
        border-radius: 16px;
        background: rgba(8, 13, 22, 0.92);
        color: #ccc;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.75), 0 0 25px rgba(0, 255, 0, 0.08);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        overflow: hidden;
    }
    .card[hidden] { display: none; }
    /* Start screen (idle = no active call): the previous session's chat
       stays out of the way and the card shrinks to orb + start panel. */
    .card[data-state="idle"] { height: auto; }
    .card[data-state="idle"] .transcript { display: none; }
    .card::after {  /* faint scanlines, matching the site's terminal vibe */
        content: '';
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: linear-gradient(transparent 50%, rgba(0, 255, 0, 0.02) 50%);
        background-size: 100% 4px;
    }

    /* --- HEADER --- */
    .head {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(0, 0, 0, 0.35);
        flex-shrink: 0;
    }
    .beacon {
        width: 10px; height: 10px; border-radius: 50%;
        background: #00ff41;
        box-shadow: 0 0 10px #00ff41;
        animation: avw-pulse 2s infinite;
        flex-shrink: 0;
    }
    .title { color: #fff; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; flex: 1; }
    .timer {
        color: #00e05a; font-size: 11px; font-weight: 700; letter-spacing: 0.1em;
        padding: 2px 7px; border: 1px solid rgba(0, 224, 90, 0.35); border-radius: 999px;
        font-variant-numeric: tabular-nums;
    }
    .timer.low { color: #ffb020; border-color: rgba(255, 176, 32, 0.45); }
    .timer.red {
        color: #ff5a5a;
        border-color: rgba(255, 90, 90, 0.55);
        animation: avw-pulse 1.2s infinite;
    }
    .title .dim { color: #5a6a5f; font-weight: 400; }
    .btn-min {
        border: 1px solid rgba(255, 255, 255, 0.15);
        background: rgba(0, 0, 0, 0.4);
        color: #9aa;
        width: 28px; height: 24px;
        border-radius: 5px;
        font-size: 11px;
        line-height: 1;
        transition: all 0.2s;
    }
    .btn-min:hover { border-color: #00ff41; color: #00ff41; }

    /* --- STAGE (orb + state line) --- */
    .stage {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 10px 14px 4px;
        flex-shrink: 0;
    }
    .orb { width: 160px; height: 160px; display: block; }
    .card[data-state="speaking"] .stage { cursor: pointer; }
    .stateline {
        margin-top: 2px;
        font-size: 11px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #5a6a5f;
        min-height: 16px;
        text-align: center;
    }
    .card[data-state="connecting"] .stateline { color: #8a9; }
    .card[data-state="listening"] .stateline { color: #4aa8ff; }
    .card[data-state="thinking"]  .stateline { color: #9effb0; }
    .card[data-state="speaking"]  .stateline { color: #00ff41; }
    .stateline.notice { color: #ffcf5e !important; }

    /* --- START / CONSENT PANEL --- */
    .start-panel { padding: 8px 20px 12px; flex-shrink: 0; }
    .start-panel[hidden] { display: none; }
    .consent {
        font-size: 10.5px;
        color: #6f8577;
        line-height: 1.6;
        text-align: center;
        margin-bottom: 12px;
    }
    .btn-start, .btn-text {
        display: block;
        width: 100%;
        padding: 12px 0;
        margin-bottom: 8px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        border-radius: 3px;
        transition: all 0.2s;
    }
    .btn-start {
        border: 1px solid #00ff41;
        background: rgba(0, 80, 0, 0.12);
        color: #00ff41;
    }
    .btn-start:hover {
        background: #00ff41;
        color: #000;
        box-shadow: 0 0 20px rgba(0, 255, 0, 0.6);
    }
    .btn-start[hidden] { display: none; }
    .btn-text {
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(0, 0, 0, 0.35);
        color: #9ab;
    }
    .btn-text:hover { border-color: #00ff41; color: #00ff41; }

    /* --- TRANSCRIPT --- */
    .transcript {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 8px 14px;
        font-size: 12px;
        line-height: 1.55;
        scrollbar-width: thin;
        scrollbar-color: #222 #000;
    }
    .transcript::-webkit-scrollbar { width: 5px; }
    .transcript::-webkit-scrollbar-track { background: transparent; }
    .transcript::-webkit-scrollbar-thumb { background: #223; border-radius: 3px; }
    .m {
        max-width: 86%;
        width: fit-content;
        margin: 6px 0;
        padding: 6px 10px;
        border-radius: 8px;
        white-space: pre-wrap;
        word-break: break-word;
    }
    .m.user {
        margin-left: auto;
        background: rgba(0, 255, 0, 0.07);
        border: 1px solid rgba(0, 255, 0, 0.25);
        color: #e6ffe9;
    }
    .m.agent {
        margin-right: auto;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #c9d2cc;
    }
    .m.agent.cut { border-style: dashed; opacity: 0.75; }
    .m.user.voice { opacity: 0.7; font-style: italic; }
    .m.interim { opacity: 0.45; font-style: italic; }
    .m.sys {
        max-width: 100%;
        margin: 8px auto;
        padding: 2px 0;
        background: none;
        border: none;
        color: #5b6a60;
        font-size: 10px;
        text-align: center;
    }

    /* --- INPUT ROW --- */
    .inputrow {
        display: flex;
        gap: 6px;
        padding: 10px 12px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(0, 0, 0, 0.3);
        flex-shrink: 0;
    }
    .inputrow[hidden] { display: none; }
    .field {
        flex: 1;
        min-width: 0;
        height: 34px;
        padding: 0 10px;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 6px;
        background: rgba(0, 0, 0, 0.45);
        color: #d9ffe0;
        font-size: 12px;
        outline: none;
    }
    .field::placeholder { color: #4b5a52; }
    .field:focus { border-color: rgba(0, 255, 0, 0.5); box-shadow: 0 0 8px rgba(0, 255, 0, 0.15); }
    .ctl {
        height: 34px;
        padding: 0 10px;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 6px;
        background: rgba(0, 0, 0, 0.4);
        color: #8a9a90;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        transition: all 0.2s;
        flex-shrink: 0;
    }
    .ctl:hover { border-color: #00ff41; color: #00ff41; }
    .ctl[hidden] { display: none; }
    .btn-mic[aria-pressed="true"] { border-style: dashed; color: #ffcf5e; border-color: rgba(255, 207, 94, 0.5); }
    .btn-end { border-color: rgba(255, 90, 90, 0.35); color: #e08a8a; }
    .btn-end:hover { border-color: #ff5a5a; color: #ff7a7a; }

    /* --- FOOTER --- */
    .foot {
        padding: 5px 0 7px;
        font-size: 9.5px;
        letter-spacing: 0.08em;
        text-align: center;
        color: #48564d;
        border-top: 1px solid rgba(255, 255, 255, 0.05);
        flex-shrink: 0;
    }

    @keyframes avw-pulse {
        0%   { opacity: 1;   transform: scale(1);   }
        50%  { opacity: 0.4; transform: scale(0.8); }
        100% { opacity: 1;   transform: scale(1);   }
    }

    /* --- MOBILE: bottom sheet --- */
    @media (max-width: 480px) {
        .launcher {
            right: 12px;
            bottom: calc(14px + env(safe-area-inset-bottom, 0px));
            padding: 8px 13px 8px 10px;
            font-size: 11px;
        }
        .card {
            left: 0;
            right: 0;
            bottom: 0;
            width: 100%;
            max-width: 100%;
            height: 70vh;
            max-height: 85vh;
            border-radius: 16px 16px 0 0;
            border-left: none;
            border-right: none;
            border-bottom: none;
            padding-bottom: env(safe-area-inset-bottom, 0px);
        }
        .orb { width: 130px; height: 130px; }
    }

    /* --- REDUCED MOTION: no wobble, gentle opacity pulse instead --- */
    @media (prefers-reduced-motion: reduce) {
        .beacon, .launcher .dot { animation: none; }
        .launcher, .btn-start, .btn-min, .ctl { transition: none; }
        .card:not([data-state="idle"]) .orb { animation: avw-breathe 4s ease-in-out infinite; }
    }
    @keyframes avw-breathe {
        0%, 100% { opacity: 0.7; }
        50%      { opacity: 1;   }
    }
`;

const WIDGET_HTML = `
    <button class="launcher" type="button" aria-label="Ask Alex AI, open the voice assistant">
        <canvas class="mini" width="24" height="24" aria-hidden="true"></canvas>
        <span class="llabel">ASK ALEX_AI</span>
        <span class="dot" aria-hidden="true"></span>
    </button>
    <section class="card" role="dialog" aria-label="ALEX_AGENT voice assistant" data-state="idle" hidden>
        <header class="head">
            <span class="beacon" aria-hidden="true"></span>
            <span class="title">ALEX_AGENT <span class="dim">// voice link</span></span>
            <span class="timer" hidden aria-label="Call time remaining">2:00</span>
            <button class="btn-min" type="button" aria-label="Close voice assistant">▁</button>
        </header>
        <div class="stage">
            <canvas class="orb" aria-hidden="true"></canvas>
            <div class="stateline">&gt; STANDBY</div>
        </div>
        <div class="start-panel">
            <p class="consent">Mic activates only during a call.<br>Voice calls are capped at two minutes.</p>
            <button class="btn-start" type="button">START VOICE LINK</button>
            <button class="btn-text" type="button">TYPE INSTEAD</button>
        </div>
        <div class="transcript" role="log" aria-live="polite"></div>
        <form class="inputrow" hidden>
            <input class="field" type="text" autocomplete="off" maxlength="${MSG_MAX}"
                   placeholder="type a message…" aria-label="Message to Alex AI">
            <button class="ctl btn-send" type="submit" aria-label="Send message">&gt;&gt;</button>
            <button class="ctl btn-mic" type="button" aria-label="Mute microphone" aria-pressed="false">MIC</button>
            <button class="ctl btn-end" type="button" aria-label="End call">END</button>
        </form>
        <footer class="foot">custom voice agent · designed &amp; built by Alexander</footer>
    </section>
`;

// ---------- THE WIDGET ----------
class AlexVoiceWidget extends HTMLElement {
    constructor() {
        super();

        // Conversation state
        this.state = 'idle';
        this.callActive = false;
        this.voiceMode = false;
        this.micMuted = false;
        this.history = [];          // {role, content}, last HISTORY_MAX kept
        this.turn = null;           // active agent turn (chat + tts + playback)
        this.utteranceId = 0;       // bumped per turn / interrupt; tags everything

        // Audio graph (lazy)
        this.ctx = null;
        this.playerNode = null;
        this.outAnalyser = null;
        this.gain = null;
        this.workletReady = false;
        this.resampleRatio = 1;
        this.framesWritten = 0;     // mirrors the worklet write pointer (per turn)
        this.framesPlayed = 0;      // latest read pointer reported by the worklet
        this.framesScheduled = 0;   // posted + pending frames in this turn
        this.playerPlaying = false;
        this.pendingPcm = [];
        this.pendingPcmFrames = 0;
        this.workletOverflows = 0;
        this.playbackEpoch = 0;

        // Mic
        this.micStream = null;
        this.micSource = null;
        this.micAnalyser = null;
        this.micBuf = null;
        this.outBuf = null;

        // STT
        this.rec = null;
        this.recRunning = false;
        this.recRestartTimer = 0;
        this.interimText = '';
        this.interimAt = 0;
        this.interimEl = null;
        this.bargeHits = 0;

        // STT engine selection — Deepgram streaming when the server mints
        // tokens, Web Speech otherwise; the one flag switches every path.
        this.sttEngine = null;          // 'deepgram' | 'webspeech' | null
        this.dgWs = null;
        this.dgCaptureNode = null;
        this.dgMuteGain = null;
        this.dgBatch = [];              // Int16 chunks (ctx rate) awaiting downsample
        this.dgBatchSamples = 0;
        this.dgFinalParts = [];         // is_final segments awaiting speech_final
        this.staleFinalText = '';       // tick() committed ahead of the engine:
        this.staleFinalUntil = 0;       // matching finals are dupes until then
        this.dgLastAudioAt = 0;
        this.dgKeepAliveTimer = 0;
        this.dgReconnected = false;     // one mid-call reconnect, then fallback
        this.sttGen = 0;                // bumped on every start/teardown: async
                                        // work from a previous call generation
                                        // must never touch the current one
        this.captureWorkletReady = false;

        // Fetch controllers + TTS queue
        this.chatCtrl = null;
        this.ttsCtrl = null;
        this.ttsQueue = [];
        this.ttsBusy = false;

        // Rendering
        this.rafId = 0;
        this.lastTs = 0;
        this.miniAcc = 0;
        this.level = 0;
        this.rings = [];
        this.lastRingAt = 0;
        this.noticeText = '';
        this.noticeUntil = 0;
        this.wakeLock = null;           // screen wake lock held during a call
        this.wakeLockPending = false;   // a request() is in flight
        this.tickTimer = 0;

        const root = this.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = WIDGET_CSS;
        root.appendChild(style);
        const wrap = document.createElement('div');
        wrap.innerHTML = WIDGET_HTML;
        while (wrap.firstChild) root.appendChild(wrap.firstChild);

        this.launcher = root.querySelector('.launcher');
        this.card = root.querySelector('.card');
        this.miniCv = root.querySelector('.mini');
        this.orbCv = root.querySelector('.orb');
        this.statelineEl = root.querySelector('.stateline');
        this.timerEl = root.querySelector('.timer');
        this.startPanel = root.querySelector('.start-panel');
        this.startBtn = root.querySelector('.btn-start');
        this.textBtn = root.querySelector('.btn-text');
        this.transcriptEl = root.querySelector('.transcript');
        this.inputRow = root.querySelector('.inputrow');
        this.field = root.querySelector('.field');
        this.micBtn = root.querySelector('.btn-mic');
        this.endBtn = root.querySelector('.btn-end');
        this.minBtn = root.querySelector('.btn-min');
    }

    connectedCallback() {
        this.mini2d = this.setupCanvas(this.miniCv, 24);
        this.orbSize = this.orbCv.getBoundingClientRect().width || 160;
        this.orb2d = this.setupCanvas(this.orbCv, this.orbSize);

        this.launcher.addEventListener('click', () => this.expand());
        this.minBtn.addEventListener('click', () => this.collapse());
        this.startBtn.addEventListener('click', () => this.startCall(true));
        this.textBtn.addEventListener('click', () => this.startCall(false));
        this.endBtn.addEventListener('click', () => this.endCall());
        this.micBtn.addEventListener('click', () => this.toggleMute());
        this.inputRow.addEventListener('submit', (e) => {
            e.preventDefault();
            const t = this.field.value.trim();
            if (!t) return;
            this.field.value = '';
            this.commitUtterance(t);
        });
        // Tap-to-interrupt on the orb / state line while the agent speaks.
        this.card.querySelector('.stage').addEventListener('click', () => {
            if (this.state === 'speaking') this.interrupt('tap');
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.card.hidden) this.collapse();
        });
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                this.resumeAudio();
                this.startLoop();
                // The OS drops the wake lock while the tab is hidden.
                if (this.callActive) this.acquireWakeLock();
            }
        });
        window.addEventListener('pointerdown', () => this.resumeAudio(), { passive: true });

        if (!SR_CTOR) {
            // Firefox etc: no Web Speech — text is the only input path.
            this.startBtn.hidden = true;
            this.textBtn.textContent = 'START LINK (TEXT)';
            this.card.querySelector('.consent').innerHTML =
                'Voice input is not supported in this browser, type instead;<br>' +
                'replies are still spoken.';
        }

        if (REDUCED.matches) {
            this.drawMini(0);
            this.drawOrbStatic();
        } else {
            this.startLoop();
        }
    }

    // ================= STATE MACHINE =================

    setState(s) {
        if (s === this.state) return;
        this.state = s;
        dbg.state = s;
        this.card.dataset.state = s;
        this.updateStateline();
        window.dispatchEvent(new CustomEvent('alexvoice:state', { detail: { state: s } }));
        if (REDUCED.matches) this.drawOrbStatic();
    }

    updateStateline() {
        if (this.noticeText && performance.now() < this.noticeUntil) {
            this.statelineEl.textContent = this.noticeText;
            this.statelineEl.classList.add('notice');
            return;
        }
        this.statelineEl.classList.remove('notice');
        let line = STATE_LINES[this.state] || '> STANDBY';
        if (this.state === 'listening' && !this.voiceMode) line = '> READY, type below';
        this.statelineEl.textContent = line;
    }

    noticeFor(text, ms) {
        this.noticeText = text;
        this.noticeUntil = performance.now() + ms;
        this.updateStateline();
    }

    // ================= OPEN / CLOSE =================

    expand() {
        dbg.opens++;
        this.launcher.hidden = true;
        this.card.hidden = false;
        // Canvas metrics depend on the visible layout (mobile shrinks the orb).
        const w = this.orbCv.getBoundingClientRect().width || 160;
        if (w !== this.orbSize) {
            this.orbSize = w;
            this.orb2d = this.setupCanvas(this.orbCv, w);
        }
        if (REDUCED.matches) this.drawOrbStatic();
        else this.startLoop();
        (this.callActive ? this.field : (this.startBtn.hidden ? this.textBtn : this.startBtn)).focus();
    }

    collapse() {
        // The mic promise is "only during a call" — a hidden card never keeps
        // a hot mic, so collapsing ends the call.
        this.endCall();
        this.card.hidden = true;
        this.launcher.hidden = false;
    }

    // ================= CALL LIFECYCLE =================

    async startCall(withVoice) {
        if (this.callActive) return;
        dbg.calls++;
        this.setState('connecting');
        this.startPanel.hidden = true;
        this.inputRow.hidden = false;
        // The transcript was display:none on the start screen, which zeroes
        // its scroll position; re-pin it to the latest messages.
        this.scrollTranscript();

        // Audio unlock must start synchronously inside this click gesture.
        this.applyAudioSession(withVoice);
        const audioOk = this.ensureContextSync();

        let voice = withVoice && !!SR_CTOR;
        if (withVoice && !SR_CTOR) {
            this.sysMsg('voice input unsupported here, text mode enabled; replies are still spoken.');
        }
        if (voice) {
            try {
                await this.ensureMic();
            } catch (e) {
                voice = false;
                this.sysMsg('mic unavailable, text mode enabled; replies are still spoken.');
            }
        }
        if (audioOk) {
            try { await this.ensureWorklet(); } catch (e) { dbg.errors++; }
        }

        this.voiceMode = voice;
        this.applyAudioSession(voice); // mic may have been denied: reclassify
        dbg.mode = voice ? 'voice' : 'text';
        this.micBtn.hidden = !voice;
        this.callActive = true;
        this.acquireWakeLock();
        // voice calls are capped: the countdown keeps it fair and visible
        this.callDeadline = voice ? performance.now() + CALL_MAX_MS : 0;
        this.timerEl.hidden = !voice;
        this.timerEl.classList.remove('low', 'red');
        this.timeNoticeShown = false;
        this.updateTimer();
        // Engine pick is async (token fetch + WS handshake) and deliberately
        // not awaited: the greeting must not wait on the network, and every
        // failure inside falls back to Web Speech silently.
        if (voice) this.startStt();
        this.startTick();

        // Canned local greeting — no LLM round trip. Once per session:
        // ending a call and starting another must not re-stack greetings
        // in the persistent transcript.
        if (!this.greeted) {
            this.greeted = true;
            this.speakCanned(GREETING);
        }
        if (this.state === 'connecting') this.setState('listening');
        this.field.focus();
    }

    endCall() {
        if (!this.callActive) return;
        if (this.turn) this.interrupt('end');
        this.callActive = false;
        this.callDeadline = 0;
        this.releaseWakeLock();
        this.timerEl.hidden = true;
        this.stopTick();
        try { if (this.rec) this.rec.abort(); } catch (e) { /* ignore */ }
        this.recRunning = false;
        this.stopDeepgram(true);        // before the mic teardown below
        this.sttEngine = null;
        dbg.sttEngine = null;
        this.clearInterim();
        this.clearStaleFinalGuard();
        if (this.micStream) {
            this.micStream.getTracks().forEach((t) => t.stop());
            this.micStream = null;
        }
        if (this.micSource) {
            try { this.micSource.disconnect(); } catch (e) { /* ignore */ }
            this.micSource = null;
            this.micAnalyser = null;
        }
        this.micMuted = false;
        this.micBtn.setAttribute('aria-pressed', 'false');
        this.micBtn.textContent = 'MIC';
        this.voiceMode = false;
        dbg.mode = null;
        this.inputRow.hidden = true;
        this.startPanel.hidden = false;
        this.setState('idle');
    }

    // Screen wake lock: a call is a hands-off experience (especially voice),
    // so the phone must not sleep mid-conversation. The OS releases the lock
    // whenever the tab hides; the visibilitychange handler re-acquires it.
    // Unsupported browsers simply keep their normal sleep behavior.
    async acquireWakeLock() {
        if (!('wakeLock' in navigator) || this.wakeLock || this.wakeLockPending) return;
        this.wakeLockPending = true;
        try {
            const lock = await navigator.wakeLock.request('screen');
            if (!this.callActive || this.wakeLock) {
                // Call ended while we awaited, or another lock won the race.
                try { lock.release(); } catch (e) { /* ignore */ }
                return;
            }
            this.wakeLock = lock;
            lock.addEventListener('release', () => {
                if (this.wakeLock === lock) this.wakeLock = null;
            });
        } catch (e) {
            /* denied (low battery etc.): screen may sleep */
        } finally {
            this.wakeLockPending = false;
        }
    }

    releaseWakeLock() {
        if (this.wakeLock) {
            try { this.wakeLock.release(); } catch (e) { /* ignore */ }
            this.wakeLock = null;
        }
    }

    enterTextMode(noticeText) {
        if (!this.callActive || !this.voiceMode) return;
        this.voiceMode = false;
        this.applyAudioSession(false); // pure playback: silent-switch immune
        dbg.mode = 'text';
        this.micBtn.hidden = true;
        try { if (this.rec) this.rec.abort(); } catch (e) { /* ignore */ }
        this.recRunning = false;
        this.stopDeepgram(true);
        this.sttEngine = null;
        dbg.sttEngine = null;
        this.clearInterim();
        if (noticeText) this.sysMsg(noticeText);
        this.updateStateline();
    }

    // ================= AUDIO ENGINE =================

    // iOS routes Web Audio through the ringer channel by default, so the
    // agent is silent whenever the mute switch is on — visitors read that
    // as "broken". The Audio Session API (Safari 16.4+) reclassifies us as
    // media playback (or a call, when the mic is live), which ignores the
    // silent switch and keeps output on the loudspeaker.
    applyAudioSession(withMic) {
        try {
            if (navigator.audioSession) {
                navigator.audioSession.type = withMic ? 'play-and-record' : 'playback';
            }
        } catch (e) { /* older browsers: no-op */ }
    }

    ensureContextSync() {
        if (this.ctx) {
            this.resumeAudio();
            return true;
        }
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        let ctx = null;
        try { ctx = new AC({ sampleRate: TARGET_RATE }); }
        catch (e) { try { ctx = new AC(); } catch (e2) { return false; } }
        this.ctx = ctx;
        this.resampleRatio = ctx.sampleRate / TARGET_RATE;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        // iOS unlock hardening: play a 1-frame silent buffer inside the gesture.
        try {
            const b = ctx.createBuffer(1, 1, 22050);
            const s = ctx.createBufferSource();
            s.buffer = b;
            s.connect(ctx.destination);
            s.start(0);
        } catch (e) { /* ignore */ }
        return true;
    }

    resumeAudio() {
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    }

    async ensureWorklet() {
        if (this.workletReady || !this.ctx || !this.ctx.audioWorklet) return;
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
        try {
            await this.ctx.audioWorklet.addModule(url);
        } finally {
            URL.revokeObjectURL(url);
        }
        this.playerNode = new AudioWorkletNode(this.ctx, 'alex-voice-player', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
        });
        this.outAnalyser = this.ctx.createAnalyser();
        this.outAnalyser.fftSize = 1024;
        this.outAnalyser.smoothingTimeConstant = 0.6;
        this.outBuf = new Uint8Array(this.outAnalyser.fftSize);
        this.gain = this.ctx.createGain();
        this.playerNode.connect(this.outAnalyser);
        this.outAnalyser.connect(this.gain);
        this.gain.connect(this.ctx.destination);
        this.playerNode.port.onmessage = (e) => this.onPlayerMessage(e.data);
        this.workletReady = true;
    }

    outputSampleRate() {
        return (this.ctx && this.ctx.sampleRate) || TARGET_RATE;
    }

    updateBufferedDebug() {
        const rate = this.outputSampleRate();
        const workletBacklog = Math.max(0, this.framesWritten - this.framesPlayed);
        const buffered = workletBacklog + this.pendingPcmFrames;
        dbg.bufferedSeconds = rate ? Math.round((buffered / rate) * 1000) / 1000 : 0;
        dbg.overflows = this.workletOverflows;
    }

    clearPendingPcm() {
        this.pendingPcm.length = 0;
        this.pendingPcmFrames = 0;
        this.updateBufferedDebug();
    }

    enqueuePcm(f32) {
        if (!f32 || !f32.length) return 0;
        const frames = f32.length;
        this.pendingPcm.push(f32);
        this.pendingPcmFrames += frames;
        this.framesScheduled += frames;
        this.drainPendingPcm();
        this.updateBufferedDebug();
        return frames;
    }

    drainPendingPcm() {
        if (!this.playerNode || !this.pendingPcm.length) {
            this.updateBufferedDebug();
            return;
        }
        const limit = this.outputSampleRate() * 10;
        let backlog = Math.max(0, this.framesWritten - this.framesPlayed);
        while (this.pendingPcm.length && backlog < limit) {
            const room = Math.floor(limit - backlog);
            if (room <= 0) break;

            const chunk = this.pendingPcm[0];
            const sendFrames = Math.min(chunk.length, room);
            let send;
            if (sendFrames >= chunk.length) {
                send = chunk;
                this.pendingPcm.shift();
            } else {
                send = chunk.slice(0, sendFrames);
                this.pendingPcm[0] = chunk.slice(sendFrames);
            }

            this.pendingPcmFrames = Math.max(0, this.pendingPcmFrames - sendFrames);
            const buf = (send.byteOffset === 0 && send.byteLength === send.buffer.byteLength)
                ? send.buffer
                : send.slice().buffer;
            this.playerNode.port.postMessage(
                { type: 'pcm', epoch: this.playbackEpoch, buf },
                [buf]
            );
            this.framesWritten += sendFrames;
            dbg.framesWritten = this.framesWritten;
            backlog += sendFrames;
        }
        this.updateBufferedDebug();
    }

    onPlayerMessage(d) {
        d = d || {};
        if (d && typeof d.epoch === 'number' && d.epoch !== this.playbackEpoch) return;
        this.playerPlaying = !!d.playing;
        if (typeof d.played === 'number') {
            this.framesPlayed = d.played;
            dbg.framesPlayed = d.played;
        }
        if (typeof d.written === 'number') {
            this.framesWritten = Math.max(this.framesWritten, d.written);
            dbg.framesWritten = this.framesWritten;
        }
        if (typeof d.overflows === 'number') {
            this.workletOverflows = d.overflows;
            dbg.overflows = d.overflows;
        }
        this.drainPendingPcm();
        if (d.playing && this.turn && this.callActive && this.state !== 'speaking') {
            this.setState('speaking');
        }
        this.updateBufferedDebug();
        this.markSpokenSentences();
        if (!d.playing) this.maybeFinishTurn();
    }

    markSpokenSentences() {
        if (!this.turn) return;
        for (const s of this.turn.sentences) {
            if (!s.spoken && this.framesPlayed > s.startFrame) {
                s.spoken = true;
                dbg.sentencesSpoken++;
            }
        }
    }

    async ensureMic() {
        if (this.micStream) return;
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,   // essential: the agent must not hear itself
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
            },
        });
        this.micStream = stream;
        const track = stream.getAudioTracks()[0];
        if (track) {
            track.onended = () => {
                if (this.callActive) this.enterTextMode('mic disconnected, text mode enabled.');
            };
        }
        if (this.ctx) {
            this.micSource = this.ctx.createMediaStreamSource(stream);
            this.micAnalyser = this.ctx.createAnalyser();
            this.micAnalyser.fftSize = 2048;
            this.micAnalyser.smoothingTimeConstant = 0.5;
            this.micBuf = new Uint8Array(this.micAnalyser.fftSize);
            this.micSource.connect(this.micAnalyser);  // analysis only, never to destination
        }
    }

    rmsOf(analyser, buf) {
        if (!analyser || !buf) return 0;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
        }
        return Math.sqrt(sum / buf.length);
    }

    micRms() { return this.micMuted ? 0 : this.rmsOf(this.micAnalyser, this.micBuf); }
    outRms() { return this.rmsOf(this.outAnalyser, this.outBuf); }

    // ================= STT (Web Speech) =================

    shouldListen() {
        // Gates the Web Speech recognizer only — it must never run (or
        // restart itself) while the Deepgram engine owns the mic.
        return this.callActive && this.voiceMode && !this.micMuted
            && this.sttEngine !== 'deepgram';
    }

    startRecognition() {
        if (!SR_CTOR) return;
        if (!this.rec) {
            const rec = new SR_CTOR();
            rec.lang = (navigator.language && /^en/i.test(navigator.language)) ? navigator.language : 'en-US';
            rec.continuous = true;
            rec.interimResults = true;
            rec.maxAlternatives = 1;
            rec.onstart = () => { this.recRunning = true; };
            rec.onresult = (e) => this.onSpeechResult(e);
            rec.onerror = (e) => {
                if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
                    this.enterTextMode('mic access blocked, text mode enabled.');
                }
                // 'no-speech' / 'network' / 'aborted' fall through to onend → restart
            };
            rec.onend = () => {
                this.recRunning = false;
                this.scheduleRecognitionRestart(150);
            };
            this.rec = rec;
        }
        this.safeRecStart();
    }

    scheduleRecognitionRestart(delay) {
        if (!this.rec || !this.shouldListen() || this.recRestartTimer) return;
        dbg.recognitionRestarts++;
        this.recRestartTimer = setTimeout(() => {
            this.recRestartTimer = 0;
            this.safeRecStart();
        }, delay);
    }

    safeRecStart() {
        if (!this.rec || this.recRunning || !this.shouldListen()) return;
        try {
            this.rec.start();
            this.recRunning = true;
        } catch (e) { /* already running */ }
    }

    restartRecognition() {
        if (!this.rec || !this.shouldListen()) return;
        this.clearInterim();
        try { this.rec.abort(); } catch (e) { /* ignore */ }
        this.recRunning = false;
        this.scheduleRecognitionRestart(80);
    }

    agentAudioActive() {
        return this.state === 'speaking'
            || this.playerPlaying
            || this.pendingPcmFrames > 0
            || this.framesScheduled > this.framesPlayed
            || this.framesWritten > this.framesPlayed;
    }

    agentEchoText() {
        const t = this.turn;
        if (!t || !t.sentences.length) return '';
        const played = this.framesPlayed;
        let current = -1;
        for (let i = 0; i < t.sentences.length; i++) {
            const s = t.sentences[i];
            const end = s.endFrame >= 0 ? s.endFrame : this.framesScheduled;
            if (played >= s.startFrame && played <= end) {
                current = i;
                break;
            }
        }
        if (current === -1) {
            for (let i = t.sentences.length - 1; i >= 0; i--) {
                if (played >= t.sentences[i].startFrame) {
                    current = i;
                    break;
                }
            }
        }
        if (current === -1) current = 0;
        const parts = [];
        if (current > 0) parts.push(t.sentences[current - 1].text);
        if (current >= 0) parts.push(t.sentences[current].text);
        return parts.join(' ');
    }

    isLikelySelfEcho(text) {
        const heard = normalizedWords(text);
        if (!heard.length) return false;
        const agentWords = new Set(normalizedWords(this.agentEchoText()));
        if (!agentWords.size) return false;
        let overlap = 0;
        for (const w of heard) if (agentWords.has(w)) overlap++;
        return overlap / heard.length >= 0.7;
    }

    maybeBargeIn(text) {
        if (!this.agentAudioActive() || !this.voiceMode || this.micMuted) return;
        if (wordCount(text) < BARGE_MIN_WORDS) return;
        if (this.isLikelySelfEcho(text)) return;
        if (this.bargeHits * TICK_MS < BARGE_SUSTAIN_MS) return;
        this.bargeHits = 0;
        this.clearInterim();
        this.interrupt('speech');
        this.restartRecognition();
    }

    onSpeechResult(e) {
        let interim = '';
        let finals = '';
        const hearingAgentAtStart = this.agentAudioActive();
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            if (r.isFinal) finals += r[0].transcript;
            else interim += r[0].transcript;
        }
        interim = interim.trim();
        if (interim) {
            const hearingAgent = hearingAgentAtStart || this.agentAudioActive();
            if (!hearingAgent || !this.isLikelySelfEcho(interim)) this.setInterim(interim);
            else this.clearInterim();
            if (hearingAgent) this.maybeBargeIn(interim);
        }
        const finalText = finals.trim();
        if (finalText) {
            if (this.isStaleFinal(finalText)) {
                this.clearStaleFinalGuard();
                return;
            }
            if (hearingAgentAtStart || this.agentAudioActive()) {
                this.clearInterim();
                return;
            }
            this.commitUtterance(finalText, true);
        }
    }

    setInterim(text) {
        if (text !== this.interimText) {
            this.interimText = text;
            this.interimAt = performance.now();
        }
        if (!this.interimEl) {
            this.interimEl = document.createElement('div');
            this.interimEl.className = 'm user interim';
            this.transcriptEl.appendChild(this.interimEl);
        }
        this.interimEl.textContent = VOICE_INTERIM_LABEL;
        this.scrollTranscript();
    }

    clearInterim() {
        this.interimText = '';
        this.dgFinalParts.length = 0;   // dropping an interim drops its segments too
        if (this.interimEl) {
            this.interimEl.remove();
            this.interimEl = null;
        }
    }

    // Stale-final guard: when tick() commits an utterance the engine never
    // endpointed, the engine's own final for that audio may still arrive and
    // must not commit again. Matching on text within a short window (rather
    // than a bare flag) means a real new utterance is never eaten — even a
    // Web Speech final that arrives with no preceding interim.
    armStaleFinalGuard(text) {
        this.staleFinalText = normalizedWords(text).join(' ');
        this.staleFinalUntil = performance.now() + STALE_FINAL_MS;
    }

    clearStaleFinalGuard() {
        this.staleFinalText = '';
        this.staleFinalUntil = 0;
    }

    // A late final may be the whole utterance re-finalized (sometimes with a
    // trailing word or two the interim never showed), or just the tail
    // segment left after earlier Deepgram segments were dropped with the
    // interim. Matching is word-based — string prefixes must not match
    // across word boundaries ("go" vs "google...") — and short utterances
    // only match exactly, so a real new command is never eaten.
    isStaleFinal(text) {
        if (!this.staleFinalText || performance.now() > this.staleFinalUntil) return false;
        const c = this.staleFinalText.split(' ');
        const f = normalizedWords(text);
        if (!f.length) return false;
        const eq = (a, b) => a.length === b.length && a.every((w, i) => w === b[i]);
        if (eq(f, c)) return true;                              // re-finalized as-is
        if (f.length >= 2 && f.length < c.length
            && eq(f, c.slice(-f.length))) return true;          // tail segment
        return c.length >= 3 && f.length > c.length && f.length - c.length <= 2
            && eq(f.slice(0, c.length), c);                     // refined, short new tail
    }

    toggleMute() {
        this.micMuted = !this.micMuted;
        this.micBtn.setAttribute('aria-pressed', String(this.micMuted));
        this.micBtn.setAttribute('aria-label', this.micMuted ? 'Unmute microphone' : 'Mute microphone');
        this.micBtn.textContent = this.micMuted ? 'MUTED' : 'MIC';
        if (this.micStream) this.micStream.getAudioTracks().forEach((t) => { t.enabled = !this.micMuted; });
        if (this.micMuted) {
            this.clearInterim();
            try { if (this.rec) this.rec.abort(); } catch (e) { /* ignore */ }
        } else {
            this.safeRecStart();
        }
    }

    // ================= STT (Deepgram streaming) =================
    // Primary engine when /api/stt-token mints tokens: mic → capture worklet
    // (Float32 → Int16) → ~100 ms batches downsampled to 16 kHz → WS to
    // Deepgram Nova-3. Results feed the SAME interim/commit/barge-in paths
    // as Web Speech. Any failure — no token (404), WS refusal, worklet
    // unavailable, a second mid-call drop — falls back to Web Speech quietly.

    async startStt() {
        const gen = ++this.sttGen;      // this attempt owns the engine now
        let ok = false;
        try { ok = await this.startDeepgram(gen); } catch (e) { ok = false; }
        if (gen !== this.sttGen) return; // an END/restart superseded us
        if (!this.callActive || !this.voiceMode) return;
        if (!ok) {
            this.stopDeepgram(true);    // never leave both engines half-alive
            this.sttEngine = 'webspeech';
            dbg.sttEngine = 'webspeech';
            this.startRecognition();
        }
    }

    async fetchSttToken() {
        const res = await fetch(STT_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        if (!res.ok) return null;       // 404 = not configured → silent fallback
        const data = await res.json();
        return (data && typeof data.token === 'string' && data.token) ? data.token : null;
    }

    async startDeepgram(gen) {
        if (!this.ctx || !this.micSource || typeof WebSocket === 'undefined') return false;
        this.sttEngine = 'deepgram';    // blocks the recognizer while we try
        this.dgReconnected = false;
        let token = null;
        try { token = await this.fetchSttToken(); } catch (e) { /* fall back */ }
        if (gen !== this.sttGen) return false;
        if (!token || !this.callActive || !this.voiceMode) return false;
        try { await this.ensureCaptureWorklet(); } catch (e) { /* fall back */ }
        if (gen !== this.sttGen) return false;
        if (!this.captureWorkletReady || !this.callActive || !this.voiceMode) return false;
        try { await this.openDgSocket(token, gen); } catch (e) { return false; }
        // Superseded after our socket opened: whoever bumped the generation
        // (teardown or a newer attempt) has already closed or displaced our
        // socket — never touch this.dgWs from a stale attempt.
        if (gen !== this.sttGen) return false;
        if (!this.callActive || !this.voiceMode) { this.stopDeepgram(true); return false; }
        this.attachCapture();
        dbg.sttEngine = 'deepgram';
        return true;
    }

    // Same Blob-URL pattern as the player worklet; reuses the one shared
    // AudioContext that the start-call gesture already unlocked (iOS).
    async ensureCaptureWorklet() {
        if (this.captureWorkletReady || !this.ctx || !this.ctx.audioWorklet) return;
        const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' }));
        try {
            await this.ctx.audioWorklet.addModule(url);
        } finally {
            URL.revokeObjectURL(url);
        }
        this.captureWorkletReady = true;
    }

    openDgSocket(token, gen) {
        return new Promise((resolve, reject) => {
            if (gen !== this.sttGen) {
                reject(new Error('dg_stale'));
                return;
            }
            let ws;
            try {
                // Browsers cannot set WS headers; Deepgram accepts the temp
                // token via the Sec-WebSocket-Protocol pair instead. Grant
                // JWTs use 'bearer' ('token' is only for raw API keys).
                ws = new WebSocket(DG_LISTEN_URL, ['bearer', token]);
            } catch (e) {
                reject(e);
                return;
            }
            ws.binaryType = 'arraybuffer';
            let opened = false;
            const stale = () => gen !== this.sttGen || this.dgWs !== ws;
            ws.onopen = () => {
                if (stale()) {                  // torn down / superseded while connecting
                    try { ws.close(); } catch (e) { /* ignore */ }
                    reject(new Error('dg_stale'));
                    return;
                }
                opened = true;
                dbg.dgConnects++;
                this.dgLastAudioAt = performance.now();
                this.startDgKeepAlive();
                resolve();
            };
            ws.onmessage = (e) => {
                if (!stale() && typeof e.data === 'string') this.onDgMessage(e.data);
            };
            ws.onerror = () => {
                if (!opened) {
                    if (this.dgWs === ws) this.dgWs = null;
                    reject(new Error('dg_ws_error'));
                }
            };
            ws.onclose = () => {
                if (!opened) {
                    if (this.dgWs === ws) this.dgWs = null;
                    reject(new Error('dg_ws_closed'));
                    return;
                }
                if (gen === this.sttGen && this.dgWs === ws) this.onDgClose();
            };
            // Never orphan a socket we displace (a stale attempt may have
            // parked one here between our checks).
            if (this.dgWs && this.dgWs !== ws) {
                try { this.dgWs.close(); } catch (e) { /* ignore */ }
            }
            this.dgWs = ws;
        });
    }

    attachCapture() {
        if (this.dgCaptureNode || !this.ctx || !this.micSource) return;
        const node = new AudioWorkletNode(this.ctx, 'alex-voice-capture', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
        });
        node.port.onmessage = (e) => this.onCaptureChunk(e.data);
        // Zero-gain sink keeps the node pulled by the render graph without
        // ever being audible (its process() writes no output anyway).
        const mute = this.ctx.createGain();
        mute.gain.value = 0;
        this.micSource.connect(node);
        node.connect(mute);
        mute.connect(this.ctx.destination);
        this.dgCaptureNode = node;
        this.dgMuteGain = mute;
    }

    onCaptureChunk(d) {
        if (!d || d.type !== 'pcm' || !d.buf) return;
        const ws = this.dgWs;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (this.micMuted) {
            // Mute contract: no audio leaves the page; KeepAlive holds the WS.
            this.dgBatch.length = 0;
            this.dgBatchSamples = 0;
            return;
        }
        const chunk = new Int16Array(d.buf);
        this.dgBatch.push(chunk);
        this.dgBatchSamples += chunk.length;
        if (this.dgBatchSamples < Math.floor(this.outputSampleRate() * DG_BATCH_MS / 1000)) return;
        const joined = new Int16Array(this.dgBatchSamples);
        let off = 0;
        for (const c of this.dgBatch) { joined.set(c, off); off += c.length; }
        this.dgBatch.length = 0;
        this.dgBatchSamples = 0;
        const frame = this.downsampleForDg(joined);
        try { ws.send(frame.buffer); } catch (e) { return; }
        dbg.dgFrames++;
        this.dgLastAudioAt = performance.now();
    }

    // Linear-interp downsample from the shared context rate (24 kHz — or the
    // device rate when the context refused 24 kHz) to Deepgram's 16 kHz.
    downsampleForDg(pcm) {
        const inRate = this.outputSampleRate();
        if (inRate === DG_RATE) return pcm;
        const ratio = inRate / DG_RATE;
        const n = Math.max(1, Math.floor(pcm.length / ratio));
        const out = new Int16Array(n);
        for (let i = 0; i < n; i++) {
            const p = i * ratio;
            const j = Math.floor(p);
            const fr = p - j;
            const a = pcm[j] !== undefined ? pcm[j] : 0;
            const b = pcm[j + 1] !== undefined ? pcm[j + 1] : a;
            out[i] = Math.round(a + (b - a) * fr);
        }
        return out;
    }

    startDgKeepAlive() {
        this.stopDgKeepAlive();
        this.dgKeepAliveTimer = setInterval(() => {
            const ws = this.dgWs;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            if (performance.now() - this.dgLastAudioAt < DG_KEEPALIVE_MS) return;
            try { ws.send(JSON.stringify({ type: 'KeepAlive' })); } catch (e) { /* ignore */ }
            this.dgLastAudioAt = performance.now();
        }, 2000);
    }

    stopDgKeepAlive() {
        if (this.dgKeepAliveTimer) {
            clearInterval(this.dgKeepAliveTimer);
            this.dgKeepAliveTimer = 0;
        }
    }

    // Deepgram Results events, routed onto the exact paths the Web Speech
    // handler uses: interims → setInterim + maybeBargeIn (echo-gated),
    // finals → dropped while agent audio is active, committed on endpoint.
    // is_final closes a segment; speech_final marks the utterance endpoint,
    // so segments accumulate in dgFinalParts until then.
    onDgMessage(raw) {
        let data;
        try { data = JSON.parse(raw); } catch (e) { return; }
        if (!data || data.type !== 'Results') return;
        const alt = data.channel && data.channel.alternatives && data.channel.alternatives[0];
        const text = (alt && typeof alt.transcript === 'string') ? alt.transcript.trim() : '';
        const hearingAgent = this.agentAudioActive();

        if (data.is_final) {
            if (text) dbg.dgFinals++;
            if (this.isStaleFinal(text)) {
                // Late final for an utterance the tick() fallback already
                // committed; text-matched, so real new speech never lands here.
                if (data.speech_final) this.clearStaleFinalGuard();
                this.dgFinalParts.length = 0;
                return;
            }
            if (hearingAgent) {
                this.clearInterim();    // same echo rule as Web Speech finals
                return;
            }
            if (text) this.dgFinalParts.push(text);
            const full = this.dgFinalParts.join(' ').trim();
            if (data.speech_final) {
                this.dgFinalParts.length = 0;
                this.clearInterim();
                if (full) this.commitUtterance(full, true);
            } else if (full) {
                this.setInterim(full);  // segment done, utterance continuing
            }
            return;
        }

        if (!text) return;
        dbg.dgInterims++;
        const shown = this.dgFinalParts.length
            ? this.dgFinalParts.join(' ') + ' ' + text
            : text;
        if (!hearingAgent || !this.isLikelySelfEcho(shown)) this.setInterim(shown);
        else this.clearInterim();
        if (hearingAgent) this.maybeBargeIn(shown);
    }

    onDgClose() {
        // Reached only on an unexpected close — deliberate teardown paths
        // null out dgWs before closing the socket.
        this.stopDgKeepAlive();
        this.dgWs = null;
        if (!this.callActive || !this.voiceMode || this.sttEngine !== 'deepgram') return;
        if (this.dgReconnected) {
            this.dgFallback();
            return;
        }
        this.dgReconnected = true;
        dbg.dgReconnects++;
        this.reconnectDeepgram(this.sttGen);
    }

    async reconnectDeepgram(gen) {
        let ok = false;
        try {
            const token = await this.fetchSttToken();
            if (gen === this.sttGen && token && this.callActive && this.sttEngine === 'deepgram') {
                await this.openDgSocket(token, gen);
                ok = true;
            }
        } catch (e) { /* fall back below */ }
        if (gen !== this.sttGen) return; // superseded: not ours to act on
        if (!this.callActive || !this.voiceMode || this.sttEngine !== 'deepgram') return;
        if (!ok) this.dgFallback();
    }

    dgFallback() {
        // Deepgram died twice mid-call: switch to Web Speech, quietly —
        // typed input always works, so no user-facing error.
        dbg.errors++;
        this.stopDeepgram(false);
        if (!this.callActive || !this.voiceMode) return;
        if (SR_CTOR) {
            this.sttEngine = 'webspeech';
            dbg.sttEngine = 'webspeech';
            this.startRecognition();
        } else {
            this.sttEngine = null;
            dbg.sttEngine = null;
            this.enterTextMode('voice input hiccuped, text mode enabled; replies are still spoken.');
        }
    }

    stopDeepgram(graceful) {
        this.sttGen++;                  // invalidate any in-flight async work
        this.stopDgKeepAlive();
        const ws = this.dgWs;
        this.dgWs = null;               // onclose now reads as deliberate
        if (ws) {
            try {
                if (graceful && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'CloseStream' }));
                }
            } catch (e) { /* ignore */ }
            try { ws.close(); } catch (e) { /* ignore */ }
        }
        if (this.dgCaptureNode) {
            this.dgCaptureNode.port.onmessage = null;
            try { if (this.micSource) this.micSource.disconnect(this.dgCaptureNode); } catch (e) { /* ignore */ }
            try { this.dgCaptureNode.disconnect(); } catch (e) { /* ignore */ }
            this.dgCaptureNode = null;
        }
        if (this.dgMuteGain) {
            try { this.dgMuteGain.disconnect(); } catch (e) { /* ignore */ }
            this.dgMuteGain = null;
        }
        this.dgBatch.length = 0;
        this.dgBatchSamples = 0;
        this.dgFinalParts.length = 0;
    }

    // ================= CONVERSATION LOOP =================

    commitUtterance(text, spoken) {
        if (!this.callActive) return;
        const t = text.trim().slice(0, MSG_MAX);
        if (!t) return;
        if (this.turn) this.interrupt('new-utterance');
        this.clearInterim();
        this.addMsg(spoken ? 'user voice' : 'user', spoken ? VOICE_MSG_LABEL : t);
        this.history.push({ role: 'user', content: t });
        this.trimHistory();
        dbg.commits++;
        this.beginTurn();
    }

    trimHistory() {
        if (this.history.length > HISTORY_MAX) {
            this.history.splice(0, this.history.length - HISTORY_MAX);
        }
        for (const m of this.history) {
            if (m.content.length > MSG_MAX) m.content = m.content.slice(0, MSG_MAX);
        }
    }

    beginTurn() {
        const id = ++this.utteranceId;
        dbg.utteranceId = id;
        this.turn = {
            id, reply: '', pending: '', sentences: [],
            chatDone: false, flushed: false, canned: false, el: null,
        };
        this.resetPlayback();
        this.setState('thinking');
        this.runChat(this.turn);
    }

    // Local canned speech (greeting) — no LLM round trip.
    speakCanned(text) {
        this.addMsg('agent', text);
        this.history.push({ role: 'assistant', content: text });
        this.trimHistory();
        const id = ++this.utteranceId;
        dbg.utteranceId = id;
        this.turn = {
            id, reply: text, pending: '', sentences: [],
            chatDone: true, flushed: true, canned: true, el: null,
        };
        this.resetPlayback();
        this.queueSentence(this.turn, text);
    }

    resetPlayback() {
        this.playbackEpoch++;
        this.framesWritten = 0;
        this.framesPlayed = 0;
        this.framesScheduled = 0;
        dbg.framesWritten = 0;
        dbg.framesPlayed = 0;
        this.playerPlaying = false;
        this.clearPendingPcm();
        if (this.playerNode) this.playerNode.port.postMessage({ type: 'clear', epoch: this.playbackEpoch });
        this.updateBufferedDebug();
    }

    async runChat(turn) {
        dbg.chatRequests++;
        const ctrl = new AbortController();
        this.chatCtrl = ctrl;
        const watchdog = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, 60000);
        let res;
        try {
            res = await fetch(CHAT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: this.history.slice(-HISTORY_MAX) }),
                signal: ctrl.signal,
            });
        } catch (e) {
            clearTimeout(watchdog);
            if (turn.id === this.utteranceId) this.turnError('connection hiccup, try again in a moment.');
            return;
        }
        if (turn.id !== this.utteranceId) { clearTimeout(watchdog); return; }
        if (res.status === 429) { clearTimeout(watchdog); this.rateLimitedTurn(); return; }
        if (!res.ok || !res.body) {
            clearTimeout(watchdog);
            this.turnError('the agent glitched, try again.');
            return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (turn.id !== this.utteranceId) { try { ctrl.abort(); } catch (e) { /* ignore */ } return; }
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let idx;
                while ((idx = buf.indexOf('\n\n')) >= 0) {
                    const frame = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    for (const rawLine of frame.split('\n')) {
                        const line = rawLine.replace(/\r$/, '');
                        if (!line.startsWith('data:')) continue;
                        let ev;
                        try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
                        if (typeof ev.d === 'string' && ev.d) {
                            this.onDelta(turn, ev.d);
                        } else if (ev.done) {
                            this.onChatDone(turn);
                        } else if (ev.error) {
                            this.turnError('the agent glitched, try again.');
                            return;
                        }
                    }
                }
            }
            if (turn.id === this.utteranceId && !turn.chatDone) this.onChatDone(turn);
        } catch (e) {
            if (turn.id === this.utteranceId) this.turnError('connection dropped, try again.');
        } finally {
            clearTimeout(watchdog);
            if (this.chatCtrl === ctrl) this.chatCtrl = null;
        }
    }

    onDelta(turn, d) {
        dbg.chatDeltas++;
        dbg.chatChars += d.length;
        turn.reply += d;
        turn.pending += d;
        if (!turn.el) turn.el = this.addMsg('agent', '');
        turn.el.textContent = turn.reply;
        this.scrollTranscript();
        this.splitPending(turn, false);
    }

    onChatDone(turn) {
        turn.chatDone = true;
        this.splitPending(turn, true);
        this.maybeFinishTurn();
    }

    // Sentence splitter with an eager first flush (latency: first audio matters most).
    splitPending(turn, flushAll) {
        const re = /([.!?…]["')\]]?)(\s+)/g;
        let consumed = 0;
        let m;
        while ((m = re.exec(turn.pending))) {
            const end = m.index + m[1].length;
            const cand = turn.pending.slice(consumed, end).trim();
            if (ABBREV_TAIL.test(cand)) continue;      // "Dr." / "e.g.", not a boundary
            this.queueSentence(turn, cand);
            consumed = m.index + m[0].length;
        }
        if (consumed) turn.pending = turn.pending.slice(consumed);

        if (!turn.flushed && !flushAll) {
            // Eager first flush: ~12 words, or the first comma clause.
            const trimmed = turn.pending.trim();
            if (wordCount(trimmed) >= 12) {
                this.queueSentence(turn, trimmed);
                turn.pending = '';
            } else {
                const ci = turn.pending.indexOf(',');
                if (ci > 10) {
                    this.queueSentence(turn, turn.pending.slice(0, ci + 1).trim());
                    turn.pending = turn.pending.slice(ci + 1);
                }
            }
        }
        if (flushAll && turn.pending.trim()) {
            this.queueSentence(turn, turn.pending.trim());
            turn.pending = '';
        }
    }

    // ================= TTS PIPELINE =================

    queueSentence(turn, text) {
        const clean = cleanForTTS(text).slice(0, TTS_MAX);
        if (clean.length < 2) return;
        turn.flushed = true;
        dbg.sentencesQueued++;
        this.ttsQueue.push({ turn, text: clean });
        this.pumpTTS();
    }

    // Serialized queue worker: sentence N+1 is fetched while N's already
    // buffered audio plays out of the ring buffer.
    async pumpTTS() {
        if (this.ttsBusy) return;
        this.ttsBusy = true;
        try {
            while (this.ttsQueue.length) {
                const job = this.ttsQueue.shift();
                if (job.turn.id !== this.utteranceId) continue;
                if (!this.playerNode) continue;         // no audio path → text-only replies
                const rec = { text: job.text, startFrame: this.framesScheduled, endFrame: -1, spoken: false };
                job.turn.sentences.push(rec);
                try {
                    await this.streamTTS(job.text, job.turn.id);
                } catch (e) {
                    if (job.turn.id !== this.utteranceId) continue;
                    if (e && e.rateLimited) {
                        dbg.rateLimited++;
                        this.noticeFor('> RATE LIMITED, one sec', 2500);
                        this.ttsQueue.length = 0;       // don't hammer the limiter
                    } else if (e && e.name !== 'AbortError') {
                        dbg.errors++;
                    }
                }
                rec.endFrame = this.framesScheduled;
            }
        } finally {
            this.ttsBusy = false;
        }
        this.maybeFinishTurn();
    }

    async streamTTS(text, uid) {
        dbg.ttsRequests++;
        const ctrl = new AbortController();
        this.ttsCtrl = ctrl;
        const watchdog = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, 30000);
        try {
            const res = await fetch(TTS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
                signal: ctrl.signal,
            });
            if (res.status === 429) throw { rateLimited: true };
            if (!res.ok || !res.body) throw new Error('tts_http_' + res.status);
            if ((res.headers.get('content-type') || '').includes('application/json')) {
                throw new Error('tts_error_payload');
            }
            const reader = res.body.getReader();
            let carry = null;   // odd trailing byte, an Int16 split across chunks
            for (;;) {
                const { done, value } = await reader.read();
                if (uid !== this.utteranceId) { try { ctrl.abort(); } catch (e) { /* ignore */ } return; }
                if (done) break;
                let bytes = value;
                if (carry) {
                    const merged = new Uint8Array(carry.length + bytes.length);
                    merged.set(carry, 0);
                    merged.set(bytes, carry.length);
                    bytes = merged;
                    carry = null;
                }
                const even = bytes.length - (bytes.length % 2);
                if (even < bytes.length) carry = bytes.slice(even);
                if (!even) continue;
                const frames = even >> 1;
                const dv = new DataView(bytes.buffer, bytes.byteOffset, even);
                let f32 = new Float32Array(frames);
                for (let i = 0; i < frames; i++) f32[i] = dv.getInt16(i * 2, true) / 32768;
                if (Math.abs(this.resampleRatio - 1) > 1e-6) f32 = this.resample(f32);
                dbg.ttsChunks++;
                dbg.ttsBytes += even;
                this.enqueuePcm(f32);
                if (this.turn && this.turn.id === uid && this.callActive && this.state !== 'speaking') {
                    this.setState('speaking');
                }
            }
        } finally {
            clearTimeout(watchdog);
            if (this.ttsCtrl === ctrl) this.ttsCtrl = null;
        }
    }

    // Linear-interp resample (only used when the context refused 24 kHz).
    resample(f32) {
        const ratio = this.resampleRatio;
        const n = Math.max(1, Math.floor(f32.length * ratio));
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const p = i / ratio;
            const j = Math.floor(p);
            const fr = p - j;
            const a = f32[j] !== undefined ? f32[j] : 0;
            const b = f32[j + 1] !== undefined ? f32[j + 1] : a;
            out[i] = a + (b - a) * fr;
        }
        return out;
    }

    // ================= TURN COMPLETION / INTERRUPTION =================

    maybeFinishTurn() {
        const t = this.turn;
        if (!t || !t.chatDone || this.ttsQueue.length || this.ttsBusy || this.pendingPcmFrames || this.playerPlaying) return;
        if (this.playerNode && this.framesPlayed < this.framesScheduled) return;   // still draining
        const wasSpeaking = this.state === 'speaking';
        this.turn = null;
        if (!t.canned && t.reply.trim()) {
            this.history.push({ role: 'assistant', content: t.reply.trim().slice(0, MSG_MAX) });
            this.trimHistory();
        }
        if (this.callActive) {
            if (wasSpeaking) this.restartRecognition();
            this.setState('listening');
        }
    }

    interrupt(reason) {
        const turn = this.turn;
        if (!turn) return;
        dbg.interrupts++;
        this.utteranceId++;                 // everything in flight is now stale
        dbg.utteranceId = this.utteranceId;
        try { if (this.chatCtrl) this.chatCtrl.abort(); } catch (e) { /* ignore */ }
        try { if (this.ttsCtrl) this.ttsCtrl.abort(); } catch (e) { /* ignore */ }
        this.ttsQueue.length = 0;
        this.clearPendingPcm();
        const played = this.framesPlayed;
        const clearEpoch = ++this.playbackEpoch;

        // Flush: quick gain ramp (no click), then clear the ring buffer.
        if (this.ctx && this.gain && this.playerNode) {
            const g = this.gain.gain;
            const t0 = this.ctx.currentTime;
            try {
                g.cancelScheduledValues(t0);
                g.setValueAtTime(g.value, t0);
                g.linearRampToValueAtTime(0, t0 + 0.03);
            } catch (e) { /* ignore */ }
            const node = this.playerNode;
            const gainRef = this.gain;
            const ctxRef = this.ctx;
            setTimeout(() => {
                node.port.postMessage({ type: 'clear', epoch: clearEpoch });
                try {
                    const t1 = ctxRef.currentTime;
                    gainRef.gain.cancelScheduledValues(t1);
                    gainRef.gain.setValueAtTime(0, t1);
                    gainRef.gain.linearRampToValueAtTime(1, t1 + 0.02);
                } catch (e) { /* ignore */ }
            }, 45);
        }

        // History gets only the sentences the visitor actually heard.
        if (!turn.canned) {
            const heard = played > 0
                ? turn.sentences.filter((s) => s.startFrame < played).map((s) => s.text).join(' ')
                : '';
            if (heard) {
                this.history.push({ role: 'assistant', content: heard.slice(0, MSG_MAX) });
                this.trimHistory();
            }
            if (turn.el) turn.el.classList.add('cut');
        }

        this.turn = null;
        this.playerPlaying = false;
        this.framesWritten = 0;
        this.framesPlayed = 0;
        this.framesScheduled = 0;
        dbg.framesWritten = 0;
        dbg.framesPlayed = 0;
        this.updateBufferedDebug();
        this.bargeHits = 0;
        if (this.callActive) this.setState('listening');
    }

    turnError(msg) {
        dbg.errors++;
        try { if (this.ttsCtrl) this.ttsCtrl.abort(); } catch (e) { /* ignore */ }
        this.ttsQueue.length = 0;
        this.clearPendingPcm();
        if (this.turn) {
            this.utteranceId++;
            dbg.utteranceId = this.utteranceId;
            this.turn = null;
        }
        this.sysMsg(msg);
        this.setState(this.callActive ? 'listening' : 'idle');
    }

    rateLimitedTurn() {
        dbg.rateLimited++;
        this.noticeFor('> RATE LIMITED, one sec', 2500);
        this.sysMsg('rate limited, give it a moment, then ask again.');
        this.clearPendingPcm();
        if (this.turn) {
            this.utteranceId++;
            dbg.utteranceId = this.utteranceId;
            this.turn = null;
        }
        this.setState(this.callActive ? 'listening' : 'idle');
    }

    // ================= TRANSCRIPT =================

    addMsg(kind, text) {
        const el = document.createElement('div');
        el.className = 'm ' + kind;
        el.textContent = text;
        // Keep the interim bubble pinned to the bottom.
        if (this.interimEl) this.transcriptEl.insertBefore(el, this.interimEl);
        else this.transcriptEl.appendChild(el);
        this.scrollTranscript();
        return el;
    }

    sysMsg(text) { return this.addMsg('sys', text); }

    scrollTranscript() {
        this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
    }

    // ================= HOUSEKEEPING TICK =================
    // Endpointing + RMS barge-in run here (not in rAF) so they keep working
    // under prefers-reduced-motion and heavy rendering load.

    startTick() {
        if (this.tickTimer) return;
        this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    }

    stopTick() {
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = 0;
        }
        this.bargeHits = 0;
    }

    tick() {
        if (!this.callActive) return;
        const now = performance.now();

        // Endpointing belt-and-braces: Safari's isFinal is flaky, so a stable
        // interim + ~900 ms of silence commits the utterance. On the Deepgram
        // engine the window must sit safely ABOVE Deepgram's own endpointing,
        // or the two race and one utterance commits twice (two bubbles).
        const endpointMs = this.sttEngine === 'deepgram' ? DG_FALLBACK_MS : ENDPOINT_MS;
        if (this.voiceMode && this.interimText && this.state === 'listening'
            && now - this.interimAt > endpointMs && this.micRms() < 0.05) {
            const t = this.interimText;
            this.clearInterim();
            // The engine never endpointed this utterance itself, so a late
            // final for it (if one ever arrives) is a duplicate — swallow it.
            this.armStaleFinalGuard(t);
            this.commitUtterance(t, true);
        }

        // Barge-in requires both sustained input energy and a non-echo interim.
        if (this.agentAudioActive() && this.voiceMode && !this.micMuted && this.micAnalyser) {
            if (this.micRms() > BARGE_RMS) {
                this.bargeHits++;
                this.maybeBargeIn(this.interimText);
            } else {
                this.bargeHits = 0;
            }
        } else {
            this.bargeHits = 0;
        }

        // iOS occasionally re-suspends the context mid-session.
        this.resumeAudio();
        this.updateStateline();     // notice expiry
        this.updateTimer();
    }

    // Voice-call countdown: visible in the header, amber for the last
    // stretch, and the call ends itself when it hits zero.
    updateTimer() {
        if (!this.callDeadline || !this.callActive) return;
        const left = this.callDeadline - performance.now();
        if (left <= 0) {
            this.sysMsg("time's up, thanks for the chat! start another call anytime.");
            this.endCall();
            // The idle start screen hides the transcript, so the sys message
            // alone would be invisible — say it on the stateline too.
            this.noticeFor("time's up, thanks for the chat", 8000);
            return;
        }
        const s = Math.ceil(left / 1000);
        this.timerEl.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
        this.timerEl.classList.toggle('low', left <= CALL_WARN_MS && left > CALL_RED_MS);
        this.timerEl.classList.toggle('red', left <= CALL_RED_MS);
        if (left <= CALL_RED_MS && !this.timeNoticeShown) {
            this.timeNoticeShown = true;
            this.noticeFor('10 seconds left', 4000);
        }
    }

    // ================= CANVAS RENDERING =================

    setupCanvas(cv, size) {
        const d = Math.min(window.devicePixelRatio || 1, 2.5);
        cv.width = Math.round(size * d);
        cv.height = Math.round(size * d);
        cv.style.width = size + 'px';
        cv.style.height = size + 'px';
        const c = cv.getContext('2d');
        c.setTransform(d, 0, 0, d, 0, 0);
        return c;
    }

    startLoop() {
        if (this.rafId || REDUCED.matches) return;
        const step = (ts) => {
            this.rafId = requestAnimationFrame(step);
            this.frame(ts);
        };
        this.rafId = requestAnimationFrame(step);
    }

    stopLoop() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = 0;
        }
    }

    frame(ts) {
        const dt = this.lastTs ? Math.min(ts - this.lastTs, 100) : 16;
        this.lastTs = ts;
        if (document.hidden) return;

        if (this.card.hidden) {
            // Collapsed: subtle launcher breath at ~12 fps.
            this.miniAcc += dt;
            if (this.miniAcc >= 80) {
                this.miniAcc = 0;
                this.drawMini(ts);
            }
            return;
        }

        // Level source follows the state: mic while listening, output while speaking.
        let target;
        switch (this.state) {
            case 'speaking':  target = Math.min(1, this.outRms() * 2.4); break;
            case 'listening': target = this.voiceMode ? Math.min(1, this.micRms() * 2.8) : 0.08 + 0.05 * Math.sin(ts / 900); break;
            case 'thinking':  target = 0.18 + 0.14 * Math.sin(ts / 120); break;
            case 'connecting': target = 0.14 + 0.1 * Math.sin(ts / 260); break;
            default:          target = 0.06 + 0.04 * Math.sin(ts / 900);
        }
        // Asymmetric attack/decay feels more alive.
        this.level += (target - this.level) * (target > this.level ? 0.4 : 0.08);
        this.drawOrb(ts);
    }

    orbColor() {
        switch (this.state) {
            case 'listening': return [56, 160, 255];    // blue = the visitor
            case 'connecting': return [120, 180, 140];
            default: return [0, 255, 102];              // green = the agent / idle
        }
    }

    drawOrb(ts) {
        const c = this.orb2d;
        const S = this.orbSize;
        if (!c) return;
        c.clearRect(0, 0, S, S);
        const cx = S / 2, cy = S / 2;
        const t = ts / 1000;
        const level = Math.max(0, Math.min(1, this.level));
        const R = S * 0.26 * (1 + level * 0.22);
        const [r, g, b] = this.orbColor();

        // Expanding rings while speaking.
        if (this.state === 'speaking' && level > 0.32 && ts - this.lastRingAt > 320) {
            this.lastRingAt = ts;
            this.rings.push({ r: R * 1.05, a: 0.5 });
        }
        for (let i = this.rings.length - 1; i >= 0; i--) {
            const ring = this.rings[i];
            ring.r += S * 0.012;
            ring.a *= 0.93;
            if (ring.a < 0.03 || ring.r > S * 0.48) { this.rings.splice(i, 1); continue; }
            c.beginPath();
            c.arc(cx, cy, ring.r, 0, Math.PI * 2);
            c.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + ring.a.toFixed(3) + ')';
            c.lineWidth = 1.5;
            c.stroke();
        }

        // Organic wobble disc.
        const N = 64;
        c.beginPath();
        for (let i = 0; i <= N; i++) {
            const a = (i / N) * Math.PI * 2;
            const wob = 1
                + 0.06 * Math.sin(3 * a + t * 0.7)
                + 0.04 * Math.sin(5 * a - t * 1.1)
                + level * 0.25 * Math.sin(7 * a + t * 2.3);
            const rr = R * wob;
            const x = cx + Math.cos(a) * rr;
            const y = cy + Math.sin(a) * rr;
            if (i === 0) c.moveTo(x, y);
            else c.lineTo(x, y);
        }
        c.closePath();
        const grad = c.createRadialGradient(cx - R * 0.25, cy - R * 0.3, R * 0.1, cx, cy, R * 1.2);
        grad.addColorStop(0, 'rgba(235,255,240,0.95)');
        grad.addColorStop(0.45, 'rgba(' + r + ',' + g + ',' + b + ',0.85)');
        grad.addColorStop(1, 'rgba(' + Math.round(r * 0.2) + ',' + Math.round(g * 0.25) + ',' + Math.round(b * 0.2) + ',0.9)');
        c.save();
        c.shadowColor = 'rgba(' + r + ',' + g + ',' + b + ',0.8)';
        c.shadowBlur = 14 + level * 36;
        c.fillStyle = grad;
        c.fill();
        c.restore();

        // Orbiting dots while thinking.
        if (this.state === 'thinking' || this.state === 'connecting') {
            const oR = R * 1.45;
            for (let i = 0; i < 3; i++) {
                const a = t * 2.6 + (i * Math.PI * 2) / 3;
                c.beginPath();
                c.arc(cx + Math.cos(a) * oR, cy + Math.sin(a) * oR * 0.92, 2.4, 0, Math.PI * 2);
                c.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',0.85)';
                c.fill();
            }
        }

        // Processing ring while thinking: two thin arcs sweeping around the
        // orb — unmistakable "working on it" motion even at a glance, without
        // leaving the terminal aesthetic. (Dots alone read as ambient.)
        if (this.state === 'thinking') {
            // level is smoothed across states (can be ~1 right after loud
            // speech), so clamp the ring inside the canvas.
            const pR = Math.min(R * 1.62, S * 0.47);
            const sweep = 1.15;
            const base = t * 1.8;
            c.save();
            c.lineWidth = 2;
            c.lineCap = 'round';
            c.shadowColor = 'rgba(' + r + ',' + g + ',' + b + ',0.7)';
            c.shadowBlur = 6;
            c.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',0.55)';
            for (let i = 0; i < 2; i++) {
                const a0 = base + i * Math.PI;
                c.beginPath();
                c.arc(cx, cy, pR, a0, a0 + sweep);
                c.stroke();
            }
            c.restore();
        }
    }

    // Reduced motion: a single static disc; CSS supplies a soft opacity pulse.
    drawOrbStatic() {
        const c = this.orb2d;
        const S = this.orbSize;
        if (!c) return;
        c.clearRect(0, 0, S, S);
        const cx = S / 2, cy = S / 2;
        const R = S * 0.28;
        const [r, g, b] = this.orbColor();
        const grad = c.createRadialGradient(cx - R * 0.25, cy - R * 0.3, R * 0.1, cx, cy, R * 1.2);
        grad.addColorStop(0, 'rgba(235,255,240,0.95)');
        grad.addColorStop(0.45, 'rgba(' + r + ',' + g + ',' + b + ',0.85)');
        grad.addColorStop(1, 'rgba(' + Math.round(r * 0.2) + ',' + Math.round(g * 0.25) + ',' + Math.round(b * 0.2) + ',0.9)');
        c.save();
        c.shadowColor = 'rgba(' + r + ',' + g + ',' + b + ',0.7)';
        c.shadowBlur = 18;
        c.fillStyle = grad;
        c.beginPath();
        c.arc(cx, cy, R, 0, Math.PI * 2);
        c.fill();
        c.restore();
    }

    // Launcher: 4 centered Siri-style pill bars with a slow breath.
    drawMini(ts) {
        const c = this.mini2d;
        if (!c) return;
        c.clearRect(0, 0, 24, 24);
        const n = 4, barW = 3, gap = 2;
        const total = n * barW + (n - 1) * gap;
        const x0 = (24 - total) / 2;
        c.fillStyle = 'rgba(0,255,65,0.9)';
        for (let i = 0; i < n; i++) {
            const breath = REDUCED.matches ? 0.5 : 0.5 + 0.5 * Math.sin(ts / 700 + i * 0.9);
            const h = 5 + 9 * breath * (i === 1 || i === 2 ? 1 : 0.65);
            const x = x0 + i * (barW + gap);
            const y = 12 - h / 2;
            c.beginPath();
            if (c.roundRect) c.roundRect(x, y, barW, h, barW / 2);
            else c.rect(x, y, barW, h);
            c.fill();
        }
    }
}

// ---------- MOUNT ----------
function mount() {
    if (!window.customElements || document.querySelector('alex-voice-widget')) return;
    if (!customElements.get('alex-voice-widget')) {
        customElements.define('alex-voice-widget', AlexVoiceWidget);
    }
    document.body.appendChild(document.createElement('alex-voice-widget'));
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}

})();
