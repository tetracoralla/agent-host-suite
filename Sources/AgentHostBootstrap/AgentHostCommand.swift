import CryptoKit
import Foundation

public struct AgentHostCommandTarget: Sendable {
    public let executable: String
    public let prefixArguments: [String]

    public init(executable: String, prefixArguments: [String]) {
        self.executable = executable
        self.prefixArguments = prefixArguments
    }
}

public enum AgentHostBootstrapError: LocalizedError {
    case invalidRelease(String)
    case invalidArtifact(String)
    case processFailed(String)

    public var errorDescription: String? {
        switch self {
        case let .invalidRelease(message), let .invalidArtifact(message), let .processFailed(message): message
        }
    }
}

public enum AgentHostCommandResolver {
    private struct Release: Decodable {
        let components: [ReleaseComponent]
    }

    private struct ReleaseComponent: Decodable {
        struct Artifact: Decodable {
            let url: String
            let sha256: String
        }
        let id: String
        let version: String
        let artifact: Artifact
        let descriptorSha256: String
    }

    private struct ComponentDescriptor: Decodable {
        struct FileRecord: Decodable {
            let path: String
            let sha256: String
            let executable: Bool
        }
        let schemaVersion: String
        let id: String
        let version: String
        let files: [FileRecord]
        let entrypoints: [String: String]
    }

    public static func bundled(resources: URL, environment: [String: String] = ProcessInfo.processInfo.environment) throws -> AgentHostCommandTarget {
        let cli = resources.appendingPathComponent("agent-host-suite/bin/agent-host.mjs")
        guard FileManager.default.isReadableFile(atPath: cli.path) else {
            throw AgentHostBootstrapError.invalidRelease("The bundled Agent Host CLI is unavailable.")
        }
        let manifest = resources.appendingPathComponent("agent-host-suite/catalog/releases/current.json")
        let node = try ensureNode(manifest: manifest, environment: environment)
        return AgentHostCommandTarget(executable: node.path, prefixArguments: [cli.path])
    }

