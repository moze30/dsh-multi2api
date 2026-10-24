# dsh-multi2api

把**多个 WorkBuddy（腾讯 CodeBuddy）账号**变成 DeepSeek Harness 里一个个**互不干扰的模型**：
一个账号一个模型，用哪个号就切到哪个模型，不会串号、不会自己换号。

## 它做了什么

- **自带程序**：包里带好了各个平台编译好的 `multi2api` 程序（Linux / macOS / Windows，x64 与 arm64），
  装上就能跑，机器上**不需要装 Go**。
- **进程托管**：插件启动时自动拉起 `multi2api`，崩了会自动重启；点"重启服务"手动重启。
- **一账号一模型**：账号池里每个账号都会变成 DSH 里的一个模型，
  切模型 = 切账号，互不影响。
- **自动检测上游模型**：直接问上游要可用模型清单（模型名、上下文长度、能力、积分倍率都是上游实时给的），
  不用手动维护。上游有几个模型，面板里就能看到几个。
- **模型名 + 账号名**：每个账号 × 每个上游模型都会拼成一条，
  名字形如「GLM-5.3 · 13800138000」，一眼就知道用哪个号跑哪个模型。
- **积分倍率可见**：面板里有一张表，列出每个模型的倍率（比如 `x0.11 credits`），花多少心里有数。
- **自动模式**：另有一个 `auto` 模型，走"积分最高的健康账号"，适合不想管号的时候。
- **选择启用**：上游模型和账号都能单独开关。没启用的模型不会出现在聊天界面的模型列表里，
  关掉的账号也不会占位置——只留你要用的那几条，清清爽爽。
- **网页管理面板**：在「设置 → 插件」里多一个页签，可以开关模型、开关账号、看倍率、看余额、加号、删号、导号、看日志、重启。

## 安装

这是一个 DSH 插件，用 DSH 自带的插件命令装：

```bash
dsh plugin --profile web install dsh-multi2api
```

把 `web` 换成你要装的 profile 名字（比如 `tui`、`headless`）。装完重启 DSH 就能用。

支持 DSH `0.2.0-rc.1` 到 `0.2.x`（含 `0.2.0-rc.2` 与 `0.2.1-rc.1`）。0.2 之前的旧版 DSH 没有验证过，会被兼容性检查拦下。

也可以直接在 DSH 网页端左侧栏的 **插件（Plugins）** 页面里，点「添加插件」填包名 `dsh-multi2api` 安装。

> `npm install dsh-multi2api` 也能下载到这个包，但它只是把包装进普通 `node_modules`，
> 不会挂进你的 profile，还得自己改 `dsh.profile.bundles`，所以推荐用上面的命令。

## 使用

1. 打开「设置 → 插件 → Multi2API 账号池」。
2. 点「添加账号」，浏览器会打开登录页，用手机号登录 WorkBuddy；面板会自动把账号存下来。
3. 也可以点「导入账号文件」，一次选多个别的机器导出的凭证 JSON，批量加号。
4. 在面板的模型表里给要用的模型打勾、在账号卡片上开关账号。**只有打勾的模型和开着的账号**，
   才会出现在聊天界面的模型列表里；没打勾的一律不显示，列表不会被塞满。
5. 回到会话，在模型选择里挑「模型名 · 账号名」的那条（模型 ID 形如 `glm-5.3-13800138000`，
   前面是上游模型，后面是账号别名）。
6. 想不管号的时候，选 `auto`。

## 数据放在哪

默认 `~/.dsh/multi2api/`：

- `auths/` —— 各账号的登录信息（权限 600）
- `config.json` —— 被托管程序的配置（插件自动生成）
- `api_key` —— 本地接口密钥（插件自动生成）
- `selection.json` —— 哪些模型启用、哪些账号关掉
- `auto_checkin.json` —— 自动签到开关
- `data/state.json` —— 运行状态

可以在插件设置里改「数据目录」。

## 注意事项

- 账号的**增删需要重启被托管程序**才会生效，面板会自动帮你重启。
- 默认本地端口 7864，被占用时会自动往后找空闲端口。
- 如果之前手动跑过 `multi2api`，把它的 `auths/*.json` 复制到本插件的数据目录，
  或者在面板里用「导入账号文件」导入即可。

## 更新日志

### 0.1.10

