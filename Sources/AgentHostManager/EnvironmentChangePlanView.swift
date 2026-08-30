import SwiftUI

struct EnvironmentChangePlanView: View {
    let plan: EnvironmentChangePlan
    @ObservedObject var store: AgentHostStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 5) {
                Text(title)
                    .font(.title2.weight(.semibold))
                Text(summary)
                    .foregroundStyle(.secondary)
            }

            Panel {
                switch plan {
                case let .update(update, _, replaceHostConflicts):
                    LabeledContent("Tool set", value: update.profileDisplayName ?? update.profile)
                    LabeledContent("Components changing", value: update.changed.count.formatted())
                    LabeledContent("Agent apps checked", value: update.activation.hosts.count.formatted())
                    LabeledContent("Background service", value: update.activation.service?.supported == false ? "Unavailable" : "Checked")
                    if replaceHostConflicts {
                        Divider()
                        Label("Conflicting copies with the same verified identity will be replaced. Agent Host records what it displaced so uninstall can restore it.", systemImage: "arrow.triangle.swap")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                case let .rollback(rollback):
                    LabeledContent("Restore version", value: rollback.targetVersion)
                    LabeledContent("Agent apps", value: "Reconnect to retained package")
                    LabeledContent("Background service", value: "Restore retained configuration")
                }
            }

            if case let .update(update, _, _) = plan, !update.changed.isEmpty {
                Panel {
                    Text("Changes").font(.headline)
                    ForEach(update.changed, id: \.self) { id in
                        Label(displayName(id), systemImage: "arrow.down.circle")
                    }
                }
            }

            NoticeView(
                title: "A new Agent task will be required",
                message: "The current task keeps its loaded catalog. Open a fresh task after this change.",
                systemImage: "arrow.clockwise.circle.fill",
                color: .blue
            )

            HStack {
                Button("Cancel", role: .cancel) { dismiss() }
                Spacer()
                Button(actionTitle) { Task { await store.applyEnvironmentChange() } }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 560)
        .accessibilityElement(children: .contain)
    }

    private var title: String {
        switch plan {
        case let .update(update, _, _): update.changed.isEmpty ? "Confirm Environment Check" : "Confirm Environment Update"
        case .rollback: "Confirm Restore"
        }
    }

    private var summary: String {
        switch plan {
        case let .update(update, _, _):
            update.changed.isEmpty
                ? "The compatibility set is already current. Confirm to refresh its Agent app connections and local service."
                : "Agent Host will activate one complete compatibility set. The retained current set remains available for restore."
        case .rollback:
            "Agent Host will activate the most recently retained complete set."
        }
    }

    private var actionTitle: String {
        switch plan {
        case let .update(update, _, _): update.changed.isEmpty ? "Refresh Connections" : "Update"
        case .rollback: "Restore"
        }
    }

    private func displayName(_ id: String) -> String {
        switch id {
        case "direct-execution-runtime": "Local execution"
        case "math-anchor": "Math Anchor"
        case "migratory-time": "Migratory Time"
        case "data-transformer": "BatchTicket"
        case "context-surface-analyzer": "Catalog measurement"
        case "file-vitals": "File Vitals"
        case "agent-catalog": "Agent tool availability"
        case "workspace-grant": "Workspace access"
        default: id.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
        }
    }
}
