import Foundation

struct ToolLogo: Decodable, Equatable, Sendable {
    let path: String?
    let absolutePath: String?
    let mediaType: String?
    let sha256: String?
    let bytes: Int?
    let dataUrl: String?
    let source: String?
}

struct ComponentSummary: Decodable, Equatable, Sendable {
    let version: String
    let displayName: String?
    let summary: String?
    let author: String?
    let homepage: String?
    let logo: ToolLogo?

    init(
        version: String,
        displayName: String? = nil,
        summary: String? = nil,
        author: String? = nil,
        homepage: String? = nil,
        logo: ToolLogo? = nil
    ) {
        self.version = version
        self.displayName = displayName
        self.summary = summary
        self.author = author
        self.homepage = homepage
        self.logo = logo
    }
}

struct UpdateItem: Decodable, Equatable, Identifiable, Sendable {
    let kind: String?
    let id: String
    let displayName: String?
    let summary: String?
    let author: String?
    let homepage: String?
    let logo: ToolLogo?
    let installedVersion: String?
    let availableVersion: String?
    let availability: String?
    let lastCheck: SourceCheck?
    let restartRequired: Bool?
    let upgrade: String?
    let note: String?
}

struct UpdatesReport: Decodable, Equatable, Sendable {
    let schemaVersion: String?
    let status: String
    let channel: String?
    let items: [UpdateItem]?
    let assessmentBoundary: String?
}

struct GitHubProjectPreview: Decodable, Equatable, Sendable {
    let schemaVersion: String?
    let status: String?
    let presentation: GitHubPresentation?
    let origin: GitHubOrigin?
    let compatibility: GitHubCompatibility?
    let downloadedPackage: Bool?
    let permissions: GitHubPermissions?
}

struct GitHubPresentation: Decodable, Equatable, Sendable {
    let displayName: String?
    let summary: String?
    let author: String?
    let homepage: String?
    let license: String?
    let logo: ToolLogo?
}

struct GitHubOrigin: Decodable, Equatable, Sendable {
    let kind: String?
    let repository: String?
    let tag: String?
    let releaseUrl: String?
}

struct GitHubCompatibility: Decodable, Equatable, Sendable {
    let platform: String?
    let available: Bool?
    let reason: String?
}

struct GitHubPermissions: Decodable, Equatable, Sendable {
    let message: String?
}

struct HostEntrySummary: Decodable, Equatable, Sendable {
    let component: String
    let ownership: String
}

struct HostSummary: Decodable, Equatable, Sendable {
    let installed: Bool
    let version: String?
    let restartRequired: Bool?
    let entries: [HostEntrySummary]?
}

struct ServiceSummary: Decodable, Equatable, Sendable {
    let label: String?
    let created: Bool?
}

struct SuiteStatus: Decodable, Equatable, Sendable {
    let configured: Bool
    let suiteVersion: String?
    let channel: String?
    let profile: String?
    let installedAt: String?
    let updatedAt: String?
    let availableAgentComponents: [String]?
    let agentComponents: [String]?
    let agentToolsPaused: Bool?
    let resumeAgentComponents: [String]?
    let components: [String: ComponentSummary]?
    let hosts: [String: HostSummary]?
    let service: ServiceSummary?
}

enum ManagerToolPolicy {
    static func visibleToolIDs(
        components: [String: ComponentSummary]?,
        availableAgentComponents: [String]?,
        activeAgentComponents: [String]?,
        orderedIDs: [String]
    ) -> [String] {
        guard let components else { return [] }
        let available = availableAgentComponents ?? activeAgentComponents ?? []
        let availableSet = Set(available)
        let preferred = orderedIDs.filter { availableSet.contains($0) && components[$0] != nil }
        let preferredSet = Set(preferred)
        let additional = available.filter { !preferredSet.contains($0) && components[$0] != nil }
        return preferred + additional
    }

    static func orderedToolIDs(_ ids: [String], preferredOrder: [String]) -> [String] {
        let selected = Set(ids)
        let preferred = preferredOrder.filter(selected.contains)
        let preferredSet = Set(preferred)
        return preferred + ids.filter { !preferredSet.contains($0) }
    }

    static let pauseArguments = ["tools", "pause"]
    static let resumeArguments = ["tools", "resume"]
}

enum ManagerCheckPolicy {
    static let foregroundDoctorArguments = ["doctor", "--deep", "--skip-agent-apps"]
    static let fullDoctorArguments = ["doctor", "--deep"]

    static func quickHostStatusArguments(_ id: String) -> [String] {
        ["host", "status", id, "--quick"]
    }
}

struct ManagerSetupTool: Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let summary: String
    let systemImage: String
    let task: String?
    let outcome: String?
    let examplePrompt: String?
    let visualLabel: String?
    let tone: String?

    init(
        id: String,
        name: String,
        summary: String,
        systemImage: String,
        task: String? = nil,
        outcome: String? = nil,
        examplePrompt: String? = nil,
        visualLabel: String? = nil,
        tone: String? = nil
    ) {
        self.id = id
        self.name = name
        self.summary = summary
        self.systemImage = systemImage
        self.task = task
        self.outcome = outcome
        self.examplePrompt = examplePrompt
        self.visualLabel = visualLabel
        self.tone = tone
    }

    var hasTaskExperience: Bool {
        task != nil && outcome != nil && examplePrompt != nil && visualLabel != nil
    }
}

enum ManagerSetupPolicy {
    static let profiles = ["featured", "standard", "developer", "observability"]
    static let defaultProfile = "featured"
    static let featuredToolIDs = ["math-anchor", "migratory-time", "armorial"]
    static let unsignedMacOSGatekeeperNote = "Unsigned build: try to open, then System Settings → Privacy & Security → Open Anyway."
    static let publicDownloadNotConfiguredNote = "Public download is not configured."
    static let workingSetNote = ""

    static func isSetupProfile(_ id: String) -> Bool {
        profiles.contains(id)
    }

    static func displayName(for profile: String) -> String {
        switch profile {
        case "featured": "Featured tools"
        case "developer": "Developer Kit"
        case "observability": "Standard + Monitoring"
        case "local-dogfood": "Standard + Local tools"
        default: "Standard tools"
        }
    }

