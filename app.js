"use strict";

/* ════════════════════════════════════════════════════════════════════
 *  Haven: a private, general-purpose AI assistant, fully local.
 *
 *  An in-browser LLM (WebLLM on WebGPU) that keeps a multi-turn
 *  conversation. Nothing you type ever leaves the page. The model runs
 *  on your own GPU, and it keeps working with the network switched off.
 *
 *  UI: a full-screen app shell (sidebar history + conversation pane) with
 *  markdown rendering and conversations persisted to localStorage.
 * ════════════════════════════════════════════════════════════════════ */

import { CreateMLCEngine } from "https://esm.run/@mlc-ai/web-llm";
import { marked } from "https://esm.run/marked@13";

/* ── Tunables ──────────────────────────────────────────────────────── */
// Qwen3-8B is a strong, modern instruct model (~5.5GB VRAM / one-time download).
// If your GPU is tight on memory, drop to "Qwen3-4B-q4f16_1-MLC" (~3GB).
// Qwen3 is a hybrid reasoning model: it can emit <think>...</think> blocks.
// We disable that below (chat config) and also strip any stray tags before display.
const LLM_MODEL = "Qwen3-8B-q4f16_1-MLC";
const SYSTEM_PROMPT =
  "You are a helpful, concise assistant for chatting, thinking and writing. " +
  "When asked to edit text, return only the rewritten text unless asked to explain. " +
  "Use clear markdown formatting and keep answers to the point.";

const STORE_KEY = "haven.conversations.v1";

// Quick-action templates wrap whatever is in the composer.
const ACTIONS = {
  improve: (t) => `Improve the writing of the following text so it is clearer and more polished, same meaning and language:\n\n${t}`,
  grammar: (t) => `Fix the spelling and grammar of the following text. Return only the corrected text:\n\n${t}`,
  summarize: (t) => `Summarize the following text in a few clear bullet points:\n\n${t}`,
  formal: (t) => `Rewrite the following text in a professional, formal tone:\n\n${t}`,
  casual: (t) => `Rewrite the following text in a friendly, casual tone:\n\n${t}`,
  shorten: (t) => `Make the following text significantly shorter while keeping the key points:\n\n${t}`,
};

const ACTION_LABELS = {
  improve: "✍️ Improve writing",
  grammar: "🔧 Fix grammar",
  summarize: "📝 Summarize",
  formal: "🎩 Make formal",
  casual: "💬 Make casual",
  shorten: "✂️ Shorten",
};

marked.setOptions({ breaks: true, gfm: true });

/* ── Elements ──────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

const appEl = $("app");
const sidebarEl = $("sidebar");
const scrimEl = $("scrim");
const menuBtn = $("menuBtn");
const collapseBtn = $("collapseBtn");
const conversationsEl = $("conversations");

const engineDot = $("engineDot");
const engineState = $("engineState");
const engineDetail = $("engineDetail");
const engineProgressWrap = $("engineProgressWrap");
const engineProgress = $("engineProgress");
const localBadge = $("localBadge");

const chatScroll = $("chatScroll");
const messagesEl = $("messages");
const convMeta = $("convMeta");
const topStatus = $("topStatus");
const topStatusText = $("topStatusText");
const newChatBtn = $("newChatBtn");
const quickActions = $("quickActions");
const suggestionsEl = $("suggestions");

const composer = $("composer");
const input = $("input");
const sendBtn = $("sendBtn");
const stopBtn = $("stopBtn");
const hint = $("hint");

/* ── State ─────────────────────────────────────────────────────────── */
let engine = null;
let modelReady = false;
let busy = false;
let stopRequested = false;

let conversations = loadStore();      // [{ id, title, history, updatedAt }]
let currentId = null;
let history = [{ role: "system", content: SYSTEM_PROMPT }];

boot();

/* ════════════════════════════════════════════════════════════════════
 *  Boot: wire up UI, check WebGPU, warm up the model.
 * ════════════════════════════════════════════════════════════════════ */
