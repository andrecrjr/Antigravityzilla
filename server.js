#!/usr/bin/env node
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import os from 'os';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORTS = [9000, 9001, 9002, 9003];
const DISCOVERY_INTERVAL = 10000;
const POLL_INTERVAL = 3000;

// Application State
let cascades = new Map(); // Map<cascadeId, { id, cdp: { ws, contexts, rootContextId }, metadata, snapshot, snapshotHash }>
let wss = null;

// --- Helpers ---

// Simple hash function
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

// HTTP GET JSON
function getJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve([]); } // return empty on parse error
            });
        });
        req.on('error', () => resolve([])); // return empty on network error
        req.setTimeout(2000, () => {
            req.destroy();
            resolve([]);
        });
    });
}

// --- CDP Logic ---

async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const handler = (msg) => {
            const data = JSON.parse(msg);
            if (data.id === id) {
                ws.off('message', handler);
                if (data.error) reject(data.error);
                else resolve(data.result);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });

    const contexts = [];
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const idx = contexts.findIndex(c => c.id === data.params.executionContextId);
                if (idx !== -1) contexts.splice(idx, 1);
            }
        } catch (e) { }
    });

    await call("Runtime.enable", {});
    await new Promise(r => setTimeout(r, 500)); // give time for contexts to load

    return { ws, call, contexts, rootContextId: null };
}

async function extractMetadata(cdp) {
    const SCRIPT = `(() => {
        const cascade = document.getElementById('cascade');
        if (!cascade) return { found: false, reason: 'no cascade element' };
        
        let chatTitle = null;
        const possibleTitleSelectors = ['h1', 'h2', 'header', '[class*="title"]'];
        for (const sel of possibleTitleSelectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.length > 2 && el.textContent.length < 50) {
                chatTitle = el.textContent.trim();
                break;
            }
        }
        
        // Multi-method conversation ID detection
        let conversationId = null;
        
        // Method 1: URL pathname (e.g., /brain/UUID/...)
        try {
            const pathMatch = window.location.pathname.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
            if (pathMatch) conversationId = pathMatch[1];
        } catch (e) {}
        
        // Method 2: URL hash
        if (!conversationId) {
            try {
                const hashMatch = window.location.hash.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
                if (hashMatch) conversationId = hashMatch[1];
            } catch (e) {}
        }
        
        // Method 3: localStorage
        if (!conversationId) {
            try {
                const stored = localStorage.getItem('conversationId') || localStorage.getItem('currentConversationId');
                if (stored && stored.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)) {
                    conversationId = stored;
                }
            } catch (e) {}
        }
        
        // Method 4: Data attributes on cascade element
        if (!conversationId) {
            try {
                conversationId = cascade.dataset.conversationId || cascade.getAttribute('data-conversation-id');
            } catch (e) {}
        }
        
        return {
            found: true,
            chatTitle: chatTitle || 'Agent',
            isActive: document.hasFocus(),
            conversationId: conversationId,
            url: window.location.href
        };
    })()`;

    // Try finding context first if not known
    if (cdp.rootContextId) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: SCRIPT, returnByValue: true, contextId: cdp.rootContextId });
            if (res.result?.value?.found) return { ...res.result.value, contextId: cdp.rootContextId };
            if (res.result?.value?.reason) console.log(`  ⚠️  Metadata check failed: ${res.result.value.reason}`);
        } catch (e) { 
            console.log(`  ❌ Metadata extraction error: ${e.message}`);
            cdp.rootContextId = null; 
        }
    }

    // Search all contexts
    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", { expression: SCRIPT, returnByValue: true, contextId: ctx.id });
            if (result.result?.value?.found) {
                return { ...result.result.value, contextId: ctx.id };
            }
        } catch (e) { }
    }
    return null;
}

