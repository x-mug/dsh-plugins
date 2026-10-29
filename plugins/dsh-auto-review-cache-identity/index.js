/**
 * 给内置 Auto 审查的模型调用补一个稳定缓存身份。
 *
 * @deepseek-ai/dsh-experimental-auto-review 的 classifyRisk 造请求时只给
 * provider/model/system/messages/temperature/signal，没有 sessionId，
 * pi-ai 因此把 prompt_cache_key 发成 undefined，缓存键每轮都变。
 *
 * 会话身份直接读 DSH 自己的 initiator 作用域：
 * 审查发生在工具调用链里，agents.currentInitiator() 就是 exec.agent。
 * 读不到就不注入，原样放过。
 *
 * 只加 sessionId 一个字段，system/messages/temperature 与其余字段逐字节不变。
 *
 * @module @local/dsh-auto-review-cache-identity
 */
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'

/** Cordis 插件名，bundle patch 用同一个 id 挂载。 */
export const name = 'auto-review-cache-identity'

/** 没有硬依赖：agents / llm / settings 都按可选服务访问。 */
export const inject = []

/**
 * 设置页表单的字段定义。
 *
 * 声明了它，DSH 就会为这个插件生成原生配置表单，改动写回 profile 补丁。
 * 取不到 schemastery 时不导出，插件照常工作，只是没有表单。
 */
export const Config = await configSchema()

/**
 * 尽量拿到 schemastery 并声明字段。
 *
 * @returns 表单 schema，依赖缺失时为 undefined。
 */
async function configSchema() {
  try {
    const { default: z } = await import('@deepseek-ai/schemastery')
    return z.object({
      enabled: z.boolean().default(true).volatile().description('给 Auto 审查补稳定缓存身份'),
      scope: z.union(['session', 'cwd']).default('session').volatile().description('缓存身份按会话还是按工作目录'),
      reviewProvider: z.string().default('').volatile().description('Auto 审查固定使用的供应商，留空跟随主对话'),
      reviewModel: z.string().default('').volatile().description('Auto 审查固定使用的模型 id，留空跟随主对话')
    })
  } catch {
    return undefined
  }
}

/** 审查策略的固定首行。 */
const POLICY_HEAD = 'REVIEW_POLICY\n'
/** 审查策略的固定句，确认首行不是别家的同名前缀。 */
const POLICY_MARK = 'You are the final authorization reviewer for exactly one pending tool call.'
/** 审查正文的环境段开头。 */
const ENVIRONMENT_HEAD = 'ENVIRONMENT\n\n'
/** 审查正文的工程指令段分隔符。 */
const PROJECT_SECTION = '\n\nPROJECT_INSTRUCTIONS\n\n'
/** 审查正文的待审动作段分隔符。 */
const ACTION_SECTION = '\n\nPENDING_ACTION\n\n'
/** 注入键的命名空间，避免和真实会话 id 撞车。 */
const KEY_PREFIX = 'auto-review:'
/** 摘要截断长度，加上命名空间仍远低于后端 64 字符上限。 */
const HASH_LENGTH = 32
/** 本插件自己造的调用，重新派发时直接放过。 */
const OWN_CALLS = new WeakSet()

// dsh-llm 会标记 agent loop 的正常对话请求，这条判据能把主对话整类排除。
let isAgentLoopRequest
try {
  const llm = await import('@deepseek-ai/dsh-llm')
  isAgentLoopRequest = typeof llm.isAgentLoopRequest === 'function' ? llm.isAgentLoopRequest : undefined
} catch {
  isAgentLoopRequest = undefined
}

/**
 * 读当前执行上下文里的发起会话。
 *
 * 服务被 dispose 后 currentInitiator 会抛，这里按"拿不到"处理。
 *
 * @param ctx - Cordis 插件上下文。
 * @returns 会话 id，不在任何发起者作用域内时为 undefined。
 */
function currentSessionId(ctx) {
  try {
    const sessionId = ctx.get('agents')?.currentInitiator()?.session?.id
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
  } catch {
    return undefined
  }
}

/**
 * 判断一次 llm 调用是不是 Auto 审查。
 *
 * @param options - waterfall 上拿到的原始请求。
 * @returns 是否命中审查特征。
 */
function isReview(options) {
  if (options === null || typeof options !== 'object') return false
  if (options.temperature !== 0) return false
  const system = options.system
  if (typeof system !== 'string') return false
  if (!system.startsWith(POLICY_HEAD) || !system.includes(POLICY_MARK)) return false
  const messages = options.messages
  if (!Array.isArray(messages) || messages.length !== 1) return false
  const message = messages[0]
  if (message === null || typeof message !== 'object' || message.role !== 'user') return false
  const content = message.content
  if (!Array.isArray(content) || content.length !== 1) return false
  const block = content[0]
  if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') return false
  const text = block.text
  return text.startsWith(ENVIRONMENT_HEAD) && text.includes(PROJECT_SECTION) && text.includes(ACTION_SECTION)
}

