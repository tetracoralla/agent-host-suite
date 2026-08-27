import Foundation

struct ComponentSummary: Decodable, Equatable, Sendable {
    let version: String
    let displayName: String?
    let summary: String?
}

struct HostEntrySummary: Decodable, Equatable, Sendable {
    let component: String
    let ownership: String
}

struct HostSummary: Decodable, Equatable, Sendable {
    let installed: Bool
    let version: String?
    let restartRequired: Bool?
    let entries: [HostEntrySummary]?
}

struct ServiceSummary: Decodable, Equatable, Sendable {
    let label: String?
    let created: Bool?
}

struct SuiteStatus: Decodable, Equatable, Sendable {
    let configured: Bool
    let suiteVersion: String?
    let channel: String?
    let profile: String?
    let installedAt: String?
    let updatedAt: String?
    let components: [String: ComponentSummary]?
    let hosts: [String: HostSummary]?
    let service: ServiceSummary?
}

struct HostStatusResult: Decodable, Equatable, Sendable {
    struct Failure: Decodable, Equatable, Sendable {
        let code: String
        let message: String
    }

    let status: String
    let host: String
    let appInstalled: Bool?
    let managed: Bool?
    let installed: Bool?
    let healthy: Bool?
    let version: String?
    let error: Failure?
}

struct SetupPlan: Decodable, Equatable, Sendable {
    let status: String
    let dryRun: Bool
    let profile: String
    let profileDisplayName: String?
    let hosts: [String: HostPlan]?
    let service: ServicePlan?
    let components: [String: ComponentSummary]
}

struct HostPlanEntry: Decodable, Equatable, Sendable {
    let component: String?
    let selector: String?
    let pluginPresent: Bool?
    let pluginEnabled: Bool?
    let installedVersion: String?
    let requestedVersion: String?
}

struct HostPlan: Decodable, Equatable, Sendable {
    let version: String?
    let entries: [HostPlanEntry]?
}

struct ServicePlan: Decodable, Equatable, Sendable {
    let supported: Bool?
    let configured: Bool?
    let loaded: Bool?
    let label: String?
    let launchAgentPath: String?
}

struct ActivationPlan: Decodable, Equatable, Sendable {
    let hosts: [String: HostPlan]
    let service: ServicePlan?
}

struct UpdatePlan: Decodable, Equatable, Sendable {
    let status: String
    let dryRun: Bool
    let fromChannel: String
    let toChannel: String
    let releaseId: String?
    let profile: String
    let profileDisplayName: String?
    let changed: [String]
    let activation: ActivationPlan
}

struct RollbackPlan: Decodable, Equatable, Sendable {
    let status: String
    let dryRun: Bool
    let targetVersion: String
}

enum EnvironmentChangePlan: Equatable, Sendable {
    case update(UpdatePlan, profile: String?, replaceHostConflicts: Bool)
    case rollback(RollbackPlan)
}

struct ActivityEntry: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let occurredAt: String
    let type: String
    let summary: String

    var date: Date? { ISO8601DateFormatter.activity.date(from: occurredAt) }
}

struct ActivityResult: Decodable, Equatable, Sendable {
    let status: String
    let entries: [ActivityEntry]
}

struct ObservationState: Decodable, Equatable, Sendable {
    let toolEvents: Int
    let usageEvents: Int
    let semanticExecutionEvents: Int
    let contextSurfaceMeasurements: Int
}

struct ContextCounts: Decodable, Equatable, Sendable {
    let tools: Int
    let schemas: Int
}

struct ContextCatalog: Decodable, Equatable, Sendable {
    let canonicalUtf8Bytes: Int
    let largestToolUtf8Bytes: Int
}

struct ContextSummary: Decodable, Equatable, Sendable {
    let catalog: ContextCatalog
    let counts: ContextCounts
    let hardNameCollisions: Int
}

struct ReportTotals: Decodable, Equatable, Sendable {
    let observedTools: Int
    let observedCalls: Int
    let suiteToolCalls: Int
}

struct ReportSummary: Decodable, Equatable, Sendable {
    let generatedAtMs: Int64
    let totals: ReportTotals
}

struct LatestObservability: Decodable, Equatable, Sendable {
    let refreshedAt: String
    let status: ObserverStatus
    let context: ContextSummary
    let report: ReportSummary
}

struct ObserverStatus: Decodable, Equatable, Sendable {
    let state: ObservationState
}

struct ObservabilityStatus: Decodable, Equatable, Sendable {
    let configured: Bool
    let enabled: Bool
    let consentedAt: String?
    let latest: LatestObservability?
}

struct DoctorCheck: Decodable, Equatable, Identifiable, Sendable {
    var id: String
    let status: String
    let message: String
}

struct DoctorResult: Decodable, Equatable, Sendable {
    let status: String
    let checks: [DoctorCheck]

    func check(_ id: String) -> DoctorCheck? {
        checks.first { $0.id == id }
    }

    func hasFailure(prefix: String) -> Bool {
        checks.contains { $0.id.hasPrefix(prefix) && $0.status == "error" }
    }
}

struct PublicFailure: Decodable, Error, Sendable {
    struct Detail: Decodable, Sendable {
        let code: String
        let message: String
    }
    let status: String
    let error: Detail
}

enum ManagerHealth: Equatable {
    case loading
    case ready
    case attention(String)
    case unavailable
}

enum ManagerSection: String, CaseIterable, Identifiable {
    case overview
    case tools
    case agentApps
    case activity

    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: "Environment"
        case .tools: "Tools"
        case .agentApps: "Agent Apps"
        case .activity: "Activity"
        }
    }

    var systemImage: String {
        switch self {
        case .overview: "square.stack.3d.up"
        case .tools: "wrench.and.screwdriver"
        case .agentApps: "bubble.left.and.bubble.right"
        case .activity: "clock.arrow.circlepath"
        }
    }
}

struct ManagedTool: Identifiable, Equatable {
    let id: String
    let name: String
    let summary: String
    let systemImage: String
    let version: String?
    let state: ManagedItemState
    let availability: String
    let ownership: String
}

enum ManagedItemState: Equatable {
    case checking
    case ready
    case attention
    case unavailable

    var label: String {
        switch self {
        case .checking: "Checking"
        case .ready: "Ready"
        case .attention: "Needs attention"
        case .unavailable: "Unavailable"
        }
    }
}

private extension ISO8601DateFormatter {
    static let activity: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