    static func tools(for profile: String) -> [ManagerSetupTool] {
        switch profile {
        case "featured":
            [
                ManagerSetupTool(
                    id: "math-anchor",
                    name: "Math Anchor",
                    summary: "Exact and scientific calculation",
                    systemImage: "function",
                    task: "Verify exact math without approximation",
                    outcome: "Exact result with the calculation checked",
                    examplePrompt: "Calculate 9,999,999,999 × 87 exactly, show the result, and verify it.",
                    visualLabel: "9,999,999,999 × 87",
                    tone: "indigo"
                ),
                ManagerSetupTool(
                    id: "migratory-time",
                    name: "Migratory Time",
                    summary: "Reliable worldwide time conversion",
                    systemImage: "globe.americas",
                    task: "Coordinate a time across cities",
                    outcome: "Local date and time with zone rules applied",
                    examplePrompt: "Convert 9:00 AM on October 15, 2026 from Shanghai to San Francisco and state the local date.",
                    visualLabel: "09:00  SHA → SFO",
                    tone: "teal"
                ),
                ManagerSetupTool(
                    id: "armorial",
                    name: "Armorial",
                    summary: "Choose project-aware icons without redrawing them",
                    systemImage: "shield.lefthalf.filled",
                    task: "Choose an icon that fits the project",
                    outcome: "A reusable SVG from the project-aware set",
                    examplePrompt: "Choose and render one project-aware icon for a primary Start action. Explain the visual fit briefly.",
                    visualLabel: "◇  ○  ✦",
                    tone: "orange"
                ),
            ]
        case "developer":
            [
                ManagerSetupTool(id: "agent-tool-development-kit", name: "Developer Kit", summary: "Skill-only kit; this profile adds no Agent MCP tools", systemImage: "hammer.fill"),
            ]
        default:
            tools(for: "featured").filter { ["math-anchor", "migratory-time"].contains($0.id) }
        }
    }

    static func connectsHost(_ appInstalled: Bool?) -> Bool {
        appInstalled == true
    }

    static func setupArguments(
        profile: String,
        host: String?,
        releaseManifest: String?,
        dryRun: Bool
    ) -> [String] {
        var arguments = ["setup", "--profile", profile]
        if let host, !host.isEmpty {
            arguments += ["--host", host]
        } else {
            arguments.append("--no-host")
        }
        if profile == "observability" {
            arguments.append("--enable-observability")
        }
        if let releaseManifest, !releaseManifest.isEmpty {
            arguments += ["--release-manifest", releaseManifest]
        }
        if dryRun {
            arguments.append("--dry-run")
        }
        return arguments
    }

    static func updateArguments(
        profile: String?,
        releaseManifest: String?,
        replaceHostConflicts: Bool,
        dryRun: Bool,
        planId: String? = nil
    ) -> [String] {
        var arguments = ["update"]
        if let profile, !profile.isEmpty {
            arguments += ["--profile", profile]
        }
        if let releaseManifest, !releaseManifest.isEmpty {
            arguments += ["--release-manifest", releaseManifest]
        }
        if replaceHostConflicts {
            arguments.append("--replace-host-conflicts")
        }
        if let planId, !planId.isEmpty {
            arguments += ["--plan-id", planId]
        }
        if dryRun {
            arguments.append("--dry-run")
        }
        return arguments
    }

    static func repairArguments(
        replaceHostConflicts: Bool,
        dryRun: Bool,
        planId: String? = nil
    ) -> [String] {
        var arguments = ["repair"]
        if replaceHostConflicts {
            arguments.append("--replace-host-conflicts")
        }
        if let planId, !planId.isEmpty {
            arguments += ["--plan-id", planId]
        }
        if dryRun {
            arguments.append("--dry-run")
        }
        return arguments
    }
}

enum ManagerSourcePolicy {
    static let unpublishedNote = "Catalog assets are unpublished."
    static let notNotarizedNote = "Not Apple-notarized. Not a store."
    static let applicationPlane = "Application"
    static let environmentPlane = "Environment"
    static let componentsPlane = "Tools"
    static let differentPayloadsNote = "The Manager application and the installed Agent environment can share this product name with different payloads."

    static func statusArguments() -> [String] { ["source", "status"] }
    static func checkArguments() -> [String] { ["source", "check"] }
    static func setURLArguments(_ url: String) -> [String] { ["source", "set", "--url", url] }
    static func setManifestArguments(_ path: String) -> [String] { ["source", "set", "--release-manifest", path] }
    static func clearArguments() -> [String] { ["source", "clear"] }

    static func versionSummary(applicationVersion: String?, applicationBuild: String?, environmentVersion: String?) -> String {
        let app = [applicationVersion, applicationBuild.map { "build \($0)" }].compactMap { $0 }.joined(separator: " · ")
        let env = environmentVersion ?? L10n.text("not installed")
        return L10n.format("App {app} · Env {env}", [
            "app": app.isEmpty ? L10n.text("unknown") : app,
            "env": env,
        ])
    }

    static func recoveryMessage(code: String?) -> String {
        switch code {
        case "PREVIEW_DOWNLOAD_DIGEST_MISMATCH", "PREVIEW_DOWNLOAD_SIZE_MISMATCH":
            "The file digest did not match. Discard it and retry, or choose another catalog."
        case "PREVIEW_DOWNLOAD_TIMEOUT", "PREVIEW_DOWNLOAD_STALLED", "PREVIEW_DOWNLOAD_CANCELLED":
            "The download was interrupted. Retry from the start, or use a local catalog."
        case "PREVIEW_DOWNLOAD_FAILED":
            "The catalog is unreachable. Retry, use the last downloaded catalog, or choose a local file."
        case "RELEASE_UNBOUND":
            "That catalog is unbound. Choose a bound current.json."
        case "PREVIEW_DOWNLOAD_INVALID", "PREVIEW_DOWNLOAD_INVALID_URL", "PREVIEW_DOWNLOAD_UNSUPPORTED":
            "Point at preview-distribution.json or a bound current.json."
        default:
            unpublishedNote + " Use a local bound catalog, or retry after an owner publishes a Release."
        }
    }

