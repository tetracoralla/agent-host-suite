import SwiftUI

struct SetupPlanView: View {
    let plan: SetupPlan
    @ObservedObject var store: AgentHostStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 5) {
                Text(L10n.text("Install Agent Environment"))
                    .font(.title2.weight(.semibold))
                Text(planSummary)
                    .foregroundStyle(.secondary)
            }

            Panel {
                ForEach(Array(ManagerSetupPolicy.tools(for: plan.profile).enumerated()), id: \.element.id) { index, tool in
                    if index > 0 { Divider() }
                    PlanRow(name: tool.name, version: plan.components[tool.id]?.version)
                }
                if plan.components["direct-execution-runtime"] != nil {
                    Divider()
                    PlanRow(name: "Local service", version: plan.components["direct-execution-runtime"]?.version)
                }
            }

            Panel {
                LabeledContent(L10n.text("Tool set"), value: L10n.text(plan.profileDisplayName ?? store.selectedSetupProfileName))
                if store.connectsAgentDuringSetup {
                    LabeledContent(L10n.format("{app} entries", ["app": store.selectedSetupHostName]), value: (plan.hosts?[store.selectedSetupHost]?.entries?.count ?? 0).formatted())
                } else {
                    LabeledContent(L10n.text("Agent app"), value: L10n.text("Connect later"))
                }
                LabeledContent(L10n.text("Background service"), value: L10n.text(plan.service?.supported == true ? "Will be installed" : "Unavailable"))
            }

            if store.connectsAgentDuringSetup {
                NoticeView(
                    title: L10n.format("A new {app} task will be required", ["app": store.selectedSetupHostName]),
                    message: L10n.format("Open a fresh task after setup so {app} can load the installed tools.", ["app": store.selectedSetupHostName]),
                    systemImage: "arrow.clockwise.circle.fill",
                    color: .blue
                )
            } else {
                NoticeView(
                    title: L10n.text("Connect an Agent app when it is installed"),
                    message: L10n.text("Connect an Agent afterward, then start a new task."),
                    systemImage: "arrow.clockwise.circle.fill",
                    color: .blue
                )
            }

            HStack {
                Button(L10n.text("Cancel"), role: .cancel) { dismiss() }
                Spacer()
                Button(L10n.text("Install")) { Task { await store.installSelectedProfile() } }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 520)
        .accessibilityElement(children: .contain)
    }

    private var planSummary: String {
        if store.connectsAgentDuringSetup {
            return L10n.format(
                "Agent Host will install the {toolSet}, connect them to {app}, and start local execution.",
                ["toolSet": L10n.text(plan.profileDisplayName ?? store.selectedSetupProfileName), "app": store.selectedSetupHostName]
            )
        }
        return L10n.format(
            "Agent Host will install the {toolSet} and start local execution. No Agent app will be connected yet.",
            ["toolSet": L10n.text(plan.profileDisplayName ?? store.selectedSetupProfileName)]
        )
    }
}

private struct PlanRow: View {
    let name: String
    let version: String?

    var body: some View {
        HStack {
            Text(L10n.text(name))
            Spacer()
            Text(version ?? L10n.text("Unavailable"))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }
}
