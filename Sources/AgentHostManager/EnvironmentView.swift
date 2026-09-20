import SwiftUI

struct EnvironmentView: View {
    @ObservedObject var store: AgentHostStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Overview", subtitle: L10n.format("{toolSet} on this Mac", ["toolSet": toolSetName])) {
                    HealthPill(health: store.health)
                }

                postSetupHandoff

                if case let .attention(message) = store.health, !store.postSetupGuidance.readyToWork {
                    // Attention already expressed in the handoff; keep a compact repair row when needed.
                    if store.postSetupGuidance.primaryActionID != .reviewRepair {
                        Panel {
                            NoticeView(
                                title: message,
                                message: firstFailure ?? "Run a full check to identify the affected tool or Agent app.",
                                systemImage: "exclamationmark.triangle.fill",
                                color: .orange
                            )
                        }
                    }
                }

                Panel {
                    Text(L10n.text("Health details")).font(.headline)
                    Text(L10n.text("Status rows are supporting detail. Starting work is the destination."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ForEach(store.healthFacets) { facet in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: facet.isHealthy ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                                .foregroundStyle(facet.isHealthy ? .green : .orange)
                                .frame(width: 18)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(L10n.text(facet.name))
                                Text(L10n.text(facet.detail))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(L10n.text(facet.name)): \(L10n.text(facet.detail))")
                    }
                }

                Panel {
                    Text(L10n.text("Current environment")).font(.headline)
                    LabeledContent(L10n.text("Application"), value: applicationVersion)
                    LabeledContent(L10n.text("Environment"), value: environmentVersion)
                    LabeledContent(L10n.text("Catalog source"), value: catalogSourceLabel)
                    if let lastCheck = store.source?.source?.lastCheck {
                        LabeledContent(L10n.text("Last check"), value: [lastCheck.status, lastCheck.code].compactMap { $0 }.joined(separator: " · "))
                    }
                    LabeledContent(L10n.text("Tool set"), value: toolSetName)
                    LabeledContent(L10n.text("Tools"), value: store.managedTools.count.formatted())
                    LabeledContent(L10n.text("Agent apps"), value: store.connectedAgentAppCount.formatted())
                    LabeledContent(L10n.text("Local execution"), value: L10n.text(store.localExecutionStatus))
                    LabeledContent(L10n.text("Monitoring"), value: L10n.text(store.monitoringSummary))
                    if store.isRefreshing {
                        LabeledContent(L10n.text("Status checked"), value: L10n.text("Refreshing…"))
                    } else if let refreshedAt = store.lastSuccessfulRefreshAt {
                        LabeledContent(L10n.text("Status checked")) {
                            Text(L10n.relativeAge(since: refreshedAt))
                        }
                    }
                    if let storage = store.storageSummary {
                        LabeledContent(L10n.text("Storage · live processes"), value: storage)
                    }
                    if let catalog = store.catalogBudgetSummary {
                        LabeledContent(L10n.text("Tool catalog"), value: catalog)
                    }
                }

                HStack {
                    Button(L10n.text("Run Full Check")) { Task { await store.runDoctor() } }
                        .disabled(store.isBusy)
                    Button(L10n.text("Review Update")) { Task { await store.prepareUpdate() } }
                        .disabled(store.isBusy)
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(32)
        }
    }

    @ViewBuilder
    private var postSetupHandoff: some View {
        let guidance = store.postSetupGuidance
        Panel {
            NoticeView(
                title: L10n.text(guidance.title),
                message: L10n.text(guidance.summary),
                systemImage: guidance.readyToWork ? "arrow.forward.circle.fill" : "exclamationmark.triangle.fill",
                color: guidance.readyToWork ? .blue : .orange
            )

            if let problemClass = guidance.problemClass {
                LabeledContent(L10n.text("Problem class"), value: L10n.text(problemClass.rawValue))
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(L10n.text("What Host confirmed")).font(.subheadline.weight(.semibold))
                ForEach(guidance.observed, id: \.self) { line in
                    Text("• \(L10n.text(line))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if !guidance.gaps.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L10n.text("Still open")).font(.subheadline.weight(.semibold))
                    ForEach(guidance.gaps, id: \.self) { line in
                        Text("• \(L10n.text(line))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Text(L10n.format("Recovery path: {path}", ["path": L10n.text(guidance.recoveryPath)]))
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack {
                Button(L10n.text(guidance.primaryActionLabel)) {
                    store.performPostSetupPrimaryAction()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(store.isBusy)
                .accessibilityIdentifier("post-setup-primary-cta")

                if guidance.primaryActionID != .runFullCheck {
                    Button(L10n.text("Run Full Check")) { Task { await store.runDoctor() } }
                        .disabled(store.isBusy)
                }
            }

            Text(L10n.text(guidance.primaryActionDetail))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("post-setup-handoff")
    }

    private var firstFailure: String? {
        if let message = store.doctor?.checks.first(where: { $0.status == "error" })?.message { return message }
        return store.healthFacets.first { !$0.isHealthy }?.detail
    }

    private var toolSetName: String {
        switch store.suite?.profile {
        case "featured": L10n.text("Featured tools")
        case "local-dogfood": L10n.text("Standard + Local tools")
        case "observability": L10n.text("Standard + Monitoring")
        default: L10n.text("Standard")
        }
    }

    private var applicationVersion: String {
        let application = store.source?.application
        let version = application?.version ?? L10n.text("Unknown")
        if let build = application?.build, !build.isEmpty {
            return "\(version) (\(build))"
        }
        return version
    }

    private var environmentVersion: String {
        store.source?.environment?.suiteVersion ?? store.suite?.suiteVersion ?? L10n.text("not installed")
    }

    private var catalogSourceLabel: String {
        if store.source?.source?.unpublished == true {
            return L10n.text(ManagerSourcePolicy.unpublishedNote)
        }
        return store.source?.source?.url ?? store.source?.source?.path ?? L10n.text(ManagerSourcePolicy.unpublishedNote)
    }
}
