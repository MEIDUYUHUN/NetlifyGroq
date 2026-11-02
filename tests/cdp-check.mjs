// 开发辅助：通过 Chrome DevTools Protocol 驱动真实页面，验证“填写 Key → 发送 → 流式渲染”全链路。
// 用法：
//   1) chrome --headless=new --remote-debugging-port=9223 --window-size=1440,2200 http://127.0.0.1:4173/
//   2) node tests/cdp-check.mjs
const CDP_HTTP = "http://127.0.0.1:9223";
const OUT = new URL("./ui-playground.png", import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pages = await (await fetch(CDP_HTTP + "/json/list")).json();
const target = pages.find((page) => page.type === "page" && page.url.includes("127.0.0.1:4173"));
if (!target) {
  console.error("未找到目标页面，请先启动带 --remote-debugging-port=9223 的 Chrome");
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

async function evaluate(expression, awaitPromise = true) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.result && result.result.exceptionDetails) {
    throw new Error(JSON.stringify(result.result.exceptionDetails));
  }
  return result.result && result.result.result ? result.result.result.value : undefined;
}

await send("Runtime.enable");
await send("Page.enable");

const before = await evaluate(`document.title + " | key=" + document.querySelector("#apiKey").value`);
console.log("页面状态:", before);

// 填写 Key、保存、触发一次流式对话
const sent = await evaluate(`(async () => {
  const key = document.querySelector("#apiKey");
  key.value = "test-key";
  key.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector("#saveKey").click();
  await new Promise(r => setTimeout(r, 700));
  const input = document.querySelector("#chatInput");
  input.value = "用一句话介绍你自己";
  document.querySelector("#chatForm").requestSubmit();
  await new Promise(r => setTimeout(r, 2500));
  return document.querySelector("#chatStatus").textContent + "|" + document.querySelector("#chatLog").innerText.slice(0, 120);
})()`);
console.log("聊天状态:", sent);

await evaluate(`document.querySelector("#playground").scrollIntoView({ block: "start" }); "ok"`);
await sleep(600);

const shot = await send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs/promises");
const decoded = Buffer.from(shot.result.data, "base64");
await fs.writeFile(OUT, decoded);
console.log("截图已保存:", OUT.pathname, decoded.length, "bytes");

socket.close();
