# agent-dual-proxy

[中文](README.md) · [English](README.en.md)

[![CI](https://github.com/gambn/agent-dual-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/gambn/agent-dual-proxy/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/agent-dual-proxy.svg)](https://www.npmjs.com/package/agent-dual-proxy)

**Agent 的网关管理器：在多个网关之间在线自动切换，让模型请求不再被一条不稳的路卡死。**

它把「agent 到模型端点的网络路径」当成可管理的资源：在配置的上游、额外指定的代理、启动环境里的代理和直连之间自动选一条能通的；运行中用真实请求持续验证，失败立刻切到下一条——不需要重启 agent，也不需要改客户端配置。

## 快速开始

```bash
# 独立 CLI
npm install -g agent-dual-proxy

# 给 Claude Code 等 CLI agent 套上
agent-gateway run claude --resume
```

要求 Node.js ≥ 22.0.0。内置短名覆盖 Claude Code、Codex CLI、Gemini CLI、Aider、OpenCode、Qwen Code、Cursor CLI、Droid、Amp、Crush、Goose、GitHub Copilot CLI 和 pi；完整对照见 [docs/agents.md](docs/agents.md)。不在表里的命令用 `agent-gateway run -- <cmd> [args...]`。

从源码安装（可选）：

```bash
git clone https://github.com/gambn/agent-dual-proxy.git
cd agent-dual-proxy
npm install
```

两种用法，同一份核心：

- **AGENT 启动器**（推荐）：`agent-gateway run <agent>`，起代理 + 注入代理变量 + exec，agent 退出时代理跟着关；
- **独立进程**：`dual-proxy` 跑一个常驻代理，或挂 systemd 用户服务。

## 它解决什么

上游代理并不稳定：同一个代理可能对 A 站通、对 B 站不通，也可能整段时间全挂；本机同时装着两个代理时，哪个能用还会变。只认一条路的客户端在这种时候会成片失败，而在死路上重试只是拖延。

这一层把候选路都握在手里，按 host 选：

```
客户端 → 127.0.0.1:7898
           ├── 网关 A（TLS 探测通过）→ 上游代理
           ├── 网关 B（TLS 探测通过）→ 上游代理
           └── 都探测失败 → 直连
```

健康检查用一个真实请求把同一组候选走一遍，谁先给出 <500 的响应，谁就成为全局首选。

## 行为

- 候选网关 = `upstreamHost:upstreamPort`（或 `upstreamUrl`）+ `gateways` + 启动环境的 `HTTP(S)_PROXY`/`ALL_PROXY`，去重并排除自身监听端口，最后补 `direct`。
- **上游代理认证**：`upstreamUrl`、`gateways` 或环境变量里的 HTTP 代理 URL 可带 `user:pass`；连接代理时会带 `Proxy-Authorization: Basic`。0.7.0 只支持 `http://` 上游代理：`upstreamUrl` 传 `https://` 会报错；额外候选（`gateways`、`--gateway`、`GATEWAY`、启动环境代理）里的 `https://` 或非法值会给脱敏 warning 后跳过。Basic 只是 base64，不是加密，只建议回环或受信任网络。
- **CONNECT（HTTPS）**：443 上先对候选做 TLS 握手探测，通过的才用来开隧道；失败换下一条。
- **普通 HTTP**：请求体先缓冲（上限 8 MB），按同一顺序换路重放；建连用 `attemptTimeoutMs`（已知路径用 `fastFailTimeoutMs`），等响应头用 `responseTimeoutMs`，响应体开始流之后不再计时。
- **幂等键重放**：打开 `retryNonIdempotentWithIdempotencyKey` 后，非幂等请求只有在带非空 `Idempotency-Key`/`X-Idempotency-Key` 时才允许发送后重放；代理不验证上游是否真的去重。
- **重放策略（仅普通 HTTP，CONNECT 隧道不重放）**：到网关/目标的 TCP 连接还没建立就失败时，任何方法都重放；连接建立后失败时，只重放幂等方法（`GET`/`HEAD`/`OPTIONS`/`TRACE`/`PUT`/`DELETE`）。`POST`/`PATCH` 等默认停止并回 502，响应体是 `non-idempotent request may have been delivered; not replayed`；需要旧行为时打开 `retryNonIdempotentAfterSend`。
- **已知路径的快失败只覆盖建连阶段**：缓存或健康首选的那条网关，TCP 连不上时 2 秒内换路；如果它连上了却迟迟不回响应头，仍要等满 `responseTimeoutMs`（默认 60 秒）。
- **健康检查**：每 `healthIntervalMs` 用 `GET healthUrl` 验证一次通道，`<500` 就算通（401/403 说明端点活着）；通过者设为全局首选，全部失败则清掉首选、下次请求重新扫描。设为 `0` 关闭。
- **每 host 偏好缓存**（默认 60 秒，最多 1000 条，LRU 淘汰）：缓存命中跳过探测；失败即切换。
- **失败网关冷却**（默认 30 秒）：某条路失败后进入冷却，期间排到最后，别的 host 不会再先撞它；健康检查证明它恢复时自动解除。
- **失败即复检**：任何一条路刚失败就踢一次健康检查（1 秒内只踢一次），不用等下一个 60 秒周期。
- **逐跳标头**按 RFC 9110 过滤（`Connection` 及其点名的字段、`Proxy-Connection`、`Transfer-Encoding` 等），`Host` 重写为目标主机；响应方向的逐跳标头同样清掉。
- **IPv6**：CONNECT 支持 `[::1]:443` 这类字面量，host 统一去掉方括号、转小写、去掉 FQDN 末尾的点。
- **关闭**最多等 `shutdownTimeoutMs`（默认 1.5 秒，内部选项）让在途请求自然结束，超时后强制断开所有 socket。
- 全部候选都失败时回 502；非幂等请求在连接建立后失败且未开 `retryNonIdempotentAfterSend`、也没有可用的幂等键开关时，也会立即回 502，不再尝试剩余候选。
- 日志只写主机、网关与原因，不记录任何请求内容。

## 作为独立进程

```bash
dual-proxy --listen-port 7898 --upstream-port 7897 \
  --gateway 127.0.0.1:12334 --health-url https://api.deepseek.com

node bin/dual-proxy.js --listen-port 7898      # 没装到 PATH 时直接跑
```

| 参数 | 默认 | 说明 |
| :--- | :--- | :--- |
| `--listen-host` | `127.0.0.1` | 监听地址 |
| `--listen-port` | `7898` | 监听端口 |
| `--port-fallback` | `0` | EADDRINUSE 时按端口 +1 依次重试的个数；`0` 关闭 |
| `--print-config` | — | 打印最终生效配置后退出（别名 `--dry-run`） |
| `--upstream-host` | `127.0.0.1` | 第一个候选网关 |
| `--upstream-port` | `7897` | 第一个候选网关的端口 |
| `--upstream-url` | — | 第一个候选的完整 URL，可含 `user:pass`；非空时覆盖 host/port |
| `--gateway` | — | 额外候选网关，可重复 |
| `--health-url` | 空 | 通道验证地址 |
| `--health-interval-ms` | `60000` | 健康检查间隔，`0` 关闭 |
| `--fast-fail-ms` | `2000` | 已知路径的建连超时 |
| `--cooldown-ms` | `30000` | 失败网关的冷却时长 |
| `--timeout-ms` | `5000` | 每次尝试/探测超时 |
| `--response-timeout-ms` | `60000` | 普通 HTTP 等响应头的上限 |
| `--pref-ttl-ms` | `60000` | 每 host 偏好缓存 TTL |
| `--no-verify-tls` | 关 | 跳过 443 的 TLS 探测 |
| `--retry-non-idempotent-after-send` | 关 | 连接建立后失败时也重放 `POST`/`PATCH` |
| `--retry-non-idempotent-with-idempotency-key` | 关 | 带 `Idempotency-Key` 时允许发送后重放 |

环境变量同名（`LISTEN_HOST`、`LISTEN_PORT`、`PORT_FALLBACK`、`UPSTREAM_HOST`、`UPSTREAM_PORT`、`UPSTREAM_URL`、`GATEWAY`、`HEALTH_URL`、`HEALTH_INTERVAL_MS`、`FAST_FAIL_MS`、`COOLDOWN_MS`、`ATTEMPT_TIMEOUT_MS`、`RESPONSE_TIMEOUT_MS`、`PREF_TTL_MS`、`VERIFY_TLS=0`、`RETRY_NON_IDEMPOTENT_AFTER_SEND=1`、`RETRY_NON_IDEMPOTENT_WITH_IDEMPOTENCY_KEY=1`）。

systemd 用户服务模板在 `contrib/`。

## 给主流 CLI agent 用

Claude Code / Codex CLI / Gemini CLI 等 agent 没有共用的插件 API，唯一通杀的是 `HTTP(S)_PROXY`。启动器做三件事：起双路代理、把代理变量塞进子进程、exec。

```bash
agent-gateway run claude --resume   # 起代理 → 注入变量 → exec
agent-gateway run -- <任意命令>      # 不限内置表
agent-gateway env                   # 打印可 source 的 export 语句
```

注入时会替换启动环境里的 socks `ALL_PROXY`：不少客户端会优先读它，留着就绕过了 `HTTP(S)_PROXY`，双路选路白做。`NO_PROXY` 与用户原有的直连段合并而不是覆盖；回环地址默认直连，agent 自己的本地端口（hook、LSP、语言服务器）不会被代理吞掉。端口上已经有本代理时复用现有监听；被其他程序占用则报错退出，不会把 agent 指向一个非代理端口。端口没有监听者却被 TIME-WAIT 卡住时，启动器默认往后找 10 个端口（`--port-fallback`），并在注入环境前使用实际绑定的端口。子进程退出后代理跟着关，不留孤儿进程。各家细节见 [docs/agents.md](docs/agents.md)。

## 测试

```bash
npm test
```

测试面向仓库或源码快照；首次先在源码目录 `npm install`，再 `npm test`。npm 包不含 `test/`，安装后不能直接跑这套用例。

用例覆盖：HTTP 直连回退、经假代理转发、多个网关时跳过不通的、两条都不通返回 502、黑洞网关按超时换路、请求与响应两个方向的逐跳标头过滤、上游中途断开不带崩进程、CONNECT 直连隧道与经假代理隧道、CONNECT 200 同包早期数据、IPv6 字面量、缓存网关卡住时快失败换路、失败网关冷却后不再先撞、关闭时强制断开在途隧道、网关解析与去重（含自身端口排除与自环防护）、健康检查的选择与失败、健康循环记住首选、失败踢一次健康检查、健康检查重入锁、偏好缓存上限、CLI 参数校验与退出码、自签证书的 TLS 探测、非幂等重放策略（send 前后边界、方法分类、开关、日志与冷却）、上游代理认证（CONNECT/HTTP/健康检查、407）、带幂等键的发送后重放（开关/键存在性/日志），以及 AGENT 启动器的环境注入、退出码透传、端口复用的身份探测、端口退避与 EADDRINUSE 诊断、socks 告警去重、`--print-config`。

## 排障

- **端口没有监听者，listen 仍报 EADDRINUSE**：先看 `ss -tan | grep :7898`。同一端口上由别的进程建立过的短连接会留下 TIME-WAIT；如果它建立时没带 `SO_REUSEADDR`，后来者即使带 Node 的 `reuseAddress` 也绑不上（这是内核的双向门槛，不是插件 bug）。换端口，或用 `--port-fallback` 自动退避；日志会打印实际监听端口。
- **启动日志出现 `socks ... skipped`**：上游只支持 `http://` 代理，`ALL_PROXY=socks://...` 会被跳过，这是预期行为。
- **运行日志写 stderr**：`dual-proxy`/`agent-gateway` 的状态日志都走 stderr；`agent-gateway env` 的导出语句走 stdout，方便 `eval`。
- **Windows**：npm 全局命令是 `.cmd`/`.ps1` shim，结束进程要杀真正持有端口的 `node.exe`（`Get-NetTCPConnection -LocalPort 7898`）；`Start-Process` 要分别重定向 stdout 与 stderr。

## 边界

- 只处理 HTTP/1.1 的 `CONNECT` 与普通 HTTP；不做透明代理、不接管 UDP。
- 普通 HTTP 请求在网关连上后要等满 `responseTimeoutMs`（默认 60 秒）才判定响应头超时；0.7.0 不缩短这个等待，幂等键只改变超时后的重放决策。
- CONNECT 隧道建立后代理只转发字节，TLS 端到端；隧道内失败无法换路，要覆盖只能做 MITM 解密，和本项目“不拦截”的定位冲突。
- 不校验证书，不缓存内容，不做鉴权。默认只绑回环；把 `listenHost` 改成非回环地址会在启动时告警——那等于开放一个无鉴权代理，风险自负。
- 上游代理认证只支持 `http://` 的 Basic；不支持 `https://` 上游代理（TLS-to-proxy）。Basic 只适合回环或受信任网络，远程代理的凭证保护不在本项目范围内。
- 只负责「到不到得了」，不负责「信不信得过」——证书校验仍是客户端的责任。
- 健康检查只发一个无凭证 `GET`，判据是「有没有 <500 的响应」，不代表凭证或模型权限有效。
- **不保证「至多一次」**：默认 `retryNonIdempotentAfterSend: false` 时，`POST`/`PATCH` 在连接建立后失败会直接 502（可能已送达、未重放），幂等方法仍会重放；打开该开关会恢复发送后重放，代价是可能重复执行。客户端 SDK 对 5xx 的自动重试不受代理控制，对计费或写入敏感的调用仍应在上游使用幂等键。

## 反馈

问题、建议与使用疑问走 GitHub Issues：<https://github.com/gambn/agent-dual-proxy/issues>。请勿在 Issue 里粘贴 token、密钥或完整请求内容；安全问题见 [SECURITY.md](SECURITY.md)。

## License

MIT
