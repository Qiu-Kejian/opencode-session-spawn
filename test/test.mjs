import { fileURLToPath, pathToFileURL } from "node:url";
// 默认测项目版（相对路径）；RELAY_MAIN 环境变量覆盖（如指向生产活实例）
const MAIN_URL = process.env.RELAY_MAIN ? pathToFileURL(process.env.RELAY_MAIN).href : new URL("../index.js", import.meta.url).href;
const { SessionSpawn } = await import(MAIN_URL);
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

// 假 client：记录 create / promptAsync / prompt 调用与 toast。
function makeClient({ failCreate = false, failPrompt = false, noPromptAsync = false, noPrompt = false, noCreate = false } = {}) {
  const calls = { create: [], promptAsync: [], prompt: [] };
  const toasts = [];
  const session = {
    create: noCreate ? undefined : async (opts) => {
      calls.create.push(opts);
      if (failCreate) throw new Error("CREATE_FAIL");
      return { data: { id: "ses_new_1" } };
    },
    promptAsync: noPromptAsync ? undefined : async (arg) => {
      calls.promptAsync.push(arg);
      if (failPrompt) throw new Error("PROMPT_FAIL");
      return { data: {} };
    },
    prompt: noPrompt ? undefined : async (arg) => {
      calls.prompt.push(arg);
      if (failPrompt) throw new Error("PROMPT_FAIL");
      return { data: {} };
    },
  };
  return { client: { tui: { showToast: async (t) => toasts.push(t) }, session }, calls, toasts };
}

const pluginPath = process.env.RELAY_MAIN || fileURLToPath(new URL("../index.js", import.meta.url));
const src = readFileSync(pluginPath, "utf8");
const ctx = { sessionID: "S", messageID: "m1", agent: "build", abort: undefined, metadata() {}, async ask() {} };

// ============ A. 工具 spawn_session ============
section("A. 工具 spawn_session（create + promptAsync 注入）");

{
  // A1: 工具契约
  const { client } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  const t = hooks.tool && hooks.tool.spawn_session;
  ok("A1 hooks.tool.spawn_session 存在", !!t);
  ok("A1 有 description", t && typeof t.description === "string" && t.description.length > 0);
  ok("A1 参数含 prompt", t && t.args && !!t.args.prompt);
  ok("A1 参数含可选 title", t && t.args && !!t.args.title);
  ok("A1 execute 为函数", t && typeof t.execute === "function");
}

{
  // A2: 正常建会话 + 注入，title 参数生效
  const { client, calls } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  const r = await hooks.tool.spawn_session.execute({ prompt: "起始语句内容", title: "自定义标题" }, ctx);
  ok("A2 create 调用1次", calls.create.length === 1);
  ok("A2 create body.title = 参数 title", calls.create[0].body.title === "自定义标题");
  ok("A2 promptAsync 注入1次", calls.promptAsync.length === 1);
  ok("A2 注入 path.id = 新会话id", calls.promptAsync[0].path.id === "ses_new_1");
  ok("A2 注入 body.parts[0].text = prompt", calls.promptAsync[0].body.parts[0].text === "起始语句内容");
  ok("A2 返回串含会话id", typeof r === "string" && r.includes("ses_new_1"));
}

{
  // A3: 无 title → 取首行并清洗非法字符/截断
  const { client, calls } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks.tool.spawn_session.execute({ prompt: '迁移任务/第一阶段*?"<>| \n第二行内容' }, ctx);
  ok("A3 标题取首行且清洗非法字符", calls.create[0].body.title === "迁移任务第一阶段");
}

{
  // A4: create 失败 → 返回失败串，未注入
  const { client, calls } = makeClient({ failCreate: true });
  const hooks = await SessionSpawn({ directory: ".", client });
  const r = await hooks.tool.spawn_session.execute({ prompt: "x" }, ctx);
  ok("A4 create 失败返回值含「创建会话失败」", typeof r === "string" && r.includes("创建会话失败"));
  ok("A4 create 失败未注入", calls.promptAsync.length === 0);
}

