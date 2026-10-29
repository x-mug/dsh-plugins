# Auto 审查缓存身份（@x-mug/dsh-auto-review-cache-identity）

给内置 Auto 审查（`@deepseek-ai/dsh-experimental-auto-review`）的模型调用补一个稳定的缓存身份，让审查请求的 prompt 前缀能跨调用复用；同时可以在设置页里给审查单独指定一个模型。

版本 **1.0.0**，插件包名为 `@x-mug/dsh-auto-review-cache-identity`。兼容基线为 **DeepSeek Harness Desktop 0.2.1-rc.3 / Cordis 4.0.5**。插件依赖 DSH 内部的服务钩子与客户端槽位，其他版本需要重新验证。

## 为什么需要它

Auto 预设下每个工具调用都要先过一次 LLM 审查。审查请求由 `classifyRisk` 构造，只有 `provider / model / system / messages / temperature / signal`，**没有 sessionId**。

pi-ai 因此把 `prompt_cache_key` 发成 `undefined`，网关只能用"首条 user 消息"现算一个会话 id。审查的 system 是固定的 `REVIEW_POLICY`，但 user 消息每次都变，于是每轮都是新键、前缀从不复用——实测这批请求命中率约 10%，占 DSH 全部未命中的多数。

本插件在 `llm/stream` 上认出审查调用，补一个稳定的 `sessionId`；pi-ai 把它写进 `prompt_cache_key` 和会话头，缓存键不再随请求内容变化。

## 功能

- **稳定身份**：`"auto-review:" + sha256(会话 id)[:32]`，原始会话 id 不出现在请求里。
- **可选固定审查模型**：设置页里选供应商与模型；留空跟随主对话。
- **只动网络元数据**：`system / messages / temperature / signal` 及其余字段逐字节不变，新增的只有 `sessionId`。
- **失败即放行**：插件内部任何异常都退回原始请求，最坏结果等于不装。
- **设置页**：导出 schemastery `Config` 后自动生成表单；另有一个自定义分区「Auto 审查模型」，用实时模型目录做下拉。

## 安装

本插件首次随仓库发布的版本是 `1.0.0`。安装方式与仓库其他插件一致：

1. 在 DSH 插件页点击「添加插件」→「安装第三方插件」，填一段安装地址。
2. 本插件对应 `local-dsh-auto-review-cache-identity-1.0.0.tgz`；已发布该版本时可直接填 Release 压缩包直链，或填仓库目录在本机的绝对路径。
3. 按插件页提示重启或重载应用，确认插件版本为 1.0.0。
4. 安装成功后，设置页会出现「Auto 审查模型」分区，并在插件配置表单里出现四个字段。

多插件仓库用 `#path:` 指向子目录，例如版本 tag 发布后可以写：

```text
github:x-mug/dsh-plugins#v1.0.0&path:/plugins/dsh-auto-review-cache-identity
```

只写仓库根地址不行：根目录不是插件包，管理器会拒绝并回滚。升级时先移除旧版本再安装。

## 配置

bundle 默认值只有两项，其余都留给设置页或 profile 补丁：

