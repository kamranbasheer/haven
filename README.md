# Haven — a fully on-device, private AI assistant

A general-purpose AI chat & writing assistant that runs **entirely in your browser**.
There is no backend, no API key, and no network call to any AI provider. The language
model is downloaded once, cached on your machine, and every token after that is
generated **on your own GPU**. Nothing you type ever leaves the page.

This document explains *how* that works — the runtime, the model, where it lives, and
how you can prove to yourself that it really is offline.

---

## TL;DR

| | Typical cloud chat (e.g. ChatGPT) | Haven (this app) |
|---|---|---|
| Where inference runs | Provider's servers | Your browser, on your GPU |
| Your messages | Sent over the network | Never leave the tab |
| Needs internet | Always | Only for the **one-time** model download |
| API key / account | Required | None |
| Works on a plane (after first load) | No | Yes |
| Chat history | On the provider's servers | `localStorage`, on your device only |

---

## The big picture

```
┌──────────────────────────── Your browser tab ────────────────────────────┐
│                                                                           │
│   index.html ──► app.js ──► WebLLM (@mlc-ai/web-llm)                       │
│                                   │                                        │
│                                   ▼                                        │
│                       MLC runtime (WebAssembly)                            │
│                                   │                                        │
│                                   ▼                                        │
│                       WebGPU  ──►  your GPU                                │
│                                                                           │
│   Model weights  ◄─────────  Browser Cache Storage (one-time download)     │
│   Chat history   ◄─────────  localStorage                                  │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
        ▲
        │  network is used ONLY here, once:
        └── first visit downloads model weights from a CDN, then it's cached
```

After the first load, you can switch off Wi-Fi and the assistant keeps working — the
badge in the sidebar even flips to **"🔒 Offline · running locally"** to prove it.

---

## What actually does the thinking

### 1. The model: Qwen2.5-7B-Instruct (quantized)

The app loads a single instruct-tuned model:

```js
// app.js
const LLM_MODEL = "Qwen2.5-7B-Instruct-q4f16_1-MLC";
```

- **Qwen2.5-7B-Instruct** — a strong, general-purpose chat/instruction model (~7B parameters).
- **`q4f16_1`** — the weights are **4-bit quantized** (with fp16 activations). Quantization
  shrinks the model from tens of GB down to a roughly **~5 GB** one-time download and lets
  it fit in consumer GPU memory.
- **`-MLC`** — the model has been compiled into the format the MLC runtime understands
  (see below).

If your GPU is tight on memory, the smaller `Qwen2.5-3B-Instruct-q4f16_1-MLC` (~2.5 GB)
is a drop-in replacement — change the one constant above.

### 2. The engine: WebLLM + MLC

