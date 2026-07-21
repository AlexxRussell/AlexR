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

  // --- Sentence splitter: chunk boundaries must not fall inside a number ---
  // The eager first flush cuts at the first comma, so a price written with a
  // thousands separator once split into "$2," and "950" and reached the ear as
  // "two dollars ... nine hundred fifty". sanitizeText is correct either way,
  // so only a splitter-level check catches this.
  // Deltas are fed one at a time, as the SSE stream really delivers them: a
  // lookahead cannot see a digit that has not arrived yet, so a single
  // whole-sentence call would pass while the streamed case still splits.
  const split = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    const stream = (deltas) => {
      const chunks = [];
      el.queueSentence = (turn, t) => chunks.push(t);
      const turn = { pending: '', flushed: false, sentences: [] };
      for (const d of deltas) { turn.pending += d; el.splitPending(turn, false); }
      el.splitPending(turn, true);
      delete el.queueSentence;
      return chunks;
    };
    return {
      whole: stream(['The Sprint package starts at $2,950 and takes 5 working days.']),
      commaEdge: stream(['The Sprint package starts at $2,', '950 and takes 5 working days.']),
      twelfth: stream(['Alexander can deliver a focused Sprint integration for your team from $2',
        ',950 and it ships fast.']),
      digitEdge: stream(['That plan saves roughly 2', '5 hours a week for the whole team here.']),
      // Alphanumeric knowledge-base terms are tokens too: cutting "CS50" into
      // "CS" + "50" speaks as "C S" then "fifty". Needs 12 words before the
      // term, or the eager flush never fires and the case proves nothing.
      course: stream(['Alexander really finished the whole introductory computer science course known online as CS50',
        "'s track."]),
      // The digit may not have streamed yet, so the token has to be held on
      // shape alone: these deltas break before the first digit of each term.
      ga4: stream(['Alexander really finished the whole introductory computer science course and analytics work on GA',
        '4 today.']),
      n8n: stream(['Alexander really finished the whole introductory computer science course and automation work on n',
        '8n today.']),
      grade: stream(['Alexander really finished the whole introductory computer science course and earned a grade A',
        '+ today.']),
      clause: stream(['Alexander builds agentic systems, and he ships them fast in days.']),
      big: stream(['That pipeline processed 1,', '250,000 records last year without a hitch.']),
    };
  });
  // No chunk may end on a partial number or begin with the rest of one.
  const intact = (chunks, full) => chunks.some((c) => c.includes(full))
    && !chunks.some((c) => /[$\d][\d.,]*$/.test(c.trim()))
    && !chunks.some((c) => /^[,.]?\d/.test(c.trim()));
  check('price intact when delivered whole', intact(split.whole, '$2,950'),
    JSON.stringify(split.whole));
  check('price intact when a delta ends on its comma', intact(split.commaEdge, '$2,950'),
    JSON.stringify(split.commaEdge));
  check('price intact when it is the twelfth word', intact(split.twelfth, '$2,950'),
    JSON.stringify(split.twelfth));
  check('bare number intact when a delta splits its digits', intact(split.digitEdge, '25'),
    JSON.stringify(split.digitEdge));
  check('multi-group number intact across deltas', intact(split.big, '1,250,000'),
    JSON.stringify(split.big));
  check('alphanumeric term intact across deltas',
    split.course.some((c) => c.includes("CS50's")) && !split.course.some((c) => /^\d/.test(c.trim())),
    JSON.stringify(split.course));
  check('term intact when a delta breaks before its digit', intact(split.ga4, 'GA4'),
    JSON.stringify(split.ga4));
  check('leading-letter term intact across deltas', intact(split.n8n, 'n8n'),
    JSON.stringify(split.n8n));
  check('grade intact when a delta breaks before its plus', intact(split.grade, 'A+'),
    JSON.stringify(split.grade));
  // The latency feature itself must still work.
  check('eager comma flush still fires on a real clause comma',
    split.clause[0] === 'Alexander builds agentic systems,', JSON.stringify(split.clause));

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

  // --- Barge-in silences the voice, not the text ---
  // Field incident: a (false) barge-in aborted the chat stream mid-delta and
  // the bubble stranded a half sentence ("He carries a"). An interrupt must
  // stop the audio instantly but let the reply finish typing; the completed
  // text (not the heard fragment) is what history carries forward.
  const soft = await page.evaluate(async () => {
    const el = document.querySelector('alex-voice-widget');
    delete el.runChat;                          // restore the real streaming loop
    let push, closeStream;
    const body = new ReadableStream({
      start(c) {
        push = (s) => c.enqueue(new TextEncoder().encode(s));
        closeStream = () => c.close();
      },
    });
    const realFetch = window.fetch.bind(window);
    window.fetch = (url, opts) => String(url).includes('/api/chat')
      ? Promise.resolve(new Response(body, {
          status: 200, headers: { 'Content-Type': 'text/event-stream' },
        }))
      : realFetch(url, opts);
    el.commitUtterance('tell me about alexander', true);
    const turn = el.turn;
    push('data: {"d":"He is sharp. He carries a"}\n\n');
    await new Promise((r) => setTimeout(r, 60));
    const midText = turn.el ? turn.el.textContent : 'NO BUBBLE';
    el.interrupt('speech');                     // barge-in mid-stream
    const cutAtInterrupt = turn.el.classList.contains('cut');
    const stateAfter = el.state;
    push('data: {"d":" deep respect for plain language."}\n\n');
    push('data: {"done":true}\n\n');
    closeStream();
    await new Promise((r) => setTimeout(r, 100));
    window.fetch = realFetch;
    el.runChat = () => {};                      // re-stub for any later scenario
    const hist = el.history[el.history.length - 1];
    return {
      midText,
      cutAtInterrupt,
      stateAfter,
      finalText: turn.el.textContent,
      cutAfter: turn.el.classList.contains('cut'),
      histRole: hist.role,
      histContent: hist.content,
    };
  });
  check('barge-in mid-stream: bubble finishes typing',
    soft.midText === 'He is sharp. He carries a'
      && soft.finalText === 'He is sharp. He carries a deep respect for plain language.',
    JSON.stringify({ mid: soft.midText, final: soft.finalText }));
  check('finished bubble is not marked cut (at interrupt or after)',
    !soft.cutAfter && !soft.cutAtInterrupt,
    `atInterrupt=${soft.cutAtInterrupt} after=${soft.cutAfter}`);
  check('interrupt still frees the mic immediately', soft.stateAfter === 'listening', soft.stateAfter);
  check('history carries the completed reply',
    soft.histRole === 'assistant' && soft.histContent.includes('plain language.'),
    JSON.stringify({ role: soft.histRole, content: soft.histContent }));

  // --- Detached / error-path edge cases (streamed through the real runChat) ---
  // Shared harness: each __newChat() arms one controllable SSE response for
  // the next /api/chat fetch, so scenarios can interleave two live streams.
  await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    delete el.runChat;
    const realFetch = window.fetch.bind(window);
    window.__realFetch = realFetch;
    window.__chatQueue = [];
    window.fetch = (url, opts) => {
      if (String(url).includes('/api/chat') && window.__chatQueue.length) {
        const ctl = window.__chatQueue.shift();
        const stream = new ReadableStream({ start(c) { ctl.attach(c); } });
        return Promise.resolve(new Response(stream, {
          status: 200, headers: { 'Content-Type': 'text/event-stream' },
        }));
      }
      return realFetch(url, opts);
    };
    window.__newChat = () => {
      const ctl = { queued: [], c: null };
      ctl.attach = (c) => { ctl.c = c; for (const b of ctl.queued) c.enqueue(b); ctl.queued = []; };
      ctl.push = (s) => {
        const b = new TextEncoder().encode(s);
        if (ctl.c) ctl.c.enqueue(b); else ctl.queued.push(b);
      };
      ctl.close = () => { try { ctl.c.close(); } catch (e) { /* done */ } };
      ctl.fail = () => { try { ctl.c.error(new Error('net')); } catch (e) { /* done */ } };
      window.__chatQueue.push(ctl);
      return ctl;
    };
  });

  // A detached stream that DIES must mark the bubble cut and keep the partial.
  const detachedFail = await page.evaluate(async () => {
    const el = document.querySelector('alex-voice-widget');
    const s = window.__newChat();
    el.commitUtterance('question for a doomed stream', true);
    const turn = el.turn;
    s.push('data: {"d":"Partial answer that will di"}\n\n');
    await new Promise((r) => setTimeout(r, 60));
    el.interrupt('speech');
    s.fail();
    await new Promise((r) => setTimeout(r, 80));
    const hist = el.history[el.history.length - 1];
    return {
      cut: turn.el.classList.contains('cut'),
      text: turn.el.textContent,
      histContent: hist.role === 'assistant' ? hist.content : 'WRONG ROLE',
    };
  });
  check('detached stream failure: bubble marked cut, partial kept',
    detachedFail.cut && detachedFail.text === 'Partial answer that will di'
      && detachedFail.histContent === 'Partial answer that will di',
    JSON.stringify(detachedFail));

  // Barge-in with an immediate new question: old bubble finishes typing while
  // the new turn streams its own; history keeps conversational order.
  const concurrent = await page.evaluate(async () => {
    const el = document.querySelector('alex-voice-widget');
    const s1 = window.__newChat();
    el.commitUtterance('first question', true);
    const turn1 = el.turn;
    s1.push('data: {"d":"First answer part one."}\n\n');
    await new Promise((r) => setTimeout(r, 60));
    const s2 = window.__newChat();
    el.commitUtterance('second question', true);   // interrupts + detaches turn1
    const turn2 = el.turn;
    s2.push('data: {"d":"Second answer."}\n\n');
    s1.push('data: {"d":" And the rest of one."}\n\n');
    s1.push('data: {"done":true}\n\n');
    s1.close();
    s2.push('data: {"done":true}\n\n');
    s2.close();
    await new Promise((r) => setTimeout(r, 150));
    const roles = el.history.slice(-4).map((h) => h.role).join(',');
    const a1 = el.history.find((h) => h.content.includes('First answer'));
    return {
      text1: turn1.el.textContent,
      text2: turn2 && turn2.el ? turn2.el.textContent : 'NO TURN2 BUBBLE',
      cut1: turn1.el.classList.contains('cut'),
      roles,
      a1: a1 ? a1.content : 'MISSING',
    };
  });
  check('concurrent turns: detached bubble completes, new turn streams its own',
    concurrent.text1 === 'First answer part one. And the rest of one.'
      && concurrent.text2 === 'Second answer.' && !concurrent.cut1,
    JSON.stringify(concurrent));
  check('concurrent turns: history keeps conversational order',
    concurrent.roles === 'user,assistant,user,assistant'
      && concurrent.a1 === 'First answer part one. And the rest of one.',
    JSON.stringify({ roles: concurrent.roles, a1: concurrent.a1 }));

  // Server-flagged truncation ({done, cut:true}) renders as a cut bubble.
  const cutFlag = await page.evaluate(async () => {
    const el = document.querySelector('alex-voice-widget');
    const s = window.__newChat();
    el.commitUtterance('question hitting the token budget', true);
    const turn = el.turn;
    s.push('data: {"d":"Truncated by budget"}\n\n');
    s.push('data: {"done":true,"cut":true}\n\n');
    s.close();
    await new Promise((r) => setTimeout(r, 120));
    return { cut: turn.el.classList.contains('cut'), state: el.state };
  });
  check('server cut flag marks the bubble incomplete', cutFlag.cut && cutFlag.state === 'listening',
    JSON.stringify(cutFlag));

  // Stream ends with NO terminal event (connection dropped mid-answer): the
  // reply is truncated, so the bubble must be marked cut, not shown complete.
  const eofNoTerm = await page.evaluate(async () => {
    const el = document.querySelector('alex-voice-widget');
    const s = window.__newChat();
    el.commitUtterance('question whose stream just stops', true);
    const turn = el.turn;
    s.push('data: {"d":"An answer with no terminator"}\n\n');
    s.close();                                   // EOF, never a {done}
    await new Promise((r) => setTimeout(r, 120));
    const hist = el.history[el.history.length - 1];
    return {
      cut: turn.el.classList.contains('cut'),
      histContent: hist.role === 'assistant' ? hist.content : 'WRONG ROLE',
      state: el.state,
    };
  });
  check('EOF without a terminal event marks the bubble cut',
    eofNoTerm.cut && eofNoTerm.histContent === 'An answer with no terminator'
      && eofNoTerm.state === 'listening',
    JSON.stringify(eofNoTerm));

  // turnError mid-stream keeps the partial (marked cut, in history) and
  // resets playback instead of abandoning buffered audio.
  const errPartial = await page.evaluate(async () => {
    const el = document.querySelector('alex-voice-widget');
    const s = window.__newChat();
    el.commitUtterance('question that upstream drops', true);
    const turn = el.turn;
    s.push('data: {"d":"Half an answer that then br"}\n\n');
    await new Promise((r) => setTimeout(r, 60));
    s.push('data: {"error":"upstream_error"}\n\n');
    await new Promise((r) => setTimeout(r, 80));
    const hist = el.history[el.history.length - 1];
    const sys = [...el.shadowRoot.querySelectorAll('.m.sys')].map((m) => m.textContent);
    return {
      cut: turn.el.classList.contains('cut'),
      histContent: hist.role === 'assistant' ? hist.content : 'WRONG ROLE',
      glitchLine: sys.some((t) => t.includes('glitched')),
      state: el.state,
      frames: el.framesScheduled,
    };
  });
  check('turnError keeps the partial reply (cut + history) and resets playback',
    errPartial.cut && errPartial.histContent === 'Half an answer that then br'
      && errPartial.glitchLine && errPartial.state === 'listening' && errPartial.frames === 0,
    JSON.stringify(errPartial));

  // Restore the stubs for anything that runs after this section.
  await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    window.fetch = window.__realFetch;
    el.runChat = () => {};
  });

  // History packing: the server's 8000-char aggregate must hold client-side.
  const budget = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    const saved = el.history;
    el.history = [];
    for (let i = 0; i < 14; i++) {
      el.history.push({ role: i % 2 ? 'assistant' : 'user', content: String(i).repeat(700) });
    }
    el.trimHistory();
    const total = el.history.reduce((s, m) => s + m.content.length, 0);
    const last = el.history[el.history.length - 1].content.slice(0, 2);
    const count = el.history.length;
    el.history = saved;
    return { total, count, last };
  });
  check('trimHistory enforces the 8000-char aggregate, newest kept',
    budget.total <= 8000 && budget.count < 14 && budget.last === '13',
    JSON.stringify(budget));

  // Oversized sentences split at word boundaries instead of losing the tail.
  const bigSentence = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    const savedPump = el.pumpTTS;
    el.pumpTTS = () => {};
    const words = [];
    for (let i = 0; i < 120; i++) words.push('understanding');   // ~1680 chars
    const text = words.join(' ') + '.';
    const turn = { flushed: false };
    el.ttsQueue.length = 0;
    el.queueSentence(turn, text);
    const chunks = el.ttsQueue.map((j) => j.text);
    el.ttsQueue.length = 0;
    el.pumpTTS = savedPump;
    const rejoined = chunks.join(' ');
    return {
      count: chunks.length,
      allWithin: chunks.every((c) => c.length <= 800),
      noSplitWords: chunks.every((c) => /^[a-z]/i.test(c) && /(understanding|understanding\.)$/.test(c)),
      complete: rejoined === text,
    };
  });
  check('oversized sentence splits at word boundaries, nothing lost',
    bigSentence.count >= 3 && bigSentence.allWithin && bigSentence.noSplitWords && bigSentence.complete,
    JSON.stringify(bigSentence));

  // Address-shaped markdown labels must point where they claim.
  const mask = await page.evaluate(() => {
    const el = document.querySelector('alex-voice-widget');
    const bubble = (text) => {
      const m = el.addMsg('agent', text);
      return [...m.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    };
    return {
      phish: bubble('Visit [alexrussell.io](https://phish.example) today.'),
      sameHost: bubble('Visit [alexrussell.io](https://www.alexrussell.io/about) today.'),
      mailPhish: bubble('Mail [me@alexrussell.io](mailto:evil@attacker.example) now.'),
      prose: bubble('See [the sample](https://atvora.com/sample) here.'),
      // Canonicalization bypass attempts: a trailing period and a zero-width
      // space inside the label must not sneak the address past the check.
      dotBypass: bubble('Visit [alexrussell.io.](https://phish.example) today.'),
      zwBypass: bubble('Visit [alexrussell​.io](https://phish.example) today.'),
      pathHost: bubble('Open [atvora.com/sample](https://phish.example/sample) now.'),
      // Explicit-scheme label with a port, and a bidi-isolate (U+2066) inside
      // the label — both previously rendered live links to phish.example.
      portBypass: bubble('Open [https://alexrussell.io:443](https://phish.example) now.'),
      isolateBypass: bubble('Open [alexrussell.io⁦](https://phish.example) now.'),
      // A legitimate explicit-scheme same-host label must still link.
      schemeSame: bubble('Open [https://alexrussell.io](https://alexrussell.io/contact) now.'),
      // C0 controls (backspace, NUL) render invisibly but are neither format
      // nor default-ignorable — they must be stripped before classification.
      bsBypass: bubble('Visit [alexrussell.io](https://phish.example) today.'),
      nulBypass: bubble('Visit [alexrussell. io](https://phish.example) today.'),
    };
  });
  check('markdown label cannot mask a different host', mask.phish.length === 0,
    JSON.stringify(mask.phish));
  check('same-host markdown label still links',
    mask.sameHost.length === 1 && mask.sameHost[0] === 'https://www.alexrussell.io/about',
    JSON.stringify(mask.sameHost));
  check('email label cannot mask a different mailbox', mask.mailPhish.length === 0,
    JSON.stringify(mask.mailPhish));
  check('prose markdown labels still link', mask.prose.length === 1,
    JSON.stringify(mask.prose));
  check('trailing-punctuation address label cannot mask host', mask.dotBypass.length === 0,
    JSON.stringify(mask.dotBypass));
  check('zero-width-split address label cannot mask host', mask.zwBypass.length === 0,
    JSON.stringify(mask.zwBypass));
  check('address label with a path cannot mask a different host', mask.pathHost.length === 0,
    JSON.stringify(mask.pathHost));
  check('explicit-scheme label with a port cannot mask a different host',
    mask.portBypass.length === 0, JSON.stringify(mask.portBypass));
  check('bidi-isolate in the label cannot mask a different host',
    mask.isolateBypass.length === 0, JSON.stringify(mask.isolateBypass));
  check('legit explicit-scheme same-host label still links',
    mask.schemeSame.length === 1 && mask.schemeSame[0] === 'https://alexrussell.io/contact',
    JSON.stringify(mask.schemeSame));
  check('backspace-control in the label cannot mask a different host',
    mask.bsBypass.length === 0, JSON.stringify(mask.bsBypass));
  check('NUL-control in the label cannot mask a different host',
    mask.nulBypass.length === 0, JSON.stringify(mask.nulBypass));

  // --- Hero chat (script.js): the same {done,cut} stream marks truncation ---
  const heroCut = await page.evaluate(async () => {
    const realFetch = window.fetch.bind(window);
    const stream = (frames) => new ReadableStream({
      start(c) {
        for (const f of frames) c.enqueue(new TextEncoder().encode(f));
        c.close();
      },
    });
    const run = async (frames) => {
      window.fetch = () => Promise.resolve(new Response(stream(frames), {
        status: 200, headers: { 'Content-Type': 'text/event-stream' },
      }));
      await window.askAlex('a hero-chat question');
      const hist = document.getElementById('chat-history');
      const last = hist.lastElementChild;
      return last ? last.textContent : 'NONE';
    };
    const cut = await run(['data: {"d":"Truncated hero answer"}\n\n', 'data: {"done":true,"cut":true}\n\n']);
    const clean = await run(['data: {"d":"Complete hero answer."}\n\n', 'data: {"done":true}\n\n']);
    const dropped = await run(['data: {"d":"Answer with no terminator"}\n\n']);
    window.fetch = realFetch;
    return { cut, clean, dropped };
  });
  check('hero chat marks a server-cut answer', heroCut.cut.includes('[answer cut short]'),
    heroCut.cut);
  check('hero chat leaves a clean answer unmarked',
    heroCut.clean.includes('Complete hero answer.') && !heroCut.clean.includes('cut short'),
    heroCut.clean);
  check('hero chat flags a dropped stream with no terminator',
    heroCut.dropped.includes('[connection dropped, answer cut short]'), heroCut.dropped);

  await browser.close();
  srv.close();
  console.log(fails ? `\n${fails} FAILURES` : '\nALL CHECKS PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
