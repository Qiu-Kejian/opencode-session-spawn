import { tool } from "@opencode-ai/plugin/tool";

/**
 * session-spawn —— 会话生成原语（v2.4.0，2026-09-15 起：父链接走 metadata + 可选 model + 创建后选中新会话）
 *
 * 只做两件事：
 *   1. 创建一个新的顶层会话，并把起始语句注入为该会话首条消息。
 *      create: client.session.create({ body: { title, metadata?, model? }, query: { directory } })
 *      inject: client.session.promptAsync({ path: { id }, body: { agent, parts: [{ type: "text", text }] } })
 *      select: client.tui.selectSession({ sessionID })（可选，默认开；回退 tui.publish 事件）
 *      （agent / directory / model 均可选，仅在显式传入且非空白时透传；不做校验，交服务端）
 *   2. 子会话向父会话注入一条 [relay] 消息并唤醒它（工具 notify_parent；仅父会话，无任意会话注入）。
 *
 * 设计约束（用户定稿）：
 *   - 插件只负责「建会话 + 注入语句 + 父会话通知」，不落文书、不读文书、不追踪链、无状态文件。
 *   - 编排中若需交接文书，由调用方把「读取文书路径」等引导写进起始语句即可（与其他工具天然兼容）。
 *   - 优先 promptAsync（异步 fire-and-forget，不阻塞父会话）；缺失则回退同步 prompt。
 *   - 两个入口共用同一 spawn()：① 工具 spawn_session（模型自主触发，打通无人值守）
 *                                        ② 命令 @spawn / @relay spawn（人工触发）。
 *   - **父链接写入会话 metadata（`spawnParentID`），不写 `parentID`**：桌面端会话列表只拉取顶层会话，
 *     写 parentID 会让派发会话变成「子会话」而从列表消失（v2.2.0 的可见性回归）；metadata 不影响列表，
 *     notify_parent 沿 `metadata.spawnParentID` 上行，并兼容旧会话的 `parentID` 回退。
 *   - **创建后默认让 UI 选中新会话**（`tui.selectSession`，失败忽略、不阻塞返回）：TUI 即时生效；
 *     桌面端 app 尚未消费该事件（上游 issue #45963），当前为 no-op，接线后自动开 tab。
 *
 * 历史：本仓库前身 session-relay 的接力链、两阶段文书、空闲事件驱动、哨兵等机制已全部移除。
 */

// 标题清洗：首行 → 去 Windows 非法字符与控制符 → 截断 60；空则回退 "spawn"。
function defaultTitle(prompt) {
  return (
    String(prompt || "")
      .split(/\r?\n/)[0]
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .trim()
      .slice(0, 60) || "spawn"
  );
}

function userText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join(" ");
}

