// 开发辅助：用 CDP 的移动端模拟（390×844）截取页面，验证响应式布局真实表现。
// 用法：chrome --headless=new --remote-debugging-port=9224 --window-size=1440,2200 http://127.0.0.1:4173/
//      node tests/mobile-shot.mjs
import fs from "node:fs/promises";

const CDP_HTTP = "http://127.0.0.1:9224";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pages = await (await fetch(CDP_HTTP + "/json/list")).json();
const target = pages.find((p) => p.type === "page" && p.url.includes("127.0.0.1:4173"));
if (!target) {
  console.error("未找到目标页面");
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
  return result.result && result.result.result ? result.result.result.value : undefined;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
});
await sleep(1200);

const metrics = await evaluate(
  `JSON.stringify((() => {
    const table = document.querySelector(".env-table");
    const wrap = table && table.parentElement;
    const h1 = document.querySelector("h1");
    const hero = document.querySelector(".hero");
    return {
      innerWidth: window.innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      tableMinWidth: table ? getComputedStyle(table).minWidth : null,
      tableWidth: table ? Math.round(table.getBoundingClientRect().width) : null,
      wrapWidth: wrap ? Math.round(wrap.getBoundingClientRect().width) : null,
      wrapOverflowX: wrap ? getComputedStyle(wrap).overflowX : null,
      h1Width: h1 ? Math.round(h1.getBoundingClientRect().width) : null,
      heroWidth: hero ? Math.round(hero.getBoundingClientRect().width) : null,
    };
  })())`,
);
console.log("移动端布局指标:", metrics);

const parsed = JSON.parse(metrics);
const height = Math.min(parsed.scrollHeight, 12000);
await send("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height,
  deviceScaleFactor: 1,
  mobile: true,
});
await sleep(800);

const shot = await send("Page.captureScreenshot", { format: "png" });
const out = new URL("./ui-mobile.png", import.meta.url);
await fs.writeFile(out, Buffer.from(shot.result.data, "base64"));
console.log("移动端截图已保存:", out.pathname);
socket.close();
