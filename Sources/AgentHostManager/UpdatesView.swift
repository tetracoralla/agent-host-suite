import SwiftUI

/// Keep the collection mounted while a detail is open, so returning preserves
/// the search, scroll position, and keyboard focus.
struct ToolsView: View {
    @ObservedObject var store: AgentHostStore
    @SceneStorage("myToolsSearch") private var searchText = ""
    @State private var selectedID: String?
    @FocusState private var focusedID: String?

    var body: some View {
        ZStack {
            collection
                .opacity(selectedID == nil ? 1 : 0)
                .allowsHitTesting(selectedID == nil)
                .accessibilityHidden(selectedID != nil)
            if let selectedID {
                ToolDetailView(store: store, toolID: selectedID) {
                    self.selectedID = nil
                    focusedID = selectedID
                }
                .id(selectedID)
            }
        }
    }

    private var collection: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                PageHeader(title: "My tools", subtitle: nil) {
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
                ToolSearchField(text: $searchText, prompt: "Search tools")
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
                    NoticeView(title: "Start a fresh Agent task", message: "", systemImage: "arrow.clockwise.circle", color: .blue)
                        .help(L10n.text("Open tasks keep their old tools."))
                }
                if installedMatches.isEmpty {
                    ContentUnavailableView(
                        L10n.text(searchText.isEmpty ? "No installed tools" : "No matching tools"),
                        systemImage: searchText.isEmpty ? "shippingbox" : "magnifyingglass"
                    )
                    .frame(maxWidth: .infinity, minHeight: 150)
                } else {
                    LazyVGrid(columns: toolColumns, spacing: 0) {
                        ForEach(installedMatches) { tool in
                            ToolRow(name: tool.name, summary: ToolPresentation.summary(tool.id, fallback: tool.summary),
                                    logo: tool.logo, systemImage: tool.systemImage, toolID: tool.id,
                                    state: store.suite?.agentToolsPaused == true ? .inactive : tool.state,
                                    updateAvailable: store.updates?.items?.contains { $0.id == tool.id && $0.availability == "update-available" } == true, paused: store.suite?.agentToolsPaused == true) {
                                selectedID = tool.id
                            }
                            .focused($focusedID, equals: tool.id)
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
                                    toolID: tool.id, state: nil) { selectedID = tool.id }
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
    private var catalogMatches: [ManagerSetupTool] {
        Array(store.featuredCatalogTools.filter {
            !store.isFeaturedToolInstalled($0.id) && ToolPresentation.matches(searchText, name: $0.name, summary: L10n.text($0.summary) + " " + L10n.text($0.details))
        }.prefix(searchText.isEmpty ? 4 : Int.max))
    }
}
