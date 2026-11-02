// Groq Relay — 健康检查函数
// 返回代理的基本配置状态（不含任何密钥），页面启动时用它对代理做体检。
const DEFAULT_UPSTREAM = "https://api.groq.com/openai/v1";
const VERSION = "1.0.0";

export default async function healthz() {
  const { upstream, password } = readConfig();
  return new Response(
    JSON.stringify({
      ok: true,
      service: "groq-relay",
      version: VERSION,
      upstream,
      password_required: Boolean(password),
      time: new Date().toISOString(),
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    },
  );
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
      // 保持默认
    }
  }
  return {
    upstream,
    password: (process.env.RELAY_PASSWORD || "").trim(),
  };
}

export const config = {
  path: ["/health", "/healthz"],
};
