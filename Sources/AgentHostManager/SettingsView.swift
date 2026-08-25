import SwiftUI

struct SettingsView: View {
    @ObservedObject var store: AgentHostStore
    @State private var confirmUninstall = false

    var body: some View {
        Form {
            Section("Maintenance") {
                Button("Return to previous version") { Task { await store.rollback() } }
                    .disabled(store.isBusy || store.suite?.configured != true)
            }
            Section("Remove") {
                Button("Uninstall Agent Host…", role: .destructive) { confirmUninstall = true }
                    .disabled(store.isBusy || store.suite?.configured != true)
                Text("Uninstall preserves local monitoring history unless it is removed separately.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding()
        .confirmationDialog("Uninstall Agent Host?", isPresented: $confirmUninstall) {
            Button("Uninstall", role: .destructive) { Task { await store.uninstall() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Agent integrations and background services created by the suite will be removed. Existing integrations are preserved.")
        }
    }
}
