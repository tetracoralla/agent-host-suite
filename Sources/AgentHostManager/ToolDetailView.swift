import SwiftUI

// Compact collection rows share rhythm, not a card-shaped container.
let toolColumns = [GridItem(.adaptive(minimum: 300), spacing: 30, alignment: .leading)]

enum ToolPresentation {
    static func summary(_ id: String, fallback: String) -> String {
        let jobs = [
            "math-anchor": "Exact calculation", "migratory-time": "World time",
            "data-transformer": "Structured data", "armorial": "Project icons",
            "laniakea": "Mind maps", "projective": "Projective layouts",
            "equatorium": "Standard expressions", "file-vitals": "File inspection",
            "layout-contract-conformance": "Responsive layouts", "calligram": "Visual documents",
            "worldbend": "Spatial composition", "text-integrity": "Unicode inspection",
            "decision-table": "Decision rules", "schedule-algebra": "Schedule calculation",
            "state-machine": "State transitions", "context-surface-analyzer": "Context inspection",
        ]
        return jobs[id] ?? fallback
    }

    static func matches(_ query: String, name: String, summary: String) -> Bool {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty || name.localizedCaseInsensitiveContains(query)
            || L10n.text(summary).localizedCaseInsensitiveContains(query)
    }
}

struct ToolSearchField: View {
    @Binding var text: String
    let prompt: String
    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "magnifyingglass").foregroundStyle(.tertiary)
            TextField(L10n.text(prompt), text: $text).textFieldStyle(.plain)
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .accessibilityLabel(L10n.text("Clear search"))
            }
        }
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) { Divider() }
    }
}

struct ToolRow: View {
    let name: String
    let summary: String
    let logo: ToolLogo?
    let systemImage: String
    let toolID: String
    let state: ManagedItemState?
    var updateAvailable = false
    var paused = false
    let open: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: 13) {
                ToolLogoView(logo: logo, systemImage: systemImage, toolID: toolID, size: 38)
                VStack(alignment: .leading, spacing: 4) {
                    Text(name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Text(L10n.text(summary)).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                ToolStateSymbol(state: state, updateAvailable: updateAvailable, paused: paused)
            }
            .padding(.vertical, 17).padding(.horizontal, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .background(hovered ? Color.primary.opacity(0.035) : .clear, in: RoundedRectangle(cornerRadius: 6))
            .overlay(alignment: .bottom) { Rectangle().fill(.separator.opacity(0.6)).frame(height: 0.5) }
        }
        .buttonStyle(.plain)
        .focusable()
        .onHover { hovered = $0 }
        .help(name + " · " + L10n.text(summary))
        .accessibilityElement(children: .combine)
    }
}

struct ToolStateSymbol: View {
    let state: ManagedItemState?
    var updateAvailable = false
    var paused = false
    private var label: String { paused ? "Paused" : updateAvailable ? "Update available" : state == .inactive ? "On-demand" : (state?.label ?? "Available to install") }
    private var symbol: String {
        if paused { return "pause" }
        if updateAvailable { return "arrow.up.circle.fill" }
        switch state {
        case .ready: return "checkmark"
        case .attention: return "exclamationmark.triangle.fill"
        case .unavailable: return "xmark.circle"
        case .checking: return "circle.dashed"
        case .inactive: return "circle"
        case nil: return "arrow.down"
        }
    }
    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(updateAvailable || state == .attention ? Color.orange : Color.secondary)
            .frame(width: 18)
            .help(L10n.text(label))
            .accessibilityLabel(L10n.text(label))
    }
}

struct ToolDetailView: View {
    @ObservedObject var store: AgentHostStore
    let toolID: String
    let back: () -> Void
    @State private var taskDraft = ""
    @State private var copied = false
    @State private var confirmingPause = false
    @FocusState private var backFocused: Bool

