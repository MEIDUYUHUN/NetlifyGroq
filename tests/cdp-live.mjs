// 开发辅助：在真实线上站点上，用真实 Groq Key 走一遍「填 Key → 加载模型 → 流式对话」。
// 用法（Key 从环境变量传入，不落盘）：
//   $env:GROQ_TEST_KEY="gsk_..."
//   chrome --headless=new --remote-debugging-port=9225 --window-size=1440,2200 https://netlifygrog.netlify.app/
//   node tests/cdp-live.mjs
const CDP_HTTP = "http://127.0.0.1:9225";
const KEY = process.env.GROQ_TEST_KEY || "";
if (!KEY) {
  console.error("缺少 GROQ_TEST_KEY 环境变量");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pages = await (await fetch(CDP_HTTP + "/json/list")).json();
const target = pages.find((p) => p.type === "page" && p.url.includes("netlifygrog"));
if (!target) {
  console.error("未找到线上站点页面");
  process.exit(1);
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.result && result.result.exceptionDetails) {
    throw new Error(JSON.stringify(result.result.exceptionDetails));
  }
  return result.result && result.result.result ? result.result.result.value : undefined;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Runtime.evaluate", { expression: "location.reload()" });
await sleep(3000);

console.log("标题:", await evaluate("document.title"));
console.log("健康状态:", await evaluate(`document.querySelector("#statusPill").textContent + " | " + document.querySelector("#statusUpstream").textContent`));

// 填 Key、保存（触发模型列表加载）
await evaluate(`(async () => {
  const key = document.querySelector("#apiKey");
  key.value = ${JSON.stringify(KEY)};
  key.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector("#saveKey").click();
  await new Promise((r) => setTimeout(r, 3500));
  const select = document.querySelector("#modelSelect");
  return "options=" + select.options.length + " selected=" + select.value;
})()`);

const modelInfo = await evaluate(`(() => {
  const select = document.querySelector("#modelSelect");
  return "options=" + select.options.length + " selected=" + select.value;
})()`);
console.log("模型列表:", modelInfo);

console.log("发送消息…");
const chatResult = await evaluate(`(async () => {
  const select = document.querySelector("#modelSelect");
  select.value = "openai/gpt-oss-120b";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  const input = document.querySelector("#chatInput");
  input.value = "Reply with exactly: relay-ok";
  document.querySelector("#chatForm").requestSubmit();
  await new Promise((r) => setTimeout(r, 9000));
  return document.querySelector("#chatStatus").textContent + " || " + document.querySelector("#chatLog").innerText.slice(0, 220);
})()`);
console.log("聊天结果:", chatResult);

await evaluate(`document.querySelector("#playground").scrollIntoView({ block: "start" }); "ok"`);
await sleep(500);
const shot = await send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs/promises");
const out = new URL("./ui-live.png", import.meta.url);
await fs.writeFile(out, Buffer.from(shot.result.data, "base64"));
console.log("截图:", out.pathname);
socket.close();
