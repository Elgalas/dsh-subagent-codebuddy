// CodeBuddy 子代理插件设置页。注册位点与官方带 UI 的插件一致:
// 「插件」侧栏页的 bundle 详情(plugins.bundle.config,key=包名)与行详情
// (plugins.row.config,key=`包名#条目 id`);表单命名空间 = profile 条目 id。
// primitives 缺失或组件抛错时退化自绘,避免槽位条目崩溃成空白。
// 检测/测试走 api.llm.discoverModels({settingsNs:'codebuddy', provider:'status'|'test'}),
// 服务端直接 spawn codebuddy CLI,不落会话。
window.__ModuleLoader__.load({
  id: '@elgalas/dsh-subagent-codebuddy',
  factory: (require) => {
    const NS_PACKAGE = '@elgalas/dsh-subagent-codebuddy'
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const slots = require('@deepseek-ai/dsh-client-ui-slots')
    // primitives 只在平台种子表里;一旦宿主版本变化导致 require 失败,
    // 或组件本身在渲染期抛错,整个槽位条目会被宿主判为崩溃并显示空白。
    // 这里退化成原生元素,保证设置页至少可读可编辑(文档 practices 也建议插件自绘)。
    let P = {}
    try {
      P = require('@deepseek-ai/dsh-client-ui-primitives') ?? {}
    } catch {
      P = {}
    }
    const pick = (name) => (typeof P[name] === 'function' ? P[name] : undefined)
    const Button = pick('Button') ?? function FallbackButton(props) {
      return react.createElement('button', {
        type: 'button',
        disabled: props.disabled === true,
        onClick: props.onClick,
        className: props.className,
        style: {
          font: 'inherit', fontSize: 12, padding: '3px 10px', borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: props.variant === 'primary' ? 'var(--dsw-alias-bg-module-platform)' : 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          cursor: props.disabled === true ? 'default' : 'pointer',
        },
      }, props.children)
    }
    const Input = pick('Input') ?? function FallbackInput(props) {
      return react.createElement('input', {
        type: props.type ?? 'text',
        value: props.value,
        placeholder: props.placeholder,
        onChange: props.onChange,
        onBlur: props.onBlur,
        className: props.className,
        style: {
          font: 'inherit', fontSize: 13, padding: '6px 8px', borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)',
        },
      })
    }
    const Modal = pick('Modal') ?? function FallbackModal(props) {
      if (props.open === false) return null
      return react.createElement('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 1000, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,.35)',
        },
      }, react.createElement('div', {
        style: {
          background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 12,
          padding: 16, minWidth: 320, maxWidth: '80vw',
        },
      }, props.children))
    }
    // 图标缺失时退化成 null 组件,避免 createElement(undefined) 抛错。
    const iconOf = (name) => pick(name) ?? function MissingIcon() { return null }
    const IconLoadingOutlineRegular = iconOf('IconLoadingOutlineRegular')
    const IconCheckOutlineRegular = iconOf('IconCheckOutlineRegular')
    const IconRefreshOutlineRegular = iconOf('IconRefreshOutlineRegular')
    const IconCopyOutlineRegular = iconOf('IconCopyOutlineRegular')
    const IconChevronDownOutlineMedium = iconOf('IconChevronDownOutlineMedium')
    const writeClipboard = typeof P.writeClipboard === 'function'
      ? P.writeClipboard
      : async (text) => { try { await navigator.clipboard.writeText(String(text)) } catch { /* 忽略 */ } }

    // ── 官方 PluginCard CSS(与 ui-settings-plugins 完全一致) ──
    const CSS = {
      card: '.dshCb_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}',
      cardHover: '.dshCb_card:hover{border-color:var(--dsw-alias-label-dimmed)}',
      cardOpen: '.dshCb_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      header: '.dshCb_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
      headerFocus: '.dshCb_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      headText: '.dshCb_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
      name: '.dshCb_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
      description: '.dshCb_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
      chevron: '.dshCb_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}',
      chevronOpen: '.dshCb_chevronOpen{transform:rotate(180deg)}',
      body: '.dshCb_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
      page: '.dshCb_page{display:flex;flex-direction:column}',
      field: '.dshCb_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
      fieldTop: '.dshCb_field+.dshCb_field{border-top:1px solid var(--dsw-alias-border-l2)}',
      fieldHead: '.dshCb_fieldHead{align-items:center;gap:8px;display:flex}',
      label: '.dshCb_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',
      hint: '.dshCb_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
      badge: '.dshCb_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
      code: '.dshCb_code{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:6px 10px;font-size:12px}',
      pre: '.dshCb_pre{margin:8px 0 0;white-space:pre-wrap;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:8px 10px}',
      row: '.dshCb_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 0}',
      // 模型输入框:铺满卡片宽度;min-width:0 避免 flex 项被内容撑爆导致超出卡片
      modelField: '.dshCb_modelField{display:flex;width:100%;min-width:0;box-sizing:border-box}.dshCb_modelField input{flex:1;min-width:0;width:100%;box-sizing:border-box}',
      // 获取模型弹窗列表:抄 Menu.module.css 的菜单卡片 + 行样式
      pickerList: '.dshCb_pickerList{box-sizing:border-box;padding:4px;display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);max-height:60vh;overflow-y:auto}',
      pickerItem: '.dshCb_pickerItem{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:none;border-radius:10px;background:transparent;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);text-align:left}.dshCb_pickerItem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      pickerLabel: '.dshCb_pickerLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      pickerCheck: '.dshCb_pickerCheck{flex:none;color:var(--dsw-alias-label-primary)}',
      // 模型优先顺序列表
      orderList: '.dshCb_orderList{display:flex;flex-direction:column;gap:6px}',
      orderRow: '.dshCb_orderRow{display:flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:6px 8px;font-size:13px}',
      orderIndex: '.dshCb_orderIndex{flex:none;width:18px;text-align:center;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px}',
      orderName: '.dshCb_orderName{flex:1;min-width:0;display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
      // 思考强度 chip
      chips: '.dshCb_chips{display:flex;flex-wrap:wrap;gap:6px}',
      chip: '.dshCb_chip{appearance:none;font:inherit;font-size:12px;line-height:18px;padding:3px 10px;border-radius:999px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2)}.dshCb_chip:hover{border-color:var(--dsw-alias-label-dimmed)}',
      chipOn: '.dshCb_chipOn{appearance:none;font:inherit;font-size:12px;line-height:18px;padding:3px 10px;border-radius:999px;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-brand-primary)}',
    }
    const cssText = Object.values(CSS).join('')
    const tagId = `${NS_PACKAGE}/plugin-card.css`
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = NS_PACKAGE
      tag.dataset.pluginCss = tagId
      tag.textContent = cssText
      document.head.appendChild(tag)
    }
    const C = {
      card: 'dshCb_card', cardOpen: 'dshCb_cardOpen', header: 'dshCb_header',
      headText: 'dshCb_headText', name: 'dshCb_name', description: 'dshCb_description',
      chevron: 'dshCb_chevron', chevronOpen: 'dshCb_chevronOpen', body: 'dshCb_body',
      page: 'dshCb_page',
      field: 'dshCb_field', fieldHead: 'dshCb_fieldHead', label: 'dshCb_label',
      hint: 'dshCb_hint', badge: 'dshCb_badge', code: 'dshCb_code',
      pre: 'dshCb_pre', row: 'dshCb_row', modelField: 'dshCb_modelField',
      pickerList: 'dshCb_pickerList', pickerItem: 'dshCb_pickerItem',
      pickerLabel: 'dshCb_pickerLabel', pickerCheck: 'dshCb_pickerCheck',
      orderList: 'dshCb_orderList', orderRow: 'dshCb_orderRow', orderIndex: 'dshCb_orderIndex',
      orderName: 'dshCb_orderName', chips: 'dshCb_chips', chip: 'dshCb_chip', chipOn: 'dshCb_chipOn',
    }

    // 安装命令 + 工具说明
    const INSTALL_CMDS = [
      { label: 'npm (global)', cmd: 'npm install -g @tencent-ai/codebuddy-code' },
    ]
    const TOOLS = [
      { name: 'subagent_codebuddy (opt-in)', desc: '委派独立任务给 CodeBuddy 子代理(独立进程 + 自带工具;continuable 可复用长线会话;可选 model 参数动态指定模型)——在上方开关开启后注册,推荐用通用 subagent 工具' },
      { name: 'list_codebuddy_models (opt-in)', desc: '列出 CodeBuddy CLI 当前支持的模型 id,委派前先查询再传准确 id;通用工具的模型目录由模型选择器/list_subagent_models 提供' },
    ]

    // 思考强度档位(与 codebuddy CLI `--effort` 一致:minimal…max)
    const EFFORT_OPTIONS = [
      { id: '', label: '默认' },
      { id: 'minimal', label: 'minimal' },
      { id: 'low', label: 'low' },
      { id: 'medium', label: 'medium' },
      { id: 'high', label: 'high' },
      { id: 'xhigh', label: 'xhigh' },
      { id: 'max', label: 'max' },
    ]

    /** 安装命令行:label + code + 复制按钮(带已复制状态)。 */
    function InstallCommandRow({ label, cmd }) {
      const [copied, setCopied] = react.useState(false)
      const copy = react.useCallback(async () => {
        try { await writeClipboard(cmd) } catch { /* 剪贴板失败静默 */ }
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }, [cmd])
      return react.createElement('div', { className: C.field },
        react.createElement('div', { className: C.fieldHead },
          react.createElement('span', { className: C.label }, label),
          react.createElement('span', { className: C.hint, style: { fontFamily: 'var(--dsw-font-family-code, monospace)' } }, cmd),
          react.createElement(Button, {
            size: 'sm', variant: 'ghost', onClick: copy,
            icon: copied
              ? react.createElement(IconCheckOutlineRegular, { size: 12 })
              : react.createElement(IconCopyOutlineRegular, { size: 12 }),
          }, copied ? '已复制' : '复制'),
        ),
      )
    }

    function CodebuddyCard(props) {
      // 列表摘要视图:一句话(官方 ItemCard 的 description 渲染此返回值)。
      if (props.view === 'summary') return 'CodeBuddy 作为主模型与子代理 provider:模型优先顺序/思考强度/配额降级、默认模型、工具桥配置、检测与安装说明'
      const [checking, setChecking] = react.useState(false)
      const [testing, setTesting] = react.useState(false)
      const [statusText, setStatusText] = react.useState('')
      const [testText, setTestText] = react.useState('')
      const scope = props.scope

      // 走 api.llm.discoverModels:服务端 registerModelDiscovery 直接 spawn codebuddy,不落会话。
      const runProbe = react.useCallback(async (_provider, setOut, setBusy) => {
        setBusy(true)
        setOut('状态/测试探测在 0.1.2 插件设置页暂不可用(需会话级 remote);字段编辑正常。')
        setBusy(false)
      }, [])

      const onStatus = react.useCallback(() => runProbe('status', setStatusText, setChecking), [runProbe])
      const onTest = react.useCallback(() => runProbe('test', setTestText, setTesting), [runProbe])

      // 默认模型:字符串输入 + "获取模型"弹窗选择(models 探测取可选列表)。
      // catalog = 可选模型清单(展示名带倍率);order = 子代理优先顺序(第一项即默认)。
      const [catalog, setCatalog] = react.useState([])
      const [currentModel, setCurrentModel] = react.useState('')
      const [savedModel, setSavedModel] = react.useState('')
      const [order, setOrder] = react.useState([])
      const [effort, setEffort] = react.useState('')
      const [fallbackOnQuota, setFallbackOnQuota] = react.useState(true)
      const [detailText, setDetailText] = react.useState('')
      const [loadingModels, setLoadingModels] = react.useState(false)
      const [pickerOpen, setPickerOpen] = react.useState(false)
      // 旧版自定义子代理工具开关(registerSubagentTools,默认关闭)。
      const [legacyTools, setLegacyTools] = react.useState(false)
      // 工具桥接模式:MCP(默认)开 / delegate 旧通道关。
      const [mcpBridge, setMcpBridge] = react.useState(true)

      // 初始值与明细:走 settings.describe(结构化、经网关校验;不走 discoverModels,
      // 避免响应 schema 校验失败导致解析出垃圾值)。
      const loadConfig = react.useCallback(async () => {
        try {
          const v = scope.getSnapshot().value ?? {}
          const model = v.model ?? ''
          setCurrentModel(model)
          setSavedModel(model)
          // 优先顺序:空表时用单模型兜底(旧配置/首装都是这种状态)。
          const configured = Array.isArray(v.models)
            ? v.models.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
            : []
          setOrder(configured.length > 0 ? configured : (model === '' ? [] : [model]))
          setEffort(typeof v.defaultEffort === 'string' ? v.defaultEffort : '')
          setFallbackOnQuota(v.fallbackOnQuota !== false)
          setLegacyTools(v.registerSubagentTools === true)
          setMcpBridge(v.bridgeMode !== 'delegate')
          setDetailText(`命令:${v.command ?? 'codebuddy'} | 权限:${v.permissionMode ?? 'bypassPermissions'} | 工具桥:${v.bridgeMode === 'delegate' ? 'delegate' : 'mcp'}`)
        } catch { /* 忽略 */ }
      }, [scope])

      const loadModels = react.useCallback(async () => {
        setLoadingModels(true)
        setCatalog([])
        try {
          // 自建模型列表路由(见服务端 models-route.ts):插件卡槽位拿不到
          // 会话级 remote,llm.discoverModels 对插件卡不可达。
          const resp = await fetch('/api/subagent-codebuddy/models', { headers: { accept: 'application/json' } })
          const data = await resp.json()
          if (data?.ok === true) {
            // 目录条目带倍率(`DeepSeek-V4.1-Flash · x0.11`),但写回设置的必须是 id。
            setCatalog((data.models ?? [])
              .filter((m) => typeof m?.id === 'string' && m.id !== '')
              .map((m) => ({ id: m.id, name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id })))
          }
        } catch { /* 加载失败保持现状 */ } finally {
          setLoadingModels(false)
        }
      }, [])

      react.useEffect(() => {
        // 只加载存储的历史值,不自动拉取模型列表(点"获取模型"时才请求)。
        loadConfig()
      }, [loadConfig])

      // 提交优先顺序:写 `models` 数组,同时把第一项写进 `model`(兼容只读
      // `model` 的旧代码路径);空表 = 两项都 unset,回落 schema 默认。
      const writeOrder = react.useCallback(async (next) => {
        const list = next.filter((id) => typeof id === 'string' && id.trim() !== '')
        try {
          if (list.length === 0) {
            await scope.unset('models')
            await scope.unset('model')
          } else {
            await scope.set('models', list)
            await scope.set('model', list[0])
          }
          setOrder(list)
          setCurrentModel(list[0] ?? '')
          setSavedModel(list[0] ?? '')
        } catch { /* 写失败回读还原 */ }
        loadConfig()
      }, [scope, loadConfig])

      /** 默认模型输入框:非空 = 设为顺序首位,空 = 移除首位。 */
      const writeModel = react.useCallback(async (value) => {
        const trimmed = value.trim()
        if (trimmed === '') return writeOrder(order.slice(1))
        return writeOrder([trimmed, ...order.filter((id) => id !== trimmed)])
      }, [order, writeOrder])

      /** 优先顺序里加一个模型(已存在则忽略;追加到末尾)。 */
      const addToOrder = react.useCallback((id) => {
        if (typeof id !== 'string' || id === '' || order.includes(id)) return
        return writeOrder([...order, id])
      }, [order, writeOrder])

      /** 顺序里上移/下移一项。 */
      const moveInOrder = react.useCallback((index, delta) => {
        const target = index + delta
        if (target < 0 || target >= order.length) return
        const next = order.slice()
        const [item] = next.splice(index, 1)
        next.splice(target, 0, item)
        return writeOrder(next)
      }, [order, writeOrder])

      /** 从顺序里移除一项。 */
      const removeFromOrder = react.useCallback((index) => {
        return writeOrder(order.filter((_id, i) => i !== index))
      }, [order, writeOrder])

      /** 思考强度:写字符串,空 = unset(不传 --effort)。 */
      const writeEffort = react.useCallback(async (value) => {
        setEffort(value)
        try {
          if (value === '') await scope.unset('defaultEffort')
          else await scope.set('defaultEffort', value)
        } catch { /* 写失败回读还原 */ }
        loadConfig()
      }, [scope, loadConfig])

      /** 配额降级开关:开 = set(true),关 = set(false)(schema 默认 true,不能用 unset 表达"关")。 */
      const toggleFallback = react.useCallback(async () => {
        const next = !fallbackOnQuota
        setFallbackOnQuota(next)
        try {
          await scope.set('fallbackOnQuota', next)
        } catch { /* 写失败回读还原 */ }
        loadConfig()
      }, [fallbackOnQuota, scope, loadConfig])

      // 旧版工具开关:开 = set(true),关 = unset(回落 schema 默认 false)。
      const toggleLegacyTools = react.useCallback(async () => {
        const next = !legacyTools
        setLegacyTools(next)
        try {
          if (next) await scope.set('registerSubagentTools', true)
          else await scope.unset('registerSubagentTools')
        } catch { /* 写失败回读还原 */ }
        loadConfig()
      }, [legacyTools, scope, loadConfig])

      // 工具桥开关:显式写入 'mcp' / 'delegate'(用户层显式值优先于配置兜底;
      // 此前"开=unset"在插件行配置为 delegate 时无法切回 MCP)。
      const toggleMcpBridge = react.useCallback(async () => {
        const next = !mcpBridge
        setMcpBridge(next)
        try {
          await scope.set('bridgeMode', next ? 'mcp' : 'delegate')
        } catch { /* 写失败回读还原 */ }
        loadConfig()
      }, [mcpBridge, scope, loadConfig])

      // 手动输入:输入时只更新本地,失焦提交;与已保存值一致时跳过。
      const onModelInput = react.useCallback((e) => setCurrentModel(e.target.value), [])
      const onModelBlur = react.useCallback(() => {
        const value = currentModel.trim()
        if (value === savedModel) return
        writeModel(value)
      }, [currentModel, savedModel, writeModel])

      // 弹窗选择:打开时若未加载则拉取列表。
      const openPicker = react.useCallback(async () => {
        setPickerOpen(true)
        if (catalog.length === 0) loadModels()
      }, [catalog.length, loadModels])
      // 弹窗是多选框:点一项即追加到优先顺序末尾(已存在则只关闭提示,不重复加)。
      const pickFromList = react.useCallback((value) => {
        addToOrder(value)
      }, [addToOrder])

      // 表单未注入时(插件页配置服务不可用/条目 id 不匹配)给一句可读提示,
      // 不要因为 scope 为 undefined 在 effect 里抛错而整块空白。
      if (scope === undefined || scope === null) {
        return react.createElement('p', { className: C.hint, style: { padding: '12px 0' } },
          '配置表单未注入:请确认插件已启用,并在「插件」页的 CodeBuddy 条目里打开设置。')
      }

      // 详情页:直接铺开字段(官方 plugins.item 详情页自带标题与说明,不画卡片头)。
      return react.createElement('div', { className: C.page },
          // 检测与测试
          react.createElement('div', { className: C.row },
            react.createElement(Button, {
              size: 'md', onClick: onStatus, disabled: checking,
              icon: checking
                ? react.createElement(IconLoadingOutlineRegular, { size: 14 })
                : react.createElement(IconRefreshOutlineRegular, { size: 14 }),
            }, checking ? '检测中...' : '检测安装/登录'),
            react.createElement(Button, {
              size: 'md', onClick: onTest, disabled: testing,
              icon: testing ? react.createElement(IconLoadingOutlineRegular, { size: 14 }) : undefined,
            }, testing ? '测试中...' : '测试(回复 hi)'),
          ),
          react.createElement('p', { className: C.hint }, '若已安装仍提示未安装,请重启 dsh 服务(PATH 生效后需重启)'),
          statusText !== '' && react.createElement('pre', { className: C.pre }, statusText),
          testText !== '' && react.createElement('pre', { className: C.pre }, testText),

          // 默认模型:字符串输入 + "获取模型"弹窗选择
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '默认模型'),
              react.createElement(Button, {
                size: 'sm', variant: 'ghost', onClick: openPicker, disabled: loadingModels,
                icon: loadingModels
                  ? react.createElement(IconLoadingOutlineRegular, { size: 12 })
                  : react.createElement(IconRefreshOutlineRegular, { size: 12 }),
              }, loadingModels ? '获取中...' : '获取模型'),
            ),
            react.createElement(Input, {
              type: 'text', value: currentModel, onChange: onModelInput, onBlur: onModelBlur,
              placeholder: '输入模型 id',
              className: C.modelField,
            }),
            detailText !== '' && react.createElement('p', { className: C.hint, style: { fontFamily: 'var(--dsw-font-family-code, monospace)' } }, detailText),
            react.createElement('p', { className: C.hint }, '可直接输入模型 id(失焦保存),或点"获取模型"从弹窗选择;作为委派子代理的默认模型(实时生效);主会话可直接在模型选择器中选择 CodeBuddy 的任意模型'),
          ),

          // 子代理模型优先顺序:第一项即默认,配额失败时按顺序降级
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '模型优先顺序'),
              react.createElement(Button, {
                size: 'sm', variant: 'ghost', onClick: openPicker, disabled: loadingModels,
                icon: loadingModels
                  ? react.createElement(IconLoadingOutlineRegular, { size: 12 })
                  : react.createElement(IconRefreshOutlineRegular, { size: 12 }),
              }, loadingModels ? '获取中...' : '添加模型'),
            ),
            order.length === 0
              ? react.createElement('p', { className: C.hint }, '尚未设置;子代理将使用上面的默认模型')
              : react.createElement('div', { className: C.orderList },
                  order.map((id, i) => {
                    const meta = catalog.find((m) => m.id === id)
                    return react.createElement('div', { key: id, className: C.orderRow },
                      react.createElement('span', { className: C.orderIndex }, String(i + 1)),
                      react.createElement('span', { className: C.orderName, title: id },
                        meta === undefined ? id : meta.name,
                        i === 0 && react.createElement('span', { className: C.badge }, '默认'),
                      ),
                      react.createElement(Button, {
                        size: 'sm', variant: 'ghost', disabled: i === 0,
                        onClick: () => moveInOrder(i, -1),
                      }, '↑'),
                      react.createElement(Button, {
                        size: 'sm', variant: 'ghost', disabled: i === order.length - 1,
                        onClick: () => moveInOrder(i, 1),
                      }, '↓'),
                      react.createElement(Button, {
                        size: 'sm', variant: 'ghost',
                        onClick: () => removeFromOrder(i),
                      }, '✕'),
                    )
                  }),
                ),
            react.createElement('p', { className: C.hint },
              '委派子代理按此顺序选择模型:第一项为默认。开启下方"配额降级"后,当前模型返回 429/额度受限且本回合还没有任何产出时,自动换下一个继续(需要新开 CodeBuddy 会话,故只在该回合零产出时降级)。'),
          ),

          // 子代理默认思考强度
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '子代理默认思考强度'),
            ),
            react.createElement('div', { className: C.chips },
              EFFORT_OPTIONS.map((opt) => react.createElement('button', {
                key: opt.id === '' ? 'default' : opt.id,
                type: 'button',
                className: effort === opt.id ? C.chipOn : C.chip,
                onClick: () => writeEffort(opt.id),
              }, opt.label)),
            ),
            react.createElement('p', { className: C.hint },
              '传给 CodeBuddy CLI 的 --effort:未指定时由模型/CLI 自行决定;具体模型支持哪些档位见模型选择器的推理强度菜单(目录里没声明的模型不会显示档位)。'),
          ),

          // 配额降级开关
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '配额降级(自动换模型)'),
              react.createElement(Button, {
                size: 'sm',
                variant: fallbackOnQuota ? undefined : 'ghost',
                onClick: toggleFallback,
              }, fallbackOnQuota ? '已开启(点按关闭)' : '已关闭(点按开启)'),
            ),
            react.createElement('p', { className: C.hint },
              '开启后:本回合零产出时遇到配额/限流(429、bizCode 6004 等),按上面的优先顺序换下一个模型重试;已产生文本或工具调用的回合不降级,避免重复执行。关闭则配额失败直接报错。'),
          ),

          // 旧版子代理工具开关(默认关闭,实时生效)
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '旧版子代理工具'),
              react.createElement(Button, {
                size: 'sm',
                variant: legacyTools ? undefined : 'ghost',
                onClick: toggleLegacyTools,
              }, legacyTools ? '已开启(点按关闭)' : '已关闭(点按开启)'),
            ),
            react.createElement('p', { className: C.hint },
              '提供 subagent_codebuddy / list_codebuddy_models 自定义工具;默认关闭——推荐用通用 subagent 工具(provider: codebuddy + 模型选择)。开启/关闭对新会话生效。'),
          ),

          // 工具桥接模式(MCP / delegate,默认 MCP;新回合生效)
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '工具桥(MCP)'),
              react.createElement(Button, {
                size: 'sm',
                variant: mcpBridge ? undefined : 'ghost',
                onClick: toggleMcpBridge,
              }, mcpBridge ? '已开启(点按退回 delegate)' : '已关闭(点按启用 MCP)'),
            ),
            react.createElement('p', { className: C.hint },
              'MCP:dsh 起 HTTP MCP server,CLI 每回合连接,工具以 mcp__dsh__<工具名> 呈现(完整 schema,推荐)。delegate:旧 DelegateTool 通道(dsh_<工具名>,回退用)。切换对新回合生效。'),
          ),

          // 安装命令
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '安装命令'),
            ),
            react.createElement('p', { className: C.hint }, 'CodeBuddy CLI 由 Tencent 维护,npm 全局安装即可'),
          ),
          ...INSTALL_CMDS.map((item) => react.createElement(InstallCommandRow, { key: item.label, label: item.label, cmd: item.cmd })),

          // 工具说明
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '工具说明'),
            ),
            react.createElement('ul', { style: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 } },
              TOOLS.map((t) => react.createElement('li', { key: t.name, className: C.hint },
                react.createElement('strong', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t.name), ' — ', t.desc,
              )),
            ),
          ),

          // 获取模型弹窗:官方 Modal(模糊遮罩/Escape/标题/关闭) + Menu 样式列表
          react.createElement(Modal, {
            open: pickerOpen,
            onClose: () => setPickerOpen(false),
            title: '添加到优先顺序(可多选)',
            closeLabel: '完成',
          },
            loadingModels && catalog.length === 0
              ? react.createElement('p', { className: C.hint }, '加载中...')
              : catalog.length === 0
                ? react.createElement('p', { className: C.hint }, '未获取到模型列表,请确认 CodeBuddy CLI 已安装')
                : react.createElement('div', { className: C.pickerList },
                    catalog.map((m) => react.createElement('button', {
                      key: m.id,
                      type: 'button',
                      className: C.pickerItem,
                      onClick: () => pickFromList(m.id),
                    },
                      react.createElement('span', { className: C.pickerLabel }, m.name),
                      order.includes(m.id) && react.createElement(IconCheckOutlineRegular, { className: C.pickerCheck, size: 14 }),
                    )),
                  ),
          ),
      )
    }

    // 槽位条目渲染抛错时宿主只打一行 console 并把条目显示为空白,
    // 用户侧就变成"看不到设置面板"。用错误边界把异常转成可见文本。
    class CardBoundary extends react.Component {
      constructor(props) {
        super(props)
        this.state = { error: undefined }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      render() {
        if (this.state.error !== undefined) {
          const text = this.state.error && this.state.error.message
            ? this.state.error.message
            : String(this.state.error)
          return react.createElement('p', { className: C.hint, style: { padding: '12px 0' } },
            `CodeBuddy 设置面板渲染失败:${text}`)
        }
        return this.props.children
      }
    }

    function CardShell(props) {
      return react.createElement(CardBoundary, null, react.createElement(CodebuddyCard, props))
    }

    function apply(ctx) {
      // 设置表单的命名空间 = profile 条目 id(dsh-settings 的 describe 按 entry id 编号)。
      const FORM_NS = 'subagent-codebuddy'
      // 插件页的配置位点按「包名」与「包名#条目 id」编号,见 dsh-client-ui-plugin-manager
      // 的 bundleConfigKey / rowConfigKey;注册键必须与宿主传的 entryKey 完全一致,
      // 否则卡片既不出现在包详情,也不出现在条目详情。
      const BUNDLE_KEY = NS_PACKAGE
      const ROW_KEY = `${NS_PACKAGE}#${FORM_NS}`

      ctx.inject(['configForms'], (child) => {
        const forms = child.configForms
        if (forms === undefined || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') {
          return
        }
        const scope = forms.get(FORM_NS)
        const sectionInject = () => ({ scope })
        const keep = (slot, key) => child.effect(() => {
          return forms.whileServed([FORM_NS], () => {
            return child.slots.inject(slot, () => {
              return child.slots.register({
                name: slot,
                key,
                locale: FORM_NS,
                inject: sectionInject,
              }, CardShell)
            })
          })
        }, `subagent-codebuddy-client: ${slot}`)
        keep('plugins.row.config', ROW_KEY)
        keep('plugins.bundle.config', BUNDLE_KEY)
      })
    }

    exports.apply = apply
    exports.inject = ['slots', 'configForms']
    exports.name = 'subagent-codebuddy-client'
    return module.exports
  },
})
