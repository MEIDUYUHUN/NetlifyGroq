# Groq Relay

> 部署在 [Netlify](https://www.netlify.com/) 上的 Groq API 反向代理。  
> 解决 Groq 按 IP 地区限制、中国大陆直连 `api.groq.com` 超时的问题。

## 原理

```
你的客户端（中国大陆 IP）
        │  请求 /v1/chat/completions
        ▼
Netlify Function（AWS 美国节点，默认 cmh）
        │  以美国出口 IP 请求 https://api.groq.com/openai/v1/chat/completions
        ▼
Groq API ──► 响应（JSON 或 SSE 流）原路返回
```

Netlify 免费计划即可运行。代理只做透明转发：**BYOK（Bring Your Own Key）**——访问者必须携带自己的 Groq API Key，站点不存储密钥、不消耗站点所有者的 Groq 额度。

## 项目结构

```
.
├─ netlify.toml              # 构建配置、/v1 与 /health 路由、安全响应头
├─ public/                   # 静态站点（零依赖，无需打包）
│  ├─ index.html             # 说明页 + 在线调试台
│  ├─ styles.css
│  └─ app.js
├─ netlify/functions/
│  ├─ v1.mjs                 # 通配代理：/v1/* → https://api.groq.com/openai/v1/*
│  └─ healthz.mjs            # /health 健康检查（不返回任何密钥）
└─ tests/
   ├─ mock-upstream.mjs      # 本地 mock Groq（离线测试用）
   ├─ proxy.test.mjs         # 15 个单元测试
   └─ serve.mjs              # 本地预览服务器
```

## 快速开始

### 本地预览（无需外网）

```bash
node tests/serve.mjs
# 浏览器打开 http://127.0.0.1:4173
# 演示用 Key：test-key（由本地 mock 上游接受）
```

### 单元测试

```bash
node --test tests/proxy.test.mjs
```

覆盖：路径映射、query 透传、SSE 流式、multipart 音频上传、上游 401 透传、CORS 预检、RELAY_PASSWORD 鉴权、ALLOWED_ORIGINS 白名单、502/504 错误、healthz。

### 部署到 Netlify

方式一：GitHub 导入

1. 把本目录推到你的 GitHub 仓库；
2. Netlify → **Add new site** → **Import an existing project**；
3. Build command 留空，Publish directory 填 `public`，Functions directory 填 `netlify/functions`（或直接使用仓库里的 `netlify.toml`）。

方式二：CLI 直接部署

```bash
npm i -g netlify-cli
netlify login
netlify deploy --prod
```

部署完成后，把站点的 `https://<站点>.netlify.app/v1` 作为 base URL 使用。

### 环境变量（均为可选）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GROQ_UPSTREAM_BASE` | `https://api.groq.com/openai/v1` | 上游地址；必须是 OpenAI 兼容前缀 |
| `RELAY_PASSWORD` | 空 | 设置后所有代理请求必须带 `x-relay-password` 请求头 |
| `ALLOWED_ORIGINS` | `*` | 允许跨域的来源，逗号分隔 |
| `UPSTREAM_TIMEOUT_MS` | `55000` | 等待上游响应头的超时（1000–58000） |

环境变量修改后需重新部署（Deploys → Trigger deploy）才能生效。

## 使用方式

OpenAI 兼容客户端只需替换 base URL：

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-site.netlify.app/v1",
    api_key="gsk_...",
)
```

```bash
curl "https://your-site.netlify.app/v1/chat/completions" \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3.3-70b-versatile","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

已启用 `RELAY_PASSWORD` 时，额外加请求头：

```bash
-H "x-relay-password: $RELAY_PASSWORD"
```

## 已知限制（Netlify 平台约束）

| 项目 | 限制 | 影响 |
| --- | --- | --- |
| 同步函数执行 | 60 秒 | 超长流式回答可能被截断 |
| 请求体 | 6 MB | 大音频文件需先压缩/分段 |
| 响应体 | 流式 20 MB / 缓冲 6 MB | 普通对话足够 |
| 并发/额度 | 按 Netlify 计划 | 免费层按调用次数计费 |
| 上游 | 仅 Groq | 不开放任意 URL 转发（防 SSRF） |

## 安全与隐私

- 代理不保存、不记录 API Key 与对话内容，仅内存内透传；
- 请求头白名单转发（`authorization`、`content-type`、`accept` 等），剔除 Netlify/浏览器内部头；
- 响应头剔除 `content-encoding`/`content-length`（undici 已解压）；
- 设置 `RELAY_PASSWORD` 可防止域名被扫描滥用；
- 公开部署时建议也留意 Netlify 的用量告警。

## FAQ

**为什么不用 Netlify redirect 代理？**  
redirect 代理会被 CDN 缓冲 SSE，聊天体验差，且无法处理 CORS、密码、错误格式。

**注册 Groq 也需要翻墙吗？**  
需要一次。代理只解决 API 调用阶段的网络可达性，注册/充值仍需自行解决一次网络问题。

**Netlify 站点在国内访问稳定吗？**  
没有中国大陆节点，通常可访问但延迟因运营商而异；可绑定自定义域名，或把同一份代码部署到 Cloudflare Pages。

## 免责声明

本项目仅供个人学习与合规使用。请遵守 [Groq 服务条款](https://console.groq.com/docs/legal) 与当地法律法规；不提供可用性 SLA。
