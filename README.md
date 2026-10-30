# agent-dual-proxy

一个本地 HTTP/HTTPS 代理：在若干候选网关（配置的上游、额外指定的代理、启动环境里的 HTTP(S)_PROXY、直连）之间自动选一条能到达目标的路；443 上先做 TLS 可达性探测，再用一个真实请求定期验证「到模型端点」的通道，把验证通过的网关设为首选。每个 host 记住最近走通的路，命中缓存就跳过诊断。

两种用法，同一份核心：

- **独立进程**：`dual-proxy` 跑一个常驻代理，或挂 systemd 用户服务；
- **AGENT 启动器**：`agent-gateway run <agent>`，起代理 + 注入 `HTTP(S)_PROXY` + exec，见 [docs/agents.md](docs/agents.md)。

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

- 候选网关 = `upstreamHost:upstreamPort` + `gateways` + 启动环境的 `HTTP(S)_PROXY`/`ALL_PROXY`，去重并排除自身监听端口，最后补 `direct`。
- **CONNECT（HTTPS）**：443 上先对候选做 TLS 握手探测，通过的才用来开隧道；失败换下一条。
- **普通 HTTP**：请求体先缓冲（上限 8 MB），按同一顺序换路重放。
- **健康检查**：每 `healthIntervalMs` 用 `GET healthUrl` 验证一次通道，`<500` 就算通（401/403 说明端点活着）；通过者设为全局首选，全部失败则清掉首选、下次请求重新扫描。设为 `0` 关闭。
- **每 host 偏好缓存**（默认 60 秒）：缓存命中跳过探测；失败即切换。
- **已知路径快失败**：缓存或健康首选的那一条只用 `fastFailTimeoutMs`（默认 2 秒）建连，挂了立刻换下一条，其余候选仍用完整超时。
- **失败网关冷却**（默认 30 秒）：某条路失败后进入冷却，期间排到最后，别的 host 不会再先撞它；健康检查证明它恢复时自动解除。
- **失败即复检**：任何一条路刚失败就踢一次健康检查（1 秒内只踢一次），不用等下一个 60 秒周期。
- 全部不通才向客户端返回 502。
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
| `--upstream-host` | `127.0.0.1` | 第一个候选网关 |
| `--upstream-port` | `7897` | 第一个候选网关的端口 |
| `--gateway` | — | 额外候选网关，可重复 |
| `--health-url` | 空 | 通道验证地址 |
| `--health-interval-ms` | `60000` | 健康检查间隔，`0` 关闭 |
| `--fast-fail-ms` | `2000` | 已知路径的建连超时 |
| `--cooldown-ms` | `30000` | 失败网关的冷却时长 |
| `--timeout-ms` | `5000` | 每次尝试/探测超时 |
| `--pref-ttl-ms` | `60000` | 每 host 偏好缓存 TTL |
| `--no-verify-tls` | 关 | 跳过 443 的 TLS 探测 |

环境变量同名（`LISTEN_HOST`、`LISTEN_PORT`、`UPSTREAM_HOST`、`UPSTREAM_PORT`、`GATEWAY`、`HEALTH_URL`、`HEALTH_INTERVAL_MS`、`FAST_FAIL_MS`、`COOLDOWN_MS`、`ATTEMPT_TIMEOUT_MS`、`PREF_TTL_MS`、`VERIFY_TLS=0`）。

systemd 用户服务模板在 `contrib/`。

## 给主流 CLI agent 用

Claude Code / Codex CLI / Gemini CLI / pi 没有共用的插件 API，只有 `HTTP(S)_PROXY` 通杀：

```bash
agent-gateway run claude --resume   # 起代理 → 注入变量 → exec
agent-gateway env                   # 打印 export 语句
agent-gateway run -- <任意命令>      # 不限上表
```

端口被占用就复用现有监听；子进程退出时代理跟着关。各家细节见 [docs/agents.md](docs/agents.md)。

## 测试

```bash
npm test
```

用例覆盖：HTTP 直连回退、经假代理转发、多个网关时跳过不通的、两条都不通返回 502、CONNECT 直连隧道与经假代理隧道、缓存网关卡住时快失败换路、失败网关冷却后不再先撞、网关解析与去重（含自身端口排除）、健康检查的选择与失败、健康循环记住首选、失败踢一次健康检查，以及 AGENT 启动器的环境注入、退出码透传与端口复用。

## 边界

- 只处理 HTTP/1.1 的 `CONNECT` 与普通 HTTP；不做透明代理、不接管 UDP。
- 不校验证书，不缓存内容，不做鉴权；只绑回环，默认信任本机。
- 只负责「到不到得了」，不负责「信不信得过」——证书校验仍是客户端的责任。
- 健康检查只发一个无凭证 `GET`，判据是「有没有 <500 的响应」，不代表凭证或模型权限有效。

## License

MIT
