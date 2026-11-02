/* =========================================================
   Groq Relay — 前端交互逻辑（零依赖，原生 JS）
   功能：健康检查 / 模型列表 / 流式聊天 / 代码示例 / 复制
   ========================================================= */
(() => {
  "use strict";

  const API_BASE = "/v1";
  const HEALTH_URL = "/health";
  const STORAGE = {
    key: "groqRelay.key",
    pw: "groqRelay.password",
    model: "groqRelay.model",
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    apiKey: localStorage.getItem(STORAGE.key) || "",
    relayPassword: localStorage.getItem(STORAGE.pw) || "",
    model: localStorage.getItem(STORAGE.model) || "",
    health: null,
    messages: [],
    streaming: false,
    controller: null,
    lang: "curl",
  };

  // 拉取真实 /v1/models 失败时的兜底列表
  const FALLBACK_MODELS = [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "meta-llama/llama-4-maverick-17b-128e-instruct",
    "qwen/qwen3-32b",
  ];

  const CHAT_FILTER = /whisper|tts|guard|embed/i;

  // ---------------- 工具函数 ----------------

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case "&": return "&amp;";
        case "<": return "&lt;";
        case ">": return "&gt;";
        case '"': return "&quot;";
        default: return "&#39;";
      }
    });
  }

  let toastTimer = 0;
  function toast(message, kind = "") {
    const el = $("#toast");
    if (!el) return;
    el.textContent = message;
    el.className = "toast show" + (kind ? " " + kind : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.className = "toast";
    }, 2800);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制到剪贴板", "ok");
      return;
    } catch {
      /* 继续用兜底方案 */
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
      toast("已复制到剪贴板", "ok");
    } catch {
      toast("复制失败，请手动选择内容", "err");
    } finally {
      area.remove();
    }
  }

  function baseUrl() {
    if (location.protocol === "file:") return "https://your-site.netlify.app/v1";
    return location.origin + "/v1";
  }

  async function safeJson(res) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  // ---------------- Markdown 轻量渲染（先转义，保证安全） ----------------

  const CODE_LANGS = new Set([
    "js", "javascript", "ts", "typescript", "jsx", "tsx",
    "py", "python", "bash", "sh", "shell", "zsh",
    "json", "html", "css", "sql", "text", "plain", "diff", "yaml", "yml", "toml", "go", "rust", "java", "rb", "php",
  ]);

  function renderMarkdown(text) {
    if (!text) return "";
    const parts = String(text).split("```");
    let html = "";
    for (let i = 0; i < parts.length; i += 1) {
      if (i % 2 === 1) {
        let body = parts[i];
        const nl = body.indexOf("\n");
        if (nl !== -1) {
          const firstLine = body.slice(0, nl).trim().toLowerCase();
          if (CODE_LANGS.has(firstLine)) body = body.slice(nl + 1);
        }
        body = body.replace(/\n$/, "");
        html += '<pre class="code"><code>' + escapeHtml(body) + "</code></pre>";
      } else {
        html += inlineMarkdown(parts[i]);
      }
    }
    return html;
  }

  function inlineMarkdown(text) {
    return escapeHtml(text)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  }

  // ---------------- 代理健康检查 ----------------

  async function refreshHealth() {
    const pill = $("#statusPill");
    const started = performance.now();
    try {
      const res = await fetch(HEALTH_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const ms = Math.round(performance.now() - started);
      state.health = data;

      pill.textContent = "在线";
      pill.className = "pill pill-ok";
      $("#statusBase").textContent = baseUrl();
      $("#statusUpstream").textContent = String(data.upstream || "").replace(/^https?:\/\//, "");
      $("#statusPassword").textContent = data.password_required ? "需要（x-relay-password）" : "无需密码";
      $("#statusLatency").textContent = ms + " ms";

      const badge = $("#healthBadge");
      badge.className = "health-badge ok";
      $("#healthText").textContent = "代理在线";

      const relayWrap = $("#relayPwWrap");
      if (relayWrap) relayWrap.hidden = !data.password_required;
    } catch (err) {
      state.health = null;
      pill.textContent = "离线";
      pill.className = "pill pill-bad";
      $("#statusUpstream").textContent = "—";
      $("#statusPassword").textContent = "—";
      $("#statusLatency").textContent = "—";

      const badge = $("#healthBadge");
      badge.className = "health-badge bad";
      $("#healthText").textContent = "代理离线";
      console.warn("[groq-relay] health check failed:", err);
    }
  }

  // ---------------- 模型列表 ----------------

  function apiHeaders() {
    const headers = { accept: "application/json" };
    if (state.apiKey) headers.authorization = "Bearer " + state.apiKey;
    if (state.relayPassword) headers["x-relay-password"] = state.relayPassword;
    return headers;
  }

  function pickModel(ids, previous) {
    const preferred = [
      previous,
      state.model,
      "llama-3.3-70b-versatile",
      "openai/gpt-oss-120b",
      "llama-3.1-8b-instant",
    ];
    for (const candidate of preferred) {
      if (candidate && ids.includes(candidate)) return candidate;
    }
    return ids[0] || "";
  }

  function fillModels(ids, dynamic) {
    const select = $("#modelSelect");
    if (!select) return;
    const list = Array.from(new Set((ids || []).filter(Boolean)));
    const previous = state.model || select.value;

    select.innerHTML = "";
    if (!list.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "（未获取到模型）";
      select.appendChild(option);
      select.disabled = true;
      return;
    }
    select.disabled = false;

    const chatList = list.filter((id) => !CHAT_FILTER.test(id));
    const shown = chatList.length ? chatList : list;
    for (const id of shown) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      select.appendChild(option);
    }

    state.model = pickModel(shown, previous);
    select.value = state.model;
    localStorage.setItem(STORAGE.model, state.model);
    select.title = dynamic ? "模型列表来自上游 /v1/models" : "内置兜底模型列表（填写 Key 后可自动拉取）";
  }

  async function loadModels(silent) {
    if (!state.apiKey) {
      fillModels(FALLBACK_MODELS, false);
      if (!silent) toast("填写 Key 后可自动拉取模型列表", "");
      return;
    }
    try {
      const res = await fetch(API_BASE + "/models", { headers: apiHeaders() });
      const data = await safeJson(res);
      if (!res.ok) {
        throw new Error((data && data.error && data.error.message) || "HTTP " + res.status);
      }
      const ids = Array.isArray(data && data.data) ? data.data.map((m) => m.id).sort() : [];
      if (!ids.length) throw new Error("上游返回的模型列表为空");
      fillModels(ids, true);
      if (!silent) toast("已加载 " + ids.length + " 个模型", "ok");
    } catch (err) {
      fillModels(FALLBACK_MODELS, false);
      if (!silent) toast("模型列表加载失败：" + err.message, "err");
      console.warn("[groq-relay] load models failed:", err);
    }
  }

  // ---------------- 聊天 ----------------

  function messageHtml(message) {
    const meta = message.meta
      ? '<div class="msg-meta">' + escapeHtml(message.meta) + "</div>"
      : "";
    return (
      '<div class="msg msg-' + message.role + '">' +
      '<div class="msg-body">' + renderMarkdown(message.content) + "</div>" +
      meta +
      "</div>"
    );
  }

  function renderChat() {
    const log = $("#chatLog");
    if (!log) return;
    if (!state.messages.length) {
      log.innerHTML =
        '<div class="chat-empty" id="chatEmpty">' +
        '<span class="chat-empty-icon">💬</span>' +
        "<p>填好 Key 后，在下方提问即可验证代理链路。</p>" +
        '<p class="muted">试试点“发送”问一句：用一句话介绍你自己。</p>' +
        "</div>";
      return;
    }
    log.innerHTML = state.messages.map(messageHtml).join("");
    scrollChatToBottom(true);
  }

  let rafPending = false;
  function renderAssistantStreaming(message) {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const node = $("#chatLog .msg-assistant:last-child .msg-body");
      if (!node) return;
      node.innerHTML = renderMarkdown(message.content);
      scrollChatToBottom(false);
    });
  }

  function scrollChatToBottom(force) {
    const log = $("#chatLog");
    if (!log) return;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 90;
    if (force || nearBottom) log.scrollTop = log.scrollHeight;
  }

  function buildMessages() {
    return state.messages
      .filter((m) => m.content && m.content.trim())
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));
  }

  function setStreaming(on) {
    state.streaming = on;
    $("#sendBtn").disabled = on;
    $("#stopBtn").hidden = !on;
    if (!on) $("#chatStatus").textContent = "";
  }

  async function sendMessage(rawText) {
    const text = (rawText || "").trim();
    syncFields();
    if (!state.apiKey) {
      toast("请先填写 Groq API Key", "err");
      $("#apiKey").focus();
      return;
    }
    if (!state.model) {
      toast("请先选择模型", "err");
      return;
    }
    if (!text || state.streaming) return;

    $("#chatInput").value = "";
    state.messages.push({ role: "user", content: text });
    const assistant = { role: "assistant", content: "", meta: "" };
    state.messages.push(assistant);
    renderChat();
    setStreaming(true);
    $("#chatStatus").textContent = "生成中…";

    const started = performance.now();
    let ttfb = null;
    state.controller = new AbortController();

    try {
      const res = await fetch(API_BASE + "/chat/completions", {
        method: "POST",
        headers: Object.assign({ "content-type": "application/json" }, apiHeaders()),
        body: JSON.stringify({
          model: state.model,
          messages: buildMessages(),
          stream: true,
        }),
        signal: state.controller.signal,
      });

      if (!res.ok) {
        const data = await safeJson(res);
        throw new Error(
          (data && data.error && data.error.message) || "HTTP " + res.status,
        );
      }
      if (!res.body) throw new Error("响应中没有可读取的流");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let usage = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let chunk = null;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) || {};
          if (delta.content) {
            if (ttfb === null) ttfb = performance.now();
            assistant.content += delta.content;
            renderAssistantStreaming(assistant);
          }
          if (chunk.x_groq && chunk.x_groq.usage) usage = chunk.x_groq.usage;
          if (chunk.usage) usage = chunk.usage;
        }
      }

      const total = performance.now() - started;
      const parts = [];
      if (ttfb !== null) parts.push("首字 " + ((ttfb - started) / 1000).toFixed(2) + "s");
      parts.push("总耗时 " + (total / 1000).toFixed(2) + "s");
      if (usage && usage.completion_tokens != null) {
        parts.push("输出 " + Number(usage.completion_tokens).toLocaleString() + " tokens");
      }
      assistant.meta = parts.join(" · ");
      $("#chatStatus").textContent = "完成";
    } catch (err) {
      if (err && err.name === "AbortError") {
        assistant.content += (assistant.content ? "\n\n" : "") + "（已停止）";
      } else {
        const reason = (err && err.message) || String(err);
        assistant.content += (assistant.content ? "\n\n" : "") + "错误：" + reason;
        $("#chatStatus").textContent = "请求失败";
        toast("请求失败：" + reason, "err");
      }
      assistant.meta = "";
    } finally {
      state.controller = null;
      setStreaming(false);
      renderChat();
    }
  }

  // ---------------- 表单字段同步 ----------------

  function syncFields() {
    const keyInput = $("#apiKey");
    const pwInput = $("#relayPassword");
    if (keyInput) state.apiKey = keyInput.value.trim();
    if (pwInput) state.relayPassword = pwInput.value.trim();
  }

  function persistFields() {
    if (state.apiKey) localStorage.setItem(STORAGE.key, state.apiKey);
    else localStorage.removeItem(STORAGE.key);
    if (state.relayPassword) localStorage.setItem(STORAGE.pw, state.relayPassword);
    else localStorage.removeItem(STORAGE.pw);
  }

  // ---------------- 代码示例 ----------------

  const SNIPPETS = {
    curl: (base) => `curl "${base}/chat/completions" \\\n  -H "Authorization: Bearer $GROQ_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "llama-3.3-70b-versatile",\n    "messages": [{"role": "user", "content": "你好，介绍一下你自己"}],\n    "stream": true\n  }'`,

    python: (base) => `from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key="gsk_你的Key",
)

stream = client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)`,

    node: (base) => `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}",
  apiKey: process.env.GROQ_API_KEY,
});

const stream = await client.chat.completions.create({
  model: "llama-3.3-70b-versatile",
  messages: [{ role: "user", content: "你好" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}`,

    fetch: (base) => `const base = "${base}";
const apiKey = "gsk_你的Key";

const res = await fetch(\`\${base}/chat/completions\`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: \`Bearer \${apiKey}\`,
  },
  body: JSON.stringify({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: "你好" }],
    stream: true,
  }),
});

const reader = res.body.getReader();
const decoder = new TextDecoder();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  for (const line of decoder.decode(value, { stream: true }).split("\\n")) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
    const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
    if (delta) process.stdout.write(delta);
  }
}`,
  };

  function updateCodeBlock(lang) {
    state.lang = lang;
    const block = $("#codeBlock");
    if (block) block.textContent = SNIPPETS[lang] ? SNIPPETS[lang](baseUrl()) : "";
    $$(".tab").forEach((tab) => {
      const active = tab.dataset.lang === lang;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  // ---------------- 事件绑定 ----------------

  function bindEvents() {
    const chatForm = $("#chatForm");
    const chatInput = $("#chatInput");

    chatForm.addEventListener("submit", (event) => {
      event.preventDefault();
      sendMessage(chatInput ? chatInput.value : "");
    });

    if (chatInput) {
      chatInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          chatForm.requestSubmit();
        }
      });
    }

    $("#stopBtn").addEventListener("click", () => {
      if (state.controller) state.controller.abort();
    });

    $("#saveKey").addEventListener("click", () => {
      syncFields();
      if (!state.apiKey) {
        toast("请填写 Groq API Key", "err");
        $("#apiKey").focus();
        return;
      }
      persistFields();
      toast("Key 已保存在本机浏览器", "ok");
      loadModels(false);
    });

    $("#clearKey").addEventListener("click", () => {
      state.apiKey = "";
      state.relayPassword = "";
      $("#apiKey").value = "";
      $("#relayPassword").value = "";
      localStorage.removeItem(STORAGE.key);
      localStorage.removeItem(STORAGE.pw);
      fillModels(FALLBACK_MODELS, false);
      $("#connStatus").textContent = "";
      toast("已清除本机保存的 Key", "");
    });

    $("#refreshModels").addEventListener("click", () => {
      syncFields();
      persistFields();
      loadModels(false);
    });

    $("#testConnection").addEventListener("click", testConnection);

    $("#copyBase").addEventListener("click", () => copyText(baseUrl()));
    $("#copyBaseHero").addEventListener("click", () => copyText(baseUrl()));
    $("#copyCode").addEventListener("click", () => copyText($("#codeBlock").textContent || ""));

    $$(".tab").forEach((tab) => {
      tab.addEventListener("click", () => updateCodeBlock(tab.dataset.lang));
    });

    $("#modelSelect").addEventListener("change", (event) => {
      state.model = event.target.value;
      localStorage.setItem(STORAGE.model, state.model);
    });

    const menuBtn = $("#menuBtn");
    const siteNav = $("#siteNav");
    if (menuBtn && siteNav) {
      menuBtn.addEventListener("click", () => {
        const open = siteNav.classList.toggle("open");
        menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
      });
      siteNav.addEventListener("click", (event) => {
        if (event.target.tagName === "A") {
          siteNav.classList.remove("open");
          menuBtn.setAttribute("aria-expanded", "false");
        }
      });
    }
  }

  async function testConnection() {
    syncFields();
    persistFields();
    if (!state.apiKey) {
      toast("请先填写 Groq API Key", "err");
      $("#apiKey").focus();
      return;
    }
    const status = $("#connStatus");
    status.textContent = "测试中…";
    const started = performance.now();
    try {
      const res = await fetch(API_BASE + "/models", { headers: apiHeaders() });
      const ms = Math.round(performance.now() - started);
      const data = await safeJson(res);
      if (!res.ok) {
        throw new Error((data && data.error && data.error.message) || "HTTP " + res.status);
      }
      const ids = Array.isArray(data && data.data) ? data.data.map((m) => m.id) : [];
      status.textContent = "✓ 连接成功 · " + ms + " ms · " + ids.length + " 个模型";
      toast("代理链路正常，Groq 返回 " + ids.length + " 个模型", "ok");
      if (ids.length) fillModels(ids.sort(), true);
    } catch (err) {
      status.textContent = "✗ " + err.message;
      toast("连接失败：" + err.message, "err");
    }
  }

  function init() {
    $("#apiKey").value = state.apiKey;
    $("#relayPassword").value = state.relayPassword;
    $("#baseUrlText").textContent = baseUrl();

    bindEvents();
    fillModels(FALLBACK_MODELS, false);
    updateCodeBlock(state.lang);
    refreshHealth();
    if (state.apiKey) loadModels(true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
