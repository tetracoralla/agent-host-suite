import Foundation

enum ManagerHealthPolicy {
    static func facets(
        doctor: DoctorResult,
        suite: SuiteStatus?,
        hostStatuses: [String: HostStatusResult] = [:],
        observations: ObservabilityStatus? = nil,
        snapshot: SuiteSnapshot? = nil,
        now: Date = Date()
    ) -> [ManagerHealthFacet] {
        var facets: [ManagerHealthFacet] = []
        facets.append(agentAppsFacet(doctor: doctor, suite: suite, hostStatuses: hostStatuses))
        facets.append(toolsFacet(doctor: doctor))
        facets.append(directExecutionFacet(doctor: doctor))
        facets.append(monitoringFacet(observations: observations, snapshot: snapshot, now: now))
        facets.append(catalogFacet(snapshot: snapshot))

        let leftover = unclaimedBlockingErrors(doctor: doctor, suite: suite)
        if !leftover.isEmpty {
            facets.append(ManagerHealthFacet(
                id: "unclassified-checks",
                name: L10n.text("Environment checks"),
                isHealthy: false,
                detail: leftover[0].message
            ))
        }
        return facets
    }

    static func overall(
        isBusy: Bool,
        suite: SuiteStatus?,
        doctor: DoctorResult?,
        facets: [ManagerHealthFacet]
    ) -> ManagerHealth {
        if isBusy && suite == nil { return .loading }
        guard let suite, suite.configured else { return .unavailable }
        guard let doctor else { return isBusy ? .loading : .attention(L10n.text("Run a health check")) }
        let unhealthy = facets.filter { !$0.isHealthy }
        let blocking = doctor.checks.filter { $0.status == "error" }
        if unhealthy.isEmpty && blocking.isEmpty { return .ready }
        if unhealthy.isEmpty {
            return .attention(L10n.format("{item} needs attention", ["item": L10n.text("Environment checks")]))
        }
        let labels = attentionLabels(doctor: doctor, facets: facets)
        if labels.count == 1, let label = labels.first {
            return .attention(L10n.format("{item} needs attention", ["item": L10n.text(label)]))
        }
        if unhealthy.count == 1 {
            return .attention(L10n.format("{item} needs attention", ["item": L10n.text(unhealthy[0].name)]))
        }
        return .attention(L10n.format("{count} items need attention", ["count": unhealthy.count.formatted()]))
    }

    static func monitoringFacet(
        observations: ObservabilityStatus?,
        snapshot: SuiteSnapshot?,
        now: Date = Date()
    ) -> ManagerHealthFacet {
        guard let observations else {
            return ManagerHealthFacet(id: "monitoring", name: L10n.text("Monitoring"), isHealthy: true, detail: L10n.text("Not configured"))
        }
        guard observations.enabled else {
            return ManagerHealthFacet(id: "monitoring", name: L10n.text("Monitoring"), isHealthy: true, detail: L10n.text("Off"))
        }
        guard let collection = snapshot?.observability?.collection else {
            return ManagerHealthFacet(id: "monitoring", name: L10n.text("Monitoring"), isHealthy: false, detail: L10n.text("On, but no collection result has been recorded"))
        }
        return MonitoringHealthEvaluator.evaluate(
            collection: collection,
            refreshedAt: snapshot?.observability?.refreshedAt ?? observations.latest?.refreshedAt,
            maintenanceIntervalSeconds: observations.maintenance?.intervalSeconds,
            now: now
        )
    }

    static func catalogFacet(snapshot: SuiteSnapshot?) -> ManagerHealthFacet {
        let catalog = snapshot?.observability?.catalog
        guard let catalog, catalog.canonicalUtf8Bytes != nil else {
            return ManagerHealthFacet(id: "catalog", name: L10n.text("Tool catalog"), isHealthy: true, detail: L10n.text("No measurement (monitoring off or not refreshed)"))
        }
        let exceeded = (catalog.budgetChecks ?? []).filter(\.exceeded)
        guard !exceeded.isEmpty else {
            return ManagerHealthFacet(id: "catalog", name: L10n.text("Tool catalog"), isHealthy: true, detail: L10n.text("Within declared budgets"))
        }
        let names = exceeded.map { budgetName($0.metric) }.joined(separator: ", ")
        return ManagerHealthFacet(
            id: "catalog",
            name: L10n.text("Tool catalog"),
            isHealthy: false,
            detail: L10n.format("Over budget: {items}", ["items": names])
        )
    }

