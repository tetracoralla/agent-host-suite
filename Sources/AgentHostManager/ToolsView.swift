import SwiftUI

struct ToolsView: View {
    @ObservedObject var store: AgentHostStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Tools", subtitle: "Available in connected Agent apps") {
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
                .accessibilityLabel(L10n.format("Make {tool} available in Agent apps", ["tool": tool.name]))
            }
        }
        .padding(.vertical, 3)
    }
}