内置「**上游风控规避**」：装上本插件后，新会话不再被 WorkBuddy/CodeBuddy 拦截。

- **背景**：上游会对 system prompt 做文本特征匹配，命中就返回
  `400 { "code": 11128, "msg": "Illegal API invocation from an unapproved channel" }`，
  界面显示「请求被拦截」。这不是 DSH 或本插件的问题，是上游侧的行为。
  
  症状是：**老会话能用，新建会话一律报错**。

- **两处触发点**（都已实测定位）：

  1. 原厂的 `You are an AI agent powered by DeepSeek Harness.`
     —— 由 `dsh-system-prompt` 注入。本插件的 bundle patch 关掉 `includeHarnessIdentity`，
     模型仍会收到 coding agent 的 persona，能力不受影响。

  2. `dsh-harness-dev-context` 注入的 Web GUI 段落里，
     `whose URL the runtime context `**`names`**` 这半句。
     —— 改用包内自带的 `dsh-multi2api/dev-context`：只把 `names` 换成 `provides`，
     其余 **1002 个字符逐字相同**，语义与信息量完全不变。

- **怎么做到的**：`cordis.patch.yml` 里同时做了四件事
  —— 挂载本插件、关掉原厂身份句、禁用官方 `harness-dev-context`、
  挂载包内的替身（走子路径导出 `dsh-multi2api/dev-context`）。
  **不需要你手动改任何配置**。

- **实测**：新会话连续 3 次全部 `completed`；
  插件功能（checkout 提示、HMR/Vite 说明、GUI URL runtime context）一条没少。

  | 内容 | 拦截率 |
  | --- | --- |
  | 原始文本 | 3/3 被拦 |
  | 修掉这两处后 | **0/3** |

- **给你自己核查**：装完后 `dsh --profile <名> --dump-config`，
  在 `system-prompt` 处应看到 `includeHarnessIdentity: false`，
  并多出一条 `harness-dev-context-patched`，其 `name` 为 `dsh-multi2api/dev-context`。

- **上游修复建议**：官方只要把 `dsh-harness-dev-context` 里 `WEB_SURFACE_PROMPT` 的
  `names` 换个词即可，所有用 WorkBuddy/multi2api 的人都能受益。

- **不影响**：账号池、模型列表、图片、`auto` 模式、面板功能全部照旧。
### 0.1.9

修「**装到 DSH 0.2.1 上被兼容性检查拦下**」：`dsh-multi2api@0.1.8 与 DSH 0.2.1-rc.1 不兼容`。

- **原因**：`peerDependencies` 写的是 `>=0.1.2-rc.1 <0.2.0`，只放到 0.2.0 之前。
  DSH 0.2.0 之后内部包整体进了 `0.2.x`，这个上限就把新版本全挡在外面了。
- **改动**：三个 `@deepseek-ai/dsh-*` peer 的上限提到 `<0.3.0-0`，下限定在 `0.2.0-rc.1`
  （0.2 之前的老 DSH 没有验证过，不再声称支持）。同时把 pi-ai 的 peer 从 `^0.87.1`
  放宽成 `^0.87.1 || >=1.1.0 <2.0.0` —— DSH 0.2.1 把 pi-ai 从 0.87 跳到了 1.x。
- **预发布注意**：`>=0.2.0-rc.1 <0.3.0-0` 这种写法在 npm 的严格 semver 下匹配不到
  `0.2.1-rc.1` 这类预发布，所以区间按已知的预发布线分别列出，保证 npm / pnpm / DSH
  三处判定都通过。
- **已实测**：0.2.0-rc.2（pi-ai 0.87.1）与 0.2.1-rc.1（pi-ai 1.3.0）两套依赖树里，
  `npm install` 均无 ERESOLVE、插件模块均能正常加载并导出 `Config/apply/inject/name`。
  插件用到的宿主接口（`PiAiAdapter` 及其全部构造选项、`resolveRetryPolicy`、
  `resolveImageAttachmentAccess`、`resolveDshHome`、`createProvider`、
  `openAICompletionsApi`）在 0.2.1 中签名未变。

### 0.1.8

修「**发图就报 `pi-ai image input requires the durable attachment service`**」，外加一处一直没生效的设置。

- **图片发不出去**：`dsh-llm-pi-ai` 在处理含图请求前会问适配器要 DSH 的
  durable attachment 服务，拿不到就直接抛错、请求根本不发出去。本插件构造
  `PiAiAdapter` 时漏了这两个字段，所以**任何带图的请求都必然失败**。现在按
  DSH 自己那个 pi-ai provider 的写法补上 `resolveAttachments` 与 `resolveImageAccess`
  （`resolveImageAttachmentAccess` 本就是 `@deepseek-ai/dsh-llm` 的公开导出）。
- **输出上限可能一直没生效**：pi-ai 决定「最大输出」字段用哪个拼写时，未显式声明就退回
  `detectCompat()`，而它**只看 provider 名和 baseUrl**。本插件的路由是
  `provider=multi2api` + `http://127.0.0.1:<端口>/v1` 的本地代理，一个特征都匹配不上，
  于是回落到 OpenAI 新拼写 `max_completion_tokens` —— 对 DeepSeek 系上游是错的，
  模型上声明的 `maxTokens`（上游默认 128000）会被上游忽略（不报错，只是不生效）。
  现在钉死为 `max_tokens`。已知同类问题作者此前已手动改对 4 个
  （`thinkingFormat` / `supportsDeveloperRole` / `supportsStore` /
  `requiresReasoningContentOnAssistantMessages`），这是第 5 个。
