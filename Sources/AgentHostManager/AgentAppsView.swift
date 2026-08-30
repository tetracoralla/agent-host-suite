import SwiftUI

struct AgentAppsView: View {
    @ObservedObject var store: AgentHostStore
    @State private var pendingRemoval: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Agent Apps", subtitle: "Where your tools are available") {
                    EmptyView()
                }

                Panel {
                    AgentAppRow(
                        id: "codex",
                        name: "Codex",
                        systemImage: "bubble.left.and.bubble.right.fill",
                        status: store.hostStatuses["codex"],
                        verifiedHealth: store.verifiedAgentAppHealth("codex"),
                        isManaged: store.suite?.hosts?["codex"]?.installed == true,
                        isBusy: store.isBusy,
                        connect: { Task { await store.setHost("codex", connected: true) } },
                        disconnect: { pendingRemoval = "codex" }
                    )
                    Divider()
                    AgentAppRow(
                        id: "claude",
                        name: "Claude Code",
                        systemImage: "terminal.fill",
                        status: store.hostStatuses["claude"],
                        verifiedHealth: store.verifiedAgentAppHealth("claude"),
                        isManaged: store.suite?.hosts?["claude"]?.installed == true,
                        isBusy: store.isBusy,
                        connect: { Task { await store.setHost("claude", connected: true) } },
                        disconnect: { pendingRemoval = "claude" }
                    )
                }

                NoticeView(
                    title: "Start a fresh task after changes",
                    message: "Agent apps load installed tool catalogs when a new task starts.",
                    systemImage: "arrow.clockwise.circle",
                    color: .blue
                )
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(32)
        }
        .confirmationDialog("Disconnect this Agent app?", isPresented: Binding(
            get: { pendingRemoval != nil },
            set: { if !$0 { pendingRemoval = nil } }
        )) {
            Button("Disconnect", role: .destructive) {
                guard let target = pendingRemoval else { return }
                pendingRemoval = nil
                Task { await store.setHost(target, connected: false) }
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        } message: {
            Text("Agent Host removes only integrations it created. Existing user-owned integrations are preserved.")
        }
    }
}

private struct AgentAppRow: View {
    let id: String
    let name: String
    let systemImage: String
    let status: HostStatusResult?
    let verifiedHealth: Bool?
    let isManaged: Bool
    let isBusy: Bool
    let connect: () -> Void
    let disconnect: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(.blue)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(name).font(.headline)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if status == nil {
                Text("Checking").foregroundStyle(.secondary)
            } else if status?.error != nil {
                Text("Inspection unavailable").foregroundStyle(.orange)
            } else if status?.appInstalled == false {
                Text("Not installed").foregroundStyle(.secondary)
            } else if isManaged {
                Button("Disconnect", action: disconnect)
                    .disabled(isBusy)
            } else {
                Button("Connect", action: connect)
                    .buttonStyle(.borderedProminent)
                    .disabled(isBusy)
            }
        }
        .padding(.vertical, 4)
    }

    private var detail: String {
        if status == nil { return "Checking this Mac" }
        if let message = status?.error?.message { return message }
        if status?.appInstalled == false { return "Install \(name) before connecting it" }
        if isManaged && verifiedHealth == false { return "Connected · needs attention" }
        if isManaged && verifiedHealth == true { return "Connected · bindings verified" }
        if isManaged { return "Connected · run Full Check to verify bindings" }
        return "Detected on this Mac"
    }
}
