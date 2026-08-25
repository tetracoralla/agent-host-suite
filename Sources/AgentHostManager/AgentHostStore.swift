import Foundation

@MainActor
final class AgentHostStore: ObservableObject {
    @Published private(set) var suite: SuiteStatus?
    @Published private(set) var observations: ObservabilityStatus?
    @Published private(set) var doctor: DoctorResult?
    @Published private(set) var isBusy = false
    @Published var errorMessage: String?

    private let cli: AgentHostCLI

    init(cli: AgentHostCLI = AgentHostCLI()) {
        self.cli = cli
    }

    var health: ManagerHealth {
        if isBusy && suite == nil { return .loading }
        guard let suite, suite.configured else { return .unavailable }
        if let doctor, doctor.status != "ok" { return .attention("Some checks need attention") }
        if suite.service == nil { return .attention("Local execution is not running") }
        return .ready
    }

    func refresh() async {
        await work {
            async let status = cli.run(["status"], as: SuiteStatus.self)
            async let observationStatus = cli.run(["observability", "status"], as: ObservabilityStatus.self)
            self.suite = try await status
            self.observations = try await observationStatus
        }
    }

    func runDoctor() async {
        await work {
            self.doctor = try await cli.run(["doctor", "--deep"], as: DoctorResult.self)
            await self.reloadStatus()
        }
    }

    func update() async { await action(["update"]) }
    func rollback() async { await action(["rollback"]) }
    func setObservability(_ enabled: Bool) async {
        await action(["observability", enabled ? "enable" : "disable"])
    }
    func uninstall() async { await action(["uninstall"]) }

    private func action(_ arguments: [String]) async {
        await work {
            _ = try await cli.run(arguments, as: GenericResult.self)
            self.doctor = nil
            await self.reloadStatus()
        }
    }

    private func reloadStatus() async {
        suite = try? await cli.run(["status"], as: SuiteStatus.self)
        observations = try? await cli.run(["observability", "status"], as: ObservabilityStatus.self)
    }

    private func work(_ operation: () async throws -> Void) async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            try await operation()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct GenericResult: Decodable, Sendable {
    let status: String
}
