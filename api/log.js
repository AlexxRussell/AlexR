// POST /api/log — one-line client telemetry sink for the voice agent.
//
// The widget beacons a small counters-only payload when a call ends, so a
// visitor's bad session leaves evidence inside the runtime-log retention
// window (field incidents outlive the transcripts, not the other way round).
// Counters and short enums only — no message text ever reaches this endpoint.

import { checkAccess, rateLimit, readJson, sendJson } from "./_lib.js";

const BODY_CAP_BYTES = 2 * 1024;
const NUM_FIELDS = [
  "secs", "commits", "interrupts", "noiseDropped", "dgUttEnds", "dgFinals",
  "errors", "rateLimited", "ttsRequests", "sentencesSpoken", "chatChars",
];
const STR_FIELDS = ["mode", "reason", "sttEngine"];

export default async function handler(req, res) {
  if (!checkAccess(req, res)) return;
  if (!rateLimit(req, res, "log", 30, 5 * 60_000)) return;

  const body = await readJson(req, res, BODY_CAP_BYTES);
  if (body === null) return;
  if (typeof body !== "object" || Array.isArray(body)) {
    sendJson(res, 400, { error: "invalid_payload" });
    return;
  }

  const out = {};
  for (const f of NUM_FIELDS) {
    const v = body[f];
    if (typeof v === "number" && Number.isFinite(v)) out[f] = Math.round(v);
  }
  for (const f of STR_FIELDS) {
    const v = body[f];
    if (typeof v === "string" && v.length > 0) out[f] = v.slice(0, 24);
  }

  console.log(`client: call ended ${JSON.stringify(out)}`);
  res.statusCode = 204;
  res.end();
}
