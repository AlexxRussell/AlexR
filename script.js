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
    btn.innerHTML = `<i class="fas fa-circle-notch fa-spin mr-2"></i> EXECUTING...`;
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

let alexAgentBusy = false;

function askQuestion(type) {
    if (alexAgentBusy) return; // ignore clicks while a response is streaming
    const history = document.getElementById('chat-history');
    let question = "";
    let answer = "";

    if (type === 'who') {
        question = "Who is Alexander?";
        answer = "Alexander is an AI Engineer and Agentic Systems Architect who bridges technical execution with business strategy. He has been automating professionally since late 2021 and currently serves as a contract AI Engineer for Harkness AI and a contributor to the AI Forum NZ LLM Working Group.";
    } else if (type === 'stack') {
        question = "What is his tech stack?";
        answer = "He leverages a multi-model intelligence layer using OpenAI, Claude, and Gemini. He specialises in Model Context Protocol (MCP) servers, RAG pipelines, and secure Supabase backends, orchestrated through Next.js, TypeScript, and Python for scalable production systems.";
    } else if (type === 'contact') {
        question = "How do I contact him?";
        answer = "You can email him at me@alexrussell.io or run the Contact Protocol on the right!";
    }

    alexAgentBusy = true;

    // Append Question
    const qEl = document.createElement('div');
    qEl.className = "mb-2 text-right";
    qEl.innerHTML = `<span class="text-gray-400">> ${question}</span>`;
    history.appendChild(qEl);

    // Show thinking loader
    const loaderEl = document.createElement('div');
    loaderEl.className = "mb-4 flex items-center gap-2";
    loaderEl.innerHTML = `<span class="text-green-500">ALEX_AGENT ></span> <span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>`;
    history.appendChild(loaderEl);
    history.scrollTop = history.scrollHeight;

    // After a brief think, stream the answer character by character (typewriter effect)
    setTimeout(() => {
        loaderEl.remove();
        const aEl = document.createElement('div');
        aEl.className = "mb-4";
        aEl.innerHTML = `<span class="text-green-500">ALEX_AGENT ></span> <span class="agent-answer"></span><span class="terminal-cursor"></span>`;
        history.appendChild(aEl);

        const answerSpan = aEl.querySelector('.agent-answer');
        const cursor = aEl.querySelector('.terminal-cursor');
        let i = 0;

        const typeChar = () => {
            if (i < answer.length) {
                answerSpan.textContent += answer.charAt(i);
                i++;
                history.scrollTop = history.scrollHeight;
                setTimeout(typeChar, 16);
            } else {
                if (cursor) cursor.remove();
                alexAgentBusy = false;
            }
        };
        typeChar();
    }, 800);

    history.scrollTop = history.scrollHeight;
}

// --- 6. Allow headings with underscores to wrap at underscores instead of mid-word ---
const underscoreHeadings = document.querySelectorAll('.break-on-underscore');
underscoreHeadings.forEach((el) => {
    const text = el.textContent;
    el.innerHTML = text.replace(/_/g, '_<wbr>');
});

