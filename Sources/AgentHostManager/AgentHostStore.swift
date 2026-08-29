import Foundation

enum RecoveryOption: Equatable {
    case replaceHostConflicts
}

@MainActor
final class AgentHostStore: ObservableObject {
    @Published private(set) var suite: SuiteStatus?
    @Published private(set) var observations: ObservabilityStatus?
    @Published private(set) var doctor: DoctorResult?
    @Published private(set) var snapshot: SuiteSnapshot?
    @Published private(set) var hostStatuses: [String: HostStatusResult] = [:]
    @Published private(set) var activity: [ActivityEntry] = []
    @Published private(set) var setupPlan: SetupPlan?
    @Published private(set) var environmentChangePlan: EnvironmentChangePlan?
    @Published private(set) var toolSetNeedsFreshTask = false
    @Published private(set) var isBusy = false
    @Published private(set) var currentAction: String?
    @Published var errorMessage: String?
    @Published private(set) var recovery: RecoveryOption?
    @Published var isPresentingSetupPlan = false
    @Published var isPresentingEnvironmentChangePlan = false

    private let cli: AgentHostCLI
    private let environment: [String: String]

    init(
        cli: AgentHostCLI = AgentHostCLI(),
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.cli = cli
        self.environment = environment
    }

    var health: ManagerHealth {
        if isBusy && suite == nil { return .loading }
        guard let suite, suite.configured else { return .unavailable }
        guard doctor != nil else { return isBusy ? .loading : .attention("Run a health check") }
        let unhealthy = healthFacets.filter { !$0.isHealthy }
        if unhealthy.isEmpty { return .ready }
        let labels = attentionLabels
        if labels.count == 1, let label = labels.first { return .attention("\(label) needs attention") }
        if unhealthy.count == 1 { return .attention("\(unhealthy[0].name) needs attention") }
        return .attention("\(unhealthy.count) items need attention")
    }

    // Independent health surfaces. No single "Ready" may hide an unhealthy
    // facet: host bindings, installed tools, direct execution, monitoring
    // completeness/freshness, and the context-catalog budget each report here.
    var healthFacets: [ManagerHealthFacet] {
        guard let doctor else { return [] }
        var facets: [ManagerHealthFacet] = []

        let hostProblems = doctor.checks.filter { $0.id.hasPrefix("host.") && $0.status == "error" }
        facets.append(ManagerHealthFacet(
            id: "agent-apps",
            name: "Agent apps",
            isHealthy: hostProblems.isEmpty,
            detail: hostProblems.isEmpty ? "Connected apps have current bindings" : hostProblems[0].message
        ))

        let toolProblems = doctor.checks.filter {
            ($0.id.hasPrefix("component.") || ($0.id.hasPrefix("tool.") && $0.id.hasSuffix(".installed"))) && $0.status == "error"
        }
        facets.append(ManagerHealthFacet(
            id: "tools",
            name: "Tools",
            isHealthy: toolProblems.isEmpty,
            detail: toolProblems.isEmpty ? "Installed tool runtimes are ready" : toolProblems[0].message
        ))

        let runtimeProblems = doctor.checks.filter {
            ($0.id.hasPrefix("runtime.") || ($0.id.hasPrefix("tool.") && $0.id.hasSuffix(".direct"))) && $0.status == "error"
        }
        facets.append(ManagerHealthFacet(
            id: "direct-execution",
            name: "Direct execution",
            isHealthy: runtimeProblems.isEmpty,
            detail: runtimeProblems.isEmpty ? "The local execution service and direct probes are ready" : runtimeProblems[0].message
        ))

        facets.append(monitoringFacet)
        facets.append(catalogFacet)
        return facets
    }

    private var monitoringFacet: ManagerHealthFacet {
        guard let observations else {
            return ManagerHealthFacet(id: "monitoring", name: "Monitoring", isHealthy: true, detail: "Not configured")
        }
        guard observations.enabled else {
            return ManagerHealthFacet(id: "monitoring", name: "Monitoring", isHealthy: true, detail: "Off")
        }
        guard let collection = snapshot?.observability?.collection else {
            return ManagerHealthFacet(id: "monitoring", name: "Monitoring", isHealthy: false, detail: "On, but no collection result has been recorded")
        }
        return MonitoringHealthEvaluator.evaluate(
            collection: collection,
            refreshedAt: snapshot?.observability?.refreshedAt ?? observations.latest?.refreshedAt,
            maintenanceIntervalSeconds: observations.maintenance?.intervalSeconds
        )
    }

