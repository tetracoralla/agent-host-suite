import SwiftUI

/// Keep the collection mounted while a detail is open, so returning preserves
/// the search, scroll position, and keyboard focus.
struct ToolsView: View {
    @ObservedObject var store: AgentHostStore
    @SceneStorage("myToolsSearch") private var searchText = ""
    @State private var selectedID: String?
    @State private var selectedProcedureID: String?
    @FocusState private var focusedID: String?

    var body: some View {
        ZStack {
            collection
                .opacity(selectedID == nil && selectedProcedureID == nil ? 1 : 0)
                .allowsHitTesting(selectedID == nil && selectedProcedureID == nil)
                .accessibilityHidden(selectedID != nil || selectedProcedureID != nil)
            if let selectedID {
                ToolDetailView(store: store, toolID: selectedID) {
                    self.selectedID = nil
                    focusedID = selectedID
                }
                .id(selectedID)
            }
            if let selectedProcedureID,
               let procedure = store.managedProcedures.first(where: { $0.id == selectedProcedureID }) {
                ProcedureDetailView(store: store, procedure: procedure) {
                    self.selectedProcedureID = nil
                    focusedID = selectedProcedureID
                }
                .id(selectedProcedureID)
            }
        }
    }

    private var collection: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                PageHeader(title: "Library", subtitle: nil) {
                    if store.suite?.configured == true {
                        Menu(L10n.text("Manage")) {
                            Button(L10n.text("Check for updates")) { Task { await store.checkUpdates() } }
                            Divider()
                            if store.suite?.agentToolsPaused == true {
                                Button(L10n.text("Resume tools")) { Task { await store.resumeTools() } }
                            } else {
                                Button(L10n.text("Pause all tools")) { Task { await store.pauseAllTools() } }
                            }
                        }
                        .fixedSize()
                        .disabled(store.isBusy)
                    }
                }
                ToolSearchField(text: $searchText, prompt: "Search providers and procedures")
                if store.suite?.agentToolsPaused == true {
                    HStack {
                        Label(L10n.text("All tools are paused."), systemImage: "pause.circle")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button(L10n.text("Resume tools")) { Task { await store.resumeTools() } }
                            .disabled(store.isBusy)
                    }
                }
                if store.toolSetNeedsFreshTask {
                    Text(L10n.text("New tasks load this tool selection. Tasks already open keep the tools they started with."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if installedMatches.isEmpty && procedureMatches.isEmpty {
                    ContentUnavailableView(
                        L10n.text(searchText.isEmpty ? "No installed products" : "No matching tools"),
                        systemImage: searchText.isEmpty ? "shippingbox" : "magnifyingglass"
                    )
                    .frame(maxWidth: .infinity, minHeight: 150)
                }
                if !installedMatches.isEmpty {
                    Text(L10n.text("Providers")).font(.headline)
                    LazyVGrid(columns: toolColumns, spacing: 0) {
                        ForEach(installedMatches) { tool in
                            ToolRow(name: tool.name, summary: ToolPresentation.summary(tool.id, fallback: tool.summary),
                                    logo: tool.logo, systemImage: tool.systemImage, toolID: tool.id,
                                    state: store.suite?.agentToolsPaused == true ? .inactive : tool.state,
                                    updateAvailable: store.updates?.items?.contains { $0.id == tool.id && $0.availability == "update-available" } == true, paused: store.suite?.agentToolsPaused == true, onDemandAvailable: tool.onDemandAvailable) {
                                selectedID = tool.id
                            }
                            .focused($focusedID, equals: tool.id)
                        }
                    }
                }
                if !procedureMatches.isEmpty {
                    Text(L10n.text("Procedures")).font(.headline)
                    LazyVGrid(columns: toolColumns, spacing: 0) {
                        ForEach(procedureMatches) { procedure in
                            ProcedureRow(procedure: procedure) {
                                selectedProcedureID = procedure.id
                            }
                            .focused($focusedID, equals: procedure.id)
                        }
                    }
                }
                if !catalogMatches.isEmpty {
                    HStack {
                        Text(L10n.text("Recommended")).font(.headline)
                        Spacer()
                        Button { store.requestedSection = .updates } label: {
                            Image(systemName: "arrow.right")
                        }
                        .buttonStyle(.plain)
                        .help(L10n.text("See all"))
                        .accessibilityLabel(L10n.text("See all"))
                    }
                    .padding(.top, 12)
                    LazyVGrid(columns: toolColumns, spacing: 0) {
                        ForEach(catalogMatches) { tool in
                            ToolRow(name: tool.name, summary: tool.summary, logo: nil, systemImage: tool.systemImage,
                                    toolID: tool.id, state: nil, platformUnavailable: !store.catalogToolAvailable(tool.id)) { selectedID = tool.id }
                                .focused($focusedID, equals: tool.id)
                        }
                    }
                } else if searchText.isEmpty {
                    Button(L10n.text("Browse more tools")) { store.requestedSection = .updates }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: 900, alignment: .leading)
            .padding(32)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }

    private var installedMatches: [ManagedTool] {
        store.managedTools.filter { ToolPresentation.matches(searchText, name: $0.name, summary: ToolPresentation.summary($0.id, fallback: $0.summary)) }
    }
    private var procedureMatches: [ManagedProcedure] {
        store.managedProcedures.filter {
            ToolPresentation.matches(searchText, name: $0.name, summary: $0.summary + " " + $0.procedureId)
        }
    }
    private var catalogMatches: [ManagerSetupTool] {
        Array(store.featuredCatalogTools.filter {
            !store.isFeaturedToolInstalled($0.id) && ToolPresentation.matches(searchText, name: $0.name, summary: L10n.text($0.summary) + " " + L10n.text($0.details))
        }.prefix(searchText.isEmpty ? 4 : Int.max))
    }
}

private struct ProcedureRow: View {
    let procedure: ManagedProcedure
    let open: () -> Void

    private var stateLabel: String {
        guard procedure.availability?.contractValidated == true,
              procedure.availability?.discoverable == true else { return "Needs attention" }
        if procedure.availability?.invocationEvidence.valid == true { return "Ready; current invocation evidence is healthy" }
        if procedure.availability?.lastSuccessfulInvocationAt != nil { return "Ready; prior invocation recorded, current binding not checked" }
        return "Ready; no successful invocation recorded"
    }

    private var evidenceCurrent: Bool {
        procedure.availability?.invocationEvidence.valid == true
    }

    private var contractReady: Bool {
        procedure.availability?.contractValidated == true && procedure.availability?.discoverable == true
    }

    var body: some View {
        Button(action: open) {
            HStack(spacing: 13) {
                ToolLogoView(logo: procedure.logo, systemImage: "point.3.connected.trianglepath.dotted", toolID: procedure.id, size: 38)
                VStack(alignment: .leading, spacing: 4) {
                    Text(procedure.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Text(L10n.text(procedure.summary)).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                Image(systemName: evidenceCurrent ? "checkmark" : contractReady ? "circle" : "exclamationmark.triangle.fill")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(procedure.availability?.contractValidated == true ? Color.secondary : Color.orange)
                    .accessibilityLabel(L10n.text(stateLabel))
            }
            .padding(.vertical, 17).padding(.horizontal, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .overlay(alignment: .bottom) { Rectangle().fill(.separator.opacity(0.6)).frame(height: 0.5) }
        }
        .buttonStyle(.plain)
        .focusable()
        .help(procedure.name + " · " + L10n.text(stateLabel))
        .accessibilityElement(children: .combine)
    }
}

private struct ProcedureDetailView: View {
    @ObservedObject var store: AgentHostStore
    let procedure: ManagedProcedure
    let back: () -> Void
    @State private var confirmingRemoval = false
    @State private var confirmingRollback = false
    @FocusState private var backFocused: Bool

    private var availability: ProcedureAvailability? { procedure.availability }
    private var executionName: String {
        procedure.execution == "agentic-runner" ? "Agentic Runner" : "Direct Runtime"
    }
    private var updateAvailable: Bool {
        store.updates?.items?.contains { $0.id == procedure.id && $0.availability == "update-available" } == true
    }
    private var lastSuccessfulInvocation: String {
        guard let value = availability?.lastSuccessfulInvocationAt else { return L10n.text("Never") }
        if let date = ISO8601DateFormatter().date(from: value) { return L10n.relativeAge(since: date) }
        return value
    }
    private var currentHealth: String {
        switch availability?.currentHealth.status {
        case "healthy": return L10n.text("Healthy")
        case "unavailable": return L10n.text("Unavailable")
        default: return L10n.text("Not checked for current binding")
        }
    }
    private var currentSessionDiscovery: String {
        availability?.currentSessionDiscovery.status == "observed"
            ? L10n.text("Observed")
            : L10n.text("Not observed")
    }
    private var invocationEvidence: String {
        guard let evidence = availability?.invocationEvidence else { return L10n.text("No successful invocation recorded yet") }
        if evidence.valid {
            let stamp = evidence.verifiedAt.flatMap { ISO8601DateFormatter().date(from: $0) }
                .map { " · \(L10n.relativeAge(since: $0))" } ?? ""
            return L10n.text("Verified for the current binding") + stamp
        }
        if let date = evidence.invalidatedAt.flatMap({ ISO8601DateFormatter().date(from: $0) }),
           availability?.lastSuccessfulInvocationAt != nil {
            return L10n.procedureEvidenceReason(evidence.invalidatedReason) + " · " + L10n.relativeAge(since: date)
        }
        if availability?.lastSuccessfulInvocationAt != nil {
            return L10n.text("Prior invocation recorded; current binding not checked")
        }
        return L10n.text("No successful invocation recorded yet")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 30) {
                Button(action: back) { Label(L10n.text("Back"), systemImage: "chevron.left") }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .keyboardShortcut(.escape, modifiers: [])
                    .focused($backFocused)
                HStack(spacing: 18) {
                    ToolLogoView(logo: procedure.logo, systemImage: "point.3.connected.trianglepath.dotted", toolID: procedure.id, size: 64)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(procedure.name).font(.system(size: 26, weight: .semibold)).textSelection(.enabled)
                        Text(L10n.text(procedure.summary)).foregroundStyle(.secondary)
                    }
                }
                Divider()
                VStack(alignment: .leading, spacing: 16) {
                    LabeledContent(L10n.text("Procedure"), value: "\(procedure.procedureId) @ \(procedure.procedureVersion)")
                    LabeledContent(L10n.text("Execution"), value: L10n.text(executionName))
                    LabeledContent(L10n.text("Contract"), value: L10n.text(availability?.contractValidated == true ? "Validated" : "Needs attention"))
                    LabeledContent(L10n.text("Agent discovery"), value: L10n.text(availability?.discoverable == true ? "Discoverable" : "Not discoverable"))
                    LabeledContent(L10n.text("Current health"), value: currentHealth)
                    LabeledContent(L10n.text("Last successful invocation"), value: lastSuccessfulInvocation)
                    LabeledContent(L10n.text("Invocation evidence"), value: invocationEvidence)
                    LabeledContent(L10n.text("Current Agent session"), value: currentSessionDiscovery)
                }
                .foregroundStyle(.secondary)
                HStack(spacing: 12) {
                    if updateAvailable {
                        Button(L10n.text("Install update")) { Task { await store.installUpdate(id: procedure.id) } }
                            .buttonStyle(.borderedProminent)
                    }
                    Button(L10n.text("Check for updates")) { Task { await store.checkUpdates() } }
                    if availability?.contractValidated != true || availability?.discoverable != true {
                        Button(L10n.text("Repair")) { Task { await store.prepareRepair() } }
                            .buttonStyle(.borderedProminent)
                    }
                    if procedure.isPrivate, let rollbackVersion = procedure.rollbackVersion {
                        Button(L10n.text("Roll back")) { confirmingRollback = true }
                    }
                    if procedure.isPrivate {
                        Button(L10n.text("Remove"), role: .destructive) { confirmingRemoval = true }
                    }
                }
                .disabled(store.isBusy)
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(32)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .confirmationDialog(
            L10n.format("Roll back this Procedure to {version}?", ["version": procedure.rollbackVersion ?? ""]),
            isPresented: $confirmingRollback
        ) {
            Button(L10n.text("Roll back")) { Task { await store.rollbackProcedure(id: procedure.id) } }
        }
        .confirmationDialog(L10n.text("Remove this Procedure?"), isPresented: $confirmingRemoval) {
            Button(L10n.text("Remove"), role: .destructive) {
                Task {
                    await store.removeProcedure(id: procedure.id)
                    if store.errorMessage == nil { back() }
                }
            }
            Button(L10n.text("Cancel"), role: .cancel) {}
        }
        .onAppear { backFocused = true }
    }
}
