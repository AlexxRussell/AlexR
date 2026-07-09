// --- SCROLL TO TOP FUNCTION (For Sticky Header Name Click) ---
function scrollToTop(event) {
    event.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // Remove hash from URL
    history.pushState("", document.title, window.location.pathname + window.location.search);
}

// --- MOUSE TRACKING FOR SPOTLIGHT ---
const spotlightEl = document.body; // We toggle opacity on body::before
// Since pseudo-elements can't be directly accessed, we'll use a class or just rely on the variable
// Actually, we set opacity: 0 in CSS, so let's toggle a class 'spotlight-active'

document.addEventListener('mousemove', (e) => {
    const x = e.clientX;
    const y = e.clientY;
    document.documentElement.style.setProperty('--mouse-x', x + 'px');
    document.documentElement.style.setProperty('--mouse-y', y + 'px');
});

// --- TOGGLE SPOTLIGHT VISIBILITY BASED ON SCROLL ---
window.addEventListener('scroll', () => {
    const triggerSection = document.getElementById('about-section');
    // Start effect slightly before the section comes into view
    if (window.scrollY > (triggerSection.offsetTop - 300)) {
        document.body.classList.add('spotlight-visible');
    } else {
        document.body.classList.remove('spotlight-visible');
    }
});

// --- 1. SCROLL DETECTOR FOR STICKY HEADER ---
window.addEventListener('scroll', function() {
    const nav = document.getElementById('sticky-nav');
    const triggerSection = document.getElementById('about-section');
    const triggerHeight = triggerSection.offsetTop - 150; // Trigger slightly before reaching the section

    if (window.scrollY > triggerHeight) {
        nav.classList.add('visible');
    } else {
        nav.classList.remove('visible');
    }
});

// --- 2. STATUS LINE TYPER (Header) ---
const statusText = "SYSTEM ONLINE: AVAILABLE";
const statusEl = document.getElementById('status-line');
let statusIdx = 0;

function typeStatus() {
    if (statusIdx < statusText.length) {
        statusEl.textContent += statusText.charAt(statusIdx);
        statusIdx++;
        setTimeout(typeStatus, 50);
    }
}
setTimeout(typeStatus, 500);


// --- 3. GHOST CODER (Top Left - Always Loop) ---
const ghostSnippet = `
import { McpServer } from '@modelcontextprotocol/sdk';
import { createClient } from '@supabase/supabase-js';

// --- SYSTEM: AGENTIC WORKFLOW ---
// Secure MCP tool server with field redaction

const supabase = createClient(env.DB_URL, env.DB_KEY);
const server = new McpServer({ name: "payroll-tools" });

server.tool("get_employee", async ({ id }) => {
    const { data } = await supabase
        .from('staff').select('*').eq('id', id);

    // Redact sensitive fields before the model sees them
    return redact(data, ['bank', 'ird', 'salary']);
});

await server.connect();
console.log("[INIT] MCP server online. Tools exposed.");
`;
const ghostWindow = document.getElementById('ghost-code-window');
let ghostIdx = 0;

function runGhostCoder() {
    if (ghostIdx < ghostSnippet.length) {
        ghostWindow.textContent += ghostSnippet.charAt(ghostIdx);
        ghostWindow.scrollTop = ghostWindow.scrollHeight;
        ghostIdx++;
        setTimeout(runGhostCoder, Math.random() * 20 + 5);
    } else {
        setTimeout(() => {
            ghostWindow.textContent = "";
            ghostIdx = 0;
            runGhostCoder();
        }, 3000);
    }
}
runGhostCoder(); 

// --- 5. PREVENT SCROLL TRAP IN GHOST WINDOW ---
// Forces the mouse wheel to scroll the PAGE instead of the box, 
// requiring the user to use the scrollbar/slider to scroll the box itself.
ghostWindow.addEventListener('wheel', (e) => {
    // Prevent the default scroll behavior of the box
    e.preventDefault();
    // Manually scroll the window instead
    window.scrollBy({
        top: e.deltaY,
        behavior: 'auto' 
    });
}, { passive: false });