    static func resolvedReleaseManifest(
        environmentManifest: String?,
        savedPath: String?,
        savedURL: String?,
        featuredCatalogURL: String?
    ) -> String? {
        return [environmentManifest, savedPath, savedURL, featuredCatalogURL]
            .compactMap { $0 }
            .first { !$0.isEmpty }
    }
}

struct SourceApplication: Decodable, Equatable, Sendable {
    let kind: String?
    let productName: String?
    let version: String?
    let build: String?
    let path: String?
    let note: String?
}

struct SourceEnvironmentPlane: Decodable, Equatable, Sendable {
    let configured: Bool?
    let suiteVersion: String?
    let releaseId: String?
    let channel: String?
    let profile: String?
    let updatedAt: String?
}

struct SourceComponentVersion: Decodable, Equatable, Sendable {
    let id: String
    let version: String?
    let displayName: String?
}

struct SourceRecovery: Decodable, Equatable, Sendable {
    let action: String?
    let retry: Bool?
    let chooseLocal: Bool?
    let chooseRemote: Bool?
    let message: String?
}

struct SourceCheck: Decodable, Equatable, Sendable {
    let at: String?
    let status: String?
    let code: String?
    let message: String?
    let recovery: SourceRecovery?
}

struct SourceLocator: Decodable, Equatable, Sendable {
    let kind: String?
    let url: String?
    let path: String?
    let unpublished: Bool?
    let message: String?
    let lastCheck: SourceCheck?
    let lastDownloadedCatalog: String?
    let recovery: SourceRecovery?
}

struct SourceStatus: Decodable, Equatable, Sendable {
    let schemaVersion: String?
    let status: String?
    let notarized: Bool?
    let marketplace: Bool?
    let publicReleasePublished: Bool?
    let application: SourceApplication?
    let environment: SourceEnvironmentPlane?
    let components: [SourceComponentVersion]?
    let source: SourceLocator?
}

struct ManagerAgentApp: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let systemImage: String

    static let all = [
        ManagerAgentApp(id: "zcode", name: "ZCode", systemImage: "z.square.fill"),
        ManagerAgentApp(id: "codex", name: "Codex", systemImage: "bubble.left.and.bubble.right.fill"),
        ManagerAgentApp(id: "claude", name: "Claude Code", systemImage: "terminal.fill"),
    ]

    private static let traceOnly = [
        ManagerAgentApp(id: "deepseek-harness", name: "DeepSeek Harness", systemImage: "point.3.connected.trianglepath.dotted"),
        ManagerAgentApp(id: "gemini-cli", name: "Gemini CLI", systemImage: "sparkles"),
        ManagerAgentApp(id: "github-copilot-cli", name: "GitHub Copilot CLI", systemImage: "chevron.left.forwardslash.chevron.right"),
    ]

    static func named(_ id: String) -> ManagerAgentApp {
        (all + traceOnly).first(where: { $0.id == id }) ?? ManagerAgentApp(
            id: id,
            name: id.replacingOccurrences(of: "-", with: " ").localizedCapitalized,
            systemImage: "app.fill"
        )
    }
}

struct ToolSetChangeResult: Decodable, Equatable, Sendable {
    let status: String
    let changed: Bool
    let activeAgentComponents: [String]
    let inactiveAgentComponents: [String]
    let restartRequired: Bool
}

struct HostStatusResult: Decodable, Equatable, Sendable {
    struct Failure: Decodable, Equatable, Sendable {
        let code: String
        let message: String
    }

    let status: String
    let host: String
    let appInstalled: Bool?
    let managed: Bool?
    let installed: Bool?
    let healthy: Bool?
    let version: String?
    let error: Failure?
}

struct SetupPlan: Decodable, Equatable, Sendable {
    let status: String
    let dryRun: Bool
    let profile: String
    let profileDisplayName: String?
    let hosts: [String: HostPlan]?
    let service: ServicePlan?
    let components: [String: ComponentSummary]
}

struct HostPlanEntry: Decodable, Equatable, Sendable {
    let component: String?
    let selector: String?
    let pluginPresent: Bool?
    let pluginEnabled: Bool?
    let installedVersion: String?
    let requestedVersion: String?
}

struct HostPlan: Decodable, Equatable, Sendable {
    let version: String?
    let entries: [HostPlanEntry]?
}

struct ServicePlan: Decodable, Equatable, Sendable {
    let supported: Bool?
    let configured: Bool?
    let loaded: Bool?
    let label: String?
    let launchAgentPath: String?
}

struct ActivationPlan: Decodable, Equatable, Sendable {
    let hosts: [String: HostPlan]
    let service: ServicePlan?
}

struct UpdateSource: Decodable, Equatable, Sendable {
    let kind: String
    let path: String?
    let url: String?
    let developmentRoot: String?
    let releaseId: String?
    let provenanceSha256: String?
}

struct ComponentVersionChange: Decodable, Equatable, Sendable, Identifiable {
    let id: String
    let action: String
    let currentVersion: String?
    let targetVersion: String?
}

struct UpdatePlan: Decodable, Equatable, Sendable {
    let status: String
    let dryRun: Bool
    let fromChannel: String
    let toChannel: String
    let fromVersion: String
    let toVersion: String
    let releaseId: String?
    let source: UpdateSource
    let profile: String
    let profileDisplayName: String?
    let changed: [String]
    let componentChanges: [ComponentVersionChange]
    let enabledAgentComponents: [String]
    let removedAgentComponents: [String]
    let planId: String
    let activation: ActivationPlan
}

struct RepairTargets: Decodable, Equatable, Sendable {
    let hosts: [String]
    let service: Bool
    let monitoring: Bool
}

struct RepairPlan: Decodable, Equatable, Sendable {
    let status: String
    let dryRun: Bool
    let kind: String
    let suiteVersion: String
    let releaseId: String?
    let profile: String
    let profileDisplayName: String?
    let changed: [String]
    let componentChanges: [ComponentVersionChange]
    let repairs: RepairTargets
    let planId: String
    let activation: ActivationPlan
}

struct RollbackPlan: Decodable, Equatable, Sendable {
    let status: String
    let dryRun: Bool
    let targetVersion: String
}

enum EnvironmentChangePlan: Equatable, Sendable {
    case update(UpdatePlan, profile: String?, replaceHostConflicts: Bool)
    case repair(RepairPlan, replaceHostConflicts: Bool)
    case rollback(RollbackPlan)
}

