# opencode-session-spawn

opencode 插件：**会话生成原语**。只做一件事——**创建一个新的顶层会话，并把起始语句注入为该会话的首条消息**。

它的用途是**无人值守长任务编排**：当一条任务超出单会话上下文时，当前会话的模型可以在需要时自行生成一段交接语句、调用工具开出一个新会话继续，新会话拿到语句立即开跑。插件不落文书、不读文书、不追踪链、无状态文件——需要交接文书时，把「读取某份文书路径」等引导写进起始语句即可，与其他工具天然兼容。

## 两个入口（共用同一实现）

| 入口 | 用法 | 谁触发 |
|------|------|--------|
| 工具 `spawn_session` | `spawn_session({ prompt, title?, agent?, directory? })` | **模型自主调用**（打通无人值守） |
| 命令 | `@spawn [--agent <名称>] [--title <标题>] <起始语句>`（兼容 `@relay spawn`） | 人工触发 |

参数 / 行为：

- `prompt`（必填）：注入新会话的起始语句。可内含读取文件、复述要点、执行下一步等引导。
- `title`（可选）：新会话标题。缺省取 `prompt` 首行（清洗非法字符、截断 60）。
- `agent`（可选，工具参数）：新会话以某 agent/模式启动（如 `leader`）。仅在传了非空白值时透传，交服务端校验。
- `directory`（可选，工具参数）：新会话绑定的项目目录（如 `D:\dev\bbcare`）。仅在传了非空白值时透传，交服务端校验。
- 命令 flag 说明：`--agent` / `--title` 值均为**单个 token**（不处理引号/空格）；仅解析命令后**前导** flag，起始语句内部再出现的 `--xxx` 原样保留；flag 缺值或起始语句为空 → warning toast 且不建会话。`--title` 优先于起始语句首行。
- 内部调用：`client.session.create({ body: { title }, query: { directory } })` → `client.session.promptAsync({ path: { id }, body: { agent, parts: [{ type: "text", text: prompt }] } })`；`agent` / `directory` 未传时不出现对应键。
- 优先 `promptAsync`（异步 fire-and-forget，**不阻塞父会话**）；缺失则回退同步 `prompt`。
- create 失败 → 不建会话；create 成功但注入失败 → **保留已建会话**并提示 id，不产生重复会话。

## 安装（部署到桌面版）

桌面版从用户配置目录加载活插件：

```bash
cp index.js package.json "$HOME/.config/opencode/plugins/session-relay/"
```

在全局 `opencode.jsonc` 的 `plugin` 数组注册 `./plugins/session-relay`，重启桌面版生效。

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

## 开发与测试

```bash
npm install          # 安装 devDependency @opencode-ai/plugin（唯一依赖，仅测试用）
node test/test.mjs   # 23 用例 / 62 断言
```

- `test/test.mjs` 默认经相对路径 `../index.js` 测项目版；环境变量 `RELAY_MAIN` 覆盖为其他路径（如生产活实例）。生产版从 `.config/opencode/node_modules` 解析 `@opencode-ai/plugin`。
- 以尾部 `==== 结果: N 通过, 0 失败 ====` 为准。

## 发布

`index.js` + `package.json` 成对同步生产 → `RELAY_MAIN=<生产路径> node test/test.mjs` 回归全绿 → 重启桌面版实测 → commit → push → `npm publish`（不打 git tag；发布前 `npm whoami` 确认登录态，凭据不入库）。详见 `AGENTS.md`。

## 历史

前身 `opencode-session-relay` 的接力链、两阶段交接文书、空闲事件驱动、哨兵兜底、`@relay status/leave/refresh/verify` 等机制已全部移除，仅保留「建会话 + 注入语句」这一核心原语。