{
  // A5: 注入失败 → 会话保留，返回串含 id 与注入失败
  const { client, calls } = makeClient({ failPrompt: true });
  const hooks = await SessionSpawn({ directory: ".", client });
  const r = await hooks.tool.spawn_session.execute({ prompt: "x" }, ctx);
  ok("A5 create 仍调用1次(会话保留)", calls.create.length === 1);
  ok("A5 返回值含会话id", typeof r === "string" && r.includes("ses_new_1"));
  ok("A5 返回值含「注入失败」", typeof r === "string" && r.includes("注入失败"));
}

{
  // A6: 传 agent → promptAsync body.agent 命中
  const { client, calls } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks.tool.spawn_session.execute({ prompt: "x", agent: "leader" }, ctx);
  ok("A6 agent 透传 promptAsync body.agent", calls.promptAsync[0].body.agent === "leader");
  ok("A6 传 agent 时 create 无 query", calls.create[0].query === undefined);
}

{
  // A7: 传 directory → create query.directory 命中
  const { client, calls } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks.tool.spawn_session.execute({ prompt: "x", directory: "D:\\dev\\bbcare" }, ctx);
  ok("A7 directory 透传 create.query.directory", calls.create[0].query && calls.create[0].query.directory === "D:\\dev\\bbcare");
  ok("A7 传 directory 时 promptAsync body 无 agent", calls.promptAsync[0].body.agent === undefined);
}

{
  // A8: 均不传 → v2.0.0 形状（无 query / 无 agent）
  const { client, calls } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks.tool.spawn_session.execute({ prompt: "x" }, ctx);
  ok("A8 未传 directory → create 无 query", calls.create[0].query === undefined);
  ok("A8 未传 agent → promptAsync body 无 agent", calls.promptAsync[0].body.agent === undefined);
}

{
  // A9: agent/directory 空串或纯空白 → 等同未传
  const { client, calls } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks.tool.spawn_session.execute({ prompt: "x", agent: "   ", directory: "" }, ctx);
  ok("A9 空白 agent 视为未传", calls.promptAsync[0].body.agent === undefined);
  ok("A9 空串 directory 视为未传", calls.create[0].query === undefined);
}

// ============ B. 人工命令 @spawn / @relay spawn ============
section("B. 人工命令 @spawn（兼容 @relay spawn）");

{
  // B1: @spawn <文本>
  const { client, calls, toasts } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@spawn 你好世界" }] });
  ok("B1 @spawn → create 1次", calls.create.length === 1);
  ok("B1 @spawn 注入文本 = 命令后文本", calls.promptAsync[0] && calls.promptAsync[0].body.parts[0].text === "你好世界");
  ok("B1 弹出 spawn toast", toasts.some((t) => t.title === "spawn"));
}

{
  // B2: @relay spawn 兼容
  const { client, calls } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@relay spawn 接力一下" }] });
  ok("B2 @relay spawn → create 1次", calls.create.length === 1);
  ok("B2 注入文本正确", calls.promptAsync[0] && calls.promptAsync[0].body.parts[0].text === "接力一下");
}

{
  // B3: @spawn 空参 → 不建会话 + warning
  const { client, calls, toasts } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@spawn" }] });
  ok("B3 空参不建会话", calls.create.length === 0);
  ok("B3 空参 warning toast", toasts.some((t) => t.variant === "warning" && /用法/.test(t.message)));
}

{
  // B4: 普通文本 → 零副作用
  const { client, calls, toasts } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "这是一条普通消息" }] });
  ok("B4 普通文本不建会话", calls.create.length === 0);
  ok("B4 普通文本零 toast", toasts.length === 0);
}

{
  // B5: @spawn --agent leader 干活
  const { client, calls } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@spawn --agent leader 干活" }] });
  ok("B5 --agent → create 1次", calls.create.length === 1);
  ok("B5 --agent=leader", calls.promptAsync[0].body.agent === "leader");
  ok("B5 prompt=干活", calls.promptAsync[0].body.parts[0].text === "干活");
}

{
  // B6: --title T --agent leader（顺序颠倒）
  const { client, calls } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@spawn --title 标题T --agent leader 起始语" }] });
  ok("B6 顺序颠倒 agent 命中", calls.promptAsync[0].body.agent === "leader");
  ok("B6 顺序颠倒 title 命中", calls.create[0].body.title === "标题T");
  ok("B6 顺序颠倒 prompt 正确", calls.promptAsync[0].body.parts[0].text === "起始语");
}

