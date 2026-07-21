// POST /api/chat — streaming LLM proxy for the voice agent.
//
// Client contract:
//   Request:  POST JSON { messages: [{ role: "user"|"assistant", content: string }, ...] }
//   Response: SSE (text/event-stream) with events:
//     data: {"d":"<text delta>"}   — visible text chunk
//     data: {"done":true}          — end of answer
//     data: {"error":"<message>"}  — upstream failure, stream ends after this
//
// Upstream: MiniMax OpenAI-compatible chat completions (MiniMax-M2.7).
// The model interleaves reasoning as <think>...</think> inside content;
// it is stripped here, statefully across chunk boundaries, before anything
// reaches the client.

import { MINIMAX_BASE, checkAccess, globalBudget, rateLimit, readJson, sendJson } from "./_lib.js";
import { SYSTEM_PROMPT } from "./_persona.js";

const MAX_MESSAGES = 16;
const MAX_CONTENT_CHARS = 1200;
const MAX_TOTAL_CHARS = 8000;
const BODY_CAP_BYTES = 32 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Stateful filter that removes <think>...</think> spans from a stream of
 * text chunks. Tag markers can be split across chunks at any position, so
 * any trailing text that could be the start of a marker is held back until
 * the next chunk decides it. Partial "<think" fragments never leak.
 */
export class ThinkFilter {
  constructor() {
    this.buf = "";
    this.inThink = false;
  }

  /** Length of the longest proper prefix of `token` that `s` ends with. */
  static #partialSuffix(s, token) {
    const max = Math.min(s.length, token.length - 1);
    for (let k = max; k > 0; k--) {
      if (s.endsWith(token.slice(0, k))) return k;
    }
    return 0;
  }

  /** Feed a chunk; returns the text that is now safe to emit. */
  push(chunk) {
    this.buf += chunk;
    let out = "";
    for (;;) {
      if (this.inThink) {
        const end = this.buf.indexOf("</think>");
        if (end === -1) {
          // Still inside the think block: discard everything except a
          // possible partial "</think>" at the tail.
          const keep = ThinkFilter.#partialSuffix(this.buf, "</think>");
          this.buf = keep > 0 ? this.buf.slice(this.buf.length - keep) : "";
          return out;
        }
        this.buf = this.buf.slice(end + "</think>".length);
        this.inThink = false;
      } else {
        const start = this.buf.indexOf("<think>");
        if (start === -1) {
          // Emit everything except a possible partial "<think>" at the tail.
          const keep = ThinkFilter.#partialSuffix(this.buf, "<think>");
          out += keep > 0 ? this.buf.slice(0, this.buf.length - keep) : this.buf;
          this.buf = keep > 0 ? this.buf.slice(this.buf.length - keep) : "";
          return out;
        }
        out += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + "<think>".length);
        this.inThink = true;
      }
    }
  }

  /**
   * Stream ended. Inside an unclosed think block everything is dropped.
   * A held-back partial marker ("<thin"…) is also dropped rather than
   * risk leaking tag syntax into spoken output.
   */
  flush() {
    this.buf = "";
    return "";
  }
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return null;
  }
  let total = 0;
  const clean = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") return null;
    if (m.role !== "user" && m.role !== "assistant") return null;
    if (typeof m.content !== "string" || m.content.length === 0) return null;
    if (m.content.length > MAX_CONTENT_CHARS) return null;
    total += m.content.length;
    if (total > MAX_TOTAL_CHARS) return null;
    clean.push({ role: m.role, content: m.content });
  }
  return clean;
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// The persona forbids em/en dashes, but models slip: swap any that get
// through for a comma so neither the transcript nor the TTS sees them.
export function deDash(s) {
  return s
    .replace(/\s*[—–]+\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/ {2,}/g, " ");
}

