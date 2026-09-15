import Foundation

enum RecoveryOption: Equatable {
    case replaceHostConflicts
    case replaceHostConnection(String)
}

@MainActor
final class AgentHostStore: ObservableObject {
    @Published private(set) var suite: SuiteStatus?
    @Published private(set) var observations: ObservabilityStatus?
    @Published private(set) var usage: UsageSummary?
    @Published private(set) var traceSourceCatalog: TraceSourceCatalog?
    @Published private(set) var doctor: DoctorResult?
    @Published private(set) var snapshot: SuiteSnapshot?
    @Published private(set) var hostStatuses: [String: HostStatusResult] = [:]
    @Published private(set) var activity: [ActivityEntry] = []
    @Published private(set) var setupPlan: SetupPlan?
    @Published private(set) var environmentChangePlan: EnvironmentChangePlan?
    @Published private(set) var toolSetNeedsFreshTask = false
    @Published private(set) var isBusy = false
    @Published private(set) var isBlockingWork = false
    @Published private(set) var currentAction: String?
    @Published private(set) var lastSuccessfulRefreshAt: Date?
    @Published var errorMessage: String?
    @Published private(set) var recovery: RecoveryOption?
    @Published var isPresentingSetupPlan = false
    @Published var isPresentingEnvironmentChangePlan = false
    @Published var selectedSetupHost = "zcode"
    @Published var selectedSetupProfile = ManagerSetupPolicy.defaultProfile

    private enum EnvironmentPreparation: Equatable {
        case update(profile: String?, replaceHostConflicts: Bool)
        case repair
    }

    private let cli: AgentHostCLI
    private let environment: [String: String]
    private var environmentPreparation: EnvironmentPreparation?

    init(
        cli: AgentHostCLI = AgentHostCLI(),
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.cli = cli
        self.environment = environment
    }

    var health: ManagerHealth {
        ManagerHealthPolicy.overall(
            isBusy: isBusy,
            suite: suite,
            doctor: doctor,
            facets: healthFacets
        )
    }

    // Independent health surfaces. No single "Ready" may hide an unhealthy
    // facet: host bindings, installed tools, profile catalog membership,
    // direct execution, monitoring completeness/freshness, context-catalog
    // budget, and any otherwise unclassified doctor error.
    var healthFacets: [ManagerHealthFacet] {
        guard let doctor else { return [] }
        return ManagerHealthPolicy.facets(
            doctor: doctor,
            suite: suite,
            hostStatuses: hostStatuses,
            observations: observations,
            snapshot: snapshot
        )
    }

    private var monitoringFacet: ManagerHealthFacet {
        ManagerHealthPolicy.monitoringFacet(observations: observations, snapshot: snapshot)
    }

