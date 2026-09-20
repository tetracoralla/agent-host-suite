import SwiftUI

struct EnvironmentView: View {
    @ObservedObject var store: AgentHostStore
    @State private var showDetails = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Overview", subtitle: nil) {
                    HealthPill(health: store.health)
                }

                postSetupHandoff

                if store.suite?.configured == true {
                    DisclosureGroup(isExpanded: $showDetails) {
                        VStack(alignment: .leading, spacing: 12) {
                            if case let .attention(message) = store.health, !store.postSetupGuidance.readyToWork {
                                NoticeView(
                                    title: message,
                                    message: firstFailure ?? L10n.text("Run a full check to identify the affected tool or Agent app."),
                                    systemImage: "exclamationmark.triangle.fill",
                                    color: .orange
                                )
                            }

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
                            }

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

                            HStack {
                                Button(L10n.text("Check")) { Task { await store.runDoctor() } }
                                    .disabled(store.isBusy)
                                Button(L10n.text("Update")) { Task { await store.prepareUpdate() } }
                                    .disabled(store.isBusy)
                            }
                        }
                        .padding(.top, 8)
                    } label: {
                        Text(L10n.text("Details"))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
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
            HStack(alignment: .center, spacing: 16) {
                HStack(spacing: 10) {
                    Image(systemName: statusSymbol(guidance.statusTone))
                        .font(.title2)
                        .foregroundStyle(statusColor(guidance.statusTone))
                    Text(L10n.text(guidance.statusLine))
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(statusColor(guidance.statusTone))
                }
                Spacer(minLength: 8)
                Button(L10n.text(guidance.primaryActionLabel)) {
                    store.performPostSetupPrimaryAction()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(store.isBusy)
                .accessibilityIdentifier("post-setup-primary-cta")
            }

            if let hint = guidance.hint, guidance.primaryActionID == .openApp || guidance.primaryActionID == .startNewAgentTask {
                Text(L10n.text(hint))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            DisclosureGroup {
                VStack(alignment: .leading, spacing: 6) {
                    if let problemClass = guidance.problemClass {
                        Text(L10n.text(problemClass.rawValue))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let code = guidance.blockingCode, !code.isEmpty {
                        Text(code + (guidance.blockingMessage.map { " · \($0)" } ?? ""))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(guidance.observed, id: \.self) { line in
                        Text("• \(L10n.text(line))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(guidance.gaps, id: \.self) { line in
                        Text("• \(L10n.text(line))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if !guidance.recoveryPath.isEmpty {
                        Text(L10n.text(guidance.recoveryPath))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.top, 4)
            } label: {
                Text(L10n.text("Details"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("post-setup-handoff")
    }

    private func statusSymbol(_ tone: ManagerPostSetupGuidance.StatusTone) -> String {
        switch tone {
        case .ready: return "arrow.forward.circle.fill"
        case .paused: return "pause.circle.fill"
        case .fault: return "exclamationmark.triangle.fill"
        case .action: return "link.circle.fill"
        }
    }

    private func statusColor(_ tone: ManagerPostSetupGuidance.StatusTone) -> Color {
        switch tone {
        case .ready: return .blue
        case .paused: return .orange
        case .fault: return .red
        case .action: return .primary
        }
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
