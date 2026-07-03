/*
 * PIXEL ALEX — an 8-bit resident of alexrussell.io.
 *
 * A tiny sprite of Alexander lives on the page. He stands on real page
 * elements (headings, panels, cards, the footer), and when the visitor
 * scrolls he parkours to stay in view: running along ledges, leaping
 * gaps, dropping with a tucked jump, mantling up over headings when the
 * visitor scrolls back up. If a move is out of range he de-rezzes and
 * blips back in like a proper video game character.
 *
 * He is aware of the visitor: his eyes follow the cursor, he turns to
 * face it when it comes near, steps aside if it gets too close, and
 * waves back at a cursor that lingers. He watches the page too — he
 * inspects the terminal panel, cheers when the contact protocol runs,
 * wanders and hops between nearby ledges while idling, and sits on
 * edges when left alone.
 *
 * Follow logic is scroll-velocity aware: the comfort band is computed
 * against a projected scroll position, soft states (wave, sit, land)
 * cancel instantly when the visitor moves on, hop chains sprint with
 * short landings while catching up, and anything unreachable in time
 * de-rezzes straight to where the visitor is. The aim: he should
 * never be off screen for more than a beat.
 *
 * Everything is self contained: sprites are hand-authored pixel maps
 * baked once to offscreen canvases, physics is a rAF loop on one small
 * transformed canvas (render-throttled while deeply idle). No
 * libraries, no layout impact (position:absolute + pointer-events:
 * none), aria-hidden, and it never initialises under
 * prefers-reduced-motion or below 420px width (intentional: no phone
 * mode).
 *
 * Debug: append ?alexdebug to the URL to see the sprite sheet, the
 * platform map, and window.__alex().
 */
