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

  // --- Noise hardening (city-test fixes) ---

  // Pending-turn gate: background chatter must not abort an in-flight turn.
  const gate = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    const dg = (transcript, confidence, speechFinal) => el.onDgMessage(JSON.stringify({
      type: 'Results', is_final: true, speech_final: speechFinal,
      channel: { alternatives: [{ transcript, confidence }] },
    }));
    const before = { id: el.utteranceId, hist: el.history.length, turn: !!el.turn };
    dg('hey', 0.95, true);                        // one word: blocked
    const afterShort = { id: el.utteranceId, turn: !!el.turn };
    dg('some random street chatter', 0.2, true);  // low confidence: blocked
    const afterLowConf = { id: el.utteranceId, turn: !!el.turn };
    dg('tell me about the pricing', 0.95, true);  // real speech: supersedes
    const afterReal = { id: el.utteranceId, hist: el.history.length };
    return { before, afterShort, afterLowConf, afterReal };
  });
  check('pending turn survives 1-word noise final',
    gate.before.turn && gate.afterShort.id === gate.before.id && gate.afterShort.turn,
    JSON.stringify(gate.afterShort));
  check('pending turn survives low-confidence chatter',
    gate.afterLowConf.id === gate.before.id && gate.afterLowConf.turn);
  check('real speech still supersedes pending turn',
    gate.afterReal.id > gate.before.id && gate.afterReal.hist === gate.before.hist + 1,
    JSON.stringify(gate.afterReal));

  // Noisy endpoint: a stable interim commits even when ambient RMS never drops.
  const noisy = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    el.interrupt('test');                 // clear the in-flight turn → listening
    el.voiceMode = true;
    el.micRms = () => 0.4;                // hot mic: the silence gate never opens
    el.setInterim('force commit works', 0.9);
    el.interimAt = performance.now() - 4000;
    const before = el.history.length;
    el.tick();
    return {
      committed: el.history.length === before + 1
        && el.history[el.history.length - 1].content === 'force commit works',
      thinking: el.state === 'thinking',
    };
  });
  check('noisy environment: stable interim force-commits', noisy.committed && noisy.thinking,
    JSON.stringify(noisy));

  // Manual escape: tapping the orb while listening sends the live interim.
  const tap = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    el.interrupt('test');
    el.setInterim('tap sent this', 0.9);
    el.shadowRoot.querySelector('.stage').click();
    return {
      sent: el.history[el.history.length - 1].content === 'tap sent this',
      thinking: el.state === 'thinking',
    };
  });
  check('orb tap force-sends the live interim', tap.sent && tap.thinking, JSON.stringify(tap));

  // Barge-in gates: word count and confidence filter street chatter.
  const barge = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    el.agentAudioActive = () => true;     // simulate the agent mid-reply
    const attempt = (text, conf) => {
      el.bargeHits = 99;
      el.interimText = text;
      el.interimAt = performance.now();
      el.interimConf = conf;
      const before = el.utteranceId;
      el.maybeBargeIn(text);
      return el.utteranceId > before;
    };
    const twoWords = attempt('nice weather', 0.9);   // 2 words, not a control intent
    const lowConf = attempt('random background chatter words', 0.3);
    const real = attempt('okay stop talking now', 0.9);
    delete el.agentAudioActive;
    return { twoWords, lowConf, real };
  });
  check('barge-in ignores 2-word interim', !barge.twoWords);
  check('barge-in ignores low-confidence interim', !barge.lowConf);
  check('barge-in fires on real confident speech', barge.real);

  // --- Agent bubble URL rendering ---
  const links = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    const bubble = (text) => {
      const m = el.addMsg('agent', text);
      return {
        text: m.textContent,
        anchors: [...m.querySelectorAll('a')].map((a) => ({ href: a.getAttribute('href'), label: a.textContent })),
      };
    };
    return {
      plain: bubble('Check atvora.com/sample or email me@alexrussell.io. More at https://alexrussell.io.'),
      spoken: bubble('It lives at atvora dot com slash sample today.'),
      spokenDeep: bubble('Find him at linkedin.com slash in slash alexrussell dash tech.'),
      spokenVariants: bubble('Or atvora dot com forward slash sample, and alexrussell hyphen tech dot io.'),
      fieldExact: bubble('You can find him at linkedin.com, slash in, alexrussell dash tech.'),
      prose: bubble('Check atvora dot com slash sample, and let me know.'),
      md: bubble('See [the sample](https://atvora.com/sample) here.'),
      evil: bubble('Do not [click](javascript:alert(1)) this.'),
    };
  });
  check('bare domains, emails, and URLs become anchors',
    links.plain.anchors.length === 3
      && links.plain.anchors[0].href === 'https://atvora.com/sample'
      && links.plain.anchors[1].href === 'mailto:me@alexrussell.io'
      && links.plain.anchors[2].href === 'https://alexrussell.io',
    JSON.stringify(links.plain.anchors));
  check('trailing period stays outside the link',
    links.plain.text.includes('https://alexrussell.io.'), links.plain.text);
  check('spoken-form slip folds back to a written link',
    links.spoken.anchors.length === 1
      && links.spoken.anchors[0].href === 'https://atvora.com/sample'
      && links.spoken.text.includes('atvora.com/sample'),
    JSON.stringify(links.spoken));
  check('spoken slash/dash deep link folds back to a written link',
    links.spokenDeep.anchors.length === 1
      && links.spokenDeep.anchors[0].href === 'https://linkedin.com/in/alexrussell-tech',
    JSON.stringify(links.spokenDeep));
  check('"forward slash" and "hyphen" variants fold back too',
    links.spokenVariants.anchors.length === 2
      && links.spokenVariants.anchors[0].href === 'https://atvora.com/sample'
      && links.spokenVariants.anchors[1].href === 'https://alexrussell-tech.io',
    JSON.stringify(links.spokenVariants));
  check('exact field transcript folds back fully',
    links.fieldExact.anchors.length === 1
      && links.fieldExact.anchors[0].href === 'https://linkedin.com/in/alexrussell-tech'
      && links.fieldExact.text.includes('linkedin.com/in/alexrussell-tech.'),
    JSON.stringify(links.fieldExact));
  check('comma continuation never swallows prose',
    links.prose.text === 'Check atvora.com/sample, and let me know.'
      && links.prose.anchors.length === 1
      && links.prose.anchors[0].href === 'https://atvora.com/sample',
    JSON.stringify(links.prose));

  // --- Speech layer (api/tts.js sanitizeText): symbols become words ---
  const { sanitizeText } = await import('../api/tts.js');
  check('TTS speaks dots, slashes, and hyphens in addresses',
    sanitizeText('See linkedin.com/in/alexrussell-tech.')
      === 'See linkedin dot com slash in slash alexrussell dash tech.',
    sanitizeText('See linkedin.com/in/alexrussell-tech.'));
  check('TTS speaks emails as at/dot',
    sanitizeText('Mail me@alexrussell.io today')
      === 'Mail me at alexrussell dot io today',
    sanitizeText('Mail me@alexrussell.io today'));
  check('markdown link renders label + href',
    links.md.anchors.length === 1
      && links.md.anchors[0].href === 'https://atvora.com/sample'
      && links.md.anchors[0].label === 'the sample',
    JSON.stringify(links.md.anchors));
  check('javascript: URL never becomes an anchor', links.evil.anchors.length === 0,
    JSON.stringify(links.evil.anchors));

  // Control intents: a bare "stop" must still interrupt despite the word gate.
  const control = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    el.commitUtterance('question before control tests', true);   // turn in flight
    el.agentAudioActive = () => true;
    el.bargeHits = 99;
    el.interimText = 'stop';
    el.interimAt = performance.now();
    el.interimConf = 0.9;
    const before = el.utteranceId;
    el.maybeBargeIn('stop');
    const stopBarged = el.utteranceId > before;
    delete el.agentAudioActive;
    return { stopBarged };
  });
  check('barge-in: bare "stop" interrupts (control intent)', control.stopBarged);

  // Control intents pass the pending gate ("wait" during thinking).
  const pendingControl = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    el.commitUtterance('another question', true);
    const before = { id: el.utteranceId, hist: el.history.length };
    el.onDgMessage(JSON.stringify({
      type: 'Results', is_final: true, speech_final: true,
      channel: { alternatives: [{ transcript: 'wait', confidence: 0.95 }] },
    }));
    return { superseded: el.utteranceId > before.id, hist: el.history.length - before.hist };
  });
  check('"wait" supersedes a pending turn (control intent)',
    pendingControl.superseded && pendingControl.hist === 1, JSON.stringify(pendingControl));

  // UtteranceEnd: the word-timing endpoint commits accumulated finals in noise.
  const uttEnd = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    el.interrupt('test');       // clear the in-flight turn → listening
    const seg = (t) => el.onDgMessage(JSON.stringify({
      type: 'Results', is_final: true, speech_final: false,
      channel: { alternatives: [{ transcript: t, confidence: 0.9 }] },
    }));
    seg('what does alexander');
    seg('charge for a build');
    const before = el.history.length;
    el.onDgMessage(JSON.stringify({ type: 'UtteranceEnd', last_word_end: 7.1 }));
    return {
      committed: el.history.length === before + 1
        && el.history[el.history.length - 1].content === 'what does alexander charge for a build',
      thinking: el.state === 'thinking',
    };
  });
  check('UtteranceEnd commits accumulated finals (noise endpoint)',
    uttEnd.committed && uttEnd.thinking, JSON.stringify(uttEnd));

  // UtteranceEnd keeps segment confidence: mid-confidence chatter (above the
  // commit floor, below the pending floor) must not abort an in-flight turn.
  const uttEndGate = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    // turn already in flight from the previous check (state: thinking)
    el.onDgMessage(JSON.stringify({
      type: 'Results', is_final: true, speech_final: false,
      channel: { alternatives: [{ transcript: 'some random street chatter', confidence: 0.5 }] },
    }));
    const before = { id: el.utteranceId, turn: !!el.turn };
    el.onDgMessage(JSON.stringify({ type: 'UtteranceEnd', last_word_end: 9.2 }));
    return { before, id: el.utteranceId, turn: !!el.turn };
  });
  check('UtteranceEnd: mid-confidence chatter cannot abort a pending turn',
    uttEndGate.before.turn && uttEndGate.id === uttEndGate.before.id && uttEndGate.turn,
    JSON.stringify(uttEndGate));

  // >> with an empty field sends the live interim (twin of the orb tap).
  const btnSend = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    el.interrupt('test');
    el.setInterim('send via button', 0.9);
    el.field.value = '';
    el.shadowRoot.querySelector('.inputrow')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return {
      sent: el.history[el.history.length - 1].content === 'send via button',
      thinking: el.state === 'thinking',
    };
  });
  check('>> with empty field sends the live interim', btnSend.sent && btnSend.thinking,
    JSON.stringify(btnSend));

  // Repeated noise drops nudge the visitor toward typing, once per call.
  const nudge = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    el.callNoiseDrops = 0;
    el.noiseNudgeShown = false;
    el.noteNoiseDrop();
    el.noteNoiseDrop();
    el.noteNoiseDrop();
    el.noteNoiseDrop();
    const msgs = [...el.shadowRoot.querySelectorAll('.m.sys')]
      .filter((m) => m.textContent.includes('typing works too'));
    return { shown: msgs.length >= 1, once: el.noiseNudgeShown };
  });
  check('noise nudge appears after repeated drops (once)', nudge.shown && nudge.once,
    JSON.stringify(nudge));

  await browser.close();
  srv.close();
  console.log(fails ? `\n${fails} FAILURES` : '\nALL CHECKS PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
