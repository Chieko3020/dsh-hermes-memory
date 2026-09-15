# dsh-hermes-memory

DeepSeek Harness 插件：把 Hermes Agent 的长期记忆作为**一个只读 system prompt 段**注入，让 DSH 与 Hermes 共享同一份记忆；并提供**反向写回工具**，让 DSH 会话中学到的知识能沉淀回记忆文件。

## 解决什么问题

Hermes 维护两份记忆文件：

| 文件 | 内容 |
|---|---|
| `~/.hermes/memories/MEMORY.md` | agent 自己的笔记：环境事实、约定、踩坑 |
| `~/.hermes/memories/USER.md` | 用户画像：偏好、风格、期望 |

DSH 没有原生记忆机制，默认对这两个文件一无所知。本插件在启动时读取它们，拼成一段文本注册进 system prompt，使 DSH 开局就具备与 Hermes 一致的记忆视野。

**v0.1.1 起双向**：除只读注入外，还注册 `memory` 工具（写回），DSH 会话中判断值得沉淀的内容可写入同一份文件，供 Hermes 与后续 DSH 会话共享；每次成功写入自动归档到独立 git 仓库可回滚。

## 工作机制

```
apply(ctx)  ──readFileSync──▶  ~/.hermes/memories/{MEMORY,USER}.md
     │
     ├─ ctx.systemPrompt.section({ name: "hermes:memory", order: 100, text })   ← 只读注入
     │
     └─ ctx.tools.register(defineTool({ name: "memory", ... }))                  ← 反向写回
                 │
                 └─ spawn python3 lib/memory_store.py  ──▶  写盘 + git 归档
```

- **服务键名 `systemPrompt`**：对应 `@deepseek-ai/dsh-system-prompt` 的 `super(ctx, "systemPrompt")`，必须写进 `inject` 数组，否则访问时抛 `cannot get property without inject`。
- **注册方法 `section()`**：`text` 为静态字符串时只在 `apply()` 期间读一次、注册一次，之后每次组装复用同一份文本 —— 对 KV Cache 前缀稳定。
- **`order: 100`**：官方段落位从 `HARNESS_IDENTITY = -1000`、`DEPLOYMENT_PERSONA_PREFIX = 0` 到 `TOOL_* = 1000+`，100 落在「身份/人格之后、工具指引之前」。外部贡献者可用任意有限数。
- **写回工具 `memory`**：schema 与语义逐条镜像 Hermes 内置 memory 工具（`action: add/replace/remove`、`operations` batch、`target: memory/user`），写盘由同目录 `memory_store.py`（spawn python3）执行，协议 100% 对齐。

### 为何不用 `sessionProjections`

官方 `dsh-agent-instructions` 插件的做法是构造 user-role 消息塞进 `agent.inbox`（见其 `apply()` 与 `agent/pre-step` 钩子），用来跟踪**会变的工作区文件**。那套机制产出的是进对话历史的上下文，方向不是 system prompt，且耦合 inbox 与 turn boundary。对一段固定文本，`section()` 语义更对口、依赖更少、前缀更稳。

## 反向写回（v0.1.1）

### 工具 `memory`

DSH agent 在会话中调用，写入 `~/.hermes/memories/`。语义与 Hermes 完全一致：

| 参数 | 说明 |
|---|---|
| `target` | `memory`（环境/项目事实）或 `user`（用户画像），必填 |
| `action` | `add` / `replace` / `remove`（单操作形态） |
| `content` | 条目内容（add/replace 必填） |
| `old_text` | 定位旧条目的唯一子串（replace/remove 必填） |
| `operations` | batch 形态：操作数组，原子应用，全部成功才写盘 |
| `note` | 可选，仅作为 git 归档 commit message，不写入记忆文件 |

### 与 Hermes 的兼容契约（必须保持 lockstep）

