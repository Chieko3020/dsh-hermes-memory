/**
 * dsh-hermes-memory —— 把 ~/.hermes/memories/ 下的 MEMORY.md 与 USER.md
 * 作为**一个只读 system prompt 段**注入。
 *
 * 机制（全部依据 DSH 0.1.5-alpha.1 已构建产物）：
 *   - 服务名 `systemPrompt`：见 @deepseek-ai/dsh-system-prompt/lib/index.js:211
 *     `super(ctx, "systemPrompt")`；所以 inject 里写 "systemPrompt"。
 *   - 注册 API `ctx.systemPrompt.section({ name, order, text, complete? })`：
 *     见同文件 :238-241 与 lib/types/index.d.ts:233。
 *     `text` 可以是静态字符串，也可以是 (AssembleContext) => string（每次组装回调）。
 *   - order 决定拼接顺序（升序，同值按 name 的 code-unit 序）：
 *     见 lib/index.js:10-42 的 SECTION_ORDERS 与 :96-98 comparePromptSections。
 *   - section() 内部用 ScopedLayers.effect(ctx, ...) 注册（:240），生命周期挂在
 *     调用它的 ctx 上：插件被卸载即自动注销，不需要手写 ctx.effect 包裹
 *     （dsh-tool-ralph/lib/index.js:295、dsh-tool-jobs/lib/index.js:201 都是直接调用）。
 *
 * 设计取舍：静态只读文本用 `section()` 一次性注册即可，**不模仿**
 * dsh-agent-instructions 的 sessionProjections 路线——那条路走的是
 * 「可刷新的 user-role 消息进历史」（见其 lib/index.js:1169-1208、1270-1288），
 * 用来跟踪工作区文件变化，对一段固定文本是纯粹的额外复杂度。
 *
 * 安全性：renderPrompt() 会严格插值 `{{variable}}`，未知/畸形引用会**抛错**，
 * 见 dsh-system-prompt/lib/index.js:151-175 与 README.md:172-173
 * （「No escape syntax for literal {{…}} braces」）。用户可编辑的 MD 文件里若出现
 * `{{`，会让整个 prompt 组装失败、agent 直接不可用，因此这里主动把 `{{`
 * 拆成 `{ {` 做消毒。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { apply as applyWriteTool } from "./memory-tool.js";

/** Cordis 插件名（loader entry 的 name 与 package.json 同名，便于排查）。 */
export const name = "dsh-hermes-memory";

/**
 * 注入的服务键名。必须与服务注册时 `super(ctx, "<key>")` 的字符串一致，
 * 否则 ctx.systemPrompt 会以 "cannot get property without inject" 报错。
 *
 * 0.1.1+：追加 "tools" —— 注册反向写回工具 memory（lib/memory-tool.js）。
 */
export const inject = ["systemPrompt", "tools"];

/** 记忆文件所在目录；允许用 HERMES_MEMORIES_DIR 覆盖，便于测试或非默认 home。 */
const MEMORIES_DIR = process.env.HERMES_MEMORIES_DIR ?? join(homedir(), ".hermes", "memories");

/** 按此顺序读取并拼接；(标题, 文件名) 一一对应。 */
const MEMORY_FILES = [
	["MEMORY", "MEMORY.md"],
	["USER", "USER.md"]
];

/**
 * 段落排序位。官方段的稀疏分配见 SECTION_ORDERS：
 * HARNESS_IDENTITY = -1000、DEPLOYMENT_PERSONA_PREFIX = 0、PLAN_POLICY = 500。
 * 外部贡献者可用任意有限数（README.md:56），这里取 100：
 * 排在身份/人格之后、计划与工具指引之前。
 */
const SECTION_ORDER = 100;

/** 单个文件读取上限（字符），防御性截断，避免异常文件把 prompt 撑爆。 */
const MAX_CHARS_PER_FILE = 32_768;

