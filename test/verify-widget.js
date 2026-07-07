// Headless behavioral suite for the voice widget. Run from anywhere:
//   node test/verify-widget.js
// Spawns its own static server for the repo root; needs a Chromium from
// Playwright (CI installs one; locally it falls back to the ms-playwright
// cache). Exits non-zero on any failed check.
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 8129;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const file = path.normalize(path.join(ROOT, url === '/' ? 'index.html' : url));
      const rel = path.relative(ROOT, file);
      if (rel.startsWith('..') || path.isAbsolute(rel)
          || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end(); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

async function launchBrowser() {
  const { chromium } = require('playwright-core');
  try {
    return await chromium.launch();
  } catch (e) {
    // Local dev fallback: the browser cached by other Playwright installs.
    const shell = path.join(process.env.HOME || '',
      'Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell');
    return chromium.launch({ executablePath: shell });
  }
}

let fails = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
  if (!ok) fails++;
};

(async () => {
  const srv = await serve();
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!document.querySelector('alex-voice-widget'));

  const info = async () => page.evaluate(() => {
    const r = document.querySelector('alex-voice-widget').shadowRoot;
    const card = r.querySelector('.card');
    const tr = r.querySelector('.transcript');
    return {
      state: card.getAttribute('data-state'),
      trDisplay: getComputedStyle(tr).display,
      msgs: [...r.querySelectorAll('.m')].map((m) => ({ cls: m.className, text: m.textContent })),
    };
  });

  // Start screen: transcript hidden while idle.
  await page.evaluate(() => {
    document.querySelector('alex-voice-widget').shadowRoot.querySelector('.launcher').click();
  });
  let s = await info();
  check('idle: transcript hidden', s.trDisplay === 'none', s.trDisplay);

  // Text call: greeting appears, transcript visible.
  await page.evaluate(() => {
    document.querySelector('alex-voice-widget').shadowRoot.querySelector('.btn-text').click();
  });
  await page.waitForTimeout(400);
  s = await info();
  check('text call: transcript visible + greeting',
    s.trDisplay !== 'none' && s.msgs.some((m) => m.cls === 'm agent'));

  // Stub the LLM round trip: this server has no /api/chat, and its instant
  // failure would inject sys lines between scenarios.
  await page.evaluate(() => { document.querySelector('alex-voice-widget').runChat = () => {}; });

  // Consolidation: two spoken commits, no reply between -> one placeholder.
  await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    el.commitUtterance('first spoken part', true);
    el.commitUtterance('second spoken part', true);
  });
  s = await info();
  const vc = s.msgs.filter((m) => m.cls.includes('voice')).length;
  check('two commits, no reply -> one placeholder', vc === 1, `voice=${vc}`);

  // Live-indicator flip: interim reuses the placeholder, no stacked bubble.
  const flip = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    el.setInterim('resuming speech');
    const r = el.shadowRoot;
    const during = [...r.querySelectorAll('.m')].map((m) => m.textContent);
    const interimBubbles = r.querySelectorAll('.m.interim').length;
    el.clearInterim();
    const after = [...r.querySelectorAll('.m')].map((m) => m.textContent);
    return { during, interimBubbles, after };
  });
  check('interim reuses placeholder (no stacked bubble)',
    flip.interimBubbles === 0 && flip.during.includes('Listening…'),
    `interims=${flip.interimBubbles}`);
  check('clearInterim restores Voice message',
    !flip.after.includes('Listening…') && flip.after.includes('Voice message'));

  // Agent reply closes the turn: fresh interim bubble and fresh placeholder.
  const post = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    el.addMsg('agent', 'a reply');
    el.setInterim('new turn speech');
    const r = el.shadowRoot;
    const interimBubbles = r.querySelectorAll('.m.interim').length;
    el.clearInterim();
    el.commitUtterance('third spoken part', true);
    return { interimBubbles, voice: r.querySelectorAll('.m.user.voice').length };
  });
  check('after reply: interim gets its own bubble', post.interimBubbles === 1, `interims=${post.interimBubbles}`);
  check('after reply: new placeholder created', post.voice === 2, `voice=${post.voice}`);

  // A reply landing while the placeholder shows Listening… restores it.
  const orphan = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    el.setInterim('speaking again');
    const ph = el.pendingVoiceEl;
    el.addMsg('agent', 'reply lands mid-speech');
    return { phText: ph ? ph.textContent : 'GONE', released: el.pendingVoiceEl === null };
  });
  check('reply mid-speech: placeholder label restored + released',
    orphan.phText === 'Voice message' && orphan.released, JSON.stringify(orphan));

  // History carries every utterance; typed stays verbatim.
  const tail = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    el.clearInterim();
    el.commitUtterance('typed message', false);
    return {
      hist: el.history.filter((h) => h.role === 'user').length,
      typed: [...el.shadowRoot.querySelectorAll('.m')].some((m) => m.textContent === 'typed message'),
    };
  });
  check('history keeps every utterance', tail.hist === 4, `entries=${tail.hist}`);
  check('typed still verbatim', tail.typed);

  await browser.close();
  srv.close();
  console.log(fails ? `\n${fails} FAILURES` : '\nALL CHECKS PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
