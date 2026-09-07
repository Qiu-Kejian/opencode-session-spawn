# session-relay 开发流水线（神圣约定，2026-09-07 立）

> 所有改动走固定流水线：**开发（项目仓库）→ 自测 → 同步生产验证 → 验证通过 → 提交发布**。
> 生产目录 = `C:\Users\tomtaw\.config\opencode\plugins\session-relay`（注册于全局 `opencode.jsonc` 的 `./plugins/session-relay`）。

## 四阶段流程

| 阶段 | 动作 | 位置 |
|------|------|------|
| 1 开发 | 只改本项目文件（index.js / docs / examples / package.json / test），生产目录不直接改 | `E:\dev\fun-projs\session-relay` |
| 2 自测 | `node test/test.mjs` → 须 `==== 结果: 68 通过, 0 失败 ====`（以尾部汇总行为准） | 项目 |
| 3 生产验证 | ① `index.js`+`package.json` **必须成对**复制到生产目录（files 清单含 README/LICENSE/docs/examples 时一并同步）② `RELAY_MAIN=<生产 index.js 绝对路径> node test/test.mjs` 回归全绿（锁定哈希一致）③ 重启桌面版 → 会话内 `@relay verify` 通过 | 生产目录 + 桌面版 |
| 4 发布 | 验证通过才可 commit → push → `npm publish`（**不打 git tag**） | GitHub + npm |

## 红线

- 版本号/描述演进时，`package.json` 必须与 `index.js` 同步复制（2026-08-27 曾漏同步导致生产停留 1.0.3）。
- 验证未全过（自测失败 / 生产回归失败 / `@relay verify` 未过）不得进入阶段 4。
- 不提交任何 token/密码/凭据；发布凭据靠本地 `.npmrc`（不入库）。`npm publish` 前先 `npm whoami` 确认登录态。
- 生产目录改动后需重启 opencode 桌面版才生效（插件加载自配置目录活实例）。

## 常用命令

```bash
node test/test.mjs                                     # 项目版自测（68 用例 A-J）
RELAY_MAIN="C:\Users\tomtaw\.config\opencode\plugins\session-relay\index.js" node test/test.mjs   # 生产版回归
# 同步生产（PowerShell，示例）：
Copy-Item index.js, package.json "C:\Users\tomtaw\.config\opencode\plugins\session-relay\"
npm whoami && npm publish                              # 发布（版本号已随阶段 3 前 bump 定稿）
```

- `test/test.mjs` 默认经相对路径测项目版；`RELAY_MAIN` 环境变量覆盖为其他路径（如生产活实例）。
- `SESSION_RELAY_DEBUG=1` 开启 compacting 钩子 `[probe]` 调试日志（默认静默）。
- 故意抛错用例（PROMPT_FAIL/CREATE_FAIL）输出 `[FAIL]` 属预期，以尾部汇总行为准。
