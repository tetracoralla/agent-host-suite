import SwiftUI

struct ActivityView: View {
    @ObservedObject var store: AgentHostStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Activity", subtitle: "Changes made to this environment") {
                    EmptyView()
                }

                if store.activity.isEmpty {
                    ContentUnavailableView(L10n.text("No activity yet"), systemImage: "clock", description: Text(L10n.text("Install, update, repair, and connection changes appear here.")))
                        .frame(maxWidth: .infinity, minHeight: 300)
                } else {
                    Panel {
                        ForEach(Array(store.activity.enumerated()), id: \.element.id) { index, entry in
                            ActivityRow(
                                entry: entry,
                                componentNames: Dictionary(uniqueKeysWithValues: (store.suite?.components ?? [:]).map {
                                    ($0.key, $0.value.displayName ?? $0.key)
                                })
                            )
                            if index < store.activity.count - 1 { Divider() }
                        }
                    }
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(32)
        }
    }
}

private struct ActivityRow: View {
    let entry: ActivityEntry
    let componentNames: [String: String]

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.localizedSummary)
                if let date = entry.date {
                    Text(L10n.relativeAge(since: date))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                ForEach(Array(entry.humanDetail(componentNames: componentNames).enumerated()), id: \.offset) { _, item in
                    Text("\(L10n.text(item.label)): \(L10n.text(item.value))")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var icon: String {
        if entry.type.contains("installed") || entry.type.contains("added") { return "plus.circle.fill" }
        if entry.type.contains("removed") || entry.type.contains("uninstalled") { return "minus.circle.fill" }
        if entry.type.contains("rolled-back") { return "arrow.uturn.backward.circle.fill" }
        if entry.type.contains("monitoring") { return "waveform.path.ecg" }
        return "arrow.triangle.2.circlepath.circle.fill"
    }
}
