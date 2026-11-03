# 给主流 CLI agent 用

这些 agent 没有共用的插件 API，唯一通杀的是 `HTTP(S)_PROXY`。所以适配层就一件事：

```
agent-gateway run <agent>   →   起双路代理 + 把代理变量塞进子进程 + exec
```

端口已被占用时复用那一个；子进程退出后代理跟着关，不留孤儿进程。agent 的本地端口
（hook、LSP、语言服务器）走 `NO_PROXY` 直连，不会被代理吞掉。

注入时会替换启动环境里的 socks `ALL_PROXY`：不少客户端会优先读它，留着就绕过了
`HTTP(S)_PROXY`，双路选路白做。`NO_PROXY` 与用户原有的直连段合并，不覆盖。

```bash
node bin/agent-gateway.js run claude --resume
node bin/agent-gateway.js run codex
node bin/agent-gateway.js run --listen-port 12334 --health-url https://api.deepseek.com -- gemini
node bin/agent-gateway.js env   # 打印 export 语句，给不支持启动器的场景用
```

内置短名只是「名字 → 可执行文件」的映射，真正的适配仍然是环境变量：

| 短名 | 可执行文件 | 说明 |
| :--- | :--- | :--- |
| `claude` | `claude` | Claude Code |
| `codex` | `codex` | OpenAI Codex CLI |
| `gemini` | `gemini` | Gemini CLI |
| `pi` | `pi` | pi |
| `aider` | `aider` | Aider |
| `opencode` | `opencode` | OpenCode |
| `qwen` | `qwen` | Qwen Code |
| `cursor` | `cursor-agent` | Cursor CLI |
| `droid` | `droid` | Factory Droid |
| `amp` | `amp` | Amp |
| `crush` | `crush` | Charm Crush |
| `goose` | `goose` | Goose |
| `copilot` | `copilot` | GitHub Copilot CLI |

不在表里的 CLI 用 `agent-gateway run -- <cmd> [args...]`，效果一样。客户端不读环境变量时，
这一层无能为力——见下面的排查提示。

## Claude Code

`~/.claude/settings.json` 支持 `env` 段，写进去就不用每次走启动器：

```json
{
  "env": {
    "HTTPS_PROXY": "http://127.0.0.1:7898",
    "HTTP_PROXY": "http://127.0.0.1:7898",
    "ALL_PROXY": "http://127.0.0.1:7898",
    "NO_PROXY": "localhost,127.0.0.1,::1,[::1]"
  }
}
```

先有代理在听（`agent-gateway run claude` 会自己起；或 `dual-proxy --listen-port 7898`）。

## Codex CLI

`~/.codex/config.toml` 没有代理字段，只能用环境变量，所以走启动器：

```bash
agent-gateway run codex
```

## Gemini CLI

同样只有环境变量这一条路：

```bash
agent-gateway run gemini
```

如果该版本的内置 HTTP 客户端不读环境变量（表现为请求完全没经过 7898，`ss -tnp | grep 7898` 为空），
就把它放到系统代理或 TUN 之下——那不是这一层能解决的，别在本插件里加特例。

## pi

```bash
agent-gateway run pi
```

pi 自己的长会话里若中途换了网络，重启会话比热改环境可靠：进程环境是启动快照，
`collectGateways` 也只读一次。

## 通用命令

```bash
agent-gateway run -- <任意命令> [args...]
```

任何尊重 `HTTP(S)_PROXY` 的 CLI 都能这样套上，不限于上表。
