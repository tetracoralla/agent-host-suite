import SwiftUI

struct EnvironmentChangePlanView: View {
    let plan: EnvironmentChangePlan
    @ObservedObject var store: AgentHostStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 5) {
                Text(L10n.text(title))
                    .font(.title2.weight(.semibold))
                Text(L10n.text(summary))
                    .foregroundStyle(.secondary)
            }

            Panel {
                switch plan {
                case let .update(update, _, replaceHostConflicts):
                    LabeledContent(L10n.text("Tool set"), value: L10n.text(update.profileDisplayName ?? update.profile))
                    LabeledContent(L10n.text("Source"), value: sourceLabel(update.source))
                    LabeledContent(L10n.text("Current version"), value: update.fromVersion)
                    LabeledContent(L10n.text("Target version"), value: update.toVersion)
                    LabeledContent(L10n.text("Components changing"), value: update.componentChanges.count.formatted())
                    LabeledContent(L10n.text("Agent apps checked"), value: update.activation.hosts.count.formatted())
                    LabeledContent(L10n.text("Background service"), value: L10n.text(update.activation.service?.supported == false ? "Unavailable" : "Checked"))
                    if replaceHostConflicts {
                        Divider()
                        Label(L10n.text("Conflicting copies with the same verified identity will be replaced. Agent Host records what it displaced so uninstall can restore it."), systemImage: "arrow.triangle.swap")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                case let .repair(repair, replaceHostConflicts):
                    LabeledContent(L10n.text("Current version"), value: repair.suiteVersion)
                    LabeledContent(L10n.text("Tool versions"), value: L10n.text("Unchanged"))
                    LabeledContent(L10n.text("Agent apps"), value: repairHostSummary(repair))
                    LabeledContent(L10n.text("Background service"), value: L10n.text(repair.repairs.service ? "Restore current service" : "Not installed"))
                    LabeledContent(L10n.text("Monitoring"), value: L10n.text(repair.repairs.monitoring ? "Rebind current monitoring" : "Off"))
                    if replaceHostConflicts {
                        Divider()
                        Label(L10n.text("Conflicting copies with the same verified identity will be replaced. Agent Host records what it displaced so uninstall can restore it."), systemImage: "arrow.triangle.swap")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                case let .rollback(rollback):
                    LabeledContent(L10n.text("Restore version"), value: rollback.targetVersion)
                    LabeledContent(L10n.text("Agent apps"), value: L10n.text("Reconnect to retained package"))
                    LabeledContent(L10n.text("Background service"), value: L10n.text("Restore retained configuration"))
                }
            }

            if case let .update(update, _, _) = plan, !update.componentChanges.isEmpty {
                Panel {
                    Text(L10n.text("Version changes")).font(.headline)
                    ForEach(update.componentChanges) { change in
                        Label(versionChangeLabel(change), systemImage: versionChangeSymbol(change.action))
                    }
                }
            }

            if case let .update(update, _, _) = plan, !update.enabledAgentComponents.isEmpty || !update.removedAgentComponents.isEmpty {
                Panel {
                    Text(L10n.text("Working set")).font(.headline)
                    if !update.enabledAgentComponents.isEmpty {
                        LabeledContent(L10n.text("Enabled tools"), value: update.enabledAgentComponents.map { displayName($0) }.joined(separator: ", "))
                    }
                    if !update.removedAgentComponents.isEmpty {
                        LabeledContent(L10n.text("Removed tools"), value: update.removedAgentComponents.map { displayName($0) }.joined(separator: ", "))
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
                Button(L10n.text("Cancel"), role: .cancel) { dismiss() }
                Spacer()
                Button(L10n.text(actionTitle)) { Task { await store.applyEnvironmentChange() } }
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
        case let .update(update, _, _):
            update.componentChanges.isEmpty && update.changed.isEmpty ? "Confirm Environment Check" : "Confirm Environment Update"
        case .repair: "Confirm Environment Repair"
        case .rollback: "Confirm Restore"
        }
    }

    private var summary: String {
        switch plan {
        case let .update(update, _, _):
            update.componentChanges.isEmpty && update.changed.isEmpty
                ? "The compatibility set is already current. Confirm to refresh its Agent app connections and local service."
                : "Agent Host will activate one complete compatibility set. The retained current set remains available for restore."
        case .repair:
            "Agent Host will restore Agent app connections, local service, and monitoring using the currently installed tool versions. Tool versions will not change."
        case .rollback:
            "Agent Host will activate the most recently retained complete set."
        }
    }

    private var actionTitle: String {
        switch plan {
        case let .update(update, _, _):
            update.componentChanges.isEmpty && update.changed.isEmpty ? "Refresh Connections" : "Update"
        case .repair: "Repair"
        case .rollback: "Restore"
        }
    }

    private func sourceLabel(_ source: UpdateSource) -> String {
        switch source.kind {
        case "bundled-catalog": L10n.text("Bundled catalog")
        case "remote-catalog": source.url ?? L10n.text("Remote catalog")
        case "release-manifest": L10n.text("Release manifest")
        case "development": L10n.text("Development source")
        default: source.kind
        }
    }

    private func repairHostSummary(_ repair: RepairPlan) -> String {
        if repair.repairs.hosts.isEmpty { return L10n.text("None connected") }
        return repair.repairs.hosts.map { ManagerAgentApp.named($0).name }.joined(separator: ", ")
    }

    private func versionChangeLabel(_ change: ComponentVersionChange) -> String {
        let name = displayName(change.id)
        let from = change.currentVersion ?? L10n.text("not installed")
        let to = change.targetVersion ?? L10n.text("removed")
        return "\(name): \(from) → \(to)"
    }

    private func versionChangeSymbol(_ action: String) -> String {
        switch action {
        case "install": "plus.circle"
        case "remove": "minus.circle"
        case "downgrade": "arrow.down.circle"
        case "upgrade": "arrow.up.circle"
        default: "arrow.triangle.2.circlepath"
        }
    }

    private func displayName(_ id: String) -> String {
        switch id {
        case "direct-execution-runtime": L10n.text("Local execution")
        case "math-anchor": "Math Anchor"
        case "migratory-time": "Migratory Time"
        case "data-transformer": "BatchTicket"
        case "context-surface-analyzer": L10n.text("Catalog measurement")
        case "agent-tool-observer": L10n.text("Local monitoring")
        case "file-vitals": "File Vitals"
        case "agent-catalog": L10n.text("Agent tool availability")
        case "workspace-grant": L10n.text("Workspace access")
        case "armorial": "Armorial"
        case "laniakea": "Laniakea"
        default: id.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
        }
    }
}
