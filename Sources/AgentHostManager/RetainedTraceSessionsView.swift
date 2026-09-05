import SwiftUI
import UniformTypeIdentifiers

struct RetainedTraceSessionsView: View {
    @ObservedObject var store: AgentHostStore
    let usage: UsageSummary

    @State private var provider = "zcode"
    @State private var document: TraceAnalysisDocument?
    @State private var filename = "agent-host-trace.json"
    @State private var isPresentingExporter = false

    var body: some View {
        let providers = providerIDs
        let catalog = store.traceSourceCatalog?.provider == provider ? store.traceSourceCatalog : nil
        Panel {
            Text(L10n.text("Retained trace sessions")).font(.headline)
            Text(L10n.text("Choose one Agent app to list locally retained metadata, then export one session for analysis."))
                .font(.caption)
                .foregroundStyle(.secondary)
            if providers.isEmpty {
                Text(L10n.text("No trace adapters are available."))
                    .foregroundStyle(.secondary)
            } else {
                sourceControls(providers)
                if let catalog { sourceList(catalog) }
            }
            Text(L10n.text("Exports contain metadata only: no prompts, reasoning, tool arguments, tool results, source paths, or interpretation."))
                .font(.caption)
                .foregroundStyle(.secondary)
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
            Button(L10n.text("Load sessions")) {
                Task { await store.loadTraceSources(provider: provider) }
            }
            .disabled(store.isBusy)
            if store.currentAction == "Loading trace sessions" {
                ProgressView().controlSize(.small)
            }
            Spacer()
        }
        .onAppear {
            if !providers.contains(provider), let first = providers.first { provider = first }
        }
    }

    @ViewBuilder private func sourceList(_ catalog: TraceSourceCatalog) -> some View {
        if catalog.sources.isEmpty {
            Text(L10n.text("No retained sessions for this Agent app."))
                .foregroundStyle(.secondary)
        } else {
            ForEach(Array(catalog.sources.enumerated()), id: \.element.id) { index, source in
                if index > 0 { Divider() }
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(ManagerAgentApp.named(catalog.provider).name) · \(source.sessionHash.prefix(12))…")
                            .lineLimit(1)
                            .help(source.sessionHash)
                        Text(L10n.format("{events} events · last observed {date}", [
                            "events": source.totalEvents.formatted(),
                            "date": traceDate(source.lastEventAtMs),
                        ]))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(L10n.text("Export metadata")) {
                        prepareExport(provider: catalog.provider, source: source)
                    }
                    .disabled(store.isBusy)
                }
                .accessibilityElement(children: .contain)
            }
        }
        if catalog.limits.sourceLimitReached {
            Text(L10n.format("Showing the newest {count} retained sessions.", [
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
        return usage.trace.adapters.compactMap(\.provider).filter { seen.insert($0).inserted }
    }

    private func traceDate(_ milliseconds: Int64) -> String {
        let formatter = DateFormatter()
        formatter.locale = L10n.locale
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: Date(timeIntervalSince1970: Double(milliseconds) / 1_000))
    }

    private func prepareExport(provider: String, source: TraceSourceEntry) {
        Task {
            guard let data = await store.prepareTraceExport(provider: provider, sessionHash: source.sessionHash) else { return }
            filename = "agent-host-\(provider)-trace-\(source.sessionHash.prefix(12)).json"
            document = TraceAnalysisDocument(data: data)
            isPresentingExporter = true
        }
    }
}