/**
 * 读审查正文的唯一文本块。
 *
 * @param options - 已判定为审查的请求。
 * @returns 拼好的四段正文。
 */
function reviewText(options) {
  return options.messages[0].content[0].text
}

/**
 * 从环境段读出工作目录。
 *
 * @param text - 审查正文。
 * @returns 工作目录，段缺失或不是合法 JSON 时为 undefined。
 */
function reviewCwd(text) {
  const body = text.slice(ENVIRONMENT_HEAD.length)
  const end = body.indexOf(PROJECT_SECTION)
  if (end < 0) return undefined
  let value
  try {
    value = JSON.parse(body.slice(0, end))
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  return typeof value.cwd === 'string' && value.cwd !== '' ? value.cwd : undefined
}

/**
 * 把一段作用域文本压成定长摘要。
 *
 * @param text - 作用域文本。
 * @returns 十六进制摘要。
 */
function digest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, HASH_LENGTH)
}

/** 作用域档位：决定哪些审查共用同一条缓存。 */
const SCOPES = {
  // 只认发起者会话，读不到就不注入，不退回 cwd。
  session: (options, sessionKey) => sessionKey,
  // 工作目录档，只给 A/B 显式用。
  cwd: (options) => reviewCwd(reviewText(options))
}

/**
 * 算出审查的稳定缓存身份。
 *
 * 加一档新作用域只需在这里加一个读函数，调用方不用改。
 *
 * @param options - 已判定为审查的请求。
 * @param scope - 设置里的档位名。
 * @param sessionKey - 当前执行上下文里的会话 id。
 * @returns 身份键，档位未知或作用域为空时为 undefined。
 */
function resolveIdentity(options, scope, sessionKey) {
  const read = SCOPES[scope]
  if (read === undefined) return undefined
  const value = read(options, sessionKey)
  if (value === undefined) return undefined
  return KEY_PREFIX + digest(value)
}

/**
 * 换入稳定身份，只加 sessionId。
 *
 * dsh-llm-pi-ai 把这一个字段翻成 pi-ai 的 sessionId，
 * 再由 pi-ai 写到 prompt_cache_key；其它字段逐字节带走。
 *
 * @param options - 原始审查请求。
 * @param identity - 稳定身份键。
 * @param override - 审查固定路由，未配置时为 undefined。
 * @returns 冻结的新请求。
 */
function rewrite(options, identity, override) {
  const next = { ...options }
  if (identity !== undefined) next.sessionId = identity
  if (override !== undefined) {
    next.provider = override.provider
    next.model = override.model
  }
  return Object.freeze(next)
}

/**
 * 决定这次调用要不要改写。
 *
 * 廉价判据先跑，确认是审查之后才去读会话身份。
 *
 * @param options - waterfall 上拿到的原始请求。
 * @param settings - 已解析的设置。
 * @param readSessionKey - 取会话 id 的函数，只在确认是审查后调用。
 * @returns 改写后的新请求，不动时为 undefined。
 */
function plan(options, settings, readSessionKey) {
  if (settings.enabled !== true) return undefined
  if (options === null || typeof options !== 'object') return undefined
  // 主闸：注入成功后 sessionId 非空，二次进入必然不再匹配。
  if (options.sessionId !== undefined) return undefined
  if (OWN_CALLS.has(options)) return undefined
  if (isAgentLoopRequest?.(options) === true) return undefined
  if (!isReview(options)) return undefined
  const sessionKey = settings.scope === 'session' ? readSessionKey() : undefined
  const identity = resolveIdentity(options, settings.scope, sessionKey)
  const override = reviewRoute(settings)
  if (identity === undefined && override === undefined) return undefined
  return rewrite(options, identity, override)
}

/**
 * 读设置，缺项落回默认值。
 *
 * @param config - bundle patch 送进来的配置。
 * @returns 冻结的设置快照。
 */
function settingsOf(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  return Object.freeze({
    enabled: plain(source.enabled) !== false,
    scope: typeof plain(source.scope) === 'string' && plain(source.scope) !== '' ? plain(source.scope) : 'session',
    log: plain(source.log) === true,
    // 诊断用：设成文件路径后，每次注入追加一行 JSON。默认配置不带它。
    trace: typeof plain(source.trace) === 'string' && plain(source.trace) !== '' ? plain(source.trace) : undefined,
    // 审查固定路由；设置页写的是扁平两字段，也兼容嵌在 review 段里的写法。
    review: routeOf({ provider: plain(source.reviewProvider), model: plain(source.reviewModel) }) ?? routeOf(source.review)
  })
}

