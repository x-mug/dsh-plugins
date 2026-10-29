# DSH 插件开发经验

把本地插件并入仓库的过程中踩到的坑，按"症状 → 根因 → 正确做法"记录。所有结论都来自本机 DSH Desktop 0.2.1-rc.3 / Cordis 4.0.5 的实测或只读源码核对，不是通用理论；升级 DSH 后需要重新验证。

本文基于 [`@local/dsh-auto-review-cache-identity`](../plugins/dsh-auto-review-cache-identity/README.md) 的开发过程：宿主插件挂 `llm/stream` 补缓存身份，客户端插件在设置页加一页模型选择。

## 0. 一个插件包的最小形态

```text
plugins/dsh-<name>/
  package.json       # name / exports / dsh.bundle / dsh.client / files
  index.js           # 宿主插件（ESM）
  client.js          # 客户端插件（浏览器工厂函数）
  cordis.patch.yml   # bundle 默认配置
  README.md
  test/*.test.mjs    # node --test，不需要第三方依赖
```

`package.json` 的关键字段：

```json
{
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "files": ["index.js", "client.js", "cordis.patch.yml", "README.md", "test/*.test.mjs"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-settings"] }
  }
}
```

没有构建步骤也能发布：宿主是 Node 侧的 ESM，客户端是浏览器里的一段工厂函数。只有需要把多个源码文件拼成一个 `client.js` 时（比如插件自带 Worker）才需要 `build.mjs`。

## 1. 插件形态：宿主插件与客户端插件是两套运行时

**症状**：想给插件加设置界面，先去装 esbuild / 打包 React；或者把 `window.__ModuleLoader__` 那段代码写进 `index.js`，结果宿主加载直接报错，插件整个起不来。

**根因**：两类插件由不同运行时加载，混在一起就是加载期异常。

- 宿主插件在 Node 侧的 Cordis 里跑，是一个 ESM 模块，导出 `name` / `inject` / `apply(ctx, config)`。
- 客户端插件在浏览器里跑，由 `window.__ModuleLoader__` 加载，形态就是一个注册了 `{ id, factory }` 的工厂函数；`require('react')` 由 loader 注入，**不需要打包 React**。

**正确做法**：

```js
// index.js —— 宿主插件
export const name = 'auto-review-cache-identity'
export const inject = []                              // 没有硬依赖也要写
export function apply(ctx, config) { /* 挂事件、读服务 */ }
```

```js
// client.js —— 客户端插件，整份就是一个函数
window.__ModuleLoader__.load({
  id: '@local/dsh-auto-review-cache-identity',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement
    function apply(ctx) { /* 注册槽位 */ }
    return { apply, inject: ['slots', 'remote'] }
  }
})
```

- `id` 用 `package.json` 的包名，和配置里引用的名字保持一致；客户端依赖的其它客户端包在 `package.json` 的 `dsh.client.inject` 里声明。
- 客户端文件不要 `import` 宿主模块；需要跨端通信走 `ctx.remote`（见第 6 节）。
- 宿主里的可选服务不要写成硬依赖：`ctx.get('llm')` 拿不到时保持惰性，或者用 `ctx.inject(['llm'], (scope) => ...)` 等它出现。

## 2. bundle patch：`- insert` 挂载，用户层按 id 整体替换

**症状**：插件装上了但行为没变；或者把 profile 里的某个字段删掉后，行为变成 schema 默认值而不是 bundle 里的默认值。

**根因**：配置是两层。

- `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，loader 把 `- insert: [{ id, name, config }]` 插进组合，这是**仓库默认值**。
- profile 的 `cordis.patch.yml` 是**用户层**，按条目 `id` 命中同一条目，`config` 是整体替换（`target[key] = value`），**不深合并**。
- 设置页保存写的也是用户层，不是 bundle 层。

**正确做法**：

```yml
# plugins/dsh-<name>/cordis.patch.yml
- insert:
    - id: local-auto-review-cache-identity
      name: '@local/dsh-auto-review-cache-identity'
      config:
        enabled: true
        scope: session
