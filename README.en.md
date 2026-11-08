# agent-dual-proxy

[English](README.en.md) · [中文](README.md)

[![CI](https://github.com/gambn/agent-dual-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/gambn/agent-dual-proxy/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/agent-dual-proxy.svg)](https://www.npmjs.com/package/agent-dual-proxy)

**A gateway manager for agents: switch between multiple gateways online, so model requests are never stuck on one flaky path.**

It treats the network path from an agent to the model endpoint as a managed resource: it picks whichever configured upstream, extra proxy, launch-environment proxy, or direct connection can reach the target, keeps verifying that channel with real requests, and switches on failure — without restarting the agent or touching client configuration.

## Quick start

```bash
# Standalone CLI
npm install -g agent-dual-proxy

# Wrap a CLI agent such as Claude Code
agent-gateway run claude --resume
```

Requires Node.js ≥ 22.0.0. Built-in short names cover Claude Code, Codex CLI, Gemini CLI, Aider, OpenCode, Qwen Code, Cursor CLI, Droid, Amp, Crush, Goose, GitHub Copilot CLI, and pi; see [docs/agents.md](docs/agents.md) for the full table. For anything not listed, use `agent-gateway run -- <cmd> [args...]`.

Install from source (optional):

```bash
git clone https://github.com/gambn/agent-dual-proxy.git
cd agent-dual-proxy
npm install
```

Two shapes, one core:

- **Agent launcher** (recommended): `agent-gateway run <agent>` starts the proxy, injects the proxy environment, and execs the agent; the proxy stops when the agent exits.
- **Standalone process**: run `dual-proxy` as a long-lived proxy, or install it as a systemd user service.

## What it solves

Upstream proxies are not reliable: the same proxy may reach site A but not site B, or be down for a while entirely. When two proxies are installed on one machine, which one works can change from hour to hour. A client that only knows one path fails in bursts, and retrying on a dead path only adds delay.

This layer keeps all candidate paths in hand and chooses per host:

```
client → 127.0.0.1:7898
           ├── gateway A (TLS probe passes) → upstream proxy
           ├── gateway B (TLS probe passes) → upstream proxy
           └── all probes fail → direct
```

The health check runs the same candidate list with a real request; the first one that returns a response below 500 becomes the global favourite.

## Behaviour

- Candidate gateways = `upstreamHost:upstreamPort` (or `upstreamUrl`) + `gateways` + `HTTP(S)_PROXY`/`ALL_PROXY` from the launch environment, deduplicated, excluding the proxy's own listen port, with `direct` appended last.
- **Destination policy (0.8.0, manual lists)**: `--prefer-direct` / `--prefer-proxy` (or `PREFER_DIRECT`/`PREFER_PROXY`) choose direct-first or proxy-first per target host, comma-separated, with `*` glob support; only normalized hosts are matched (lowercase, brackets/trailing dot removed, IDN as punycode), and regex/CIDR/port/URL-path inputs are not accepted. Priority: policy > per-host cache > global health favourite > default order; direct wins when both lists match; rules only reorder the hot set and never pull a cooling gateway back; unmatched hosts keep the old candidate order (cooldown semantics are covered by the two-tier cooldown below). `*.cn` does not match `cn` itself or `deepseek.cn`; list the apex explicitly. Example: `--prefer-direct api.deepseek.com,deepseek.cn,*.deepseek.cn --prefer-proxy api.openai.com,api.anthropic.com`. **This is an operator policy, not automatic domestic/overseas classification.**
- **Upstream proxy authentication**: `upstreamUrl`, `gateways`, or a proxy URL in the launch environment may carry `user:pass`; proxy connections then send `Proxy-Authorization: Basic`. Currently only `http://` upstream proxies are supported: `upstreamUrl` with `https://` is an error; extra candidates (`gateways`, `--gateway`, `GATEWAY`, launch-environment proxies) with `https://` or invalid values are skipped with a redacted warning. Basic is base64, not encryption; use it only on loopback or trusted networks.
- **CONNECT (HTTPS)**: on 443, each candidate gets a TLS handshake probe; only a candidate that passes is used to open the tunnel. On failure, the next one is tried.
- **Plain HTTP**: the request body is buffered first (8 MB limit), and the request is replayed along the same candidate order. Connect uses `attemptTimeoutMs` (`fastFailTimeoutMs` for a known path), waiting for response headers uses `responseTimeoutMs`; the timer stops once the response body starts streaming.
- **Idempotency-key replay**: with `retryNonIdempotentWithIdempotencyKey` on, a non-idempotent request is replayed after send only when it carries a non-empty `Idempotency-Key`/`X-Idempotency-Key`; the proxy does not verify that the upstream actually deduplicates.
- **Replay policy (plain HTTP only; CONNECT tunnels are never replayed)**: if the TCP connection to the gateway/target is not established yet, any method is replayed. Once the connection is established, only idempotent methods are replayed (`GET`/`HEAD`/`OPTIONS`/`TRACE`/`PUT`/`DELETE`). `POST`/`PATCH` and other methods stop by default with 502 and the body `non-idempotent request may have been delivered; not replayed`; enable `retryNonIdempotentAfterSend` for the old behaviour.
- **Fast-fail covers the connect phase only**: if the cached or health-preferred gateway cannot connect over TCP, it is skipped within 2 seconds; a policy match is not a known path, so a `preferDirect` first candidate still uses the full `attemptTimeoutMs`. If it connects but never returns response headers, the request still waits the full `responseTimeoutMs` (60 seconds by default).
- **Health check**: every `healthIntervalMs`, a `GET healthUrl` validates the channel; anything below 500 counts as reachable (401/403 means the endpoint is alive). The winner becomes the global favourite; if all candidates fail, the favourite is cleared and the next request re-scans. Set to `0` to disable. Policy-matched hosts ignore the global favourite; only unmatched hosts use it.
- **Per-host preference cache** (60 seconds by default, up to 1000 entries, LRU eviction): a cache hit skips probing; a failure switches immediately.
- **Two-tier cooldown** (30 seconds by default):
  - Proxy's own TCP/DNS/connect failure, 407, proxy silence or reset before response headers: gateway-wide, affecting every host so new hosts do not keep hitting a dead proxy;
  - Direct connect failure, proxy CONNECT target failure, TLS failure, direct header timeout, direct reset before headers: `host + gateway`, affecting only that host;
  - A reset after response headers started streaming is not a routing failure and is not cooled; policy rules never pull a cooling gateway back.
- **Failure triggers a health check**: any failed path kicks a health re-check (at most once per second), instead of waiting for the next 60-second cycle.
- **Hop-by-hop headers** are stripped per RFC 9110 (`Connection` and the fields it names, `Proxy-Connection`, `Transfer-Encoding`, etc.), and `Host` is rewritten to the target; response hop-by-hop headers are stripped too.
- **IPv6**: CONNECT accepts literals such as `[::1]:443`; hosts are normalised by removing brackets, lowercasing, and dropping a trailing dot.
- **Shutdown** waits up to `shutdownTimeoutMs` (1.5 seconds by default; an internal option) for in-flight requests, then force-destroys all sockets.
- A 502 is returned when every candidate fails, and also immediately when a non-idempotent request fails after the connection is established with `retryNonIdempotentAfterSend` off and no usable idempotency-key switch (remaining candidates are not tried).
- Logs contain the host, gateway and reason only; request contents are never logged.

**0.8.0 behaviour change**: adds manual destination policy and switches to two-tier cooling. With no policy, candidate order matches 0.7.4, but direct/TLS/header/reset failures no longer cool across hosts; proxy-own failures still cool gateway-wide.

## As a standalone process

```bash
dual-proxy --listen-port 7898 --upstream-port 7897 \
  --gateway 127.0.0.1:12334 --health-url https://api.deepseek.com

node bin/dual-proxy.js --listen-port 7898      # if it is not on PATH
```

| Flag | Default | Description |
| :--- | :--- | :--- |
| `--listen-host` | `127.0.0.1` | Listen address |
| `--listen-port` | `7898` | Listen port |
| `--port-fallback` | `0` | On EADDRINUSE, try port+1 up to this many times; `0` disables |
| `--print-config` | — | Print the effective config and exit (alias `--dry-run`) |
| `--upstream-host` | `127.0.0.1` | First candidate gateway |
| `--upstream-port` | `7897` | Port of the first candidate |
| `--upstream-url` | — | Full URL of the first candidate, may include `user:pass`; overrides host/port |
| `--gateway` | — | Extra candidate, repeatable |
| `--prefer-direct` | empty | Try direct first for these hosts, comma-separated, `*` glob |
| `--prefer-proxy` | empty | Try proxies first for these hosts, comma-separated, `*` glob |
| `--health-url` | empty | Channel check URL |
| `--health-interval-ms` | `60000` | Health-check interval, `0` disables |
| `--fast-fail-ms` | `2000` | Connect timeout for a known path |
| `--cooldown-ms` | `30000` | Cooldown for a failed gateway |
| `--timeout-ms` | `5000` | Per-attempt/per-probe timeout |
| `--response-timeout-ms` | `60000` | Upper bound for response headers |
| `--pref-ttl-ms` | `60000` | Per-host preference TTL |
| `--no-verify-tls` | off | Skip the TLS probe on 443 |
| `--retry-non-idempotent-after-send` | off | Also replay `POST`/`PATCH` after the connection was established |
| `--retry-non-idempotent-with-idempotency-key` | off | Allow post-send replay when `Idempotency-Key` is present |

Environment variables use the same names (`LISTEN_HOST`, `LISTEN_PORT`, `PORT_FALLBACK`, `UPSTREAM_HOST`, `UPSTREAM_PORT`, `UPSTREAM_URL`, `GATEWAY`, `PREFER_DIRECT`, `PREFER_PROXY`, `HEALTH_URL`, `HEALTH_INTERVAL_MS`, `FAST_FAIL_MS`, `COOLDOWN_MS`, `ATTEMPT_TIMEOUT_MS`, `RESPONSE_TIMEOUT_MS`, `PREF_TTL_MS`, `VERIFY_TLS=0`, `RETRY_NON_IDEMPOTENT_AFTER_SEND=1`, `RETRY_NON_IDEMPOTENT_WITH_IDEMPOTENCY_KEY=1`).

A systemd user-service template lives in `contrib/`.

## For mainstream CLI agents

Agents such as Claude Code, Codex CLI, and Gemini CLI share no plugin API; the only common ground is `HTTP(S)_PROXY`. The launcher does three things: start the dual proxy, inject the proxy environment into the child, and exec the agent.

```bash
agent-gateway run claude --resume   # start proxy → inject → exec
agent-gateway run -- <any command>  # beyond the built-in table
agent-gateway env                   # print export statements to source
agent-gateway --print-config        # print listen/upstream/gateways/rules/health and exit
```

Injection replaces a socks `ALL_PROXY` inherited from the launch environment: many clients prefer it, and leaving it in place bypasses `HTTP(S)_PROXY`, defeating the whole point. `NO_PROXY` is merged with the user's existing bypasses rather than overwritten; loopback stays direct, so an agent's own local ports (hooks, LSP, language servers) are never swallowed by the proxy. If the port already hosts agent-dual-proxy, the launcher reuses that listener; if another program owns it, the launcher exits with an error instead of pointing the agent at a non-proxy port. If nothing is listening but the port is blocked by TIME-WAIT, the launcher steps forward up to 10 ports (`--port-fallback`) and injects the port it actually bound. When the child exits, the proxy is closed and no orphan process is left behind. See [docs/agents.md](docs/agents.md) for per-agent details.

## Tests

```bash
npm test
```

The suite runs from the repository or the source archive; run `npm install` once in the source directory before `npm test`. The npm package does not include `test/`, so it cannot be run from an installed package.

The suite covers: HTTP direct fallback, forwarding through a fake proxy, skipping a dead gateway among several, 502 when every path fails, timeout-based failover from a black-hole gateway, hop-by-hop header filtering in both directions, upstream disconnects mid-response without crashing, CONNECT direct tunnels and fake-proxy tunnels, early data arriving with the CONNECT 200, IPv6 literals, fast-fail when a cached gateway stalls, cooldown after a failure, two-tier cooling with host isolation and phase classification, stream resets not cooling, destination policy (parsing/matching/precedence/health-and-cache override/CLI/env/both entrypoints), forced tunnel teardown on shutdown, gateway parsing/deduplication (including self-exclusion and self-loop protection), health-check selection and failure, the health loop remembering the favourite, failure kicking a health check, the health-check reentrancy lock, the preference-cache cap, CLI validation and exit codes, self-signed TLS probing, the non-idempotent replay policy (send boundary, method classes, switch, logs and cooldown), upstream proxy authentication (CONNECT/HTTP/health, 407), the idempotency-key replay switch (presence checks and logs), and the agent launcher's environment injection, exit-code passthrough, port-reuse identity probing, port fallback and EADDRINUSE diagnostics, socks-warning deduplication, and `--print-config`.

## Troubleshooting

- **Nothing is listening, yet listen reports EADDRINUSE**: check `ss -tan | grep :7898`. Short-lived connections created by another process leave TIME-WAIT sockets on that port; if they were created without `SO_REUSEADDR`, a later binder cannot reuse the port even with Node's `reuseAddress` (the reuse bit is a two-way gate, not a plugin bug). Use another port, or `--port-fallback` to step forward; the log prints the actual port.
- **`socks ... skipped` in the startup log**: only `http://` upstream proxies are supported, so `ALL_PROXY=socks://...` is skipped by design.
- **Runtime logs go to stderr**: `dual-proxy` and `agent-gateway` write status logs to stderr; `agent-gateway env` writes export statements to stdout so they can be evaluated.
- **Windows**: global npm commands are `.cmd`/`.ps1` shims; kill the `node.exe` that owns the port (`Get-NetTCPConnection -LocalPort 7898`) rather than the shim; `Start-Process` needs separate stdout and stderr redirections.

## Boundaries

- Only HTTP/1.1 `CONNECT` and plain HTTP; no transparent proxying and no UDP.
- A plain HTTP request waits up to `responseTimeoutMs` (60 seconds by default) for response headers after the gateway connection is established; 0.8.0 does not shorten that wait, and the idempotency key only changes the replay decision after the timeout.
- Once a CONNECT tunnel is established the proxy only forwards bytes and TLS is end-to-end; an in-tunnel failure cannot be failed over. Covering it would require MITM decryption, which conflicts with this project's no-interception design.
- Certificates are not verified, contents are not cached, and there is no authentication. It binds to loopback by default; changing `listenHost` to a non-loopback address logs a warning at startup — that turns it into an unauthenticated proxy, at your own risk.
- Upstream proxy authentication is HTTP Basic only; `https://` upstream proxies (TLS-to-proxy) are not supported. Basic is suitable only on loopback or trusted networks; protecting credentials to a remote proxy is outside this project's scope.
- **Destination policy is an operator-maintained list, not automatic domestic/overseas classification**; unmatched hosts still follow the health favourite and default order.
- **Cooldown classification is heuristic**: a proxy-path reset before response headers may be target-triggered and relayed by the proxy; gateway-wide cooling can over-cool other hosts. 0.8.0 accepts that trade-off; an escalation mechanism is future work.
- It only answers "can I get there", not "can I trust it" — certificate validation remains the client's responsibility.
- The health check sends one unauthenticated `GET`; the criterion is "a response below 500", not whether credentials or model permissions are valid. It is only a fallback signal for hosts that match no policy rule, not a classification input.
- **At-most-once is not guaranteed**: with the default `retryNonIdempotentAfterSend: false`, `POST`/`PATCH` return 502 immediately after a failure once the connection is established (possibly delivered, not replayed), while idempotent methods are still replayed; enabling the switch restores replay-after-send at the cost of possible duplicate execution. Client SDK retries on 5xx are outside the proxy's control; for billing- or write-sensitive calls, use idempotency keys upstream.

## Feedback

Use GitHub Issues for questions, bugs, and suggestions: <https://github.com/gambn/agent-dual-proxy/issues>. Do not paste tokens, keys, or full request contents into an issue; see [SECURITY.md](SECURITY.md) for security reports.

## License

MIT
