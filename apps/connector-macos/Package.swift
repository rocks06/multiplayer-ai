// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MultiplayerAI",
    platforms: [.macOS(.v14)],
    targets: [
        // The app's views and all the reasoning about what it may claim, kept in a library so
        // the app and the checks below are looking at exactly the same code.
        .target(name: "ConnectorUI", path: "Sources/ConnectorUI"),
        .executableTarget(name: "MultiplayerAI", dependencies: ["ConnectorUI"], path: "Sources/MultiplayerAI"),
        // Renders the real views offscreen, for looking at them without opening the app.
        .executableTarget(name: "ConnectorPreviews", dependencies: ["ConnectorUI"], path: "Sources/ConnectorPreviews"),
        // Walks the real first run against a real workspace. Wrapped in a bundle of its own by
        // scripts/verify-shell.sh so it never touches the app someone is actually using.
        .executableTarget(name: "VerifyShell", dependencies: ["ConnectorUI"], path: "Sources/VerifyShell"),
        .testTarget(name: "ConnectorUITests", dependencies: ["ConnectorUI"], path: "Tests/ConnectorUITests"),
    ]
)
