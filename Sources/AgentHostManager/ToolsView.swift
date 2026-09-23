import SwiftUI

struct ToolLibraryView: View {
    @ObservedObject var store: AgentHostStore
    @SceneStorage("browseToolsSearch") private var searchText = ""
    @State private var selectedID: String?
    @State private var isAddingGitHubProject = false
    @FocusState private var focusedID: String?

    var body: some View {
        ZStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    PageHeader(title: "Browse", subtitle: nil) {
                        Button { isAddingGitHubProject = true } label: {
                            Label(L10n.text("GitHub"), systemImage: "plus")
                        }
                    }
                    ToolSearchField(text: $searchText, prompt: "Search tools")
                    if filteredTools.isEmpty {
                        ContentUnavailableView.search(text: searchText)
                    } else {
                        LazyVGrid(columns: toolColumns, spacing: 0) {
                            ForEach(filteredTools) { tool in
                                let installed = store.managedTools.first { $0.id == tool.id }
                                ToolRow(name: tool.name, summary: ToolPresentation.summary(tool.id, fallback: tool.summary), logo: nil,
                                        systemImage: tool.systemImage, toolID: tool.id,
                                        state: installed?.state,
                                        updateAvailable: store.updates?.items?.contains { $0.id == tool.id && $0.availability == "update-available" } == true,
                                        paused: installed != nil && store.suite?.agentToolsPaused == true, onDemandAvailable: installed?.onDemandAvailable == true,
                                        platformUnavailable: installed == nil && !store.catalogToolAvailable(tool.id)) {
                                    selectedID = tool.id
                                }
                                .focused($focusedID, equals: tool.id)
                            }
                        }
                    }
                }
                .frame(maxWidth: 900, alignment: .leading)
                .padding(32)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
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
        .sheet(isPresented: $isAddingGitHubProject) { GitHubToolImportView(store: store) }
    }

    private var filteredTools: [ManagerSetupTool] {
        store.featuredCatalogTools.filter {
            ToolPresentation.matches(searchText, name: $0.name, summary: L10n.text($0.summary) + " " + L10n.text($0.details))
        }
    }
}

struct GitHubToolImportView: View {
    @ObservedObject var store: AgentHostStore
    var initialURL = ""
    @State private var githubURL = ""
    @State private var previewedURL = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text(L10n.text("Add from GitHub"))
                    .font(.title2.weight(.semibold))
                Spacer()
                Button(L10n.text("Close")) { dismiss() }
            }

            TextField(L10n.text("GitHub repository or Release URL"), text: $githubURL)
                .textFieldStyle(.roundedBorder)

            HStack {
                Button(L10n.text("Check compatibility")) {
                    let target = normalizedURL
                    Task {
                        await store.previewGitHubTool(target)
                        if store.githubPreview != nil && normalizedURL == target {
                            previewedURL = target
                        } else {
                            store.clearGitHubPreview()
                        }
                    }
                }
                .disabled(store.isBusy || githubURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Spacer()
            }

            if let preview = store.githubPreview {
                Divider()
                HStack(alignment: .top, spacing: 14) {
                    ToolLogoView(logo: preview.presentation?.logo, systemImage: "shippingbox", size: 52)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(preview.presentation?.displayName ?? preview.origin?.repository ?? L10n.text("GitHub project"))
                            .font(.headline)
                        if let summary = preview.presentation?.summary {
                            Text(summary).foregroundStyle(.secondary)
                        }
                        Label(
                            L10n.text(preview.compatibility?.available == true ? "Compatible" : "Not compatible"),
                            systemImage: preview.compatibility?.available == true ? "checkmark.seal.fill" : "exclamationmark.triangle.fill"
                        )
                        .foregroundStyle(preview.compatibility?.available == true ? Color.green : Color.orange)
                    }
                }
                if let reason = preview.compatibility?.reason, preview.compatibility?.available != true {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            if let message = store.errorMessage {
                Text(message).font(.callout).foregroundStyle(.red).textSelection(.enabled)
            }
            if store.githubConflictURL == normalizedURL {
                Text(L10n.text("This tool is already configured independently. Agent Host can take over its connection and restore the previous configuration when you remove it."))
                    .font(.callout).foregroundStyle(.secondary)
            }

            HStack {
                Spacer()
                if store.suite?.configured == true {
                    Button(L10n.text(store.githubConflictURL == normalizedURL ? "Take over connection and add" : "Add tool")) {
                        Task {
                            await store.addGitHubTool(githubURL, replacingHostConflicts: store.githubConflictURL == normalizedURL)
                            if store.errorMessage == nil && store.githubPreview == nil { dismiss() }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(
                        store.isBusy
                            || store.githubPreview?.compatibility?.available != true
                            || normalizedURL != previewedURL
                    )
                } else {
                    Text(L10n.text("Install Agent Host before adding a GitHub tool."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(24)
        .frame(width: 560, height: 500)
        .onAppear {
            store.clearGitHubPreview()
            store.errorMessage = nil
            githubURL = initialURL
            previewedURL = ""
        }
        .onChange(of: normalizedURL) { _, value in
            if value != previewedURL { store.clearGitHubPreview() }
        }
    }

    private var normalizedURL: String {
        githubURL.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
