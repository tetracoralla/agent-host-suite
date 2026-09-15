import SwiftUI

struct ToolsView: View {
    @ObservedObject var store: AgentHostStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Tools", subtitle: nil) {
                    Button(L10n.text("Check All")) { Task { await store.runDoctor() } }
                        .disabled(store.isBusy)
                }

                if store.toolSetNeedsFreshTask {
                    NoticeView(
                        title: "Start a fresh Agent task",
                        message: "Open tasks keep their old tools.",
                        systemImage: "arrow.clockwise.circle",
                        color: .blue
                    )
                }

                if let catalog = store.catalogBudgetSummary {
                    Panel {
                        LabeledContent(L10n.text("Context cost"), value: catalog)
                            .accessibilityLabel("\(L10n.text("Context cost")): \(catalog)")
                    }
                }

                Panel {
                    HStack {
                        Text(L10n.text("Featured")).font(.headline)
                        Spacer()
                        if store.needsFeaturedInventory {
                            Button(L10n.text("Get")) {
                                Task { await store.prepareFeaturedAcquire() }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(store.isBusy)
                        }
                    }
                    ForEach(Array(store.featuredCatalogTools.enumerated()), id: \.element.id) { index, tool in
                        if index > 0 { Divider() }
                        FeaturedCatalogRow(
                            tool: tool,
                            installed: store.isFeaturedToolInstalled(tool.id)
                        )
                    }
                }

                Panel {
                    HStack {
                        Text(L10n.text("For new tasks")).font(.headline)
                        Spacer()
                        if store.suite?.agentToolsPaused == true {
                            Button(L10n.text("Resume")) { Task { await store.resumeTools() } }
                                .disabled(store.isBusy)
                        } else if !store.managedTools.isEmpty {
                            Button(L10n.text("Pause all")) { Task { await store.pauseAllTools() } }
                                .disabled(store.isBusy)
                        }
                    }
                    if store.suite?.agentToolsPaused == true {
                        Text(L10n.text("Fully paused: no MCP and no on-demand Skill."))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text(L10n.text("Off keeps an on-demand Skill. Pause all withholds both."))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(Array(store.managedTools.enumerated()), id: \.element.id) { index, tool in
                        ToolRow(
                            tool: tool,
                            isBusy: store.isBusy,
                            paused: store.suite?.agentToolsPaused == true,
                            onChange: { value in Task { await store.setTool(tool.id, active: value) } }
                        )
                        if index < store.managedTools.count - 1 { Divider() }
                    }
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(32)
        }
    }
}

private struct FeaturedCatalogRow: View {
    let tool: ManagerSetupTool
    let installed: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: tool.systemImage)
                .font(.title3)
                .foregroundStyle(.blue)
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 5) {
                Text(L10n.text(tool.name)).font(.headline)
                Text(L10n.text(tool.summary)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 20)
            Text(L10n.text(installed ? "Installed" : "Missing"))
                .font(.caption)
                .foregroundStyle(installed ? Color.secondary : Color.orange)
        }
        .padding(.vertical, 3)
    }
}

private struct ToolRow: View {
    let tool: ManagedTool
    let isBusy: Bool
    let paused: Bool
    let onChange: @Sendable (Bool) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: tool.systemImage)
                .font(.title3)
                .foregroundStyle(.blue)
                .frame(width: 28, height: 28)

            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(tool.name).font(.headline)
                    if let version = tool.version {
                        Text(version.split(separator: "+", maxSplits: 1).first.map(String.init) ?? version)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                }
                Text(L10n.text(tool.summary)).foregroundStyle(.secondary)
                if paused {
                    Text(L10n.text("Fully paused: no MCP and no on-demand Skill."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if !tool.active {
                    Text(L10n.text("On-demand Skill only"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 20)
            VStack(alignment: .trailing, spacing: 8) {
                ItemStatePill(state: tool.state)
                Toggle(L10n.text("Available"), isOn: Binding(
                    get: { !paused && tool.active },
                    set: onChange
                ))
                .toggleStyle(.switch)
                .labelsHidden()
                .disabled(isBusy)
                .accessibilityLabel(L10n.format("Include {tool} in new Agent tasks", ["tool": tool.name]))
            }
        }
        .padding(.vertical, 3)
    }
}