// --- 4. WORKFLOW SIMULATOR (Top Right) ---
function runWorkflow() {
    const btn = document.getElementById('wf-btn');
    const nodes = ['node1', 'node2', 'node3'];
    const pipes = ['pipe1', 'pipe2'];
    
    if(btn.disabled) return;

    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner mr-2"></span> EXECUTING...`;
    btn.classList.add('opacity-50', 'cursor-not-allowed');
    
    // Reset styles
    nodes.forEach(n => {
        const el = document.getElementById(n);
        el.classList.remove('border-blue-500', 'text-blue-500', 'shadow-[0_0_15px_#1e90ff]');
        el.classList.add('border-gray-700', 'text-gray-600');
    });

    // Step 1
    const n1 = document.getElementById('node1');
    n1.classList.replace('border-gray-700', 'border-blue-500');
    n1.classList.replace('text-gray-600', 'text-blue-500');
    n1.classList.add('shadow-[0_0_15px_#1e90ff]');
    document.getElementById('pipe1').style.animation = "flow 0.6s linear forwards";

    // Step 2
    setTimeout(() => {
        const n2 = document.getElementById('node2');
        n2.classList.replace('border-gray-700', 'border-blue-500');
        n2.classList.replace('text-gray-600', 'text-blue-500');
        n2.classList.add('shadow-[0_0_15px_#1e90ff]');
        document.getElementById('pipe2').style.animation = "flow 0.6s linear forwards";
    }, 600);

    // Step 3 & Action
    setTimeout(() => {
        const n3 = document.getElementById('node3');
        n3.classList.replace('border-gray-700', 'border-blue-500');
        n3.classList.replace('text-gray-600', 'text-blue-500');
        n3.classList.add('shadow-[0_0_15px_#1e90ff]');
        
        btn.innerText = "ACCESS GRANTED - OPENING MAIL";
        btn.classList.replace('text-blue-500', 'text-white');
        btn.classList.replace('bg-blue-900/10', 'bg-blue-600');
        
    setTimeout(() => {
        window.location.href = "mailto:me@alexrussell.io?subject=Portfolio%20Connection&body=" + encodeURIComponent("Hey Alex, I ran your protocol. Let's chat.");
        
        setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = "[\u00A0Initialize Protocol\u00A0]";
            btn.classList.remove('opacity-50', 'cursor-not-allowed', 'text-white', 'bg-blue-600');
            btn.classList.add('text-green-500', 'bg-green-900/10');
            document.getElementById('pipe1').style.animation = "none";
            document.getElementById('pipe2').style.animation = "none";
        }, 2000);
    }, 1000);
}, 1200);
}

// --- 5. LEFT PANEL LOGIC (Tabs & Chat) ---
function switchTab(tab) {
    const btnLogs = document.getElementById('tab-logs');
    const btnChat = document.getElementById('tab-chat');
    const contentLogs = document.getElementById('content-logs');
    const contentChat = document.getElementById('content-chat');

    if (tab === 'logs') {
        // Active State for Logs
        btnLogs.classList.add('text-green-400', 'bg-white/10', 'border-t', 'border-green-500');
        btnLogs.classList.remove('text-gray-500');
        
        // Inactive State for Chat
        btnChat.classList.add('text-gray-500');
        btnChat.classList.remove('text-green-400', 'bg-white/10', 'border-t', 'border-green-500');

        contentLogs.classList.remove('hidden');
        contentChat.classList.add('hidden');
        btnLogs.setAttribute('aria-selected', 'true');
        btnChat.setAttribute('aria-selected', 'false');
    } else {
        // Active State for Chat
        btnChat.classList.add('text-green-400', 'bg-white/10', 'border-t', 'border-green-500');
        btnChat.classList.remove('text-gray-500');

        // Inactive State for Logs
        btnLogs.classList.add('text-gray-500');
        btnLogs.classList.remove('text-green-400', 'bg-white/10', 'border-t', 'border-green-500');

        contentLogs.classList.add('hidden');
        contentChat.classList.remove('hidden');
        btnChat.setAttribute('aria-selected', 'true');
        btnLogs.setAttribute('aria-selected', 'false');
    }
}

// --- 5b. ALEX_AGENT CHAT: the real agent, same brain as the voice link ---
// Streams from /api/chat (persona lives server-side). The old canned
// answers are gone; this is live.
const alexChat = {
    history: [{ role: 'assistant', content: "Hello! I am Alexander's personal agent, live and unscripted. Ask me anything about his work." }],
    busy: false,
};

function chatUiBusy(busy) {
    alexChat.busy = busy;
    document.querySelectorAll('#chat-chips button, #chat-send').forEach((b) => { b.disabled = busy; });
    const input = document.getElementById('chat-input');
    if (input) input.disabled = busy;
}

function sendChatForm(ev) {
    ev.preventDefault();
    const input = document.getElementById('chat-input');
    const q = (input && input.value ? input.value : '').trim();
    if (q) {
        input.value = '';
        askAlex(q);
    }
    return false;
}