- 条目分隔符 `"\n§\n"`，文件是干净的 § 分隔条目列表
- **flock 锁**：`.lock` 文件 + `fcntl.flock(LOCK_EX)`（跨进程，与 Hermes 同一把锁）
- **原子写**：temp 文件 + `os.replace`（读者永远看到完整文件）
- **drift 保护**：replace/remove/batch 前做 round-trip 检测（`split(§).join` 必须还原原文）与单条超限检测，不通过则拒写并保存 `.bak.<ts>` 快照；add 是 append-only 跳过 drift（不覆盖既有内容）
- **容量上限**：memory 2200 字符 / user 1375 字符（全文件总长），超限返回 consolidation 指引
- **威胁扫描**：写入内容做注入/外泄模式扫描（与 Hermes threat_patterns 同源），命中即拒写
- **成功响应**：`{success, done, target, usage, entry_count, note}`，不回显 entries（防模型反复调用）

### git 归档

每次写盘成功后，把 `MEMORY.md`/`USER.md` 复制到 `~/Dev/hermes-memories/`（独立 git 仓库）并 commit，作为任意历史版本的回滚网。归档失败不影响写盘结果，只附加 `archive_reason` 提示。

## 安全处理：`{{` 消毒

`renderPrompt()` 会严格插值 `{{variable}}`，**未知或畸形引用直接抛错**，且没有转义语法。记忆文件是用户可编辑的 —— 一旦里面出现 `{{cwd}}` 这类文本，会让整个 prompt 组装失败、agent 不可用。

因此插件在注入前把 `{{` 替换为 `{ {`，使整段退化为字面文本。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `HERMES_MEMORIES_DIR` | `~/.hermes/memories` | 记忆文件所在目录，便于测试或非默认 home |
| `HERMES_MEMORY_ARCHIVE_DIR` | `~/Dev/hermes-memories` | git 归档仓库目录（须是已初始化的 git 仓库） |

文件不存在、不可读、为空时**不注册任何段并静默跳过**，任何异常都不会影响 DSH 启动。

## 安装

```bash
# 1. 本目录即插件本体；登记到目标 profile
cd ~/.dsh/profiles/web
python3 - <<'EOF'
import json, pathlib
p = pathlib.Path("package.json")
d = json.loads(p.read_text())
d["dependencies"]["dsh-hermes-memory"] = "file:/ABSOLUTE/PATH/TO/dsh-hermes-memory"
d["dsh"]["profile"]["bundles"].append("dsh-hermes-memory")
p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
EOF

# 2. 安装并重启
pnpm install
sudo systemctl restart dsh
```

`cordis.patch.yml` 中的 `insert.name` 必须等于 `package.json` 的 `name`（`dsh-hermes-memory`），因为该模块说明符由 profile 目录解析。

## 测试

```bash
# Python 写盘核心单测（隔离临时目录）：解析/drift/容量/batch/威胁/并发锁
python3 test/test_store.py

# Node 工具集成测试（隔离临时目录）：schema 注册/写盘+归档/原子性/失败不归档
# 依赖 dsh-tools 解析，需要 Dev 仓库 node_modules/@deepseek-ai/dsh-tools symlink
node --test test/test_tool.mjs
```

## 验证

重启后，在 DSH 新会话里问一个**只有记忆文件里才有**的事实（例如某个只写在 `USER.md` 里的项目名）。答得出即说明注入生效。

也可直接脱离 DSH 干跑逻辑：

```bash
node -e "
import('./lib/index.js').then(m => {
  const reg = [];
  m.apply({ systemPrompt: { section: s => { reg.push(s); return () => {}; } }, logger: {} });
  console.log('注册段数:', reg.length);
  if (reg[0]) console.log('字符数:', reg[0].text.length, '| 含 {{ :', reg[0].text.includes('{{'));
});
"
```

## 卸载

从 profile 的 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 两处移除 `dsh-hermes-memory`，然后 `pnpm install && sudo systemctl restart dsh`。

## 许可

MIT
