import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
    @ObservedObject var store: AgentHostStore
    @State private var confirmMonitoring = false
    @State private var confirmUninstall = false
    @State private var catalogURL = ""
    @State private var showingCatalogURL = false
    @State private var showingCatalogImporter = false
    @AppStorage(ManagerLanguage.storageKey) private var language = ManagerLanguage.system.rawValue

    var body: some View {
        Form {
            Section(L10n.text("General")) {
                Picker(L10n.text("Language"), selection: $language) {
                    ForEach(ManagerLanguage.allCases) { option in
                        Text(option.title).tag(option.rawValue)
                    }
                }
            }

            Section(L10n.text("Versions")) {
                LabeledContent(L10n.text("Application"), value: applicationVersion)
                LabeledContent(L10n.text("Environment"), value: environmentVersion)
                if let tools = componentVersions, !tools.isEmpty {
                    LabeledContent(L10n.text("Tools"), value: tools)
                }
                Text(L10n.text(ManagerSourcePolicy.differentPayloadsNote))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section(L10n.text("Catalog source")) {
                Text(sourceMessage)
                    .font(.body)
                Text(L10n.text(ManagerSourcePolicy.notNotarizedNote))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let lastCheck = store.source?.source?.lastCheck {
                    LabeledContent(L10n.text("Last check"), value: lastCheckLabel(lastCheck))
                }
                if let recovery = store.source?.source?.recovery?.message ?? store.source?.source?.lastCheck?.recovery?.message {
                    Text(recovery)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Button(L10n.text("Check source")) { Task { await store.checkCatalogSource() } }
                    .disabled(store.isBusy)
                Button(L10n.text("Use local catalog…")) { showingCatalogImporter = true }
                    .disabled(store.isBusy)
                Button(L10n.text("Set HTTPS catalog…")) { showingCatalogURL = true }
                    .disabled(store.isBusy)
                if store.source?.source?.kind != nil && store.source?.source?.kind != "unset" {
                    Button(L10n.text("Clear source")) { Task { await store.clearCatalogSource() } }
                        .disabled(store.isBusy)
                }
            }

            Section(L10n.text("Monitoring")) {
                Toggle(L10n.text("Local tool monitoring"), isOn: Binding(
                    get: { store.observations?.enabled == true },
                    set: { enabled in
                        if enabled { confirmMonitoring = true }
                        else { Task { await store.setObservability(false) } }
                    }
                ))
                .disabled(store.isBusy || store.suite?.configured != true)

                Text(L10n.text("Stores counts and timings locally. Prompts, tool arguments, and tool results are not stored or uploaded."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(L10n.text("Monitoring can be turned off without changing installed tools, Agent connections, or the working set."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section(L10n.text("Tool Set")) {
                LabeledContent(L10n.text("Current"), value: currentToolSet)
                if store.suite?.profile == "local-dogfood" {
                    Button(L10n.text("Review Standard + Monitoring…")) { Task { await store.prepareUpdate(profile: "observability") } }
                } else {
                    Button(L10n.text("Review Local Tool Set…")) { Task { await store.prepareUpdate(profile: "local-dogfood") } }
                }
            }

            Section(L10n.text("Recovery")) {
                Button(L10n.text("Review Previous Version…")) { Task { await store.prepareRollback() } }
                    .disabled(store.isBusy || store.suite?.configured != true)
            }

            Section(L10n.text("Remove")) {
                Button(L10n.text("Uninstall Agent Host…"), role: .destructive) { confirmUninstall = true }
                    .disabled(store.isBusy || store.suite?.configured != true)
                Text(L10n.text("You can preserve recovery history or remove Agent Host packages, monitoring data, and retained recovery data. Existing user-owned integrations are never removed."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
        .fileImporter(isPresented: $showingCatalogImporter, allowedContentTypes: [.json]) { result in
            if case let .success(url) = result {
                let path = url.path
                Task { await store.setCatalogManifest(path) }
            }
        }
        .sheet(isPresented: $showingCatalogURL) {
            VStack(alignment: .leading, spacing: 16) {
                Text(L10n.text("Set HTTPS catalog"))
                    .font(.headline)
                TextField("https://…/preview-distribution.json", text: $catalogURL)
                    .textFieldStyle(.roundedBorder)
                Text(L10n.text(ManagerSourcePolicy.notNotarizedNote))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack {
                    Button(L10n.text("Cancel"), role: .cancel) { showingCatalogURL = false }
                    Spacer()
                    Button(L10n.text("Set HTTPS catalog")) {
                        let url = catalogURL
                        showingCatalogURL = false
                        Task { await store.setCatalogURL(url) }
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(catalogURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(24)
            .frame(width: 480)
        }
        .confirmationDialog(L10n.text("Turn on local monitoring?"), isPresented: $confirmMonitoring) {
            Button(L10n.text("Turn On")) { Task { await store.setObservability(true) } }
            Button(L10n.text("Cancel"), role: .cancel) {}
        } message: {
            Text(L10n.text("A local check runs periodically and stores operational metadata on this Mac. It does not upload prompts or tool contents."))
        }
        .confirmationDialog(L10n.text("Uninstall Agent Host?"), isPresented: $confirmUninstall) {
            Button(L10n.text("Uninstall and Keep History"), role: .destructive) { Task { await store.uninstall() } }
            Button(L10n.text("Uninstall and Delete Agent Host Data"), role: .destructive) { Task { await store.uninstall(purgeData: true) } }
            Button(L10n.text("Cancel"), role: .cancel) {}
        } message: {
            Text(L10n.text("Agent integrations and background services created by Agent Host will be removed. Deleting Agent Host data also removes retained packages and recovery history."))
        }
    }

    private var currentToolSet: String {
        switch store.suite?.profile {
        case "featured": L10n.text("Featured tools")
        case "local-dogfood": L10n.text("Standard + Local tools")
        case "observability": L10n.text("Standard + Monitoring")
        default: L10n.text("Standard")
        }
    }

    private var applicationVersion: String {
        let application = store.source?.application
        let version = application?.version ?? L10n.text("Unknown")
        if let build = application?.build, !build.isEmpty {
            return "\(version) (\(build))"
        }
        return version
    }

    private var environmentVersion: String {
        store.source?.environment?.suiteVersion ?? store.suite?.suiteVersion ?? L10n.text("not installed")
    }

    private var componentVersions: String? {
        let items = store.source?.components ?? []
        guard !items.isEmpty else { return nil }
        return items.prefix(8).map { item in
            [item.displayName ?? item.id, item.version].compactMap { $0 }.joined(separator: " ")
        }.joined(separator: ", ")
    }

    private var sourceMessage: String {
        store.source?.source?.message ?? L10n.text(ManagerSourcePolicy.unpublishedNote)
    }

    private func lastCheckLabel(_ check: SourceCheck) -> String {
        [check.status, check.code].compactMap { $0 }.joined(separator: " · ")
    }
}