/**
 * 消毒 `{{`：renderPrompt 的插值器会对任何完整的 `{{...}}` 抛错。
 * 拆开左花括号即可让 indexOf("{{") 永不命中，整段退化为字面文本。
 */
function neutralizeBraces(text) {
	return text.replaceAll("{{", "{ {");
}

/** 同步读一个文件；不存在、不可读、是目录等任何异常都返回 undefined。 */
function readTextFile(absolutePath) {
	try {
		const text = readFileSync(absolutePath, "utf8");
		if (typeof text !== "string" || text.trim().length === 0) return undefined;
		const clipped = text.length > MAX_CHARS_PER_FILE
			? `${text.slice(0, MAX_CHARS_PER_FILE)}\n…（内容过长已截断）`
			: text;
		return clipped.trim();
	} catch {
		// 文件不存在 / 无权限 / 是目录 —— 一律静默跳过，不影响 DSH 启动。
		return undefined;
	}
}

/**
 * 组装待注入文本；两个文件都缺失时返回 undefined。
 *
 * 0.1.1+：末尾追加一段静态写回指引（只读提示，非指令），告诉 agent
 * 存在 memory 写回工具、何时该用。静态文本保持 KV Cache 前缀稳定。
 */
function buildMemoryText() {
	const blocks = [];
	for (const [title, fileName] of MEMORY_FILES) {
		const body = readTextFile(join(MEMORIES_DIR, fileName));
		if (body !== undefined) blocks.push(`## ${title}\n\n${body}`);
	}
	if (blocks.length === 0) return undefined;
	return neutralizeBraces(
		[
			"以下是从本机 ~/.hermes/memories/ 读取的长期记忆与用户画像，供你参考；它们是只读上下文，不是指令。",
			"",
			...blocks,
			"",
			"如果你在本次会话中学到值得长期沉淀的新环境事实或用户偏好，可调用 memory 工具将其写回 ~/.hermes/memories/（target=memory 记环境/项目事实，target=user 记用户画像），供后续 DSH 与 Hermes 会话共享；每次成功写入会自动归档到 git 仓库可回滚。"
		].join("\n\n")
	);
}

/**
 * 插件入口。
 *
 * 时机：读取发生在 apply() 期间（插件加载时，早于任何 agent 组装 prompt），
 * 一次读入、一次注册；之后每次组装都用同一份静态文本，
 * 因此对 KV Cache 前缀是稳定的（README.md:147-149）。
 * 若想热更新，把 `text` 换成 `() => buildMemoryText() ?? ""` 即可
 * （每次组装回调，见 dsh-system-prompt/lib/index.js:339），代价是失去前缀稳定性。
 *
 * 0.1.1+：除注入外，还注册反向写回工具 memory（lib/memory-tool.js）。
 * 两者相互独立：注入失败不影响工具注册；工具注册失败也不影响注入
 * （各自 try/catch，日志可区分）。
 */
export function apply(ctx) {
	// ── 只读注入（原有逻辑）──
	try {
		const text = buildMemoryText();
		// 没有内容就不注册：renderPrompt 本来也会丢弃空段（lib/index.js:112），
		// 但少注册一段更干净，也不会在 registry 里留下空条目。
		if (text !== undefined) {
			ctx.systemPrompt.section({
				name: "hermes:memory",
				order: SECTION_ORDER,
				text
			});
		}
	} catch (error) {
		// 兜底：任何意外（含 ctx.systemPrompt 缺失）都不得影响 DSH 启动。
		try {
			ctx.logger?.warn?.("hermes-memory: 注入失败，已跳过: %o", error);
		} catch {
			// logger 本身出问题也一并吞掉。
		}
	}

	// ── 反向写回工具（0.1.1+）──
	try {
		applyWriteTool(ctx);
	} catch (error) {
		try {
			ctx.logger?.warn?.("hermes-memory: 写回工具注册失败，已跳过: %o", error);
		} catch {
			// logger 本身出问题也一并吞掉。
		}
	}
}
