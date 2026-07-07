// POST /api/tts — streaming text-to-speech proxy for the voice agent.
//
// Client contract:
//   Request:  POST JSON { text: string }  (1..800 chars after trim)
//   Response: raw binary PCM streamed as it is synthesised
//     Content-Type:   application/octet-stream
//     X-Audio-Format: pcm;rate=24000;bits=16;channels=1
//   Errors before the first audio byte are JSON with a proper status code;
//   after audio has started, the stream simply ends early.
//
// Upstream: MiniMax T2A v2 (speech-2.8-turbo) SSE stream of hex audio chunks,
// decoded to bytes here and forwarded as they arrive.
//
// Billing: prefers MINIMAX_SUBSCRIPTION_KEY (prepaid Credits pool, spent via
// the Subscription Key) so voice burns credits, while /api/chat stays on
// MINIMAX_API_KEY (pay-as-you-go wallet). If the credits attempt fails before
// producing audio (exhausted credits, auth error, network error), the wallet
// key is tried.

import { MINIMAX_BASE, checkAccess, globalBudget, rateLimit, readJson, sendJson } from "./_lib.js";

const MAX_TEXT_CHARS = 800;
const BODY_CAP_BYTES = 8 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Defense in depth: the LLM prompt already forbids markdown, but strip any
 * residual markdown syntax and control characters before speaking them.
 */
