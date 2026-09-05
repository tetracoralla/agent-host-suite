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
                    ForEach(Array(ManagerAgentApp.all.enumerated()), id: \.element.id) { index, app in
                        if index > 0 { Divider() }
                        AgentAppRow(
                            id: app.id,
                            name: app.name,
                            systemImage: app.systemImage,
                            status: store.hostStatuses[app.id],
                            verifiedHealth: store.verifiedAgentAppHealth(app.id),
                            isManaged: store.suite?.hosts?[app.id]?.installed == true,
                            isBusy: store.isBusy,
                            connect: { Task { await store.setHost(app.id, connected: true) } },
                            disconnect: { pendingRemoval = app.id }
                        )
                    }
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
                Text(L10n.text("Checking")).foregroundStyle(.secondary)
            } else if status?.error != nil {
                Text(L10n.text("Inspection unavailable")).foregroundStyle(.orange)
            } else if status?.appInstalled == false {
                Text(L10n.text("Not installed")).foregroundStyle(.secondary)
            } else if isManaged {
                Button(L10n.text("Disconnect"), action: disconnect)
                    .disabled(isBusy)
            } else {
                Button(L10n.text("Connect"), action: connect)
                    .buttonStyle(.borderedProminent)
                    .disabled(isBusy)
            }
        }
        .padding(.vertical, 4)
    }

    private var detail: String {
        if status == nil { return L10n.text("Checking this Mac") }
        if let message = status?.error?.message { return message }
        if status?.appInstalled == false { return L10n.format("Install {name} before connecting it", ["name": name]) }
        if isManaged && verifiedHealth == false { return L10n.text("Connected · needs attention") }
        if isManaged && verifiedHealth == true { return L10n.text("Connected · bindings verified") }
        if isManaged { return L10n.text("Connected · run Full Check to verify bindings") }
        return L10n.text("Detected on this Mac")
    }
}