    private var catalogFacet: ManagerHealthFacet {
        let catalog = snapshot?.observability?.catalog
        guard let catalog, catalog.canonicalUtf8Bytes != nil else {
            return ManagerHealthFacet(id: "catalog", name: "Tool catalog", isHealthy: true, detail: "No measurement (monitoring off or not refreshed)")
        }
        let exceeded = (catalog.budgetChecks ?? []).filter(\.exceeded)
        guard !exceeded.isEmpty else {
            return ManagerHealthFacet(id: "catalog", name: "Tool catalog", isHealthy: true, detail: "Within declared budgets")
        }
        let names = exceeded.map { budgetName($0.metric) }.joined(separator: ", ")
        return ManagerHealthFacet(
            id: "catalog",
            name: "Tool catalog",
            isHealthy: false,
            detail: "Over budget: \(names)"
        )
    }

    var catalogBudgetSummary: String? {
        guard let catalog = snapshot?.observability?.catalog, let bytes = catalog.canonicalUtf8Bytes else { return nil }
        var parts = [
            "\(catalog.tools ?? 0) tools",
            "\(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .binary)) catalog",
        ]
        if let largest = catalog.largestToolUtf8Bytes {
            parts.append("largest tool \(ByteCountFormatter.string(fromByteCount: Int64(largest), countStyle: .binary))")
        }
        let exceeded = (catalog.budgetChecks ?? []).filter(\.exceeded)
        if let catalogBudget = (catalog.budgetChecks ?? []).first(where: { $0.metric == "catalog.canonicalUtf8Bytes" }) {
            parts.append("budget \(ByteCountFormatter.string(fromByteCount: Int64(catalogBudget.limit), countStyle: .binary))")
        }
        if !exceeded.isEmpty {
            parts.append("OVER BUDGET (\(exceeded.count))")
        }
        return parts.joined(separator: " · ")
    }

    var monitoringSummary: String {
        guard let observations, observations.enabled else { return "Off" }
        let facet = monitoringFacet
        return facet.detail
    }