// Smooth streaming: the model delivers text in uneven lumps, so network
// chunks land in a buffer and this typer drains it at a steady, readable
// pace, accelerating when it falls behind so it never lags the stream.
function createTyper(span, historyEl) {
    let buf = '';
    let out = '';
    let done = false;
    let onDrained = null;
    const timer = setInterval(() => {
        if (buf.length) {
            const n = Math.max(1, Math.min(12, Math.round(buf.length / 50)));
            out += buf.slice(0, n);
            buf = buf.slice(n);
            span.textContent = out;
            historyEl.scrollTop = historyEl.scrollHeight;
        } else if (done) {
            clearInterval(timer);
            if (onDrained) onDrained();
        }
    }, 24);
    return {
        push(text) { buf += text; },
        finish() {
            return new Promise((resolve) => {
                done = true;
                onDrained = resolve;
                if (!buf.length) { clearInterval(timer); resolve(); }
            });
        },
        cancel(finalText) {
            clearInterval(timer);
            span.textContent = finalText !== undefined ? finalText : out + buf;
        },
    };
}

async function askAlex(question) {
    if (alexChat.busy) return;
    question = String(question || '').trim().slice(0, 500);
    if (!question) return;
    const historyEl = document.getElementById('chat-history');
    chatUiBusy(true);

    const qEl = document.createElement('div');
    qEl.className = 'mb-2 text-right';
    const qSpan = document.createElement('span');
    qSpan.className = 'text-gray-400';
    qSpan.textContent = '> ' + question;
    qEl.appendChild(qSpan);
    historyEl.appendChild(qEl);

    const loaderEl = document.createElement('div');
    loaderEl.className = 'mb-4 flex items-center gap-2';
    loaderEl.innerHTML = '<span class="text-green-500">ALEX_AGENT ></span> <span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>';
    historyEl.appendChild(loaderEl);
    historyEl.scrollTop = historyEl.scrollHeight;

    const aEl = document.createElement('div');
    aEl.className = 'mb-4';
    aEl.innerHTML = '<span class="text-green-500">ALEX_AGENT ></span> <span class="agent-answer"></span><span class="terminal-cursor"></span>';
    const answerSpan = aEl.querySelector('.agent-answer');

    alexChat.history.push({ role: 'user', content: question });
    let reply = '';
    let typer = null;
    let failText = 'link hiccup, try again in a moment.';
    // Watchdog: a stalled mobile connection would otherwise leave read()
    // hanging forever with the input locked (busy never clears).
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), 60000);
    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: alexChat.history.slice(-14) }),
            signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
            if (res.status === 429) failText = 'rate limited, give it a beat and try again.';
            throw new Error('http');
        }
        loaderEl.remove();
        historyEl.appendChild(aEl);
        typer = createTyper(answerSpan, historyEl);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
                const frame = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const line = frame.split('\n').find((l) => l.startsWith('data: '));
                if (!line) continue;
                let ev;
                try { ev = JSON.parse(line.slice(6)); } catch (e) { continue; }
                if (ev.d) {
                    reply += ev.d;
                    typer.push(ev.d);
                }
                if (ev.error) {
                    if (ev.error === 'rate_limited') failText = 'rate limited, give it a beat and try again.';
                    throw new Error('upstream');
                }
            }
        }
        if (!reply) throw new Error('empty');
        await typer.finish(); // let the last characters land before unlocking
        // Once complete, upgrade addresses/links in the answer to anchors
        // (renderer shared from the voice widget; plain text if absent).
        if (window.__alexvoiceRichText) window.__alexvoiceRichText(answerSpan, reply);
        alexChat.history.push({ role: 'assistant', content: reply });
    } catch (err) {
        loaderEl.remove();
        if (!aEl.parentNode) historyEl.appendChild(aEl);
        if (reply) {
            // keep what was heard mid-stream, shown in full — but say it was
            // cut, or a half answer reads as a complete (wrong) one.
            if (typer) typer.cancel();
            if (window.__alexvoiceRichText) window.__alexvoiceRichText(answerSpan, reply);
            const note = document.createElement('span');
            note.className = 'text-gray-600';
            note.textContent = ' [link dropped, answer cut short]';
            aEl.appendChild(note);
            alexChat.history.push({ role: 'assistant', content: reply });
        } else {
            if (typer) typer.cancel('');
            alexChat.history.pop(); // let the visitor retry cleanly
            answerSpan.textContent = failText;
        }
    } finally {
        clearTimeout(watchdog);
        const cursor = aEl.querySelector('.terminal-cursor');
        if (cursor) cursor.remove();
        historyEl.scrollTop = historyEl.scrollHeight;
        chatUiBusy(false);
    }
}

function openVoiceLink() {
    const w = document.querySelector('alex-voice-widget');
    if (w && typeof w.expand === 'function') w.expand();
}

// --- 6. Allow headings with underscores to wrap at underscores instead of mid-word ---
const underscoreHeadings = document.querySelectorAll('.break-on-underscore');
underscoreHeadings.forEach((el) => {
    const text = el.textContent;
    el.innerHTML = text.replace(/_/g, '_<wbr>');
});

