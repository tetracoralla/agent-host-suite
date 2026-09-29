import SwiftUI

/// Account records are reusable credential references. The Manager never
/// asks for or displays the secret itself: the credential stays in the
/// macOS Keychain item the owner created, and every connected account user
/// resolves the same record by id.
struct AccountsView: View {
    @ObservedObject var store: AgentHostStore
    @State private var showingAddAccount = false
    @State private var accountPendingRemoval: AccountRecord?
    @State private var draftName = ""
    @State private var draftService = "openadam.github-readonly"
    @State private var draftAccountName = ""

    var body: some View {
        Group {
            if store.suite?.configured == true {
                content
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "person.crop.circle")
                        .font(.system(size: 28))
                        .foregroundStyle(.secondary)
                    Text(L10n.text("No Agent environment is installed"))
                        .font(.headline)
                    Text(L10n.text("Accounts are recorded in the installed Agent environment."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private var content: some View {
        List {
            if store.accounts.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L10n.text("No accounts connected"))
                        .font(.headline)
                    Text(L10n.text("Connect an account once so authorized Procedures can reuse it. The credential itself stays in your Keychain; Agent Host only records the reference."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
            }
            ForEach(store.accounts) { account in
                AccountRow(account: account, busy: store.isBusy) {
                    Task { await store.checkAccount(id: account.id) }
                } onRemove: {
                    accountPendingRemoval = account
                }
            }
        }
        .overlay(alignment: .bottom) {
            if store.isBusy { ProgressView(store.currentAction ?? L10n.text("Working")).padding(8) }
        }
        .toolbar {
            Button {
                draftName = ""
                draftAccountName = ""
                showingAddAccount = true
            } label: {
                Label(L10n.text("Connect Account"), systemImage: "plus")
            }
            .disabled(store.isBusy)
        }
        .navigationTitle(L10n.text("Accounts"))
        .sheet(isPresented: $showingAddAccount) {
            addAccountSheet
        }
        .confirmationDialog(
            L10n.format("Remove account {name}?", ["name": accountPendingRemoval?.name ?? ""]),
            isPresented: Binding(
                get: { accountPendingRemoval != nil },
                set: { if !$0 { accountPendingRemoval = nil } }
            )
        ) {
            Button(L10n.text("Remove Record"), role: .destructive) {
                if let account = accountPendingRemoval {
                    Task { await store.removeAccount(id: account.id) }
                }
                accountPendingRemoval = nil
            }
            Button(L10n.text("Cancel"), role: .cancel) { accountPendingRemoval = nil }
        } message: {
            Text(L10n.text("This removes the Agent Host record. The Keychain item and its credential are yours and are never deleted by Agent Host."))
        }
    }

    private var addAccountSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n.text("Connect Account"))
                .font(.headline)
            Form {
                TextField(L10n.text("Account name (for example GitHub Personal)"), text: $draftName)
                TextField(L10n.text("Keychain item name (service)"), text: $draftService)
                TextField(L10n.text("Keychain account name"), text: $draftAccountName)
            }
            Text(L10n.text("Create the Keychain item first with your credential. Agent Host records only these reference names — it never asks for the token, and it never stores the secret."))
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                Button(L10n.text("Cancel"), role: .cancel) { showingAddAccount = false }
                Spacer()
                Button(L10n.text("Record Account")) {
                    let name = draftName
                    let service = draftService
                    let keychainAccount = draftAccountName
                    showingAddAccount = false
                    Task { await store.addAccount(name: name, keychainService: service, keychainAccount: keychainAccount) }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!draftComplete)
            }
        }
        .padding(24)
        .frame(width: 520)
    }

    private var draftComplete: Bool {
        ![draftName, draftService, draftAccountName].map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) }).contains(where: \.isEmpty)
    }
}

private struct AccountRow: View {
    let account: AccountRecord
    let busy: Bool
    let onCheck: () -> Void
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(account.name)
                    .font(.body.weight(.semibold))
                Text(account.provider)
                    .font(.caption2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
                Spacer()
                healthBadge
            }
            LabeledContent(L10n.text("Endpoint"), value: account.endpoint)
                .font(.caption)
            LabeledContent(L10n.text("Keychain item"), value: "\(account.credential.service) · \(account.credential.account)")
                .font(.caption)
            if let health = account.lastHealth {
                LabeledContent(L10n.text("Last check"), value: healthLabel(health))
                    .font(.caption)
            }
            HStack {
                Button(L10n.text("Check Access")) { onCheck() }
                    .disabled(busy)
                Button(L10n.text("Remove…"), role: .destructive) { onRemove() }
                    .disabled(busy)
            }
            .controlSize(.small)
        }
        .padding(.vertical, 4)
    }

    private var healthBadge: some View {
        let (label, color): (String, Color) = {
            switch account.lastHealth?.status {
            case "healthy": return (L10n.text("Healthy"), .green)
            case "unauthorized": return (L10n.text("Credential rejected"), .orange)
            case "credential-missing": return (L10n.text("Keychain item missing"), .orange)
            case "unreachable": return (L10n.text("Endpoint unreachable"), .red)
            default: return (L10n.text("Not checked"), .secondary)
            }
        }()
        return Text(label)
            .font(.caption.weight(.medium))
            .foregroundStyle(color)
    }

    private func healthLabel(_ health: AccountRecord.Health) -> String {
        [health.status, health.detail].compactMap { $0 }.joined(separator: " · ")
    }
}
