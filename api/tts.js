// POST /api/tts — streaming text-to-speech proxy for the voice agent.
//
// Client contract:
//   Request:  POST JSON { text: string }  (1..800 chars after trim)
//   Response: raw binary PCM streamed as it is synthesised
//     Content-Type:   application/octet-stream
//     X-Audio-Format: pcm;rate=24000;bits=16;channels=1
//   Errors before the first audio byte are JSON with a proper status code;
//   after audio has started, a failure closes the connection abnormally so
//   the client can tell a broken clip from a complete one.
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

const MAX_TEXT_CHARS = 800;      // client contract, measured on the raw text
// Headroom for digits expanding into words, sized just under MiniMax's 10,000
// limit. The raw contract above is the real gate; this only stops an absurd
// payload reaching upstream, so it is deliberately loose — a reply that merely
// quotes several prices must never be rejected here and go silent.
const MAX_SPOKEN_CHARS = 9500;
const BODY_CAP_BYTES = 8 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;

// ---- Number speech normalization ------------------------------------------
// The persona writes numbers as digits so transcripts read like a pricing page
// ($2,950, 71%, 5 working days); speech needs the words. The reading depends on
// the kind of number: money and counts are cardinals, but a bare four-digit
// year is said in pairs ("twenty twenty six", never "two thousand twenty six").
const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function under1000(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
  return ONES[Math.floor(n / 100)] + " hundred" + (n % 100 ? " " + under1000(n % 100) : "");
}

function cardinal(n) {
  if (n === 0) return "zero";
  const parts = [];
  for (const [value, name] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]]) {
    if (n >= value) {
      parts.push(under1000(Math.floor(n / value)) + " " + name);
      n %= value;
    }
  }
  if (n) parts.push(under1000(n));
  return parts.join(" ");
}

// 2026 → "twenty twenty six", 2000 → "two thousand", 1900 → "nineteen hundred".
function yearWords(n) {
  if (n % 1000 === 0) return cardinal(n);
  if (n >= 2000 && n < 2010) return cardinal(n);
  if (n % 100 === 0) return under1000(Math.floor(n / 100)) + " hundred";
  const lo = n % 100;
  return under1000(Math.floor(n / 100)) + " "
    + (lo < 10 ? "oh " + ONES[lo] : under1000(lo));
}

// A standalone figure, optionally money, decimal, or a percentage. The
// lookaround keeps digits welded to letters out of it (GA4, 1st, 16GB) so only
// free-standing numbers convert, and leaves any digit inside an already
// spoken-out URL path alone.
// The ",\d" and "\.\d" arms of the lookahead stop the number branches
// backtracking into a longer figure whose tail is welded to letters. Without
// them the optional groups are simply dropped and only the head converts:
// "2,950kg" speaks as "two,950kg" and "2.5kg" as "two.5kg".
const NUMBER_RE =
  /(?<![A-Za-z0-9.,])(\$)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(%)?(?![A-Za-z0-9]|[.,]\d)/g;

function speakNumbers(t) {
  return t
    // Digit ranges read as a span, not a pause: "7-14" → "7 to 14". Must run
    // before the generic dash rule below turns it into a comma.
    .replace(/(\d)\s*[-–—]\s*(\d)/g, "$1 to $2")
    .replace(NUMBER_RE, (match, dollar, intPart, frac, pct) => {
      const n = parseInt(intPart.replace(/,/g, ""), 10);
      // cardinal() only names groups through billions; anything larger would
      // spell "undefined hundred billion", so leave it for the engine.
      if (!Number.isFinite(n) || n >= 1e12) return match;

      // Money with cents is said as dollars-then-cents, never "point five zero
      // dollars". A bare ".5" is 50 cents, ".05" is 5. More than two decimals
      // is not a price, and silently truncating it would speak a wrong amount
      // ("$1.999" as "one dollar ninety nine"), so leave it for the engine.
      if (dollar && frac) {
        if (frac.length > 2) return match;
        const cents = parseInt(frac.padEnd(2, "0"), 10);
        return cardinal(n) + (n === 1 ? " dollar" : " dollars")
          + (cents ? " " + cardinal(cents) : "");
      }

      let words;
      if (frac) words = cardinal(n) + " point " + frac.split("").map((d) => ONES[+d]).join(" ");
      // Grouped thousands ("1,200 hours") are a quantity, never a year.
      else if (!dollar && !pct && !intPart.includes(",")
               && intPart.length === 4 && n >= 1900 && n <= 2099) words = yearWords(n);
      else words = cardinal(n);
      if (dollar) words += n === 1 ? " dollar" : " dollars";
      if (pct) words += " percent";
      return words;
    });
}

/**
 * Defense in depth: the LLM prompt already forbids markdown, but strip any
 * residual markdown syntax and control characters before speaking them.
 */