struct ActivityEntry: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let occurredAt: String
    let type: String
    let summary: String
    let detail: [String: ActivityDetailValue]?

    var date: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: occurredAt)
    }

    var localizedSummary: String {
        switch type {
        case "monitoring.enabled": L10n.text("Local monitoring turned on")
        case "monitoring.disabled": L10n.text("Local monitoring turned off")
        case "environment.maintained": L10n.text("Local observation and package storage maintained")
        case "environment.installed":
            L10n.text(detail?["profile"]?.displayText == "featured" ? "Featured tools installed" : "Agent environment installed")
        case "environment.updated": L10n.text(summary == "Environment checked for updates" ? "Environment checked for updates" : "Environment updated")
        case "environment.repaired": L10n.text("Environment connections repaired")
        case "environment.rolled-back": L10n.text("Previous environment restored")
        case "tool-set.changed": L10n.text("Agent tool availability changed")
        case "environment.uninstalled": L10n.text("Agent Host removed")
        case "agent-app.added": L10n.format("{app} connected", ["app": Self.agentAppName(detail?["host"]?.displayText ?? "Agent")])
        case "agent-app.removed": L10n.format("{app} disconnected", ["app": Self.agentAppName(detail?["host"]?.displayText ?? "Agent")])
        default: L10n.text(summary)
        }
    }

    var orderedDetail: [(key: String, value: String)] {
        (detail ?? [:])
            .sorted { $0.key < $1.key }
            .map { (key: $0.key, value: $0.value.displayText) }
    }

    func humanDetail(componentNames: [String: String]) -> [(label: String, value: String)] {
        let values = detail ?? [:]
        var output: [(label: String, value: String)] = []
        if let active = list(values["activeAgentComponents"]), !active.isEmpty {
            output.append(("Available tools", names(active, componentNames: componentNames)))
        }
        if let inactive = list(values["inactiveAgentComponents"]), !inactive.isEmpty {
            output.append(("Kept installed", names(inactive, componentNames: componentNames)))
        }
        if let changed = list(values["changed"]), !changed.isEmpty {
            output.append(("Updated", names(changed, componentNames: componentNames)))
        }
        if let hosts = list(values["hosts"]), !hosts.isEmpty {
            output.append(("Agent apps", hosts.map(Self.agentAppName).joined(separator: ", ")))
        }
        if let host = values["host"]?.displayText {
            output.append(("Agent app", Self.agentAppName(host)))
        }
        if let component = values["component"]?.displayText {
            output.append(("Tool", displayName(component, componentNames: componentNames)))
        }
        if let profile = values["profile"]?.displayText {
            output.append(("Tool set", profile.replacingOccurrences(of: "-", with: " ").localizedCapitalized))
        }
        if let version = values["suiteVersion"]?.displayText ?? values["version"]?.displayText {
            output.append(("Version", version))
        }
        if let previousVersion = values["rolledBackFrom"]?.displayText {
            output.append(("Replaced version", previousVersion))
        }
        if let active = values["active"]?.displayText {
            output.append(("Availability", active == "yes" ? "Selected for new Agent tasks" : "Kept installed"))
        }
        if let purgeData = values["purgeData"]?.displayText {
            output.append(("Local data", purgeData == "yes" ? "Removed" : "Preserved"))
        }
        if let retained = values["packageRetainedForRollback"]?.displayText, retained == "yes" {
            output.append(("Recovery copy", "Preserved"))
        }
        if let removed = values["observerRowsRemoved"]?.displayText {
            output.append(("Old monitoring records removed", removed))
        }
        if let reclaimed = values["storageBytesReclaimed"]?.displayText, let bytes = Int64(reclaimed) {
            output.append(("Storage recovered", ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)))
        }
        return output
    }

    private func list(_ value: ActivityDetailValue?) -> [String]? {
        guard let text = value?.displayText, text.first == "[", text.last == "]" else { return nil }
        let body = text.dropFirst().dropLast()
        if body.isEmpty { return [] }
        return body.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private func names(_ ids: [String], componentNames: [String: String]) -> String {
        ids.map { displayName($0, componentNames: componentNames) }.joined(separator: ", ")
    }

    private func displayName(_ id: String, componentNames: [String: String]) -> String {
        if let name = componentNames[id], name != id { return name }
        switch id {
        case "agent-catalog": return "Agent tool availability"
        case "workspace-grant": return "Workspace access"
        case "direct-execution-runtime": return "Direct Runtime"
        case "agent-tool-observer": return "Local monitoring"
        case "context-surface-analyzer": return "Catalog measurement"
        case "math-anchor": return "Math Anchor"
        case "migratory-time": return "Migratory Time"
        case "data-transformer": return "BatchTicket"
        case "armorial": return "Armorial"
        case "laniakea": return "Laniakea"
        case "projective": return "Projective"
        case "equatorium": return "Equatorium"
        case "file-vitals": return "File Vitals"
        default: return id.replacingOccurrences(of: "-", with: " ").localizedCapitalized
        }
    }

    private static func agentAppName(_ id: String) -> String {
        switch id {
        case "codex": return "Codex"
        case "claude": return "Claude Code"
        case "zcode": return "ZCode"
        default: return id.localizedCapitalized
        }
    }
}

struct ActivityDetailValue: Decodable, Equatable, Sendable {
    private static let maximumDisplayCharacters = 240
    let displayText: String

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rendered: String
        if container.decodeNil() {
            rendered = "none"
        } else if let text = try? container.decode(String.self) {
            rendered = text
        } else if let flag = try? container.decode(Bool.self) {
            rendered = flag ? "yes" : "no"
        } else if let number = try? container.decode(Int64.self) {
            rendered = String(number)
        } else if let number = try? container.decode(UInt64.self) {
            rendered = String(number)
        } else if let number = try? container.decode(Double.self) {
            rendered = String(number)
        } else if let values = try? container.decode([ActivityDetailValue].self) {
            rendered = "[\(values.map(\.displayText).joined(separator: ", "))]"
        } else if let values = try? container.decode([String: ActivityDetailValue].self) {
            let items = values
                .sorted { $0.key < $1.key }
                .map { "\($0.key): \($0.value.displayText)" }
            rendered = "{\(items.joined(separator: ", "))}"
        } else {
            throw DecodingError.typeMismatch(
                ActivityDetailValue.self,
                .init(codingPath: decoder.codingPath, debugDescription: "Unsupported activity detail value")
            )
        }
        displayText = Self.bounded(rendered)
    }

    private static func bounded(_ value: String) -> String {
        guard value.count > maximumDisplayCharacters else { return value }
        return String(value.prefix(maximumDisplayCharacters - 1)) + "…"
    }
}

