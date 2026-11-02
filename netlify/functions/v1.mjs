// Groq Relay — Netlify Function (v2 / Fetch API)
// 作用：把 https://<站点>/v1/* 透明转发到 https://api.groq.com/openai/v1/*
//
// BYOK（Bring Your Own Key）模式：客户端必须自带自己的 Groq API Key
// （Authorization: Bearer gsk_...），本代理不持有、不记录、不外泄任何密钥。
//
// 可选环境变量：
//   GROQ_UPSTREAM_BASE   上游地址，默认 https://api.groq.com/openai/v1
//   RELAY_PASSWORD       访问密码；设置后请求需带 x-relay-password 头
//   ALLOWED_ORIGINS      允许跨域的来源，逗号分隔；默认 *
//   UPSTREAM_TIMEOUT_MS  等待上游响应头的超时，默认 55000（Netlify 同步上限 60s）
import { createHash, timingSafeEqual } from "node:crypto";

const DEFAULT_UPSTREAM = "https://api.groq.com/openai/v1";
const VERSION = "1.0.0";

// 只把这些客户端请求头转发给 Groq，避免泄漏浏览器指纹 / Netlify 内部头
const REQ_ALLOW = new Set([
  "authorization",
  "content-type",
  "accept",
  "user-agent",
  "range",
  "openai-beta",
]);

// 响应里必须剥掉的头：undici 已自动解压 body，透传会导致浏览器二次解码失败
const RES_STRIP = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "vary",
  "cache-control",
]);

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

// 支持多种前缀，兼容 in-source 路由（/v1/*）与默认函数 URL（/.netlify/functions/v1/*）
const PREFIXES = ["/v1", "/openai/v1", "/.netlify/functions/v1"];

export default async function relay(req) {
  const origin = req.headers.get("origin") || "";
  const cfg = readConfig();
  const cors = resolveCors(origin, cfg.allowedOrigins);

  const respond = (res) => applyCors(res, cors);
  const fail = (status, message, code) => respond(jsonError(status, message, code));

  // CORS 预检：直接放行，不校验密码（浏览器预检不会携带密码值）
  if (req.method === "OPTIONS") {
    return respond(new Response(null, { status: 204, headers: preflightHeaders(cors) }));
  }

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return fail(400, "无法解析请求地址", "bad_request");
  }

  const rest = matchApiPath(url.pathname);
  if (rest === null) {
    return fail(404, "仅支持 /v1/* 代理路径", "not_found");
  }

  // 可选访问密码（BYOK 之外的轻量防护，防止域名被扫描滥用）
  if (cfg.password) {
    const supplied = req.headers.get("x-relay-password") || "";
    if (!sameSecret(supplied, cfg.password)) {
      return fail(401, "访问密码错误或缺失（请求头 x-relay-password）", "invalid_relay_password");
    }
  }

  let target;
  try {
    target = new URL(cfg.upstream + rest);
    target.search = url.search;
  } catch {
    return fail(500, "上游地址配置无效，请检查 GROQ_UPSTREAM_BASE", "bad_upstream_config");
  }

  const method = (req.method || "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  let body;
  if (hasBody) {
    try {
      body = await req.arrayBuffer();
    } catch {
      return fail(400, "读取请求体失败", "bad_request_body");
    }
  }

  const headers = new Headers();
  for (const [key, value] of req.headers) {
    const k = key.toLowerCase();
    if (k === "x-relay-password") continue;
    if (!REQ_ALLOW.has(k)) continue;
    if (k === "authorization" && !value.trim()) continue;
    headers.set(k, value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  let upstream;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? body : undefined,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      return fail(504, `等待上游响应超时（${cfg.timeoutMs}ms）`, "upstream_timeout");
    }
    return fail(502, `无法连接上游 ${cfg.upstream}：${err?.message || err}`, "upstream_unreachable");
  } finally {
    clearTimeout(timer);
  }

  const out = new Headers();
  for (const [key, value] of upstream.headers) {
    if (RES_STRIP.has(key.toLowerCase())) continue;
    out.set(key, value);
  }
  out.set("cache-control", "no-store");
  out.set("x-relay-version", VERSION);
  out.set("access-control-expose-headers", "*");

  const noBody = method === "HEAD" || NULL_BODY_STATUS.has(upstream.status);
  return respond(
    new Response(noBody ? null : upstream.body, {
      status: upstream.status,
      headers: out,
    }),
  );
}

// 将请求路径映射为“上游相对路径”。例如 /v1/chat/completions -> /chat/completions
function matchApiPath(pathname) {
  for (const prefix of PREFIXES) {
    if (pathname === prefix) return "/";
    if (pathname.startsWith(prefix + "/")) return pathname.slice(prefix.length);
  }
  return null;
}

function readConfig() {
  const raw = (process.env.GROQ_UPSTREAM_BASE || "").trim();
  let upstream = DEFAULT_UPSTREAM;
  if (raw) {
    try {
      const u = new URL(raw);
      if (!u.pathname || u.pathname === "/") u.pathname = "/openai/v1";
      upstream = u.toString().replace(/\/+$/, "");
    } catch {
      // 配置无效时保持默认上游，避免整个函数不可用
    }
  }

  const timeout = Number(process.env.UPSTREAM_TIMEOUT_MS);
  return {
    upstream,
    password: (process.env.RELAY_PASSWORD || "").trim(),
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    timeoutMs:
      Number.isFinite(timeout) && timeout > 0
        ? Math.min(Math.max(timeout, 1000), 58000)
        : 55000,
  };
}

function resolveCors(origin, allowed) {
  if (!allowed.length || allowed.includes("*")) return "*";
  if (!origin) return null;
  return allowed.includes(origin) ? origin : null;
}

function applyCors(res, cors) {
  if (!cors) return res;
  res.headers.set("access-control-allow-origin", cors);
  res.headers.set("access-control-expose-headers", "*");
  if (cors !== "*") res.headers.set("vary", "origin");
  return res;
}

function preflightHeaders(cors) {
  const headers = {
    "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, accept, x-relay-password, openai-beta",
    "access-control-max-age": "86400",
    "cache-control": "no-store",
  };
  if (cors) {
    headers["access-control-allow-origin"] = cors;
    if (cors !== "*") headers["vary"] = "origin";
  }
  return headers;
}

function jsonError(status, message, code) {
  return new Response(
    JSON.stringify({ error: { message, type: "relay_error", code } }),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-relay-version": VERSION,
      },
    },
  );
}

// 常数时间比较，避免密码被计时攻击
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const config = {
  path: ["/v1/*", "/v1"],
};
