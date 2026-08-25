import Foundation

struct AgentHostCLI: Sendable {
    private let environment: [String: String]

    init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.environment = environment
    }

    func run<T: Decodable & Sendable>(_ arguments: [String], as type: T.Type = T.self) async throws -> T {
        try await Task.detached(priority: .userInitiated) {
            let process = Process()
            let stdout = Pipe()
            let stderr = Pipe()
            let target = self.command()
            process.executableURL = URL(fileURLWithPath: target.executable)
            process.arguments = target.prefixArguments + arguments + ["--json"]
            process.environment = self.environment
            process.standardOutput = stdout
            process.standardError = stderr
            try process.run()

            let timeout = DispatchWorkItem {
                if process.isRunning { process.terminate() }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 130, execute: timeout)
            let output = stdout.fileHandleForReading.readDataToEndOfFile()
            let errorOutput = stderr.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            timeout.cancel()

            let payload = process.terminationStatus == 0 ? output : errorOutput
            if process.terminationStatus != 0,
               let failure = try? JSONDecoder().decode(PublicFailure.self, from: payload) {
                throw CLIError.failed(code: failure.error.code, message: failure.error.message)
            }
            guard process.terminationStatus == 0 else {
                throw CLIError.failed(code: "COMMAND_FAILED", message: String(data: payload, encoding: .utf8) ?? "Agent Host did not complete the action.")
            }
            return try JSONDecoder().decode(T.self, from: output)
        }.value
    }

    private func command() -> (executable: String, prefixArguments: [String]) {
        if let explicit = environment["AGENT_HOST_CLI"], !explicit.isEmpty {
            if explicit.hasSuffix(".mjs") {
                return (environment["AGENT_HOST_NODE"] ?? "/usr/bin/env", environment["AGENT_HOST_NODE"] == nil ? ["node", explicit] : [explicit])
            }
            return (explicit, [])
        }
        if let resources = Bundle.main.resourceURL {
            let bundled = resources.appendingPathComponent("agent-host-suite/bin/agent-host.mjs").path
            if FileManager.default.isReadableFile(atPath: bundled) {
                for node in ["/opt/homebrew/opt/node@22/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"] where FileManager.default.isExecutableFile(atPath: node) {
                    return (node, [bundled])
                }
            }
        }
        for candidate in ["/opt/homebrew/bin/agent-host", "/usr/local/bin/agent-host"] where FileManager.default.isExecutableFile(atPath: candidate) {
            return (candidate, [])
        }
        return ("/usr/bin/env", ["agent-host"])
    }
}

enum CLIError: LocalizedError {
    case failed(code: String, message: String)

    var errorDescription: String? {
        switch self {
        case let .failed(_, message): message
        }
    }
}
