import AppKit
import SwiftUI

struct AgentAppsView: View {
    @ObservedObject var store: AgentHostStore
    @State private var pendingRemoval: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Agents", subtitle: nil) {
                    HStack(spacing: 10) {
                        Button {
                            Task { await store.redetectAgentApps() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .help(L10n.text("Detect Agent apps again"))
                        .disabled(store.isBusy)

                        if store.suite?.configured == true {
                            Button(L10n.text("Check")) {
                                Task { await store.runDoctor() }
                            }
                            .disabled(store.isBusy)
                        }
                    }
                }

                if let handoff = store.exampleTaskHandoff {
                    NoticeView(
                        title: "Task copied",
                        message: handoff,
                        systemImage: "doc.on.clipboard.fill",
                        color: .blue
                    )
                }

                if store.suite?.configured == true {
                    startWorkHandoff
                }

                VStack(spacing: 0) {
                    ForEach(ManagerAgentApp.all) { app in
                        AgentAppRow(
                            app: app,
                            icon: store.agentAppIcon(app.id),
                            status: store.hostStatuses[app.id],
                            verifiedHealth: store.verifiedAgentAppHealth(app.id),
                            isManaged: store.suite?.hosts?[app.id]?.installed == true,
                            hostConfigured: store.suite?.configured == true,
                            isBusy: store.isBusy,
                            connect: {
                                Task { await store.setHost(app.id, connected: true) }
                            },
                            setup: {
                                store.selectedSetupHost = app.id
                                store.selectedSetupProfile = ManagerSetupPolicy.defaultProfile
                                Task { await store.prepareSetup() }
                            },
                            open: { store.openConnectedAgentApp(hostID: app.id) },
                            repair: { Task { await store.prepareRepair() } },
                            copyError: { copyErrorReport(app: app, status: store.hostStatuses[app.id]) },
                            disconnect: { pendingRemoval = app.id }
                        )
                    }
                }
            }
            .frame(maxWidth: 860, alignment: .leading)
            .padding(32)
        }
        .confirmationDialog(L10n.text("Disconnect this Agent app?"), isPresented: Binding(
            get: { pendingRemoval != nil },
            set: { if !$0 { pendingRemoval = nil } }
        )) {
            Button(L10n.text("Disconnect"), role: .destructive) {
                guard let target = pendingRemoval else { return }
                pendingRemoval = nil
                Task { await store.setHost(target, connected: false) }
            }
            Button(L10n.text("Cancel"), role: .cancel) { pendingRemoval = nil }
        } message: {
            Text(L10n.text("Agent Host removes only integrations it created. Existing user-owned integrations are preserved."))
        }
    }


    /// Aggregate start-work state. Shown only when something blocks new work;
    /// a plain missing connection is already visible in the app cards below.
    @ViewBuilder private var startWorkHandoff: some View {
        let guidance = store.postSetupGuidance
        if !guidance.readyToWork, guidance.problemClass?.rawValue != "not-connected" {
            Panel {
                HStack(alignment: .center, spacing: 16) {
                    HStack(spacing: 10) {
                        Image(systemName: statusSymbol(guidance.statusTone))
                            .font(.title2)
                            .foregroundStyle(statusColor(guidance.statusTone))
                        Text(L10n.text(guidance.statusLine))
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(statusColor(guidance.statusTone))
                    }
                    Spacer(minLength: 8)
                    Button(L10n.text(guidance.primaryActionLabel)) {
                        store.performPostSetupPrimaryAction()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(store.isBusy)
                    .accessibilityIdentifier("post-setup-primary-cta")
                }

                if let hint = guidance.hint {
                    Text(L10n.text(hint))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 6) {
                        if let problemClass = guidance.problemClass {
                            Text(L10n.text(problemClass.rawValue))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(guidance.observed, id: \.self) { line in
                            Text("• \(L10n.text(line))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(guidance.gaps, id: \.self) { line in
                            Text("• \(L10n.text(line))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if !guidance.recoveryPath.isEmpty {
                            Text(L10n.text(guidance.recoveryPath))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.top, 4)
                } label: {
                    Text(L10n.text("Details"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("post-setup-handoff")
        }
    }

    private func statusSymbol(_ tone: ManagerPostSetupGuidance.StatusTone) -> String {
        switch tone {
        case .ready: "arrow.forward.circle.fill"
        case .paused: "pause.circle.fill"
        case .fault: "exclamationmark.triangle.fill"
        case .action: "link.circle.fill"
        }
    }

    private func statusColor(_ tone: ManagerPostSetupGuidance.StatusTone) -> Color {
        switch tone {
        case .ready: .blue
        case .paused: .orange
        case .fault: .red
        case .action: .primary
        }
    }

    private func copyErrorReport(app: ManagerAgentApp, status: HostStatusResult?) {
        let error = status?.error
        let report = """
        Agent Host connection report
        Agent: \(app.name)
        Code: \(error?.code ?? "UNKNOWN")
        Message: \(error?.message ?? "Inspection unavailable")
        """
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(report, forType: .string)
    }
}

private struct AgentAppRow: View {
    let app: ManagerAgentApp
    let icon: NSImage?
    let status: HostStatusResult?
    let verifiedHealth: Bool?
    let isManaged: Bool
    let hostConfigured: Bool
    let isBusy: Bool
    let connect: () -> Void
    let setup: () -> Void
    let open: () -> Void
    let repair: () -> Void
    let copyError: () -> Void
    let disconnect: () -> Void

    var body: some View {
        HStack(spacing: 16) {
            appIcon
            VStack(alignment: .leading, spacing: 5) {
                Text(app.name).font(.headline)
                if status?.appInstalled != true || status?.error != nil || effectiveHealth == false {
                    Text(L10n.text(state.label)).font(.caption).foregroundStyle(state.color)
                } else if let version = status?.version, !version.isEmpty {
                    Text(version).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 12)
            Image(systemName: state.symbol)
                .font(.system(size: 13)).foregroundStyle(state.color)
                .help(L10n.text(state.label)).accessibilityLabel(L10n.text(state.label))
                .frame(width: 22)
            HStack(spacing: 10) { actions }.frame(minWidth: 90, alignment: .trailing)
        }
        .padding(.vertical, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { Rectangle().fill(.separator.opacity(0.6)).frame(height: 0.5) }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var appIcon: some View {
        if let icon {
            Image(nsImage: icon)
                .resizable()
                .scaledToFit()
                .frame(width: 42, height: 42)
        } else {
            Image(systemName: app.systemImage)
                .font(.title2)
                .foregroundStyle(.secondary)
                .frame(width: 42, height: 42)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 13))
        }
    }

    @ViewBuilder private var actions: some View {
        if status == nil {
            ProgressView().controlSize(.small)
        } else if status?.error != nil {
            Button(L10n.text("Copy error report"), action: copyError)
                .controlSize(.small)
            if hostConfigured {
                Button(L10n.text("Repair"), action: repair)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(isBusy)
            }
        } else if status?.appInstalled != true {
            EmptyView()
        } else if isManaged {
            if effectiveHealth == false {
                Button(L10n.text("Repair"), action: repair)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(isBusy)
            } else {
                Button(L10n.text("Open"), action: open)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(isBusy)
            }
            Menu {
                Button(L10n.text("Open"), action: open)
                Button(L10n.text("Disconnect"), role: .destructive, action: disconnect)
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuStyle(.borderlessButton)
            .frame(width: 22)
            .disabled(isBusy)
        } else if hostConfigured {
            Button(L10n.text("Connect"), action: connect)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(isBusy)
        } else {
            Button(L10n.text("Set up"), action: setup)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(isBusy)
        }
    }

    private var effectiveHealth: Bool? {
        verifiedHealth ?? status?.healthy
    }

    private var state: (label: String, symbol: String, color: Color) {
        if status == nil {
            return ("Checking", "circle.dashed", .secondary)
        }
        if status?.error != nil {
            return ("Inspection unavailable", "exclamationmark.triangle.fill", .orange)
        }
        guard status?.appInstalled == true else {
            return ("Not installed", "circle", .secondary)
        }
        guard isManaged else {
            return ("Installed on this Mac", "circle", .secondary)
        }
        if effectiveHealth == false {
            return ("Needs repair", "exclamationmark.triangle.fill", .orange)
        }
        if effectiveHealth == true {
            return ("Connected", "checkmark", .secondary)
        }
        return ("Connected, not checked", "link", .secondary)
    }
}