struct ActivityResult: Decodable, Equatable, Sendable {
    let status: String
    let entries: [ActivityEntry]
}

struct ObservationState: Decodable, Equatable, Sendable {
    let toolEvents: Int
    let usageEvents: Int
    let semanticExecutionEvents: Int
    let contextSurfaceMeasurements: Int
}

struct ContextCounts: Decodable, Equatable, Sendable {
    let tools: Int
    let schemas: Int
}

struct ContextCatalog: Decodable, Equatable, Sendable {
    let canonicalUtf8Bytes: Int
    let largestToolUtf8Bytes: Int
}

struct ContextSummary: Decodable, Equatable, Sendable {
    let catalog: ContextCatalog
    let counts: ContextCounts
    let hardNameCollisions: Int
}

struct ReportTotals: Decodable, Equatable, Sendable {
    let observedTools: Int
    let observedCalls: Int
    let suiteToolCalls: Int
}

struct ReportSummary: Decodable, Equatable, Sendable {
    let generatedAtMs: Int64
    let totals: ReportTotals
}

struct LatestObservability: Decodable, Equatable, Sendable {
    let refreshedAt: String
    let status: ObserverStatus
    let context: ContextSummary
    let report: ReportSummary
}

struct ObserverStatus: Decodable, Equatable, Sendable {
    let state: ObservationState
}

struct ObservabilityStatus: Decodable, Equatable, Sendable {
    struct Schedule: Decodable, Equatable, Sendable {
        let intervalSeconds: Int?
    }

    let configured: Bool
    let enabled: Bool
    let consentedAt: String?
    let observer: Schedule?
    let maintenance: Schedule?
    let latest: LatestObservability?
}

struct SnapshotCollectionSource: Decodable, Equatable, Sendable {
    let source: String?
    let status: String?
    let errorCode: String?
    let backlogSources: Int?
    let skippedLines: Int?
}

struct SnapshotCollection: Decodable, Equatable, Sendable {
    let status: String?
    let providersOk: Int?
    let providersPartial: Int?
    let providersMissing: Int?
    let providersError: Int?
    let sources: [SnapshotCollectionSource]?
}

struct SnapshotBudgetCheck: Decodable, Equatable, Sendable {
    let metric: String
    let actual: Int
    let limit: Int
    let status: String

    var exceeded: Bool { status == "exceeded" }
}

struct SnapshotCatalog: Decodable, Equatable, Sendable {
    let canonicalUtf8Bytes: Int?
    let largestToolUtf8Bytes: Int?
    let tools: Int?
    let schemas: Int?
    let hardNameCollisions: Int?
    let budgetChecks: [SnapshotBudgetCheck]?
}

struct SnapshotObservability: Decodable, Equatable, Sendable {
    let enabled: Bool
    let refreshedAt: String?
    let collection: SnapshotCollection?
    let catalog: SnapshotCatalog?
}

struct SnapshotStorage: Decodable, Equatable, Sendable {
    let allocatedBytes: Int?
    let apparentBytes: Int?
}

struct SnapshotProcesses: Decodable, Equatable, Sendable {
    let sampledAt: String?
    let processCount: Int?
    let totalRssBytes: Int?
}

struct SuiteSnapshot: Decodable, Equatable, Sendable {
    let configured: Bool
    let generatedAt: String?
    let observability: SnapshotObservability?
    let storage: SnapshotStorage?
    let processes: SnapshotProcesses?
}

struct UsageFreshness: Decodable, Equatable, Sendable {
    let status: String?
    let ageMs: Int?
    let overdueAfterMs: Int?
}

struct UsageProviderHealth: Decodable, Equatable, Identifiable, Sendable {
    let provider: String?
    let status: String?
    let errorCode: String?
    let scannedAtMs: Int64?
    var id: String { provider ?? "unknown" }
}

struct UsageProviderTokens: Decodable, Equatable, Identifiable, Sendable {
    let provider: String?
    let records: Int?
    let inputTokens: Int64?
    let cachedInputTokens: Int64?
    let outputTokens: Int64?
    let reasoningTokens: Int64?
    let totalTokens: Int64?
    let averageDurationMs: Double?
    let semantics: String?
    let peakObservedDailyTokens: Int64?
    let peakObservedDailyDate: String?
    let dailyTokenSemantics: String?
    var id: String { provider ?? "unknown" }
}

struct UsageProviderActivity: Decodable, Equatable, Identifiable, Sendable {
    let provider: String?
    let observedSessions: Int?
    let observedTurns: Int?
    let observedActiveDays: Int?
    let firstObservedAtMs: Int64?
    let lastObservedAtMs: Int64?
    let longestObservedSessionSpanMs: Int64?
    let currentObservedDayStreak: Int?
    let longestObservedDayStreak: Int?
    var id: String { provider ?? "unknown" }
}

struct UsageDailyEntry: Decodable, Equatable, Identifiable, Sendable {
    let provider: String?
    let utcDate: String?
    let toolCalls: Int?
    let usageRecords: Int?
    let observedSessions: Int?
    let observedTurns: Int?
    let inputTokens: Int64?
    let cachedInputTokens: Int64?
    let outputTokens: Int64?
    let reasoningTokens: Int64?
    let totalTokens: Int64?
    var id: String { "\(provider ?? "unknown"):\(utcDate ?? "unknown")" }
}

struct UsageDailyList: Decodable, Equatable, Sendable {
    let returned: Int
    let available: Int
    let limit: Int
    let truncated: Bool
    let entries: [UsageDailyEntry]
}

