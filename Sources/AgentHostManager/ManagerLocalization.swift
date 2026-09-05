import Foundation

enum ManagerLanguage: String, CaseIterable, Identifiable {
    static let storageKey = "agentHostManagerLanguage"

    case system
    case english
    case simplifiedChinese

    var id: String { rawValue }

    var locale: Locale {
        switch self {
        case .system: .autoupdatingCurrent
        case .english: Locale(identifier: "en")
        case .simplifiedChinese: Locale(identifier: "zh-Hans")
        }
    }

    var title: String {
        switch self {
        case .system: L10n.text("System Default")
        case .english: "English"
        case .simplifiedChinese: "简体中文"
        }
    }
}

enum L10n {
    static var locale: Locale {
        switch selectedLanguage {
        case .system:
            return usesSimplifiedChinese ? Locale(identifier: "zh-Hans") : .autoupdatingCurrent
        case .english:
            return Locale(identifier: "en")
        case .simplifiedChinese:
            return Locale(identifier: "zh-Hans")
        }
    }

    static func text(_ english: String) -> String {
        guard usesSimplifiedChinese else { return english }
        return simplifiedChinese[english] ?? english
    }

    static func format(_ english: String, _ replacements: [String: String]) -> String {
        replacements.reduce(text(english)) { value, entry in
            value.replacingOccurrences(of: "{\(entry.key)}", with: entry.value)
        }
    }

    static func relativeAge(since date: Date, now: Date = Date()) -> String {
        let age = max(0, now.timeIntervalSince(date))
        if age < 60 { return text("just now") }
        if age < 3_600 { return format("{count}m ago", ["count": Int(age / 60).formatted()]) }
        if age < 86_400 { return format("{count}h ago", ["count": Int(age / 3_600).formatted()]) }
        return format("{count}d ago", ["count": Int(age / 86_400).formatted()])
    }

    private static var usesSimplifiedChinese: Bool {
        switch selectedLanguage {
        case .simplifiedChinese: true
        case .english: false
        case .system: Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") == true
        }
    }

    private static var selectedLanguage: ManagerLanguage {
        UserDefaults.standard.string(forKey: ManagerLanguage.storageKey)
            .flatMap(ManagerLanguage.init(rawValue:)) ?? .system
    }

