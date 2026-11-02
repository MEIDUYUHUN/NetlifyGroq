// 代理函数单元测试：node --test tests/proxy.test.mjs
// 不依赖外网，全部通过本地 mock 上游验证。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMockGroq } from "./mock-upstream.mjs";

let mock;
let relay;
let healthz;
const ENV = {};

before(async () => {
  for (const key of [
    "GROQ_UPSTREAM_BASE",
    "RELAY_PASSWORD",
    "ALLOWED_ORIGINS",
    "UPSTREAM_TIMEOUT_MS",
  ]) {
    ENV[key] = process.env[key];
  }

  mock = await createMockGroq();
  process.env.GROQ_UPSTREAM_BASE = mock.url + "/openai/v1";
  process.env.RELAY_PASSWORD = "";
  process.env.ALLOWED_ORIGINS = "";
  process.env.UPSTREAM_TIMEOUT_MS = "5000";

  relay = (await import("../netlify/functions/v1.mjs")).default;
  healthz = (await import("../netlify/functions/healthz.mjs")).default;
});

after(async () => {
  for (const [key, value] of Object.entries(ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await mock.close();
});

function request(path, init = {}) {
  return relay(new Request("https://relay.test" + path, init));
}

function authHeaders(extra = {}) {
  return { authorization: "Bearer test-key", ...extra };
}

test("路径映射：/v1/models 映射到上游 /openai/v1/models 并透传 JSON", async () => {
  const res = await request("/v1/models", { headers: authHeaders() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-relay-version"), "1.0.0");

  const data = await res.json();
  assert.equal(data.data.length, 3);

  const upstream = mock.requests.at(-1);
  assert.equal(upstream.method, "GET");
  assert.equal(upstream.url, "/openai/v1/models");
  assert.equal(upstream.headers.authorization, "Bearer test-key");
});

test("query string 原样透传", async () => {
  await request("/v1/models?foo=bar&x=1", { headers: authHeaders() });
  assert.equal(mock.requests.at(-1).url, "/openai/v1/models?foo=bar&x=1");
});

test("POST 流式：SSE body 逐块透传，保留事件与 [DONE]", async () => {
  const res = await request("/v1/chat/completions", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("x-ratelimit-remaining-requests"), "29");

  const text = await res.text();
  assert.match(text, /hello/);
  assert.match(text, /world/);
  assert.match(text, /\[DONE\]/);

  const upstream = mock.requests.at(-1);
  assert.equal(upstream.method, "POST");
  assert.equal(JSON.parse(upstream.body).stream, true);
});

test("非流式 POST：请求体完整转发到上游", async () => {
  const payload = {
    model: "llama-3.1-8b-instant",
    messages: [{ role: "user", content: "ping" }],
  };
  const res = await request("/v1/chat/completions", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.choices[0].message.content, "ok");
  assert.deepEqual(JSON.parse(mock.requests.at(-1).body), payload);
});

test("上游 401 原样透传（客户端 SDK 能正确识别错误）", async () => {
  const res = await request("/v1/models", {
    headers: { authorization: "Bearer wrong-key" },
  });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error.message, "Invalid API Key");
});

test("multipart/form-data 音频上传透传（boundary 保持一致）", async () => {
  const form = new FormData();
  form.append("file", new Blob(["fake-audio"], { type: "audio/mpeg" }), "a.mp3");
  form.append("model", "whisper-large-v3");

  const res = await request("/v1/audio/transcriptions", {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.text, "transcribed");

  const upstream = mock.requests.at(-1);
  assert.match(upstream.headers["content-type"], /multipart\/form-data; boundary=/);
  assert.match(upstream.body, /fake-audio/);
  assert.match(upstream.body, /whisper-large-v3/);
});

test("OPTIONS 预检：204 + CORS 头", async () => {
  const res = await request("/v1/chat/completions", {
    method: "OPTIONS",
    headers: {
      origin: "https://example.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-methods"), /POST/);
  assert.match(res.headers.get("access-control-allow-headers"), /x-relay-password/);
});

test("RELAY_PASSWORD：缺失/错误返回 401，正确则放行且不转发密码头", async () => {
  process.env.RELAY_PASSWORD = "s3cret";

  let res = await request("/v1/models", { headers: authHeaders() });
  assert.equal(res.status, 401);
  let data = await res.json();
  assert.equal(data.error.code, "invalid_relay_password");

  res = await request("/v1/models", {
    headers: authHeaders({ "x-relay-password": "wrong" }),
  });
  assert.equal(res.status, 401);

  res = await request("/v1/models", {
    headers: authHeaders({ "x-relay-password": "s3cret" }),
  });
  assert.equal(res.status, 200);
  assert.equal(mock.requests.at(-1).headers["x-relay-password"], undefined);

  process.env.RELAY_PASSWORD = "";
});

test("ALLOWED_ORIGINS：白名单内回显 Origin，白名单外不返回 CORS 头", async () => {
  process.env.ALLOWED_ORIGINS = "https://a.example,https://b.example";

  let res = await request("/v1/models", {
    headers: authHeaders({ origin: "https://a.example" }),
  });
  assert.equal(res.headers.get("access-control-allow-origin"), "https://a.example");
  assert.equal(res.headers.get("vary"), "origin");

  res = await request("/v1/models", {
    headers: authHeaders({ origin: "https://evil.example" }),
  });
  assert.equal(res.headers.get("access-control-allow-origin"), null);

  process.env.ALLOWED_ORIGINS = "";
});

test("兼容默认函数 URL：/.netlify/functions/v1/models", async () => {
  const res = await request("/.netlify/functions/v1/models", {
    headers: authHeaders(),
  });
  assert.equal(res.status, 200);
  assert.equal(mock.requests.at(-1).url, "/openai/v1/models");
});

test("兼容 /openai/v1 前缀", async () => {
  const res = await request("/openai/v1/models", { headers: authHeaders() });
  assert.equal(res.status, 200);
  assert.equal(mock.requests.at(-1).url, "/openai/v1/models");
});

test("未匹配路径返回 404 JSON", async () => {
  const res = await request("/api/foo");
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.error.code, "not_found");
});

test("上游不可达返回 502 OpenAI 风格错误", async () => {
  process.env.GROQ_UPSTREAM_BASE = "http://127.0.0.1:1/openai/v1";
  const res = await request("/v1/models", { headers: authHeaders() });
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.equal(data.error.code, "upstream_unreachable");
  process.env.GROQ_UPSTREAM_BASE = mock.url + "/openai/v1";
});

test("上游超时返回 504", async () => {
  process.env.UPSTREAM_TIMEOUT_MS = "1000";
  const res = await request("/v1/slow", { headers: authHeaders() });
  assert.equal(res.status, 504);
  const data = await res.json();
  assert.equal(data.error.code, "upstream_timeout");
  process.env.UPSTREAM_TIMEOUT_MS = "5000";
});

test("healthz 返回配置状态且不含密钥", async () => {
  const res = await healthz(new Request("https://relay.test/health"), {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.service, "groq-relay");
  assert.equal(data.upstream, mock.url + "/openai/v1");
  assert.equal(data.password_required, false);
  assert.equal(JSON.stringify(data).includes("s3cret"), false);
});
