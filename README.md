# dsh-hermes-memory

DeepSeek Harness 插件：把 Hermes Agent 的长期记忆作为**一个只读 system prompt 段**注入，让 DSH 与 Hermes 共享同一份记忆。

## 解决什么问题

Hermes 维护两份记忆文件：

| 文件 | 内容 |
|---|---|
| `~/.hermes/memories/MEMORY.md` | agent 自己的笔记：环境事实、约定、踩坑 |
| `~/.hermes/memories/USER.md` | 用户画像：偏好、风格、期望 |

DSH 没有原生记忆机制，默认对这两个文件一无所知。本插件在启动时读取它们，拼成一段文本注册进 system prompt，使 DSH 开局就具备与 Hermes 一致的记忆视野。

**只读**：DSH 不写入这两个文件。记忆的权威方仍是 Hermes（保留其注入扫描、去重、容量回流、`write_approval` 四道闸门）。

## 工作机制

```
apply(ctx)  ──readFileSync──▶  ~/.hermes/memories/{MEMORY,USER}.md
     │
     └─ ctx.systemPrompt.section({ name: "hermes:memory", order: 100, text })
```

- **服务键名 `systemPrompt`**：对应 `@deepseek-ai/dsh-system-prompt` 的 `super(ctx, "systemPrompt")`，必须写进 `inject` 数组，否则访问时抛 `cannot get property without inject`。
- **注册方法 `section()`**：`text` 为静态字符串时只在 `apply()` 期间读一次、注册一次，之后每次组装复用同一份文本 —— 对 KV Cache 前缀稳定。
- **`order: 100`**：官方段落位从 `HARNESS_IDENTITY = -1000`、`DEPLOYMENT_PERSONA_PREFIX = 0` 到 `TOOL_* = 1000+`，100 落在「身份/人格之后、工具指引之前」。外部贡献者可用任意有限数。

### 为何不用 `sessionProjections`

官方 `dsh-agent-instructions` 插件的做法是构造 user-role 消息塞进 `agent.inbox`（见其 `apply()` 与 `agent/pre-step` 钩子），用来跟踪**会变的工作区文件**。那套机制产出的是进对话历史的上下文，方向不是 system prompt，且耦合 inbox 与 turn boundary。对一段固定文本，`section()` 语义更对口、依赖更少、前缀更稳。

## 安全处理：`{{` 消毒

`renderPrompt()` 会严格插值 `{{variable}}`，**未知或畸形引用直接抛错**，且没有转义语法。记忆文件是用户可编辑的 —— 一旦里面出现 `{{cwd}}` 这类文本，会让整个 prompt 组装失败、agent 不可用。

因此插件在注入前把 `{{` 替换为 `{ {`，使整段退化为字面文本。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `HERMES_MEMORIES_DIR` | `~/.hermes/memories` | 记忆文件所在目录，便于测试或非默认 home |

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