```yml
- insert:
    - id: local-auto-review-cache-identity
      name: '@x-mug/dsh-auto-review-cache-identity'
      config:
        enabled: true      # 关掉等于没装
        scope: session     # session：按会话；cwd：按工作目录（只给 A/B）
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后监听器直接放过所有请求。 |
| `scope` | `session` | `session`：键 = `sha256(会话 id)`，读不到会话则本次不注入；`cwd`：键 = `sha256(cwd)`，完全不读发起者作用域，只用于 A/B 对照。 |
| `reviewProvider` | 空 | 审查固定使用的供应商 id，空 = 跟随主对话。 |
| `reviewModel` | 空 | 审查固定使用的模型 id，空 = 跟随主对话。 |

`reviewProvider` / `reviewModel` 两个字符串都非空才会覆盖路由；只填一个等于没填。

**profile 用户层按条目 id 覆盖 `config`，是整体替换、不是深合并。** 删掉用户层某个字段不会回落到 bundle 默认值，而是回落到 schema 默认值。要么只保留一层配置，要么两层始终写全。

### 诊断选项

两个只从 profile 补丁读、不进设置页表单的选项，默认都不开：

| 字段 | 默认 | 说明 |
|---|---|---|
| `log` | `false` | 每次注入打一行 info：`injected=<累计> key=<键> identityMisses=<累计>`。 |
| `trace` | 不设 | 一个**本机绝对路径**。每次注入向该文件追加一行 JSON（时间、键、provider、model）。 |

`trace` 不写进仓库默认值：绝对路径是某台机器的本地残留，装到别人机器上只会静默写失败。需要定位时在自己的 profile 补丁里显式给出路径，用完删掉。

## 设置页

两条路径都可以用：

- **自动表单**：插件导出 `Config` 并调用 `ctx.settings.configure()`，设置页会为四个字段生成原生表单，改动写回 profile 的 `cordis.patch.yml`。适合改 `enabled` / `scope`。
- **自定义分区「Auto 审查模型」**：供应商、模型两个下拉框，数据来自实时的模型目录；点「保存」写入同一份 profile 补丁。适合给审查换模型。

两点行为需要知道：

1. 设置页保存只写 volatile 字段，**不会重新 apply 插件**。插件每次处理审查时现读配置，所以保存后立即生效、无需重启。
2. 写入是 CAS：客户端用读到的 revision 提交，过期会被拒绝并提示保存失败，重新打开设置页再存即可。

自定义分区下方有「设置原始信息」，展开是 `describe` 的原始返回，排查"保存了但没生效"时先看它。

## 只动网络元数据

- `system` / `messages` / `temperature` / `signal` 以及其余所有字段原样带走，逐字节不变。
- 新增的只有 `sessionId`（它不进 prompt，只在适配器里翻成 `prompt_cache_key` 和两个请求头）。
- 不改 `options` 本身。审查的 options 是 `deepFreeze`，本插件构造新对象并冻结。
- 流是纯透传：不包装、不过滤、不重试、不补块、不聚合。
- 非审查调用不吃包装：监听器直接返回 `next()`，调用方拿到的就是下游那个流对象本身。
- 处理器是同步函数：返回 Promise 会让审查方的 `for await` 直接 TypeError。
- 不缓存 `llm` 服务引用，每次调用都重新取，HMR 后不会走旧注册表。
- 不持有 AbortController，卸载时不 abort 在飞的审查。

## 失败即放行

| 情况 | 行为 |
|---|---|
| 插件内部抛错（识别、解析、摘要任一环） | 吞掉，走 `next()` 派发原始请求 |
| 认不出是审查 | 走 `next()` |
| 拿不到发起者会话 | 不注入，走 `next()`（计数并在日志里说明一次） |
| `agents` 服务缺失、被 dispose、不在发起者作用域内 | 同上 |
| 已有 `sessionId`（另一个实例注入过） | 不再改写 |
| 配置的档位名不认识 | 启动时 warn，整插件不注入 |
| 拿不到 `llm` 服务 | 插件保持惰性 |

重新派发用的是 `ctx.llm.stream(newCall)`，**不是** `next(newOptions)`：cordis 的 `next` 在原始参数上闭包，传入的新参数会被静默丢弃。`next()` 靠 `cbs.shift()` 前进，任何路径都只能调用一次。

## 识别判据与顺序

必须同时满足，任何一条不满足都不算审查：

1. `temperature === 0`
2. `system` 以 `REVIEW_POLICY\n` 开头，且含固定句
   `You are the final authorization reviewer for exactly one pending tool call.`
3. `messages` 恰好 1 条，role 为 `user`
4. 该消息恰好 1 个 `type: "text"` 块
5. 正文以 `ENVIRONMENT\n\n` 开头，且含 `\n\nPROJECT_INSTRUCTIONS\n\n` 与 `\n\nPENDING_ACTION\n\n`

主对话、压缩（`purpose: "compaction"`）、标题（`purpose: "session-title"`）、subagent、以及 approve-for-me 自己的审查（`>>> APPROVAL REQUEST START`，system 不同）都不满足 2-5。

判定顺序是为了让热路径不付钱：

```text
enabled → options.sessionId 已存在 → OWN_CALLS → isAgentLoopRequest → isReview
        → 这时才 currentInitiator() → resolveIdentity → reviewRoute