    private static let simplifiedChinese: [String: String] = [
        "System Default": "跟随系统",
        "General": "通用",
        "Language": "语言",
        "Environment": "环境",
        "Tools": "工具",
        "Agent Apps": "Agent 应用",
        "Usage & Reliability": "使用情况与可靠性",
        "Activity": "活动",
        "Settings": "设置",
        "OK": "确定",
        "Check": "检查",
        "Repair": "修复",
        "Update": "更新",
        "Run Full Check": "运行完整检查",
        "Review Repair": "查看修复方案",
        "Review Update": "查看更新方案",
        "Run a full environment check": "运行完整的环境检查",
        "Repair the installed environment": "修复已安装的环境",
        "Check for compatible updates": "检查兼容更新",
        "Replace Conflicting Installation": "替换冲突的安装",
        "Replace Conflicting Connection": "替换冲突的连接",
        "Working": "处理中",
        "Checking": "检查中",
        "Ready": "就绪",
        "Running": "运行中",
        "Complete": "完整",
        "Stale": "已过期",
        "Unavailable": "不可用",
        "Installed": "已安装",
        "Not set up": "未设置",
        "Agent environment": "Agent 环境",
        "Health": "健康状态",
        "Current environment": "当前环境",
        "Tool set": "工具集",
        "Agent apps": "Agent 应用",
        "Local execution": "本地执行",
        "Status checked": "状态检查时间",
        "Refreshing…": "正在刷新…",
        "Storage · live processes": "存储 · 活跃进程",
        "Tool catalog": "工具目录",
        "Your environment is ready": "环境已就绪",
        "Your local environment is ready": "本地环境已就绪",
        "Open a fresh task in a connected Agent app to use the installed tools.": "请在已连接的 Agent 应用中打开新任务以使用已安装工具。",
        "Connected Agent apps are configured. Run Full Check when you want to verify their current bindings.": "已配置连接的 Agent 应用；需要核验当前绑定时可运行完整检查。",
        "Run a full check to identify the affected tool or Agent app.": "运行完整检查以定位受影响的工具或 Agent 应用。",
        "Available in connected Agent apps": "可供已连接的 Agent 应用使用",
        "Check All": "检查全部",
        "Start a fresh Agent task": "请启动新的 Agent 任务",
        "New tasks load this tool selection. Tasks already open keep the tools they started with.": "新任务会载入当前工具选择；已打开的任务保留启动时的工具。",
        "Context cost": "上下文成本",
        "Available": "可用",
        "Make {tool} available in Agent apps": "让 Agent 应用可使用 {tool}",
        "Where your tools are available": "工具可用的位置",
        "Start a fresh task after changes": "更改后请启动新任务",
        "Agent apps load installed tool catalogs when a new task starts.": "Agent 应用会在新任务启动时载入已安装的工具目录。",
        "Disconnect this Agent app?": "断开此 Agent 应用？",
        "Disconnect": "断开连接",
        "Cancel": "取消",
        "Agent Host removes only integrations it created. Existing user-owned integrations are preserved.": "Agent Host 只移除由它创建的集成，保留用户已有的集成。",
        "Inspection unavailable": "无法检查",
        "Not installed": "未安装",
        "Connect": "连接",
        "Checking this Mac": "正在检查这台 Mac",
        "Connected · needs attention": "已连接 · 需要处理",
        "Connected · bindings verified": "已连接 · 绑定已验证",
        "Connected · run Full Check to verify bindings": "已连接 · 运行完整检查以验证绑定",
        "Detected on this Mac": "已在这台 Mac 上检测到",
        "Changes made to this environment": "此环境的变更",
        "No activity yet": "尚无活动",
        "Install, update, repair, and connection changes appear here.": "安装、更新、修复及连接变更会显示在这里。",
        "Local monitoring is off": "本地监控已关闭",
        "Turn on local monitoring in Settings to collect metadata-only activity and reliability observations.": "在设置中开启本地监控，以采集仅含元数据的活动和可靠性观测。",
        "Showing the last completed refresh": "正在显示上次完成的刷新",
        "The live monitoring snapshot is temporarily unavailable. No stale result is presented as current.": "实时监控快照暂时不可用；旧结果不会被标记为当前结果。",
        "Agent activity": "Agent 活动",
        "No supported Agent activity was observed in this window.": "在此时间范围内未观测到受支持的 Agent 活动。",
        "Sessions": "会话",
        "Turns": "轮次",
        "Active days": "活跃天数",
        "Reported tokens": "报告的 Token",
        "Claude totals exclude separately reported cache-read tokens.": "Claude 总量不含单独报告的缓存读取 Token。",
        "Observed outcomes": "已观测结果",
        "Measured calls": "已测量调用",
        "Completed": "已完成",
        "Errors": "错误",
        "Cancelled": "已取消",
        "Outcome counts cover mapped Agent Host tools with provider-reported runtime state; an unmeasured call is not treated as success.": "结果计数覆盖具有 Provider 运行状态的已映射 Agent Host 工具；未测量的调用不视为成功。",
        "Most used Agent Host tools": "最常用的 Agent Host 工具",
        "Agent trace coverage": "Agent 轨迹覆盖",
        "Retained trace sessions": "保留的轨迹会话",
        "Choose one Agent app to list locally retained metadata, then export one session for analysis.": "选择一个 Agent 应用，列出本地保留的元数据，再导出一个会话用于分析。",
        "No trace adapters are available.": "没有可用的轨迹适配器。",
        "Load sessions": "载入会话",
        "No retained sessions for this Agent app.": "此 Agent 应用没有保留的会话。",
        "{events} events · last observed {date}": "{events} 个事件 · 最后观测于 {date}",
        "Export metadata": "导出元数据",
        "Showing the newest {count} retained sessions.": "正在显示最近的 {count} 个保留会话。",
        "Retained for {days} days. Earlier or pre-monitoring events may be missing; completeness is unknown.": "保留 {days} 天。更早或启用监控前的事件可能缺失，完整性未知。",
        "Exports contain metadata only: no prompts, reasoning, tool arguments, tool results, source paths, or interpretation.": "导出内容仅含元数据：不含提示词、推理、工具参数、工具结果、来源路径或解释性判断。",
        "Model steps": "模型步骤",
        "Tool offers": "工具已提供",
        "Trace tool calls": "轨迹工具调用",
        "Trace tool results": "轨迹工具结果",
        "Turn endings": "轮次结束",
        "Public events": "公开事件",
        "Official hooks": "官方 Hook",
        "Local records": "本机记录",
        "Aggregate usage": "聚合用量",
        "Offered, called, and returned are separate recorded facts. They do not establish why a tool was chosen, whether its result was adopted, or whether the work was correct.": "工具已提供、已调用和已返回是彼此独立的记录事实；它们不能说明为何选择工具、结果是否被采纳，也不能证明工作正确。",
        "No mapped Agent Host tool calls were observed in this window.": "在此时间范围内未观测到已映射的 Agent Host 工具调用。",
        "calls": "次调用",
        "Historical calls are observations, not proof of adoption, correctness, task quality, or value.": "历史调用只是观测，不能证明采纳、正确性、任务质量或价值。",
        "What monitoring can tell you": "监控能够说明什么",
        "Tool calls": "工具调用",
        "Runtime outcomes": "运行结果",
        "Token usage": "Token 用量",
        "Skill activation": "Skill 激活",
        "Result adoption": "结果采纳",
        "Why a tool was not used": "未使用工具的原因",
        "Observed": "已观测",
        "Partially observed": "部分观测",
        "No observations": "无观测",
        "Not observed": "未观测",
        "No prompts, tool arguments, tool results, or source paths are returned. The Observer makes no model calls and performs no causal or quality assessment.": "不会返回提示词、工具参数、工具结果或源码路径。Observer 不调用模型，也不做因果或质量判断。",
        "Current": "当前",
        "Partial": "部分",
        "Needs attention": "需要处理",
        "Unknown": "未知",
        "Overdue": "已逾期",
        "Cached": "缓存结果",
        "Freshness unknown": "新鲜度未知",
        "Local metadata only": "仅本地元数据",
        "Set up your Agent environment": "设置 Agent 环境",
        "Install one verified local environment for your Agent app.": "为 Agent 应用安装一套经过验证的本地环境。",
        "Standard tools": "标准工具",
        "Reliable calculation and time conversion": "可靠计算与时区转换",
        "Local service": "本地服务",
        "Keeps installed tools ready on this Mac": "让已安装工具在这台 Mac 上保持就绪",
        "Agent app": "Agent 应用",
        "Review Setup": "查看设置方案",
        "Local monitoring stays off until you turn it on.": "本地监控会保持关闭，直到你主动开启。",
        "Install Agent Environment": "安装 Agent 环境",
        "Background service": "后台服务",
        "Will be installed": "将会安装",
        "A new Agent task will be required": "需要启动新的 Agent 任务",
        "The current task keeps its loaded catalog. Open a fresh task after this change.": "当前任务保留已载入的目录；更改后请打开新任务。",
        "Install": "安装",
        "Selected": "已选择",
        "Standard": "标准",
        "Standard + Monitoring": "标准 + 监控",
        "Standard + Local tools": "标准 + 本地工具",
        "Monitoring": "监控",
        "Local tool monitoring": "本地工具监控",
        "Stores counts and timings locally. Prompts, tool arguments, and tool results are not stored or uploaded.": "在本地保存计数与耗时；不保存或上传提示词、工具参数和工具结果。",
        "Switch to Standard + Monitoring before turning monitoring off.": "关闭监控前请切换到“标准 + 监控”。",
        "Tool Set": "工具集",
        "Review Standard + Monitoring…": "查看“标准 + 监控”方案…",
        "Review Local Tool Set…": "查看本地工具集方案…",
        "Turn on local monitoring first so this expanded local tool set can measure reliability and usage on this Mac.": "请先开启本地监控，以便扩展工具集测量这台 Mac 上的可靠性与使用情况。",
        "Recovery": "恢复",
        "Review Previous Version…": "查看上一版本…",
        "Remove": "移除",
        "Uninstall Agent Host…": "卸载 Agent Host…",
        "You can preserve recovery history or remove Agent Host packages, monitoring data, and retained recovery data. Existing user-owned integrations are never removed.": "你可以保留恢复历史，或移除 Agent Host 软件包、监控数据与恢复数据；不会移除用户已有的集成。",
        "Turn on local monitoring?": "开启本地监控？",
        "Turn On": "开启",
        "A local check runs periodically and stores operational metadata on this Mac. It does not upload prompts or tool contents.": "本地检查会定期运行并在这台 Mac 上保存运行元数据，不会上传提示词或工具内容。",
        "Uninstall Agent Host?": "卸载 Agent Host？",
        "Uninstall and Keep History": "卸载并保留历史",
        "Uninstall and Delete Agent Host Data": "卸载并删除 Agent Host 数据",
        "Agent integrations and background services created by Agent Host will be removed. Deleting Agent Host data also removes retained packages and recovery history.": "将移除 Agent Host 创建的 Agent 集成和后台服务；删除 Agent Host 数据还会移除保留的软件包与恢复历史。"
        ," and ": "、"
        ,"A connected Agent app is no longer installed": "一个已连接的 Agent 应用已不再安装"
        ,"Agent Host will install the Standard tools, connect them to {app}, and start local execution.": "Agent Host 将安装标准工具、连接到 {app} 并启动本地执行。"
        ,"Agent apps checked": "已检查的 Agent 应用"
        ,"Agent tool availability": "Agent 工具可用性"
        ,"Available in {apps}": "可用于 {apps}"
        ,"Catalog measurement": "目录测量"
        ,"Changes": "变更"
        ,"Components changing": "变更的组件"
        ,"Conflicting copies with the same verified identity will be replaced. Agent Host records what it displaced so uninstall can restore it.": "将替换具有相同已验证身份的冲突副本；Agent Host 会记录被替换内容，以便卸载时恢复。"
        ,"Connected apps are configured · Run Full Check to verify bindings": "已配置连接的应用 · 运行完整检查以验证绑定"
        ,"Connected apps have current bindings": "已连接应用的绑定为当前版本"
        ,"Direct execution": "直接执行"
        ,"Install {name} before connecting it": "请先安装 {name}，再进行连接"
        ,"Installed tool runtimes are ready": "已安装的工具运行时已就绪"
        ,"Installed Agent tool": "已安装的 Agent 工具"
        ,"No measurement (monitoring off or not refreshed)": "无测量结果（监控已关闭或尚未刷新）"
        ,"Not available in an Agent app": "尚不可用于 Agent 应用"
        ,"Not configured": "未配置"
        ,"Observed locally over the last {days} days": "最近 {days} 天的本地观测"
        ,"Off": "已关闭"
        ,"On, but no collection result has been recorded": "已开启，但尚未记录采集结果"
        ,"Over budget: {items}": "超出预算：{items}"
        ,"Reconnect to retained package": "重新连接到保留的软件包"
        ,"Restore retained configuration": "恢复保留的配置"
        ,"Restore version": "恢复版本"
        ,"Run a health check": "运行健康检查"
        ,"Stopped": "已停止"
        ,"The local execution service and direct probes are ready": "本地执行服务与直接探测已就绪"
        ,"Top {shown} of {available}": "显示前 {shown} 项，共 {available} 项"
        ,"Unknown tool": "未知工具"
        ,"Use {app} for setup": "使用 {app} 进行设置"
        ,"Within declared budgets": "在声明的预算内"
        ,"{count} Agent operation": "{count} 个 Agent 操作"
        ,"{count} Agent operations": "{count} 个 Agent 操作"
        ,"{size} catalog": "目录 {size}"
        ,"largest operation {size}": "最大操作 {size}"
        ,"budget {size}": "预算 {size}"
        ,"OVER BUDGET ({count})": "超出预算（{count}）"
        ,"{count} live suite process": "{count} 个活跃 Suite 进程"
        ,"{count} live suite processes": "{count} 个活跃 Suite 进程"
        ,"{size} resident": "常驻内存 {size}"
        ,"Workspace access": "工作区访问"
        ,"just now": "刚刚"
        ,"last run {status}": "上次运行状态：{status}"
        ,"no refresh time recorded": "未记录刷新时间"
        ,"refresh time is in the future": "刷新时间位于未来"
        ,"refreshed {age}": "刷新于 {age}"
        ,"refreshed {age} (stale)": "刷新于 {age}（已过期）"
        ,"unknown": "未知"
        ,"{app} entries": "{app} 条目"
        ,"{count} items need attention": "{count} 项需要处理"
        ,"{count} sources incomplete": "{count} 个来源不完整"
        ,"{count} source incomplete": "{count} 个来源不完整"
        ,"{count}d ago": "{count} 天前"
        ,"{count}h ago": "{count} 小时前"
        ,"{count}m ago": "{count} 分钟前"
        ,"{item} needs attention": "{item}需要处理"
        ,"A complete previous version is not available to restore.": "没有可供恢复的完整上一版本。"
        ,"A required tool package is unavailable in this build. Install a verified release or repair the tool package, then try again.": "此构建缺少必需的工具软件包。请安装已验证版本或修复工具软件包后重试。"
        ,"Agent Host took too long to complete this action. Try again; if it repeats, run a full check.": "Agent Host 完成此操作用时过长。请重试；若再次发生，请运行完整检查。"
        ,"Turn on local monitoring before loading or exporting retained trace sessions.": "请先开启本地监控，再载入或导出保留的轨迹会话。"
        ,"The installed monitoring component cannot read retained trace sessions. Update or repair Agent Host, then try again.": "已安装的监控组件无法读取保留的轨迹会话。请更新或修复 Agent Host 后重试。"
        ,"This retained trace session is no longer available.": "此保留的轨迹会话已不可用。"
        ,"No retained trace events remain in the selected time range.": "所选时间范围内已没有保留的轨迹事件。"
        ,"Agent Host could not prepare a verified trace export. Run a full check, then try again.": "Agent Host 无法准备经过验证的轨迹导出。请运行完整检查后重试。"
        ,"Another Agent Host local execution service is already configured. Open that installation or remove it before setting up again.": "已配置另一个 Agent Host 本地执行服务。请打开该安装，或移除后重新设置。"
        ,"Claude Code has a conflicting tool installation that Agent Host left unchanged. Replace it with the managed installation to continue.": "Claude Code 中存在冲突的工具安装，Agent Host 未对其修改。请替换为托管安装后继续。"
        ,"Claude Code is not installed or cannot be found on this Mac.": "这台 Mac 上未安装或无法找到 Claude Code。"
        ,"Codex has a conflicting tool installation that Agent Host left unchanged. Replace it with the managed installation to continue.": "Codex 中存在冲突的工具安装，Agent Host 未对其修改。请替换为托管安装后继续。"
        ,"Codex is not installed or cannot be found on this Mac.": "这台 Mac 上未安装或无法找到 Codex。"
        ,"No verified Agent Host release is available yet.": "目前没有可用的已验证 Agent Host 版本。"
        ,"The local execution service cannot be installed safely. Remove the conflicting service entry, then try again.": "无法安全安装本地执行服务。请移除冲突的服务条目后重试。"
        ,"The saved Agent Host state is unreadable, so Agent Host left the environment unchanged. Restore a known-good Agent Host backup before trying again.": "已保存的 Agent Host 状态不可读取，因此环境未被修改。请先恢复已知良好的 Agent Host 备份。"
        ,"ZCode has a conflicting tool installation that Agent Host left unchanged. Replace it with the managed installation to continue.": "ZCode 中存在冲突的工具安装，Agent Host 未对其修改。请替换为托管安装后继续。"
        ,"ZCode is not installed or cannot be found on this Mac.": "这台 Mac 上未安装或无法找到 ZCode。"
        ,"{toolSet} on this Mac": "这台 Mac 上的{toolSet}"
        ,"A new {app} task will be required": "需要启动新的 {app} 任务"
        ,"Open a fresh task after setup so {app} can load the installed tools.": "设置后请启动新的 {app} 任务，以载入已安装工具。"
        ,"Exact and scientific calculation": "精确与科学计算"
        ,"Reliable worldwide time conversion": "可靠的全球时间转换"
        ,"Confirm Environment Check": "确认环境检查"
        ,"Confirm Environment Update": "确认环境更新"
        ,"Confirm Restore": "确认恢复"
        ,"The compatibility set is already current. Confirm to refresh its Agent app connections and local service.": "兼容性集合已是当前版本。确认后将刷新 Agent 应用连接与本地服务。"
        ,"Agent Host will activate one complete compatibility set. The retained current set remains available for restore.": "Agent Host 将激活一套完整兼容性集合；当前集合会保留以便恢复。"
        ,"Agent Host will activate the most recently retained complete set.": "Agent Host 将激活最近保留的完整集合。"
        ,"Refresh Connections": "刷新连接"
        ,"Restore": "恢复"
        ,"Checked": "已检查"
        ,"Available tools": "可用工具"
        ,"Kept installed": "保留安装"
        ,"Updated": "已更新"
        ,"Tool": "工具"
        ,"Version": "版本"
        ,"Replaced version": "被替换版本"
        ,"Availability": "可用性"
        ,"Local data": "本地数据"
        ,"Removed": "已移除"
        ,"Preserved": "已保留"
        ,"Recovery copy": "恢复副本"
        ,"Old monitoring records removed": "已移除的旧监控记录"
        ,"Storage recovered": "已释放存储"
        ,"Local monitoring turned on": "已开启本地监控"
        ,"Local monitoring turned off": "已关闭本地监控"
        ,"Local observation and package storage maintained": "已维护本地观测与软件包存储"
        ,"Standard tools installed": "已安装标准工具"
        ,"Environment checked for updates": "已检查环境更新"
        ,"Environment updated": "环境已更新"
        ,"Previous environment restored": "已恢复上一环境"
        ,"Agent tool availability changed": "Agent 工具可用性已更改"
        ,"Agent Host removed": "已移除 Agent Host"
        ,"{app} connected": "{app} 已连接"
        ,"{app} disconnected": "{app} 已断开连接"
        ,"Preparing setup": "正在准备设置"
        ,"Loading trace sessions": "正在载入轨迹会话"
        ,"Preparing trace export": "正在准备轨迹导出"
        ,"Installing standard tools": "正在安装标准工具"
        ,"Preparing restore": "正在准备恢复"
        ,"Repairing environment": "正在修复环境"
        ,"Updating environment": "正在更新环境"
        ,"Restoring previous version": "正在恢复上一版本"
        ,"Turning on monitoring": "正在开启监控"
        ,"Turning off monitoring": "正在关闭监控"
        ,"Disconnecting Agent app": "正在断开 Agent 应用"
        ,"Connecting Agent app": "正在连接 Agent 应用"
        ,"Making tool available": "正在启用工具"
        ,"Removing tool from Agent apps": "正在从 Agent 应用移除工具"
        ,"Removing Agent Host": "正在移除 Agent Host"
        ,"Running full check": "正在运行完整检查"
        ,"Checking environment": "正在检查环境"
        ,"Managed by Agent Host": "由 Agent Host 管理"
        ,"Kept in this environment": "保留在此环境中"
        ,"Installed by you": "由你安装"
        ,"Exact and reliability-sensitive calculation": "精确且对可靠性敏感的计算"
        ,"Time-zone conversion with daylight-saving rules": "支持夏令时规则的时区转换"
        ,"Inspect, reshape, validate, and compare structured data": "检查、重塑、验证与比较结构化数据"
        ,"Choose project-aware icons without redrawing them": "选择感知项目的图标，无需重新绘制"
        ,"Create, inspect, search, and revise Markdown mind maps": "创建、检查、搜索与修改 Markdown 思维导图"
        ,"Compose, inspect, render, and emit explicit projective planes": "组合、检查、渲染并输出明确的投影平面"
        ,"Interpret specification-dense standard expressions deterministically": "确定性解释规范密集的标准表达式"
        ,"Inspect and inventory files before acting on them": "操作文件前先检查并建立清单"
        ,"Peak UTC day": "UTC 单日峰值"
        ,"Current streak": "当前连续天数"
        ,"Longest streak": "最长连续天数"
        ,"{days} active UTC days · session span is not chat duration": "{days} 个活跃 UTC 日 · 会话跨度不等于聊天时长"
        ,"{date} · {tokens} tokens · {calls} tool calls": "{date} · {tokens} Token · {calls} 次工具调用"
        ,"Daily activity for the latest observed UTC days": "最近已观测 UTC 日的每日活动"
    ]
}
