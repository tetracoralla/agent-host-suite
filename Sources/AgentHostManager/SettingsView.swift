import SwiftUI

struct SettingsView: View {
    @ObservedObject var store: AgentHostStore
    @State private var confirmMonitoring = false
    @State private var confirmUninstall = false
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

            Section(L10n.text("Monitoring")) {
                Toggle(L10n.text("Local tool monitoring"), isOn: Binding(
                    get: { store.observations?.enabled == true },
                    set: { enabled in
                        if enabled { confirmMonitoring = true }
                        else { Task { await store.setObservability(false) } }
                    }
                ))
                .disabled(store.isBusy || store.suite?.configured != true || store.suite?.profile == "local-dogfood")

                Text(L10n.text("Stores counts and timings locally. Prompts, tool arguments, and tool results are not stored or uploaded."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if store.suite?.profile == "local-dogfood" {
                    Text(L10n.text("Switch to Standard + Monitoring before turning monitoring off."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section(L10n.text("Tool Set")) {
                LabeledContent(L10n.text("Current"), value: currentToolSet)
                if store.suite?.profile == "local-dogfood" {
                    Button(L10n.text("Review Standard + Monitoring…")) { Task { await store.prepareUpdate(profile: "observability") } }
                } else {
                    Button(L10n.text("Review Local Tool Set…")) { Task { await store.prepareUpdate(profile: "local-dogfood") } }
                        .disabled(store.observations?.enabled != true)
                    if store.observations?.enabled != true {
                        Text(L10n.text("Turn on local monitoring first so this expanded local tool set can measure reliability and usage on this Mac."))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
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
        case "local-dogfood": L10n.text("Standard + Local tools")
        case "observability": L10n.text("Standard + Monitoring")
        default: L10n.text("Standard")
        }
    }
}
