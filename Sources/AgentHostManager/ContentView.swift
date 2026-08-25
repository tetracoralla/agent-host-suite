import SwiftUI

struct ContentView: View {
    @ObservedObject var store: AgentHostStore
    @State private var confirmMonitoring = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                if store.suite?.configured == true {
                    providerSection
                    hostSection
                    executionSection
                    monitoringSection
                    doctorSection
                } else {
                    unavailable
                }
            }
            .padding(28)
        }
        .toolbar {
            ToolbarItemGroup {
                Button { Task { await store.runDoctor() } } label: { Label("Check", systemImage: "stethoscope") }
                    .disabled(store.isBusy || store.suite?.configured != true)
                Button { Task { await store.update() } } label: { Label("Update", systemImage: "arrow.triangle.2.circlepath") }
                    .disabled(store.isBusy || store.suite?.configured != true)
            }
        }
        .alert("Agent Host", isPresented: Binding(get: { store.errorMessage != nil }, set: { if !$0 { store.errorMessage = nil } })) {
            Button("OK", role: .cancel) { store.errorMessage = nil }
        } message: {
            Text(store.errorMessage ?? "")
        }
        .confirmationDialog("Turn on local monitoring?", isPresented: $confirmMonitoring) {
            Button("Turn On") { Task { await store.setObservability(true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A local check runs every 5 minutes and stores metadata under ~/Library/Application Support/OpenAdam/Agent Tool Observer. A weekly catalog measurement is also scheduled. Prompts, tool arguments, and tool results are not stored or uploaded.")
        }
        .overlay {
            if store.isBusy { ProgressView().controlSize(.large).padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)) }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Agent Host").font(.largeTitle.weight(.semibold))
                Text(store.suite?.profile == "observability" ? "Tools and local monitoring" : "Tools and local execution")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            HealthBadge(health: store.health)
        }
    }

    private var providerSection: some View {
        SectionCard(title: "Tools") {
            ProviderRow(name: "Math Anchor", detail: "Exact and reliability-sensitive calculation", version: store.suite?.components?["math-anchor"]?.version)
            Divider()
            ProviderRow(name: "Migratory Time", detail: "Time-zone conversion with daylight-saving rules", version: store.suite?.components?["migratory-time"]?.version)
        }
    }

    private var hostSection: some View {
        SectionCard(title: "Agent apps") {
            StatusRow(name: "Codex", active: store.suite?.hosts?["codex"]?.installed == true)
            Divider()
            StatusRow(name: "Claude Code", active: store.suite?.hosts?["claude"]?.installed == true)
        }
    }

    private var executionSection: some View {
        SectionCard(title: "Fast local execution") {
            HStack {
                Label(store.suite?.service == nil ? "Stopped" : "Running", systemImage: store.suite?.service == nil ? "stop.circle" : "bolt.circle.fill")
                    .foregroundStyle(store.suite?.service == nil ? Color.secondary : Color.green)
                Spacer()
                Text("0 model calls").foregroundStyle(.secondary)
            }
        }
    }

    private var monitoringSection: some View {
        SectionCard(title: "Local monitoring") {
            Toggle(isOn: Binding(
                get: { store.observations?.enabled == true },
                set: { value in
                    if value { confirmMonitoring = true }
                    else { Task { await store.setObservability(false) } }
                }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(store.observations?.enabled == true ? "On" : "Off")
                    Text("Stores counts and timings, not prompts or tool contents")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .disabled(store.isBusy)
            if let latest = store.observations?.latest {
                Divider()
                LabeledContent("Observed tool calls", value: latest.report.totals.observedCalls.formatted())
                LabeledContent("Managed catalog", value: ByteCountFormatter.string(fromByteCount: Int64(latest.context.catalog.canonicalUtf8Bytes), countStyle: .file))
                LabeledContent("Managed tools", value: latest.context.counts.tools.formatted())
                LabeledContent("Name collisions", value: latest.context.hardNameCollisions.formatted())
            }
        }
    }

    @ViewBuilder private var doctorSection: some View {
        if let doctor = store.doctor {
            SectionCard(title: "Latest check") {
                ForEach(doctor.checks) { check in
                    Label(check.message, systemImage: check.status == "ok" ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(check.status == "ok" ? Color.primary : Color.orange)
                }
            }
        }
    }

    private var unavailable: some View {
        ContentUnavailableView("Not configured", systemImage: "shippingbox", description: Text("Install the Agent Host suite, then reopen this app."))
            .frame(maxWidth: .infinity, minHeight: 320)
    }
}

private struct SectionCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            VStack(alignment: .leading, spacing: 12) { content }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

private struct ProviderRow: View {
    let name: String
    let detail: String
    let version: String?
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) { Text(name); Text(detail).font(.caption).foregroundStyle(.secondary) }
            Spacer()
            Text(version?.split(separator: "+", maxSplits: 1).first.map(String.init) ?? "Unavailable").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
    }
}

private struct StatusRow: View {
    let name: String
    let active: Bool
    var body: some View {
        HStack { Text(name); Spacer(); Label(active ? "Tools installed" : "Not installed", systemImage: active ? "checkmark.circle.fill" : "circle").foregroundStyle(active ? .green : .secondary) }
    }
}

private struct HealthBadge: View {
    let health: ManagerHealth
    var body: some View {
        let value: (String, Color) = switch health {
        case .loading: ("Checking", .secondary)
        case .ready: ("Local setup healthy", .green)
        case .attention: ("Attention", .orange)
        case .unavailable: ("Not configured", .secondary)
        }
        Text(value.0).font(.caption.weight(.medium)).padding(.horizontal, 10).padding(.vertical, 5).background(value.1.opacity(0.14), in: Capsule()).foregroundStyle(value.1)
    }
}
