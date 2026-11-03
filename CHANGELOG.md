# Changelog

## 0.7.0

独立项目的首个正式版本：从 0.5.0 拆出版本回补 0.5.1–0.7.0 的核心演进，并把 agent 适配面扩展到主流 CLI。

### Added

- 上游代理认证：`upstreamUrl`、`gateways`、启动环境代理 URL 可带 `user:pass`，CONNECT/HTTP/TLS 探测/健康检查带 `Proxy-Authorization: Basic`；凭证不进日志、不转发给目标。
- `upstreamUrl` 配置/CLI/env 字段：非空时覆盖 `upstreamHost`/`upstreamPort`，非法值 fail fast 且错误信息脱敏。
- 幂等键重放：`retryNonIdempotentWithIdempotencyKey`，仅在请求带非空 `Idempotency-Key`/`X-Idempotency-Key` 时允许发送后重放非幂等请求。
- `responseTimeoutMs`：普通 HTTP 等响应头的上限，响应体开始流之后不再计时。
- 407 语义：上游代理拒绝认证时视为该网关失败并换路，不转发给客户端。
- 逐跳标头过滤（RFC 9110），请求方向重写 `Host`。
- 偏好缓存 LRU 上限（默认 1000 条）；关闭时最多等 `shutdownTimeoutMs` 再强制断开在途 socket。
- 健康检查重入锁，周期检查与失败踢动不会并发探测。
- CONNECT 200 同包早期数据转交客户端；IPv6 字面量不做无效的 `servername`。
- CLI 参数校验统一为一行错误、退出码 2；帮助文本补齐新选项。
- `agent-gateway` 内置短名扩展到 13 个：claude、codex、gemini、pi、aider、opencode、qwen、cursor（`cursor-agent`）、droid、amp、crush、goose、copilot；不在表里的用 `run -- <cmd>`。

### Changed

- `agent-gateway` 注入子进程环境时替换启动环境的 socks `ALL_PROXY`，`NO_PROXY` 与用户原有直连段合并而不是覆盖。
- `agent-gateway` 的启动环境 `HTTP(S)_PROXY`/`ALL_PROXY` 会作为候选网关，自身监听端口自动排除；`env` 子命令输出增加 `ALL_PROXY`/`all_proxy`。
- Node 要求提升到 `>=22.19.0`（与 undici 8 一致），启动时给出可读错误。

### Tests

- 回补上游认证、407、幂等键重放、两段超时、逐跳标头、IPv6、CONNECT 早期数据、偏好 LRU、健康重入锁、CLI 校验等用例；测试总数 109。
