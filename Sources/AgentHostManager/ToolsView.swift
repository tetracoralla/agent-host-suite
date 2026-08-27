import SwiftUI

struct ToolsView: View {
    @ObservedObject var store: AgentHostStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Tools", subtitle: "Available in connected Agent apps") {
                    Button("Check All") { Task { await store.runDoctor() } }
                        .disabled(store.isBusy)
                }

                Panel {
                    ForEach(Array(store.managedTools.enumerated()), id: \.element.id) { index, tool in
                        ToolRow(tool: tool)
                        if index < store.managedTools.count - 1 { Divider() }
                    }
                }

                Text("Agent Host keeps this tool set on compatible versions and preserves each tool's identity in Codex.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(32)
        }
    }
}

private struct ToolRow: View {
    let tool: ManagedTool

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
                Text(tool.summary).foregroundStyle(.secondary)
                Text(tool.availability).font(.caption).foregroundStyle(.secondary)
                Text(tool.ownership).font(.caption).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 20)
            ItemStatePill(state: tool.state)
        }
        .padding(.vertical, 3)
    }
}
