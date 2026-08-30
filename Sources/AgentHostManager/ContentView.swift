import SwiftUI

struct ContentView: View {
    @ObservedObject var store: AgentHostStore
    @SceneStorage("managerSection") private var selection: ManagerSection = .overview

    var body: some View {
        NavigationSplitView {
            sidebar
        } detail: {
            detail
        }
        .toolbar {
            ToolbarItemGroup {
                if store.suite?.configured == true {
                    Button { Task { await store.runDoctor() } } label: {
                        Label("Check", systemImage: "stethoscope")
                    }
                    .help("Run a full environment check")
                    .disabled(store.isBusy)

                    Button { Task { await store.prepareUpdate() } } label: {
                        Label(store.health.needsRepair ? "Repair" : "Update", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .help(store.health.needsRepair ? "Repair the installed environment" : "Check for compatible updates")
                    .disabled(store.isBusy)
                }

                SettingsLink {
                    Label("Settings", systemImage: "gearshape")
                }
            }
        }
        .alert("Agent Host", isPresented: Binding(
            get: { store.errorMessage != nil },
            set: { if !$0 { store.dismissError() } }
        )) {
            if store.recovery == .replaceHostConflicts {
                Button("Replace Conflicting Installation", role: .destructive) {
                    Task { await store.replaceConflictingInstallations() }
                }
            }
            Button("OK", role: .cancel) { store.dismissError() }
        } message: {
            Text(store.errorMessage ?? "")
        }
        .sheet(isPresented: $store.isPresentingSetupPlan) {
            if let plan = store.setupPlan {
                SetupPlanView(plan: plan, store: store)
            }
        }
        .sheet(isPresented: $store.isPresentingEnvironmentChangePlan) {
            if let plan = store.environmentChangePlan {
                EnvironmentChangePlanView(plan: plan, store: store)
            }
        }
        .overlay {
            if store.isBlockingWork {
                BusyOverlay(label: store.currentAction ?? "Working")
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var sidebar: some View {
        List(selection: $selection) {
            ForEach(store.suite?.configured == true ? ManagerSection.allCases : [.overview]) { section in
                Label(section.title, systemImage: section.systemImage)
                    .tag(section)
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Agent Host")
        .safeAreaInset(edge: .bottom) {
            if let version = store.suite?.suiteVersion {
                Text(version)
                    .font(.caption)
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .accessibilityLabel("Version \(version)")
            }
        }
    }

    @ViewBuilder private var detail: some View {
        if store.suite?.configured == true {
            switch selection {
            case .overview: EnvironmentView(store: store)
            case .tools: ToolsView(store: store)
            case .agentApps: AgentAppsView(store: store)
            case .activity: ActivityView(store: store)
            }
        } else {
            SetupView(store: store)
        }
    }
}

private extension ManagerHealth {
    var needsRepair: Bool {
        if case .attention = self { return true }
        return false
    }
}