    private static func ensureNode(manifest: URL, environment: [String: String]) throws -> URL {
        let release = try JSONDecoder().decode(Release.self, from: Data(contentsOf: manifest))
        guard let component = release.components.first(where: { $0.id == "node-runtime" }) else {
            throw AgentHostBootstrapError.invalidRelease("The bundled release does not contain the Node runtime.")
        }
        let digest = try digestValue(component.artifact.sha256, label: "Node artifact")
        let installName = "\(component.version)-\(digest.prefix(16))"
        let root: URL
        if let explicit = environment["AGENT_HOST_BOOTSTRAP_ROOT"], !explicit.isEmpty {
            root = URL(fileURLWithPath: explicit, isDirectory: true)
        } else {
            let applicationSupport = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            root = applicationSupport.appendingPathComponent("OpenAdam/Agent Host Suite", isDirectory: true)
        }
        let packageRoot = root.appendingPathComponent("packages/node-runtime", isDirectory: true)
        let destination = packageRoot.appendingPathComponent(installName, isDirectory: true)
        if try verifiedNode(at: destination, component: component) { return destination.appendingPathComponent("bin/node") }
        if FileManager.default.fileExists(atPath: destination.path) {
            throw AgentHostBootstrapError.invalidArtifact("The installed Agent Host Node runtime failed verification.")
        }

        guard !component.artifact.url.contains("\\"), !component.artifact.url.hasPrefix("/"), !component.artifact.url.contains("://") else {
            throw AgentHostBootstrapError.invalidRelease("The bundled Node artifact must use a contained relative path.")
        }
        let catalogRoot = manifest.deletingLastPathComponent().standardizedFileURL
        let artifact = catalogRoot.appendingPathComponent(component.artifact.url).standardizedFileURL
        guard contains(root: catalogRoot, candidate: artifact) else {
            throw AgentHostBootstrapError.invalidRelease("The bundled Node artifact escapes its release catalog.")
        }
        guard try sha256(artifact) == digest else {
            throw AgentHostBootstrapError.invalidArtifact("The bundled Node artifact digest does not match its release manifest.")
        }

        try FileManager.default.createDirectory(at: packageRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let staging = packageRoot.appendingPathComponent(".staging-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        do {
            let listing = try run("/usr/bin/tar", ["-tzf", artifact.path])
            let entries = listing.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
            guard !entries.isEmpty, entries.contains(where: { normalizedArchivePath($0) == "component.json" }) else {
                throw AgentHostBootstrapError.invalidArtifact("The bundled Node archive has no component descriptor.")
            }
            guard entries.allSatisfy(safeArchivePath) else {
                throw AgentHostBootstrapError.invalidArtifact("The bundled Node archive contains an unsafe path.")
            }
            _ = try run("/usr/bin/tar", ["-xzf", artifact.path, "-C", staging.path])
            guard try verifiedNode(at: staging, component: component) else {
                throw AgentHostBootstrapError.invalidArtifact("The extracted Node runtime failed verification.")
            }
            do {
                try FileManager.default.moveItem(at: staging, to: destination)
            } catch {
                if try verifiedNode(at: destination, component: component) {
                    try? FileManager.default.removeItem(at: staging)
                } else {
                    throw error
                }
            }
        } catch {
            try? FileManager.default.removeItem(at: staging)
            throw error
        }
        return destination.appendingPathComponent("bin/node")
    }

    private static func verifiedNode(at root: URL, component: ReleaseComponent) throws -> Bool {
        let descriptorURL = root.appendingPathComponent("component.json")
        let nodeURL = root.appendingPathComponent("bin/node")
        guard FileManager.default.fileExists(atPath: descriptorURL.path), FileManager.default.isExecutableFile(atPath: nodeURL.path) else { return false }
        let descriptorDigest = try digestValue(component.descriptorSha256, label: "Node descriptor")
        guard try sha256(descriptorURL) == descriptorDigest else { return false }
        let descriptor = try JSONDecoder().decode(ComponentDescriptor.self, from: Data(contentsOf: descriptorURL))
        guard descriptor.schemaVersion == "openadam.agent-host-component.v0.1",
              descriptor.id == component.id,
              descriptor.version == component.version,
              descriptor.entrypoints["node"] == "bin/node",
              let nodeRecord = descriptor.files.first(where: { $0.path == "bin/node" }),
              nodeRecord.executable else { return false }
        return try sha256(nodeURL) == digestValue(nodeRecord.sha256, label: "Node executable")
    }

    private static func digestValue(_ value: String, label: String) throws -> String {
        guard value.hasPrefix("sha256:"), value.count == 71 else {
            throw AgentHostBootstrapError.invalidRelease("\(label) digest is invalid.")
        }
        let digest = String(value.dropFirst(7))
        guard digest.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else {
            throw AgentHostBootstrapError.invalidRelease("\(label) digest is invalid.")
        }
        return digest
    }

    private static func sha256(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let data = try handle.read(upToCount: 1024 * 1024) ?? Data()
            if data.isEmpty { break }
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func contains(root: URL, candidate: URL) -> Bool {
        let rootPath = root.path.hasSuffix("/") ? root.path : "\(root.path)/"
        return candidate.path == root.path || candidate.path.hasPrefix(rootPath)
    }

    private static func normalizedArchivePath(_ path: String) -> String {
        var value = path
        while value.hasPrefix("./") { value.removeFirst(2) }
        return value
    }

    private static func safeArchivePath(_ path: String) -> Bool {
        let value = normalizedArchivePath(path)
        if value.isEmpty || value.hasPrefix("/") || value.contains("\\") { return false }
        return !value.split(separator: "/", omittingEmptySubsequences: false).contains("..")
    }

    private static func run(_ executable: String, _ arguments: [String]) throws -> String {
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        let output = stdout.fileHandleForReading.readDataToEndOfFile()
        let error = stderr.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let detail = String(data: error, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "unknown error"
            throw AgentHostBootstrapError.processFailed("The bundled runtime could not be prepared: \(detail)")
        }
        return String(data: output, encoding: .utf8) ?? ""
    }
}
