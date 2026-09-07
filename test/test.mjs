import { fileURLToPath, pathToFileURL } from "node:url";
// 默认测项目版（相对路径）；RELAY_MAIN 环境变量覆盖（如指向生产活实例）
const MAIN_URL = process.env.RELAY_MAIN ? pathToFileURL(process.env.RELAY_MAIN).href : new URL("../index.js", import.meta.url).href;
const { SessionRelay } = await import(MAIN_URL);
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

function makeClient({ failCreate = false, failPrompt = false, noPrompt = false, failGet = false, title = "原始会话X" } = {}) {
  const calls = { create: 0, prompt: 0, get: 0, createArgs: [], promptArgs: [] };
  const toasts = [];
  const client = {
    tui: { showToast: async (t) => toasts.push(t) },
    session: {
      get: async (opts) => {
        calls.get++;
        if (failGet) throw new Error("GET_FAIL");
        return { data: { title } };
      },
      create: async (opts) => {
        calls.create++;
        calls.createArgs.push(opts);
        if (failCreate) throw new Error("CREATE_FAIL");
        return { data: { id: "ses_auto_1" } };
      },
      prompt: async (arg) => {
        calls.prompt++;
        calls.promptArgs.push(arg);
        if (failPrompt) throw new Error("PROMPT_FAIL");
        return { data: {} };
      },
    },
  };
  if (noPrompt) delete client.session.prompt;
  return { client, calls, toasts };
}

const pluginPath = process.env.RELAY_MAIN || fileURLToPath(new URL("../index.js", import.meta.url));
const src = readFileSync(pluginPath, "utf8");

async function fresh() {
  return mkdtempSync(join(tmpdir(), "relay-test-"));
}
async function state(dir) {
  return JSON.parse(readFileSync(join(dir, "handoff", ".relay-state.json"), "utf8"));
}

