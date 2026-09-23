import AppKit
import SwiftUI

struct PageHeader<Trailing: View>: View {
    let title: String
    let subtitle: String?
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(L10n.text(title))
                    .font(.system(size: 25, weight: .semibold))
                if let subtitle {
                    Text(L10n.text(subtitle))
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 20)
            trailing
        }
    }
}

struct Panel<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            content
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 14))
    }
}

struct ItemStatePill: View {
    let state: ManagedItemState

    var body: some View {
        let value: (Color, String) = switch state {
        case .checking: (.secondary, "arrow.triangle.2.circlepath")
        case .ready: (.green, "checkmark.circle.fill")
        case .attention: (.orange, "exclamationmark.triangle.fill")
        case .unavailable: (.secondary, "circle.dashed")
        case .inactive: (.secondary, "shippingbox")
        }
        Label(L10n.text(state.label), systemImage: value.1)
            .font(.caption.weight(.medium))
            .foregroundStyle(value.0)
    }
}

struct BusyOverlay: View {
    let label: String

    var body: some View {
        VStack(spacing: 10) {
            ProgressView()
                .controlSize(.large)
            Text(L10n.text(label))
                .font(.callout.weight(.medium))
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .shadow(radius: 14, y: 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(L10n.text(label))
        .accessibilityAddTraits(.updatesFrequently)
    }
}

struct NoticeView: View {
    let title: String
    let message: String
    let systemImage: String
    let color: Color

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .foregroundStyle(color)
                .font(.title3)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(L10n.text(title)).font(.headline)
                if !message.isEmpty {
                    Text(L10n.text(message)).foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ToolLogoView: View {
    let logo: ToolLogo?
    let systemImage: String
    var toolID: String? = nil
    var bundledResource: String? = nil
    var size: CGFloat = 48

    var body: some View {
        Group {
            if let image = resolvedImage {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()

            } else if let file = fallbackResource, let url = bundledURL(named: file), let image = NSImage(contentsOf: url) {
                Image(nsImage: image)
                    .resizable().scaledToFit().padding(size * 0.23)
                    .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: size * 0.22))
            } else {
                Image(systemName: systemImage)
                    .resizable()
                    .scaledToFit()
                    .padding(size * 0.25)
                    .foregroundStyle(.secondary)
                    .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: size * 0.22))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var fallbackResource: String? {
        let names = ["data-transformer": "table", "file-vitals": "file-search",
                     "text-integrity": "text", "layout-contract-conformance": "layout-four",
                     "projective": "layout-four"]
        return toolID.flatMap { names[$0] }.map { "fallback-\($0).svg" }
    }

    private var resolvedImage: NSImage? {
        if let logo {
            if let dataURL = logo.dataUrl, let image = image(fromDataURL: dataURL) {
                return image
            }
            if let image = verifiedInstalledImage(logo) {
                return image
            }
        }
        if let bundledResource, let url = bundledURL(named: bundledResource), let image = NSImage(contentsOf: url) {
            return image
        }
        if let toolID, let url = bundledURL(forToolID: toolID), let image = NSImage(contentsOf: url) {
            return image
        }
        return nil
    }

    private func verifiedInstalledImage(_ logo: ToolLogo) -> NSImage? {
        let path = logo.absolutePath ?? (logo.path?.hasPrefix("/") == true ? logo.path : nil)
        guard let path, FileManager.default.fileExists(atPath: path) else { return nil }
        if let expected = logo.bytes {
            guard
                let attributes = try? FileManager.default.attributesOfItem(atPath: path),
                let number = attributes[.size] as? NSNumber,
                number.intValue == expected
            else { return nil }
        }
        return NSImage(contentsOfFile: path)
    }

    private func bundledURL(named name: String) -> URL? {
        bundledResourceURL(for: name)
    }

    private func bundledURL(forToolID id: String) -> URL? {
        for ext in ["svg", "png", "pdf"] {
            if let url = bundledResourceURL(for: "\(id).\(ext)") { return url }
        }
        return nil
    }

    /// Bundled marks must resolve in three layouts without the generated
    /// `Bundle.module` accessor, whose absolute-build-path fallback crashes a
    /// packaged app copied to another machine: the SwiftPM build tree (beside
    /// the executable, flattened by `.process`), a packaged .app
    /// (Contents/Resources/ToolLogos), and the suite's Sources copy.
    private func bundledResourceURL(for fileName: String) -> URL? {
        for root in bundledResourceRoots {
            for path in ["ToolLogos/\(fileName)", fileName] {
                let url = root.appendingPathComponent(path)
                if FileManager.default.fileExists(atPath: url.path) { return url }
            }
        }
        return nil
    }

    private var bundledResourceRoots: [URL] {
        var roots: [URL] = []
        if let resources = Bundle.main.resourceURL { roots.append(resources) }
        let executableDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
        roots.append(contentsOf: [
            Bundle.main.bundleURL,
            executableDir,
            executableDir.appendingPathComponent("AgentHostManager_AgentHostManager.bundle"),
        ])
        return roots
    }

    private func image(fromDataURL value: String) -> NSImage? {
        guard let comma = value.firstIndex(of: ",") else { return nil }
        let metadata = value[..<comma]
        let payload = String(value[value.index(after: comma)...])
        let data: Data?
        if metadata.contains(";base64") {
            data = Data(base64Encoded: payload)
        } else {
            data = payload.removingPercentEncoding?.data(using: .utf8)
        }
        return data.flatMap(NSImage.init(data:))
    }
}

/// Data sections use alignment and spacing; only interactive or exceptional
/// surfaces need a filled container.
struct DataSection<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 16) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
    }
}
