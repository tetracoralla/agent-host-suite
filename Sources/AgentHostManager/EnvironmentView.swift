import SwiftUI

struct EnvironmentView: View {
    @ObservedObject var store: AgentHostStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Agent environment", subtitle: L10n.format("{toolSet} on this Mac", ["toolSet": toolSetName])) {
                    HealthPill(health: store.health)
                }

                if case let .attention(message) = store.health {
                    Panel {
                        NoticeView(
                            title: message,
                            message: firstFailure ?? "Run a full check to identify the affected tool or Agent app.",
                            systemImage: "exclamationmark.triangle.fill",
                            color: .orange
                        )
                        HStack {
                            Button(L10n.text("Review Repair")) { Task { await store.prepareUpdate() } }
                                .buttonStyle(.borderedProminent)
                            Button(L10n.text("Run Full Check")) { Task { await store.runDoctor() } }
                        }
                    }
                } else if store.health == .ready {
                    Panel {
                        NoticeView(
                            title: store.agentAppsVerified ? "Your environment is ready" : "Your local environment is ready",
                            message: store.agentAppsVerified
                                ? "Open a fresh task in a connected Agent app to use the installed tools."
                                : "Connected Agent apps are configured. Run Full Check when you want to verify their current bindings.",
                            systemImage: "checkmark.circle.fill",
                            color: .green
                        )
                    }
                }

                Panel {
                    Text(L10n.text("Health")).font(.headline)
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

    private var firstFailure: String? {
        if let message = store.doctor?.checks.first(where: { $0.status == "error" })?.message { return message }
        return store.healthFacets.first { !$0.isHealthy }?.detail
    }

    private var toolSetName: String {
        switch store.suite?.profile {
        case "local-dogfood": L10n.text("Standard + Local tools")
        case "observability": L10n.text("Standard + Monitoring")
        default: L10n.text("Standard")
        }
    }
}
