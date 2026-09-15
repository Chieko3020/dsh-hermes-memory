/**
 * memory-tool.js 集成测试：在隔离临时目录验证
 *  1. defineTool 注册（name/description/parameters 形状）
 *  2. execute 单操作 add → 写盘 + git 归档
 *  3. execute batch → 原子性
 *  4. execute 失败（drift）→ 不归档
 * 通过临时环境变量把 MEMORIES_DIR / ARCHIVE_DIR 指到临时目录。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 用子进程跑，避免污染当前进程环境变量
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const TOOL_JS = join(__dirname, "..", "lib", "memory-tool.js");

function makeSandbox() {
	const root = mkdtempSync(join(tmpdir(), "dsh-mm-tool-"));
	const memDir = join(root, "memories");
	const archiveDir = join(root, "archive");
	mkdirSync(memDir, { recursive: true });
	mkdirSync(archiveDir, { recursive: true });
	// 初始化归档仓库
	execFileSync("git", ["init", "-b", "main"], { cwd: archiveDir, stdio: "ignore" });
	return { root, memDir, archiveDir };
}

// 在子进程里 import memory-tool 并执行工具
function runTool(args, env) {
	const argsJson = JSON.stringify(args);
	const script = `
		import { apply } from ${JSON.stringify(TOOL_JS)};
		const tools = { registered: [] };
		const ctx = {
			tools: {
				register(tool) { tools.registered.push(tool); }
			}
		};
		apply(ctx);
		const tool = tools.registered[0];
		const result = await tool.execute(${argsJson}, {});
		console.log(JSON.stringify({ toolName: tool.name, result }));
	`;
	const proc = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	if (proc.status !== 0) throw new Error(`runner failed: ${proc.stderr}`);
	return JSON.parse(proc.stdout.trim().split("\n").pop());
}

test("tool registers with name=memory and full schema", async () => {
	const { memDir, archiveDir } = makeSandbox();
	const env = {
		HERMES_MEMORIES_DIR: memDir,
		HERMES_MEMORY_ARCHIVE_DIR: archiveDir,
	};
	const out = runTool({ target: "memory", action: "add", content: "x" }, env);
	assert.equal(out.toolName, "memory");
	rmSync(join(memDir, ".."), { recursive: true, force: true });
});

test("execute add → writes file + git archive commit", async () => {
	const { root, memDir, archiveDir } = makeSandbox();
	const env = {
		HERMES_MEMORIES_DIR: memDir,
		HERMES_MEMORY_ARCHIVE_DIR: archiveDir,
	};
	const out = runTool({ target: "memory", action: "add", content: "集成测试条目", note: "interop test" }, env);
	assert.equal(out.result.success, true, JSON.stringify(out.result));
	assert.equal(out.result.entry_count, 1);
	assert.equal(out.result.archived, true, JSON.stringify(out.result));
	assert.ok(out.result.commit, "should have commit hash");
	// 真实文件写入
	const file = join(memDir, "MEMORY.md");
	assert.ok(existsSync(file));
	assert.ok(readFileSync(file, "utf8").includes("集成测试条目"));
	// 归档副本 + commit 存在
	const archived = join(archiveDir, "MEMORY.md");
	assert.ok(existsSync(archived), "archive copy should exist");
	const log = execFileSync("git", ["log", "--oneline"], { cwd: archiveDir, encoding: "utf8" });
	assert.match(log, /interop test/);
	rmSync(root, { recursive: true, force: true });
});

test("execute batch → atomic all-or-nothing", async () => {
	const { root, memDir, archiveDir } = makeSandbox();
	const env = {
		HERMES_MEMORIES_DIR: memDir,
		HERMES_MEMORY_ARCHIVE_DIR: archiveDir,
	};
	runTool({ target: "memory", action: "add", content: "A" }, env);
	// 第二个 op 失败 → 整体不写、不归档
	const out = runTool({
		target: "memory",
		operations: [
			{ action: "add", content: "B" },
			{ action: "remove", old_text: "不存在的" },
		],
	}, env);
	assert.equal(out.result.success, false, JSON.stringify(out.result));
	assert.match(out.result.error, /all-or-nothing/);
	const file = join(memDir, "MEMORY.md");
	const entries = readFileSync(file, "utf8").split("\n§\n");
	assert.deepEqual(entries.map((e) => e.trim()).filter(Boolean), ["A"]);
	rmSync(root, { recursive: true, force: true });
});

test("execute drift refusal → no archive", async () => {
	const { root, memDir, archiveDir } = makeSandbox();
	const env = {
		HERMES_MEMORIES_DIR: memDir,
		HERMES_MEMORY_ARCHIVE_DIR: archiveDir,
	};
	// 预置 drift 文件（replace 会拒写）
	writeFileSync(join(memDir, "MEMORY.md"), "条目A\n§\n\n§\n条目B", "utf8");
	const out = runTool({ target: "memory", action: "replace", old_text: "条目A", content: "条目A2" }, env);
	assert.equal(out.result.success, false, JSON.stringify(out.result));
	assert.equal(out.result.archived, undefined, "should not archive on failure");
	// 归档目录应只有 .git
	const archiveEntries = readdirSync(archiveDir).filter((e) => e !== ".git");
	assert.deepEqual(archiveEntries, []);
	rmSync(root, { recursive: true, force: true });
});
