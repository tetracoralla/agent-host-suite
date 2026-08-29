import SwiftUI

struct SetupView: View {
    @ObservedObject var store: AgentHostStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Set up your Agent environment", subtitle: "Install one verified local environment for Codex.") {
                    HealthPill(health: store.health)
                }

                Panel {
                    Label("Standard tools", systemImage: "shippingbox.fill")
                        .font(.headline)
                    SetupItem(name: "Math Anchor", detail: "Exact and scientific calculation", image: "function")
                    Divider()
                    SetupItem(name: "Migratory Time", detail: "Reliable worldwide time conversion", image: "globe.americas")
                }

                Panel {
                    Label("Local service", systemImage: "bolt.fill")
                        .font(.headline)
                    SetupItem(name: "Local execution", detail: "Keeps installed tools ready on this Mac", image: "bolt.fill")
                }

                Panel {
                    Text("Agent app").font(.headline)
                    HStack(spacing: 12) {
                        Image(systemName: "bubble.left.and.bubble.right.fill")
                            .foregroundStyle(.blue)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Codex")
                            Text(store.hostStatuses["codex"]?.appInstalled == true ? "Detected on this Mac" : "Codex must be installed first")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: store.hostStatuses["codex"]?.appInstalled == true ? "checkmark.circle.fill" : "exclamationmark.circle")
                            .foregroundStyle(store.hostStatuses["codex"]?.appInstalled == true ? .green : .orange)
                    }
                }

                HStack {
                    Button("Review Setup") {
                        Task { await store.prepareSetup() }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(store.isBusy || store.hostStatuses["codex"]?.appInstalled != true)

                    Text("Local monitoring stays off until you turn it on.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: 720, alignment: .leading)
            .padding(32)
        }
    }
}

struct SetupPlanView: View {
    let plan: SetupPlan
    @ObservedObject var store: AgentHostStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 5) {
                Text("Install Agent Environment")
                    .font(.title2.weight(.semibold))
                Text("Agent Host will install the Standard tools, connect them to Codex, and start local execution.")
                    .foregroundStyle(.secondary)
            }

            Panel {
                PlanRow(name: "Math Anchor", version: plan.components["math-anchor"]?.version)
                Divider()
                PlanRow(name: "Migratory Time", version: plan.components["migratory-time"]?.version)
                Divider()
                PlanRow(name: "Local service", version: plan.components["direct-execution-runtime"]?.version)
            }

            Panel {
                LabeledContent("Tool set", value: plan.profileDisplayName ?? "Standard")
                LabeledContent("Codex entries", value: (plan.hosts?["codex"]?.entries?.count ?? 0).formatted())
                LabeledContent("Background service", value: plan.service?.supported == true ? "Will be installed" : "Unavailable")
            }

            NoticeView(
                title: "A new Codex task will be required",
                message: "Open a fresh task after setup so Codex can load the installed tools.",
                systemImage: "arrow.clockwise.circle.fill",
                color: .blue
            )

            HStack {
                Button("Cancel", role: .cancel) { dismiss() }
                Spacer()
                Button("Install") { Task { await store.installStandard() } }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 520)
        .accessibilityElement(children: .contain)
    }
}

private struct SetupItem: View {
    let name: String
    let detail: String
    let image: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: image)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

private struct PlanRow: View {
    let name: String
    let version: String?

    var body: some View {
        HStack {
            Text(name)
            Spacer()
            Text(version ?? "Unavailable")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }
}