async function boot() {
  composer.addEventListener("submit", onSubmit);
  newChatBtn.addEventListener("click", newConversation);
  stopBtn.addEventListener("click", () => { stopRequested = true; });

  menuBtn.addEventListener("click", () => toggleNav());
  collapseBtn.addEventListener("click", () => appEl.classList.toggle("is-collapsed"));
  scrimEl.addEventListener("click", () => toggleNav(false));

  // Enter to send, Shift+Enter for newline.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });
  input.addEventListener("input", autoGrow);

  quickActions.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (btn) applyQuickAction(btn.dataset.action);
  });

  // Welcome suggestion cards prefill the composer and focus it.
  if (suggestionsEl) {
    suggestionsEl.addEventListener("click", (e) => {
      const card = e.target.closest(".suggestion");
      if (!card || !modelReady) return;
      input.value = card.dataset.fill || "";
      autoGrow();
      input.focus();
    });
  }

  // Start a fresh conversation in memory and paint the history list.
  newConversation({ silent: true });
  renderConversationList();

  // Show the runs-locally badge right away, since the app is local from the start.
  localBadge.classList.remove("is-hidden");
  updateLocalBadge();
  window.addEventListener("online", updateLocalBadge);
  window.addEventListener("offline", updateLocalBadge);

  if (!("gpu" in navigator)) {
    setEngine("error", "WebGPU not available", "Try the latest Chrome or Edge on desktop.");
    return;
  }

  setEngine("loading", "Downloading the model…", "One-time ~5GB download, cached for next time.");
  showEngineProgress(true);
  try {
    engine = await CreateMLCEngine(LLM_MODEL, {
      initProgressCallback: (report) => {
        const pct = Math.round((report.progress || 0) * 100);
        setEngineProgress(pct);
        engineDetail.textContent = report.text || `${pct}%`;
      },
    });
  } catch (err) {
    showEngineProgress(false);
    setEngine("error", "Could not load the model", String(err && err.message ? err.message : err));
    return;
  }

  showEngineProgress(false);
  modelReady = true;
  setEngine("ready", "Model ready", "Everything runs locally from here on.");
  refreshState();
  input.focus();
}

function updateLocalBadge() {
  const offline = navigator.onLine === false;
  localBadge.textContent = offline ? "🔒 Offline · running locally" : "🔒 Runs locally";
  localBadge.classList.toggle("is-offline", offline);

  // Mirror the live state in the topbar pill so it's visible while chatting.
  if (topStatus && topStatusText) {
    topStatusText.textContent = offline ? "Running offline" : "Running locally";
    topStatus.classList.toggle("is-offline", offline);
  }
}

/* ════════════════════════════════════════════════════════════════════
 *  Sending & streaming
 * ════════════════════════════════════════════════════════════════════ */
async function onSubmit(event) {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || busy || !modelReady) return;
  send(text);
}

function applyQuickAction(action) {
  const tpl = ACTIONS[action];
  if (!tpl) return;
  const text = input.value.trim();
  if (!text) {
    hint.textContent = "Type or paste some text first, then pick a quick action.";
    input.focus();
    return;
  }
  send(tpl(text), { label: ACTION_LABELS[action] });
}

