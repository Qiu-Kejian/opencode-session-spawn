# opencode-session-spawn

opencode 插件：**会话生成原语**。做两件事——**创建一个新的顶层会话，并把起始语句注入为该会话首条消息**；以及**子会话反向通知父会话**（`notify_parent`：注入一条 `[relay]` 消息并唤醒父会话）。

它的用途是**无人值守长任务编排**：当一条任务超出单会话上下文时，当前会话的模型可以在需要时自行生成一段交接语句、调用工具开出一个新会话继续，新会话拿到语句立即开跑；子会话完成 / 受阻时可用 `notify_parent` 回调 spawn 它的会话。插件不落文书、不读文书、不追踪链、无状态文件——需要交接文书时，把「读取某份文书路径」等引导写进起始语句即可，与其他工具天然兼容。

## 入口与工具

| 入口 / 工具 | 用法 | 谁触发 |
|------|------|--------|
| 工具 `spawn_session` | `spawn_session({ prompt, title?, agent?, directory? })` | **模型自主调用**（打通无人值守） |
| 工具 `notify_parent` | `notify_parent({ text })` | **子会话模型自主调用**（完成 / 受阻时回调父会话） |
| 命令 | `@spawn [--agent <名称>] [--title <标题>] <起始语句>`（兼容 `@relay spawn`） | 人工触发 |

参数 / 行为：

- `prompt`（必填）：注入新会话的起始语句。可内含读取文件、复述要点、执行下一步等引导。
- `title`（可选）：新会话标题。缺省取 `prompt` 首行（清洗非法字符、截断 60）。
- `agent`（可选，工具参数）：新会话以某 agent/模式启动（如 `leader`）。仅在传了非空白值时透传，交服务端校验。
- `directory`（可选，工具参数）：新会话绑定的项目目录（如 `D:\dev\bbcare`）。仅在传了非空白值时透传，交服务端校验。
- `parentID`（自动，非参数）：`spawn_session` 自动把调用者会话 id 写入新会话 `parentID`（`context.sessionID` 非空白时）；命令 `@spawn` 无会话上下文，不带 `parentID`。
- 命令 flag 说明：`--agent` / `--title` 值均为**单个 token**（不处理引号/空格）；仅解析命令后**前导** flag，起始语句内部再出现的 `--xxx` 原样保留；flag 缺值或起始语句为空 → warning toast 且不建会话。`--title` 优先于起始语句首行。
- 内部调用（spawn）：`client.session.create({ body: { title, parentID }, query: { directory } })` → `client.session.promptAsync({ path: { id }, body: { agent, parts: [{ type: "text", text: prompt }] } })`；`agent` / `directory` / `parentID` 未传时不出现对应键。
- `notify_parent` 行为：仅能通知**父会话**（不提供任意 session id 参数）；`client.session.get` 解析自身 `parentID` 后，向父会话注入 `[relay] <text>` 并唤醒它；父会话以服务端默认模式（`build`）被唤醒；空文本 / 无父会话 / 读取或注入失败 → 返回错误文本（不抛）；无重试 / 队列 / 追踪（保持无状态原语）。
- 优先 `promptAsync`（异步 fire-and-forget，**不阻塞父会话**）；缺失则回退同步 `prompt`。
- create 失败 → 不建会话；create 成功但注入失败 → **保留已建会话**并提示 id，不产生重复会话。

## 安装（部署到桌面版）

现有部署形态：公共层配置 `share/opencode.json`（挂载到项目内即 `.opencode/opencode.json`）的 `plugin` 数组注册 **npm 包名**：

```jsonc
{
  "plugin": ["opencode-session-spawn"]
}
```

opencode 启动时自动把最新发布安装到包缓存 `~/.cache/opencode/packages/opencode-session-spawn/`（活实例为其中的 `node_modules/opencode-session-spawn/index.js`），**重启桌面版生效**。发布新版本后重启即自动更新；若缓存未刷新，删除 `~/.cache/opencode/packages/opencode-session-spawn@latest` 后重启强制重装。

> 旧的本地目录注册写法（如 `./plugins/session-relay/`）已作废；开发与生产验证统一走 `test/test.mjs` + `RELAY_MAIN`（见下节）。

## 编排示例

模型在长任务中决定交接，直接调用工具（可选 `agent` / `directory`）：

```
spawn_session({
  prompt: `你是本任务的接手会话。先读取交接文书：
E:\\proj\\handoff\\migration-3.md
通读后复述要点（已完成/未完成/下一步第 1 件事），确认后继续执行。`,
  title: "[迁移] 第 3 棒",
  agent: "leader",
  directory: "D:\\dev\\bbcare"
})
```

或人工在会话里发（前导 flag 可省略、顺序不限）：

```
@spawn --agent leader --title "[P1-10] sprint" 读取 handoff/migration-3.md 后继续迁移任务
```

父子回复约定（防环路）：父会话在起始语句里要求「子会话收尾 / 受阻时调用 `notify_parent`」；子会话执行：

```
notify_parent({ text: "P1-10 已完成，验收报告见 runs/P1-10-acceptance.md" })
```

父会话会收到一条 `[relay] …` 消息并以服务端默认模式被唤醒；收到通知后按需行动，**不要自动回发通知**（`notify_parent` 只向父会话发送，避免环路）。

## 开发与测试

```bash
npm install          # 安装 devDependency @opencode-ai/plugin（唯一依赖，仅测试用）
node test/test.mjs   # 34 用例 / 86 断言
```

- `test/test.mjs` 默认经相对路径 `../index.js` 测项目版；环境变量 `RELAY_MAIN` 覆盖为其他路径（tarball 解包版 / 包缓存活实例）。`RELAY_MAIN` 目标须能向上解析到 `@opencode-ai/plugin`（解包放项目内即可）。
- 以尾部 `==== 结果: N 通过, 0 失败 ====` 为准。

## 发布

bump 版本号（`package.json` 与 `index.js` 头注释同步）→ `node test/test.mjs` 全绿 → `npm pack` 解包核对哈希 + `RELAY_MAIN` 回归全绿 → commit → push → `npm publish`（不打 git tag；先 `npm whoami` 确认登录态，凭据不入库）→ 重启桌面版实测 `@spawn` / `spawn_session`；实测不过修复补丁重发。详见 `AGENTS.md`。

## 历史

前身 `opencode-session-relay` 的接力链、两阶段交接文书、空闲事件驱动、哨兵兜底、`@relay status/leave/refresh/verify` 等机制已全部移除，仅保留「建会话 + 注入语句」这一核心原语。
