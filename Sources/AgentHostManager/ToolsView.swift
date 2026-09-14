import SwiftUI

struct ToolsView: View {
    @ObservedObject var store: AgentHostStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Tools", subtitle: "Get catalog inventory, then enable a working set for new Agent tasks") {
                    Button(L10n.text("Check All")) { Task { await store.runDoctor() } }
                        .disabled(store.isBusy)
                }

                if store.toolSetNeedsFreshTask {
                    NoticeView(
                        title: "Start a fresh Agent task",
                        message: "New tasks load this tool selection. Tasks already open keep the tools they started with.",
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
                    Text(L10n.text("Featured catalog")).font(.headline)
                    Text(L10n.text("Owner-selected tools, including Armorial. Not a marketplace, store, ranking, or payment catalog."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(L10n.text(ManagerSetupPolicy.workingSetNote))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ForEach(Array(store.featuredCatalogTools.enumerated()), id: \.element.id) { index, tool in
                        if index > 0 { Divider() }
                        FeaturedCatalogRow(
                            tool: tool,
                            installed: store.isFeaturedToolInstalled(tool.id)
                        )
                    }
                    if store.needsFeaturedInventory {
                        Button(L10n.text("Get featured tools")) {
                            Task { await store.prepareFeaturedAcquire() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(store.isBusy)
                        Text(L10n.text("Get runs update --profile featured against the same bound catalog as CLI setup. It installs inventory; switches below only change the working set."))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let url = store.featuredCatalogDownloadURL {
                        Text(L10n.text("Featured catalog download"))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(url)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                        Text(L10n.text(ManagerSetupPolicy.unsignedMacOSGatekeeperNote))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Panel {
                    Text(L10n.text("Working set for new tasks")).font(.headline)
                    ForEach(Array(store.managedTools.enumerated()), id: \.element.id) { index, tool in
                        ToolRow(
                            tool: tool,
                            isBusy: store.isBusy,
                            canDeactivate: store.managedTools.filter(\.active).count > 1,
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
            Text(L10n.text(installed ? "Installed" : "Not installed in this environment"))
                .font(.caption)
                .foregroundStyle(installed ? .secondary : .orange)
        }
        .padding(.vertical, 3)
    }
}

private struct ToolRow: View {
    let tool: ManagedTool
    let isBusy: Bool
    let canDeactivate: Bool
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
                Text(L10n.text(tool.availability)).font(.caption).foregroundStyle(.secondary)
                Text(L10n.text(tool.ownership)).font(.caption).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 20)
            VStack(alignment: .trailing, spacing: 8) {
                ItemStatePill(state: tool.state)
                Toggle(L10n.text("Available"), isOn: Binding(
                    get: { tool.active },
                    set: onChange
                ))
                .toggleStyle(.switch)
                .labelsHidden()
                .disabled(isBusy || (tool.active && !canDeactivate))
                .accessibilityLabel(L10n.format("Include {tool} in new Agent tasks", ["tool": tool.name]))
            }
        }
        .padding(.vertical, 3)
    }
}
