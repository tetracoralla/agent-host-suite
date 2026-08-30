import SwiftUI

@main
struct AgentHostManagerApp: App {
    @StateObject private var store = AgentHostStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup("Agent Host") {
            ContentView(store: store)
                .frame(minWidth: 760, minHeight: 580)
                .task { await store.refreshIfNeeded() }
                .onChange(of: scenePhase) { _, phase in
                    guard phase == .active else { return }
                    Task { await store.refreshIfNeeded() }
                }
        }
        .defaultSize(width: 940, height: 700)
        .windowResizability(.contentMinSize)
        .commands {
            CommandMenu("Environment") {
                Button("Run Full Check") { Task { await store.runDoctor() } }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                    .disabled(store.isBusy || store.suite?.configured != true)
                Button(store.health.needsRepair ? "Review Repair" : "Review Update") { Task { await store.prepareUpdate() } }
                    .keyboardShortcut("u", modifiers: [.command, .shift])
                    .disabled(store.isBusy || store.suite?.configured != true)
            }
        }

        Settings {
            SettingsView(store: store)
                .frame(width: 520, height: 440)
        }
    }
}

private extension ManagerHealth {
    var needsRepair: Bool {
        if case .attention = self { return true }
        return false
    }
}
