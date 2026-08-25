// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "AgentHostManager",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "AgentHostManager", targets: ["AgentHostManager"])],
    targets: [
        .executableTarget(name: "AgentHostManager", path: "Sources/AgentHostManager"),
    ]
)
