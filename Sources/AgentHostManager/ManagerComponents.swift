import SwiftUI

struct PageHeader<Trailing: View>: View {
    let title: String
    let subtitle: String?
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.largeTitle.weight(.semibold))
                if let subtitle {
                    Text(subtitle)
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

struct HealthPill: View {
    let health: ManagerHealth

    var body: some View {
        let value: (String, Color, String) = switch health {
        case .loading: ("Checking", .secondary, "arrow.triangle.2.circlepath")
        case .ready: ("Ready", .green, "checkmark.circle.fill")
        case let .attention(message): (message, .orange, "exclamationmark.triangle.fill")
        case .unavailable: ("Not set up", .secondary, "circle.dashed")
        }
        Label(value.0, systemImage: value.2)
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
        Label(state.label, systemImage: value.1)
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
            Text(label)
                .font(.callout.weight(.medium))
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .shadow(radius: 14, y: 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
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
                Text(title).font(.headline)
                Text(message).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
