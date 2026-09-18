import AppKit
import SwiftUI

struct UpdatesView: View {
    @ObservedObject var store: AgentHostStore
    @State private var githubURL = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Updates", subtitle: L10n.text("profiles fetch --carrier downloads an installer. It does not replace Agent Host.")) {
                    Button(L10n.text("Check for updates")) { Task { await store.checkUpdates() } }
                        .disabled(store.isBusy)
                }

                Panel {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(L10n.text("Versions")).font(.headline)
                        if let items = store.updates?.items, !items.isEmpty {
                            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                                if index > 0 { Divider() }
                                UpdateItemRow(
                                    item: item,
                                    isBusy: store.isBusy,
                                    install: { Task { await store.installUpdate(id: item.id) } }
                                )
                            }
                            if items.contains(where: { $0.kind == "tool" && $0.availability == "update-available" }) {
                                Button(L10n.text("Install all updates")) { Task { await store.installAllUpdates() } }
                                    .disabled(store.isBusy)
                            }
                        } else {
                            Text(L10n.text("Check for updates to load current and available versions."))
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Panel {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(L10n.text("Add GitHub project")).font(.headline)
                        Text(L10n.text("Paste a GitHub repository or Release URL. Preview uses project metadata; the package is downloaded only when you add it."))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        TextField("https://github.com/owner/repo", text: $githubURL)
                            .textFieldStyle(.roundedBorder)
                        HStack {
                            Button(L10n.text("Preview GitHub project")) {
                                let url = githubURL
                                Task { await store.previewGitHubTool(url) }
                            }
                            .disabled(store.isBusy || githubURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            Button(L10n.text("Add from GitHub")) {
                                let url = githubURL
                                githubURL = ""
                                Task { await store.addGitHubTool(url) }
                            }
                            .disabled(store.isBusy || githubURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                        if let preview = store.githubPreview {
                            GitHubPreviewBlock(preview: preview)
                        }
                    }
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(32)
        }
    }
}

private struct UpdateItemRow: View {
    let item: UpdateItem
    let isBusy: Bool
    let install: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            ToolLogoView(logo: item.logo, systemImage: "shippingbox.fill")
            VStack(alignment: .leading, spacing: 4) {
                Text(item.displayName ?? item.id).font(.headline)
                Text(versionLine)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                if let note = item.note ?? item.upgrade {
                    Text(L10n.text(note)).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 20)
            VStack(alignment: .trailing, spacing: 8) {
                Text(L10n.text(availabilityLabel))
                    .font(.caption)
                    .foregroundStyle(item.availability == "update-available" ? Color.orange : Color.secondary)
                if item.availability == "update-available" {
                    Button(L10n.text("Install update"), action: install)
                        .disabled(isBusy)
                }
            }
        }
        .padding(.vertical, 3)
    }

    private var versionLine: String {
        let installed = item.installedVersion ?? L10n.text("not installed")
        if let available = item.availableVersion, available != item.installedVersion {
            return "\(installed) → \(available)"
        }
        return installed
    }

    private var availabilityLabel: String {
        switch item.availability {
        case "update-available": "update available"
        case "current": "current"
        case "not-installed": "not installed"
        case "no-platform-asset": "No asset for this platform"
        case "check-failed": "check failed"
        case "compatible-after-host-update": "compatible after Host update"
        case "installed-official-upgrade": "official upgrade"
        default: item.availability ?? "—"
        }
    }
}

private struct GitHubPreviewBlock: View {
    let preview: GitHubProjectPreview

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ToolLogoView(logo: preview.presentation?.logo, systemImage: "shippingbox")
            VStack(alignment: .leading, spacing: 4) {
                Text(preview.presentation?.displayName ?? preview.origin?.repository ?? "")
                    .font(.headline)
                if let summary = preview.presentation?.summary {
                    Text(summary).foregroundStyle(.secondary)
                }
                Text([preview.origin?.tag, preview.compatibility?.available == true ? L10n.text("This platform") : L10n.text("No asset for this platform")].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if preview.downloadedPackage == true {
                    Text(L10n.text("Preview does not download the plugin archive."))
                        .font(.caption)
                }
            }
        }
        .padding(.top, 8)
    }
}

struct ToolLogoView: View {
    let logo: ToolLogo?
    let systemImage: String

    var body: some View {
        if let dataUrl = logo?.dataUrl, let url = URL(string: dataUrl) {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Image(systemName: systemImage)
            }
            .frame(width: 28, height: 28)
            .clipShape(RoundedRectangle(cornerRadius: 6))
        } else if let nsImage = verifiedInstalledImage {
            Image(nsImage: nsImage)
                .resizable()
                .scaledToFill()
                .frame(width: 28, height: 28)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        } else {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(.blue)
                .frame(width: 28, height: 28)
        }
    }

    private var verifiedInstalledImage: NSImage? {
        guard let logo else { return nil }
        let path = logo.absolutePath ?? (logo.path?.hasPrefix("/") == true ? logo.path : nil)
        guard let path, FileManager.default.fileExists(atPath: path) else { return nil }
        if let expected = logo.bytes {
            let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? -1
            if size != expected { return nil }
        }
        return NSImage(contentsOfFile: path)
    }
}
