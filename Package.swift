// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "AgentHostManager",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "AgentHostManager", targets: ["AgentHostManager"]),
        .executable(name: "AgentHostCLIShim", targets: ["AgentHostCLIShim"]),
    ],
    targets: [
        .target(name: "AgentHostBootstrap", path: "Sources/AgentHostBootstrap"),
        .executableTarget(name: "AgentHostManager", dependencies: ["AgentHostBootstrap"], path: "Sources/AgentHostManager"),
        .executableTarget(name: "AgentHostCLIShim", dependencies: ["AgentHostBootstrap"], path: "Sources/AgentHostCLIShim"),
    ]
)
