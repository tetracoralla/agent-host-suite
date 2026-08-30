import SwiftUI

struct EnvironmentView: View {
    @ObservedObject var store: AgentHostStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Agent environment", subtitle: "\(toolSetName) on this Mac") {
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
                            Button("Review Repair") { Task { await store.prepareUpdate() } }
                                .buttonStyle(.borderedProminent)
                            Button("Run Full Check") { Task { await store.runDoctor() } }
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
                    Text("Health").font(.headline)
                    ForEach(store.healthFacets) { facet in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: facet.isHealthy ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                                .foregroundStyle(facet.isHealthy ? .green : .orange)
                                .frame(width: 18)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(facet.name)
                                Text(facet.detail)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(facet.name): \(facet.detail)")
                    }
                }

                Panel {
                    Text("Current environment").font(.headline)
                    LabeledContent("Tool set", value: toolSetName)
                    LabeledContent("Tools", value: store.managedTools.count.formatted())
                    LabeledContent("Agent apps", value: store.connectedAgentAppCount.formatted())
                    LabeledContent("Local execution", value: store.localExecutionStatus)
                    LabeledContent("Monitoring", value: store.monitoringSummary)
                    if store.isRefreshing {
                        LabeledContent("Status checked", value: "Refreshing…")
                    } else if let refreshedAt = store.lastSuccessfulRefreshAt {
                        LabeledContent("Status checked") {
                            Text(refreshedAt, format: .relative(presentation: .named))
                        }
                    }
                    if let storage = store.storageSummary {
                        LabeledContent("Storage · live processes", value: storage)
                    }
                    if let catalog = store.catalogBudgetSummary {
                        LabeledContent("Tool catalog", value: catalog)
                    }
                }

                HStack {
                    Button("Run Full Check") { Task { await store.runDoctor() } }
                        .disabled(store.isBusy)
                    Button("Review Update") { Task { await store.prepareUpdate() } }
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
        case "local-dogfood": "Standard + Local tools"
        case "observability": "Standard + monitoring"
        default: "Standard"
        }
    }
}
