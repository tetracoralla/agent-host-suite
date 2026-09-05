import SwiftUI

@main
struct AgentHostManagerApp: App {
    @StateObject private var store = AgentHostStore()
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(ManagerLanguage.storageKey) private var language = ManagerLanguage.system.rawValue

    private var selectedLanguage: ManagerLanguage {
        ManagerLanguage(rawValue: language) ?? .system
    }

    var body: some Scene {
        WindowGroup("Agent Host") {
            ContentView(store: store)
                .environment(\.locale, selectedLanguage.locale)
                .id(selectedLanguage.id)
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
            CommandMenu(L10n.text("Environment")) {
                Button(L10n.text("Run Full Check")) { Task { await store.runDoctor() } }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                    .disabled(store.isBusy || store.suite?.configured != true)
                Button(L10n.text(store.health.needsRepair ? "Review Repair" : "Review Update")) { Task { await store.prepareUpdate() } }
                    .keyboardShortcut("u", modifiers: [.command, .shift])
                    .disabled(store.isBusy || store.suite?.configured != true)
            }
        }

        Settings {
            SettingsView(store: store)
                .environment(\.locale, selectedLanguage.locale)
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
