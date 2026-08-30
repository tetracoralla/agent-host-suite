import SwiftUI

struct SettingsView: View {
    @ObservedObject var store: AgentHostStore
    @State private var confirmMonitoring = false
    @State private var confirmUninstall = false

    var body: some View {
        Form {
            Section("Monitoring") {
                Toggle("Local tool monitoring", isOn: Binding(
                    get: { store.observations?.enabled == true },
                    set: { enabled in
                        if enabled { confirmMonitoring = true }
                        else { Task { await store.setObservability(false) } }
                    }
                ))
                .disabled(store.isBusy || store.suite?.configured != true || store.suite?.profile == "local-dogfood")

                Text("Stores counts and timings locally. Prompts, tool arguments, and tool results are not stored or uploaded.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if store.suite?.profile == "local-dogfood" {
                    Text("Switch to Standard + Monitoring before turning monitoring off.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Tool Set") {
                LabeledContent("Current", value: currentToolSet)
                if store.suite?.profile == "local-dogfood" {
                    Button("Review Standard + Monitoring…") { Task { await store.prepareUpdate(profile: "observability") } }
                } else {
                    Button("Review Local Tool Set…") { Task { await store.prepareUpdate(profile: "local-dogfood") } }
                        .disabled(store.observations?.enabled != true)
                    if store.observations?.enabled != true {
                        Text("Turn on local monitoring first so this expanded local tool set can measure reliability and usage on this Mac.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section("Recovery") {
                Button("Review Previous Version…") { Task { await store.prepareRollback() } }
                    .disabled(store.isBusy || store.suite?.configured != true)
            }

            Section("Remove") {
                Button("Uninstall Agent Host…", role: .destructive) { confirmUninstall = true }
                    .disabled(store.isBusy || store.suite?.configured != true)
                Text("You can preserve recovery history or remove Agent Host packages, monitoring data, and retained recovery data. Existing user-owned integrations are never removed.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
        .confirmationDialog("Turn on local monitoring?", isPresented: $confirmMonitoring) {
            Button("Turn On") { Task { await store.setObservability(true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A local check runs periodically and stores operational metadata on this Mac. It does not upload prompts or tool contents.")
        }
        .confirmationDialog("Uninstall Agent Host?", isPresented: $confirmUninstall) {
            Button("Uninstall and Keep History", role: .destructive) { Task { await store.uninstall() } }
            Button("Uninstall and Delete Agent Host Data", role: .destructive) { Task { await store.uninstall(purgeData: true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Agent integrations and background services created by Agent Host will be removed. Deleting Agent Host data also removes retained packages and recovery history.")
        }
    }

    private var currentToolSet: String {
        switch store.suite?.profile {
        case "local-dogfood": "Standard + Local tools"
        case "observability": "Standard + Monitoring"
        default: "Standard"
        }
    }
}