```

- 默认值只放"安全默认"。本机绝对路径、`log: true`、临时 trace 路径这类调试配置**不能**进仓库默认值：别人装上后会静默写失败，或者直接指向不存在的目录。
- 两层要么只留一层，要么始终写全。删掉用户层字段不会回落 bundle 值，而是回落 schema 默认值——`reviewModel` 会从配置值变成 `''`（跟随主对话），这类"删了个字段行为变了"很容易误判成 bug。
- 判断当前生效值最快的地方是插件自己的挂载日志：把解析后的关键配置打出来，一眼能看出是读到了配置还是走了默认。

## 3. 配置读取（最容易错的一节）

这是本次最大的坑，按发生顺序有三层。

### 3.1 `.volatile()` 字段传进 `apply` 的不是普通值

**症状**：`Config` 里声明了 `enabled: z.boolean().default(true).volatile()`，`apply` 里 `config.enabled !== false` 永远成立；`typeof config.reviewModel === 'string'` 永远为假，配置像没生效，但日志里又能证明配置确实送到了。

**根因**：schemastery 在解析配置时会把 `.volatile()` 字段包成 cosmokit 引用对象，`apply` 收到的是引用而不是值。引用形状是：

```js
{ get(): currentValue, [Symbol.for('cosmokit.volatile.write')](next): void }
```

`apply` 拿到的是 `resolveConfig` 的结果，所以按 `true` / `'session'` 这种普通值去判断必然落空。

**正确做法**：读配置处统一解引用。

```js
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 取出可变配置的真值；普通值原样返回。 */
function plain(value) {
  return value !== null && typeof value === 'object' && VOLATILE_WRITE in value ? value.get() : value
}
```

### 3.2 设置页保存不会重新 `apply`，所以不能在挂载时快照

**症状**：解引用后挂载时读对了，但在设置页改值、显示"已保存"之后，插件行为完全不变；只有重启才生效。

**根因**：设置页保存是 **volatile-only** 的：loader 是把新值原地写进那个引用（`_commitVolatile()`），再发 `loader/volatile-update` 事件，**fiber 不重启、不重新 apply**。只有非 volatile 字段变化才会重新 apply。所以任何"在 `apply` 里算一次 settings 存起来"的写法都是错的。

**正确做法**：每次用时现读。

```js
export function apply(ctx, config) {
  // 设置页改值走运行期写引用，不重启也不重新 apply，必须每次现读。
  const readSettings = () => settingsOf(config)
  const initial = readSettings()          // 只用于挂载日志/档位校验
  /* ... */
  scope.on('llm/stream', (options, next) => {
    const settings = readSettings()       // ← 每个事件现读
    /* ... */
  })
}
```

### 3.3 不能为了省事去掉 `.volatile()`

**症状**：去掉 `.volatile()` 后 `apply` 确实收到普通值了，但设置页里这个插件的表单消失；客户端调 `update` 保存时报 `No volatile fields`。

**根因**：`dsh-settings` 的表单只收 volatile 字段（`volatileForm` 只遍历 volatile 子树）；非 volatile 字段改了也不会热生效，只能整体重挂载。

**正确做法**：字段保持 `.volatile()`，配 `Config` + 注册声明，读值走 3.1/3.2 的解引用与现读。

```js
export const Config = await configSchema()   // 取不到 schemastery 时可以不导出，插件照常工作

async function configSchema() {
  try {
    const { default: z } = await import('@deepseek-ai/schemastery')
    return z.object({
      enabled: z.boolean().default(true).volatile().description('给 Auto 审查补稳定缓存身份'),
      scope: z.union(['session', 'cwd']).default('session').volatile()
    })
  } catch {
    return undefined
  }
}