async function captureCSS(cdp) {
    const SCRIPT = `(() => {
        // Gather CSS and namespace it basic way to prevent leaks
        let css = '';
        for (const sheet of document.styleSheets) {
            try { 
                for (const rule of sheet.cssRules) {
                    let text = rule.cssText;
                    // Naive scoping: replace body/html with #cascade locator
                    // This prevents the monitored app's global backgrounds from overriding our monitor's body
                    text = text.replace(/(^|[\\s,}])body(?=[\\s,{])/gi, '$1#cascade');
                    text = text.replace(/(^|[\\s,}])html(?=[\\s,{])/gi, '$1#cascade');
                    css += text + '\\n'; 
                }
            } catch (e) { }
        }
        return { css };
    })()`;

    const contextId = cdp.rootContextId;
    if (!contextId) return null;

    try {
        const result = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: contextId
        });
        return result.result?.value?.css || '';
    } catch (e) { return ''; }
}

async function captureHTML(cdp) {
    const SCRIPT = `(() => {
        const cascade = document.getElementById('cascade');
        if (!cascade) return { error: 'cascade not found' };
        
        const clone = cascade.cloneNode(true);
        // Remove input box to keep snapshot clean
        const input = clone.querySelector('[contenteditable="true"]')?.closest('div[id^="cascade"] > div');
        if (input) input.remove();
        
        const bodyStyles = window.getComputedStyle(document.body);

        return {
            html: clone.outerHTML,
            bodyBg: bodyStyles.backgroundColor,
            bodyColor: bodyStyles.color
        };
    })()`;

    const contextId = cdp.rootContextId;
    if (!contextId) return null;

    try {
        const result = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: contextId
        });
        if (result.result?.value && !result.result.value.error) {
            return result.result.value;
        }
    } catch (e) { }
    return null;
}

// Brain Artifact Helpers

function getMostRecentBrainDir() {
    try {
        const userHome = os.homedir();
        const brainBasePath = path.join(userHome, '.gemini', 'antigravity', 'brain');
        
        if (!fs.existsSync(brainBasePath)) return null;
        
        const entries = fs.readdirSync(brainBasePath, { withFileTypes: true });
        const dirs = entries
            .filter(e => e.isDirectory())
            .filter(e => e.name.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/))
            .map(e => {
                const dirPath = path.join(brainBasePath, e.name);
                const stats = fs.statSync(dirPath);
                return { name: e.name, mtime: stats.mtime };
            })
            .sort((a, b) => b.mtime - a.mtime); // Most recent first
        
        return dirs.length > 0 ? dirs[0].name : null;
    } catch (e) {
        console.error('Error finding recent brain dir:', e.message);
        return null;
    }
}

function readBrainArtifacts(conversationId) {
    if (!conversationId) return null;
    
    // Construct path: ~/.gemini/antigravity/brain/{id}
    const userHome = os.homedir();
    const brainPath = path.join(userHome, '.gemini', 'antigravity', 'brain', conversationId);
    
    const artifacts = {
        implementation_plan: null,
        task: null,
        walkthrough: null
    };
    
    try {
        const planPath = path.join(brainPath, 'implementation_plan.md');
        if (fs.existsSync(planPath)) artifacts.implementation_plan = fs.readFileSync(planPath, 'utf8');
    } catch (e) {}
    
    try {
        const taskPath = path.join(brainPath, 'task.md');
        if (fs.existsSync(taskPath)) artifacts.task = fs.readFileSync(taskPath, 'utf8');
    } catch (e) {}
    
    try {
        const walkthroughPath = path.join(brainPath, 'walkthrough.md');
        if (fs.existsSync(walkthroughPath)) artifacts.walkthrough = fs.readFileSync(walkthroughPath, 'utf8');
    } catch (e) {}
    
    return artifacts;
}

// --- Main App Logic ---