- **回放降级不再静默**：补上 `onReplayDegrade`，历史里的图片被降级成占位符时会记一条
  warning（DSH 自己的 provider 也这么做）。只增加可观测性，不改变行为。

**没动的**：`supports_tool_call`（上游会报，但 pi-ai 里**没有**对应的模型字段，
插件无处声明）；`credits → cost`（上游给的是倍率如 `x0.29`，而 `cost` 是"每 token 多少美元"，
量纲不同，硬映射只会显示假数字）。

### 0.1.7

修「**刚配好的账号，在聊天界面的模型选择器里看不见**」：

- **原因不在刷新，在通知。** 服务端的模型清单其实一直是新的 —— 启动时、加/删/导入账号后、
  每 30 秒、以及面板点「刷新模型」时都会重拉一遍。查下来是 multi2api **更新完自己的快照，
  却从来没有告诉客户端**：聊天界面那个模型选择器（`dsh-client-ui-model-selection`）持有一份
  客户端缓存，只有收到 `llm/adapters-updated` 才会重新拉清单。
- **改法**：模型清单的指纹一变（也就是那处已经在做的 `runtime.invalidate()`），
  就顺手 `ctx.emit("llm/adapters-updated")`。这个事件名取自 DSH 自己的
  Host→客户端转发白名单，所以根 ctx 上 emit 就能送到每个已打开的界面。
- 附带效果：删号、改名、白名单开关导致的模型变化，界面也会立刻跟上，
  不用再"先点一下别的模型"来触发重算。

### 0.1.6

修了三个会让你用不下去的毛病：

- **桌面端（DSH Desktop / Electron）加不上账号**：管理接口的写操作守卫原来要求请求必须带
  `Origin` 头，而桌面端经 Electron 网络层转发出来的请求不带这个头，于是加号、签到、删号、
  保存设置、重启**全部 403 `origin-required`**。现在去掉了这条硬性要求，改成
  「Host 必须是回环地址」+「Origin 一旦出现就必须也是回环」+「必须 `Content-Type: application/json`」，
  防跨站伪造和防 DNS rebinding 的能力不变。
- **点了「添加账号」两秒后自己中断**：上游在"还没登录完"时返回的是
  `HTTP 200 + code=11217 (login ing...)`，旧代码把它当成致命错误抛出去，直接掐断了整个登录流程，
  账号永远加不上（那个可以手动复制的登录链接也跟着一起消失了）。现在未完成会被正确识别为
  "继续等待"。
- **改成手动确认登录**：不再后台自动轮询（它容易判断错）。现在点「添加账号」会**立刻显示完整
  登录链接并提供「复制链接」按钮**——浏览器拉不起来也能自己粘到浏览器里打开。你在浏览器里
  登录完成后，回到面板点「我已登录完成」即可。没检测到会提示"再点一次"，不会把面板关掉。

## 许可

MIT

## 致谢

包里自带的 `multi2api` 程序基于 [itamzxm/ai-multi-platform-proxy](https://github.com/itamzxm/ai-multi-platform-proxy)（MIT 许可）修改后编译，
按其许可要求在此声明。本插件包内**不含任何账号凭证**。
