import SwiftUI

struct SetupView: View {
    @ObservedObject var store: AgentHostStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Set up", subtitle: nil) {
                    HealthPill(health: store.health)
                }

                Panel {
                    Text(L10n.text("Tool set")).font(.headline)
                    ForEach(Array(ManagerSetupPolicy.profiles.enumerated()), id: \.element) { index, profile in
                        if index > 0 { Divider() }
                        ProfileChoiceRow(
                            id: profile,
                            name: ManagerSetupPolicy.displayName(for: profile),
                            selected: store.selectedSetupProfile == profile,
                            select: { store.selectedSetupProfile = profile }
                        )
                    }
                }

                Panel {
                    Label(L10n.text(store.selectedSetupProfileName), systemImage: "shippingbox.fill")
                        .font(.headline)
                    ForEach(Array(ManagerSetupPolicy.tools(for: store.selectedSetupProfile).enumerated()), id: \.element.id) { index, tool in
                        if index > 0 { Divider() }
                        SetupItem(name: tool.name, detail: tool.summary, image: tool.systemImage)
                    }
                }

                Panel {
                    Label(L10n.text("Local service"), systemImage: "bolt.fill")
                        .font(.headline)
                    SetupItem(name: "Local execution", detail: "Keeps installed tools ready on this Mac", image: "bolt.fill")
                }

                Panel {
                    HStack {
                        Text(L10n.text("Agent app")).font(.headline)
                        Spacer()
                        Button(L10n.text("Check again")) {
                            Task { await store.redetectAgentApps() }
                        }
                        .disabled(store.isBusy)
                    }
                    if !store.hasDetectedSetupHost {
                        NoticeView(
                            title: "No supported Agent app was found",
                            message: "Install now; connect an Agent later.",
                            systemImage: "info.circle.fill",
                            color: .blue
                        )
                    }
                    ForEach(Array(ManagerAgentApp.all.enumerated()), id: \.element.id) { index, app in
                        if index > 0 { Divider() }
                        AgentAppChoiceRow(
                            app: app,
                            installed: store.hostStatuses[app.id]?.appInstalled == true,
                            selected: store.selectedSetupHost == app.id,
                            select: { store.selectedSetupHost = app.id }
                        )
                    }
                }


                HStack {
                    Button(L10n.text("Review Setup")) {
                        Task { await store.prepareSetup() }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(store.isBusy)

                    Text(L10n.text(store.connectsAgentDuringSetup
                        ? "Local monitoring stays off until you turn it on."
                        : "Install without an Agent for now."))
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

private struct ProfileChoiceRow: View {
    let id: String
    let name: String
    let selected: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            HStack(spacing: 12) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? .blue : .secondary)
                    .frame(width: 24)
                Text(L10n.text(name)).foregroundStyle(.primary)
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L10n.format("Use {toolSet} for setup", ["toolSet": L10n.text(name)]))
        .accessibilityValue(L10n.text(selected ? "Selected" : "Available"))
        .accessibilityIdentifier(id)
    }
}

private struct AgentAppChoiceRow: View {
    let app: ManagerAgentApp
    let installed: Bool
    let selected: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            HStack(spacing: 12) {
                Image(systemName: app.systemImage)
                    .foregroundStyle(installed ? .blue : .secondary)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(app.name).foregroundStyle(.primary)
                    Text(L10n.text(installed ? "Detected on this Mac" : "Not installed · connect after setup"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? .blue : .secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L10n.format("Use {app} for setup", ["app": app.name]))
        .accessibilityValue(L10n.text(selected ? "Selected" : installed ? "Available" : "Not installed"))
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
                Text(L10n.text(name))
                Text(L10n.text(detail)).font(.caption).foregroundStyle(.secondary)
            }
        }
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
