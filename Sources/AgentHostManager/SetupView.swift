import SwiftUI

struct SetupView: View {
    @ObservedObject var store: AgentHostStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Set up your Agent environment", subtitle: "Install one verified local environment for your Agent app.") {
                    HealthPill(health: store.health)
                }

                Panel {
                    Label(L10n.text("Standard tools"), systemImage: "shippingbox.fill")
                        .font(.headline)
                    SetupItem(name: "Math Anchor", detail: "Exact and scientific calculation", image: "function")
                    Divider()
                    SetupItem(name: "Migratory Time", detail: "Reliable worldwide time conversion", image: "globe.americas")
                }

                Panel {
                    Label(L10n.text("Local service"), systemImage: "bolt.fill")
                        .font(.headline)
                    SetupItem(name: "Local execution", detail: "Keeps installed tools ready on this Mac", image: "bolt.fill")
                }

                Panel {
                    Text(L10n.text("Agent app")).font(.headline)
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
                    .disabled(store.isBusy || store.hostStatuses[store.selectedSetupHost]?.appInstalled != true)

                    Text(L10n.text("Local monitoring stays off until you turn it on."))
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
                Text(L10n.format("Agent Host will install the Standard tools, connect them to {app}, and start local execution.", ["app": store.selectedSetupHostName]))
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
                LabeledContent(L10n.text("Tool set"), value: L10n.text(plan.profileDisplayName ?? "Standard"))
                LabeledContent(L10n.format("{app} entries", ["app": store.selectedSetupHostName]), value: (plan.hosts?[store.selectedSetupHost]?.entries?.count ?? 0).formatted())
                LabeledContent(L10n.text("Background service"), value: L10n.text(plan.service?.supported == true ? "Will be installed" : "Unavailable"))
            }

            NoticeView(
                title: L10n.format("A new {app} task will be required", ["app": store.selectedSetupHostName]),
                message: L10n.format("Open a fresh task after setup so {app} can load the installed tools.", ["app": store.selectedSetupHostName]),
                systemImage: "arrow.clockwise.circle.fill",
                color: .blue
            )

            HStack {
                Button(L10n.text("Cancel"), role: .cancel) { dismiss() }
                Spacer()
                Button(L10n.text("Install")) { Task { await store.installStandard() } }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 520)
        .accessibilityElement(children: .contain)
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
                    Text(L10n.text(installed ? "Detected on this Mac" : "Not installed"))
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
        .disabled(!installed)
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