// ============ 模拟模型写完成品文书 ============
async function completeDocThenSentinel(dir, sessionID, extras = "", docHandoff = "") {
  const st = await state(dir);
  const pending = st.pendingHandoffs[sessionID];
  const docPath = pending.docPath;
  mkdirSync(dirname(docPath), { recursive: true });
  writeFileSync(docPath, `# 交接文书（成品，已覆盖骨架）
这是旧会话走 work-handoff skill 写好的成品交接内容，不再含骨架标记。
${extras}
${docHandoff ? `\n## 交接语\n\n\`\`\`text\n${docHandoff}\n\`\`\`` : ""}`, "utf8");
  return { docPath, cid: pending.cid, docNumber: pending.docNumber };
}

const RELAY_SENTINEL = "[RELAY_HANDOFF_DONE]";

// ============ A. 两阶段全自动链路（"下一棒"→Phase A→模型写文书→Phase B） ============
section("A. 两阶段（下一棒→Phase A→写文书→Phase B 哨兵/全自动）");

{
  // A1: "下一棒" → Phase A 只准备文书(不建会话) → 写成品 + 哨兵 → Phase B 建会话+注入
  const dir = await fresh();
  const { client, calls, toasts } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "下一棒" }] });
  const cid = (await state(dir)).sessionChain["S"];
  // Phase A：尚未建会话（create=0, prompt=0）
  ok("A1 Phase A 未建会话(create=0)", calls.create === 0);
  ok("A1 Phase A 未注入(prompt=0)", calls.prompt === 0);
  const stA = await state(dir);
  const dp = stA.chains[cid].docs[0];
  ok("A1 pending 已挂起", !!stA.pendingHandoffs["S"]);
  ok("A1 pending.cid === 链ID", stA.pendingHandoffs["S"].cid === cid);
  ok("A1 docPath 用 handoff/{cid}/原始会话标题-交接-N.md(含 cid 目录层)", /handoff[\\/]SR-[0-9a-f]{8}[\\/]原始会话X-\d{8}-交接-1\.md$/.test(dp) && dp.includes(cid));
  ok("A1 骨架文书已落盘(文件存在)", existsSync(dp));
  ok("A1 骨架含链标识", readFileSync(dp, "utf8").includes(cid));
  // system.transform 条件注入：pending 存在 → 应注入写文书指令
  const oSys = { system: ["base"] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "S" }, oSys);
  ok("A1 system.transform pending→注入指令", oSys.system.length === 2);
  ok("A1 指令含 docPath", oSys.system[1].includes(dp));
  // 旧模型写完成品并回复哨兵+真实交接语
  await completeDocThenSentinel(dir, "S", "真实交接语段：\n项目：X\n【先读文书再动手】【读完向用户复述要点】");
  const toastsB = [];
  const bclient = makeClient();
  bclient.toasts.length = 0;
  const hooksB = await SessionRelay({ directory: dir, client: { ...bclient.client, tui: { showToast: async (t) => toastsB.push(t) } } });
  await hooksB["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: `${RELAY_SENTINEL}
项目：E:\\dev\\func-projs\\session-relay
任务：xxx
文书：${dp}
【先读文书再动手】阅读文书。
【读完向用户复述】要点，确认后执行。` }] });
  ok("A1 Phase B create 调用1次(顶层 body.title)", bclient.calls.create === 1);
  ok("A1 Phase B prompt 注入1次", bclient.calls.prompt === 1);
  ok("A1 create 用 body.title 顶层会话(无 parentID)", bclient.calls.createArgs[0] && bclient.calls.createArgs[0].body && bclient.calls.createArgs[0].body.parentID === undefined && bclient.calls.createArgs[0].path === undefined);
  ok("A1 create 标题=[接力]原始会话名[N棒]", bclient.calls.createArgs[0] && bclient.calls.createArgs[0].body.title === "[接力]原始会话X[1棒]");
  ok("A1 注入消息=哨兵后的真实交接语", bclient.calls.promptArgs[0] && bclient.calls.promptArgs[0].body.parts[0].text.includes("【先读文书再动手】"));
  ok("A1 pending 已清(不再挂起)", !(await state(dir)).pendingHandoffs["S"]);
}

{
  // A2: 文书仍未补全(骨架)→ 哨兵到达 → 不建会话 + 告警
  const dir = await fresh();
  const { client, calls, toasts } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "下一棒" }] });
  // 不覆盖骨架，直接回复哨兵 → 应拒绝建会话
  const stA = await state(dir);
  const dp = stA.chains[stA.sessionChain["S"]].docs[0];
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: `${RELAY_SENTINEL} 交接语` }] });
  ok("A2 文书仍骨架→未建会话(create=0)", calls.create === 0);
  ok("A2 未注入(prompt=0)", calls.prompt === 0);
  ok("A2 文书未补全告警 warning", toasts.some((t) => (t.title || "").includes("文书未补全") && t.variant === "warning"));
}

{
  // A3(v3.1): 用户只发哨兵（无交接语文本）→ 从文书「## 交接语」节提取注入
  const dir = await fresh();
  const { client, calls, toasts } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "下一棒" }] });
  // 文书含「## 交接语」节；用户只发哨兵
  await completeDocThenSentinel(dir, "S", "", "项目：X\n任务：Y\n【先读文书再动手】复述要点");
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: RELAY_SENTINEL }] });
  ok("A3 用户哨兵 → create 1次", calls.create === 1);
  ok("A3 注入文本=文书内交接语节", calls.promptArgs[0] && calls.promptArgs[0].body.parts[0].text.includes("【先读文书再动手】"));
  ok("A3 pending 已清", !(await state(dir)).pendingHandoffs["S"]);
}

{
  // A4(全自动): 下一棒→Phase A→模型写完文书后 session.idle → 自动 Phase B 建会话+注入
  const dir = await fresh();
  const { client, calls } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "下一棒" }] });
  // 模型用 Write 覆盖为成品，随后 session.idle 事件触发
  await completeDocThenSentinel(dir, "S", "", "项目：X\n任务：Y\n【先读文书再动手】复述要点");
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "S" } } });
  ok("A4 session.idle → create 1次(无需用户哨兵)", calls.create === 1);
  ok("A4 注入文本=文书内交接语节", calls.promptArgs[0] && calls.promptArgs[0].body.parts[0].text.includes("【先读文书再动手】"));
  ok("A4 pending 已清", !(await state(dir)).pendingHandoffs["S"]);
}

// ============ A5. "下一棒" / "relay next" 双触发词 ============
section("A5. 下一棒 / relay next 双触发词");

{
  // A5a: "下一棒" 触发（未归链→自动建链）
  const dir = await fresh();
  const { client, calls } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "下一棒" }] });
  let st = await state(dir);
  ok("A5a 下一棒→建链(未归链自动建)", !!st.sessionChain["S"]);
  ok("A5a Phase A 未建会话", calls.create === 0);
  ok("A5a docs=1", st.chains[st.sessionChain["S"]].docs.length === 1);

  // A5b: "relay next" 触发（同下一棒）
  const dir2 = await fresh();
  const { client: c2, calls: c2c } = makeClient();
  const hooks2 = await SessionRelay({ directory: dir2, client: c2 });
  await hooks2["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "relay next" }] });
  let st2 = await state(dir2);
  ok("A5b relay next→建链", !!st2.sessionChain["S"]);
  ok("A5b relay next→未建会话", c2c.create === 0);
  ok("A5b docs=1", st2.chains[st2.sessionChain["S"]].docs.length === 1);

  // A5c: "Relay Next" 大小写不敏感
  const dir3 = await fresh();
  const { client: c3, calls: c3c } = makeClient();
  const hooks3 = await SessionRelay({ directory: dir3, client: c3 });
  await hooks3["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "Relay Next" }] });
  let st3 = await state(dir3);
  ok("A5c Relay Next 大小写→建链", !!st3.sessionChain["S"]);
}

{
  // A5d: "@relay next" 不冲突 → 应由 @relay 命令处理走「不支持」toast
  const dir = await fresh();
  const { client, toasts } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@relay next" }] });
  ok("A5d @relay next 走命令toast(非下一棒触发)", toasts.some((t) => (t.title || "").includes("relay 命令")));
}

// A5e: 文本中含 "relay next" 作为整体而不被 @relay 误拦截（正则独占）
{
  const dir = await fresh();
  const { client, calls } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "  relay next  " }] });
  let st = await state(dir);
  ok("A5e 前后空格→建链", !!st.sessionChain["S"]);
}

// ============ B. @relay 命令 ============
section("B. @relay status/leave");

{
  const dir = await fresh();
  const { client, toasts } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  // status（未归链）
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@relay status" }] });
  ok("B1 未归链 status 提示未归属", toasts.some((t) => t.title === "relay 状态" && /未归属/.test(t.message)));
  // 进入链
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "进入接力模式" }] });
  const toasts2 = [];
  const { client: c2 } = makeClient();
  const hooks2 = await SessionRelay({ directory: dir, client: { ...c2, tui: { showToast: async (t) => toasts2.push(t) } } });
  await hooks2["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@relay status" }] });
  ok("B2 归链后 status 显示链信息", toasts2.some((t) => t.title === "relay 状态" && /SR-/.test(t.message)));
  // leave
  const toasts3 = [];
  const hooks3 = await SessionRelay({ directory: dir, client: { ...c2, tui: { showToast: async (t) => toasts3.push(t) } } });
  await hooks3["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@relay leave" }] });
  const st = await state(dir);
  ok("B3 leave 后 sessionChain 已删", !st.sessionChain["S"]);
  ok("B3 leave 后 chains[].sessions 已移除", Object.values(st.chains).every((c) => !(c.sessions || []).includes("S")));
}

// ============ C. 通用性/去硬编码/错误toast ============
section("C. 去硬编码 + 跨平台 + 错误toast");

{
  ok("C1 index.js 无硬编码 E:\\dev\\AGENTS.md", !src.includes("E:\\\\dev"));
  ok("C1 用 join() 而非写死反斜杠拼接 docPath", /join\(justify\(directory\)/.test(src) && /\\\$/.test(src) === false);
}

{
  // 错误 toast：Phase B 建会话失败 → 文书已完成但降级告警
  const dir = await fresh();
  const { client, toasts } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "下一棒" }] });
  client.session.create = async () => { throw new Error("boom"); };
  await completeDocThenSentinel(dir, "S");
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: `${RELAY_SENTINEL} 交接语` }] });
  ok("C2 Phase B 建会话失败 → 降级toast出现", toasts.some((t) => (t.title || "").includes("降级")));
}

// ============ D. 状态机多跳（两阶段：@relay handoff） ============
section("D. 链内多跳 docs 递增 + used 不重复");

{
  const dir = await fresh();
  const { client } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "S1" }, { parts: [{ type: "text", text: "进入接力模式" }] });
  const cid = (await state(dir)).sessionChain["S1"];
  // S1 @relay handoff 触发 Phase A
  await hooks["chat.message"]({ sessionID: "S1" }, { parts: [{ type: "text", text: "@relay handoff" }] });
  let st = await state(dir);
  ok("D1 第一跳 Phase A docs=1", st.chains[cid].docs.length === 1);
  ok("D1 pending 已挂起 S1", !!st.pendingHandoffs["S1"]);
  // 写成品+哨兵 → Phase B 完成第一跳（used 标记 S1）
  await completeDocThenSentinel(dir, "S1");
  await hooks["chat.message"]({ sessionID: "S1" }, { parts: [{ type: "text", text: `${RELAY_SENTINEL} 交接语` }] });
  st = await state(dir);
  ok("D1 used 已记 S1", st.chains[cid].used.includes("S1"));
  ok("D1 pending S1 已清", !st.pendingHandoffs["S1"]);
  // 新会话 S2 带链 token 归链
  await hooks["chat.message"]({ sessionID: "S2" }, { parts: [{ type: "text", text: `链标识：${cid}。继续任务。` }] });
  st = await state(dir);
  ok("D2 S2 归入同链", st.sessionChain["S2"] === cid);
  // S2 @relay handoff → Phase A 第二跳 docs=2
  await hooks["chat.message"]({ sessionID: "S2" }, { parts: [{ type: "text", text: "@relay handoff" }] });
  st = await state(dir);
  ok("D3 第二跳 Phase A docs=2", st.chains[cid].docs.length === 2);
  ok("D3 pending S2 已挂起", !!st.pendingHandoffs["S2"]);
}

// ============ E. 本次 bug 回归：骨架落盘 ============
section("E. R1+R3 修复回归（骨架落盘）");

{
  // E1: @relay handoff → Phase A 自落盘骨架（文件真实存在，不建会话）
  const dir = await fresh();
  const { client, calls, toasts } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "进入接力模式" }] });
  const cid = (await state(dir)).sessionChain["S"];
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "@relay handoff" }] });
  const st = await state(dir);
  const docPath = st.chains[cid].docs[0];
  ok("E1 Phase A 未建会话(create=0)", calls.create === 0);
  ok("E1 交接文书已真实落盘(文件存在)", existsSync(docPath));
  ok("E1 骨架内容含链标识", readFileSync(docPath, "utf8").includes(cid));
}

// ============ F. system.transform 条件注入 ============
section("F. system.transform 条件注入（仅 pending 存在时注入）");

{
  const dir = await fresh();
  const c = makeClient();
  const hooks = await SessionRelay({ directory: dir, client: c.client });

  // F1 无 pending → 不注入（未归链也不注入，与压缩无关）
  const o1 = { system: ["base"] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "FREE" }, o1);
  ok("F1 无 pending 未归链→不注入", o1.system.length === 1);

  // F2 无 sessionID → 不注入
  const o2 = { system: ["base"] };
  await hooks["experimental.chat.system.transform"]({}, o2);
  ok("F2 无 sessionID 不注入", o2.system.length === 1);

  // F3 system 非数组 → 不注入
  const o3 = { system: "not-array" };
  await hooks["experimental.chat.system.transform"]({ sessionID: "X" }, o3);
  ok("F3 system 非数组不注入(不抛错)", true);

  // F4 有 pending → 注入写文书指令（无论是否归链）
  await hooks["chat.message"]({ sessionID: "S" }, { parts: [{ type: "text", text: "下一棒" }] });
  const st = await state(dir);
  const dp = st.pendingHandoffs["S"].docPath;
  const o4 = { system: ["base"] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "S" }, o4);
  ok("F4 有 pending → 注入写文书指令", o4.system.length === 2);
  ok("F4 指令含 docPath", o4.system[1].includes(dp));
  ok("F4 指令含 Write 工具提示", o4.system[1].includes("Write"));

  // F5 无 pending 归链 → 不注入（先落盘清除，再重新加载 hooks 读磁盘）
  let stF5 = await state(dir);
  delete stF5.pendingHandoffs["S"];
  writeFileSync(join(dir, "handoff", ".relay-state.json"), JSON.stringify(stF5, null, 2), "utf8");
  const hooks2 = await SessionRelay({ directory: dir, client: c.client });
  const o5 = { system: ["base"] };
  await hooks2["experimental.chat.system.transform"]({ sessionID: "S" }, o5);
  ok("F5 无 pending 归链→不注入", o5.system.length === 1);
}

// ============ G. @relay verify 自检命令 ============
section("G. @relay verify 自检（修复后签名 create+prompt+读回）");

{
  const dir = await fresh();
  let listCalls = 0;
  const client = {
    tui: { showToast: async () => {} },
    session: {
      create: async (opts) => {
        ok("G1 verify create 用 body.title 顶层会话(无 parentID)", opts && opts.body && typeof opts.body.title === "string" && opts.body.parentID === undefined && opts.path === undefined);
        return { data: { id: "ses_verify_1" } };
      },
      prompt: async (arg) => {
        ok("G2 verify prompt 用 path.id + body.parts 且无 noReply",
          arg && arg.path && arg.path.id === "ses_verify_1" && arg.path.sessionID === undefined &&
          arg.body && Array.isArray(arg.body.parts) && arg.body.parts[0].type === "text" &&
          arg.body.noReply === undefined);
      },
      messages: async (input) => {
        listCalls++;
        ok("G3 verify messages 会话方法 path.id (SDK hey-api)", input && input.path && input.path.id === "ses_verify_1");
        if (listCalls >= 2) {
          return { data: [{ role: "user" }, { role: "assistant" }] };
        }
        return { data: [{ role: "user" }] };
      },
    },
  };
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "V" }, { parts: [{ type: "text", text: "@relay verify" }] });
  const rep = JSON.parse(readFileSync(join(dir, "handoff", "verify-result.json"), "utf8"));
  ok("G4 verify 检测到执行(executed=true)", rep.executed === true);
  ok("G5 verify 消息角色含 assistant", Array.isArray(rep.msgs) && rep.msgs.includes("assistant"));
}

// ============ H. @relay handoff 手动交接命令（两阶段） ============
section("H. @relay handoff 手动两阶段交接");

{
  const dir = await fresh();
  const { client, calls, toasts } = makeClient();
  const hooks = await SessionRelay({ directory: dir, client });
  // H1 未归链会话 → @relay handoff Phase A 建链 + 准备文书（不立即建会话）
  await hooks["chat.message"]({ sessionID: "H1" }, { parts: [{ type: "text", text: "@relay handoff" }] });
  let st = await state(dir);
  const cid = st.sessionChain["H1"];
  ok("H1 未归链会话 handoff 自动建链", !!cid);
  ok("H1 Phase A 未建会话(create=0)", calls.create === 0);
  ok("H1 docs 递增为 1", st.chains[cid].docs.length === 1);
  ok("H1 文书已落盘(骨架)", existsSync(st.chains[cid].docs[0]));
  ok("H1 pending 已挂起", !!st.pendingHandoffs["H1"]);
  // H2 已归链会话 → 复用原链再 preparation（docs=2），仍未建会话
  await hooks["chat.message"]({ sessionID: "H1" }, { parts: [{ type: "text", text: "@relay handoff" }] });
  st = await state(dir);
  ok("H2 归链会话 handoff 复用链 docs=2", st.chains[cid].docs.length === 2);
  ok("H2 Phase A 仍未建会话(create=0)", calls.create === 0);
  // H3 写成品 → 哨兵 → Phase B 建会话
  await completeDocThenSentinel(dir, "H1", "手工写完成品交接内容：项目=E:\\dev\\func-projs\\session-relay\n【先读文书再动手】");
  await hooks["chat.message"]({ sessionID: "H1" }, { parts: [{ type: "text", text: `${RELAY_SENTINEL}\n项目：E:\\dev\\func-projs\\session-relay\n任务：xxx\n【先读文书再动手】` }] });
  ok("H3 Phase B create 调用1次", calls.create === 1);
  ok("H3 弹「自动接力已创建」", toasts.some((t) => (t.title || "").includes("自动接力已创建")));
}

// ============ I. 会话标题不可读→回退 cid（Phase B 建会话标题） ============
section("I. 标题读取失败/空→文书基名回退 cid");

{
  // I1: session.get 失败 → Phase A 基名回退 cid；Phase B create 标题 = [接力] cid → N
  const dir = await fresh();
  const { client, calls, toasts } = makeClient({ failGet: true });
  const hooks = await SessionRelay({ directory: dir, client });
  await hooks["chat.message"]({ sessionID: "I1" }, { parts: [{ type: "text", text: "下一棒" }] });
  const cid = (await state(dir)).sessionChain["I1"];
  const stA = await state(dir);
  const dp = stA.chains[cid].docs[0];
  ok("I1 Phase A docPath 基名回退 cid(含cid且非会话标题)", dp.includes(cid) && dp.includes("原始会话X") === false);
  await completeDocThenSentinel(dir, "I1");
  await hooks["chat.message"]({ sessionID: "I1" }, { parts: [{ type: "text", text: `${RELAY_SENTINEL} 交接语` }] });
  ok("I1 Phase B create 标题回退格式 [接力]{cid}[N棒](读失败)", calls.createArgs[0] && calls.createArgs[0].body.title === `[接力]${cid}[1棒]`);

  // I2: 原始标题已含 [1棒] 后缀（第 2 棒会话）→ 剥离旧后缀防叠加，得 [接力]某任务[2棒]
  const dir2 = await fresh();
  const cid2 = "SR-deadbeef";
  mkdirSync(join(dir2, "handoff", cid2), { recursive: true });
  writeFileSync(join(dir2, "handoff", cid2, "某任务-20260827-交接-1.md"), "# 第一份成品", "utf8");
  writeFileSync(join(dir2, "handoff", ".relay-state.json"), JSON.stringify({
    chains: { [cid2]: { docs: [join("handoff", cid2, "某任务-20260827-交接-1.md")], sessions: ["P1"], used: [] } },
    sessionChain: { I2: cid2 }, pendingHandoffs: {},
  }, null, 2), "utf8");
  const { client: c2, calls: calls2 } = makeClient({ title: "某任务[1棒]" });
  const hooks2 = await SessionRelay({ directory: dir2, client: c2 });
  await hooks2["chat.message"]({ sessionID: "I2" }, { parts: [{ type: "text", text: "下一棒" }] });
  await completeDocThenSentinel(dir2, "I2");
  await hooks2["chat.message"]({ sessionID: "I2" }, { parts: [{ type: "text", text: `${RELAY_SENTINEL} 交接语` }] });
  ok("I2 标题已含 [1棒] → 剥离旧后缀 + [2棒] 不叠加", calls2.createArgs[0] && calls2.createArgs[0].body.title === "[接力]某任务[2棒]");
  ok("I2 Phase A docPath 在 handoff/{cid}/ 子目录", (await state(dir2)).chains[cid2].docs[1].includes(join("handoff", cid2)));

  // I3: 标题累积了多次 [接力][接力]/[接力5] 前缀 → 全部剥离
  const dir3 = await fresh();
  const cid3 = "SR-cafe01";
  mkdirSync(join(dir3, "handoff", cid3), { recursive: true });
  writeFileSync(join(dir3, "handoff", cid3, "某任务-20260827-交接-1.md"), "# 第一份成品", "utf8");
  writeFileSync(join(dir3, "handoff", ".relay-state.json"), JSON.stringify({
    chains: { [cid3]: { docs: [join("handoff", cid3, "某任务-20260827-交接-1.md")], sessions: ["P1"], used: [] } },
    sessionChain: { I3: cid3 }, pendingHandoffs: {},
  }, null, 2), "utf8");
  const { client: c3, calls: calls3 } = makeClient({ title: "[接力][接力]某任务[接力5][1棒]" });
  const hooks3 = await SessionRelay({ directory: dir3, client: c3 });
  await hooks3["chat.message"]({ sessionID: "I3" }, { parts: [{ type: "text", text: "下一棒" }] });
  await completeDocThenSentinel(dir3, "I3");
  await hooks3["chat.message"]({ sessionID: "I3" }, { parts: [{ type: "text", text: `${RELAY_SENTINEL} 交接语` }] });
  ok("I3 多重 [接力][接力][接力5] → 只包一个 [接力] 不叠加", calls3.createArgs[0] && calls3.createArgs[0].body.title === "[接力]某任务[2棒]");
}

// ============ J. 与压缩彻底脱钩（compacted 事件零副作用） ============
section("J. 与压缩彻底脱钩：compacted 事件零副作用");

{
  const dir = await fresh();
  const c = makeClient();
  const hooks = await SessionRelay({ directory: dir, client: c.client });

  // 先建一个链会话，再触发压缩事件 → 压缩不应影响链/pending/任何状态
  await hooks["chat.message"]({ sessionID: "J1" }, { parts: [{ type: "text", text: "下一棒" }] });
  const toastBase = c.toasts.length; // 建链/Phase A 的 toast 基线
  const before = await state(dir);
  const hasChainBefore = !!before.sessionChain["J1"];

  await hooks.event({ event: { type: "session.compacted", properties: { sessionID: "J1" } } });
  let st = await state(dir);
  ok("J1 compacted 不写 counts（无压缩计数残留）", st.counts === undefined);
  ok("J1 compacted 不建链", hasChainBefore === false ? !st.sessionChain["J1"] : st.sessionChain["J1"] === before.sessionChain["J1"]);
  ok("J1 compacted 不改 pending（接力挂起不受压缩影响）", JSON.stringify(st.pendingHandoffs) === JSON.stringify(before.pendingHandoffs));
  ok("J1 compacted 不改 chains 内容", JSON.stringify(st.chains) === JSON.stringify(before.chains));
  ok("J1 compacted 不弹任何新 toast（压缩零干预）", c.toasts.length === toastBase);
  // 再触发一次 → 状态文件完全不变（无累计副作用）
  await hooks.event({ event: { type: "session.compacted", properties: { sessionID: "J1" } } });
  const st2 = await state(dir);
  ok("J2 二次 compacted 状态零变化（彻底无副作用）", JSON.stringify(st2) === JSON.stringify(st));
}

{
  // J3: 未归链会话 compacted → 插件完全静默：不建链、不挂 pending、甚至不写状态文件、零 toast
  const dir = await fresh();
  const c = makeClient();
  const hooks = await SessionRelay({ directory: dir, client: c.client });
  await hooks.event({ event: { type: "session.compacted", properties: { sessionID: "FREE" } } });
  ok("J3 未归链 compacted → 状态文件都未创建（零副作用）", !existsSync(join(dir, "handoff", ".relay-state.json")));
  ok("J3 未归链 compacted → 零 toast", c.toasts.length === 0);
}

{
  // J4: 源码级断言——不注册 compacting/compacted 处理钩子，无 counts/reminded 逻辑残留
  const srcCheck = readFileSync(pluginPath, "utf8");
  ok("J4 源码无 experimental.session.compacting 注册", srcCheck.includes("experimental.session.compacting") === false);
  ok("J4 源码 event 钩子无 session.compacted 处理", /session\.compacted/.test(srcCheck) === false);
  ok("J4 源码无 counts 字段残留", /counts\s*:/.test(srcCheck) === false);
  ok("J4 源码无 reminded 字段残留", /reminded/.test(srcCheck) === false);
  ok("J4 源码无「压缩模式」文本分支残留", srcCheck.includes("压缩模式") === false);
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);