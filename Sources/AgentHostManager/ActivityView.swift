import SwiftUI

struct ActivityView: View {
    @ObservedObject var store: AgentHostStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "History", subtitle: nil) {
                    EmptyView()
                }

                if store.activity.isEmpty {
                    ContentUnavailableView(L10n.text("No activity yet"), systemImage: "clock", description: Text(L10n.text("Install, update, repair, and connection changes appear here.")))
                        .frame(maxWidth: .infinity, minHeight: 300)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(store.activity.enumerated()), id: \.element.id) { index, entry in
                            ActivityRow(
                                entry: entry,
                                componentNames: Dictionary(uniqueKeysWithValues: (store.suite?.components ?? [:]).map {
                                    ($0.key, $0.value.displayName ?? $0.key)
                                })
                            )
                            if index < store.activity.count - 1 { Divider().padding(.leading, 34) }
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
                .accessibilityHidden(true)
            let details = entry.humanDetail(componentNames: componentNames)
            if details.isEmpty {
                summary
            } else {
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(details.enumerated()), id: \.offset) { _, item in
                            Text("\(L10n.text(item.label)): \(L10n.text(item.value))")
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 10)
                } label: { summary }
            }
        }
        .padding(.vertical, 18)
    }

    private var summary: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(entry.localizedSummary)
            Spacer(minLength: 8)
            if let date = entry.date {
                Text(L10n.relativeAge(since: date))
                    .font(.caption).foregroundStyle(.secondary).fixedSize()
                    .help(date.formatted(date: .complete, time: .shortened))
            }
        }
    }

    private var icon: String {
        if entry.type.contains("installed") || entry.type.contains("added") || entry.type.contains("imported") { return "plus.circle.fill" }
        if entry.type.contains("removed") || entry.type.contains("uninstalled") { return "minus.circle.fill" }
        if entry.type.contains("rolled-back") { return "arrow.uturn.backward.circle.fill" }
        if entry.type.contains("monitoring") { return "waveform.path.ecg" }
        return "arrow.triangle.2.circlepath.circle.fill"
    }
}