/**
 * 取出可变配置的真值。
 *
 * volatile 字段传进来是 cosmokit 引用，必须解引用才拿得到值。
 *
 * @param value - 配置原始值。
 * @returns 解引用后的值。
 */
function plain(value) {
  return value !== null && typeof value === 'object' && Symbol.for('cosmokit.volatile.write') in value ? value.get() : value
}

/**
 * 校验一次路由覆盖，两个字段都非空才算数。
 *
 * @param value - 配置里的 review 段。
 * @returns 冻结的 provider/model，字段不全时为 undefined。
 */
function routeOf(value) {
  if (value === null || typeof value !== 'object') return undefined
  const provider = typeof value.provider === 'string' && value.provider !== '' ? value.provider : undefined
  const model = typeof value.model === 'string' && value.model !== '' ? value.model : undefined
  return provider === undefined || model === undefined ? undefined : Object.freeze({ provider, model })
}

/**
 * 审查当前的固定路由。
 *
 * @param settings - 已解析的设置。
 * @returns 冻结的 provider/model，未配置时为 undefined。
 */
function reviewRoute(settings) {
  return settings.review
}

/**
 * 挂到 llm/stream 上，只动审查请求。
 *
 * @param ctx - Cordis 插件上下文。
 * @param config - bundle patch 送进来的配置。
 */
export function apply(ctx, config) {
  // 设置页改值走运行期写引用，不重启也不重新 apply，必须每次现读。
  const readSettings = () => settingsOf(config)
  const initial = readSettings()
  if (SCOPES[initial.scope] === undefined) {
    ctx.logger?.warn(`[auto-review-cache-identity] unknown scope "${initial.scope}"; injection stays off`)
    return
  }
  ctx.logger?.info(`[auto-review-cache-identity] mounted (enabled=${initial.enabled}, scope=${initial.scope}, review=${initial.review === undefined ? 'inherit' : `${initial.review.provider}/${initial.review.model}`})`)

  let injected = 0
  let identityMisses = 0
  let identityMissLogged = false
  const noteIdentityMiss = () => {
    identityMisses += 1
    if (identityMissLogged) return
    identityMissLogged = true
    ctx.logger?.warn('[auto-review-cache-identity] Auto review has no initiator session; this call was left untouched')
  }

  const declareSettings = (scope) => {
    try {
      // 声明本插件参与自动配置表单；同一个 fiber 只能声明一次。
      scope.effect(() => scope.settings.configure({}, scope.fiber))
    } catch {
      // 没有设置表单的宿主照常工作。
    }
  }
  try {
    if (ctx.get('settings') !== undefined) declareSettings(ctx)
    else ctx.inject(['settings'], declareSettings)
  } catch {
    // 设置表单是可选项，取不到就算了。
  }

  ctx.inject(['llm'], (scope) => {
    // 处理器必须同步返回流：返回 Promise 会让调用方直接 TypeError。
    scope.on('llm/stream', (options, next) => {
      // 只有确认是审查才去读发起者会话，主对话、压缩、标题不付这个开销。
      let asked = false
      let sessionKey
      const readSessionKey = () => {
        asked = true
        sessionKey = currentSessionId(ctx)
        return sessionKey
      }
      let call
      let settings
      try {
        settings = readSettings()
        call = plan(options, settings, readSessionKey)
      } catch {
        call = undefined
      }
      if (call === undefined) {
        if (asked && sessionKey === undefined) noteIdentityMiss()
        return next()
      }
      OWN_CALLS.add(call)
      // next() 靠 cbs.shift() 前进，任何路径都只能调一次；重放会跳过后续监听器。
      let stream
      try {
        stream = scope.llm.stream(call)
      } catch {
        return next()
      }
      injected += 1
      if (settings?.trace !== undefined) {
        try {
          appendFileSync(settings.trace, `${JSON.stringify({
            at: new Date().toISOString(),
            key: call.sessionId,
            provider: call.provider,
            model: call.model
          })}\n`)
        } catch {
          // 诊断写入失败不影响审查。
        }
      }
      if (settings?.log) {
        ctx.logger?.info(`[auto-review-cache-identity] injected=${injected} key=${call.sessionId} identityMisses=${identityMisses}`)
      }
      return stream
    }, { global: true, prepend: true })
  })
}

/** 纯函数导出，离线验证台直接用。 */
export const _internal = { isReview, reviewText, reviewCwd, resolveIdentity, rewrite, plan, currentSessionId, routeOf, reviewRoute, settingsOf, SCOPES }
