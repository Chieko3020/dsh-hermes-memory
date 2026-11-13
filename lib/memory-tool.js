/**
 * memory — DSH → Hermes 反向写回工具。
 *
 * 把值得沉淀的环境事实 / 用户偏好写入 ~/.hermes/memories/{MEMORY.md,USER.md}，
 * 供 Hermes 与后续 DSH 会话共享。语义与 Hermes 内置 memory 工具逐条兼容
 * （§ 分隔、flock 锁、drift 保护、容量上限、威胁扫描、batch 原子性），
 * 写盘实际由同目录的 memory_store.py（spawn python3）执行，协议 100% 对齐。
 *
 * 写成功后，把 MEMORY.md / USER.md 归档到 ~/Dev/hermes-memories/ 并 git commit，
 * 作为任意历史版本的回滚网（该目录是独立 git 仓库，真实记忆文件不移动）。
 */

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { defineTool } from "@deepseek-ai/dsh-tools";

/** 本工具名（与 Hermes 同名，方便 agent 记忆）。 */
export const toolName = "memory";

/** memory_store.py 绝对路径（与插件同目录）。 */
const STORE_SCRIPT = fileURLToPath(new URL("./memory_store.py", import.meta.url));

/** 归档 git 仓库目录：真实文件复制到这里并 commit（可被 HERMES_MEMORY_ARCHIVE_DIR 覆盖用于测试）。
 *  用 os.homedir() 而非 process.env.HOME —— 后者在 Windows 上未定义（2026-10-13 跨平台修复）。 */
const ARCHIVE_DIR = process.env.HERMES_MEMORY_ARCHIVE_DIR ?? join(homedir(), "Dev", "hermes-memories");

/** 记忆文件真实位置（与注入侧同源；可被 HERMES_MEMORIES_DIR 覆盖用于测试）。 */
const MEMORIES_DIR = process.env.HERMES_MEMORIES_DIR ?? join(homedir(), ".hermes", "memories");

const MEMORY_FILES = {
	memory: "MEMORY.md",
	user: "USER.md"
};

/**
 * 定位一个可用的 Python 解释器。
 *
 * 为什么不写死 "python3"：Windows 上 `python` 常被 uv/pyenv 的 trampoline 占用
 * （实测报 "uv trampoline failed to spawn Python child process"），而 `python3`
 * 往往是 Microsoft Store 的占位 stub（执行无输出）。Desktop 版 DSH 自带
 * primary-runtime/dependencies/python/python.exe，优先用它；其次 `py` launcher。
 * 解析结果缓存，只探测一次（2026-10-13 Windows 落地）。
 */
let pythonCommand;
async function resolvePython() {
	if (pythonCommand !== undefined) return pythonCommand;

	const candidates = [];
	if (process.env.DSH_PYTHON) candidates.push(process.env.DSH_PYTHON);

	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
		const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
		const appDirSuffix = join("resources", "runtime", "primary-runtime", "dependencies", "python", "python.exe");
		// 桌面版 DSH 自带的解释器（随应用升级，故按候选探测而非固定缓存路径）
		const appDirs = [
			process.env.DSH_DESKTOP_DIR,                        // 显式指定优先
			join(localAppData, "Programs", "DeepSeek Harness"), // 默认安装位置
			join(programFiles, "DeepSeek Harness"),             // 系统级安装位置
		].filter(Boolean);
		for (const appDir of appDirs) candidates.push(join(appDir, appDirSuffix));
		candidates.push("py", "python", "python3");
	} else {
		candidates.push("python3", "python");
	}

	for (const candidate of candidates) {
		try {
			const probe = spawnSync(candidate, ["--version"], { timeout: 8000, encoding: "utf8" });
			if (probe.status === 0 && /Python\s+\d/u.test(`${probe.stdout ?? ""}${probe.stderr ?? ""}`)) {
				pythonCommand = candidate;
				return candidate;
			}
		} catch {
			// 候选不可用，继续尝试下一个
		}
	}

	// 都不行时退回平台默认名，让 spawn 抛出真实错误（错误信息会回给工具调用方）
	pythonCommand = process.platform === "win32" ? "python" : "python3";
	return pythonCommand;
}

/** 执行一次写盘（spawn 已解析到的 python）。stdin 传 JSON，stdout 收 JSON。 */
async function runStore(request) {
	const python = await resolvePython();
	return new Promise((resolve, reject) => {
		const child = spawn(python, [STORE_SCRIPT], {
			env: { ...process.env, HERMES_MEMORIES_DIR: MEMORIES_DIR }
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`memory_store.py exited ${code}: ${stderr.slice(0, 500)}`));
				return;
			}
			try {
				resolve(JSON.parse(stdout));
			} catch (err) {
				reject(new Error(`memory_store.py returned invalid JSON: ${stdout.slice(0, 500)}`));
			}
		});
		child.stdin.end(JSON.stringify(request));
	});
}

/**
 * 写盘成功后归档到 git 仓库。返回 {archived, commit} 或 {archived:false, reason}。
 * 归档是尽力而为：失败不阻断工具结果（写盘已落盘），但会把 reason 带回提示。
 */
