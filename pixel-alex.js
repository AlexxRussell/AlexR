/*
 * PIXEL ALEX — an 8-bit resident of alexrussell.io.
 *
 * A tiny sprite of Alexander lives on the page. He stands on real page
 * elements (headings, panels, cards, the footer), and when the visitor
 * scrolls he parkours to stay in view: running along ledges, leaping
 * gaps, dropping with a tucked jump, mantling up over headings when the
 * visitor scrolls back up. Where overhead text leaves no room to stand
 * he ducks and shuffles through at a crouch, and when the way down is
 * straight through the page's structure he hops down through it — card
 * top to inner bubble to the next card — instead of de-rezzing. If a
 * move is truly out of range he de-rezzes and blips back in like a
 * proper video game character.
 *
 * He is aware of the visitor: his eyes follow the cursor, he turns to
 * face it when it comes near, steps aside if it gets too close, and
 * waves back at a cursor that lingers. When the visitor hovers one of
 * the page's highlighted boxes he treats it as the current exhibit —
 * he runs (or de-rezzes) over, presents it, then sits on it keeping
 * the visitor company while they read. On touch screens taps stand in
 * for the cursor, tapping a box sends him over to attend it, and once
 * a scroll settles he attends the box nearest the centre of the
 * screen. He watches the page too — he inspects the terminal panel,
 * cheers when the contact protocol runs (or a voice call connects),
 * wanders and hops between nearby ledges while idling, sits on edges
 * when left alone, and settles down to wait when the visitor goes
 * quiet or the tab is hidden.
 *
 * Follow logic is scroll-velocity aware: the comfort band is computed
 * against a projected scroll position, soft states (wave, sit, land)
 * cancel instantly when the visitor moves on, hop chains sprint with
 * short landings while catching up, and anything unreachable in time
 * de-rezzes straight to where the visitor is. The aim: he should
 * never be off screen for more than a beat.
 *
 * Pixel mode is an easter egg: clicking or tapping Alexander's name in
 * the header (or the portrait on desktop) toggles it, and the choice
 * persists in localStorage. There is no visible control.
 *
 * Everything is self contained: sprites are hand-authored pixel maps
 * baked once to offscreen canvases, physics is a rAF loop on one small
 * transformed canvas (render-throttled while deeply idle). No
 * libraries, no layout impact (position:absolute + pointer-events:
 * none), aria-hidden. Under prefers-reduced-motion he never
 * auto-starts, but the name tap still toggles him on — an explicit
 * tap is an informed opt-in.
 *
 * Debug: append ?alexdebug to the URL to see the sprite sheet, the
 * platform map (duck zones in orange), and window.__alex().
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * 1. SPRITES
   * ------------------------------------------------------------------ */

  var PAL = {
    k: "#0c1016", // outline
    h: "#c9a052", // hair (golden blonde)
    H: "#e8ca7e", // hair highlight
    s: "#eab894", // skin
    S: "#cf9873", // skin shadow
    e: "#1e40af", // eyes (dark blue)
    g: "#1d3242", // hoodie
    G: "#152633", // hoodie shade / sleeves
    z: "#e63946", // zip + shirt accent (red)
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
    // star jump: both arms flung up and out in a Y, legs spread mid-air —
    // one of the two celebration hops a click can earn
    cheerY: [
      "....................",
      "......kkkkkkkk......",
      ".ks..khhHHHHhhk..sk.",
      ".ksk.khHhhhhhhk.ksk.",
      "..kGkkhhhhhhhhkkGk..",
      "..kGkkhsssssshkkGk..",
      "...kGkssessesskGk...",
      "...kGkSssssssSkGk...",
      "....kGksssssskGk....",
      "........kssk........",
      "......kggggggk......",
      ".....kGggggggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....kGGGzzGGGk.....",
      "......kGGGGGGk......",
      ".....kddk..kddk.....",
      ".....kddk..kddk.....",
      "....kDdk....kdDk....",
      "....kDdk....kdDk....",
      "....kddk....kddk....",
      "....kwwk....kwwk....",
      "....kWWk....kWWk....",
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
    // crouched under a low ceiling: knees bent, torso lowered, head
    // tucked — the visible body is ~17 rows so he clears overhangs the
    // full 26-row stance cannot. duckA/duckB alternate as a subtle bob
    // while idle and as a shuffle while moving.
    duckA: [
      "....................",
      "....................",
      "....................",
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
      "......kggggggk......",
      ".....kGggzzggGk.....",
      ".....kGggzzggGk.....",
      ".....ksGGzzGGsk.....",
      "......kGGGGGGk......",
      ".....kddk..kddk.....",
      ".....kDdk..kdDk.....",
      ".....kwwk..kwwk.....",
      ".....kWWk..kWWk.....",
      "....................",
    ],
    duckB: [
      "....................",
      "....................",
      "....................",
      "....................",
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
      "......kggggggk......",
      ".....kGggzzggGk.....",
      ".....ksGGzzGGsk.....",
      "......kGGGGGGk......",
      ".....kddk..kddk.....",
      ".....kDdk..kdDk.....",
      ".....kwwk..kwwk.....",
      ".....kWWk..kWWk.....",
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
  var EYE_ROW = { idleA: 6, idleB: 7, waveA: 6, waveB: 6, pointA: 6, pointB: 6, sit: 10, duckA: 13, duckB: 14, cheerY: 6 };

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

  // SCALE (and everything derived from it: CW/CH, the carve band, the
  // canvas CSS size) is viewport-dependent; recomputed on every rebuild
  // so rotation and resizes keep the sprite and its geometry consistent.
  // The frames themselves never re-bake — the CSS size scales them.
  function applyScale() {
    var s = innerWidth < 640 ? 2 : 3;
    if (s === SCALE) return;
    SCALE = s;
    CW = SW * SCALE;
    CH = SH * SCALE;
    canvas.style.width = CW + "px";
    canvas.style.height = CH + "px";
  }

  var MODE_KEY = "pixel-alex-mode";
  var canvasMounted = false;
  var enabled = false;

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

  // touch has no hover and rarely a pointermove: taps seed the cursor
  // so gaze, waves and step-asides can happen around them too
  addEventListener(
    "pointerdown",
    function (e) {
      cursor.cx = e.clientX;
      cursor.cy = e.clientY;
      cursor.movedAt = performance.now();
    },
    { passive: true }
  );

  // the old-arcade score chime: two short square-wave blips, like the
  // Chrome dino clearing a hundred points. Lazy context, created inside
  // the click gesture; quiet enough to charm rather than startle.
  var pingCtx = null;
  function playPing() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!pingCtx) pingCtx = new AC();
      if (pingCtx.state === "suspended") pingCtx.resume();
      var t0 = pingCtx.currentTime;
      [988, 1319].forEach(function (freq, i) {
        var osc = pingCtx.createOscillator();
        var g = pingCtx.createGain();
        osc.type = "square";
        osc.frequency.value = freq;
        var at = t0 + i * 0.09;
        g.gain.setValueAtTime(0.035, at);
        g.gain.exponentialRampToValueAtTime(0.001, at + 0.08);
        osc.connect(g);
        g.connect(pingCtx.destination);
        osc.start(at);
        osc.stop(at + 0.09);
      });
    } catch (err) {
      /* audio is a garnish; never let it break the click */
    }
  }

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
      if (perch && alex.platform === perch) return; // seated on the widget: leave him be
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
      // half the time he throws his arms out in a star jump, and every
      // poke earns the visitor an arcade point-chime — unless the voice
      // agent has a call up: its audio owns the stage then
      alex.cheerStyle = Math.random() < 0.5 ? "Y" : "";
      if (voiceState === "idle") playPing();
      setState("cheer");
      for (var i = 0; i < 3; i++) {
        alex.dust.push({
          x: alex.x + (Math.random() * 14 - 7),
          y: alex.y - 8 - Math.random() * 10,
          vx: Math.random() * 50 - 25,
          vy: -40 - Math.random() * 70,
          t: 0,
          c: "#00e05a", // digital dust stays terminal green
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

  // the boxes that light up on hover; when the visitor highlights one,
  // Alex treats it as the current exhibit and goes to attend it
  var BOX_SELECTOR =
    ".animated-border-box, .glass-panel, .skill-category, .timeline-content, " +
    ".project-bubble, .cert-card, .job-block, #ghost-code-window";

  var platforms = [];

  // touchPick marks attention chosen by the centred-box picker (below),
  // which explicit input — a hover or a tap — is always allowed to beat
  var hover = { el: null, at: -1e9, presented: false, touchPick: false };

  addEventListener(
    "pointerover",
    function (e) {
      var t = e.target;
      var el = t && t.closest ? t.closest(BOX_SELECTOR) : null;
      if (el && el.closest("#sticky-nav")) el = null;
      if (el !== hover.el) {
        hover.el = el;
        hover.at = performance.now();
        hover.presented = false;
        hover.touchPick = false;
      }
    },
    { passive: true }
  );

  // ---- touch-era attention ------------------------------------------
  // pointerover is dead on touch screens, so two analogues stand in:
  // tapping a box is the strong version of pointing at it, and once a
  // scroll settles the box nearest the viewport centre (and mostly
  // visible) becomes the attended one. Desktop-with-mouse never uses
  // either — the pointerover flow above is unchanged there.

  var hoverNoneMQ = matchMedia("(hover: none)");

  function touchMode() {
    return hoverNoneMQ.matches;
  }

  addEventListener(
    "pointerdown",
    function (e) {
      if (!touchMode()) return;
      var t = e.target;
      var el = t && t.closest ? t.closest(BOX_SELECTOR) : null;
      if (el && el.closest("#sticky-nav")) el = null;
      if (el && el !== hover.el) {
        hover.el = el;
        hover.at = performance.now();
        hover.presented = false;
        hover.touchPick = false;
      }
    },
    { passive: true }
  );

  var attendPickAt = 0;

  function pickCenteredBox() {
    var hc = innerWidth / 2;
    var vc = innerHeight / 2;
    var els = document.querySelectorAll(BOX_SELECTOR);
    var best = null,
      bestD = Infinity;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest("#sticky-nav")) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 20) continue;
      var visW = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
      var visH = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      if (visW <= 0 || visH <= 0) continue;
      if ((visW * visH) / (r.width * r.height) < 0.4) continue; // mostly visible only
      var d = Math.hypot(r.left + r.width / 2 - hc, r.top + r.height / 2 - vc);
      if (d < bestD) {
        bestD = d;
        best = el;
      }
    }
    return best;
  }

  function touchAttend(now) {
    if (!touchMode()) return;
    if (now - lastScrollAt < ATTEND_SETTLE_MS) return; // wait for the scroll to settle
    if (hover.el && !hover.touchPick) return; // a real hover/tap owns attention
    if (now - attendPickAt < 400) return; // don't thrash the DOM
    attendPickAt = now;
    var el = pickCenteredBox();
    if (el && el !== hover.el) {
      hover.el = el;
      hover.at = now;
      hover.presented = false;
      hover.touchPick = true;
    }
  }

  function hoverFor() {
    return (performance.now() - hover.at) / 1000;
  }

  function platformByEl(el) {
    for (var i = 0; i < platforms.length; i++) {
      if (platforms[i].el === el) return platforms[i];
    }
    return null;
  }

  // the platform behind the hovered box: the box itself, the nearest
  // boxy ancestor, or failing that the highest ledge inside the box
  // (its title heading, an inner card). Boxes that have left the
  // viewport (stale hover after a scroll) do not count.
  function hoverPlatform() {
    var el = hover.el;
    if (!el) return null;
    var p = null;
    var probe = el;
    while (probe && !p) {
      p = platformByEl(probe);
      if (!p) probe = probe.parentElement ? probe.parentElement.closest(BOX_SELECTOR) : null;
    }
    if (!p) {
      var bestY = Infinity;
      for (var i = 0; i < platforms.length; i++) {
        var q = platforms[i];
        if (q.y < bestY && el.contains(q.el)) {
          bestY = q.y;
          p = q;
        }
      }
    }
    if (!p && el.getBoundingClientRect) {
      // nothing standable on the box at all (its top is covered by
      // text): attend from the nearest ledge so he still reacts
      var r = el.getBoundingClientRect();
      var bx = r.left + scrollX + r.width / 2;
      var by = r.top + scrollY;
      var bestD = Infinity;
      for (var j = 0; j < platforms.length; j++) {
        var c = platforms[j];
        var cx = Math.max(c.x1, Math.min(c.x2, bx));
        var d = Math.hypot(cx - bx, c.y - by);
        if (d < 340 && d < bestD) {
          bestD = d;
          p = c;
        }
      }
    }
    if (!p) return null;
    if (p.y < scrollY - 60 || p.y > scrollY + innerHeight + 100) return null;
    return p;
  }

  // is he genuinely standing on the hovered box (or a ledge inside it /
  // its boxy ancestor), as opposed to attending from a nearby proxy?
  function hoverIsGenuine(p) {
    return (
      !!hover.el &&
      (p.el === hover.el || hover.el.contains(p.el) || p.el.contains(hover.el))
    );
  }

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

  function mergeIntervals(intervals) {
    if (intervals.length < 2) return intervals;
    intervals.sort(function (a, b) {
      return a[0] - b[0];
    });
    var out = [intervals[0]];
    for (var i = 1; i < intervals.length; i++) {
      var iv = intervals[i];
      var lastIv = out[out.length - 1];
      if (iv[0] <= lastIv[1]) lastIv[1] = Math.max(lastIv[1], iv[1]);
      else out.push(iv);
    }
    return out;
  }

  // is x under a low ceiling on platform p (standing blocked, crouch ok)?
  function duckAt(p, x) {
    if (!p || !p.duck || !p.duck.length) return false;
    for (var i = 0; i < p.duck.length; i++) {
      if (x >= p.duck[i][0] && x <= p.duck[i][1]) return true;
    }
    return false;
  }

  function inIntervals(p, x, pad) {
    if (!p.iv || !p.iv.length) return false;
    var ex = pad || 0;
    for (var i = 0; i < p.iv.length; i++) {
      if (x >= p.iv[i][0] - ex && x <= p.iv[i][1] + ex) return true;
    }
    return false;
  }

  // ---- the sticky header -----------------------------------------------
  // When the visitor scrolls past the hero, #sticky-nav slides down over
  // the top of the viewport (z-50, above his canvas). If it would cover
  // him he notices it coming — freezes, eyes up — then crouches until it
  // slides away or he moves clear. Grounded states only; nothing here
  // fights the physics.
  var navEl = null;
  var navSeenAt = -1; // clock when the overlap began, -1 when clear
  function navOverlapNow() {
    if (!navEl) navEl = document.getElementById("sticky-nav");
    if (!navEl || !navEl.classList.contains("visible")) return false;
    if (!alex.platform) return false;
    var grounded =
      alex.state === "idle" ||
      alex.state === "run" ||
      alex.state === "present" ||
      alex.state === "wave" ||
      alex.state === "sit";
    if (!grounded) return false;
    var nb = navEl.getBoundingClientRect().bottom; // viewport px
    var headV = alex.y - CH - scrollY; // standing head, viewport px
    var feetV = alex.y - scrollY;
    return headV < nb + 2 && feetV > nb - 4;
  }
  function navTick() {
    if (navOverlapNow()) {
      if (navSeenAt < 0) navSeenAt = clock;
    } else {
      navSeenAt = -1;
    }
  }
  function navNoticing() {
    return navSeenAt >= 0 && clock - navSeenAt < NAV_NOTICE;
  }
  function navDucking() {
    return navSeenAt >= 0 && clock - navSeenAt >= NAV_NOTICE;
  }
  function navLooking() {
    // eyes up from the moment he notices until shortly after crouching
    return navSeenAt >= 0 && clock - navSeenAt < NAV_NOTICE + 1.2;
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
    var glyphRange = document.createRange();
    for (var t = 0; t < textEls.length; t++) {
      var tel = textEls[t];
      if (tel.closest("#sticky-nav")) continue;
      if (!tel.textContent || !tel.textContent.trim()) continue;
      var tr = tel.getBoundingClientRect();
      if (tr.width <= 0 || tr.height <= 0) continue;
      // block elements report the full row width even for short text;
      // measure the actual glyphs so a short heading does not wipe out
      // the entire ledge beneath it
      try {
        glyphRange.selectNodeContents(tel);
        var gr = glyphRange.getBoundingClientRect();
        if (gr.width > 0 && gr.height > 0) tr = gr;
      } catch (err) {}
      textRects.push({
        x1: tr.left + scrollX,
        x2: tr.right + scrollX,
        y1: tr.top + scrollY,
        y2: tr.bottom + scrollY,
      });
    }
    // overhead clearance per platform: text whose bottom leaves less
    // than a crouch of headroom carves the interval out entirely; text
    // that still leaves crouch room keeps the ledge but marks the
    // x-range as a duck zone (he shuffles through those at a crouch).
    // STAND_CH is the full sprite height the carve has always used.
    var STAND_CH = CH;
    var DUCK_CH = Math.round(CH * DUCK_RATIO);
    for (var n = next.length - 1; n >= 0; n--) {
      var np = next[n];
      var ivs = [[np.x1 + 14, np.x2 - 14]];
      var ducks = [];
      var z1 = np.y - STAND_CH - 8;
      var z2 = np.y - 2;
      for (var ri = 0; ri < textRects.length; ri++) {
        var rr = textRects[ri];
        if (rr.y2 <= z1 || rr.y1 >= z2) continue;
        var a = rr.x1 - CW / 2 - 4;
        var b = rr.x2 + CW / 2 + 4;
        if (rr.y2 >= np.y - DUCK_CH) {
          // no room even to crouch under this text
          ivs = subtractInterval(ivs, a, b);
          if (!ivs.length) break;
        } else if (rr.y2 > np.y - Math.round(STAND_CH * 0.85)) {
          // meaningfully into his standing height: crouch to pass
          ducks.push([a, b]);
        }
        // else: it barely grazes his hair — no crouching for that
      }
      np.iv = cleanIntervals(ivs);
      if (!np.iv.length) {
        next.splice(n, 1);
        continue;
      }
      np.duck = mergeIntervals(ducks);
      // where he can stand fully upright: the preferred landing spots —
      // ducking is for transit and tight spots, not the default home
      var stand = np.iv;
      for (var di = 0; di < np.duck.length; di++) {
        stand = subtractInterval(stand, np.duck[di][0], np.duck[di][1]);
      }
      np.stand = cleanIntervals(stand);
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
    // (the widget perch is synthetic and never in the platform list)
    if (alex.platform && alex.platform.kind !== "widget") alex.platform = remap(alex.platform);
    if (alex.target) alex.target = remap(alex.target);
    if (alex.afterBlip) alex.afterBlip = remap(alex.afterBlip);
    if (alex.anchor) alex.anchor = remap(alex.anchor);
    if (alex.passThroughTarget) alex.passThroughTarget = remap(alex.passThroughTarget);
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
      // duck zones: orange segments floating just above the ledge line
      (p.duck || []).forEach(function (z) {
        var zx1 = Math.max(p.x1, z[0]);
        var zx2 = Math.min(p.x2, z[1]);
        if (zx2 - zx1 <= 0) return;
        var o = document.createElement("div");
        o.style.cssText =
          "position:absolute;border-top:2px solid rgba(255,150,0,.85);left:" +
          zx1 +
          "px;top:" +
          (p.y - 4) +
          "px;width:" +
          (zx2 - zx1) +
          "px;height:0;";
        debugLayer.appendChild(o);
      });
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
  var DUCK_RATIO = 0.66; // crouch height as a fraction of full sprite height
  var DUCK_PACE = 0.6; // pace multiplier while shuffling through a duck zone
  var HOP_DOWN_POP = 220; // upward pop (px/s) starting a pass-through descent
  var IDLE_SIT_AFTER = 12; // s of visitor quiet before he sits down to wait
  var ATTEND_SETTLE_MS = 350; // scroll-quiet before picking the centred box (touch)
  var NAV_NOTICE = 0.35; // s he freezes, eyes up, before crouching under the sticky header

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
    passThroughTarget: null, // hop-down descent: the only ledge that may catch him
    waitSit: false, // seated waiting for the visitor to come back
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
    if (s !== "sit") alex.waitSit = false;
    alex.state = s;
    alex.stateT = 0;
    alex.animT = 0;
    if (s === "present") showGuideUnderline();
  }

  function platformAt(x, y, slackY, slackX, exclude, only) {
    var sx = slackX || 2;
    var best = null;
    for (var i = 0; i < platforms.length; i++) {
      var p = platforms[i];
      if (p === exclude) continue;
      if (only && p !== only) continue; // pass-through descent: one valid landing
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

  function snapToIvs(ivs, nearX) {
    var best = ivs[0][0] + 2,
      bestD = Infinity;
    for (var i = 0; i < ivs.length; i++) {
      var iv = ivs[i];
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

  function spotOn(p, nearX) {
    // prefer spots with full standing headroom; duck zones are for
    // transit and tight landings, not the default idle home
    if (p.stand && p.stand.length) return snapToIvs(p.stand, nearX);
    if (!p.iv || !p.iv.length) return Math.max(p.x1 + 14, Math.min(p.x2 - 14, nearX));
    return snapToIvs(p.iv, nearX);
  }

  function blipTo(p) {
    if (!p) return;
    alex.afterBlip = p;
    alex.passThroughTarget = null;
    alex.quickBlip = offScreenBy() !== 0; // nobody sees the old spot
    setState("blipOut");
  }

  /* ---------- the brain: called while idle/running -------------------- */

  // hop-down: a small upward pop, then a fall that ignores every ledge
  // except the intended target — how he descends INTO the page's
  // structure (card top → inner project bubble → next card) instead of
  // de-rezzing every time the visitor scrolls down.
  function hopDownLegal(t) {
    if (!t || !alex.platform) return false;
    var dy = t.y - alex.platform.y;
    if (dy < 20 || dy > MAX_DROP) return false;
    // the target must be roughly beneath: horizontal spans overlap
    var overlap = Math.min(t.x2, alex.platform.x2) - Math.max(t.x1, alex.platform.x1);
    if (overlap < 30) return false;
    if (Math.abs(spotOn(t, alex.x) - alex.x) > MAX_JUMP_SPAN) return false;
    // the pop needs standing headroom at the start of the arc
    if (duckAt(alex.platform, alex.x)) return false;
    return true;
  }

  function hopDown(t) {
    var tx = spotOn(t, alex.x);
    var dy = t.y - alex.y;
    var up = HOP_DOWN_POP;
    var t1 = up / GRAVITY;
    var drop = dy + (up * up) / (2 * GRAVITY);
    var t2 = drop > 0 ? Math.sqrt((2 * drop) / GRAVITY) : 0;
    var T = Math.max(0.22, t1 + t2);
    alex.vy = -up;
    alex.vx = (tx - alex.x) / T;
    alex.dir = alex.vx >= 0 ? 1 : -1;
    alex.jumpFrom = alex.platform;
    alex.passThroughTarget = t;
    alex.target = t;
    alex.hurry = true;
    setState("jump");
  }

  function moveToward(target) {
    if (!target) return;
    // already committed and en route: re-planning every think() tick
    // churns targetX (spotOn can flip between interval ends) and reads
    // as a left-right vibration — stay the course instead
    if (alex.state === "run" && alex.target === target) return;
    var dy = target.y - alex.y;
    var off = offScreenBy();
    // following a downward scroll: prefer dropping through the page's
    // structure over a de-rez — unless it is a genuine teleport (very
    // far, or he is deep off screen: "never off screen for more than a
    // beat" still wins)
    if (
      dy > 0 &&
      hopDownLegal(target) &&
      dy <= innerHeight * 1.6 &&
      Math.abs(off) <= 400 &&
      (!reachable(target) || (Math.abs(dy) > CHASE_DROP && scrollingHard()))
    ) {
      hopDown(target);
      return;
    }
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

  // nearest end of the ledge interval he is standing in — a spot where
  // the sit frame's dangling legs read correctly
  function nearestLedgeEdgeX() {
    var p = alex.platform;
    if (!p) return alex.x;
    if (!p.iv || !p.iv.length) {
      return alex.x - p.x1 < p.x2 - alex.x ? p.x1 + 4 : p.x2 - 4;
    }
    for (var i = 0; i < p.iv.length; i++) {
      var iv = p.iv[i];
      if (alex.x >= iv[0] - 2 && alex.x <= iv[1] + 2) {
        return alex.x - iv[0] < iv[1] - alex.x ? iv[0] + 2 : iv[1] - 2;
      }
    }
    return alex.x;
  }

  function think(dt) {
    var band = comfortBand();
    alex.idleFor += dt;

    // --- attend the box the visitor is highlighting ----------------------
    // He notices the hover, comes over (de-rezzing if it is out of range),
    // presents the box once, then settles on its edge for as long as the
    // visitor stays. The early returns suppress wandering and guide mode
    // so he stays attentive.
    var hovered = hoverPlatform();
    if (hovered) {
      if (alex.platform === hovered) {
        alex.hurry = false;
        if (alex.state === "idle") {
          if (cursorRecent(6000)) alex.dir = cursorDocX() >= alex.x ? 1 : -1;
          if (!hover.presented && hoverFor() > 0.35) {
            hover.presented = true;
            // only present when actually on the box; from a nearby proxy
            // ledge the underline would highlight the wrong element
            if (hoverIsGenuine(hovered)) setState("present");
          } else if (hover.presented && hoverFor() > 4.5 && clock > alex.sitUntil) {
            var edge = nearestLedgeEdgeX();
            if (Math.abs(edge - alex.x) < 14) {
              alex.sitUntil = clock + 2;
              setState("sit");
            } else {
              alex.target = null;
              alex.targetX = edge;
              alex.pace = 140;
              setState("run");
            }
          }
        }
        return;
      }
      if (alex.state === "run" && alex.target === hovered) return; // on his way
      if (hoverFor() > 0.35 && (alex.state === "idle" || alex.state === "run")) {
        moveToward(hovered);
        return;
      }
    }

    var offTop = alex.y < band.top - 20; // visitor scrolled down past him
    var offBot = alex.y > band.bot + 20; // visitor scrolled up past him

    if (offTop || offBot) {
      var rescue = pickTarget(offTop ? 1 : -1);
      var gain = rescue
        ? Math.abs(alex.y - band.mid) - Math.abs(rescue.y - band.mid)
        : 0;
      // only travel if it actually gets him closer to the comfort band
      // (or he is invisible, where any move beats none). A tall section
      // with no standable ledge inside the band used to ping-pong him
      // between the headings above and below it forever.
      if (rescue && rescue !== alex.platform && (gain > 40 || offScreenBy() !== 0)) {
        moveToward(rescue);
        return;
      }
    }
    alex.hurry = false;

    // --- guide mode: point out the strongest content when all is calm ---
    var anchor = settled() ? bestAnchor() : null;
    if (
      alex.state === "idle" &&
      anchor &&
      anchor !== alex.platform &&
      alex.idleFor > 1.2 &&
      // an anchor outside the comfort band is a trap: the band logic
      // would immediately pull him back, and he would oscillate forever
      anchor.y > band.top - 20 &&
      anchor.y < band.bot + 20
    ) {
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

    // --- the visitor went quiet: sit down and wait for them ------------
    if (
      alex.state === "idle" &&
      alex.platform &&
      !cursorRecent(IDLE_SIT_AFTER * 1000) &&
      performance.now() - lastScrollAt > IDLE_SIT_AFTER * 1000
    ) {
      var wEdge = nearestLedgeEdgeX();
      var wDist = Math.abs(wEdge - alex.x);
      if (wDist >= 14 && wDist <= 120) {
        // a ledge edge is close: amble over so the seated legs dangle
        alex.target = null;
        alex.targetX = wEdge;
        alex.pace = 120;
        setState("run");
      } else {
        // sit right here until the cursor moves or a scroll happens
        alex.waitSit = true;
        alex.sitUntil = Infinity;
        setState("sit");
      }
      return;
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

    if (alex.state === "idle" && alex.idleFor > alex.nextWanderAt && !navDucking()) {
      // unhurried: he keeps still far more than he roams
      alex.nextWanderAt = alex.idleFor + 11 + Math.random() * 8;
      alex.pace = RUN_BASE();
      // sometimes, parkour to a neighbouring ledge for fun
      if (Math.random() < 0.08) {
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
      // otherwise stroll a short stretch of the current ledge
      alex.target = null;
      alex.targetX = spotOn(
        alex.platform,
        alex.x + (Math.random() < 0.5 ? -1 : 1) * (40 + Math.random() * 70)
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

  // jumps may not start under a low ceiling — the arc would clip the
  // text overhead. From a duck zone he walks to the nearest standing
  // spot first (or de-rezzes if the zone has boxed him in entirely).
  function launchOrWalkOut(t) {
    var pl = alex.platform;
    if (pl && duckAt(pl, alex.x)) {
      if (pl.stand && pl.stand.length) {
        var out = snapToIvs(pl.stand, alex.x);
        if (Math.abs(out - alex.x) > 4) {
          alex.targetX = out; // keep running (crouched) toward clear air
          return;
        }
      } else {
        blipTo(t);
        return;
      }
    }
    launchToward(t);
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

      case "sit": {
        // seated waiting for an absent visitor: any input wakes him
        if (
          alex.waitSit &&
          (cursorRecent(600) || performance.now() - lastScrollAt < 600)
        ) {
          alex.waitSit = false;
          alex.idleFor = 0;
          alex.nextWanderAt = 2 + Math.random() * 3;
          setState("idle");
          break;
        }
        var sitHover = hoverPlatform();
        if (sitHover === alex.platform && sitHover) {
          // the visitor is still on this box: keep him company
          alex.sitUntil = Math.max(alex.sitUntil, clock + 1.2);
        } else if (sitHover) {
          // they moved to another box: get up and let think() route him
          alex.idleFor = 0;
          setState("idle");
          break;
        }
        if (clock > alex.sitUntil) {
          alex.idleFor = 0;
          alex.nextWanderAt = 1;
          setState("idle");
        }
        break;
      }

      case "inspect":
        // crouch over the panel and poke at it; green bits fly
        if (alex.animT % 0.28 < dt) {
          alex.dust.push({
            x: alex.x + alex.dir * (6 + Math.random() * 6),
            y: alex.y - 8 - Math.random() * 10,
            vx: alex.dir * (10 + Math.random() * 30),
            vy: -30 - Math.random() * 50,
            t: 0,
            c: "#00e05a", // digital dust stays terminal green
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
        // under a low ceiling he shuffles: no sprinting through duck zones
        if (duckAt(alex.platform, alex.x)) sp *= DUCK_PACE;
        // the sticky header is sliding in overhead: freeze for a beat
        // and look up before crouching on (movement resumes below)
        if (navNoticing()) {
          if (alex.state === "run") think(dt);
          break;
        }
        var gap = goal - alex.x;
        // dir hysteresis + a stride clamp: at sprint speed one frame's
        // step is wider than the settle band, and an uncapped stride
        // made him overshoot and vibrate around the goal
        if (Math.abs(gap) > 1) alex.dir = gap > 0 ? 1 : -1;
        alex.x += alex.dir * Math.min(sp * dt, Math.abs(gap));

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
            launchOrWalkOut(t);
            break;
          }
          alex.x = Math.max(pl.x1 + 2, Math.min(pl.x2 - 2, alex.x));
        }
        if (Math.abs(alex.x - goal) < 6) {
          alex.x = Math.max(pl ? pl.x1 + 2 : alex.x, Math.min(pl ? pl.x2 - 2 : alex.x, goal));
          if (alex.target && alex.target !== alex.platform) {
            var t2 = alex.target;
            if (t2.y < alex.y - 12) {
              setState("climb");
            } else {
              launchOrWalkOut(t2);
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
        // A pass-through descent ignores every ledge except its target
        // until he lands on it or falls past it (then normal rules
        // resume as the safety net).
        if (alex.passThroughTarget && alex.y > alex.passThroughTarget.y + 40) {
          alex.passThroughTarget = null;
        }
        var ban =
          alex.target && alex.jumpFrom !== alex.target ? alex.jumpFrom : null;
        var landOn = platformAt(
          alex.x,
          alex.y - 20,
          Math.max(26, alex.vy * dt * 2),
          Math.abs(alex.vx * dt) + 4,
          ban,
          alex.passThroughTarget
        );
        if (landOn && alex.y >= landOn.y - 2) {
          alex.y = landOn.y;
          alex.platform = landOn;
          alex.target = null;
          alex.jumpFrom = null;
          alex.passThroughTarget = null;
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
    // under a low ceiling every grounded pose becomes the crouch: a
    // slow bob while still, a quicker duckA/duckB shuffle while moving.
    // The sticky header sliding in overhead counts as a low ceiling too
    // (after the notice beat — he first freezes and looks up).
    if (
      (alex.state === "idle" ||
        alex.state === "run" ||
        alex.state === "present" ||
        alex.state === "wave") &&
      (duckAt(alex.platform, alex.x) || navDucking())
    ) {
      return Math.floor(t / (alex.state === "run" ? 0.16 : 0.5)) % 2 ? "duckB" : "duckA";
    }
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
        return alex.vy < -40 || alex.y < (alex.platform ? alex.platform.y - 2 : alex.y)
          ? (alex.cheerStyle === "Y" ? "cheerY" : "jump")
          : "idleA";
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
      if (row !== undefined && navLooking()) {
        // the sticky header is sliding in overhead: eyes up
        ctx.fillStyle = PAL.s;
        ctx.fillRect(8, row, 1, 1);
        ctx.fillRect(11, row, 1, 1);
        ctx.fillStyle = PAL.e;
        ctx.fillRect(8, row - 1, 1, 1);
        ctx.fillRect(11, row - 1, 1, 1);
      } else if (row !== undefined && cursorRecent(6000)) {
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
    if (scrollY !== lastScrollY) {
      lastScrollAt = performance.now();
      hover.el = null; // pointerover does not refire on scroll: hover is stale
    }
    lastScrollY = scrollY;
    scrollVel = scrollVel * 0.8 + inst * 0.2;

    touchAttend(ts); // touch analogue of hover attention (no-op with a mouse)
    navTick(); // does the sticky header overlap him this frame?
    step(dt);
    widgetPerchTick(); // after physics: the pin to the fixed card wins the frame

    // render throttle: deep idle (nothing moving, nobody interacting)
    // paints at ~12fps instead of 60 — breathing still reads fine
    var deepIdle =
      (alex.state === "idle" || alex.state === "sit") &&
      !alex.dust.length &&
      !cursorRecent(3000) &&
      !navLooking() &&
      performance.now() - lastScrollAt > 3000;
    if (!deepIdle || tick % 5 === 0) render();

    raf = requestAnimationFrame(loop);
  }

  function start() {
    if (!enabled) return;
    applyScale();
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
      applyScale(); // rotation / resize may have changed the sprite scale
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

  // a brief glow on the name so a tap visibly registers before the
  // sprite blips in (and a shorter fade-out when disabling). Inline
  // styles are restored afterwards — no permanent DOM/style pollution.
  function pulseName(on) {
    var name = document.querySelector("#main-header h1");
    if (!name) return;
    var prevTransition = name.style.transition;
    var prevShadow = name.style.textShadow;
    name.style.transition = "text-shadow 0.15s ease";
    name.style.textShadow = on
      ? "0 0 18px rgba(0,224,90,0.9)"
      : "0 0 8px rgba(0,224,90,0.4)";
    setTimeout(function () {
      name.style.textShadow = prevShadow;
      setTimeout(function () {
        name.style.transition = prevTransition;
        if (!name.getAttribute("style")) name.removeAttribute("style");
      }, 300);
    }, on ? 600 : 250);
  }

  // the easter egg: clicking/tapping Alexander's name in the header (a
  // tap fires a normal click event) or the portrait (desktop only)
  // toggles pixel mode. The timestamp guard swallows any synthetic
  // second click a touch tap might produce.
  var lastToggleAt = 0;

  function installEasterEgg() {
    var triggers = [];
    var name = document.querySelector("#main-header h1");
    if (name) triggers.push(name);
    var portrait = document.querySelector('#main-header img[alt="Alexander Russell"]');
    if (portrait) triggers.push(portrait.closest(".group") || portrait);
    triggers.forEach(function (el) {
      el.addEventListener("click", function () {
        var now = performance.now();
        if (now - lastToggleAt < 400) return;
        lastToggleAt = now;
        var on = !enabled;
        storeMode(on);
        pulseName(on);
        if (on) {
          enable();
        } else {
          disable();
        }
      });
    });
  }

  function enable() {
    if (enabled) return;
    appendCanvas();
    enabled = true;
    running = true;
    resizeObserver.observe(document.body);
    start();
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
  }

  window.addEventListener("resize", scheduleRebuild);
  window.addEventListener("orientationchange", scheduleRebuild);
  window.addEventListener("load", scheduleRebuild);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleRebuild);

  document.addEventListener("visibilitychange", function () {
    if (!enabled) return;
    if (document.hidden) {
      // sit tight where he is until the visitor comes back; he stands
      // again a beat after the tab returns (the clock is frozen while
      // hidden, so the timer only runs once the loop resumes)
      if (
        alex.platform &&
        (alex.state === "idle" ||
          alex.state === "run" ||
          alex.state === "present" ||
          alex.state === "wave")
      ) {
        alex.target = null;
        alex.dir = scrollX + innerWidth / 2 >= alex.x ? 1 : -1; // face the viewport centre
        alex.sitUntil = clock + 0.4;
        setState("sit");
        render();
      }
      running = false;
    } else {
      running = true;
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(loop);
      }
    }
  });

  // the voice widget broadcasts its call state; the first non-idle
  // state after idle means a call is connecting — worth a cheer. The
  // widget is position:fixed, so that is all he can do about it. If the
  // widget never loads this listener simply never fires.
  var voiceState = "idle";
  addEventListener("alexvoice:state", function (e) {
    var s = e && e.detail && e.detail.state ? String(e.detail.state) : "";
    if (!s) return;
    var prev = voiceState;
    voiceState = s;
    if (!enabled || prev !== "idle" || s === "idle") return;
    var grounded =
      alex.platform &&
      (alex.state === "idle" ||
        alex.state === "run" ||
        alex.state === "wave" ||
        alex.state === "sit" ||
        alex.state === "present" ||
        alex.state === "land");
    if (grounded) {
      alex.hops = 0;
      alex.vy = -300;
      setState("cheer");
    }
  });

  /* ------------------------------------------------------------------
   * 12b. THE WIDGET PERCH — the voice widget card is position:fixed and
   * floats above everything (z-index 9999 vs his 45), so standing
   * behind it means vanishing. When the open card would cover him, he
   * climbs on top and sits on its edge instead — and because the ledge
   * is re-pinned every frame, he rides the card while the visitor
   * scrolls. When the card closes he simply drops back into the page
   * and the normal landing rules catch him.
   * ------------------------------------------------------------------ */
  var perch = null; // synthetic ledge glued to the card; never in platforms[]

  function widgetCardRect() {
    var host = document.querySelector("alex-voice-widget");
    if (!host || !host.shadowRoot) return null;
    var card = host.shadowRoot.querySelector(".card");
    if (!card || card.hidden) return null;
    var r = card.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return null;
    return r;
  }

  function pinPerch(r) {
    perch.x1 = r.left + scrollX;
    perch.x2 = r.right + scrollX;
    perch.y = r.top + scrollY + 1;
    perch.iv = [[perch.x1 + 10, perch.x2 - 10]];
    perch.stand = perch.iv;
    alex.platform = perch;
    alex.target = null;
    alex.jumpFrom = null;
    alex.passThroughTarget = null;
    alex.vx = 0;
    alex.vy = 0;
    alex.x = Math.min(Math.max(alex.x, perch.x1 + 16), perch.x2 - 16);
    alex.y = perch.y;
    alex.sitUntil = clock + 0.5; // refreshed every frame: he stays seated
    if (alex.state !== "sit") setState("sit");
  }

  function widgetPerchTick() {
    if (!enabled) return;
    var r = widgetCardRect();
    if (perch) {
      if (!r) {
        // card closed: back into the world, gravity does the rest
        perch = null;
        if (alex.platform && alex.platform.kind === "widget") {
          alex.platform = null;
          alex.vy = 0;
          setState("fall");
        }
        return;
      }
      pinPerch(r);
      return;
    }
    if (!r) return;
    // only whisk him up from settled ground states; a jump arc that
    // passes behind the card is a blink, not a burial
    var grounded =
      alex.state === "idle" ||
      alex.state === "run" ||
      alex.state === "wave" ||
      alex.state === "sit" ||
      alex.state === "present" ||
      alex.state === "inspect" ||
      alex.state === "land";
    if (!grounded) return;
    var x1 = r.left + scrollX - 4;
    var x2 = r.right + scrollX + 4;
    var y1 = r.top + scrollY - 4;
    var y2 = r.bottom + scrollY + 4;
    var covered = alex.x > x1 && alex.x < x2 && alex.y > y1 && alex.y - CH < y2;
    if (!covered) return;
    perch = { el: null, kind: "widget", x1: 0, x2: 0, y: 0, iv: [], duck: [], stand: [] };
    pinPerch(r);
  }

  function boot() {
    // the easter egg always installs — even under prefers-reduced-motion,
    // where he simply never auto-starts (a stored opt-in was an explicit
    // tap, so it is honoured; a fresh tap is an informed opt-in too)
    installEasterEgg();
    if (storedModeOn()) enable();
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    boot();
  } else {
    document.addEventListener("DOMContentLoaded", boot);
  }
})();
