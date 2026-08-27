// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MultiplayerAIConnector",
    platforms: [.macOS(.v14)],
    targets: [
        // The Connector's views and the reasoning about what it may claim, kept in a library so
        // both the app and the checks below are looking at exactly the same code.
        .target(name: "ConnectorUI", path: "Sources/ConnectorUI"),
        .executableTarget(name: "MultiplayerAIConnector", dependencies: ["ConnectorUI"], path: "Sources/MultiplayerAIConnector"),
        // Renders the real views offscreen, for looking at them without a menu bar.
        .executableTarget(name: "ConnectorPreviews", dependencies: ["ConnectorUI"], path: "Sources/ConnectorPreviews"),
        .testTarget(name: "ConnectorUITests", dependencies: ["ConnectorUI"], path: "Tests/ConnectorUITests"),
    ]
)
