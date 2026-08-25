import Foundation

struct ComponentSummary: Decodable, Equatable, Sendable {
    let version: String
}

struct HostSummary: Decodable, Equatable, Sendable {
    let installed: Bool
    let version: String?
    let restartRequired: Bool?
}

struct ServiceSummary: Decodable, Equatable, Sendable {
    let label: String?
    let created: Bool?
}

struct SuiteStatus: Decodable, Equatable, Sendable {
    let configured: Bool
    let suiteVersion: String?
    let profile: String?
    let components: [String: ComponentSummary]?
    let hosts: [String: HostSummary]?
    let service: ServiceSummary?
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
