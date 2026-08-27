import SwiftUI

struct EnvironmentView: View {
    @ObservedObject var store: AgentHostStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Agent environment", subtitle: "Standard tools on this Mac") {
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
                            title: "Your environment is ready",
                            message: "Open a fresh Codex task to use the installed tools.",
                            systemImage: "checkmark.circle.fill",
                            color: .green
                        )
                    }
                }

                Panel {
                    Text("Current environment").font(.headline)
                    LabeledContent("Tool set", value: toolSetName)
                    LabeledContent("Tools", value: store.managedTools.count.formatted())
                    LabeledContent("Agent apps", value: store.connectedAgentAppCount.formatted())
                    LabeledContent("Local execution", value: store.localExecutionStatus)
                    LabeledContent("Monitoring", value: store.observations?.enabled == true ? "On" : "Off")
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
        store.doctor?.checks.first { $0.status == "error" }?.message
    }

    private var toolSetName: String {
        switch store.suite?.profile {
        case "local-dogfood": "Standard + Local tools"
        case "observability": "Standard + monitoring"
        default: "Standard"
        }
    }
}
