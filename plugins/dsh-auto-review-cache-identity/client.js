/**
 * 设置页分区：给 Auto 审查挑一个固定模型。
 *
 * 客户端插件就是一段工厂函数，React 由 loader 注入，不需要打包构建。
 * 读模型目录与读写设置都走 ctx.remote，返回的是 RPC 信封，取值前先拆。
 *
 * @module @x-mug/dsh-auto-review-cache-identity/client
 */
window.__ModuleLoader__.load({
  id: '@x-mug/dsh-auto-review-cache-identity',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement
    const NS = 'local-auto-review-cache-identity'

    // 完整打印原始数据，不截断。
    const pretty = (value) => {
      try {
        return JSON.stringify(value, (key, item) => item instanceof Map ? Object.fromEntries(item) : item, 2)
      } catch {
        return String(value)
      }
    }

    // RPC 外层套 {ok,value}，分组字段也可能换名。
    const groupsOf = (catalog) => {
      const data = catalog?.ok === true ? catalog.value : catalog
      const list = Array.isArray(data) ? data
        : data?.groups ?? data?.providers ?? data?.value?.groups ?? data?.value?.providers ?? []
      return (Array.isArray(list) ? list : []).map((group, index) => {
        const isText = typeof group === 'string'
        const id = isText ? group : group?.id ?? group?.provider ?? group?.name ?? `#${index}`
        return {
          id: String(id),
          name: String(isText ? group : group?.name ?? group?.label ?? id),
          models: (isText ? [] : group?.models ?? group?.children ?? []).map((model) => typeof model === 'string'
            ? { id: model, name: model }
            : { id: String(model?.id ?? model?.name ?? model), name: String(model?.name ?? model?.label ?? model?.id ?? model) })
        }
      })
    }

    // describe 返回 {ok, value:{namespaces:[...]}}，取出本插件那一份表单。
    const asForm = (raw) => {
      const value = raw?.ok === true ? raw.value : raw
      const list = Array.isArray(value) ? value
        : value?.namespaces ?? value?.forms ?? Object.values(value ?? {})
      const match = (item) => item !== null && typeof item === 'object'
        && (item.ns === NS || String(item.ns ?? item.id ?? '').includes('auto-review-cache'))
      return (list ?? []).find(match)
    }

    // 读当前表单值；用户层没有写入时回落 schema 默认值（空字符串 = 跟随主对话）。
    const currentValue = async (remote) => {
      const raw = await remote.settings.describe()
      const form = asForm(raw)
      const of = (layer) => ({
        reviewProvider: typeof layer?.reviewProvider === 'string' ? layer.reviewProvider : '',
        reviewModel: typeof layer?.reviewModel === 'string' ? layer.reviewModel : ''
      })
      return { value: of(form?.user), layers: raw === undefined ? 'undefined' : raw }
    }

    const row = (label, control) => h('label', { style: { display: 'flex', gap: '12px', alignItems: 'center' } },
      h('span', { style: { width: '84px', fontSize: '13px', color: 'var(--dsw-alias-label-primary, inherit)' } }, label),
      control)

    // createElement 的包装必须把 children 转发出去，否则 option 全被吞掉。
    const select = (props, ...children) => h('select', props, ...children)

    // 原生弹层默认白底，选项要自己带主题色。
    const OPTION = { background: 'var(--dsw-alias-bg-l2, #1b1c1e)', color: 'var(--dsw-alias-label-primary, #f7f8f8)' }

    function Picker({ remote }) {
      const [groups, setGroups] = react.useState([])
      const [draft, setDraft] = react.useState({ reviewProvider: '', reviewModel: '' })
      const [status, setStatus] = react.useState('')
      const [layers, setLayers] = react.useState(null)

      react.useEffect(() => {
        let live = true
        const load = async () => {
          try {
            // modelCatalog 挂在 session 命名空间下，不在 remote 根上。
            const [catalog, read] = await Promise.all([remote.session.modelCatalog(), currentValue(remote)])
            if (!live) return
            setGroups(groupsOf(catalog))
            setDraft(read.value)
            setLayers(read.layers)
            setStatus('')
          } catch (error) {
            if (live) setStatus(`读取失败：${error?.message ?? error}`)
          }
        }
        load()
        return () => { live = false }
      }, [])

      const models = groups.find((group) => group.id === draft.reviewProvider)?.models ?? []
      const save = async () => {
        try {
          // 写入是 CAS：expectedRevision 来自 describe，过期会被拒绝。
          await remote.settings.update(NS, draft, asForm(await remote.settings.describe())?.revision)
          setStatus('已保存')
        } catch (error) {
          setStatus(`保存失败：${error?.message ?? error}`)
        }
      }

      const S = {
        card: { display: 'flex', flexDirection: 'column', gap: '14px', boxSizing: 'border-box', width: '100%', maxWidth: '100%', padding: '20px 24px',
          background: 'transparent', border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22))', borderRadius: '10px' },
        title: { margin: 0, fontSize: '16px', fontWeight: 600, letterSpacing: '-0.2px', color: 'var(--dsw-alias-label-primary, inherit)' },
        sub: { margin: 0, fontSize: '13px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))' },
        label: { width: '84px', fontSize: '13px', color: 'var(--dsw-alias-label-primary, inherit)' },
        field: { width: '280px', boxSizing: 'border-box', height: '32px', padding: '0 8px', fontSize: '13px', color: 'inherit',
          background: 'var(--dsw-alias-bg-l1, rgba(127,127,127,0.08))', border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))',
          borderRadius: '6px', outline: 'none' },
        button: { height: '32px', padding: '0 14px', fontSize: '13px', fontWeight: 500, color: '#ffffff',
          background: '#5e6ad2', border: '1px solid #5e69d1', borderRadius: '6px', cursor: 'pointer' },
        status: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))' },
        details: { marginTop: '2px', paddingTop: '14px', borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22))' },
        summary: { cursor: 'pointer', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))' },
        pre: { margin: '10px 0 0', padding: '12px', maxHeight: '320px', overflow: 'auto', fontSize: '11px',
          lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))',
          background: 'rgba(127,127,127,0.08)', border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22))', borderRadius: '8px' }
      }

      return h('div', { style: S.card },
        h('h3', { style: S.title }, 'Auto 审查模型'),
        h('p', { style: S.sub }, '固定 Auto 审查使用的模型；留空则跟随主对话。模型必须能按审查协议返回，否则审查失败会直接拒绝工具调用。'),
        row('供应商', select({
          style: S.field,
          value: draft.reviewProvider,
          onChange: (event) => setDraft({ reviewProvider: event.target.value, reviewModel: '' })
        }, h('option', { value: '', style: OPTION }, '跟随主对话'),
          groups.map((group) => h('option', { key: group.id, value: group.id, style: OPTION }, group.name ?? group.id)))),
        row('模型', select({
          style: S.field,
          value: draft.reviewModel,
          onChange: (event) => setDraft({ ...draft, reviewModel: event.target.value })
        }, h('option', { value: '', style: OPTION }, '跟随主对话'),
          models.map((model) => h('option', { key: model.id, value: model.id, style: OPTION }, model.name ?? model.id)))),
        h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', paddingTop: '2px' } },
          h('button', { type: 'button', style: S.button, onClick: save }, '保存'),
          h('span', { style: S.status }, status)),
        h('details', { style: S.details },
          h('summary', { style: S.summary }, '设置原始信息'),
          h('pre', { style: S.pre }, pretty(layers))))
    }

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

    return { apply, inject }
  }
})