async function send(content, opts = {}) {
  if (busy || !modelReady) return;

  // Render the user's turn (show a friendly label for quick actions).
  addMessage("user", opts.label ? `${opts.label}\n\n${stripTemplate(content)}` : content);
  history.push({ role: "user", content });

  input.value = "";
  autoGrow();

  busy = true;
  stopRequested = false;
  refreshState();

  const bubble = addMessage("assistant", "");
  bubble.classList.add("is-streaming");
  let answer = "";

  try {
    const stream = await engine.chat.completions.create({
      messages: history,
      stream: true,
      temperature: 0.5,
      // Qwen3 is a hybrid reasoning model; keep replies as direct answers
      // (no <think> blocks) for this chat/writing assistant.
      extra_body: { enable_thinking: false },
    });

    for await (const part of stream) {
      if (stopRequested) {
        await engine.interruptGenerate();
        break;
      }
      const delta = part.choices?.[0]?.delta?.content || "";
      if (delta) {
        answer += delta;
        // Strip any reasoning block before painting (defensive: enable_thinking
        // should suppress it, but never show <think> contents to the user).
        bubble.textContent = stripThinking(answer);
        scrollToBottom();
      }
    }
  } catch (err) {
    answer = answer || `Something went wrong: ${err && err.message ? err.message : err}`;
    bubble.textContent = answer;
  } finally {
    answer = stripThinking(answer);
    bubble.classList.remove("is-streaming");
    renderMarkdown(bubble, answer);          // pretty markdown once complete
    bubble.dataset.raw = answer;             // copy yields the raw markdown
    history.push({ role: "assistant", content: answer });
    busy = false;
    refreshState();
    persistCurrent();
    input.focus();
  }
}

/* ════════════════════════════════════════════════════════════════════
 *  Conversation rendering
 * ════════════════════════════════════════════════════════════════════ */