export default async function handler(req, res) {
  if (!checkAccess(req, res)) return;
  if (!rateLimit(req, res, "chat", 20, 5 * 60_000)) return;
  if (!globalBudget(res, "chat", 300, 60 * 60_000)) return;

  const body = await readJson(req, res, BODY_CAP_BYTES);
  if (body === null) return;

  const messages = validateMessages(body.messages);
  if (!messages) {
    sendJson(res, 400, { error: "invalid_messages" });
    return;
  }
  // Usage visibility: one line per turn makes conversation volume greppable
  // in the function logs without any client-side analytics weight.
  console.log(`chat: turn started (history ${messages.length})`);

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    console.error("chat: MINIMAX_API_KEY is not set");
    sendJson(res, 500, { error: "server_misconfigured" });
    return;
  }

  // Abort the upstream call if the client disconnects or we hit the timeout,
  // so credits stop burning the moment nobody is listening. The two aborts
  // must stay distinguishable: a timeout owes the still-connected client an
  // in-band error, a disconnect owes it nothing.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);
  res.on("close", () => controller.abort());

  // SSE headers go out before the upstream call; any later failure is
  // reported in-band as a {"error": ...} event.
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const endWithError = (message) => {
    sseWrite(res, { error: message });
    res.end();
  };

  try {
    const upstream = await fetch(`${MINIMAX_BASE}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "MiniMax-M2.7",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        stream: true,
        temperature: 0.8,
        // M2.7 interleaves hidden <think> reasoning in content and it spends
        // from THIS budget. 240 caused occasional mid-sentence truncation
        // (long think -> few tokens left for the visible answer, stream ends
        // cleanly at finish_reason=length). The persona keeps visible answers
        // short; the headroom is for the thinking.
        max_completion_tokens: 2048,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      console.error(`chat: upstream HTTP ${upstream.status}`);
      endWithError("upstream_error");
      return;
    }

    const filter = new ThinkFilter();
    let started = false; // set once real (non-whitespace) text has been sent
    let finishReason = null;
    const decoder = new TextDecoder();
    let sseBuf = "";

    // Upstream is OpenAI-style SSE: "data: {json}\n\n" frames, "[DONE]" last.
    for await (const chunk of upstream.body) {
      sseBuf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = sseBuf.indexOf("\n")) !== -1) {
        const line = sseBuf.slice(0, nl).replace(/\r$/, "");
        sseBuf = sseBuf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;

        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue; // tolerate malformed frames
        }
        if (event?.base_resp && event.base_resp.status_code !== 0) {
          console.error(
            `chat: upstream error code ${event.base_resp.status_code} trace ${event.trace_id || "n/a"}`
          );
          endWithError("upstream_error");
          return;
        }
        const fr = event?.choices?.[0]?.finish_reason;
        if (typeof fr === "string" && fr.length > 0) finishReason = fr;
        const delta = event?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          let visible = deDash(filter.push(delta));
          // The model leaves blank lines behind where its think block was;
          // swallow all leading whitespace until real text starts.
          if (!started && visible.length > 0) {
            visible = visible.replace(/^\s+/, "");
            if (visible.length > 0) started = true;
          }
          if (visible.length > 0) sseWrite(res, { d: visible });
        }
      }
    }

    let tail = deDash(filter.flush());
    if (!started) tail = tail.replace(/^\s+/, "");
    if (tail.length > 0) sseWrite(res, { d: tail });
    // A non-"stop" finish must never hide again: "length" means the visible
    // answer was truncated by the token budget (the mid-sentence-cutoff bug),
    // and an EOF with no finish_reason at all is an upstream that died early.
    // Both used to collapse into a clean {done:true} and the client showed a
    // fragment as a complete answer — done now carries cut:true so the
    // transcript can mark it visibly incomplete.
    const clean = finishReason === "stop";
    if (!clean) {
      if (finishReason) console.warn(`chat: finish_reason=${finishReason}`);
      else console.error("chat: upstream ended without finish_reason");
    }
    sseWrite(res, clean ? { done: true } : { done: true, cut: true });
    res.end();
  } catch (err) {
    if (controller.signal.aborted && !timedOut) {
      // Client went away — end quietly.
      try {
        res.end();
      } catch {
        /* already closed */
      }
    } else if (timedOut) {
      // Upstream stalled past the deadline with the client still waiting:
      // ending here without this event would read as a complete (empty)
      // answer and the visitor would get silence with no explanation.
      console.error("chat: upstream timeout");
      endWithError("upstream_timeout");
    } else {
      console.error(`chat: ${err?.name || "error"}`);
      endWithError("upstream_error");
    }
  } finally {
    clearTimeout(timer);
  }
}