    var storageSummary: String? {
        guard let bytes = snapshot?.storage?.allocatedBytes else { return nil }
        var parts = [ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .binary)]
        if let processes = snapshot?.processes, let count = processes.processCount {
            var baseline = "\(count) live suite process\(count == 1 ? "" : "es")"
            if let rss = processes.totalRssBytes {
                baseline += " · \(ByteCountFormatter.string(fromByteCount: Int64(rss), countStyle: .binary)) resident"
            }
            parts.append(baseline)
        }
        return parts.joined(separator: " · ")
    }

    var managedTools: [ManagedTool] {
        Self.toolOrder.compactMap { id in
            guard suite?.components?[id] != nil else { return nil }
            let metadata = Self.toolMetadata[id]!
            return tool(id: id, name: suite?.components?[id]?.displayName ?? metadata.name, summary: suite?.components?[id]?.summary ?? metadata.summary, systemImage: metadata.systemImage)
        }
    }

    var connectedAgentAppCount: Int {
        suite?.hosts?.values.filter(\.installed).count ?? 0
    }

    var localExecutionStatus: String {
        guard suite?.service != nil else { return "Stopped" }
        guard let service = doctor?.check("runtime.service") else { return "Checking" }
        return service.status == "ok" ? "Running" : "Needs attention"
    }

    func refresh() async {
        await work("Checking environment") {
            let status = try await cli.run(["status"], as: SuiteStatus.self)
            self.suite = status

            async let codex = self.cli.run(["host", "status", "codex"], as: HostStatusResult.self)
            async let claude = self.cli.run(["host", "status", "claude"], as: HostStatusResult.self)
            async let activity = self.cli.run(["activity"], as: ActivityResult.self)
            async let snapshot = self.cli.run(["snapshot"], as: SuiteSnapshot.self)

            if status.configured {
                async let observations = self.cli.run(["observability", "status"], as: ObservabilityStatus.self)
                async let doctor = self.cli.run(["doctor", "--deep"], as: DoctorResult.self)
                self.observations = try await observations
                self.doctor = try await doctor
            } else {
                self.observations = nil
                self.doctor = nil
            }

            let hostValues = try await [codex, claude]
            self.hostStatuses = Dictionary(uniqueKeysWithValues: hostValues.map { ($0.host, $0) })
            self.activity = try await activity.entries
            self.snapshot = try? await snapshot
        }
    }

    func prepareSetup() async {
        await work("Preparing setup") {
            self.setupPlan = try await self.cli.run(self.setupArguments(dryRun: true), as: SetupPlan.self)
            self.isPresentingSetupPlan = true
        }
    }

    func installStandard() async {
        isPresentingSetupPlan = false
        await work("Installing standard tools") {
            _ = try await self.cli.run(self.setupArguments(dryRun: false), as: GenericResult.self)
            await self.reloadAll()
        }
    }

    func runDoctor(deep: Bool = true) async {
        await work(deep ? "Running full check" : "Checking environment") {
            self.doctor = try await self.cli.run(deep ? ["doctor", "--deep"] : ["doctor"], as: DoctorResult.self)
            await self.reloadStatus()
        }
    }

    func prepareUpdate(profile: String? = nil, replacingHostConflicts: Bool = false) async {
        var arguments = ["update"]
        if let profile { arguments += ["--profile", profile] }
        if replacingHostConflicts { arguments.append("--replace-host-conflicts") }
        arguments.append("--dry-run")
        await work(health.needsRepair ? "Preparing repair" : "Preparing update") {
            do {
                let plan = try await self.cli.run(arguments, as: UpdatePlan.self)
                self.environmentChangePlan = .update(plan, profile: profile, replaceHostConflicts: replacingHostConflicts)
                self.isPresentingEnvironmentChangePlan = true
            } catch let error as CLIError {
                if case let CLIError.failed(code, _) = error,
                   code == "CODEX_PLUGIN_CONFLICT" || code == "CODEX_MARKETPLACE_CONFLICT" {
                    self.recovery = .replaceHostConflicts
                }
                throw error
            }
        }
    }

    func replaceConflictingInstallations() async {
        recovery = nil
        await prepareUpdate(replacingHostConflicts: true)
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
        case let .update(_, profile, replaceHostConflicts):
            var arguments = ["update"]
            if let profile { arguments += ["--profile", profile] }
            if replaceHostConflicts { arguments.append("--replace-host-conflicts") }
            await action(arguments, label: health.needsRepair ? "Repairing environment" : "Updating environment", conflictRecovery: true)
        case .rollback:
            await action(["rollback"], label: "Restoring previous version")
        }
    }

    func setObservability(_ enabled: Bool) async {
        await action(["observability", enabled ? "enable" : "disable"], label: enabled ? "Turning on monitoring" : "Turning off monitoring")
    }

    func setHost(_ id: String, connected: Bool) async {
        await action(["host", connected ? "add" : "remove", id], label: connected ? "Connecting Agent app" : "Disconnecting Agent app")
    }

    func setTool(_ id: String, active: Bool) async {
        let current = suite?.agentComponents ?? []
        let next = active ? Array(Set(current + [id])).sorted(by: toolOrderIndex) : current.filter { $0 != id }
        guard !next.isEmpty else { return }
        await work(active ? "Making tool available" : "Removing tool from Agent apps") {
            var arguments = ["tools", "set"]
            for component in Self.toolOrder where next.contains(component) {
                arguments += ["--tool", component]
            }
            let result = try await self.cli.run(arguments, as: ToolSetChangeResult.self)
            self.toolSetNeedsFreshTask = result.restartRequired
            self.doctor = nil
            await self.reloadAll()
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
        var arguments = ["setup", "--profile", "standard", "--host", "codex"]
        if let root = environment["AGENT_HOST_DEVELOPMENT_ROOT"], !root.isEmpty {
            arguments += ["--development-root", root]
        }
        if dryRun { arguments.append("--dry-run") }
        return arguments
    }

    private func action(_ arguments: [String], label: String, conflictRecovery: Bool = false) async {
        await work(label) {
            do {
                _ = try await self.cli.run(arguments, as: GenericResult.self)
            } catch let error as CLIError {
                if conflictRecovery, case let CLIError.failed(code, _) = error,
                   code == "CODEX_PLUGIN_CONFLICT" || code == "CODEX_MARKETPLACE_CONFLICT" {
                    self.recovery = .replaceHostConflicts
                }
                throw error
            }
            self.doctor = nil
            await self.reloadAll()
        }
    }

    private func reloadAll() async {
        await reloadStatus()
        guard suite?.configured == true else {
            observations = nil
            doctor = nil
            snapshot = nil
            hostStatuses = [:]
            activity = (try? await cli.run(["activity"], as: ActivityResult.self).entries) ?? []
            return
        }
        async let observations = cli.run(["observability", "status"], as: ObservabilityStatus.self)
        async let doctor = cli.run(["doctor", "--deep"], as: DoctorResult.self)
        async let codex = cli.run(["host", "status", "codex"], as: HostStatusResult.self)
        async let claude = cli.run(["host", "status", "claude"], as: HostStatusResult.self)
        async let activity = cli.run(["activity"], as: ActivityResult.self)
        async let snapshot = cli.run(["snapshot"], as: SuiteSnapshot.self)
        self.observations = try? await observations
        self.doctor = try? await doctor
        let hosts = await [try? codex, try? claude].compactMap { $0 }
        self.hostStatuses = Dictionary(uniqueKeysWithValues: hosts.map { ($0.host, $0) })
        self.activity = (try? await activity.entries) ?? []
        self.snapshot = try? await snapshot
    }

    private func reloadStatus() async {
        suite = try? await cli.run(["status"], as: SuiteStatus.self)
    }

    private func work(_ label: String, _ operation: () async throws -> Void) async {
        guard !isBusy else { return }
        isBusy = true
        currentAction = label
        errorMessage = nil
        recovery = nil
        defer {
            isBusy = false
            currentAction = nil
        }
        do {
            try await operation()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func tool(id: String, name: String, summary: String, systemImage: String) -> ManagedTool {
        let component = suite?.components?[id]
        let componentFailed = doctor?.check("component.\(id)")?.status == "error"
        let hostFailed = doctor?.hasFailure(prefix: "host.codex.\(id)") == true || doctor?.hasFailure(prefix: "host.claude.\(id)") == true
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
        let ownership = ownershipValues.contains("suite") ? "Managed by Agent Host" : ownershipValues.isEmpty ? "Kept in this environment" : "Installed by you"

        return ManagedTool(
            id: id,
            name: name,
            summary: summary,
            systemImage: systemImage,
            version: component?.version,
            state: state,
            availability: availableHosts.isEmpty ? "Not available in an Agent app" : "Available in \(availableHosts.joined(separator: " and "))",
            ownership: ownership,
            active: active
        )
    }

    private func toolOrderIndex(_ left: String, _ right: String) -> Bool {
        (Self.toolOrder.firstIndex(of: left) ?? Int.max) < (Self.toolOrder.firstIndex(of: right) ?? Int.max)
    }

    private func displayName(for host: String) -> String {
        host == "claude" ? "Claude Code" : "Codex"
    }

    private var attentionLabels: [String] {
        var labels = Set<String>()
        if let doctor {
            let errors = doctor.checks.filter { $0.status == "error" }
            if errors.contains(where: { $0.id.contains("math-anchor") }) { labels.insert("Math Anchor") }
            if errors.contains(where: { $0.id.contains("migratory-time") }) { labels.insert("Migratory Time") }
            if errors.contains(where: { $0.id == "runtime.service" }) { labels.insert("Local execution") }
            if errors.contains(where: { $0.id == "host.codex" }) && !errors.contains(where: { $0.id.hasPrefix("host.codex.") }) { labels.insert("Codex") }
            if errors.contains(where: { $0.id == "host.claude" }) && !errors.contains(where: { $0.id.hasPrefix("host.claude.") }) { labels.insert("Claude Code") }
        }
        if !monitoringFacet.isHealthy { labels.insert("Monitoring") }
        if !catalogFacet.isHealthy { labels.insert("Tool catalog") }
        return labels.sorted()
    }

    private func budgetName(_ metric: String) -> String {
        switch metric {
        case "catalog.canonicalUtf8Bytes": "total catalog bytes"
        case "counts.tools": "tool count"
        case "catalog.largestToolUtf8Bytes": "largest tool bytes"
        default: metric
        }
    }

    private static let toolOrder = [
        "math-anchor", "migratory-time", "data-transformer", "armorial", "laniakea",
        "projective", "equatorium", "file-vitals", "context-surface-analyzer",
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
        "context-surface-analyzer": ("Context Surface Analyzer", "Measure and compare explicit Agent tool catalogs", "gauge.with.dots.needle.33percent"),
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