struct UsageToolEntry: Decodable, Equatable, Identifiable, Sendable {
    let provider: String?
    let toolName: String?
    let historicalCalls: Int?
    let directCalls: Int?
    let referencedCalls: Int?
    let componentId: String?
    let componentVersion: String?
    let currentBindingCalls: Int?
    let currentBindingObservedSinceMs: Int64?
    let currentBindingAttribution: String?
    let measuredCalls: Int?
    let completed: Int?
    let errors: Int?
    let cancelled: Int?
    let averageDurationMs: Double?
    let currentReleaseCalls: Int?
    let currentReleaseFreshSessionCalls: Int?
    let currentReleaseStatus: String?
    let firstObservedAtMs: Int64?
    let lastObservedAtMs: Int64?
    var id: String { "\(provider ?? "unknown"):\(toolName ?? "unknown")" }
}

struct UsageToolList: Decodable, Equatable, Sendable {
    let returned: Int
    let available: Int
    let limit: Int
    let entries: [UsageToolEntry]
}

struct UsageTraceAdapter: Decodable, Equatable, Identifiable, Sendable {
    let id: String?
    let provider: String?
    let transport: String?
    let status: String
    let errorCode: String?
    let scannedAtMs: Int64?
    let eventsWritten: Int?
    let backlogSources: Int?
    var identifier: String { id ?? "\(provider ?? "unknown"):\(transport ?? "unknown")" }
}

struct UsageTraceSummary: Decodable, Equatable, Sendable {
    let adaptersReturned: Int
    let adaptersAvailable: Int
    let adapters: [UsageTraceAdapter]
    let providersObserved: Int
    let modelSteps: Int
    let toolOffers: Int
    let toolCalls: Int
    let toolResults: Int
    let turnEnds: Int
    let passiveStorage: String
    let interpretationStatus: String
}

struct UsageReliability: Decodable, Equatable, Sendable {
    let measuredToolCalls: Int
    let completedToolCalls: Int
    let toolErrors: Int
    let toolCancellations: Int
    let semanticExecutions: Int
    let semanticCompleted: Int
    let semanticProviderErrors: Int
    let semanticHostErrors: Int
}

struct UsageCoverageItem: Decodable, Equatable, Sendable {
    let status: String
    let basis: String?
    let reason: String?
}

struct UsageCoverage: Decodable, Equatable, Sendable {
    let toolInvocation: UsageCoverageItem
    let runtimeOutcome: UsageCoverageItem
    let tokenUsage: UsageCoverageItem
    let skillUse: UsageCoverageItem
    let semanticEffect: UsageCoverageItem
    let resultAdoption: UsageCoverageItem
    let nonUseReason: UsageCoverageItem
}

struct UsageVersionEntry: Decodable, Equatable, Identifiable, Sendable {
    let providerId: String?
    let providerVersion: String?
    let purpose: String?
    let executions: Int?
    let completed: Int?
    let providerErrors: Int?
    let hostErrors: Int?
    let reportedOutcomes: Int?
    let partialResults: Int?
    let itemErrors: Int?
    let firstObservedAtMs: Int64?
    let lastObservedAtMs: Int64?
    var id: String { "\(providerId ?? "unknown"):\(providerVersion ?? "unknown"):\(purpose ?? "unknown")" }
}

struct UsageVersionHistory: Decodable, Equatable, Sendable {
    let available: Int
    let returned: Int
    let truncated: Bool
    let totalExecutions: Int
    let entries: [UsageVersionEntry]
}

struct UsageSummary: Decodable, Equatable, Sendable {
    let configured: Bool
    let enabled: Bool
    let generatedAt: String
    let windowDays: Int?
    let observationSource: String
    let currentReadErrorCode: String?
    let freshness: UsageFreshness?
    let providerHealth: [UsageProviderHealth]
    let providerUsage: [UsageProviderTokens]
    let providerActivity: [UsageProviderActivity]
    let dailyActivity: UsageDailyList?
    let tools: UsageToolList
    let versionHistory: UsageVersionHistory?
    let trace: UsageTraceSummary
    let reliability: UsageReliability
    let coverage: UsageCoverage
    let assessmentBoundary: String
}

struct TraceSourceRange: Decodable, Equatable, Sendable {
    let fromMs: Int64?
    let toMs: Int64?
}

struct TraceSourceRetention: Decodable, Equatable, Sendable {
    let retentionDays: Int
    let currentCutoffMs: Int64
    let eventsBeforeCutoffMayHaveBeenRemoved: Bool
    let collectionBeforeMonitoringWasEnabled: String
}

struct TraceSourceLimits: Decodable, Equatable, Sendable {
    let maxSources: Int
    let sourceLimitReached: Bool
    let sourcesReturned: Int
}

struct TraceSourcePrivacy: Decodable, Equatable, Sendable {
    let contentPolicy: String
    let sourcePathIncluded: Bool
    let rawConversationContentIncluded: Bool
    let toolArgumentsIncluded: Bool
    let toolResultsIncluded: Bool
}

struct TraceSourceEntry: Decodable, Equatable, Identifiable, Sendable {
    let sessionHash: String
    let firstEventAtMs: Int64
    let lastEventAtMs: Int64
    let totalEvents: Int
    let modelSteps: Int
    let toolCalls: Int
    let toolResults: Int
    let turnEnds: Int
    let completeness: String

    var id: String { sessionHash }
}

struct TraceSourceCatalog: Decodable, Equatable, Sendable {
    let schemaVersion: String
    let status: String
    let generatedAt: String
    let provider: String
    let requestedRange: TraceSourceRange
    let retention: TraceSourceRetention
    let privacy: TraceSourcePrivacy
    let limits: TraceSourceLimits
    let sources: [TraceSourceEntry]
    let unknowns: [String]
    let interpretationStatus: String

    func isValid(expectedProvider: String) -> Bool {
        schemaVersion == "openadam.agent-host-trace-source-catalog.v0.1"
            && status == "ok"
            && provider == expectedProvider
            && privacy.contentPolicy == "metadata-only"
            && !privacy.sourcePathIncluded
            && !privacy.rawConversationContentIncluded
            && !privacy.toolArgumentsIncluded
            && !privacy.toolResultsIncluded
            && interpretationStatus == "not-performed"
            && limits.maxSources > 0
            && limits.sourcesReturned == sources.count
            && sources.count <= limits.maxSources
            && sources.allSatisfy { source in
                source.sessionHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
                    && source.firstEventAtMs >= 0
                    && source.lastEventAtMs >= source.firstEventAtMs
                    && source.totalEvents >= 1
                    && source.modelSteps >= 0
                    && source.toolCalls >= 0
                    && source.toolResults >= 0
                    && source.turnEnds >= 0
                    && source.totalEvents == source.modelSteps + source.toolCalls + source.toolResults + source.turnEnds
                    && source.completeness == "unknown"
            }
    }
}