(function () {
  "use strict";

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (innerWidth < 420) return; // too narrow for parkour to read well

  /* ------------------------------------------------------------------ *
   * 1. SPRITES
   * ------------------------------------------------------------------ */

  var PAL = {
    k: "#0c1016", // outline
    h: "#8a6a45", // hair
    H: "#a8845c", // hair highlight
    s: "#eab894", // skin
    S: "#cf9873", // skin shadow
    e: "#20304a", // eyes
    g: "#1d3242", // hoodie
    G: "#152633", // hoodie shade / sleeves
    z: "#00e05a", // zip + accents (terminal green)
    d: "#2f4166", // denim
    D: "#243350", // denim shade
    w: "#e8edf3", // shoe
    W: "#8f9aa8", // sole
  };

  // Every frame is 20 wide x 26 tall. "." = transparent.
  var FRAMES = {
    // ---- front-facing -------------------------------------------------
    idleA: [
      "....................",
      "......kkkkkkkk......",
      ".....khhHHHHhhk.....",
      ".....khHhhhhhhk.....",
      ".....khhhhhhhhk.....",
      ".....khsssssshk.....",
      ".....kssessessk.....",
      ".....kSssssssSk.....",
      "......kssssssk......",
      "........kssk........",
      "......kggggggk......",
      ".....kGggggggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....ksGGzzGGsk.....",
      "......kGGGGGGk......",
      "......kddkkddk......",
      "......kddkkddk......",
      "......kDdkkdDk......",
      "......kDdkkdDk......",
      "......kddkkddk......",
      "......kwwkkwwk......",
      "......kWWkkWWk......",
      "....................",
    ],
    // breathing: torso row lifts, head bobs down one
    idleB: [
      "....................",
      "....................",
      "......kkkkkkkk......",
      ".....khhHHHHhhk.....",
      ".....khHhhhhhhk.....",
      ".....khhhhhhhhk.....",
      ".....khsssssshk.....",
      ".....kssessessk.....",
      ".....kSssssssSk.....",
      "......kssssssk......",
      "......kggggggk......",
      ".....kGggggggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....ksGGzzGGsk.....",
      "......kGGGGGGk......",
      "......kddkkddk......",
      "......kddkkddk......",
      "......kDdkkdDk......",
      "......kDdkkdDk......",
      "......kddkkddk......",
      "......kwwkkwwk......",
      "......kWWkkWWk......",
      "....................",
    ],
    blink: [
      "....................",
      "......kkkkkkkk......",
      ".....khhHHHHhhk.....",
      ".....khHhhhhhhk.....",
      ".....khhhhhhhhk.....",
      ".....khsssssshk.....",
      ".....kssSssSssk.....",
      ".....kSssssssSk.....",
      "......kssssssk......",
      "........kssk........",
      "......kggggggk......",
      ".....kGggggggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....ksGGzzGGsk.....",
      "......kGGGGGGk......",
      "......kddkkddk......",
      "......kddkkddk......",
      "......kDdkkdDk......",
      "......kDdkkdDk......",
      "......kddkkddk......",
      "......kwwkkwwk......",
      "......kWWkkWWk......",
      "....................",
    ],
    waveA: [
      "....................",
      "......kkkkkkkk..ks..",
      ".....khhHHHHhhk.ksk.",
      ".....khHhhhhhhk.kGk.",
      ".....khhhhhhhhk.kGk.",
      ".....khsssssshk.kGk.",
      ".....kssessessk.kGk.",
      ".....kSssssssSkkGk..",
      "......kssssssk.kGk..",
      "........kssk..kGk...",
      "......kggggggkkGk...",
      ".....kGgggggggGk....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....ksGGzzGGk......",
      "......kGGGGGGk......",
      "......kddkkddk......",
      "......kddkkddk......",
      "......kDdkkdDk......",
      "......kDdkkdDk......",
      "......kddkkddk......",
      "......kwwkkwwk......",
      "......kWWkkWWk......",
      "....................",
    ],
    waveB: [
      "....................",
      "......kkkkkkkk......",
      ".....khhHHHHhhk.ks..",
      ".....khHhhhhhhk.ksk.",
      ".....khhhhhhhhk.kGk.",
      ".....khsssssshk.kGk.",
      ".....kssessesskkGk..",
      ".....kSssssssSkkGk..",
      "......kssssssk.kGk..",
      "........kssk..kGk...",
      "......kggggggkkGk...",
      ".....kGgggggggGk....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....ksGGzzGGk......",
      "......kGGGGGGk......",
      "......kddkkddk......",
      "......kddkkddk......",
      "......kDdkkdDk......",
      "......kDdkkdDk......",
      "......kddkkddk......",
      "......kwwkkwwk......",
      "......kWWkkWWk......",
      "....................",
    ],
    // presenting: arm extended toward the content he is highlighting
    pointA: [
      "....................",
      "......kkkkkkkk......",
      ".....khhHHHHhhk.....",
      ".....khHhhhhhhk.....",
      ".....khhhhhhhhk.....",
      ".....khsssssshk.....",
      ".....kssessessk.....",
      ".....kSssssssSk.....",
      "......kssssssk......",
      "........kssk........",
      "......kggggggk......",
      ".....kGggggggGkkkk..",
      ".....kGggzzggGGGGsk.",
      ".....kGggzzggGkkkk..",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....ksGGzzGGk......",
      "......kGGGGGGk......",
      "......kddkkddk......",
      "......kddkkddk......",
      "......kDdkkdDk......",
      "......kDdkkdDk......",
      "......kddkkddk......",
      "......kwwkkwwk......",
      "......kWWkkWWk......",
      "....................",
    ],
    pointB: [
      "....................",
      "......kkkkkkkk......",
      ".....khhHHHHhhk.....",
      ".....khHhhhhhhk.....",
      ".....khhhhhhhhk.....",
      ".....khsssssshk.....",
      ".....kssessessk.....",
      ".....kSssssssSk.....",
      "......kssssssk......",
      "........kssk........",
      "......kggggggk......",
      ".....kGggggggGk.....",
      ".....kGggzzggGkkkk..",
      ".....kGggzzggGGGGsk.",
      ".....kGggzzggGkkkk..",
      ".....kGggzzggGk.....",
      ".....ksGGzzGGk......",
      "......kGGGGGGk......",
      "......kddkkddk......",
      "......kddkkddk......",
      "......kDdkkdDk......",
      "......kDdkkdDk......",
      "......kddkkddk......",
      "......kwwkkwwk......",
      "......kWWkkWWk......",
      "....................",
    ],
    // sitting on a ledge, legs dangling over the edge
    sit: [
      "....................",
      "....................",
      "....................",
      "....................",
      "....................",
      "......kkkkkkkk......",
      ".....khhHHHHhhk.....",
      ".....khHhhhhhhk.....",
      ".....khhhhhhhhk.....",
      ".....khsssssshk.....",
      ".....kssessessk.....",
      ".....kSssssssSk.....",
      "......kssssssk......",
      "........kssk........",
      "......kggggggk......",
      ".....kGggggggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....ksGgzzgGsk.....",
      "......kddddddk......",
      "......kddkkddk......",
      "......kDdkkdDk......",
      "......kddkkddk......",
      "......kwwkkwwk......",
      "......kWWkkWWk......",
      "....................",
    ],
    // ---- side view, facing right (left is mirrored at build time) -----
    runA: [
      "....................",
      ".......kkkkkk.......",
      "......khhhhhhk......",
      "......khhHHhhhk.....",
      "......khhhhhhhk.....",
      "......khhssssk......",
      "......khhssesk......",
      "......khSssssk......",
      ".......kssssk.......",
      "........kssk........",
      ".......kggggk.......",
      "......kgggggGk......",
      "......kgGGggzk......",
      "......kgGGggzk......",
      "......kggGsgk.......",
      ".......kgggk........",
      ".......kdddk........",
      "......kdddddk.......",
      ".....kddk.kddk......",
      "....kDdk...kdDk.....",
      "....kdk.....kddk....",
      "...kwwk......kwwk...",
      "...kWWk......kWWk...",
      "....................",
      "....................",
      "....................",
    ],
    runB: [
      "....................",
      "....................",
      ".......kkkkkk.......",
      "......khhhhhhk......",
      "......khhHHhhhk.....",
      "......khhhhhhhk.....",
      "......khhssssk......",
      "......khhssesk......",
      "......khSssssk......",
      ".......kssssk.......",
      "........kssk........",
      ".......kggggk.......",
      "......kgggggGk......",
      "......kgGGggzk......",
      "......kgGGggzk......",
      "......kggGsgk.......",
      ".......kgggk........",
      ".......kdddk........",
      ".......kdddk........",
      ".......kddk.........",
      ".......kddk.........",
      "......kwwkdk........",
      "......kWWkwwk.......",
      "..........kWk.......",
      "....................",
      "....................",
    ],
    runC: [
      "....................",
      ".......kkkkkk.......",
      "......khhhhhhk......",
      "......khhHHhhhk.....",
      "......khhhhhhhk.....",
      "......khhssssk......",
      "......khhssesk......",
      "......khSssssk......",
      ".......kssssk.......",
      "........kssk........",
      ".......kggggk.......",
      "......kgggggGk......",
      "......kgGGggzk......",
      "......kgGGggzk......",
      "......kggGsgk.......",
      ".......kgggk........",
      ".......kdddk........",
      "......kdddddk.......",
      "......kdk.kddk......",
      ".....kdk...kdDk.....",
      "....kddk....kdk.....",
      "....kwwk....kwwk....",
      "....kWWk....kWWk....",
      "....................",
      "....................",
      "....................",
    ],
    runD: [
      "....................",
      "....................",
      ".......kkkkkk.......",
      "......khhhhhhk......",
      "......khhHHhhhk.....",
      "......khhhhhhhk.....",
      "......khhssssk......",
      "......khhssesk......",
      "......khSssssk......",
      ".......kssssk.......",
      "........kssk........",
      ".......kggggk.......",
      "......kgggggGk......",
      "......kgGGggzk......",
      "......kgGGggzk......",
      "......kggGsgk.......",
      ".......kgggk........",
      ".......kdddk........",
      ".......kdddk........",
      "........kddk........",
      "........kddk........",
      ".......kdkwwk.......",
      "......kwwkWWk.......",
      "......kWWk..........",
      "....................",
      "....................",
    ],
    jump: [
      "....................",
      "....................",
      ".......kkkkkk.......",
      "......khhhhhhk......",
      "......khhHHhhhk.....",
      "......khhhhhhhk.....",
      "......khhssssk......",
      "......khhssesk......",
      "......khSssssk......",
      ".......kssssk.......",
      "........kssk........",
      ".....kskggggk.......",
      ".....kskgggggGk.....",
      "......kgGGggzk......",
      "......kgGGggzk......",
      ".......kgggk........",
      ".......kdddddk......",
      "......kddkkddk......",
      "......kddk.kdk......",
      "......kwwk.kwwk.....",
      "......kWWk.kWWk.....",
      "....................",
      "....................",
      "....................",
      "....................",
      "....................",
    ],
    fall: [
      "....................",
      ".....ks.kkkkkk.ks...",
      ".....kskhhhhhhkksk..",
      ".....kGkhhHHhhhkGk..",
      ".....kGkhhhhhhhkGk..",
      "......kGhhsssskGk...",
      "......kGhhssesGk....",
      "......khSssssk......",
      ".......kssssk.......",
      "........kssk........",
      ".......kggggk.......",
      "......kgggggggk.....",
      "......kgGGggzgk.....",
      "......kgGGggzgk.....",
      ".......kggggk.......",
      ".......kdddk........",
      "......kdddddk.......",
      "......kddkddk.......",
      ".....kddk.kddk......",
      ".....kdk...kdk......",
      "....kwwk...kwwk.....",
      "....kWWk...kWWk.....",
      "....................",
      "....................",
      "....................",
      "....................",
    ],
    land: [
      "....................",
      "....................",
      "....................",
      "....................",
      "....................",
      "....................",
      ".......kkkkkk.......",
      "......khhhhhhk......",
      "......khhHHhhhk.....",
      "......khhhhhhhk.....",
      "......khhssssk......",
      "......khhssesk......",
      "......khSssssk......",
      ".......kssssk.......",
      "........kssk........",
      ".....kskggggksk.....",
      ".....kGkgggggGk.....",
      "......kgGGggzk......",
      ".......kggggk.......",
      "......kddddddk......",
      ".....kddkkkkddk.....",
      "....kddk....kddk....",
      "....kwwk....kwwk....",
      "....kWWk....kWWk....",
      "....................",
      "....................",
    ],
    // mantling a ledge: hands up on the lip, then knee over
    climbA: [
      "....................",
      ".....ks....ks.......",
      ".....ksk...ksk......",
      ".....kGk...kGk......",
      ".....kGkkkkkGk......",
      ".....kGhhhhhGk......",
      ".....khhHHhhhk......",
      "......khhhhhhhk.....",
      "......khhssssk......",
      "......khhssesk......",
      "......khSssssk......",
      ".......kssssk.......",
      "........kssk........",
      ".......kggggk.......",
      "......kggggggk......",
      "......kgGGggzk......",
      "......kgGGggzk......",
      ".......kggggk.......",
      ".......kdddk........",
      ".......kdddk........",
      "......kddkddk.......",
      "......kdk.kdk.......",
      "......kwwkkwwk......",
      "......kWWkkWWk......",
      "....................",
      "....................",
    ],
    climbB: [
      "....................",
      "....................",
      "....................",
      ".......kkkkkk.......",
      "......khhhhhhk......",
      "......khhHHhhhk.....",
      "......khhhhhhhk.....",
      "......khhssssk......",
      "......khhssesk......",
      "......khSssssk......",
      ".....ks.kssssk.ks...",
      ".....kskkssk..ksk...",
      ".....kGkggggk.kGk...",
      ".....kGgggggggGk....",
      "......kgGGggzk......",
      "......kgGGggzk......",
      ".......kggggk.......",
      "......kdddddk.......",
      "......kddkkdddk.....",
      "......kdk..kddk.....",
      "......kwwk..kwwk....",
      "......kWWk..kWWk....",
      "....................",
      "....................",
      "....................",
      "....................",
    ],
  };

  var SW = 20, // sprite grid width
    SH = 26; // sprite grid height

  function bakeFrame(rows, flip) {
    var c = document.createElement("canvas");
    c.width = SW;
    c.height = SH;
    var x2 = c.getContext("2d");
    for (var y = 0; y < SH; y++) {
      var row = rows[y] || "";
      for (var x = 0; x < SW; x++) {
        var ch = row[x];
        if (!ch || ch === ".") continue;
        var col = PAL[ch];
        if (!col) continue;
        x2.fillStyle = col;
        x2.fillRect(flip ? SW - 1 - x : x, y, 1, 1);
      }
    }
    return c;
  }

  var SPRITES = { R: {}, L: {} };
  for (var name in FRAMES) {
    SPRITES.R[name] = bakeFrame(FRAMES[name], false);
    SPRITES.L[name] = bakeFrame(FRAMES[name], true);
  }

  // eye row per front-facing frame (eyes sit at x=8 and x=11 in both
  // the right and mirrored bake, the faces being symmetric); used by
  // the cursor-gaze overlay in render()
  var EYE_ROW = { idleA: 6, idleB: 7, waveA: 6, waveB: 6, pointA: 6, pointB: 6, sit: 10 };

  /* ------------------------------------------------------------------ *
   * 2. STAGE
   * ------------------------------------------------------------------ */

  var SCALE = innerWidth < 640 ? 2 : 3;
  var CW = SW * SCALE,
    CH = SH * SCALE;

  var canvas = document.createElement("canvas");
  canvas.id = "pixel-alex";
  canvas.width = SW;
  canvas.height = SH;
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText =
    "position:absolute;left:0;top:0;width:" +
    CW +
    "px;height:" +
    CH +
    "px;z-index:45;pointer-events:none;image-rendering:pixelated;image-rendering:crisp-edges;will-change:transform;opacity:0;transition:none;";
  var ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  var MODE_KEY = "pixel-alex-mode";
  var canvasMounted = false;
  var enabled = false;
  var toggleButton = null;

  var DEBUG = /[?&]alexdebug/.test(location.search);
  var debugLayer = null;
  if (DEBUG) window.__alex = function () { return alex; };

  /* ------------------------------------------------------------------ *
   * 3. INPUT AWARENESS — scroll velocity and the cursor
   * ------------------------------------------------------------------ */

  var scrollVel = 0; // px/s, smoothed, + is down
  var lastScrollY = scrollY;
  var lastScrollAt = 0; // performance.now() ms of last real scroll
  var cursor = { cx: -9999, cy: -9999, movedAt: -1e9 };

  addEventListener(
    "pointermove",
    function (e) {
      cursor.cx = e.clientX;
      cursor.cy = e.clientY;
      cursor.movedAt = performance.now();
    },
    { passive: true }
  );

  document.addEventListener(
    "click",
    function (e) {
      if (
        !enabled ||
        !(
          alex.state === "idle" ||
          alex.state === "run" ||
          alex.state === "wave" ||
          alex.state === "sit" ||
          alex.state === "present" ||
          alex.state === "inspect" ||
          alex.state === "land"
        )
      ) {
        return;
      }
      var cx = e.clientX + scrollX;
      var cy = e.clientY + scrollY;
      var r = canvas.getBoundingClientRect();
      var x1 = r.left + scrollX - 6;
      var x2 = r.right + scrollX + 6;
      var y1 = r.top + scrollY - 6;
      var y2 = r.bottom + scrollY + 6;
      if (cx < x1 || cx > x2 || cy < y1 || cy > y2) return;
      alex.dir = cx >= alex.x ? 1 : -1;
      alex.hops = 1;
      alex.vy = -380;
      setState("cheer");
      for (var i = 0; i < 3; i++) {
        alex.dust.push({
          x: alex.x + (Math.random() * 14 - 7),
          y: alex.y - 8 - Math.random() * 10,
          vx: Math.random() * 50 - 25,
          vy: -40 - Math.random() * 70,
          t: 0,
          c: PAL.z,
        });
      }
    },
    { passive: true }
  );

  function cursorDocX() {
    return cursor.cx + scrollX;
  }
  function cursorDocY() {
    return cursor.cy + scrollY;
  }
  function cursorRecent(ms) {
    return performance.now() - cursor.movedAt < (ms || 4000);
  }
  function scrollingHard() {
    return Math.abs(scrollVel) > 700 || performance.now() - lastScrollAt < 250;
  }

  // where the viewport will roughly be in ~250ms, so he starts moving
  // before the visitor has fully scrolled past him
  function projScrollY() {
    var v = Math.max(-2400, Math.min(2400, scrollVel));
    return scrollY + v * 0.25;
  }

  /* ------------------------------------------------------------------ *
   * 4. PLATFORMS — real page elements the sprite can stand on
   * ------------------------------------------------------------------ */

  var PLATFORM_SELECTOR =
    "h1, h2, h3, #ghost-code-window, #wf-btn, #node1, #node2, #node3, footer, " +
    ".skill-category, .timeline-content, .project-bubble, .cert-card, .glass-panel, .job-block, img";
  var TEXT_SELECTOR =
    "p, li, h1, h2, h3, h4, dd, blockquote, figcaption, a, button, .project-bubble-desc";

  var platforms = [];

  function kindOf(el) {
    if (el.id === "ghost-code-window") return "code";
    if (el.id === "wf-btn") return "button";
    if (/^node\d$/.test(el.id)) return "node";
    if (el.tagName === "FOOTER") return "footer";
    if (/^H[123]$/.test(el.tagName)) return el.tagName.toLowerCase();
    if (el.tagName === "IMG") return "img";
    return "card";
  }

  function isHeadingKind(kind) {
    return kind === "h1" || kind === "h2" || kind === "h3";
  }

  function subtractInterval(intervals, a, b) {
    var next = [];
    for (var i = 0; i < intervals.length; i++) {
      var iv = intervals[i];
      if (b <= iv[0] || a >= iv[1]) {
        next.push(iv);
      } else {
        if (a > iv[0]) next.push([iv[0], Math.min(a, iv[1])]);
        if (b < iv[1]) next.push([Math.max(b, iv[0]), iv[1]]);
      }
    }
    return next;
  }

  function cleanIntervals(intervals) {
    var next = [];
    for (var i = 0; i < intervals.length; i++) {
      if (intervals[i][1] - intervals[i][0] >= 10) next.push(intervals[i]);
    }
    return next;
  }

  function inIntervals(p, x, pad) {
    if (!p.iv || !p.iv.length) return false;
    var ex = pad || 0;
    for (var i = 0; i < p.iv.length; i++) {
      if (x >= p.iv[i][0] - ex && x <= p.iv[i][1] + ex) return true;
    }
    return false;
  }

  function buildPlatforms() {
    var next = [];
    var els = document.querySelectorAll(PLATFORM_SELECTOR);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest("#sticky-nav")) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 8) continue;
      next.push({
        el: el,
        kind: kindOf(el),
        x1: r.left + scrollX,
        x2: r.right + scrollX,
        y: r.top + scrollY,
      });
    }
    var textRects = [];
    var textEls = document.querySelectorAll(TEXT_SELECTOR);
    for (var t = 0; t < textEls.length; t++) {
      var tel = textEls[t];
      if (tel.closest("#sticky-nav")) continue;
      if (!tel.textContent || !tel.textContent.trim()) continue;
      var tr = tel.getBoundingClientRect();
      if (tr.width <= 0 || tr.height <= 0) continue;
      textRects.push({
        x1: tr.left + scrollX,
        x2: tr.right + scrollX,
        y1: tr.top + scrollY,
        y2: tr.bottom + scrollY,
      });
    }
    for (var n = next.length - 1; n >= 0; n--) {
      var np = next[n];
      var ivs = [[np.x1 + 14, np.x2 - 14]];
      var z1 = np.y - CH - 8;
      var z2 = np.y - 2;
      for (var ri = 0; ri < textRects.length; ri++) {
        var rr = textRects[ri];
        if (rr.y2 <= z1 || rr.y1 >= z2) continue;
        ivs = subtractInterval(ivs, rr.x1 - CW / 2 - 4, rr.x2 + CW / 2 + 4);
        if (!ivs.length) break;
      }
      np.iv = cleanIntervals(ivs);
      if (!np.iv.length) next.splice(n, 1);
    }
    next.sort(function (a, b) {
      return a.y - b.y;
    });
    // drop near-duplicate ledges (a card whose top hugs its parent's):
    // they add nothing and make target scoring jittery
    platforms = [];
    for (var j = 0; j < next.length; j++) {
      var p = next[j];
      var dup = false;
      for (var k = platforms.length - 1; k >= 0 && p.y - platforms[k].y < 14; k--) {
        var q = platforms[k];
        var overlap = Math.min(p.x2, q.x2) - Math.max(p.x1, q.x1);
        if (overlap > 0.8 * (p.x2 - p.x1)) {
          dup = true;
          break;
        }
      }
      if (!dup) platforms.push(p);
    }
    // keep his references pointing at live objects after a rebuild
    if (alex.platform) alex.platform = remap(alex.platform);
    if (alex.target) alex.target = remap(alex.target);
    if (alex.afterBlip) alex.afterBlip = remap(alex.afterBlip);
    if (alex.anchor) alex.anchor = remap(alex.anchor);
    if (DEBUG) drawDebug();
  }

  function remap(old) {
    for (var i = 0; i < platforms.length; i++) {
      if (platforms[i].el === old.el) return platforms[i];
    }
    // element vanished: nearest surface by y
    var best = null,
      bestD = Infinity;
    for (var j = 0; j < platforms.length; j++) {
      var d = Math.abs(platforms[j].y - old.y);
      if (d < bestD) {
        bestD = d;
        best = platforms[j];
      }
    }
    return best;
  }

  function drawDebug() {
    if (!debugLayer) {
      debugLayer = document.createElement("div");
      debugLayer.style.cssText =
        "position:absolute;left:0;top:0;z-index:29;pointer-events:none;";
      document.body.appendChild(debugLayer);
      var sheet = document.createElement("canvas");
      var names = Object.keys(SPRITES.R);
      sheet.width = SW * names.length;
      sheet.height = SH;
      var sx = sheet.getContext("2d");
      names.forEach(function (n, i) {
        sx.drawImage(SPRITES.R[n], i * SW, 0);
      });
      sheet.style.cssText =
        "position:fixed;left:8px;bottom:8px;width:" +
        SW * names.length * 3 +
        "px;height:" +
        SH * 3 +
        "px;image-rendering:pixelated;z-index:9999;background:#111;border:1px solid #333;";
      document.body.appendChild(sheet);
    }
    debugLayer.replaceChildren();
    platforms.forEach(function (p) {
      var d = document.createElement("div");
      d.style.cssText =
        "position:absolute;border-top:2px solid rgba(0,224,90,.7);left:" +
        p.x1 +
        "px;top:" +
        p.y +
        "px;width:" +
        (p.x2 - p.x1) +
        "px;height:0;";
      debugLayer.appendChild(d);
    });
  }

  /* ------------------------------------------------------------------ *
   * 5. THE CHARACTER
   * ------------------------------------------------------------------ */

  var GRAVITY = 2600;
  var TERMINAL_VY = 1350; // fall speed cap so long drops stay readable
  var HURRY_SPEED = 470; // sprint while catching up to the visitor
  var MAX_HOP_UP = 170; // climbable height in one mantle, px
  var MAX_DROP = 1500; // hard limit for an animated fall
  var CHASE_DROP = 750; // during active scrolling, blip beyond this
  var MAX_JUMP_SPAN = 420;

  var alex = {
    x: 0, // feet centre, document coords
    y: 0, // feet y, document coords
    vx: 0,
    vy: 0,
    dir: 1, // 1 right, -1 left
    state: "hidden", // hidden|blipIn|blipOut|idle|run|jump|fall|land|climb|sit|wave|inspect|present|cheer
    stateT: 0,
    animT: 0,
    platform: null, // platform currently stood on
    target: null, // platform we are moving toward
    anchor: null, // content he is quietly pointing out
    targetX: 0,
    pace: RUN_BASE(), // current stroll speed, varied per wander
    hurry: false, // catching up with the visitor
    quickBlip: false, // skip most of blipOut (he was off screen anyway)
    idleFor: 0,
    nextWanderAt: 2,
    blinkAt: 2 + Math.random() * 3,
    waveCooldownUntil: 6, // seconds (loop clock) before he may wave again
    sitUntil: 0,
    stepAsideUntil: 0,
    inspected: null, // platform he already inspected this visit
    hops: 0, // cheer hop counter
    cheered: false, // reacted to the contact protocol this run
    jumpFrom: null, // platform he launched from, banned as a landing mid-arc
    dust: [], // particles {x,y,vx,vy,t,c}
  };

  function RUN_BASE() {
    return 110 + Math.random() * 70;
  }

  var clock = 0; // seconds since start, advanced by the loop
  var presentedEls = new WeakSet();
  var guideUnderline = null;

  function guideUnderlineEl() {
    if (!guideUnderline) {
      guideUnderline = document.createElement("div");
      guideUnderline.style.cssText =
        "position:absolute;height:2px;pointer-events:none;z-index:44;background:linear-gradient(90deg, transparent, #00e05a, transparent);border-radius:1px;opacity:0;transition:opacity 0.45s ease;";
      document.body.appendChild(guideUnderline);
    }
    return guideUnderline;
  }

  function facePlatformCenter(p) {
    if (!p || !p.el) return;
    var r = p.el.getBoundingClientRect();
    alex.dir = r.left + scrollX + r.width / 2 >= alex.x ? 1 : -1;
  }

  function showGuideUnderline() {
    if (!alex.platform || !alex.platform.el) return;
    var r = alex.platform.el.getBoundingClientRect();
    var u = guideUnderlineEl();
    u.style.left = r.left + scrollX + "px";
    u.style.top = r.bottom + scrollY + 6 + "px";
    u.style.width = r.width + "px";
    u.style.opacity = "0.85";
    facePlatformCenter(alex.platform);
  }

  function hideGuideUnderline() {
    if (guideUnderline) guideUnderline.style.opacity = "0";
  }

  function setState(s) {
    if (alex.state === "present" && s !== "present") hideGuideUnderline();
    alex.state = s;
    alex.stateT = 0;
    alex.animT = 0;
    if (s === "present") showGuideUnderline();
  }

  function platformAt(x, y, slackY, slackX, exclude) {
    var sx = slackX || 2;
    var best = null;
    for (var i = 0; i < platforms.length; i++) {
      var p = platforms[i];
      if (p === exclude) continue;
      if (x < p.x1 - sx || x > p.x2 + sx) continue;
      if (!inIntervals(p, x, 8)) continue;
      if (p.y < y - 4) continue;
      if (p.y > y + slackY) continue;
      if (!best || p.y < best.y) best = p;
    }
    return best;
  }

  function comfortBand() {
    var vt = projScrollY();
    var top = vt + innerHeight * 0.24;
    var bot = vt + innerHeight * 0.76;
    return { top: top, bot: bot, mid: (top + bot) / 2 };
  }

  // feet outside the REAL viewport (with margin): the visitor cannot
  // see him, whatever he is doing must yield to recovery
  function offScreenBy() {
    var top = scrollY - 100;
    var bot = scrollY + innerHeight + 140;
    if (alex.y < top) return alex.y - top; // negative: above by that much
    if (alex.y > bot) return alex.y - bot; // positive: below
    return 0;
  }

  function nearPlatforms() {
    // every ledge in or near the (projected) viewport
    var vt = projScrollY();
    var lo = vt - 120;
    var hi = vt + innerHeight + 180;
    return platforms.filter(function (p) {
      return p.y > lo && p.y < hi;
    });
  }

  function reachable(p) {
    var dy = p.y - alex.y;
    if (dy > MAX_DROP || dy < -MAX_HOP_UP * 2.2) return false;
    var gapX = alex.x < p.x1 ? p.x1 - alex.x : alex.x > p.x2 ? alex.x - p.x2 : 0;
    return gapX <= MAX_JUMP_SPAN;
  }

  function settled() {
    return performance.now() - lastScrollAt > 900;
  }

  function anchorWeight(kind) {
    if (kind === "button") return 3.4;
    if (kind === "h2") return 3;
    if (kind === "h1") return 2.4;
    if (kind === "h3") return 1.4;
    if (kind === "code" || kind === "node") return 1;
    return 0.6;
  }

  function anchorScore(p) {
    var xTravel = Math.abs(spotOn(p, alex.x) - alex.x);
    return (
      anchorWeight(p.kind) * 260 -
      Math.abs(p.y - (scrollY + innerHeight * 0.45)) -
      xTravel * 0.3
    );
  }

  function anchorInView(p, top, bot) {
    return p && p.iv && p.iv.length && p.y >= top && p.y <= bot;
  }

  function bestAnchor() {
    var top = scrollY + 90;
    var bot = scrollY + innerHeight - 40;
    var best = null,
      bestScore = -Infinity;
    for (var i = 0; i < platforms.length; i++) {
      var p = platforms[i];
      if (!anchorInView(p, top, bot)) continue;
      var score = anchorScore(p);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (!best) {
      alex.anchor = null;
      return null;
    }
    if (anchorInView(alex.anchor, top, bot) && anchorScore(alex.anchor) >= bestScore - 120) {
      return alex.anchor;
    }
    alex.anchor = best;
    return best;
  }

  function nearestTo(docY) {
    var best = null,
      bestD = Infinity;
    for (var i = 0; i < platforms.length; i++) {
      var d = Math.abs(platforms[i].y - docY);
      if (d < bestD) {
        bestD = d;
        best = platforms[i];
      }
    }
    return best;
  }

  function pickTarget(dir) {
    // dir: 1 = need to travel down, -1 = up, 0 = any. Prefer the platform
    // that makes the most progress toward the comfort mid in ONE
    // reachable move, so long distances become chains of hops and
    // climbs; fall back to anything in the direction of travel.
    var band = comfortBand();
    var cands = nearPlatforms();
    var best = null,
      bestScore = Infinity,
      bestAny = null,
      bestAnyScore = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var p = cands[i];
      if (p === alex.platform) continue;
      if (dir === 1 && p.y < alex.y + 20) continue;
      if (dir === -1 && p.y > alex.y - 20) continue;
      var px = spotOn(p, alex.x);
      var score = Math.abs(p.y - band.mid) + Math.abs(px - alex.x) * 0.35;
      if (score < bestAnyScore) {
        bestAnyScore = score;
        bestAny = p;
      }
      if (reachable(p) && score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    // stepping stones outside the viewport in the travel direction
    // (the next heading just past the edge, say)
    if (!best && dir !== 0) {
      var bestD = Infinity;
      for (var j = 0; j < platforms.length; j++) {
        var q = platforms[j];
        if (q === alex.platform) continue;
        if (dir === 1 && q.y < alex.y + 20) continue;
        if (dir === -1 && q.y > alex.y - 20) continue;
        if (!reachable(q)) continue;
        var d = Math.abs(q.y - alex.y);
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
    }
    return best || bestAny || nearestTo(scrollY + innerHeight * 0.5);
  }

  function spotOn(p, nearX) {
    if (!p.iv || !p.iv.length) return Math.max(p.x1 + 14, Math.min(p.x2 - 14, nearX));
    var best = p.iv[0][0] + 2,
      bestD = Infinity;
    for (var i = 0; i < p.iv.length; i++) {
      var iv = p.iv[i];
      if (nearX >= iv[0] && nearX <= iv[1]) return nearX;
      var dl = Math.abs(nearX - iv[0]);
      if (dl < bestD) {
        bestD = dl;
        best = iv[0] + 2;
      }
      var dr = Math.abs(nearX - iv[1]);
      if (dr < bestD) {
        bestD = dr;
        best = iv[1] - 2;
      }
    }
    return best;
  }

  function blipTo(p) {
    if (!p) return;
    alex.afterBlip = p;
    alex.quickBlip = offScreenBy() !== 0; // nobody sees the old spot
    setState("blipOut");
  }

  /* ---------- the brain: called while idle/running -------------------- */

  function moveToward(target) {
    if (!target) return;
    var dy = target.y - alex.y;
    var off = offScreenBy();
    // beyond animation range, deep off screen, or the visitor is
    // actively flying past: de-rez straight there instead of arriving
    // late (a chain of climbs from below the fold takes seconds)
    if (
      !reachable(target) ||
      Math.abs(off) > 400 ||
      (Math.abs(dy) > CHASE_DROP && scrollingHard())
    ) {
      blipTo(target);
      return;
    }
    alex.target = target;
    alex.targetX = spotOn(target, alex.x);
    alex.hurry = true;
    setState("run");
  }

  function cursorDist() {
    if (!cursorRecent(5000)) return Infinity;
    var hx = alex.x,
      hy = alex.y - CH / 2;
    return Math.hypot(cursorDocX() - hx, cursorDocY() - hy);
  }

  function think(dt) {
    var band = comfortBand();
    alex.idleFor += dt;

    var offTop = alex.y < band.top - 20; // visitor scrolled down past him
    var offBot = alex.y > band.bot + 20; // visitor scrolled up past him

    if (offTop || offBot) {
      moveToward(pickTarget(offTop ? 1 : -1));
      return;
    }
    alex.hurry = false;

    // --- guide mode: point out the strongest content when all is calm ---
    var anchor = settled() ? bestAnchor() : null;
    if (alex.state === "idle" && anchor && anchor !== alex.platform && alex.idleFor > 1.2) {
      if (reachable(anchor)) {
        alex.target = anchor;
        alex.targetX = spotOn(anchor, alex.x);
        alex.hurry = false;
        alex.pace = 150;
        setState("run");
        return;
      }
    }
    if (
      alex.state === "idle" &&
      anchor &&
      alex.platform === anchor &&
      !presentedEls.has(anchor.el) &&
      (isHeadingKind(anchor.kind) || anchor.kind === "button")
    ) {
      presentedEls.add(anchor.el);
      setState("present");
      return;
    }

    // --- cursor play (only when settled and the pointer is live) ------
    var cd = cursorDist();
    if (alex.state === "idle" && cd < 999) {
      var away = alex.x < cursorDocX() ? -1 : 1;
      if (cd < 60 && clock > alex.stepAsideUntil && alex.platform) {
        // too close: take a few quick steps aside
        alex.stepAsideUntil = clock + 2.5;
        alex.target = null;
        alex.targetX = spotOn(alex.platform, alex.x + away * (50 + Math.random() * 40));
        alex.pace = 190;
        if (Math.abs(alex.targetX - alex.x) > 10) {
          setState("run");
          return;
        }
      } else if (cd < 150) {
        // meet its gaze
        alex.dir = cursorDocX() >= alex.x ? 1 : -1;
        if (cd < 130 && clock > alex.waveCooldownUntil) {
          alex.waveCooldownUntil = clock + 16 + Math.random() * 10;
          setState("wave");
          return;
        }
      }
    }

    // --- flavour on the furniture --------------------------------------
    if (
      alex.state === "idle" &&
      alex.platform &&
      (alex.platform.kind === "code" || alex.platform.kind === "node") &&
      alex.inspected !== alex.platform &&
      alex.idleFor > 2.5
    ) {
      alex.inspected = alex.platform;
      setState("inspect");
      return;
    }

    // --- idle life -------------------------------------------------------
    if (alex.state === "idle" && alex.idleFor > 10 && alex.platform && !isHeadingKind(alex.platform.kind)) {
      var pEdge = alex.platform;
      var dL = alex.x - pEdge.x1,
        dR = pEdge.x2 - alex.x;
      if (Math.min(dL, dR) < 70) {
        alex.dir = dL < dR ? -1 : 1;
        alex.sitUntil = clock + 4 + Math.random() * 3;
        setState("sit");
        return;
      }
    }

    if (alex.state === "idle" && alex.idleFor > alex.nextWanderAt) {
      alex.nextWanderAt = alex.idleFor + 6 + Math.random() * 5;
      alex.pace = RUN_BASE();
      // sometimes, parkour to a neighbouring ledge for fun
      if (Math.random() < 0.12) {
        var hopTo = null,
          hopD = Infinity;
        var near = nearPlatforms();
        for (var i = 0; i < near.length; i++) {
          var q = near[i];
          if (q === alex.platform) continue;
          var dy = Math.abs(q.y - alex.y);
          var qx = spotOn(q, alex.x);
          var dx = Math.abs(qx - alex.x);
          if (dy <= 180 && dx <= 260 && reachable(q)) {
            var dd = dy + dx * 0.5;
            if (dd < hopD) {
              hopD = dd;
              hopTo = q;
            }
          }
        }
        if (hopTo) {
          alex.target = hopTo;
          alex.targetX = spotOn(hopTo, alex.x);
          setState("run");
          return;
        }
      }
      // otherwise stroll a decent stretch of the current ledge
      alex.target = null;
      alex.targetX = spotOn(
        alex.platform,
        alex.x + (Math.random() < 0.5 ? -1 : 1) * (60 + Math.random() * 100)
      );
      if (Math.abs(alex.targetX - alex.x) > 12) setState("run");
    }
  }

  /* ---------- physics + state machine --------------------------------- */

  function launchToward(target) {
    var tx = spotOn(target, alex.targetX);
    var dy = target.y - alex.y; // + is down
    var up = dy < -8 ? Math.sqrt(2 * GRAVITY * (-dy + 26)) : dy > 8 ? 240 : 300;
    var t1 = up / GRAVITY;
    var drop = dy + (up * up) / (2 * GRAVITY);
    var t2 = drop > 0 ? Math.sqrt((2 * drop) / GRAVITY) : 0;
    var T = Math.max(0.22, t1 + t2);
    alex.vy = -up;
    alex.vx = (tx - alex.x) / T;
    alex.dir = alex.vx >= 0 ? 1 : -1;
    alex.jumpFrom = alex.platform;
    setState("jump");
  }

  function step(dt) {
    alex.stateT += dt;
    alex.animT += dt;
    var band = comfortBand();

    // ---- global recovery: he is off screen, so whatever soft thing he
    // is doing yields NOW; airborne states get rescued if truly lost
    var off = offScreenBy();
    if (off !== 0 && alex.state !== "hidden" && alex.state !== "blipOut" && alex.state !== "blipIn") {
      var soft =
        alex.state === "idle" ||
        alex.state === "wave" ||
        alex.state === "sit" ||
        alex.state === "land" ||
        alex.state === "inspect" ||
        alex.state === "present" ||
        alex.state === "cheer" ||
        alex.state === "run";
      if (soft) {
        if (alex.state !== "run") setState("idle");
        alex.idleFor = 99; // let think() act immediately
        think(dt);
        if (alex.state === "idle") {
          // think() found nothing animatable: go directly
          blipTo(pickTarget(off < 0 ? 1 : -1));
        }
      } else if (Math.abs(off) > innerHeight * 0.9) {
        // mid-jump/fall/climb but hopelessly far away
        blipTo(pickTarget(off < 0 ? 1 : -1));
      }
    }

    switch (alex.state) {
      case "hidden":
        break;

      case "blipOut": {
        var outDur = alex.quickBlip ? 0.1 : 0.34;
        if (alex.stateT > outDur) {
          // the page may have moved on while we de-rezzed: land wherever
          // is useful NOW, not where was useful then
          var p = alex.afterBlip;
          var vt = scrollY;
          if (!p || p.y < vt - 80 || p.y > vt + innerHeight + 120) {
            p = pickTarget(0);
          }
          if (p) {
            alex.platform = p;
            alex.x = spotOn(p, alex.x);
            alex.y = p.y;
          }
          alex.afterBlip = null;
          setState("blipIn");
        }
        break;
      }

      case "blipIn":
        if (alex.stateT > 0.3) {
          alex.idleFor = 0;
          alex.nextWanderAt = 1.5 + Math.random() * 2.5;
          setState("idle");
        }
        break;

      case "idle":
        think(dt);
        break;

      case "wave":
        if (alex.stateT > 1.3) {
          alex.idleFor = 0;
          setState("idle");
        }
        break;

      case "sit":
        if (clock > alex.sitUntil) {
          alex.idleFor = 0;
          alex.nextWanderAt = 1;
          setState("idle");
        }
        break;

      case "inspect":
        // crouch over the panel and poke at it; green bits fly
        if (alex.animT % 0.28 < dt) {
          alex.dust.push({
            x: alex.x + alex.dir * (6 + Math.random() * 6),
            y: alex.y - 8 - Math.random() * 10,
            vx: alex.dir * (10 + Math.random() * 30),
            vy: -30 - Math.random() * 50,
            t: 0,
            c: PAL.z,
          });
        }
        if (alex.stateT > 1.5) {
          alex.idleFor = 0;
          setState("idle");
        }
        break;

      case "present":
        facePlatformCenter(alex.platform);
        if (alex.stateT > 1.9) {
          alex.idleFor = 0;
          setState("idle");
        }
        break;

      case "cheer": {
        // two little hops on the spot
        alex.vy += GRAVITY * dt;
        alex.y += alex.vy * dt;
        if (alex.platform && alex.y >= alex.platform.y) {
          alex.y = alex.platform.y;
          alex.hops++;
          if (alex.hops >= 2) {
            alex.vy = 0;
            alex.idleFor = 0;
            setState("idle");
          } else {
            alex.vy = -300;
          }
        }
        break;
      }

      case "run": {
        var goal = alex.targetX;
        var sp = alex.hurry ? HURRY_SPEED : alex.pace;
        alex.dir = goal > alex.x ? 1 : -1;
        alex.x += alex.dir * sp * dt;

        var pl = alex.platform;
        if (pl) {
          if (alex.target && (alex.x <= pl.x1 + 4 || alex.x >= pl.x2 - 4)) {
            var t = alex.target;
            if (t.y < pl.y - 12 && t.y > pl.y - MAX_HOP_UP - 60) {
              if (alex.x > t.x1 - 30 && alex.x < t.x2 + 30) {
                setState("climb");
                break;
              }
            }
            launchToward(t);
            break;
          }
          alex.x = Math.max(pl.x1 + 2, Math.min(pl.x2 - 2, alex.x));
        }
        if (Math.abs(alex.x - goal) < 6) {
          if (alex.target && alex.target !== alex.platform) {
            var t2 = alex.target;
            if (t2.y < alex.y - 12) {
              setState("climb");
            } else {
              launchToward(t2);
            }
          } else {
            alex.idleFor = 0;
            setState("idle");
          }
        }
        // only keep thinking if nothing above changed state; think()
        // would otherwise clobber a jump/climb we just committed to
        if (alex.state === "run") think(dt);
        break;
      }

      case "jump":
        alex.vy += GRAVITY * dt;
        alex.x += alex.vx * dt;
        alex.y += alex.vy * dt;
        if (alex.vy > 40) setState("fall");
        break;

      case "fall": {
        alex.vy = Math.min(TERMINAL_VY, alex.vy + GRAVITY * dt);
        alex.x += alex.vx * dt;
        alex.y += alex.vy * dt;
        // sweep enough of x and y that fast arcs cannot tunnel through
        // a narrow ledge between frames. While a different ledge is the
        // target, the one he launched from is not a landing: catching it
        // mid arc used to bounce him on the spot forever when the target
        // sat directly below.
        var ban =
          alex.target && alex.jumpFrom !== alex.target ? alex.jumpFrom : null;
        var landOn = platformAt(
          alex.x,
          alex.y - 20,
          Math.max(26, alex.vy * dt * 2),
          Math.abs(alex.vx * dt) + 4,
          ban
        );
        if (landOn && alex.y >= landOn.y - 2) {
          alex.y = landOn.y;
          alex.platform = landOn;
          alex.target = null;
          alex.jumpFrom = null;
          alex.vx = 0;
          alex.vy = 0;
          spawnDust();
          setState("land");
        } else if (alex.y > scrollY + innerHeight + 400 || alex.y > document.documentElement.scrollHeight) {
          blipTo(pickTarget(0));
        }
        break;
      }

      case "land": {
        // barely a beat when he is catching up; a real crouch when not
        var pause = alex.hurry ? 0.08 : 0.22;
        if (alex.stateT > pause) {
          alex.idleFor = 0;
          setState("idle");
          if (alex.hurry) think(dt); // chain the next hop immediately
        }
        break;
      }

      case "climb": {
        var t3 = alex.target;
        if (!t3) {
          setState("idle");
          break;
        }
        var fromY = alex.platform ? alex.platform.y : alex.y;
        var dur = Math.min(1.1, 0.35 + Math.abs(t3.y - fromY) / 450);
        if (alex.hurry) dur *= 0.65;
        var k = Math.min(1, alex.stateT / dur);
        alex.y = fromY + (t3.y - fromY) * k;
        alex.x += (spotOn(t3, alex.x) - alex.x) * Math.min(1, dt * 6);
        if (k >= 1) {
          alex.platform = t3;
          alex.target = null;
          alex.y = t3.y;
          alex.idleFor = 0;
          setState("idle");
          if (alex.hurry) think(dt);
        }
        break;
      }
    }

    // watch the contact protocol: cheer when the visitor runs it
    if (!alex.cheered && (alex.state === "idle" || alex.state === "sit")) {
      var btn = document.getElementById("wf-btn");
      if (btn && btn.disabled && offScreenBy() === 0) {
        alex.cheered = true;
        alex.hops = 0;
        alex.vy = -300;
        setState("cheer");
      }
      if (btn && !btn.disabled && alex.cheered) alex.cheered = false;
    }

    // dust particles
    for (var i = alex.dust.length - 1; i >= 0; i--) {
      var m = alex.dust[i];
      m.t += dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      if (m.t > 0.4) alex.dust.splice(i, 1);
    }

    // keep feet honest while standing (layout may drift subtly)
    if (
      (alex.state === "idle" || alex.state === "sit" || alex.state === "wave" || alex.state === "inspect" || alex.state === "present") &&
      alex.platform
    ) {
      alex.y = alex.platform.y;
    }
  }

  function spawnDust() {
    for (var i = 0; i < 5; i++) {
      alex.dust.push({
        x: alex.x + (Math.random() * 16 - 8),
        y: alex.y,
        vx: Math.random() * 60 - 30,
        vy: -Math.random() * 40,
        t: 0,
        c: "rgba(220,230,240,0.8)",
      });
    }
  }

  /* ---------- frame selection ------------------------------------------ */

  function currentFrame() {
    var t = alex.animT;
    switch (alex.state) {
      case "idle": {
        if (t > alex.blinkAt && t < alex.blinkAt + 0.14) return "blink";
        if (t > alex.blinkAt + 0.14) {
          alex.animT = 0;
          alex.blinkAt = 2 + Math.random() * 3.5;
        }
        return Math.floor(t / 0.6) % 2 ? "idleB" : "idleA";
      }
      case "wave":
        return Math.floor(t / 0.22) % 2 ? "waveB" : "waveA";
      case "sit":
        return "sit";
      case "inspect":
        return Math.floor(t / 0.3) % 2 ? "land" : "idleA";
      case "present":
        return Math.floor(t / 0.35) % 2 ? "pointB" : "pointA";
      case "cheer":
        return alex.vy < -40 || alex.y < (alex.platform ? alex.platform.y - 2 : alex.y) ? "jump" : "idleA";
      case "run":
        return ["runA", "runB", "runC", "runD"][Math.floor(t / 0.09) % 4];
      case "jump":
        return "jump";
      case "fall":
        return "fall";
      case "land":
        return "land";
      case "climb":
        return Math.floor(t / 0.2) % 2 ? "climbB" : "climbA";
      case "blipIn":
      case "blipOut":
        return "idleA";
    }
    return "idleA";
  }

  /* ---------- render ----------------------------------------------------- */

  function render() {
    ctx.clearRect(0, 0, SW, SH);
    var frame = currentFrame();
    var dirSet = alex.dir < 0 ? SPRITES.L : SPRITES.R;

    if (alex.state === "blipOut" || alex.state === "blipIn") {
      var dur = alex.state === "blipOut" ? (alex.quickBlip ? 0.1 : 0.34) : 0.3;
      var k = Math.min(1, alex.stateT / dur);
      var vis = alex.state === "blipOut" ? 1 - k : k;
      var img = dirSet[frame];
      for (var x = 0; x < SW; x++) {
        var h = Math.max(0, Math.round(SH * vis - ((x * 7919) % 5)));
        if (h <= 0) continue;
        ctx.drawImage(img, x, SH - h, 1, h, x, SH - h, 1, h);
      }
      ctx.fillStyle = "rgba(0,224,90," + 0.5 * (1 - vis) + ")";
      for (var i = 0; i < 4; i++) {
        ctx.fillRect(Math.floor(Math.random() * SW), Math.floor(Math.random() * SH), 1, 1);
      }
    } else {
      ctx.drawImage(dirSet[frame], 0, 0);

      // cursor gaze: nudge the pupils toward the pointer on the
      // front-facing frames (the faces are symmetric, so the eye cells
      // sit at x=8 and x=11 in both bakes)
      var row = EYE_ROW[frame];
      if (row !== undefined && cursorRecent(6000)) {
        var dx = cursorDocX() - alex.x;
        var dyE = cursorDocY() - (alex.y - CH * 0.75);
        var ox = dx < -26 ? -1 : dx > 26 ? 1 : 0;
        var oy = dyE < -110 ? -1 : dyE > 60 ? 1 : 0;
        if (ox || oy) {
          ctx.fillStyle = PAL.s;
          ctx.fillRect(8, row, 1, 1);
          ctx.fillRect(11, row, 1, 1);
          ctx.fillStyle = PAL.e;
          ctx.fillRect(8 + ox, row + oy, 1, 1);
          ctx.fillRect(11 + ox, row + oy, 1, 1);
        }
      }
    }

    if (
      alex.platform &&
      (alex.state === "idle" || alex.state === "run" || alex.state === "wave" || alex.state === "land" || alex.state === "inspect" || alex.state === "present")
    ) {
      ctx.fillStyle = "rgba(0,224,90,0.5)";
      ctx.fillRect(4, SH - 1, 12, 1);
      ctx.fillStyle = "rgba(12,16,22,0.9)";
      ctx.fillRect(4, SH - 1, 1, 1);
      ctx.fillRect(15, SH - 1, 1, 1);
    }

    if (alex.dust.length) {
      for (var j = 0; j < alex.dust.length; j++) {
        var m = alex.dust[j];
        var lx = Math.round((m.x - alex.x) / SCALE + SW / 2);
        var ly = Math.round((m.y - alex.y) / SCALE + SH - 2);
        if (lx >= 0 && lx < SW && ly >= 0 && ly < SH) {
          ctx.fillStyle = m.c;
          ctx.fillRect(lx, ly, 1, 1);
        }
      }
    }

    var px = Math.round(alex.x - CW / 2);
    var py = Math.round(alex.y - CH + SCALE);
    if (alex.state === "sit") py = Math.round(alex.y - CH + 7 * SCALE);
    canvas.style.transform = "translate3d(" + px + "px," + py + "px,0)";
    canvas.style.opacity = alex.state === "hidden" ? "0" : "1";
  }

  /* ------------------------------------------------------------------ *
   * 6. LOOP + WIRING
   * ------------------------------------------------------------------ */

  var last = 0,
    raf = 0,
    running = false,
    tick = 0;

  function loop(ts) {
    raf = 0;
    if (!enabled || !running) return;
    var dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts;
    clock += dt;
    tick++;

    // smoothed scroll velocity feeds the projected comfort band
    var inst = (scrollY - lastScrollY) / dt;
    if (scrollY !== lastScrollY) lastScrollAt = performance.now();
    lastScrollY = scrollY;
    scrollVel = scrollVel * 0.8 + inst * 0.2;

    step(dt);

    // render throttle: deep idle (nothing moving, nobody interacting)
    // paints at ~12fps instead of 60 — breathing still reads fine
    var deepIdle =
      (alex.state === "idle" || alex.state === "sit") &&
      !alex.dust.length &&
      !cursorRecent(3000) &&
      performance.now() - lastScrollAt > 3000;
    if (!deepIdle || tick % 5 === 0) render();

    raf = requestAnimationFrame(loop);
  }

  function start() {
    if (!enabled) return;
    buildPlatforms();
    if (!platforms.length) return;
    var t = pickTarget(0) || platforms[0];
    alex.platform = t;
    alex.x = spotOn(t, t.x2 - 40);
    alex.y = t.y;
    alex.afterBlip = null;
    setState("blipIn");
    setTimeout(function () {
      if (enabled && alex.state === "idle") setState("wave");
    }, 1400);
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
  }

  var rebuildTimer;
  var resizeObserver = new ResizeObserver(scheduleRebuild);

  function scheduleRebuild() {
    if (!enabled) return;
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(function () {
      if (!enabled) return;
      buildPlatforms();
      if (alex.platform && (alex.state === "idle" || alex.state === "sit")) {
        alex.y = alex.platform.y;
        alex.x = spotOn(alex.platform, alex.x);
      }
    }, 150);
  }

  function appendCanvas() {
    if (canvasMounted) return;
    document.body.appendChild(canvas);
    canvasMounted = true;
  }

  function storedModeOn() {
    try {
      return localStorage.getItem(MODE_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function storeMode(on) {
    try {
      localStorage.setItem(MODE_KEY, on ? "1" : "0");
    } catch (e) {}
  }

  function updateToggleButton() {
    if (!toggleButton) return;
    toggleButton.textContent = enabled ? "■ PIXEL MODE" : "► PIXEL MODE";
    toggleButton.setAttribute("aria-pressed", enabled ? "true" : "false");
  }

  function installToggle() {
    if (toggleButton) return;
    var mail = document.querySelector('#main-header a[href^="mailto"]');
    var row = mail && mail.parentElement;
    toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.style.cssText =
      "font-family:inherit;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;padding:8px 14px;background:transparent;color:#22c55e;border:1px solid rgba(34,197,94,0.6);border-radius:2px;cursor:pointer;";
    if (row) {
      row.appendChild(toggleButton);
    } else {
      toggleButton.style.position = "fixed";
      toggleButton.style.top = "76px";
      toggleButton.style.right = "18px";
      toggleButton.style.zIndex = "49";
      document.body.appendChild(toggleButton);
    }
    toggleButton.onmouseenter = function () {
      toggleButton.style.background = "rgba(34,197,94,0.15)";
    };
    toggleButton.onmouseleave = function () {
      toggleButton.style.background = "transparent";
    };
    toggleButton.addEventListener("click", function () {
      var on = !enabled;
      storeMode(on);
      if (on) {
        enable();
      } else {
        disable();
      }
      updateToggleButton();
    });
    updateToggleButton();
  }

  function enable() {
    if (enabled) return;
    appendCanvas();
    enabled = true;
    running = true;
    resizeObserver.observe(document.body);
    start();
    updateToggleButton();
  }

  function disable() {
    enabled = false;
    running = false;
    clearTimeout(rebuildTimer);
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    setState("hidden");
    canvas.style.opacity = "0";
    hideGuideUnderline();
    resizeObserver.disconnect();
    updateToggleButton();
  }

  window.addEventListener("resize", scheduleRebuild);
  window.addEventListener("load", scheduleRebuild);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleRebuild);

  document.addEventListener("visibilitychange", function () {
    if (!enabled) return;
    running = !document.hidden;
    if (running && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
  });

  function boot() {
    installToggle();
    if (storedModeOn()) {
      enable();
    } else {
      disable();
    }
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    boot();
  } else {
    document.addEventListener("DOMContentLoaded", boot);
  }
})();