// apply 里声明本插件参与自动配置表单；同一个 fiber 只能声明一次，重复调会抛。
const declare = (scope) => scope.effect(() => scope.settings.configure({}, scope.fiber))
```

**验证办法**：不要靠"看起来对"。写一个离线脚本，用真的 schemastery 跑一遍 `Config['~standard'].validate(rawConfig)`，把每个字段的 `typeof` 打出来；引用字段会显示 `object`、`get()` 里才是值。再把设置页保存前后的行为各跑一次，确认第二次读到了新值。

## 4. `llm/stream` 拦截：同步、只派发一次、改写靠重新派发

**症状**（三条都能把会话打废）：

1. 插件一挂上，Auto 预设下所有工具调用都报 `Auto review of tool "X" failed`。
2. 想改 `options`（换模型、补字段），写成 `return next({ ...options, sessionId })`，下游没看到任何变化。
3. 观察日志发现后续监听器被跳过，或者审查没跑、工具直接执行了。

**根因**：

1. `llm/stream` 是 waterfall，审查方拿到返回值直接 `for await`。监听器写成 `async` 或返回 Promise，调用方立刻 `TypeError: ... is not async iterable`；审查侧把任何 rejection 折成 deny，于是变成**全部工具被硬拒**，而且不弹审批、不转人工、不重试（fail-closed）。同理，监听器里任何未捕获异常、返回 `undefined`、误改冻结对象，后果一样。
2. cordis 的 `next` 是在**原始参数**上闭包的，`next(newOptions)` 传入的新参数会被静默丢弃。
3. `next()` 内部是 `cbs.shift()`，调用第二次会跳过后续监听器；在判决型 waterfall 上等于直接放行。

**正确做法**：

```js
scope.on('llm/stream', (options, next) => {
  let call
  try {
    call = plan(options, readSettings())      // 纯函数，抛错也不外泄
  } catch {
    call = undefined
  }
  if (call === undefined) return next()       // 不改写：交回下游，且只调一次

  let stream
  try {
    stream = scope.llm.stream(call)           // 改写必须重新派发，不能用 next(newOptions)
  } catch {
    return next()
  }
  return stream                               // 原流返回，不包装、不过滤、不聚合
}, { global: true, prepend: true })
```

纪律清单：

- 监听器**不能是 async**，返回值必须是 stream 本身。
- 任何路径只调用一次 `next()`，或者只重新派发一次，不能两个都调。
- 守卫要用**幂等判据**（"目标字段已经在 → 放过"），不要用对象身份的 WeakSet 当唯一判据：嵌套派发每次都是新对象，身份判据会一路递归到 `RangeError`。
- 插件出错必须等价于"没有插件"：`try/catch` + 纯透传 + 幂等守卫，三条缺一不可。

**顺带一个死路**：不要试图用 `options.onPayload` 改请求体。pi-ai 三个适配器都支持它，但 `dsh-llm-pi-ai` 用白名单重建送给 pi-ai 的选项，`onPayload` 不在白名单里，从 `llm/stream` 上挂会被静默丢弃；monkey-patch `ctx.llm.stream` 或包 adapter 也改不到，参数对象是在绑定层内部重建的。要落到请求上，只能用绑定层认的字段（本例是 `sessionId` → `prompt_cache_key`）。

## 5. 会话身份：直接读 DSH 的发起者作用域

**症状**：在 `llm/stream` 监听器里 `options.sessionId`、`options.session`、`options.agent` 全是 `undefined`；想自己建一套 `tools/pre-execute` + `AsyncLocalStorage` 把会话带下去，又要处理注册顺序、HMR、漏挂。

**根因**：`llm/stream` 的 options 是审查方 `deepFreeze` 出来的固定形状，里面没有会话身份。但 DSH 自己已经有一个发起者作用域：`dsh-agent` 用 `node:async_hooks` 的 AsyncLocalStorage 保存当前 `agent`，而审查发生在 `tools/pre-execute` 的监听器里、`ctx.llm.stream` 之前，和工具执行是同一条 await 链。

**正确做法**：

```js
function currentSessionId(ctx) {
  try {
    const sessionId = ctx.get('agents')?.currentInitiator()?.session?.id
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
  } catch {
    return undefined
  }
}
```

- **必须包 `try`**：agents 服务 dispose 之后 `currentInitiator()` 会抛；这个异常要是漏到 `llm/stream` 外面，主对话那一侧会直接把整个 turn 打断。
- **读的时机放在确认命中之后**：`currentInitiator()` 每次都是真读 AsyncLocalStorage，主对话、压缩、标题这些请求不该为它付钱。
- **读不到就不注入，不要退回工作目录**：同一 cwd 下几十个互不相干的会话和子代理会塌成同一个身份，"稳定地错"比"没有"更危险，而且从日志和命中率上都看不出来。工作目录只能作为显式的 A/B 档。
- **不要原样外发会话 id**：身份用 `"<namespace>:" + sha256(id)[:32]`，既避开和后端 64 字符上限的冲突，也不把原始会话 id 写进请求。

## 6. 客户端设置分区与 remote 调用

**症状**：

1. 客户端里调 `ctx.remote.modelCatalog()` 报 `not a function`。
2. `await ctx.remote.settings.describe()` 拿到的东西当对象直接读 `ns`、`value`，全是 `undefined`。
3. 下拉框渲染出来一个选项都没有，但 state 里数据是有的。
4. 保存报冲突，或者提示"已保存"但页面上的值没变。
5. 下拉弹层白底白字，选项看不清。

**根因**：

1. `remote` 是命名空间树，不是平铺的方法集合：模型目录在 **session 命名空间**下（`ctx.remote.session.modelCatalog()`），依赖也要在 `inject` 里声明 `remote.session`。
2. RPC 返回值外面套了一层 `{ ok, value }` 信封，值在 `value` 里；`describe()` 的 `value` 是 `{ namespaces: [...] }`，每个 namespace 项才带 `ns` / `user` / `base` / `revision`。
3. `react.createElement` 的包装函数忘记转发 children：`h('select', props)` 这种写法会把所有 `option` 子节点吞掉，页面上只剩一个空下拉框。
4. `settings.update(ns, patch, revision)` 是 CAS：`revision` 必须来自最新的 `describe()`，过期会被拒绝；另外保存只写 volatile 字段（见第 3 节），而"保存后不重新 apply"意味着插件必须现读。
5. 原生 `<select>` 的弹层是浏览器自己绘制的，不继承父元素的背景色和文字色。

**正确做法**：

```js
// 注册一个设置分区
const inject = ['slots', 'remote', 'remote.session', 'remote.settings']

function apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'auto-review-cache-identity',
    order: 60,
    label: () => 'Auto 审查模型',
    inject: () => ({ remote: ctx.remote })
  }, Picker), 'auto-review-cache-identity: settings section')
}
```

```js
// 拆信封：兼容 {ok,value} 与直接返回，兼容 namespaces / forms / 对象三种形态
const asForm = (raw) => {
  const value = raw?.ok === true ? raw.value : raw
  const list = Array.isArray(value) ? value : value?.namespaces ?? value?.forms ?? Object.values(value ?? {})
  return list.find((item) => item?.ns === NS || String(item?.ns ?? item?.id ?? '').includes('auto-review-cache'))
}

// 读模型目录：注意 session 命名空间
const [catalog, read] = await Promise.all([remote.session.modelCatalog(), currentValue(remote)])
```

```js
// createElement 包装必须转发 children
const select = (props, ...children) => h('select', props, ...children)

// 原生弹层的选项要单独给主题色，且用 CSS 变量，不要在暗色里硬编码浅色
const OPTION = { background: 'var(--dsw-alias-bg-l2, #1b1c1e)', color: 'var(--dsw-alias-label-primary, #f7f8f8)' }
```

另外两条：`ctx.slots.inject(slotName, cb)` 的回调返回注册句柄，卸载时由槽位系统释放，不要自己在 `apply` 里重复注册；组件拿到的 props 是 `register.inject()` 返回的对象，不要假设能直接访问宿主服务。

## 7. 调试纪律：先打原始返回，再改代码

**症状**：看到"配置没生效 / 模型不对"就直接改代码，改了几轮之后发现值一直是对的——只是在走兜底默认值，而兜底默认值恰好等于配置值。之后又误判成"配置没送到"，再改一轮。

**根因**：兜底默认值和配置值相同时，任何日志都分不出"读到了配置"和"走了默认"。同样，只看线上命中率反推，会得出"改动已生效"的错误结论。

**正确做法**：

1. **先让程序把原始返回打出来，再改代码。** 配置字段的 `typeof` 与 `get()`、RPC 的原始 `{ok,value}`、每一条实际注入的 provider/model，全都先落盘或打在日志里。
2. **验收用与默认值不同的值。** 想证明"配置生效了"，就把配置改成一个和默认值**不一样**的值再看；一样就永远测不出来。
3. **挂载时打印解析后的关键配置。** 比如 `mounted (enabled=true, scope=session, review=magpie/group/x)`，比事后猜快得多；改配置后这行日志也应该跟着变。
4. **区分"临时诊断"和"仓库默认值"。** 绝对路径、`log: true`、`trace` 只在本机 profile 补丁里临时加，用完删掉；迁移/发布前检查 `cordis.patch.yml`，这些残留会跟着插件发出去，在别人机器上静默失败。
5. **客户端放一个"原始信息"折叠面板。** 排查"保存了但没生效"时直接看 `describe()` 的 JSON，比翻宿主日志快。
6. **离线验证台**：用迷你 cordis 复刻 `waterfall`/`next`/`inject` 的语义，用真的 `AsyncLocalStorage` 模拟发起者作用域，用假的 volatile 引用（带 `Symbol.for('cosmokit.volatile.write')`）模拟设置页原地写值。这样第 3～5 节的每条行为都能离线回归，不需要每次起 GUI。

## 速查

| 症状 | 一句话结论 |
|---|---|
| 配置像没生效，但日志说配置到了 | `.volatile()` 字段是 `{ get() }` 引用，先解引用 |
| 挂载时读对了，设置页改值后不变 | volatile-only 保存不重新 apply，必须每次现读 |
| 去掉 `.volatile()` 后表单消失、update 报 `No volatile fields` | 表单只收 volatile 字段，不能去掉 |
| Auto 预设下所有工具调用被拒 | `llm/stream` 监听器返回了 Promise / 抛错；改成同步 + 全 catch + 纯透传 |
| `next(newOptions)` 改不动请求 | `next` 在原始参数上闭包；改写要重新 `ctx.llm.stream(newOptions)` |
| 后续监听器被跳过 | `next()` 只能调用一次 |
| 想用 `onPayload` 改请求体 | 绑定层白名单会丢弃它，换绑定层认的字段 |
| `llm/stream` 里拿不到会话 | 读 `ctx.get('agents')?.currentInitiator()?.session?.id`，包 try |
| `ctx.remote.modelCatalog` 不存在 | 它在 `remote.session` 命名空间下 |
| 从 RPC 返回里读不到字段 | 先拆 `{ ok, value }` 信封，再拆 `namespaces` 数组 |
| 下拉框里的 option 全没了 | `createElement` 包装忘了转发 children |
| 保存提示冲突 | `update` 的 revision 必须来自最新 `describe()` |
| 原生下拉弹层颜色不对 | option 单独设 `background` / `color`，用主题 CSS 变量 |
| 改了几轮发现改动没生效 | 兜底默认值和配置值相同，验收要用不同的值 |
