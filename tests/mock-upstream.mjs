// 本地 mock 上游：模拟 Groq 的 OpenAI 兼容端点，用于在无外网环境下验证代理逻辑。
// 覆盖：鉴权失败、JSON 响应、SSE 流式响应、multipart 上传、慢响应（超时）。
import http from "node:http";

export async function createMockGroq() {
  const requests = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });

      const url = new URL(req.url, "http://127.0.0.1");
      const path = url.pathname;
      const authorized = req.headers.authorization === "Bearer test-key";

      if (path === "/openai/v1/models") {
        if (!authorized) {
          return json(res, 401, {
            error: { message: "Invalid API Key", type: "invalid_request_error" },
          });
        }
        return json(res, 200, {
          object: "list",
          data: [
            { id: "llama-3.3-70b-versatile", object: "model" },
            { id: "llama-3.1-8b-instant", object: "model" },
            { id: "whisper-large-v3", object: "model" },
          ],
        });
      }

      if (path === "/openai/v1/chat/completions") {
        if (!authorized) {
          return json(res, 401, { error: { message: "Invalid API Key" } });
        }
        let payload = {};
        try {
          payload = JSON.parse(body || "{}");
        } catch {
          return json(res, 400, { error: { message: "bad json" } });
        }

        if (payload.stream) {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "x-ratelimit-remaining-requests": "29",
          });
          res.write('data: {"id":"c1","choices":[{"delta":{"content":"hello"}}]}\n\n');
          res.write(
            'data: {"id":"c1","choices":[{"delta":{"content":" world"}}],"x_groq":{"usage":{"completion_tokens":2,"total_tokens":9}}}\n\n',
          );
          res.end("data: [DONE]\n\n");
          return;
        }

        return json(res, 200, {
          id: "c1",
          choices: [{ message: { role: "assistant", content: "ok" } }],
        });
      }

      if (path === "/openai/v1/audio/transcriptions") {
        return json(res, 200, { text: "transcribed" });
      }

      if (path === "/openai/v1/slow") {
        const timer = setTimeout(() => {
          if (!res.destroyed) json(res, 200, { slow: true });
        }, 1500);
        res.on("close", () => clearTimeout(timer));
        return;
      }

      return json(res, 404, { error: { message: "not found", path } });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close() {
      return new Promise((resolve) => {
        if (typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
        server.close(() => resolve());
      });
    },
  };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "x-ratelimit-remaining-tokens": "12000",
  });
  res.end(body);
}