export function sanitizeText(raw) {
  return raw
    .replace(/[*_#`~]/g, "")
    // Speech-normalize contacts: the persona writes them with real symbols
    // (me@alexrussell.io) so transcripts look right; audio needs the words.
    // Emails first (their domain loses its dots here, so the domain rule
    // below cannot double-process them).
    .replace(/([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g,
      (m, user, dom) => user + " at " + dom.replace(/\./g, " dot "))
    .replace(/\b((?:[A-Za-z0-9-]+\.)+(?:io|com|nz|ai|dev|org|net|co))\b(\/[A-Za-z0-9\-/]*)?/g,
      (m, dom, path) => dom.replace(/\./g, " dot ") +
        (path ? " slash " + path.slice(1).replace(/\//g, " slash ") : ""))
    .replace(/\s*[–—]+\s*/g, ", ") // persona forbids dashes; belt and braces
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export default async function handler(req, res) {
  if (!checkAccess(req, res)) return;
  if (!rateLimit(req, res, "tts", 60, 5 * 60_000)) return;
  if (!globalBudget(res, "tts", 900, 60 * 60_000)) return;

  const body = await readJson(req, res, BODY_CAP_BYTES);
  if (body === null) return;

  if (typeof body.text !== "string") {
    sendJson(res, 400, { error: "invalid_text" });
    return;
  }
  const text = sanitizeText(body.text);
  if (text.length < 1 || text.length > MAX_TEXT_CHARS) {
    sendJson(res, 400, { error: "invalid_text" });
    return;
  }

  const keys = [...new Set(
    [process.env.MINIMAX_SUBSCRIPTION_KEY, process.env.MINIMAX_API_KEY].filter(Boolean),
  )];
  if (keys.length === 0) {
    console.error("tts: neither MINIMAX_SUBSCRIPTION_KEY nor MINIMAX_API_KEY is set");
    sendJson(res, 500, { error: "server_misconfigured" });
    return;
  }

  // Abort upstream on client disconnect or timeout to save credits.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  res.on("close", () => controller.abort());

  let audioStarted = false;

  const failBeforeAudio = (status, message) => {
    if (!audioStarted) {
      sendJson(res, status, { error: message });
    } else {
      res.end();
    }
  };

  // One streaming attempt against one key. Returns "done" when a client
  // response was fully produced (success or terminal error), or "retry"
  // when nothing reached the client and the next key may be tried.
  // Thrown errors (fetch rejection, stream read failure) are the caller's
  // problem so they can also fall through to the next key.
  const attempt = async (key, keyTag, lastKey) => {
    const upstream = await fetch(`${MINIMAX_BASE}/v1/t2a_v2`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "speech-2.8-turbo",
        text,
        stream: true,
        stream_options: { exclude_aggregated_audio: true },
        language_boost: "auto",
        output_format: "hex",
        voice_setting: {
          voice_id: process.env.MINIMAX_VOICE_ID || "English_expressive_narrator",
          speed: 1,
          vol: 1,
          pitch: 0,
        },
        audio_setting: {
          sample_rate: 24000,
          format: "pcm",
          channel: 1,
        },
      }),
    });

    if (!upstream.ok || !upstream.body) {
      console.error(`tts: upstream HTTP ${upstream.status} (${keyTag})`);
      if (!lastKey) return "retry";
      failBeforeAudio(upstream.status === 429 ? 429 : 502, "upstream_error");
      return "done";
    }

    const decoder = new TextDecoder();
    let sseBuf = "";

    // Upstream SSE frames: data: {"data":{"audio":"<hex>","status":1},
    // "base_resp":{"status_code":0},...}; the final frame has status 2.
    for await (const chunk of upstream.body) {
      sseBuf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = sseBuf.indexOf("\n")) !== -1) {
        const line = sseBuf.slice(0, nl).replace(/\r$/, "");
        sseBuf = sseBuf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "") continue;

        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue; // tolerate malformed frames
        }

        const code = event?.base_resp?.status_code;
        if (code !== undefined && code !== 0) {
          console.error(`tts: upstream error code ${code} trace ${event.trace_id || "n/a"} (${keyTag})`);
          if (!lastKey && !audioStarted) {
            // Returning early cancels the upstream body stream.
            return "retry";
          }
          failBeforeAudio(code === 1002 || code === 1039 ? 429 : 502, "upstream_error");
          return "done";
        }

        const hex = event?.data?.audio;
        if (typeof hex === "string" && hex.length > 0) {
          const bytes = Buffer.from(hex, "hex");
          if (bytes.length === 0) continue;
          if (!audioStarted) {
            audioStarted = true;
            // Usage visibility: which billing pool served this call. When
            // "key 2/2" lines start appearing, the Credits pool has run dry
            // and voice is silently billing the wallet.
            console.log(`tts: audio started (${keyTag}, ${text.length} chars)`);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/octet-stream");
            res.setHeader("Cache-Control", "no-cache, no-transform");
            res.setHeader("X-Audio-Format", "pcm;rate=24000;bits=16;channels=1");
            if (typeof res.flushHeaders === "function") res.flushHeaders();
          }
          res.write(bytes);
        }
        // event?.data?.status === 2 marks the final frame; the upstream
        // stream closes right after, so the read loop ends naturally.
      }
    }

    if (!audioStarted) {
      // Stream ended without producing any audio.
      console.error(`tts: upstream stream ended with no audio (${keyTag})`);
      if (!lastKey) return "retry";
      sendJson(res, 502, { error: "upstream_error" });
      return "done";
    }
    res.end();
    return "done";
  };

  try {
    // Credits pool first, wallet second.
    for (let k = 0; k < keys.length; k++) {
      const keyTag = `key ${k + 1}/${keys.length}`;
      const lastKey = k === keys.length - 1;
      let outcome;
      try {
        outcome = await attempt(keys[k], keyTag, lastKey);
      } catch (err) {
        if (controller.signal.aborted || audioStarted) {
          // Client gone, timeout fired, or the stream broke mid-audio:
          // nothing useful left to send.
          try {
            res.end();
          } catch {
            /* already closed */
          }
          return;
        }
        console.error(`tts: ${err?.name || "error"} (${keyTag})`);
        if (lastKey) {
          failBeforeAudio(502, "upstream_error");
          return;
        }
        outcome = "retry"; // thrown before audio: the next key may still work
      }
      if (outcome === "done") return;
    }
  } finally {
    clearTimeout(timer);
  }
}
