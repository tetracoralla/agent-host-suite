import SwiftUI

@main
struct AgentHostManagerApp: App {
    @StateObject private var store = AgentHostStore()

    var body: some Scene {
        WindowGroup("Agent Host") {
            ContentView(store: store)
                .frame(minWidth: 620, minHeight: 560)
                .task { await store.refresh() }
        }
        .defaultSize(width: 680, height: 680)
        .windowResizability(.contentMinSize)

        Settings {
            SettingsView(store: store)
                .frame(width: 480, height: 260)
        }
    }
}
