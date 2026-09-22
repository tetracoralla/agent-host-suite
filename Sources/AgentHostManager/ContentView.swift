import SwiftUI

struct ContentView: View {
    @ObservedObject var store: AgentHostStore
    @SceneStorage("managerSection") private var selection: ManagerSection = .tools

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 160, ideal: 176, max: 220)
        } detail: {
            detail
        }
        .toolbar {
            ToolbarItem {
                SettingsLink {
                    Label(L10n.text("Settings"), systemImage: "gearshape")
                }
            }
        }
        .alert("Agent Host", isPresented: Binding(
            get: { store.errorMessage != nil },
            set: { if !$0 { store.dismissError() } }
        )) {
            if store.recovery == .replaceHostConflicts {
                Button(L10n.text("Replace Conflicting Installation"), role: .destructive) {
                    Task { await store.replaceConflictingInstallations() }
                }
            }
            if case .replaceHostConnection = store.recovery {
                Button(L10n.text("Replace Conflicting Connection"), role: .destructive) {
                    Task { await store.replaceConflictingHostConnection() }
                }
            }
            Button(L10n.text("OK"), role: .cancel) { store.dismissError() }
        } message: {
            Text(L10n.text(store.errorMessage ?? ""))
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
        .onAppear {
            // Older builds persisted Overview as the initial destination even
            // though it is no longer part of the primary navigation.
            if selection == .overview { selection = .tools }
        }
        .onChange(of: store.requestedSection) { _, section in
            guard let section else { return }
            selection = section
            store.requestedSection = nil
        }
    }

    private var sidebar: some View {
        List(selection: $selection) {
            ForEach(ManagerSection.primaryCases) { section in
                Label(L10n.text(section.title), systemImage: section.systemImage)
                    .tag(section)
            }
            if store.suite?.configured == true {
                Section(L10n.text("Activity")) {
                    Label(L10n.text(ManagerSection.activity.title), systemImage: ManagerSection.activity.systemImage)
                        .tag(ManagerSection.activity)
                    Label(L10n.text(ManagerSection.usage.title), systemImage: ManagerSection.usage.systemImage)
                        .tag(ManagerSection.usage)
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Agent Host")
        .safeAreaInset(edge: .bottom) {
            if let summary = versionSummary {
                Text(summary)
                    .font(.caption)
                    .monospacedDigit()
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .accessibilityLabel(summary)
            }
        }
    }

    private var versionSummary: String? {
        let application = store.source?.application
        let environment = store.source?.environment?.suiteVersion ?? store.suite?.suiteVersion
        if application?.version == nil && environment == nil { return nil }
        return ManagerSourcePolicy.versionSummary(
            applicationVersion: application?.version,
            applicationBuild: application?.build,
            environmentVersion: environment
        )
    }

    @ViewBuilder private var detail: some View {
        switch selection {
        case .overview: ToolsView(store: store)
        case .tools: ToolsView(store: store)
        case .updates: ToolLibraryView(store: store)
        case .agentApps: AgentAppsView(store: store)
        case .usage:
            if store.suite?.configured == true { UsageReliabilityView(store: store) }
            else { ToolsView(store: store) }
        case .activity:
            if store.suite?.configured == true { ActivityView(store: store) }
            else { ToolsView(store: store) }
        }
    }
}
