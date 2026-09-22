import SwiftUI
import UniformTypeIdentifiers

struct RetainedTaskSessionsView: View {
    @ObservedObject var store: AgentHostStore
    let usage: UsageSummary

    @State private var provider = "codex"
    @State private var document: JSONExportDocument?
    @State private var filename = "agent-host-task-activity.json"
    @State private var isPresentingExporter = false
    @State private var loadError: String?

    var body: some View {
        let providers = providerIDs
        let catalog = store.taskSourceCatalog?.provider == provider ? store.taskSourceCatalog : nil
        DataSection {
            Text(L10n.text("Task activity")).font(.headline)
            if providers.isEmpty {
                Text(L10n.text("No retained task activity for this Agent app."))
                    .foregroundStyle(.secondary)
            } else {
                sourceControls(providers)
                if let loadError {
                    Text(L10n.text(loadError))
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                if let catalog { sourceList(catalog) }
            }
            if let catalog, catalog.sources.contains(where: { $0.staticReferences > 0 }) {
                Text(L10n.text("Static references do not prove execution."))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .fileExporter(
            isPresented: $isPresentingExporter,
            document: document,
            contentType: .json,
            defaultFilename: filename
        ) { result in
            document = nil
            if case let .failure(error) = result {
                store.errorMessage = error.localizedDescription
            }
        }
    }

    @ViewBuilder private func sourceControls(_ providers: [String]) -> some View {
        HStack(spacing: 10) {
            Picker(L10n.text("Agent app"), selection: $provider) {
                ForEach(providers, id: \.self) { id in
                    Text(ManagerAgentApp.named(id).name).tag(id)
                }
            }
            .labelsHidden()
            .frame(maxWidth: 220)
            Button(L10n.text("Show recent tasks")) {
                Task {
                    loadError = nil
                    loadError = await store.loadTaskSources(provider: provider)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(store.isBusy)
            if store.currentAction == "Loading task activity" {
                ProgressView().controlSize(.small)
            }
            Spacer()
        }
        .onAppear {
            if !providers.contains(provider), let first = providers.first { provider = first }
        }
        .onChange(of: provider) { _, _ in loadError = nil }
    }

    @ViewBuilder private func sourceList(_ catalog: TaskSourceCatalog) -> some View {
        if catalog.sources.isEmpty {
            Text(L10n.text("No retained task activity for this Agent app."))
                .foregroundStyle(.secondary)
        } else {
            ForEach(Array(catalog.sources.enumerated()), id: \.element.id) { index, source in
                if index > 0 { Divider() }
                HStack(alignment: .center, spacing: 16) {
                    VStack(alignment: .leading, spacing: 7) {
                        Text("\(ManagerAgentApp.named(catalog.provider).name) · \(taskDate(source.lastEventAtMs))")
                            .fontWeight(.semibold)
                        HStack(spacing: 16) {
                            TaskActivityMetric(value: source.directCalls, label: "Direct calls")
                            TaskActivityMetric(value: source.errors, label: "Errors", color: source.errors > 0 ? .orange : .secondary)
                            TaskActivityMetric(value: source.staticReferences, label: "Static references", color: .secondary)
                        }
                    }
                    Spacer(minLength: 12)
                    Button(L10n.text("Export details")) {
                        prepareExport(provider: catalog.provider, source: source)
                    }
                    .disabled(store.isBusy)
                }
                .accessibilityElement(children: .contain)
            }
        }
        if catalog.limits.sourceLimitReached {
            Text(L10n.format("Showing the newest {count} retained tasks.", [
                "count": catalog.limits.sourcesReturned.formatted(),
            ]))
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Text(L10n.format("Retained for {days} days. Earlier or pre-monitoring events may be missing; completeness is unknown.", [
            "days": catalog.retention.retentionDays.formatted(),
        ]))
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private var providerIDs: [String] {
        var seen = Set<String>()
        return usage.providerActivity.compactMap(\.provider).filter { seen.insert($0).inserted }
    }

    private func taskDate(_ milliseconds: Int64) -> String {
        let formatter = DateFormatter()
        formatter.locale = L10n.locale
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: Date(timeIntervalSince1970: Double(milliseconds) / 1_000))
    }

    private func prepareExport(provider: String, source: TaskSourceEntry) {
        Task {
            guard let data = await store.prepareTaskActivityExport(provider: provider, sessionHash: source.sessionHash) else { return }
            filename = "agent-host-\(provider)-task-\(source.sessionHash.prefix(12)).json"
            document = JSONExportDocument(data: data)
            isPresentingExporter = true
        }
    }
}

private struct TaskActivityMetric: View {
    let value: Int
    let label: String
    var color: Color = .primary

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(value.formatted())
                .font(.callout.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(value > 0 ? color : .secondary)
            Text(L10n.text(label))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}