    private static func agentAppsFacet(
        doctor: DoctorResult,
        suite: SuiteStatus?,
        hostStatuses: [String: HostStatusResult]
    ) -> ManagerHealthFacet {
        let managedHostIDs = Set((suite?.hosts ?? [:]).filter(\.value.installed).map(\.key))
        let fullHostChecks = managedHostIDs.compactMap { doctor.check("host.\($0)") }
        let hostProblems = fullHostChecks.filter { $0.status == "error" }
        let missingApps = managedHostIDs.filter { hostStatuses[$0]?.appInstalled == false }
        let agentAppsVerified = managedHostIDs.isEmpty || fullHostChecks.count == managedHostIDs.count
        return ManagerHealthFacet(
            id: "agent-apps",
            name: L10n.text("Agent apps"),
            isHealthy: hostProblems.isEmpty && missingApps.isEmpty,
            detail: !hostProblems.isEmpty
                ? hostProblems[0].message
                : !missingApps.isEmpty
                    ? L10n.text("A connected Agent app is no longer installed")
                    : agentAppsVerified
                        ? L10n.text("Connected apps have current bindings")
                        : L10n.text("Connected apps are configured · Run Full Check to verify bindings")
        )
    }

    private static func toolsFacet(doctor: DoctorResult) -> ManagerHealthFacet {
        let toolProblems = doctor.checks.filter { check in
            check.status == "error" && (
                check.id == "profile.catalog"
                    || check.id.hasPrefix("component.")
                    || (check.id.hasPrefix("tool.") && check.id.hasSuffix(".installed"))
            )
        }
        return ManagerHealthFacet(
            id: "tools",
            name: L10n.text("Tools"),
            isHealthy: toolProblems.isEmpty,
            detail: toolProblems.isEmpty ? L10n.text("Installed tool runtimes are ready") : toolProblems[0].message
        )
    }

    private static func directExecutionFacet(doctor: DoctorResult) -> ManagerHealthFacet {
        let runtimeProblems = doctor.checks.filter {
            ($0.id.hasPrefix("runtime.") || ($0.id.hasPrefix("tool.") && $0.id.hasSuffix(".direct"))) && $0.status == "error"
        }
        return ManagerHealthFacet(
            id: "direct-execution",
            name: L10n.text("Direct execution"),
            isHealthy: runtimeProblems.isEmpty,
            detail: runtimeProblems.isEmpty ? L10n.text("The local execution service and direct probes are ready") : runtimeProblems[0].message
        )
    }

    private static func unclaimedBlockingErrors(doctor: DoctorResult, suite: SuiteStatus?) -> [DoctorCheck] {
        doctor.checks.filter { $0.status == "error" && !isClaimed($0, suite: suite) }
    }

    private static func isClaimed(_ check: DoctorCheck, suite: SuiteStatus?) -> Bool {
        if check.id == "profile.catalog" { return true }
        if check.id.hasPrefix("component.") { return true }
        if check.id.hasPrefix("runtime.") { return true }
        if check.id.hasPrefix("tool.") && (check.id.hasSuffix(".installed") || check.id.hasSuffix(".direct")) {
            return true
        }
        let managedHostIDs = Set((suite?.hosts ?? [:]).filter(\.value.installed).map(\.key))
        return managedHostIDs.contains { check.id == "host.\($0)" }
    }

    private static func attentionLabels(doctor: DoctorResult, facets: [ManagerHealthFacet]) -> [String] {
        var labels = Set<String>()
        let errors = doctor.checks.filter { $0.status == "error" }
        if errors.contains(where: { $0.id.contains("math-anchor") }) { labels.insert("Math Anchor") }
        if errors.contains(where: { $0.id.contains("migratory-time") }) { labels.insert("Migratory Time") }
        if errors.contains(where: { $0.id == "runtime.service" }) { labels.insert("Local execution") }
        if errors.contains(where: { $0.id == "host.codex" }) && !errors.contains(where: { $0.id.hasPrefix("host.codex.") }) { labels.insert("Codex") }
        if errors.contains(where: { $0.id == "host.claude" }) && !errors.contains(where: { $0.id.hasPrefix("host.claude.") }) { labels.insert("Claude Code") }
        if errors.contains(where: { $0.id == "host.zcode" }) && !errors.contains(where: { $0.id.hasPrefix("host.zcode.") }) { labels.insert("ZCode") }
        if facets.contains(where: { $0.id == "monitoring" && !$0.isHealthy }) { labels.insert("Monitoring") }
        if facets.contains(where: { $0.id == "catalog" && !$0.isHealthy }) { labels.insert("Tool catalog") }
        return labels.sorted()
    }

    private static func budgetName(_ metric: String) -> String {
        switch metric {
        case "catalog.canonicalUtf8Bytes": "total catalog bytes"
        case "counts.tools": "tool count"
        case "catalog.largestToolUtf8Bytes": "largest tool bytes"
        default: metric
        }
    }
}
