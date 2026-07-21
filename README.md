# 压缩与缓存断点 (Compress & Cache Breakpoints)

SillyTavern 第三方 UI 扩展。两件事：

1. **主动触发的上下文压缩**：把最近 N 条消息用可配置的提示词交给当前模型总结，结果写回会话记录；可选把被压缩的原始消息隐藏出上下文。
2. **三组缓存断点（TTL 可配）**：在指定消息位置注入 [gproxy](https://gproxy.leenhawk.com/guides/claude-caching/) 缓存断点，命中 prompt 缓存、省钱提速。

---

## 安装

把整个 `st-compress-cache/` 文件夹放到 SillyTavern 的第三方扩展目录：

- 单用户：`SillyTavern/data/<你的用户名>/extensions/st-compress-cache/`
- 全体用户：`SillyTavern/public/scripts/extensions/third-party/st-compress-cache/`

刷新页面后，在 **扩展（Extensions）面板** 里会出现「压缩与缓存断点」设置抽屉。

> `manifest.json` 里的 `generate_interceptor` 字段是断点注入的关键，改名或删除会导致断点失效。

---

## 一、压缩

- **压缩提示词**：给模型的 system 指令，决定“怎么压”。
- **压缩最近条数 N**：从会话末尾往前取 N 条（自动跳过已隐藏的消息和以往生成的摘要）。
- **摘要写回角色**：`assistant` 或 `user`，即摘要以哪种角色进入后续上下文。
- **摘要前缀**：写回消息的开头标记，默认 `【压缩记忆】`。
- **压缩后隐藏原始消息**：勾选后，被压缩的原始消息用 ST 的 `/hide` 移出上下文（仍留在聊天记录里、灰显），从而真正“省 token”。不勾则只追加摘要、原文照旧发送。

触发方式：

- 设置面板里的 **「立即压缩」** 按钮（右边小框可填临时条数）。
- 斜杠命令：`/compress` 或 `/compress 20`。

摘要消息会带内部标记 `extra.compress_cache.isCompression = true`，供「上次压缩结果」断点定位。

---

## 二、缓存断点（gproxy 魔法字符串）

三组断点，各自独立开关、独立 TTL：

| 断点 | 定位 | 默认 |
|---|---|---|
| 上次压缩结果 | 最近一条带压缩标记的消息 | 关闭（没有压缩结果时无意义） |
| 倒数第一条 assistant | 末尾往前第一条非隐藏的 assistant 消息 | 开启，5m |
| 输入消息 | 末尾往前第一条非隐藏的 user 消息 | 开启，5m |

### 原理

生成请求前，扩展在目标消息内容末尾追加一段 gproxy **魔法字符串**（按 TTL 选取固定串）。gproxy 在发送前**删除触发串**、并在该位置写入原生 `cache_control`。注入通过 `structuredClone` 只作用于**本次请求**，**不写回存档**。压缩自身的后台生成（`type === 'quiet'`）会被跳过，不会被加断点。

### 前置条件

1. 在 gproxy 对应渠道（Claude API / Claude Code / OpenAI / OpenRouter / Vercel 等）打开 **Magic-string cache**。
2. gproxy 每次请求最多 **4 个**缓存标记，本扩展最多用 3 个。
3. 断点应放在稳定前缀之后、可变内容之前，才能稳定命中缓存。本扩展的三个断点从前到后为：压缩结果 → 倒数第一条 assistant → 输入消息，天然符合“稳定在前”的布局。

### TTL 与魔法字符串

TTL 三档：`default`（渠道默认）/ `5m` / `1h`，各对应一个 gproxy 固定触发串（内置默认值取自官方文档；如官方更新可在设置面板「高级：gproxy 触发串」里覆盖）。

> Claude 的 1h TTL 需要 gproxy 渠道侧支持扩展 TTL（`extended-cache-ttl` beta）。魔法字符串方案下由 gproxy 处理。

### 关于“原生断点”

SillyTavern 对 Claude 有内置的 prompt 缓存（Chat Completion 里的 *Cache at Depth*），但那是**按深度的全局策略**，无法从扩展按“具体某条消息 + 独立 TTL”精确下断点。因此本扩展默认走 gproxy 魔法字符串；若你只想用原生按深度缓存，直接用 ST 自带设置即可，可把本扩展断点设为「关闭」，只用压缩功能。

---

## 工作原理小结

- 压缩：`generateRaw({ systemPrompt, prompt })` 用当前模型后台出摘要 → 写回 `context.chat` → 可选 `/hide` 原文。
- 断点：`manifest.generate_interceptor` 注册的全局函数在每次真实生成前对将要发送的消息数组做**临时**修改（克隆后追加魔法字符串），不影响存档。

## 兼容性

- 面向 Chat Completion（Claude / gproxy-claude 等）。
- 依赖较新版本 SillyTavern 的 `getContext()` API（`generateRaw` 对象参数、`loader`、`executeSlashCommandsWithOptions` 等）。开发验证于 SillyTavern 1.18.0。

## 许可

AGPL-3.0
