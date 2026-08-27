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
               !output.isEmpty,
               let diagnostic = try? JSONDecoder().decode(T.self, from: output) {
                return diagnostic
            }
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
                let bundledNode = resources.appendingPathComponent("agent-host-runtime/node").path
                if FileManager.default.isExecutableFile(atPath: bundledNode) {
                    return (bundledNode, [bundled])
                }
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
        case let .failed(code, message):
            switch code {
            case "RELEASE_UNBOUND":
                "No verified Agent Host release is available yet."
            case "COMPONENT_PACKAGE_UNAVAILABLE", "DEVELOPMENT_COMPONENT_INVALID":
                "A required tool package is unavailable in this build. Install a verified release or repair the tool package, then try again."
            case "CODEX_NOT_INSTALLED":
                "Codex is not installed or cannot be found on this Mac."
            case "CODEX_PLUGIN_CONFLICT", "CODEX_MARKETPLACE_CONFLICT":
                "Codex has a conflicting tool installation that Agent Host left unchanged. Replace it with the managed installation to continue."
            case "STATE_INVALID_JSON", "STATE_SCHEMA_UNSUPPORTED":
                "The saved Agent Host state on this Mac is unreadable. Remove the previous installation, then set up again."
            case "ROLLBACK_UNAVAILABLE", "ROLLBACK_BYTES_UNAVAILABLE":
                "A complete previous version is not available to restore."
            case "SERVICE_CONFLICT":
                "Another Agent Host local execution service is already configured. Open that installation or remove it before setting up again."
            case "SERVICE_PATH_UNSAFE":
                "The local execution service cannot be installed safely. Remove the conflicting service entry, then try again."
            default:
                message
            }
        }
    }
}