struct TaskSourceObservationBoundary: Decodable, Equatable, Sendable {
    let directCallsAreExecutionObservations: Bool
    let staticReferencesAreExecutionObservations: Bool
    let terminalStatusMayBePartial: Bool
}

struct TaskSourceEntry: Decodable, Equatable, Identifiable, Sendable {
    let sessionHash: String
    let sessionStartedAtMs: Int64?
    let firstEventAtMs: Int64
    let lastEventAtMs: Int64
    let observedTurns: Int
    let toolObservations: Int
    let directCalls: Int
    let staticReferences: Int
    let completed: Int
    let errors: Int
    let cancelled: Int
    let outcomeUnknown: Int
    let usageRecords: Int
    let completeness: String

    var id: String { sessionHash }
}

struct TaskSourceCatalog: Decodable, Equatable, Sendable {
    let schemaVersion: String
    let status: String
    let generatedAt: String
    let provider: String
    let requestedRange: TraceSourceRange
    let retention: TraceSourceRetention
    let privacy: TraceSourcePrivacy
    let limits: TraceSourceLimits
    let sources: [TaskSourceEntry]
    let observationBoundary: TaskSourceObservationBoundary
    let unknowns: [String]
    let interpretationStatus: String

    func isValid(expectedProvider: String) -> Bool {
        schemaVersion == "openadam.agent-host-task-source-catalog.v0.1"
            && status == "ok"
            && provider == expectedProvider
            && privacy.contentPolicy == "metadata-only"
            && !privacy.sourcePathIncluded
            && !privacy.rawConversationContentIncluded
            && !privacy.toolArgumentsIncluded
            && !privacy.toolResultsIncluded
            && observationBoundary.directCallsAreExecutionObservations
            && !observationBoundary.staticReferencesAreExecutionObservations
            && observationBoundary.terminalStatusMayBePartial
            && interpretationStatus == "not-performed"
            && limits.maxSources > 0
            && limits.maxSources <= 500
            && limits.sourcesReturned == sources.count
            && sources.count <= limits.maxSources
            && retention.retentionDays > 0
            && retention.currentCutoffMs >= 0
            && retention.eventsBeforeCutoffMayHaveBeenRemoved
            && retention.collectionBeforeMonitoringWasEnabled == "unavailable"
            && sources.allSatisfy { source in
                source.sessionHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
                    && (source.sessionStartedAtMs.map { $0 >= 0 } ?? true)
                    && source.firstEventAtMs >= 0
                    && source.lastEventAtMs >= source.firstEventAtMs
                    && source.observedTurns >= 0
                    && source.toolObservations >= 0
                    && source.directCalls >= 0
                    && source.staticReferences >= 0
                    && source.directCalls + source.staticReferences == source.toolObservations
                    && source.completed >= 0
                    && source.errors >= 0
                    && source.cancelled >= 0
                    && source.outcomeUnknown >= 0
                    && source.completed + source.errors + source.cancelled + source.outcomeUnknown == source.toolObservations
                    && source.usageRecords >= 0
                    && source.toolObservations + source.usageRecords >= 1
                    && source.completeness == "unknown"
            }
    }
}

struct TraceExportReceipt: Decodable, Equatable, Sendable {
    let status: String
    let schemaVersion: String
    let outputPath: String
    let outputBytes: Int
    let eventsReturned: Int
    let eventsAvailable: Int
    let contentPolicy: String
    let observerPackRetained: Bool
    let sourcePathStoredInPack: Bool
    let interpretationStatus: String
}

enum TraceContractValidator {
    static let retainedPackVersion = "openadam.agent-host-trace-analysis-pack.v0.2"

    static func isValidRetainedExport(
        data: Data,
        receipt: TraceExportReceipt,
        outputPath: String,
        provider: String,
        sessionHash: String
    ) -> Bool {
        guard receipt.status == "completed",
              receipt.schemaVersion == retainedPackVersion,
              receipt.outputPath == outputPath,
              receipt.outputBytes == data.count,
              receipt.eventsReturned >= 0,
              receipt.eventsAvailable >= receipt.eventsReturned,
              receipt.contentPolicy == "metadata-only",
              receipt.observerPackRetained == false,
              receipt.sourcePathStoredInPack == false,
              receipt.interpretationStatus == "not-performed",
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["schemaVersion"] as? String == retainedPackVersion,
              value["interpretationStatus"] as? String == "not-performed",
              let source = value["source"] as? [String: Any],
              source["provider"] as? String == provider,
              source["selectionKind"] as? String == "observer-retained-session",
              source["sessionHash"] as? String == sessionHash,
              let privacy = value["privacy"] as? [String: Any],
              privacy["contentPolicy"] as? String == "metadata-only",
              privacy["selectedConversationContentIncluded"] as? Bool == false,
              privacy["sensitiveContentConfirmed"] as? Bool == false,
              privacy["transportSecretsExcluded"] as? Bool == true,
              privacy["selectedContentMayContainUserSecrets"] as? Bool == false,
              privacy["observerPackRetained"] as? Bool == false,
              privacy["sourceUsesObserverRetainedMetadata"] as? Bool == true,
              privacy["sourcePathIncluded"] as? Bool == false,
              privacy["toolArgumentsIncluded"] as? Bool == false,
              privacy["toolResultsIncluded"] as? Bool == false,
              let limits = value["limits"] as? [String: Any],
              limits["eventsReturned"] as? Int == receipt.eventsReturned,
              limits["eventsAvailable"] as? Int == receipt.eventsAvailable,
              let events = value["events"] as? [Any],
              events.count == receipt.eventsReturned else {
            return false
        }
        return true
    }
}