    var catalogBudgetSummary: String? {
        guard let catalog = snapshot?.observability?.catalog, let bytes = catalog.canonicalUtf8Bytes else { return nil }
        var parts = [
            L10n.format((catalog.tools ?? 0) == 1 ? "{count} Agent operation" : "{count} Agent operations", ["count": (catalog.tools ?? 0).formatted()]),
            L10n.format("{size} catalog", ["size": ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .binary)]),
        ]
        if let largest = catalog.largestToolUtf8Bytes {
            parts.append(L10n.format("largest operation {size}", ["size": ByteCountFormatter.string(fromByteCount: Int64(largest), countStyle: .binary)]))
        }
        let exceeded = (catalog.budgetChecks ?? []).filter(\.exceeded)
        if let catalogBudget = (catalog.budgetChecks ?? []).first(where: { $0.metric == "catalog.canonicalUtf8Bytes" }) {
            parts.append(L10n.format("budget {size}", ["size": ByteCountFormatter.string(fromByteCount: Int64(catalogBudget.limit), countStyle: .binary)]))
        }
        if !exceeded.isEmpty {
            parts.append(L10n.format("OVER BUDGET ({count})", ["count": exceeded.count.formatted()]))
        }
        return parts.joined(separator: " · ")
    }

    var monitoringSummary: String {
        guard let observations, observations.enabled else { return L10n.text("Off") }
        let facet = monitoringFacet
        return facet.detail
    }

    var storageSummary: String? {
        guard let bytes = snapshot?.storage?.allocatedBytes else { return nil }
        var parts = [ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .binary)]
        if let processes = snapshot?.processes, let count = processes.processCount {
            var baseline = L10n.format(count == 1 ? "{count} live suite process" : "{count} live suite processes", ["count": count.formatted()])
            if let rss = processes.totalRssBytes {
                baseline += " · \(L10n.format("{size} resident", ["size": ByteCountFormatter.string(fromByteCount: Int64(rss), countStyle: .binary)]))"
            }
            parts.append(baseline)
        }
        return parts.joined(separator: " · ")
    }

    var managedTools: [ManagedTool] {
        ManagerToolPolicy.visibleToolIDs(
            components: suite?.components,
            availableAgentComponents: suite?.availableAgentComponents,
            activeAgentComponents: suite?.agentComponents,
            orderedIDs: Self.toolOrder
        ).compactMap { id in
            let metadata = Self.toolMetadata[id] ?? (
                name: suite?.components?[id]?.displayName ?? id.replacingOccurrences(of: "-", with: " ").localizedCapitalized,
                summary: suite?.components?[id]?.summary ?? L10n.text("Installed Agent tool"),
                systemImage: "shippingbox.fill"
            )
            return tool(id: id, name: suite?.components?[id]?.displayName ?? metadata.name, summary: suite?.components?[id]?.summary ?? metadata.summary, systemImage: metadata.systemImage)
        }
    }

    var connectedAgentAppCount: Int {
        suite?.hosts?.values.filter(\.installed).count ?? 0
    }

    var selectedSetupHostName: String {
        ManagerAgentApp.named(selectedSetupHost).name
    }

    var selectedSetupProfileName: String {
        ManagerSetupPolicy.displayName(for: selectedSetupProfile)
    }

    var connectsAgentDuringSetup: Bool {
        ManagerSetupPolicy.connectsHost(hostStatuses[selectedSetupHost]?.appInstalled)
    }

    var hasDetectedSetupHost: Bool {
        ManagerAgentApp.all.contains { hostStatuses[$0.id]?.appInstalled == true }
    }

    var featuredCatalogTools: [ManagerSetupTool] {
        ManagerSetupPolicy.tools(for: "featured")
    }

    var needsFeaturedInventory: Bool {
        guard suite?.configured == true else { return false }
        return ManagerSetupPolicy.featuredToolIDs.contains { suite?.components?[$0] == nil }
    }

    func isFeaturedToolInstalled(_ id: String) -> Bool {
        suite?.components?[id] != nil
    }

    private var releaseManifestPath: String? {
        let value = environment["AGENT_HOST_RELEASE_MANIFEST"]
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    var featuredCatalogDownloadURL: String? {
        let value = environment["AGENT_HOST_FEATURED_CATALOG_URL"]
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    var localExecutionStatus: String {
        guard suite?.service != nil else { return L10n.text("Stopped") }
        guard let service = doctor?.check("runtime.service") else { return L10n.text("Checking") }
        return L10n.text(service.status == "ok" ? "Running" : "Needs attention")
    }

    var isRefreshing: Bool {
        isBusy && currentAction == "Checking environment"
    }

    var agentAppsVerified: Bool {
        let managedHostIDs = Set((suite?.hosts ?? [:]).filter(\.value.installed).map(\.key))
        return !managedHostIDs.isEmpty && managedHostIDs.allSatisfy { doctor?.check("host.\($0)")?.status == "ok" }
    }

    func verifiedAgentAppHealth(_ id: String) -> Bool? {
        guard let check = doctor?.check("host.\(id)") else { return nil }
        return check.status == "ok"
    }

    func refreshIfNeeded(now: Date = Date(), maxAge: TimeInterval = 60) async {
        guard ManagerRefreshPolicy.shouldRefresh(
            lastSuccessfulRefreshAt: lastSuccessfulRefreshAt,
            now: now,
            maxAge: maxAge
        ) else { return }
        await refresh()
    }

    func refresh() async {
        await work("Checking environment", blocksInterface: suite == nil) {
            self.traceSourceCatalog = nil
            let status = try await cli.run(["status"], as: SuiteStatus.self)
            self.suite = status

            async let codex = self.cli.run(ManagerCheckPolicy.quickHostStatusArguments("codex"), as: HostStatusResult.self)
            async let claude = self.cli.run(ManagerCheckPolicy.quickHostStatusArguments("claude"), as: HostStatusResult.self)
            async let zcode = self.cli.run(ManagerCheckPolicy.quickHostStatusArguments("zcode"), as: HostStatusResult.self)
            async let activity = self.cli.run(["activity"], as: ActivityResult.self)
            async let snapshot = self.cli.run(["snapshot"], as: SuiteSnapshot.self)
            async let usage = self.cli.run(["usage"], as: UsageSummary.self)

            let hostValues = try await [zcode, codex, claude]
            self.hostStatuses = Dictionary(uniqueKeysWithValues: hostValues.map { ($0.host, $0) })
            self.selectDefaultSetupHostIfNeeded()

            if status.configured {
                self.observations = try await self.cli.run(["observability", "status"], as: ObservabilityStatus.self)
                // Agent-app CLIs may load project-scoped configuration and ask
                // macOS for unrelated folder access. Startup checks the local
                // environment and real direct routes without launching them;
                // Run Full Check performs the explicit binding inspection.
                self.doctor = try await self.cli.run(ManagerCheckPolicy.foregroundDoctorArguments, as: DoctorResult.self)
            } else {
                self.observations = nil
                self.usage = nil
                self.doctor = nil
            }

            self.activity = try await activity.entries
            self.snapshot = try? await snapshot
            self.usage = try? await usage
            self.lastSuccessfulRefreshAt = Date()
        }
    }

    func prepareSetup() async {
        await work("Preparing setup") {
            self.setupPlan = try await self.cli.run(self.setupArguments(dryRun: true), as: SetupPlan.self)
            self.isPresentingSetupPlan = true
        }
    }

    func installSelectedProfile() async {
        isPresentingSetupPlan = false
        await work("Installing tools") {
            _ = try await self.cli.run(self.setupArguments(dryRun: false), as: GenericResult.self)
            try await self.reloadAll()
        }
    }

    func prepareFeaturedAcquire() async {
        await prepareUpdate(profile: "featured")
    }

    func redetectAgentApps() async {
        await refresh()
    }

    func runDoctor(deep: Bool = true) async {
        await work(deep ? "Running full check" : "Checking environment") {
            let checked = try await self.cli.run(deep ? ManagerCheckPolicy.fullDoctorArguments : ["doctor"], as: DoctorResult.self)
            // A full check can run after an external CLI update or working-set
            // change. Reload every displayed surface so the new status is not
            // combined with an old snapshot, activity list, or host summary,
            // while preserving the explicit Agent-app checks just completed.
            try await self.reloadAll(preserving: checked)
        }
    }

    func prepareUpdate(profile: String? = nil, replacingHostConflicts: Bool = false) async {
        environmentPreparation = .update(profile: profile, replaceHostConflicts: replacingHostConflicts)
        let arguments = ManagerSetupPolicy.updateArguments(
            profile: profile,
            releaseManifest: releaseManifestPath,
            replaceHostConflicts: replacingHostConflicts,
            dryRun: true
        )
        await work("Preparing update") {
            do {
                let plan = try await self.cli.run(arguments, as: UpdatePlan.self)
                self.environmentChangePlan = .update(plan, profile: profile, replaceHostConflicts: replacingHostConflicts)
                self.isPresentingEnvironmentChangePlan = true
            } catch let error as CLIError {
                if case let CLIError.failed(code, _) = error, Self.isHostConflict(code) {
                    self.recovery = .replaceHostConflicts
                }
                throw error
            }
        }
    }

    func prepareRepair(replacingHostConflicts: Bool = false) async {
        environmentPreparation = .repair
        let arguments = ManagerSetupPolicy.repairArguments(
            replaceHostConflicts: replacingHostConflicts,
            dryRun: true
        )
        await work("Preparing repair") {
            do {
                let plan = try await self.cli.run(arguments, as: RepairPlan.self)
                self.environmentChangePlan = .repair(plan, replaceHostConflicts: replacingHostConflicts)
                self.isPresentingEnvironmentChangePlan = true
            } catch let error as CLIError {
                if case let CLIError.failed(code, _) = error, Self.isHostConflict(code) {
                    self.recovery = .replaceHostConflicts
                }
                throw error
            }
        }
    }

    func replaceConflictingInstallations() async {
        recovery = nil
        switch environmentPreparation {
        case .repair:
            await prepareRepair(replacingHostConflicts: true)
        case let .update(profile, _):
            await prepareUpdate(profile: profile, replacingHostConflicts: true)
        case nil:
            await prepareUpdate(replacingHostConflicts: true)
        }
    }

    func prepareRollback() async {
        await work("Preparing restore") {
            let plan = try await self.cli.run(["rollback", "--dry-run"], as: RollbackPlan.self)
            self.environmentChangePlan = .rollback(plan)
            self.isPresentingEnvironmentChangePlan = true
        }
    }

    func applyEnvironmentChange() async {
        guard let plan = environmentChangePlan else { return }
        isPresentingEnvironmentChangePlan = false
        environmentChangePlan = nil
        switch plan {
        case let .update(update, profile, replaceHostConflicts):
            let arguments = ManagerSetupPolicy.updateArguments(
                profile: profile,
                releaseManifest: releaseManifestPath,
                replaceHostConflicts: replaceHostConflicts,
                dryRun: false,
                planId: update.planId
            )
            await action(arguments, label: "Updating environment", conflictRecovery: true)
        case let .repair(repair, replaceHostConflicts):
            let arguments = ManagerSetupPolicy.repairArguments(
                replaceHostConflicts: replaceHostConflicts,
                dryRun: false,
                planId: repair.planId
            )
            await action(arguments, label: "Repairing environment", conflictRecovery: true)
        case .rollback:
            await action(["rollback"], label: "Restoring previous version")
        }
    }

    func setObservability(_ enabled: Bool) async {
        await action(["observability", enabled ? "enable" : "disable"], label: enabled ? "Turning on monitoring" : "Turning off monitoring")
    }

    func loadTraceSources(provider: String) async {
        await work("Loading trace sessions", blocksInterface: false) {
            self.traceSourceCatalog = nil
            let catalog = try await self.cli.run(
                ["observability", "trace-sources", "--provider", provider, "--limit", "25"],
                as: TraceSourceCatalog.self
            )
            guard catalog.isValid(expectedProvider: provider) else {
                throw CLIError.failed(
                    code: "TRACE_SOURCE_CATALOG_INVALID",
                    message: "Agent Host returned an invalid retained trace catalog."
                )
            }
            self.traceSourceCatalog = catalog
        }
    }

    func prepareTraceExport(provider: String, sessionHash: String) async -> Data? {
        await workResult("Preparing trace export", blocksInterface: false) {
            try await self.cli.exportRetainedTrace(provider: provider, sessionHash: sessionHash)
        }
    }

    func setHost(_ id: String, connected: Bool) async {
        guard connected else {
            await action(["host", "remove", id], label: "Disconnecting Agent app")
            return
        }
        await work("Connecting Agent app") {
            do {
                _ = try await self.cli.run(["host", "add", id], as: GenericResult.self)
            } catch let error as CLIError {
                if case let CLIError.failed(code, _) = error, Self.isHostConflict(code) {
                    self.recovery = .replaceHostConnection(id)
                }
                throw error
            }
            self.doctor = nil
            try await self.reloadAll()
        }
    }

    func replaceConflictingHostConnection() async {
        guard case let .replaceHostConnection(id) = recovery else { return }
        recovery = nil
        await action(["host", "add", id, "--replace-host-conflicts"], label: "Connecting \(ManagerAgentApp.named(id).name)")
    }

    func setTool(_ id: String, active: Bool) async {
        let current = suite?.agentComponents ?? []
        let next = active ? Array(Set(current + [id])).sorted(by: toolOrderIndex) : current.filter { $0 != id }
        guard !next.isEmpty else { return }
        await work(active ? "Making tool available" : "Removing tool from Agent apps") {
            var arguments = ["tools", "set"]
            for component in ManagerToolPolicy.orderedToolIDs(next, preferredOrder: Self.toolOrder) {
                arguments += ["--tool", component]
            }
            let result = try await self.cli.run(arguments, as: ToolSetChangeResult.self)
            self.toolSetNeedsFreshTask = result.restartRequired
            self.doctor = nil
            try await self.reloadAll()
        }
    }

    func uninstall(purgeData: Bool = false) async {
        await action(purgeData ? ["uninstall", "--purge-data"] : ["uninstall"], label: "Removing Agent Host")
    }

    func dismissError() {
        errorMessage = nil
        recovery = nil
    }

    private func setupArguments(dryRun: Bool) -> [String] {
        ManagerSetupPolicy.setupArguments(
            profile: selectedSetupProfile,
            host: connectsAgentDuringSetup ? selectedSetupHost : nil,
            releaseManifest: releaseManifestPath,
            dryRun: dryRun
        )
    }

    private func action(_ arguments: [String], label: String, conflictRecovery: Bool = false) async {
        await work(label) {
            do {
                _ = try await self.cli.run(arguments, as: GenericResult.self)
            } catch let error as CLIError {
                if conflictRecovery, case let CLIError.failed(code, _) = error, Self.isHostConflict(code) {
                    self.recovery = .replaceHostConflicts
                }
                throw error
            }
            self.doctor = nil
            try await self.reloadAll()
        }
    }

    private func reloadAll(preserving checkedDoctor: DoctorResult? = nil) async throws {
        try await reloadStatus()
        traceSourceCatalog = nil
        guard suite?.configured == true else {
            observations = nil
            usage = nil
            traceSourceCatalog = nil
            doctor = nil
            snapshot = nil
            hostStatuses = [:]
            activity = (try? await cli.run(["activity"], as: ActivityResult.self).entries) ?? []
            return
        }
        async let codex = cli.run(ManagerCheckPolicy.quickHostStatusArguments("codex"), as: HostStatusResult.self)
        async let claude = cli.run(ManagerCheckPolicy.quickHostStatusArguments("claude"), as: HostStatusResult.self)
        async let zcode = cli.run(ManagerCheckPolicy.quickHostStatusArguments("zcode"), as: HostStatusResult.self)
        async let activity = cli.run(["activity"], as: ActivityResult.self)
        async let snapshot = cli.run(["snapshot"], as: SuiteSnapshot.self)
        async let usage = cli.run(["usage"], as: UsageSummary.self)
        let hosts = await [try? zcode, try? codex, try? claude].compactMap { $0 }
        self.hostStatuses = Dictionary(uniqueKeysWithValues: hosts.map { ($0.host, $0) })
        self.selectDefaultSetupHostIfNeeded()
        self.observations = try? await cli.run(["observability", "status"], as: ObservabilityStatus.self)
        if let checkedDoctor {
            self.doctor = checkedDoctor
        } else {
            self.doctor = try? await cli.run(ManagerCheckPolicy.foregroundDoctorArguments, as: DoctorResult.self)
        }
        self.activity = (try? await activity.entries) ?? []
        self.snapshot = try? await snapshot
        self.usage = try? await usage
        self.lastSuccessfulRefreshAt = Date()
    }

    private func reloadStatus() async throws {
        suite = try await cli.run(["status"], as: SuiteStatus.self)
    }

    private func work(_ label: String, blocksInterface: Bool = true, _ operation: () async throws -> Void) async {
        guard !isBusy else { return }
        isBusy = true
        isBlockingWork = blocksInterface
        currentAction = label
        errorMessage = nil
        recovery = nil
        defer {
            isBusy = false
            isBlockingWork = false
            currentAction = nil
        }
        do {
            try await operation()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func workResult<T>(
        _ label: String,
        blocksInterface: Bool = true,
        _ operation: () async throws -> T
    ) async -> T? {
        guard !isBusy else { return nil }
        isBusy = true
        isBlockingWork = blocksInterface
        currentAction = label
        errorMessage = nil
        recovery = nil
        defer {
            isBusy = false
            isBlockingWork = false
            currentAction = nil
        }
        do {
            return try await operation()
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    private func tool(id: String, name: String, summary: String, systemImage: String) -> ManagedTool {
        let component = suite?.components?[id]
        let componentFailed = doctor?.check("component.\(id)")?.status == "error"
        let hostFailed = (suite?.hosts ?? [:]).keys.contains { doctor?.hasFailure(prefix: "host.\($0).\(id)") == true }
        let runtimeFailed = doctor?.hasFailure(prefix: "tool.\(id).") == true
        let state: ManagedItemState
        let active = suite?.agentComponents?.contains(id) ?? false
        if component == nil {
            state = .unavailable
        } else if !active {
            state = .inactive
        } else if doctor == nil {
            state = .checking
        } else if componentFailed || hostFailed || runtimeFailed {
            state = .attention
        } else {
            state = .ready
        }

        let availableHosts = (suite?.hosts ?? [:]).compactMap { host, value in
            value.entries?.contains { $0.component == id } == true ? displayName(for: host) : nil
        }.sorted()
        let ownershipValues = (suite?.hosts ?? [:]).flatMap { $0.value.entries ?? [] }.filter { $0.component == id }.map(\.ownership)
        let ownership = L10n.text(ownershipValues.contains("suite") ? "Managed by Agent Host" : ownershipValues.isEmpty ? "Kept in this environment" : "Installed by you")

        return ManagedTool(
            id: id,
            name: name,
            summary: summary,
            systemImage: systemImage,
            version: component?.version,
            state: state,
            availability: availableHosts.isEmpty ? L10n.text("Not selected for an Agent app") : L10n.format("Selected for {apps}", ["apps": availableHosts.joined(separator: L10n.text(" and "))]),
            ownership: ownership,
            active: active
        )
    }

    private func toolOrderIndex(_ left: String, _ right: String) -> Bool {
        (Self.toolOrder.firstIndex(of: left) ?? Int.max) < (Self.toolOrder.firstIndex(of: right) ?? Int.max)
    }

    private func displayName(for host: String) -> String {
        ManagerAgentApp.named(host).name
    }

    private static func isHostConflict(_ code: String) -> Bool {
        [
            "CODEX_PLUGIN_CONFLICT", "CODEX_MARKETPLACE_CONFLICT",
            "CLAUDE_MCP_CONFLICT", "ZCODE_MCP_CONFLICT",
            "DEVELOPER_SKILL_CONFLICT", "PRODUCT_SKILL_CONFLICT",
        ].contains(code)
    }

    private func selectDefaultSetupHostIfNeeded() {
        guard suite?.configured != true, hostStatuses[selectedSetupHost]?.appInstalled != true else { return }
        if let available = ManagerAgentApp.all.first(where: { hostStatuses[$0.id]?.appInstalled == true }) {
            selectedSetupHost = available.id
        }
    }

    private static let toolOrder = [
        "math-anchor", "migratory-time", "data-transformer", "armorial", "laniakea",
        "projective", "equatorium", "file-vitals",
    ]

    private static let toolMetadata: [String: (name: String, summary: String, systemImage: String)] = [
        "math-anchor": ("Math Anchor", "Exact and reliability-sensitive calculation", "function"),
        "migratory-time": ("Migratory Time", "Time-zone conversion with daylight-saving rules", "globe.americas"),
        "data-transformer": ("BatchTicket", "Inspect, reshape, validate, and compare structured data", "tablecells"),
        "armorial": ("Armorial", "Choose project-aware icons without redrawing them", "shield.lefthalf.filled"),
        "laniakea": ("Laniakea", "Create, inspect, search, and revise Markdown mind maps", "point.3.connected.trianglepath.dotted"),
        "projective": ("Projective", "Compose, inspect, render, and emit explicit projective planes", "square.resize"),
        "equatorium": ("Equatorium", "Interpret specification-dense standard expressions deterministically", "textformat.abc"),
        "file-vitals": ("File Vitals", "Inspect and inventory files before acting on them", "doc.text.magnifyingglass"),
    ]
}

private struct GenericResult: Decodable, Sendable {
    let status: String
}

private extension ManagerHealth {
    var needsRepair: Bool {
        if case .attention = self { return true }
        return false
    }
}
