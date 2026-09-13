# opencode-session-spawn 开发流水线（神圣约定，2026-09-07 立；2026-09-12 v2 简化；2026-09-13 对齐 npm 生产形态）

> 所有改动走固定流水线：**开发（项目仓库）→ 自测 → 生产验证 → 发布上线**。
> 项目目录 = `D:\dev\session-spawn`；生产实例 = npm 包 `opencode-session-spawn`（注册于全局 `C:\Users\qiu_k\.config\opencode\opencode.jsonc` 的 `plugin` 数组），opencode 将其装入包缓存 `C:\Users\qiu_k\.cache\opencode\packages\opencode-session-spawn@latest\node_modules\opencode-session-spawn`，重启桌面版后生效。

## 四阶段流程

| 阶段 | 动作 | 位置 |
|------|------|------|
| 1 开发 | 只改本项目文件（index.js / package.json / test / README），不直接改包缓存 | `D:\dev\session-spawn` |
| 2 自测 | `node test/test.mjs` → 须 `==== 结果: 62 通过, 0 失败 ====`（23 用例 / 62 断言，以尾部汇总行为准） | 项目 |
| 3 生产验证 | ① `npm pack`（tarball 即发布内容）→ 解包核对 `index.js` + `package.json` 与仓库哈希一致 ② `RELAY_MAIN=<解包目录>\package\index.js node test/test.mjs` 回归全绿 ③ 发布后重启桌面版 → 核对包缓存活实例哈希一致并 `RELAY_MAIN` 回归 → `@spawn <测试语句>` / `spawn_session` 实测建会话+注入成功 | 项目 + 包缓存 |
| 4 发布上线 | 阶段 2、3①② 全过才可 commit → push → `npm publish`（**不打 git tag**）→ 重启桌面版做 3③ 上线实测；实测不过必须立即修复补丁重发，不得带病收工 | GitHub + npm |

## 红线

- `package.json` 版本号必须与 `index.js` 头注释同步（2026-08-27 曾漏同步导致生产停留 1.0.3）。
- 发布前：自测或 tarball 回归未全过，不得 commit 发布；`npm publish` 前先 `npm whoami` 确认登录态。
- 不提交任何 token/密码/凭据；发布凭据靠本地 `.npmrc`（不入库；`.env` 已忽略）。
- 生产实例随 npm 包更新：重启桌面版后 opencode 按 `plugin` 名拉取最新发布；若缓存未刷新（版本/哈希未变），删除 `C:\Users\qiu_k\.cache\opencode\packages\opencode-session-spawn@latest` 后重启强制重装。
- `@opencode-ai/plugin` 是唯一外部依赖（工具注册需要）。测试前先 `npm install`。

## 常用命令

```powershell
npm install                                  # 安装 devDependency @opencode-ai/plugin（唯一依赖，仅测试用）
node test/test.mjs                           # 项目版自测（23 用例 / 62 断言 A-D）

# 发布前：验证 tarball（npm pack 产物即发布内容；解包须放项目内以解析 @opencode-ai/plugin）
npm pack                                     # 产出 opencode-session-spawn-<版本>.tgz
New-Item -ItemType Directory .pack-check -Force | Out-Null
tar -xzf opencode-session-spawn-<版本>.tgz -C .pack-check
Get-FileHash .\index.js, .pack-check\package\index.js   # 两行哈希须一致
$env:RELAY_MAIN="D:\dev\session-spawn\.pack-check\package\index.js"; node test/test.mjs
Remove-Item .pack-check -Recurse -Force      # 清理临时解包（不入库）

# 发布后：验证包缓存活实例
$env:RELAY_MAIN="C:\Users\qiu_k\.cache\opencode\packages\opencode-session-spawn@latest\node_modules\opencode-session-spawn\index.js"; node test/test.mjs
npm whoami; npm publish                      # 版本号已随阶段 3 前 bump 定稿
```

- `test/test.mjs` 默认经相对路径测项目版；环境变量 `RELAY_MAIN` 覆盖为其他路径（tarball 解包版 / 包缓存活实例）。
- 解包位置必须在项目内（或任何可向上解析到 `node_modules` 的目录），否则 `@opencode-ai/plugin` 解析失败。
- 有意构造的失败用例（CREATE_FAIL/PROMPT_FAIL）在自身断言内被捕获，不产生尾部 `[FAIL]`。

## 架构（v2.1.0）

- 唯一职责：`client.session.create({ body:{ title }, query:{ directory } })` → `client.session.promptAsync({ path:{ id }, body:{ agent, parts:[{type:'text',text}] } })`（agent/directory 可选，仅非空白时透传，交服务端校验）。
- 入口：工具 `spawn_session({ prompt, title?, agent?, directory? })`（模型自主）+ 命令 `@spawn [--agent <名称>] [--title <标题>] <起始语句>`（人工，兼容 `@relay spawn`）。
- 不落/不读文书、不追踪链、无状态文件；交接文书引导由调用方写进 `prompt`。