async function discover() {
    // 1. Find all targets
    const allTargets = [];
    await Promise.all(PORTS.map(async (port) => {
        const list = await getJson(`http://127.0.0.1:${port}/json/list`);
        const workbenches = list.filter(t => t.url?.includes('workbench.html') || t.title?.includes('workbench'));
        workbenches.forEach(t => allTargets.push({ ...t, port }));
    }));

    const newCascades = new Map();

    // 2. Connect/Refresh
    for (const target of allTargets) {
        const id = hashString(target.webSocketDebuggerUrl);

        // Reuse existing
        if (cascades.has(id)) {
            const existing = cascades.get(id);
            if (existing.cdp.ws.readyState === WebSocket.OPEN) {
                // Refresh metadata
                const meta = await extractMetadata(existing.cdp);
                if (meta) {
                    existing.metadata = { ...existing.metadata, ...meta };
                    if (meta.contextId) existing.cdp.rootContextId = meta.contextId; // Update optimization
                    newCascades.set(id, existing);
                    continue;
                }
            }
        }

        // New connection
        try {
            console.log(`🔌 Connecting to ${target.title}`);
            const cdp = await connectCDP(target.webSocketDebuggerUrl);
            const meta = await extractMetadata(cdp);

            if (meta) {
                if (meta.contextId) cdp.rootContextId = meta.contextId;
                
                // Fallback: Use most recent brain dir if no conversationId found
                let conversationId = meta.conversationId;
                if (!conversationId) {
                    conversationId = getMostRecentBrainDir();
                    if (conversationId) {
                        console.log(`  📁 Using most recent brain dir: ${conversationId}`);
                    }
                }
                
                const cascade = {
                    id,
                    cdp,
                    metadata: {
                        windowTitle: target.title,
                        chatTitle: meta.chatTitle,
                        isActive: meta.isActive,
                        conversationId: conversationId,
                        url: meta.url || null
                    },
                    snapshot: null,
                    css: await captureCSS(cdp), //only on init bc its huge
                    snapshotHash: null
                };
                newCascades.set(id, cascade);
                console.log(`✨ Added cascade: ${meta.chatTitle}`);
            } else {
                cdp.ws.close();
            }
        } catch (e) {
            // console.error(`Failed to connect to ${target.title}: ${e.message}`);
        }
    }

    // 3. Cleanup old
    for (const [id, c] of cascades.entries()) {
        if (!newCascades.has(id)) {
            console.log(`👋 Removing cascade: ${c.metadata.chatTitle}`);
            try { c.cdp.ws.close(); } catch (e) { }
        }
    }

    const changed = cascades.size !== newCascades.size; // Simple check, could be more granular
    cascades = newCascades;

    if (changed) broadcastCascadeList();
}

// Heuristic to get a useful project/workspace name from the window title
function extractProjectName(title) {
    if (!title) return '';
    
    // Common formats:
    // "filename.js - ProjectName - EditorName"
    // "ProjectName - EditorName"
    
    const parts = title.split(' - ');
    
    // If we have 3 or more parts, the project name is likely the second-to-last
    // e.g. "server.js - Antigravityzilla - Cursor" -> "Antigravityzilla"
    if (parts.length >= 3) {
        return parts[parts.length - 2];
    }
    
    // If 2 parts, usually "File - Editor" or "Project - Editor"
    // Hard to distinguish without knowing the editor name, but let's try returning the first part
    // providing it's not a generic file name. 
    // Actually, often "ProjectName" comes first in some views.
    // Let's just return the whole thing if we can't be sure, or the first part.
    if (parts.length === 2) {
       return parts[0]; 
    }

    return title; 
}

async function updateSnapshots() {
    // Parallel updates
    await Promise.all(Array.from(cascades.values()).map(async (c) => {
        try {
            const snap = await captureHTML(c.cdp); // Only capture HTML
            if (snap) {
                const hash = hashString(snap.html);
                if (hash !== c.snapshotHash) {
                    c.snapshot = snap;
                    c.snapshotHash = hash;
                    broadcast({ type: 'snapshot_update', cascadeId: c.id });
                    // console.log(`📸 Updated ${c.metadata.chatTitle}`);
                }
            }
        } catch (e) { }
    }));
}

function broadcast(msg) {
    if (!wss) return;
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msg));
    });
}

function broadcastCascadeList() {
    const list = Array.from(cascades.values()).map(c => ({
        id: c.id,
        title: c.metadata.chatTitle,
        window: c.metadata.windowTitle,
        projectName: extractProjectName(c.metadata.windowTitle),
        active: c.metadata.isActive
    }));
    broadcast({ type: 'cascade_list', cascades: list });
}

// --- Server Setup ---

