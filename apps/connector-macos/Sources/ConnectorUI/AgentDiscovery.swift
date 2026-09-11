import Foundation

/// Generic adapter records. Display labels never supply or replace runtime identity.
public struct DiscoveredAgent: Identifiable, Equatable, Sendable {
    public let runtime: SidecarState.Runtime
    public let runtimeInstallationId: String
    public let profile: String
    public var id: String { runtimeInstallationId }
    public var isConnectable: Bool { runtime.isConnectable }
    public var detail: String {
        [runtime.runtimeType ?? runtime.name, runtime.version, profile]
            .compactMap { $0 }.joined(separator: " · ")
    }
    public static func decode(_ raw: [String: Any]) -> DiscoveredAgent? {
        guard let id = raw["runtimeInstallationId"] as? String ?? raw["externalRuntimeId"] as? String, !id.isEmpty,
              let type = raw["runtimeType"] as? String ?? raw["adapter"] as? String, !type.isEmpty else { return nil }
        var normalized = raw
        normalized["externalRuntimeId"] = id
        normalized["runtimeType"] = type
        guard let data = try? JSONSerialization.data(withJSONObject: normalized),
              let runtime = try? JSONDecoder().decode(SidecarState.Runtime.self, from: data) else { return nil }
        return .init(runtime: runtime, runtimeInstallationId: id, profile: raw["profile"] as? String ?? "default")
    }
}
public struct KnownRuntimeIdentity: Equatable, Sendable {
    public let principalId: String
    public let displayName: String
}
public enum AgentDiscoveryPhase: Equatable, Sendable {
    case idle, looking, results, connecting, connected
    case failed(String)
}
