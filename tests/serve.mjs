// 本地预览服务器（仅用于开发验证，不参与 Netlify 部署）
//   node tests/serve.mjs
// 浏览器打开 http://127.0.0.1:4173
// 特点：静态页面 + 真实调用 v1.mjs/healthz.mjs + 内置 mock 上游（无需外网）。
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMockGroq } from "./mock-upstream.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const mock = await createMockGroq();
process.env.GROQ_UPSTREAM_BASE = mock.url + "/openai/v1";
process.env.RELAY_PASSWORD = "";
process.env.UPSTREAM_TIMEOUT_MS = "5000";

const { default: relay } = await import(
  pathToFileURL(path.join(root, "netlify", "functions", "v1.mjs")).href
);
const { default: healthz } = await import(
  pathToFileURL(path.join(root, "netlify", "functions", "healthz.mjs")).href
);

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function sendWebResponse(res, response) {
  const headers = {};
  for (const [key, value] of response.headers) headers[key] = value;
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  try {
    for await (const chunk of response.body) res.write(chunk);
  } catch (err) {
    console.error("[serve] stream error:", err?.message || err);
  } finally {
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  try {
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      const response = await healthz(
        new Request(`http://localhost${url.pathname}`, { method: req.method }),
      );
      return await sendWebResponse(res, response);
    }

    if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const hasBody = !["GET", "HEAD"].includes(req.method || "GET");
      const body = hasBody ? await readBody(req) : undefined;
      const response = await relay(
        new Request(`http://localhost${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body,
          duplex: "half",
        }),
        {},
      );
      return await sendWebResponse(res, response);
    }

    // 静态文件
    const decoded = decodeURIComponent(url.pathname);
    const target = path.resolve(
      publicDir,
      "." + (decoded === "/" ? "/index.html" : decoded),
    );
    if (target !== publicDir && !target.startsWith(publicDir + path.sep)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    try {
      const data = await readFile(target);
      res.writeHead(200, {
        "content-type": MIME[path.extname(target)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    }
  } catch (err) {
    console.error("[serve] handler error:", err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Groq Relay 本地预览: http://127.0.0.1:${PORT}`);
  console.log(`Mock 上游: ${mock.url}/openai/v1`);
  console.log("测试用 Key: test-key（演示用，仅本地 mock 接受）");
});
