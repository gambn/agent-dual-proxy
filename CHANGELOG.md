# Changelog

## 0.7.4

0.7.3 未发布的收尾版本：把 `EADDRINUSE` 诊断进一步区分为 LISTEN 冲突与 TIME-WAIT 冲突。

### Changed

- 监听失败时先探测端口：有进程在听 → 提示停掉该进程或换端口；没有监听者但有 TIME-WAIT → 提示 TIME-WAIT 及其约 60 秒的存活时间；探测不确定时两种都提示。
- 排查命令按平台给出：Windows 用 `Get-NetTCPConnection -LocalPort <port>`，其他平台仍用 `ss`。
- `agent-gateway` 的端口退避改为逐端口判断：本代理复用、其他程序报错，只有无人监听且绑定失败（TIME-WAIT）才继续往后找。
- 退避耗尽后的诊断提示 `Increase --port-fallback`，不再提示已经生效的 `enable`。

### Fixed

- 端口退避后按实际监听端口重建候选列表，避免把退避到的端口当成网关造成自环。
- `--print-config` 的 health URL 去掉 userinfo、查询串和 hash，和网关凭证一样不输出敏感值。

### Tests

- 新增退避后自环防护、TIME-WAIT/unknown 诊断分支、退避耗尽文案、`portHints` 平台分支、`--print-config` health URL 脱敏用例。
- `agent-gateway` 的端口选择抽成可注入的 `selectListener`，覆盖“其他程序报错 / TIME-WAIT 退避 / 本代理复用 / 全部失败”四条语义；总用例 125。

## 0.7.3

### Added

- `--port-fallback <n>`：监听遇到 `EADDRINUSE` 时按端口 +1 依次重试，返回并打印实际绑定端口。`dual-proxy` 默认 `0`，`agent-gateway` 默认 `10`（它会在注入环境前回读实际端口）。
- `dual-proxy --print-config`（别名 `--dry-run`）：输出生效配置、去重后的候选顺序与超时取值后退出，凭证只显示是否存在。
- README 增加排障段：TIME-WAIT 占端口、socks 候选告警属预期、运行日志走 stderr、Windows shim 与进程结束方式。

### Changed

- `EADDRINUSE` 报错改为可操作诊断：提示分别用 `ss -tln` 和 `ss -tan` 检查监听者与 TIME-WAIT，并给出 `--listen-port` / `--port-fallback` 的下一步。
- socks 上游候选的告警改为自解释文案（说明只支持 `http://`、`ALL_PROXY` 场景下属预期），并按脱敏值去重，大小写两份环境变量只报一次。

### Notes

- 已核实插件不会用固定源端口发探测/健康请求，不存在“自己制造 TIME-WAIT 堵自己”的自伤链。

## 0.7.2

### Changed

- 移除未使用的 `undici` 依赖（本项目只用 Node 内置 `http`/`net`/`tls`）；Node 门槛从 `>=22.19.0` 降到 `>=22.0.0`。
- `agent-gateway` 复用监听端口前先探测身份：只有本代理才复用；被其他程序占用时报错退出（退出码 1），不再把 agent 指向非代理端口。
- 代理新增本地身份端点 `GET /__agent_dual_proxy__`，返回 `x-agent-dual-proxy: 1`，供端口复用探测与运维检查使用。

### Tests

- 新增身份端点、端口复用身份探测用例；更新 Node 门槛用例。

## 0.7.1

### Changed

- `package.json` 补齐 `repository`、`homepage`、`bugs`、`author`，npm 页面会显示仓库与问题入口。无行为变更。

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