struct TaskExportReceipt: Decodable, Equatable, Sendable {
    let status: String
    let schemaVersion: String
    let outputPath: String
    let outputBytes: Int
    let eventsReturned: Int
    let eventsAvailable: Int
    let contentPolicy: String
    let observerPackRetained: Bool
    let interpretationStatus: String
}

enum TaskActivityContractValidator {
    static let retainedPackVersion = "openadam.agent-host-task-activity-pack.v0.1"

    static func isValidRetainedExport(
        data: Data,
        receipt: TaskExportReceipt,
        outputPath: String,
        provider: String,
        sessionHash: String
    ) -> Bool {
        guard receipt.status == "completed",
              receipt.schemaVersion == retainedPackVersion,
              receipt.outputPath == outputPath,
              receipt.outputBytes == data.count,
              receipt.eventsReturned >= 0,
              receipt.eventsAvailable >= receipt.eventsReturned,
              receipt.contentPolicy == "metadata-only",
              receipt.observerPackRetained == false,
              receipt.interpretationStatus == "not-performed",
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["schemaVersion"] as? String == retainedPackVersion,
              value["interpretationStatus"] as? String == "not-performed",
              let source = value["source"] as? [String: Any],
              source["provider"] as? String == provider,
              source["selectionKind"] as? String == "observer-retained-task-session",
              source["sessionHash"] as? String == sessionHash,
              let privacy = value["privacy"] as? [String: Any],
              privacy["contentPolicy"] as? String == "metadata-only",
              privacy["observerPackRetained"] as? Bool == false,
              privacy["sourceUsesObserverRetainedMetadata"] as? Bool == true,
              privacy["sourcePathIncluded"] as? Bool == false,
              privacy["rawConversationContentIncluded"] as? Bool == false,
              privacy["toolArgumentsIncluded"] as? Bool == false,
              privacy["toolResultsIncluded"] as? Bool == false,
              let boundary = value["observationBoundary"] as? [String: Any],
              boundary["directCallsAreExecutionObservations"] as? Bool == true,
              boundary["staticReferencesAreExecutionObservations"] as? Bool == false,
              boundary["nestedChildReceiptsRequireAProviderTraceOrComponentReceipt"] as? Bool == true,
              boundary["adoptionNotRepresented"] as? Bool == true,
              let limits = value["limits"] as? [String: Any],
              limits["eventsReturned"] as? Int == receipt.eventsReturned,
              limits["eventsAvailable"] as? Int == receipt.eventsAvailable,
              let events = value["events"] as? [Any],
              events.count == receipt.eventsReturned else {
            return false
        }
        return true
    }
}

struct DoctorCheck: Decodable, Equatable, Identifiable, Sendable {
    var id: String
    let status: String
    let message: String
}

struct DoctorResult: Decodable, Equatable, Sendable {
    let status: String
    let checks: [DoctorCheck]

    func check(_ id: String) -> DoctorCheck? {
        checks.first { $0.id == id }
    }

    func hasFailure(prefix: String) -> Bool {
        checks.contains { $0.id.hasPrefix(prefix) && $0.status == "error" }
    }
}

struct PublicFailure: Decodable, Error, Sendable {
    struct RecoveryAction: Decodable, Sendable {
        let command: String
        let arguments: [String]
    }
    struct RecoveryReference: Decodable, Sendable {
        let action: RecoveryAction?
    }
    struct ErrorDetails: Decodable, Sendable {
        let recovery: RecoveryReference?
    }
    struct Detail: Decodable, Sendable {
        let code: String
        let message: String
        let details: ErrorDetails?

        var recoveryInstruction: String? {
            guard code == "SERVICE_INSTALL_ROLLBACK_FAILED",
                  let action = details?.recovery?.action,
                  action.command == "agent-host",
                  action.arguments.count == 6,
                  action.arguments[0] == "service",
                  action.arguments[1] == "recover",
                  action.arguments[2] == "--recovery",
                  action.arguments[4] == "--manifest-sha256",
                  action.arguments[3].hasPrefix("service-recovery-v2-"),
                  UUID(uuidString: String(action.arguments[3].dropFirst("service-recovery-v2-".count))) != nil,
                  action.arguments[5].hasPrefix("sha256:"),
                  action.arguments[5].dropFirst("sha256:".count).count == 64,
                  action.arguments[5].dropFirst("sha256:".count).allSatisfy({ $0.isHexDigit && !$0.isUppercase })
            else { return nil }
            return ([action.command] + action.arguments).joined(separator: " ")
        }
    }
    let status: String
    let error: Detail
}

enum ManagerHealth: Equatable {
    case loading
    case ready
    case attention(String)
    case unavailable
}

struct ManagerHealthFacet: Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let isHealthy: Bool
    let detail: String
}

enum ManagerSection: String, CaseIterable, Identifiable {
    case overview
    case tools
    case updates
    case agentApps
    case activity
    case usage

    var id: String { rawValue }

    /// Primary sidebar: install → tools → versions → connect → history. Usage is advanced.
    static var primaryCases: [ManagerSection] { [.overview, .tools, .updates, .agentApps, .activity] }

    var title: String {
        switch self {
        case .overview: "Overview"
        case .tools: "Tools"
        case .updates: "Updates"
        case .agentApps: "Agents"
        case .activity: "History"
        case .usage: "Usage"
        }
    }

    var systemImage: String {
        switch self {
        case .overview: "house"
        case .tools: "wrench.and.screwdriver"
        case .updates: "arrow.triangle.2.circlepath"
        case .agentApps: "link"
        case .activity: "clock"
        case .usage: "chart.bar.xaxis"
        }
    }
}

struct ManagedTool: Identifiable, Equatable {
    let id: String
    let name: String
    let summary: String
    let systemImage: String
    let version: String?
    let author: String?
    let homepage: String?
    let logo: ToolLogo?
    let state: ManagedItemState
    let availability: String
    let ownership: String
    let active: Bool
}

enum ManagedItemState: Equatable {
    case checking
    case ready
    case attention
    case unavailable
    case inactive

    var label: String {
        switch self {
        case .checking: "Checking"
        case .ready: "Ready"
        case .attention: "Needs attention"
        case .unavailable: "Unavailable"
        case .inactive: "Installed"
        }
    }
}