```

`currentInitiator()` 每次都是真读 AsyncLocalStorage，所以放在确认是审查之后。另有一道独立护栏：`@deepseek-ai/dsh-llm` 导出的 `isAgentLoopRequest(options)`，它只标记 agent loop 的正常对话请求；拿不到这个导出时自动退化为上面的弱护栏。

会话身份直接读 DSH 自己的发起者作用域，不另建一套：

```js
ctx.get('agents')?.currentInitiator()?.session?.id
```

审查发生在 `tools/pre-execute` 的监听器里、`ctx.llm.stream` 之前，同一条 await 链，所以读到的就是发起这次工具调用的会话。服务被 dispose 后 `currentInitiator()` 会抛，读取必须包 `try`。

**读不到会话就不注入，原样放过。** 不退回 cwd：同一目录下几十个互不相干的会话和子代理会塌成同一个身份，把几十条审查链塞进一条缓存，还让它们长期共用一个账号——"稳定地错"比"没有"危险，而且从日志和命中率上都看不出来。

## 已知限制

1. **分路由有效，这是最大的边界。** 只在 openai-responses 这类会发会话头的路由上有效；纯 chat/completions 路由上键虽然稳定，但请求被摊到不同账号，读不到别人的缓存，收益≈0。判断方法：看请求实际走的接口路径，上游段是 `/v1/responses` 才有效。不要因为"装上了"就以为有效。
2. **固定审查模型是安全闸门上的配置。** Auto 审查要求模型按规定协议返回：恰好一个 text 块、合法 JSON、6 种判决形状之一。换成不遵守协议的模型后，审查会**失败并直接拒绝工具调用**（fail-closed：不弹审批、不转人工、不重试），表现为所有工具调用都报「Auto review of tool "X" failed」。设置固定模型前先用兼容模型验证，出问题就把两个字段清空、回落主对话。
3. **`onPayload` 这条路已验证不可用，别重走。** pi-ai 三个适配器都支持它，但 `dsh-llm-pi-ai` 用白名单重建送给 pi-ai 的选项，`onPayload` 不在白名单里，从 `llm/stream` 上挂会被静默丢掉。唯一能从插件侧到达 `prompt_cache_key` 的字段是 `sessionId`。
4. **`isAgentLoopRequest` 护栏未在真环境验证。** 它是模块级的 WeakSet：插件 `import '@deepseek-ai/dsh-llm'` 若解析到另一份模块副本，这个集合就是空的，护栏静默失效。两个方向都安全：误 false 只是少一道护栏；误 true 只是这一次不注入。
5. **寄生依赖：键发不发得出去由 profile 决定。** `prompt_cache_key` 不是本插件凭空加的，pi-ai 还要满足自己的条件：responses 适配器要 `cacheRetention !== "none"`；completions 适配器只有 baseURL 命中 `api.openai.com` 或 `cacheRetention === "long"` 且 compat 支持时才发。换一台机器可能静默 no-op。
6. **离线无法证明后端真的按这个键复用。** 验收要看 `cache_read` 是否真的增长，不能只看缓存命中率的小数点。
7. **`scope: cwd` 不要长期开。** 同目录几十个会话会共用一个身份，这是稳定的错，账本上看不出来；它只用来做 A/B 对照。
8. **插件不写任何持久状态**，卸载后不留残留；设置值留在 profile 的 `cordis.patch.yml` 里，需要时手动清。

## 回退

把 `enabled` 设成 `false`，或从 `dsh.profile.bundles` 里移除后重启。两种回退都不影响已经保存的设置值。

## 开发

需要 **Node.js 24**，核心测试不需要第三方依赖，无需执行 `npm install`：

```powershell
npm test
npm run check
```

等价的直接命令为：

```powershell
node --test --test-isolation=none test/*.test.mjs
node --check index.js
node --check client.js
```

离线测试用迷你 cordis 复刻 waterfall 语义、真实 AsyncLocalStorage 模拟发起者作用域，覆盖审查识别、身份推导、并发不串号、volatile 配置解引用、运行期改设置、失败放行、卸载恢复，共 23 项。自动化测试不代表真实 GUI 验收；设置分区、下拉框和保存按钮还需要在应用里点一遍。

客户端部分不需要构建：`client.js` 是手写的 `window.__ModuleLoader__.load({ id, factory })` 工厂函数，React 由 loader 注入，直接 `require('react')`。宿主部分（`index.js`）只读配置、挂 `llm/stream`，没有编译产物。

插件形态、配置读取、`llm/stream` 拦截、设置分区等通用注意事项见 [DSH 插件开发经验](../../docs/PLUGIN-DEVELOPMENT.md)。