function addMessage(role, text) {
  hideWelcome();

  const row = document.createElement("div");
  row.className = `msg msg--${role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "You" : "🔒";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "assistant" && text) renderMarkdown(bubble, text);
  else bubble.textContent = text;

  if (role === "assistant") {
    // Keep the raw text around so "Copy" yields markdown, not rendered HTML.
    bubble.dataset.raw = text || "";
    const col = document.createElement("div");
    col.className = "msg__col";
    col.append(bubble, buildMsgActions(bubble));
    row.append(avatar, col);
  } else {
    row.append(avatar, bubble);
  }

  messagesEl.appendChild(row);
  scrollToBottom();
  return bubble;
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

function buildMsgActions(bubble) {
  const bar = document.createElement("div");
  bar.className = "msg-actions";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "msg-action";
  copy.title = "Copy response";
  copy.innerHTML = `${COPY_ICON}<span>Copy</span>`;
  copy.addEventListener("click", () => copyText(bubble.dataset.raw || bubble.textContent, copy));

  bar.appendChild(copy);
  return bar;
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for non-secure contexts where the Clipboard API is blocked.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* give up */ }
    ta.remove();
  }
  const label = btn.querySelector("span");
  if (!label || btn.classList.contains("is-copied")) return;
  const prev = label.textContent;
  btn.classList.add("is-copied");
  btn.innerHTML = `${CHECK_ICON}<span>Copied</span>`;
  setTimeout(() => {
    btn.classList.remove("is-copied");
    btn.innerHTML = `${COPY_ICON}<span>${prev}</span>`;
  }, 1400);
}

function renderMarkdown(el, text) {
  try {
    el.innerHTML = marked.parse(text || "");
  } catch {
    el.textContent = text || "";
  }
}

function hideWelcome() {
  const welcome = $("welcome");
  if (welcome) welcome.remove();
}

function renderAllMessages() {
  messagesEl.innerHTML = "";
  const turns = history.filter((m) => m.role !== "system");
  for (const m of turns) addMessage(m.role, m.content);
  if (!turns.length) {
    hint.textContent = modelReady ? "Your messages stay on this device." : "Waiting for the model to load…";
  }
  updateConvMeta();
}

function updateConvMeta() {
  const turns = history.filter((m) => m.role === "user").length;
  convMeta.textContent = turns
    ? `${turns} message${turns === 1 ? "" : "s"} · stays on this device`
    : "New conversation";
}

function scrollToBottom() {
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

/* ════════════════════════════════════════════════════════════════════
 *  Conversation history (localStorage + sidebar)
 * ════════════════════════════════════════════════════════════════════ */
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(conversations));
  } catch { /* storage full or unavailable, stay in-memory */ }
}

function newConversation(opts = {}) {
  if (busy) return;
  currentId = null;
  history = [{ role: "system", content: SYSTEM_PROMPT }];
  messagesEl.innerHTML = "";
  // Restore the welcome screen.
  const welcome = buildWelcome();
  messagesEl.appendChild(welcome);
  updateConvMeta();
  renderConversationList();
  toggleNav(false);
  if (!opts.silent) input.focus();
}

// Persist the active conversation (creating it on first assistant reply).
function persistCurrent() {
  const turns = history.filter((m) => m.role !== "system");
  if (!turns.length) return;

  const firstUser = history.find((m) => m.role === "user");
  const title = firstUser ? truncate(stripTemplate(firstUser.content), 48) : "New chat";

  if (!currentId) {
    currentId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    conversations.unshift({ id: currentId, title, history: [...history], updatedAt: Date.now() });
  } else {
    const conv = conversations.find((c) => c.id === currentId);
    if (conv) {
      conv.title = title;
      conv.history = [...history];
      conv.updatedAt = Date.now();
      // Move to top.
      conversations = [conv, ...conversations.filter((c) => c.id !== currentId)];
    }
  }
  saveStore();
  renderConversationList();
}

function openConversation(id) {
  if (busy) return;
  const conv = conversations.find((c) => c.id === id);
  if (!conv) return;
  currentId = id;
  history = conv.history.length ? [...conv.history] : [{ role: "system", content: SYSTEM_PROMPT }];
  if (history[0]?.role !== "system") history.unshift({ role: "system", content: SYSTEM_PROMPT });
  renderAllMessages();
  renderConversationList();
  toggleNav(false);
  scrollToBottom();
}

function deleteConversation(id, ev) {
  ev?.stopPropagation();
  conversations = conversations.filter((c) => c.id !== id);
  saveStore();
  if (id === currentId) newConversation({ silent: true });
  else renderConversationList();
}

function renderConversationList() {
  conversationsEl.innerHTML = "";
  if (!conversations.length) {
    const empty = document.createElement("p");
    empty.className = "conv-empty";
    empty.textContent = "No conversations yet. Your chats are saved on this device only.";
    conversationsEl.appendChild(empty);
    return;
  }

  const group = document.createElement("div");
  group.className = "conv-group";
  group.textContent = "Recent";
  conversationsEl.appendChild(group);

  for (const conv of conversations) {
    const item = document.createElement("div");
    item.className = "conv-item" + (conv.id === currentId ? " is-active" : "");
    item.setAttribute("role", "button");
    item.tabIndex = 0;

    const title = document.createElement("span");
    title.className = "conv-item__title";
    title.textContent = conv.title || "New chat";

    const del = document.createElement("button");
    del.className = "conv-item__del";
    del.type = "button";
    del.title = "Delete conversation";
    del.setAttribute("aria-label", "Delete conversation");
    del.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2m-9 0v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6"/></svg>';

    item.append(title, del);
    item.addEventListener("click", () => openConversation(conv.id));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openConversation(conv.id); }
    });
    del.addEventListener("click", (e) => deleteConversation(conv.id, e));
    conversationsEl.appendChild(item);
  }
}

/* ════════════════════════════════════════════════════════════════════
 *  UI helpers
 * ════════════════════════════════════════════════════════════════════ */
function refreshState() {
  const canType = modelReady && !busy;
  input.disabled = !canType;
  sendBtn.disabled = !canType || !input.value.trim();
  quickActions.querySelectorAll(".chip").forEach((c) => (c.disabled = !canType));
  document.querySelectorAll(".suggestion").forEach((s) => (s.disabled = !canType));
  stopBtn.classList.toggle("is-hidden", !busy);
  sendBtn.classList.toggle("is-hidden", busy);

  if (busy) hint.textContent = "Generating locally on your GPU…";
  else if (!modelReady) hint.textContent = "Waiting for the model to load…";
  else hint.textContent = "Your messages stay on this device.";
}

// Keep the send button reactive to typed input.
input.addEventListener("input", () => {
  if (modelReady && !busy) sendBtn.disabled = !input.value.trim();
});

function autoGrow() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

function toggleNav(force) {
  const open = typeof force === "boolean" ? force : !appEl.classList.contains("nav-open");
  appEl.classList.toggle("nav-open", open);
  scrimEl.hidden = !open;
  // Allow the element to exist before transitioning opacity.
  requestAnimationFrame(() => scrimEl.classList.toggle("is-shown", open));
}

function setEngine(kind, title, detail) {
  engineDot.className = `dot dot--${kind}`;
  engineState.textContent = title;
  engineDetail.textContent = detail;
}
function showEngineProgress(show) {
  engineProgressWrap.classList.toggle("is-hidden", !show);
}
function setEngineProgress(pct) {
  engineProgress.style.width = `${pct}%`;
}

// Rebuild the welcome/empty state node (suggestion cards prefill the composer).
function buildWelcome() {
  const tpl = `
    <div class="welcome" id="welcome">
      <div class="welcome__mark" aria-hidden="true">🔒</div>
      <h1 class="welcome__title">Your own private AI</h1>
      <p class="welcome__sub">A general AI assistant for chatting, drafting, rewriting and summarizing. Running locally on your device. Nothing you type ever leaves this page.</p>
      <div class="suggestions" id="suggestions">
        <button class="suggestion" type="button" data-fill="Explain quantum computing like I'm five."><span class="suggestion__icon">🧠</span><span class="suggestion__text"><strong>Explain a concept</strong>Quantum computing, simply</span></button>
        <button class="suggestion" type="button" data-fill="Draft a short, friendly email asking a client for feedback on our last project."><span class="suggestion__icon">✉️</span><span class="suggestion__text"><strong>Draft an email</strong>Ask a client for feedback</span></button>
        <button class="suggestion" type="button" data-fill="Give me 5 creative names for a privacy-first note-taking app."><span class="suggestion__icon">💡</span><span class="suggestion__text"><strong>Brainstorm names</strong>For a new app</span></button>
        <button class="suggestion" type="button" data-fill="Summarize the key idea of compound interest in three bullet points."><span class="suggestion__icon">📝</span><span class="suggestion__text"><strong>Summarize</strong>Compound interest in 3 points</span></button>
      </div>
    </div>`;
  const frag = document.createElement("template");
  frag.innerHTML = tpl.trim();
  const node = frag.content.firstChild;
  node.querySelector("#suggestions").addEventListener("click", (e) => {
    const card = e.target.closest(".suggestion");
    if (!card || !modelReady || busy) return;
    input.value = card.dataset.fill || "";
    autoGrow();
    sendBtn.disabled = !input.value.trim();
    input.focus();
  });
  return node;
}

// Remove Qwen3 reasoning blocks. Drops a closed <think>…</think> span, and while
// a block is still streaming (open <think> with no close yet) hides everything
// after it so partial reasoning never flashes on screen.
function stripThinking(text) {
  if (!text) return text;
  let out = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, "");
  const open = out.lastIndexOf("<think>");
  if (open !== -1) out = out.slice(0, open);
  return out.replace(/^\s+/, "");
}

// For quick actions, show the user's original text in the bubble (not the template wrapper).
function stripTemplate(content) {
  const idx = content.indexOf("\n\n");
  return idx >= 0 ? content.slice(idx + 2) : content;
}

function truncate(s, n) {
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/* ────────────────────────────────────────────────────────────────────
 *  Next steps (out of scope for this slice):
 *   • Render markdown live while streaming (currently rendered on finish).
 *   • Trim old turns when the context window fills up.
 *   • Share the loaded engine with /ask so the model loads once site-wide.
 * ──────────────────────────────────────────────────────────────────── */