async function archive(target, note) {
	try {
		if (!existsSync(ARCHIVE_DIR)) return { archived: false, reason: `archive dir missing: ${ARCHIVE_DIR}` };
		const src = join(MEMORIES_DIR, MEMORY_FILES[target]);
		if (!existsSync(src)) return { archived: false, reason: `source missing: ${src}` };
		copyFileSync(src, join(ARCHIVE_DIR, MEMORY_FILES[target]));
		const commitMsg = `memory: ${target} — ${(note || "").trim() || "update"}`.slice(0, 200);
		const result = await runGit(["add", "-A"], ARCHIVE_DIR);
		if (result.code !== 0 && result.stderr && !/nothing to commit/.test(result.stderr)) {
			return { archived: false, reason: `git add failed: ${result.stderr.slice(0, 200)}` };
		}
		const commit = await runGit(["commit", "-m", commitMsg], ARCHIVE_DIR);
		// "nothing to commit"（无实际变更）不算失败——幂等调用后的正常情况。
		if (commit.code !== 0 && !/nothing to commit|no changes added/.test(commit.stderr)) {
			return { archived: false, reason: `git commit failed: ${commit.stderr.slice(0, 200)}` };
		}
		const hashMatch = /\[[^\]]+ ([0-9a-f]{7,})/.exec(commit.stdout || "");
		return { archived: true, commit: hashMatch ? hashMatch[1] : "committed" };
	} catch (err) {
		return { archived: false, reason: `archive error: ${String(err).slice(0, 200)}` };
	}
}

/** 在指定 cwd 跑一条 git 命令。 */
function runGit(args, cwd) {
	return new Promise((resolve) => {
		const child = spawn("git", args, { cwd });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

const DESCRIPTION = `Write a durable note into the shared Hermes memory (MEMORY.md or USER.md) that will be injected into future DSH and Hermes sessions.

Use this when you learn something worth remembering across sessions: environment facts, project conventions, tool quirks, deployment topology, or a durable user preference. Skip trivial/obvious info, easily re-discovered facts, raw data dumps, task progress, completed-work logs, and temporary TODO state (reuse session history for those). Reusable procedures belong in a skill, not memory.

TARGETS: 'user' = who the user is (name, role, preferences, style). 'memory' = your notes (environment, conventions, tool quirks, lessons).

IF FULL: an add is rejected with the current entries shown. Reissue as ONE batch that removes or shortens enough stale entries and adds the new one together.

Each successful write is archived to a git repo (~/Dev/hermes-memories/) so any version is recoverable.`;

export function apply(ctx) {
	ctx.tools.register(defineTool({
		name: toolName,
		description: DESCRIPTION,
		parameters: {
			target: {
				type: "string",
				required: true,
				enum: ["memory", "user"],
				description: "Which memory store: 'memory' for personal notes, 'user' for user profile."
			},
			action: {
				type: "string",
				enum: ["add", "replace", "remove"],
				description: "The action to perform (single-op shape). Omit when using 'operations'."
			},
			content: {
				type: "string",
				description: "The entry content. Required for 'add' and 'replace' (single-op shape)."
			},
			old_text: {
				type: "string",
				description: "REQUIRED for 'replace' and 'remove' (single-op shape): a short unique substring identifying the existing entry to modify. Omit only for 'add'."
			},
			operations: {
				type: "array",
				description: "Batch shape: a list of operations applied atomically in one call against the final char budget. Preferred when making multiple changes or consolidating to make room. Each item is {action, content?, old_text?}.",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						action: { type: "string", required: true, enum: ["add", "replace", "remove"] },
						content: { type: "string", description: "Entry content for add/replace." },
						old_text: { type: "string", description: "Substring identifying the entry for replace/remove." }
					}
				}
			},
			note: {
				type: "string",
				description: "Optional human-readable note used as the git commit message for the archive. Not written into the memory file."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					success: { type: "boolean", required: true },
					done: { type: "boolean" },
					target: { type: "string" },
					usage: { type: "string" },
					entry_count: { type: "number" },
					message: { type: "string" },
					note: { type: "string" },
					error: { type: "string" },
					current_entries: { type: "array", items: { type: "string" } },
					usage_info: { type: "string" },
					drift_backup: { type: "string" },
					archived: { type: "boolean" },
					commit: { type: "string" },
					archive_reason: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		async execute(args, exec) {
			const target = args.target ?? "memory";
			const note = typeof args.note === "string" ? args.note : "";

			let result;
			if (Array.isArray(args.operations)) {
				result = await runStore({ target, operations: args.operations });
			} else {
				result = await runStore({
					target,
					action: args.action ?? "",
					content: typeof args.content === "string" ? args.content : undefined,
					old_text: typeof args.old_text === "string" ? args.old_text : undefined
				});
			}

			// 写盘成功才归档；归档失败不改变写盘结果，只附加提示字段。
			if (result && result.success) {
				const ar = await archive(target, note);
				result.archived = ar.archived;
				if (ar.commit) result.commit = ar.commit;
				if (!ar.archived) result.archive_reason = ar.reason;
			}
			return result;
		}
	}));
}

export const name = "hermes-memory-write";
export const inject = ["tools"];