async function main() {
    const app = express();
    const server = http.createServer(app);
    wss = new WebSocketServer({ server });

    app.use(express.json());
    app.use(express.static(join(__dirname, 'public')));

    // API Routes
    app.get('/cascades', (req, res) => {
        res.json(Array.from(cascades.values()).map(c => ({
            id: c.id,
            title: c.metadata.chatTitle,
            active: c.metadata.isActive
        })));
    });

    app.get('/snapshot/:id', (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c || !c.snapshot) return res.status(404).json({ error: 'Not found' });
        res.json(c.snapshot);
    });

    app.get('/styles/:id', (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Not found' });
        res.json({ css: c.css || '' });
    });

    app.get('/brain/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });
        
        const conversationId = c.metadata.conversationId;
        if (!conversationId) {
            return res.json({ 
                implementation_plan: null, 
                task: null, 
                walkthrough: null,
                error: 'No conversation ID found',
                debug: {
                    url: c.metadata.url,
                    title: c.metadata.windowTitle
                }
            });
        }
        
        try {
            const artifacts = readBrainArtifacts(conversationId);
            res.json(artifacts || { implementation_plan: null, task: null, walkthrough: null });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Alias for simple single-view clients (returns first active or first available)
    app.get('/snapshot', (req, res) => {
        const active = Array.from(cascades.values()).find(c => c.metadata.isActive) || cascades.values().next().value;
        if (!active || !active.snapshot) return res.status(503).json({ error: 'No snapshot' });
        res.json(active.snapshot);
    });

    app.post('/create/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        console.log(`🆕 Creating new agent for ${c.metadata.chatTitle}`);
        try {
            // Simulate Ctrl+Shift+L
            await c.cdp.call("Input.dispatchKeyEvent", {
                type: "rawKeyDown",
                modifiers: 10, // Ctrl=2, Shift=8 -> 10? Or bitwise. 
                // Modifiers: None: 0, Alt: 1, Ctrl: 2, Meta/Cmd: 4, Shift: 8
                windowsVirtualKeyCode: 76, // L
                key: "L",
                code: "KeyL"
            });
            await c.cdp.call("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 76, key: "L", code: "KeyL" });
            
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/send/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        // Re-using the injection logic logic would be long, 
        // but let's assume valid injection for brevity in this single-file request:
        // We'll trust the previous logic worked, just pointing it to c.cdp

        // ... (Injection logic here would be same as before, simplified for brevity of this file edit)
        // For now, let's just log it to prove flow works
        console.log(`Message to ${c.metadata.chatTitle}: ${req.body.message}`);
        // TODO: Port the full injection script back in if needed, 
        // but user asked for "update" which implies features, I'll assume I should include it.
        // See helper below.

        const result = await injectMessage(c.cdp, req.body.message);
        if (result.ok) res.json({ success: true });
        else res.status(500).json(result);
    });


    wss.on('connection', (ws) => {
        broadcastCascadeList(); // Send list on connect
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });

    // Start Loops
    discover();
    setInterval(discover, DISCOVERY_INTERVAL);
    setInterval(updateSnapshots, POLL_INTERVAL);
}

// Injection Helper (Moved down to keep main clear)
async function injectMessage(cdp, text) {
    const SCRIPT = `(async () => {
        // Try contenteditable first, then textarea
        const editor = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
        if (!editor) return { ok: false, reason: "no editor found" };
        
        editor.focus();
        
        if (editor.tagName === 'TEXTAREA') {
            const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
            nativeTextAreaValueSetter.call(editor, "${text.replace(/"/g, '\\"')}");
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            document.execCommand("selectAll", false, null);
            document.execCommand("insertText", false, "${text.replace(/"/g, '\\"')}");
        }
        
        await new Promise(r => setTimeout(r, 100));
        
        // Try multiple button selectors
        const btn = document.querySelector('button[class*="arrow"]') || 
                   document.querySelector('button[aria-label*="Send"]') ||
                   document.querySelector('button[type="submit"]');

        if (btn) {
            btn.click();
        } else {
             // Fallback to Enter key
             editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter" }));
        }
        return { ok: true };
    })()`;

    try {
        const res = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: cdp.rootContextId
        });
        return res.result?.value || { ok: false };
    } catch (e) { return { ok: false, reason: e.message }; }
}

main();
