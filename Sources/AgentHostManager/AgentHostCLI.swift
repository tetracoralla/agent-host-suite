import Foundation
import AgentHostBootstrap
import Darwin

private final class LockedData: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = Data()

    func replace(with data: Data) {
        lock.lock()
        storage = data
        lock.unlock()
    }

    var value: Data {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = false

    func set() {
        lock.lock()
        storage = true
        lock.unlock()
    }

    var value: Bool {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

struct AgentHostCLI: Sendable {
    private let environment: [String: String]
    private let timeoutSeconds: Int

    init(environment: [String: String] = ProcessInfo.processInfo.environment, timeoutSeconds: Int = 130) {
        self.environment = Self.augmentedEnvironment(environment)
        self.timeoutSeconds = timeoutSeconds
    }

    // A Finder-launched app inherits a minimal PATH (/usr/bin:/bin:...), so
    // Homebrew-installed host CLIs are invisible to the CLI's `which` probe.
    // Append the standard install locations before forwarding the environment.
    static func augmentedEnvironment(_ environment: [String: String]) -> [String: String] {
        let home = environment["HOME"] ?? NSHomeDirectory()
        let additions = [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "\(home)/.local/bin",
            "\(home)/bin",
        ]
        var entries = (environment["PATH"] ?? "")
            .split(separator: ":", omittingEmptySubsequences: true)
            .map(String.init)
        for directory in additions where !entries.contains(directory) {
            entries.append(directory)
        }
        var augmented = environment
        augmented["PATH"] = entries.joined(separator: ":")
        return augmented
    }

    func run<T: Decodable & Sendable>(_ arguments: [String], as type: T.Type = T.self) async throws -> T {
        try await Task.detached(priority: .userInitiated) {
            try self.runSynchronously(arguments, as: type)
        }.value
    }

    private func runSynchronously<T: Decodable>(_ arguments: [String], as type: T.Type) throws -> T {
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        let target = try command()
        process.executableURL = URL(fileURLWithPath: target.executable)
        process.arguments = target.prefixArguments + arguments + ["--json"]
        process.environment = environment
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()

        let timedOut = LockedFlag()
        let timeout = DispatchWorkItem {
            guard process.isRunning else { return }
            timedOut.set()
            process.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + .seconds(2)) {
                if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
            }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + .seconds(timeoutSeconds), execute: timeout)
        // Drain both pipes at once: reading stdout to completion first can
        // deadlock when the child fills the bounded stderr pipe.
        let group = DispatchGroup()
        let outputDrain = LockedData()
        let errorDrain = LockedData()
        group.enter()
        DispatchQueue.global().async {
            outputDrain.replace(with: stdout.fileHandleForReading.readDataToEndOfFile())
            group.leave()
        }
        group.enter()
        DispatchQueue.global().async {
            errorDrain.replace(with: stderr.fileHandleForReading.readDataToEndOfFile())
            group.leave()
        }
        group.wait()
        process.waitUntilExit()
        timeout.cancel()

        if timedOut.value {
            throw CLIError.failed(code: "COMMAND_TIMEOUT", message: "Agent Host took too long to complete this action.")
        }

        let output = outputDrain.value
        let errorOutput = errorDrain.value
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
    }

    private func command() throws -> (executable: String, prefixArguments: [String]) {
        if let explicit = environment["AGENT_HOST_CLI"], !explicit.isEmpty {
            if explicit.hasSuffix(".mjs") {
                return (environment["AGENT_HOST_NODE"] ?? "/usr/bin/env", environment["AGENT_HOST_NODE"] == nil ? ["node", explicit] : [explicit])
            }
            return (explicit, [])
        }
        if let resources = Bundle.main.resourceURL {
            let bundled = resources.appendingPathComponent("agent-host-suite/bin/agent-host.mjs").path
            if FileManager.default.isReadableFile(atPath: bundled) {
                if let appExecutable = Bundle.main.executableURL {
                    let shim = appExecutable.deletingLastPathComponent().appendingPathComponent("agent-host").path
                    if FileManager.default.isExecutableFile(atPath: shim) {
                        return (shim, [])
                    }
                }
                let target = try AgentHostCommandResolver.bundled(resources: resources, environment: environment)
                return (target.executable, target.prefixArguments)
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
            case "STATE_INVALID_JSON", "STATE_SCHEMA_INVALID", "STATE_SCHEMA_UNSUPPORTED":
                "The saved Agent Host state is unreadable, so Agent Host left the environment unchanged. Restore a known-good Agent Host backup before trying again."
            case "ROLLBACK_UNAVAILABLE", "ROLLBACK_BYTES_UNAVAILABLE":
                "A complete previous version is not available to restore."
            case "SERVICE_CONFLICT":
                "Another Agent Host local execution service is already configured. Open that installation or remove it before setting up again."
            case "SERVICE_PATH_UNSAFE":
                "The local execution service cannot be installed safely. Remove the conflicting service entry, then try again."
            case "COMMAND_TIMEOUT":
                "Agent Host took too long to complete this action. Try again; if it repeats, run a full check."
            default:
                message
            }
        }
    }
}