export function sanitizeText(raw) {
  const spokenAddresses = raw
    .replace(/[*_#`~]/g, "")
    // Speech-normalize contacts: the persona writes them with real symbols
    // (me@alexrussell.io) so transcripts look right; audio needs the words —
    // including "dash" for hyphens, or alexrussell-tech reads as two words
    // with a silent, unwriteable gap. Emails first (their domain loses its
    // dots here, so the domain rule below cannot double-process them).
    .replace(/([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g,
      (m, user, dom) => user.replace(/-/g, " dash ") + " at " +
        dom.replace(/\./g, " dot ").replace(/-/g, " dash "))
    .replace(/\b((?:[A-Za-z0-9-]+\.)+(?:io|com|nz|ai|dev|org|net|co))\b(\/[A-Za-z0-9\-/]*)?/g,
      (m, dom, path) => dom.replace(/\./g, " dot ").replace(/-/g, " dash ") +
        (path ? " slash " + path.slice(1).replace(/\//g, " slash ").replace(/-/g, " dash ") : ""));
  return speakNumbers(spokenAddresses)
    // Grades and languages are written as A+ and C++; say the symbol. The
    // lookbehind accepts a preceding + so the second one in C++ also converts.
    .replace(/(?<=[A-Za-z0-9+])\+/g, " plus ")
    .replace(/\s*[–—]+\s*/g, ", ") // persona forbids dashes; belt and braces
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    // Expanded symbols leave a space before whatever punctuation followed them
    // ("A+," → "A plus ,"), which reads as an extra beat.
    .replace(/ +([,.;:!?])/g, "$1")
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
  // The 800-char contract is measured on the raw text the client sent; the
  // sanitized form is checked separately and loosely, because spelling numbers
  // out expands it (a "$9,500" of 6 chars speaks as 33) and a sentence that
  // merely quotes a few prices must not fail the size check and go silent.
  const rawLen = body.text.trim().length;
  if (rawLen < 1 || rawLen > MAX_TEXT_CHARS) {
    sendJson(res, 400, { error: "invalid_text" });
    return;
  }
  const text = sanitizeText(body.text);
  if (text.length < 1 || text.length > MAX_SPOKEN_CHARS) {
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

  // Abort upstream on client disconnect or timeout to save credits. Keep the
  // two distinguishable: a timeout before any audio owes the still-connected
  // client a real error status (a bare 200 with no body would read as a
  // successful, silent reply and the widget would never flag it).
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);
  res.on("close", () => controller.abort());

  let audioStarted = false;

  // Before the first audio byte a failure is a JSON error with a status.
  // After it, the body is raw PCM with no framing left to carry an error —
  // the only honest signal is an abnormal close, so the client's reader
  // rejects and the widget marks the sentence failed. res.end() here used
  // to make every mid-stream upstream failure look like a complete clip.
  const failStream = (status, message) => {
    if (!audioStarted) {
      sendJson(res, status, { error: message });
    } else {
      try { res.destroy(); } catch { /* already closed */ }
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
      failStream(upstream.status === 429 ? 429 : 502, "upstream_error");
      return "done";
    }

    const decoder = new TextDecoder();
    let sseBuf = "";
    let sawFinal = false;

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
          failStream(code === 1002 || code === 1039 ? 429 : 502, "upstream_error");
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
        // status 2 marks the final frame; the upstream stream closes right
        // after. Tracked so an EOF WITHOUT it is known to be a broken clip.
        if (event?.data?.status === 2) sawFinal = true;
      }
    }

    if (!audioStarted) {
      // Stream ended without producing any audio.
      console.error(`tts: upstream stream ended with no audio (${keyTag})`);
      if (!lastKey) return "retry";
      sendJson(res, 502, { error: "upstream_error" });
      return "done";
    }
    if (!sawFinal) {
      // Audio flowed but the terminal frame never came: the clip is cut.
      console.error(`tts: upstream ended without final frame (${keyTag})`);
      try { res.destroy(); } catch { /* already closed */ }
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
        if (timedOut && !audioStarted) {
          // Upstream stalled before producing any audio; the client is
          // still waiting and must see a failure, not an empty success.
          console.error(`tts: upstream timeout (${keyTag})`);
          failStream(504, "upstream_timeout");
          return;
        }
        if (controller.signal.aborted || audioStarted) {
          // Client gone, or the stream broke mid-audio. Mid-audio breaks
          // close abnormally so the widget's reader rejects and marks the
          // sentence failed — a clean end() here read as a complete clip.
          try {
            if (audioStarted) res.destroy();
            else res.end();
          } catch {
            /* already closed */
          }
          return;
        }
        console.error(`tts: ${err?.name || "error"} (${keyTag})`);
        if (lastKey) {
          failStream(502, "upstream_error");
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
