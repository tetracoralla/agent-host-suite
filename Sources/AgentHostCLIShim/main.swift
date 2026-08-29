import AgentHostBootstrap
import Darwin
import Foundation

@main
struct AgentHostCLIShim {
    static func main() {
        do {
            let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
            let resources = executable.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources", isDirectory: true)
            let target = try AgentHostCommandResolver.bundled(resources: resources)
            let process = Process()
            process.executableURL = URL(fileURLWithPath: target.executable)
            process.arguments = target.prefixArguments + Array(CommandLine.arguments.dropFirst())
            process.environment = ProcessInfo.processInfo.environment
            process.standardInput = FileHandle.standardInput
            process.standardOutput = FileHandle.standardOutput
            process.standardError = FileHandle.standardError
            try process.run()
            process.waitUntilExit()
            exit(process.terminationStatus)
        } catch {
            let message = "AGENT_HOST_BOOTSTRAP_FAILED: \(error.localizedDescription)\n"
            FileHandle.standardError.write(Data(message.utf8))
            exit(1)
        }
    }
}