{
  // B7: 起始语句内含 --agent（非前导）→ 原样保留、不解析
  const { client, calls } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@spawn 跑任务 --agent leader" }] });
  ok("B7 非前导 --agent 不解析", calls.promptAsync[0].body.agent === undefined);
  ok("B7 非前导 --agent 原样保留", calls.promptAsync[0].body.parts[0].text === "跑任务 --agent leader");
}

{
  // B8: @spawn --agent（缺值）→ warning 含用法、不建会话
  const { client, calls, toasts } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@spawn --agent" }] });
  ok("B8 缺值不建会话", calls.create.length === 0);
  ok("B8 缺值 warning 含用法", toasts.some((t) => t.variant === "warning" && /用法/.test(t.message)));
}

{
  // B9: @relay spawn 兼容且无 flag
  const { client, calls } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@relay spawn 提示" }] });
  ok("B9 @relay spawn → create 1次", calls.create.length === 1);
  ok("B9 @relay spawn 无 agent", calls.promptAsync[0].body.agent === undefined);
}

{
  // B10: --title 覆盖首行标题
  const { client, calls } = makeClient();
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@spawn --title 覆盖标题 首行标题\n第二行" }] });
  ok("B10 --title 覆盖首行标题", calls.create[0].body.title === "覆盖标题");
}

// ============ C. 回退与健壮性 ============
section("C. promptAsync 缺失回退 / create 缺失");

{
  // C1: 无 promptAsync → 回退同步 prompt
  const { client, calls } = makeClient({ noPromptAsync: true });
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks.tool.spawn_session.execute({ prompt: "回退测试" }, ctx);
  ok("C1 回退 prompt 1次", calls.prompt.length === 1);
  ok("C1 未调用 promptAsync(不存在)", calls.promptAsync.length === 0);
  ok("C1 回退注入文本正确", calls.prompt[0].body.parts[0].text === "回退测试");
}

{
  // C2: create 缺失 → 工具返回失败串，不抛
  const { client, calls } = makeClient({ noCreate: true });
  const hooks = await SessionSpawn({ directory: ".", client });
  const r = await hooks.tool.spawn_session.execute({ prompt: "x" }, ctx);
  ok("C2 create 缺失 → 返回「创建会话失败」", typeof r === "string" && r.includes("创建会话失败"));
  ok("C2 create 缺失未注入", calls.promptAsync.length === 0);
}

{
  // C3: 回退同步 prompt 同样透传 agent/directory
  const { client, calls } = makeClient({ noPromptAsync: true });
  const hooks = await SessionSpawn({ directory: ".", client });
  await hooks.tool.spawn_session.execute({ prompt: "回退", agent: "leader", directory: "D:\\dev\\bbcare" }, ctx);
  ok("C3 回退 prompt body.agent 命中", calls.prompt[0].body.agent === "leader");
  ok("C3 回退 create query.directory 命中", calls.create[0].query && calls.create[0].query.directory === "D:\\dev\\bbcare");
}

// ============ D. 源码无旧机制残留 ============
section("D. 源码级：旧接力机制零残留");

{
  ok("D1 无 pendingHandoffs", src.includes("pendingHandoffs") === false);
  ok("D1 无 HANDOFF_SENTINEL / RELAY_HANDOFF_DONE", src.includes("HANDOFF_SENTINEL") === false && src.includes("RELAY_HANDOFF_DONE") === false);
  ok("D1 无 event 钩子 / session.idle", src.includes("session.idle") === false && /\bevent\s*:/.test(src) === false);
  ok("D1 无 system.transform 注入", src.includes("system.transform") === false);
  ok("D1 无文书机制(seedDoc/docIsComplete/交接文书落盘)", src.includes("seedDoc") === false && src.includes("docIsComplete") === false);
  ok("D1 无链状态(chains/sessionChain)", src.includes("sessionChain") === false && src.includes("chains") === false);
  ok("D1 无 fs 状态文件", src.includes('"handoff"') === false && src.includes("readFileSync") === false);
  ok("D1 无旧命令 status/leave/refresh/verify", /@relay\s+status|@relay\s+leave|@relay\s+refresh|@relay\s+verify/i.test(src) === false);
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
