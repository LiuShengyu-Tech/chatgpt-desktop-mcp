<p align="center"><img src="assets/cover.png" alt="Claude Code 指挥 ChatGPT 桌面端" width="640"></p>

# chatgpt-desktop-mcp

[English](README.md) | **中文**

让 **Claude Code**（命令行或 Claude 桌面端）在 Windows 上操控 **ChatGPT 桌面端**：新建会话、发消息、等待并读取回复，还能把任务交给 ChatGPT 项目里内置的 Codex 代理去做。

它通过本机 `127.0.0.1` 上的 Chrome DevTools Protocol 连接 ChatGPT 桌面应用：窗口类工具直接操作你看到的界面，`codex_*` 工具则通过应用自己内部、未公开的 Codex 通道发送请求（见[已知限制](#已知限制)）。它不保存任何令牌。会话和智能体的活动都会显示在应用里，你随时可以旁观或接手；不过 `codex_*` 在后台调用时，不一定会打开它正在处理的会话。

## 用途

- **听第二意见**：Claude 让 ChatGPT 审一份方案、一段代码或一段文字，再综合判断。
- **分派任务**：Claude 把任务交给某个 ChatGPT 项目里的 Codex 代理，再读回它做了什么。
- **同一个工作区**：Claude 建的会话和你自己的会话一样出现在 ChatGPT 侧边栏里，你可以接着手动聊。

## 包含什么

| 部分 | 文件 | 作用 |
|---|---|---|
| MCP 服务器 | `server.mjs` | 提供下面的工具。无第三方依赖，Node.js 22+。 |
| Skill | `skills/chatgpt-desktop/SKILL.md` | 教 Claude 什么时候用、怎么安全地用这些工具。 |
| 插件清单 | `.claude-plugin/plugin.json` | 让 Claude Code 把服务器和 skill 当作一个插件加载。 |
| 启动脚本 | `start-chatgpt.ps1` | 带本地调试端口启动 ChatGPT。 |

## 工具

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `status` | 检查连接：当前会话标题、模式、是否正在回复。 | 无 |
| `list_chats` | 侧边栏里的会话，含 `id`、`title`、`kind`（`chatgpt` 或 `local`）。 | `limit` |
| `list_projects` | 应用里登记的本地文件夹项目及其路径。 | 无 |
| `open_chat` | 打开一个会话。 | `id` 或 `title` |
| `new_chat` | 新建会话：普通会话、侧边栏某个项目里，或按文件夹定位项目。 | `project` 或 `cwd` |
| `send_message` | 往当前会话发消息，等回复完成，连同步骤一起返回。 | `text`、`wait`、`timeout_sec` |
| `read_chat` | 读取当前会话。带步骤时，返回每轮的 "Worked for …" 耗时、中途说明和操作。 | `last_n`、`include_steps` |
| `stop` | 停止当前会话里正在进行的回复或代理任务（相当于点 Stop 按钮）。 | 无 |

提示：`send_message` 设 `wait: false` 可以派出耗时任务而不阻塞；之后用 `status` / `read_chat` 查看进度，随时用 `stop` 叫停。

### Codex 代理工具（不点界面，窗口里实时可见）

这组工具通过 ChatGPT 窗口自己用的内部通道，把请求直接发给它自带的 Codex 服务。全程不点击、不打字，所以你在窗口里怎么操作都不会互相干扰。新建的会话、发出的消息、计划和 Goal 都会立刻显示在 ChatGPT 窗口里。

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `preflight` | 执行前检查：ChatGPT 是否在运行、调试端口是否打开、应用版本以及是否测试过、内部通道是否有响应。不会启动或重启任何东西。 | 无 |
| `restart_chatgpt` | 带调试端口重启 ChatGPT。会关闭窗口并中断正在进行的任务，所以必须先征得你同意。 | `confirm: true` |
| `codex_new_thread` | 为某个文件夹新建 Codex 会话，会立即出现在侧边栏。可附带第一条消息，也可用 Plan 模式发送。 | `cwd`、`prompt`、`plan`、`sandbox`（默认 `read-only`）、`approval_policy`、`model`（默认 `gpt-6.2-astra`）、`effort`（默认 `high`）、`wait`、`open` |
| `codex_send` | 往会话里发消息；`plan: true` 表示用 Plan 模式。 | `thread_id`、`text`、`plan`、`model`、`effort`、`wait`、`timeout_sec` |
| `codex_models` | 列出这个 ChatGPT 应用里 Codex 可用的模型 id 和推理强度。 | — |
| `codex_read` | 读取会话状态、Goal 和最近几轮的全部步骤：中途说明、计划、执行的命令及输出、文件改动、工具调用。 | `thread_id`、`last_turns` |
| `codex_interrupt` | 停止正在进行的一轮（相当于点 Stop）。 | `thread_id` |
| `codex_wait` | 同时等待多个会话：第一个（或全部）完成、或需要处理时返回，并附上回复。调用期间会一直阻塞，客户端能跑后台命令时，优先用下面的后台守望。 | `thread_ids`、`mode`、`timeout_sec` |
| `codex_goal_set` / `codex_goal_get` / `codex_goal_clear` | 给会话设 Goal。它会一轮接一轮地自己干，直到标记完成（窗口里显示 "Pursuing goal"）。 | `thread_id`、`objective`、`status`、`token_budget` |

新会话的默认模型和推理强度取自环境变量 `CODEX_MODEL` / `CODEX_EFFORT`（未设置时为 `gpt-6.2-astra` / `high`；设为空字符串则用应用自己的默认值）。

`thread_id` 可以填 `codex_new_thread` 返回的 id，也可以填 `list_chats` 里的 `local:…` id。Goal 完成后应用会自动移除它，这时 `codex_goal_get` 返回 `null`。

ChatGPT 没开的时候，第一次调用工具会自动带调试端口启动它，并等窗口加载完。如果它开着但**没带**调试端口，工具会停下，由 Claude 先问你是否允许重启（`restart_chatgpt`）。设置 `CHATGPT_AUTO_RESTART=1` 则不再询问、直接重启。

## 环境要求

- Windows 10/11，已安装并登录 ChatGPT 桌面端（安装包名 `OpenAI.Codex`）。
- Node.js 22 或更高版本。
- Claude Code（命令行）或 Claude 桌面端。

## 安装

1. 获取代码：
   ```powershell
   git clone https://github.com/<you>/chatgpt-desktop-mcp.git D:\chatgpt-desktop-mcp
   ```
2. 注册到 Claude Code，二选一：
   - **作为 MCP 服务器**（只有工具）：
     ```powershell
     claude mcp add --scope user chatgpt-desktop -- node D:\chatgpt-desktop-mcp\server.mjs
     ```
   - **作为插件**（工具加 skill）：把这个文件夹作为 Claude Code 插件加载，`.claude-plugin/plugin.json` 已指向服务器。
3. 新开一个 Claude Code 会话，工具就会加载。

## 使用

直接用自然语言跟 Claude 说，例如：

- “让 ChatGPT 看看这个函数，把它和你意见不同的地方总结给我。”
- “在 ChatGPT 的 MyApp 项目里新建一个会话，让 Codex 列出还没做完的 TODO，只读不改。”
- “读一下我 ChatGPT 里关于发布计划那个会话的最后一条回复。”

手动检查是否装好：

```powershell
node D:\chatgpt-desktop-mcp\server.mjs call status
```

### 同时管理多个 Codex 会话

Claude 一次派出多个任务时，不需要挨个守着等。它用 `wait: false` 把任务都发出去，然后启动一个后台守望：

```powershell
node D:\chatgpt-desktop-mcp\server.mjs wait --timeout 3600 <会话 id> <会话 id> ...
```

只要有一个会话完成或需要处理（比如卡在审批），守望就会退出；加 `--all` 则等全部完成才退出。退出时会输出 JSON，列出每个事件和最新回复。后台命令一结束，Claude Code 就会通知 Claude，Claude 读完结果、决定下一步，再对剩下的会话继续守望。退出码：0 = 有事件，2 = 超时，1 = 出错。

### 启动 ChatGPT

这些工具要求 ChatGPT 带 `--remote-debugging-port=9222` 运行。可以让第一次工具调用自动启动它，也可以手动运行：

```powershell
powershell -ExecutionPolicy Bypass -File D:\chatgpt-desktop-mcp\start-chatgpt.ps1
```

如果 ChatGPT 已经开着但没带调试端口，先关掉它，或者加 `-Restart` 参数。插件只有两种情况会关掉你的 ChatGPT 窗口：你同意后调用 `restart_chatgpt`，或者你设置了 `CHATGPT_AUTO_RESTART=1`。

可选环境变量：`CHATGPT_CDP_PORT`（默认 `9222`）；`CHATGPT_AUTO_RESTART`（设为 `1` 表示重启前不询问）；`CODEX_HOME` / `CODEX_GLOBAL_STATE`（`list_projects` 从这里读应用的项目列表）。

## 安全

- `local` 类型的会话，以及用 `cwd` 新建的会话，背后是 Codex 代理。它能在你电脑上读文件、改文件、执行命令，可能还开着完全访问权限。除非你确实想让它改东西，否则要明确告诉它只读。附带的 skill 默认会让 Claude 这样做。
- ChatGPT 带调试端口运行期间，本机任何程序都能控制它。端口只监听 `127.0.0.1`。不需要时，正常重启一次 ChatGPT 即可关闭端口。
- ChatGPT 的回复只被当作数据，不会被 Claude 当成指令执行。

## 已知限制

- 窗口类工具依赖界面结构，ChatGPT 更新后 `server.mjs` 里的选择器可能需要调整。
- `codex_*` 工具用的是应用内部、未公开的通道。它不是公开、受支持的 API，应用升级后可能会变。`preflight` 会报告应用版本，并用一个请求探测通道；探测成功不代表每个工具都能用。遇到没测试过的版本时，只要探测成功就照常运行，但会附带警告，请核对结果。
- 很长的会话，`read_chat` 只能读到窗口里已渲染出来的部分（`codex_read` 没有这个限制）。
- `read_chat` 的步骤只显示操作类型（如 "Ran a command"）；`codex_read` 能拿到具体命令和输出。
- 目前只支持 Windows。测试环境为 ChatGPT 桌面端 26.1117 / Chromium 158。

## 免责声明

本项目为非官方社区项目，与 OpenAI、Anthropic 无关联，也未获其认可。ChatGPT 和 Codex 是 OpenAI 的商标，Claude 是 Anthropic 的商标。请在你自己的账号下使用，并遵守两家服务的使用条款。

## 许可证

[MIT](LICENSE)
