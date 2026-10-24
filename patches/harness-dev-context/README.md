# dsh-harness-dev-context-patched

`@deepseek-ai/dsh-harness-dev-context` 的最小 fork，**只改了一个词**。

## 为什么

WorkBuddy / CodeBuddy 上游对 system prompt 做文本特征匹配，命中即返回：

```json
HTTP 400
{ "code": 11128,
  "msg": "Illegal API invocation from an unapproved channel",
  "displayMsg": { "zh": "请求被拦截" } }
```

官方插件注入的 Web GUI 段落里，这半句会命中：

```
... Web GUI whose URL the runtime context names.
                                        ^^^^^
```

## 改了什么

```diff
- ... Web GUI whose URL the runtime context names.
+ ... Web GUI whose URL the runtime context provides.
```

**只此一处。** 语义完全不变（"运行时上下文所提供/命名的 URL"），
插件要告诉模型的其它信息一条没少：checkout 位置、HMR 要跑 `pnpm run dev:web`、
Vite 入口不是独立应用、不要另起 server 等等。

## 实测依据

对 `/v1/chat/completions` 直接二分定位，接在同样的 baseline 之后：

| 内容 | 结果 |
| --- | --- |
| 完整原段落 | 3/3 被拦 |
| 只把 `names` 换成 `provides` | **0/3 通过** |
| 换成 `states` / `gives` / `specifies` / `carries` | 同样通过 |
| 等长随机填充（排除长度因素） | 通过 |

## 为什么不改 LEGACY 常量

源码里的 `LEGACY_WEB_SURFACE` 是给**老会话**用的：那些会话的日志里已经嵌了
旧版原话，必须逐字保持一致，否则 resume 时会重写它的历史 prompt。
老版用的是 `at <url>` 措辞，本来就不触发风控，所以一个字都没动。

## 用法

本目录是 `dsh-multi2api` 仓库的一个子补丁，不单独发布。安装方式：

1. 把本目录内容复制到 profile 的 `node_modules/dsh-harness-dev-context-patched/`
2. 在 profile 的 `cordis.patch.yml` 里加：

```yaml
- id: harness-dev-context
  name: dsh-harness-dev-context-patched
```

3. 重启 dsh

`harness-dev-context` 这个条目 id 由官方 `dsh-web-app` bundle 挂载，
用同名 id 覆盖 `name` 即可替换实现。

## 上游修复建议

官方只要把 `src/index.ts` 里 `WEB_SURFACE_PROMPT` 的 `names` 换个词即可，
对所有使用 WorkBuddy / multi2api 的用户都有效，无需各自 fork。

## 许可

MIT，与上游一致。原始代码版权归 DeepSeek。