// 可选参数透传判定：空串 / 纯空白视为未传（返回 undefined）。
function nonEmpty(v) {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

// 解析 "provider/model" → { providerID, id }；空 / 无 "/" / 缺段 → undefined（视为未传）。
function parseModel(v) {
  const s = nonEmpty(v);
  if (s === undefined) return undefined;
  const i = s.indexOf("/");
  if (i <= 0 || i >= s.length - 1) return undefined;
  return { providerID: s.slice(0, i), id: s.slice(i + 1) };
}

const SPAWN_USAGE = "用法：@spawn [--agent <名称>] [--title <标题>] [--no-select] <起始语句>";

// 解析人工命令：@spawn / @relay spawn，支持前导 --agent / --title / --no-select。
// 返回 null（非 spawn 命令）或 { prompt, agent, title, select } / { error, flag?, agent?, title? }。
// 规则：仅解析命令后前导的 flag；--agent/--title 值为单个空白分隔 token；--no-select 为布尔开关；剩余内容原样作为起始语句。
function parseSpawnCommand(text) {
  const m = /^\s*@(?:relay\s+)?spawn\b([\s\S]*)$/i.exec(String(text || ""));
  if (!m) return null;

  let rest = m[1];
  let agent;
  let title;
  let select = true;
  while (true) {
    const bm = /^\s*--no-select(?=\s|$)/.exec(rest);
    if (bm) {
      rest = rest.slice(bm[0].length);
      select = false;
      continue;
    }
    const fm = /^\s*(--agent|--title)(?=\s|$)/.exec(rest);
    if (!fm) break;
    rest = rest.slice(fm[0].length);
    const vm = /^\s+(\S+)/.exec(rest);
    const value = vm && vm[1];
    if (!value || value.startsWith("--")) {
      return { error: "missing-value", flag: fm[1], agent, title };
    }
    rest = rest.slice(vm[0].length);
    if (fm[1] === "--agent") agent = value;
    else title = value;
  }

  const prompt = rest.trim();
  if (!prompt) return { error: "empty-prompt", agent, title };
  return { prompt, agent, title, select };
}

export const SessionSpawn = async (ctx) => {
  const { client } = ctx;

  const notify = async (title, message, variant = "info") => {
    try {
      if (client && client.tui && client.tui.showToast) {
        await client.tui.showToast({ title, message, variant, duration: 15000 });
      }
    } catch (e) {
      console.error(`[session-spawn] toast 通知失败: ${e.message}`);
    }
  };

  // 创建后让 UI 选中新会话：优先 client.tui.selectSession，缺失则回退 tui.publish 事件；
  // 均不可用 / 失败 → 仅记录，不影响 spawn 结果（桌面端 app 当前未消费该事件，为 no-op）。
  async function selectCreatedSession(sessionID) {
    try {
      if (client && client.tui && typeof client.tui.selectSession === "function") {
        await client.tui.selectSession({ sessionID });
        return;
      }
      if (client && client.tui && typeof client.tui.publish === "function") {
        await client.tui.publish({ type: "tui.session.select", properties: { sessionID } });
        return;
      }
    } catch (e) {
      console.error(`[session-spawn] 选中新会话失败（忽略）: ${e.message}`);
    }
  }

  // 核心：建新会话 + 注入起始语句。
  // opts.agent / opts.directory / opts.model / opts.select / opts.parentSessionID 可选；仅非空白时透传（不做校验）。
  // 父链接写 metadata.spawnParentID（不写 parentID：保持顶层 → 会话列表可见）。
  // 返回 { id, title, injected, agent?, directory?, error? }；create 失败则抛出（未建会话）。
  async function spawn(prompt, title, opts = {}) {
    const text = typeof prompt === "string" ? prompt : "";
    if (!text.trim()) throw new Error("起始语句为空");
    if (!client || !client.session || typeof client.session.create !== "function") {
      throw new Error("client.session.create 不可用");
    }
    const t = (title && String(title).trim()) || defaultTitle(text);
    const agent = nonEmpty(opts.agent);
    const directory = nonEmpty(opts.directory);
    const parentSessionID = nonEmpty(opts.parentSessionID);
    const model = parseModel(opts.model);

    const createReq = { body: { title: t } };
    if (parentSessionID !== undefined) createReq.body.metadata = { spawnParentID: parentSessionID };
    if (model !== undefined) createReq.body.model = model;
    if (directory !== undefined) createReq.query = { directory };
    const created = await client.session.create(createReq);
    const id = created && (created.data?.id || created.id);
    if (!id) throw new Error("create 未返回会话 id");
    if (opts.select !== false) await selectCreatedSession(id);

    const body = { parts: [{ type: "text", text }] };
    if (agent !== undefined) body.agent = agent;
    const injectFn =
      typeof client.session.promptAsync === "function"
        ? client.session.promptAsync.bind(client.session)
        : typeof client.session.prompt === "function"
          ? client.session.prompt.bind(client.session)
          : null;
    if (!injectFn) {
      return { id, title: t, injected: false, agent, directory, error: "client.session.promptAsync/prompt 均不可用" };
    }

    try {
      await injectFn({ path: { id }, body });
      return { id, title: t, injected: true, agent, directory };
    } catch (e) {
      console.error(`[session-spawn] 注入失败（会话 ${id} 已建保留）: ${e.message}`);
      return { id, title: t, injected: false, agent, directory, error: e.message };
    }
  }

  return {
    // 工具：模型自主调用 → 无人值守长任务编排的最短路径。
    tool: {
      spawn_session: tool({
        description:
          "创建一个新的顶层会话并向其注入起始语句，用于无人值守长任务编排：当前会话模型在需要时自行决定把工作交给一个新会话继续。新会话会立即开始执行该起始语句；它保持顶层，会出现在会话列表中（便于人工查看），并默认让 UI 选中它（TUI 即时生效；桌面端需 app 支持，当前为 no-op）。若需让其读取某份交接文书，请把文书路径与读取要求写进 prompt。agent 可指定新会话以某 agent/模式启动（如 leader）；directory 可绑定项目目录；model 可指定模型（provider/model）。新会话可用 notify_parent 回通知本会话。",
        args: {
          prompt: tool.schema.string().describe("注入新会话的起始语句（可内含读取交接文书路径等引导）"),
          title: tool.schema.string().optional().describe("新会话标题；缺省取起始语句首行"),
          agent: tool.schema.string().optional().describe("新会话以某 agent/模式启动（如 leader）；缺省由服务端默认"),
          directory: tool.schema.string().optional().describe("新会话绑定的项目目录（绝对路径，如 D:\\dev\\bbcare）；缺省由服务端默认"),
          model: tool.schema.string().optional().describe("新会话使用的模型（provider/model，如 deepseek/deepseek-v4-flash 或 opencode/big-pickle）；缺省由服务端默认"),
          select: tool.schema.boolean().optional().describe("创建后让 UI 选中新会话（默认 true；传 false 关闭）"),
        },
        async execute(args, context) {
          try {
            const r = await spawn(args.prompt, args.title, {
              agent: args.agent,
              directory: args.directory,
              model: args.model,
              select: args.select,
              parentSessionID: context && context.sessionID,
            });
            if (!r.injected) {
              return `会话「${r.title}」(id=${r.id}) 已创建，但起始语句注入失败：${r.error}。请手动打开该会话补发指令。`;
            }
            return `已创建会话「${r.title}」(id=${r.id}) 并注入起始语句，新会话已开始执行。`;
          } catch (e) {
            return `创建会话失败：${e.message}`;
          }
        },
      }),

      // 工具：子会话反向通知父会话（沿 metadata.spawnParentID 上行，兼容 parentID；失败一律返回文本，不抛）。
      notify_parent: tool({
        description:
          "向本会话的父会话（spawn 本会话的会话）注入一条消息并唤醒它：用于子会话完成 / 受阻时通知父会话。仅能通知父会话，不支持指定任意会话；注入文本自动加 [relay] 前缀；父会话以服务端默认模式（build）被唤醒。收到通知后按需行动即可，不要自动回发通知（防环路）。",
        args: {
          text: tool.schema.string().describe("通知内容（注入父会话，自动加 [relay] 前缀）"),
        },
        async execute(args, context) {
          const text = typeof args.text === "string" ? args.text : "";
          if (!text.trim()) return "通知失败：内容为空";
          if (!client || !client.session || typeof client.session.get !== "function") {
            return "通知失败：client.session.get 不可用";
          }

          let parentID;
          try {
            const got = await client.session.get({ path: { id: context && context.sessionID } });
            const info = (got && (got.data || got)) || {};
            const meta = info.metadata || {};
            parentID = nonEmpty(meta.spawnParentID) || nonEmpty(info.parentID);
          } catch (e) {
            return `通知失败：读取会话失败（${e.message}）`;
          }
          if (!parentID) return "当前会话没有父会话，无法通知";

          const body = { parts: [{ type: "text", text: "[relay] " + text }] };
          const injectFn =
            typeof client.session.promptAsync === "function"
              ? client.session.promptAsync.bind(client.session)
              : typeof client.session.prompt === "function"
                ? client.session.prompt.bind(client.session)
                : null;
          if (!injectFn) return "通知失败：client.session.promptAsync/prompt 均不可用";

          try {
            await injectFn({ path: { id: parentID }, body });
          } catch (e) {
            return `通知失败：注入父会话失败（${e.message}）`;
          }
          return `已通知父会话 (id=${parentID})。`;
        },
      }),
    },

    // 人工命令：@spawn [--agent <名称>] [--title <标题>] [--no-select] <起始语句>（兼容 @relay spawn）。
    "chat.message": async ({ sessionID }, { parts }) => {
      try {
        const text = userText(parts);
        const parsed = parseSpawnCommand(text);
        if (!parsed) return;
        if (parsed.error === "missing-value") {
          await notify("spawn", `${parsed.flag} 缺少值。${SPAWN_USAGE}`, "warning");
          return;
        }
        if (parsed.error === "empty-prompt") {
          await notify("spawn", SPAWN_USAGE, "warning");
          return;
        }
        try {
          const r = await spawn(parsed.prompt, parsed.title, { agent: parsed.agent, select: parsed.select });
          if (!r.injected) {
            await notify("spawn", `会话「${r.title}」(id=${r.id}) 已创建，但注入失败：${r.error}`, "warning");
          } else {
            await notify("spawn", `已创建会话「${r.title}」(id=${r.id}) 并注入起始语句。`);
          }
        } catch (e) {
          await notify("spawn", `创建失败：${e.message}`, "error");
        }
      } catch (e) {
        console.error(`[session-spawn] chat.message 处理失败: ${e.message}`);
      }
    },
  };
};

export default SessionSpawn;
