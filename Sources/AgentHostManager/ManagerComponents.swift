import SwiftUI

struct PageHeader<Trailing: View>: View {
    let title: String
    let subtitle: String?
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(L10n.text(title))
                    .font(.largeTitle.weight(.semibold))
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

enum CapabilityExperienceState: Equatable {
    case preview
    case installed
    case missing
    case paused
}

struct CapabilityExperienceCard: View {
    let tool: ManagerSetupTool
    let state: CapabilityExperienceState
    var action: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .center, spacing: 18) {
            visual

            VStack(alignment: .leading, spacing: 6) {
                Text(L10n.text(tool.name))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(L10n.text(tool.task ?? tool.summary))
                    .font(.title3.weight(.semibold))
                if let outcome = tool.outcome {
                    Text(L10n.text(outcome))
                        .foregroundStyle(.secondary)
                } else {
                    Text(L10n.text(tool.summary))
                        .foregroundStyle(.secondary)
                }
                if let prompt = tool.examplePrompt {
                    Text(L10n.format("Try: {task}", ["task": L10n.text(prompt)]))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(alignment: .trailing, spacing: 10) {
                if let stateLabel {
                    Text(L10n.text(stateLabel))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(state == .missing ? Color.orange : Color.secondary)
                }
                if let action, state == .installed {
                    Button(L10n.text("Try in a new task"), action: action)
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .accessibilityLabel(L10n.format(
                            "Try {tool} in a new Agent task",
                            ["tool": L10n.text(tool.name)]
                        ))
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.secondary.opacity(0.18), lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
    }

    private var visual: some View {
        VStack(alignment: .leading, spacing: 0) {
            Image(systemName: tool.systemImage)
                .font(.title2.weight(.semibold))
                .accessibilityHidden(true)
            Spacer(minLength: 10)
            Text(tool.visualLabel ?? "")
                .font(.system(.callout, design: .rounded).weight(.semibold))
                .lineLimit(2)
                .minimumScaleFactor(0.65)
        }
        .foregroundStyle(accent)
        .padding(12)
        .frame(width: 138, height: 96, alignment: .leading)
        .background(accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 11))
        .overlay(alignment: .topTrailing) {
            Circle()
                .fill(accent.opacity(0.2))
                .frame(width: 42, height: 42)
                .offset(x: 12, y: -12)
                .accessibilityHidden(true)
        }
        .clipped()
        .accessibilityHidden(true)
    }

    private var stateLabel: String? {
        switch state {
        case .preview: nil
        case .installed: "Installed"
        case .missing: "Not installed"
        case .paused: "Tools paused"
        }
    }

    private var accent: Color {
        switch tool.tone {
        case "teal": .teal
        case "orange": .orange
        default: .indigo
        }
    }
}

struct HealthPill: View {
    let health: ManagerHealth

    var body: some View {
        let value: (String, Color, String) = switch health {
        case .loading: ("Checking", .secondary, "arrow.triangle.2.circlepath")
        case .ready: ("Ready", .green, "checkmark.circle.fill")
        case let .attention(message): (message, .orange, "exclamationmark.triangle.fill")
        case .unavailable: ("Not set up", .secondary, "circle.dashed")
        }
        Label(L10n.text(value.0), systemImage: value.2)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(value.1.opacity(0.14), in: Capsule())
            .foregroundStyle(value.1)
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