    private var installed: ManagedTool? { store.managedTools.first { $0.id == toolID } }
    private var catalog: ManagerSetupTool? { store.featuredCatalogTools.first { $0.id == toolID } }
    private var paused: Bool { store.suite?.agentToolsPaused == true }
    private var update: UpdateItem? { store.updates?.items?.first { $0.id == toolID && $0.availability == "update-available" } }
    private var name: String { installed?.name ?? catalog?.name ?? toolID }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 30) {
                Button(action: back) { Label(L10n.text("Back"), systemImage: "chevron.left") }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .keyboardShortcut(.escape, modifiers: [])
                    .focused($backFocused)
                HStack(alignment: .center, spacing: 18) {
                    ToolLogoView(logo: installed?.logo, systemImage: installed?.systemImage ?? catalog?.systemImage ?? "shippingbox",
                                 toolID: toolID, bundledResource: catalog?.logoResource, size: 64)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(name).font(.system(size: 26, weight: .semibold)).textSelection(.enabled)
                        Text(L10n.text(ToolPresentation.summary(toolID, fallback: installed?.summary ?? catalog?.summary ?? "")))
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 12)
                    primaryAction
                }
                if let installed {
                    if installed.state == .attention {
                        HStack {
                            Label(L10n.text("Needs attention"), systemImage: "exclamationmark.triangle")
                                .foregroundStyle(.orange)
                            Spacer()
                            Button(L10n.text("Repair")) { Task { await store.prepareRepair() } }.disabled(store.isBusy)
                        }
                    }
                    if paused {
                        Label(L10n.text("All tools are paused."), systemImage: "pause.circle")
                            .foregroundStyle(.secondary)
                    }
                }
                if catalog?.examplePrompt != nil {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(L10n.text("Try a task")).font(.headline)
                        TextEditor(text: $taskDraft)
                            .font(.system(size: 14))
                            .scrollContentBackground(.hidden)
                            .frame(minHeight: 96, maxHeight: 180)
                            .padding(14)
                            .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 10))
                            .accessibilityLabel(L10n.text("Example task"))
                        if copied {
                            Label(L10n.text("Task copied"), systemImage: "doc.on.clipboard")
                                .foregroundStyle(.secondary).font(.caption)
                        }
                    }
                } else if let summary = installed?.summary, !summary.isEmpty {
                    Text(L10n.text(summary)).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Divider()
                VStack(alignment: .leading, spacing: 18) {
                    if let installed {
                        Toggle(L10n.text("Enable by default"), isOn: Binding(
                            get: { self.installed?.active == true },
                            set: { value in
                                if !value && store.suite?.agentComponents?.count == 1 { confirmingPause = true }
                                else { Task { await store.setTool(toolID, active: value) } }
                            }
                        ))
                        .toggleStyle(.switch)
                        .disabled(store.isBusy || paused)
                        .help(L10n.text("Off keeps an on-demand Skill. Pause all withholds both."))
                        if let version = installed.version {
                            LabeledContent(L10n.text("Version")) { Text(version).textSelection(.enabled) }
                                .foregroundStyle(.secondary)
                        }
                    }
                    if let homepage = installed?.homepage ?? catalog?.repositoryURL, let url = URL(string: homepage) {
                        Link(destination: url) { Label(url.host ?? L10n.text("Project website"), systemImage: "arrow.up.right") }
                    }
                    if update != nil {
                        HStack {
                            Text(L10n.text("Update available")).foregroundStyle(.secondary)
                            Spacer()
                            Button(L10n.text("Update")) { Task { await store.installUpdate(id: toolID) } }.disabled(store.isBusy)
                        }
                    }
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(32)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .confirmationDialog(L10n.text("Pause all tools?"), isPresented: $confirmingPause) {
            Button(L10n.text("Pause all tools")) { Task { await store.pauseAllTools() } }
            Button(L10n.text("Cancel"), role: .cancel) {}
        } message: { Text(L10n.text("On-demand tools will also pause.")) }
        .onAppear {
            taskDraft = store.exampleTaskDrafts[toolID] ?? L10n.text(catalog?.examplePrompt ?? "")
            backFocused = true
        }
        .onChange(of: taskDraft) { _, value in
            store.exampleTaskDrafts[toolID] = value
            copied = false
        }
    }

    @ViewBuilder private var primaryAction: some View {
        if installed == nil, catalog != nil {
            // Installs the whole admitted featured set; the preflight plan
            // discloses exactly which tools that adds.
            Button(L10n.text("Install featured tools")) {
                Task {
                    if store.suite?.configured == true { await store.prepareFeaturedAcquire() }
                    else { store.selectedSetupProfile = "featured"; await store.prepareSetup() }
                }
            }
            .buttonStyle(.borderedProminent).disabled(store.isBusy)
        } else if paused {
            Button(L10n.text("Resume tools")) { Task { await store.resumeTools() } }
                .buttonStyle(.borderedProminent).disabled(store.isBusy)
        } else if catalog?.examplePrompt != nil, installed != nil {
            Button(L10n.text("Use in Agent")) { copied = store.beginExampleTask(taskDraft) }
                .buttonStyle(.borderedProminent)
                .disabled(store.isBusy || taskDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }
}