The app talks to the model through [**WebLLM**](https://github.com/mlc-ai/web-llm), the
in-browser inference engine from the MLC (Machine Learning Compilation) project. It's
pulled straight from a CDN as an ES module:

```js
import { CreateMLCEngine } from "https://esm.run/@mlc-ai/web-llm";
```

WebLLM gives us an **OpenAI-compatible API** (`engine.chat.completions.create(...)`),
but instead of sending an HTTP request to a server, it runs the model locally:

- The model's compute graph is compiled (ahead of time, by MLC) and shipped as
  **WebAssembly** + GPU shader code.
- At runtime WebLLM uses that to execute the transformer **on your GPU via WebGPU**.

### 3. The hardware path: WebGPU

[**WebGPU**](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API) is the modern
browser API for general-purpose GPU compute. It's what makes running a 7B model in a tab
practical. The app checks for it before doing anything:

```js
if (!("gpu" in navigator)) {
  setEngine("error", "WebGPU not available",
    "Try the latest Chrome or Edge on desktop.");
  return;
}
```

No WebGPU ⇒ no local model. There is intentionally **no cloud fallback**, because a cloud
fallback would break the privacy guarantee.

---

## The lifecycle of a session

### First visit — the only time the network is touched for AI

1. `boot()` checks for WebGPU.
2. It calls `CreateMLCEngine(LLM_MODEL, { initProgressCallback })`.
3. WebLLM downloads the model shards (~5 GB) from the MLC model CDN and the compiled
   WASM runtime. Progress is streamed to the sidebar status:

   ```js
   engine = await CreateMLCEngine(LLM_MODEL, {
     initProgressCallback: (report) => {
       const pct = Math.round((report.progress || 0) * 100);
       setEngineProgress(pct);
       engineDetail.textContent = report.text || `${pct}%`;
     },
   });
   ```

4. The browser stores those weights in its **Cache Storage / IndexedDB**. This is the
   "one-time download, cached for next time" you see in the UI.

### Every visit after that — fully local

- The weights are already cached, so loading is just reading them off disk into GPU
  memory. No download, no server.
- Once ready, the status dot turns green ("Model ready · Everything runs locally from
  here on") and the composer unlocks.

### Sending a message

When you hit send, the conversation (a plain array of `{role, content}` messages,
starting with a system prompt) is handed to the local engine and the reply is
**streamed token-by-token** straight from your GPU:

```js
const stream = await engine.chat.completions.create({
  messages: history,   // your whole conversation, in memory only
  stream: true,
  temperature: 0.5,
});

for await (const part of stream) {
  const delta = part.choices?.[0]?.delta?.content || "";
  // append delta to the on-screen bubble...
}
```

There is no `fetch()` to an AI server anywhere in this loop. `history` lives in a
JavaScript variable in your tab and is never transmitted.

---

## Where your data lives (and where it doesn't)

| Data | Stored in | Leaves your device? |
|---|---|---|
| Model weights | Browser Cache Storage / IndexedDB | No (downloaded once **to** you) |
| Current conversation | In-memory JS (`history` array) | **No** |
| Saved chat history | `localStorage` key `haven.conversations.v1` | **No** |
| Your prompts & the model's replies | Stay in the tab | **No** |

Chat history is persisted locally so your conversations survive a page reload and show
up in the sidebar:

```js
const STORE_KEY = "haven.conversations.v1";
// conversations are JSON-serialized into localStorage; nothing is uploaded.
```

Because it's `localStorage`, it's **per-browser and per-device**. Clearing your browser
data (or deleting a chat in the sidebar) removes it for good. There is no server copy.

---

## Prove it to yourself

You don't have to take the word "private" on faith:

1. **Load the page once** and wait for the model to finish downloading ("Model ready").
2. **Open DevTools → Network**, then send a few messages. You'll see **no requests**
   going out while chatting — generation is local.
3. **Go offline**: turn off Wi-Fi, or in DevTools → Network set throttling to *Offline*.
4. Keep chatting. It still works, and the sidebar badge changes to
   **"🔒 Offline · running locally"** (driven by the browser's `online`/`offline` events):

   ```js
   window.addEventListener("offline", updateLocalBadge);
   ```

If it can answer with the network physically off, the answer is obviously coming from
your own machine.

---

## Requirements

- **A WebGPU-capable browser**: current **Chrome** or **Edge** on desktop are the surest
  bet. (Safari and Firefox WebGPU support is progressing but less reliable for models
  this size.)
- **A reasonably modern GPU** with enough memory:
  - ~6 GB+ free VRAM for the default 7B model.
  - ~3 GB+ for the 3B alternative.
- **~5 GB of free disk** for the cached weights (one-time).
- Internet **once**, for the initial download. After that, offline is fine.

---

## Files

| File | Role |
|---|---|
| `index.html` | The app shell — sidebar (history + status) and chat pane markup. |
| `app.js` | All the logic: WebGPU check, model load, streaming, history, markdown, copy. |
| `styles.css` | The full-screen app UI. |
| `demo.html` | A **static** screenshot/demo page (no model, no JS) for previews. |

---

## Design choices & trade-offs

- **No backend, on purpose.** The entire privacy story depends on there being no server
  to send your text to. That's also why there's no account, no API key, and no telemetry.
- **One-time cost for permanent privacy.** The ~5 GB download is the price of admission;
  after that everything is free, instant-to-start, and offline-capable.
- **It runs on *your* hardware.** Speed depends on your GPU. A 7B model on a laptop iGPU
  will be slower than on a discrete GPU — but it's *yours*, and it works on a plane.
- **Markdown is rendered locally** from the model's output for readability; assistant
  replies include a **Copy** button to grab the raw markdown.

---

## Roadmap / known limitations

- Markdown is rendered when a reply **finishes** (streamed as plain text first) for speed.
- Very long conversations will eventually hit the model's context window; old turns
  aren't trimmed yet.
- The engine reloads per page/app; sharing one loaded engine across the site (e.g. with
  the `/ask` tool) is a future optimization.

---

**Bottom line:** the only thing the network is ever used for is fetching the model the
first time. Every prompt, every token of every reply, and your entire chat history stay
on your device — provably so, even with the Wi-Fi off.
