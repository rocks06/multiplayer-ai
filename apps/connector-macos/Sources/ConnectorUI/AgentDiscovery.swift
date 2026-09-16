import Foundation

/// Generic adapter records. Display labels never supply or replace runtime identity.
public struct DiscoveredAgent: Identifiable, Equatable, Sendable {
    public let runtime: SidecarState.Runtime
    public let runtimeInstallationId: String
    public let profile: String
    /// What the runtime itself calls this profile, such as a Hermes display name.
    public var displayName: String? = nil
    public var id: String { runtimeInstallationId }
    public var isConnectable: Bool { runtime.isConnectable }

    /// The card's name. Never empty: a card with nothing on it is a checkbox for nobody knows what.
    public func title(known: KnownRuntimeIdentity? = nil) -> String {
        for candidate in [known?.displayName, displayName, profile, runtime.name] {
            if let name = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return name }
        }
        return "Agent"
    }

    /// Hermes · profile · version — what it is, which one, and which release.
    public var detail: String {
        let kind = runtime.runtimeType.map { $0 == "hermes" ? "Hermes" : $0 } ?? runtime.name
        return [kind, profile, runtime.version].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
    public static func decode(_ raw: [String: Any]) -> DiscoveredAgent? {
        guard let id = raw["runtimeInstallationId"] as? String ?? raw["externalRuntimeId"] as? String, !id.isEmpty,
              let type = raw["runtimeType"] as? String ?? raw["adapter"] as? String, !type.isEmpty else { return nil }
        var normalized = raw
        normalized["externalRuntimeId"] = id
        normalized["runtimeType"] = type
        guard let data = try? JSONSerialization.data(withJSONObject: normalized),
              let runtime = try? JSONDecoder().decode(SidecarState.Runtime.self, from: data) else { return nil }
        let profile = (raw["profile"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "default"
        let named = (raw["displayName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return .init(runtime: runtime, runtimeInstallationId: id, profile: profile,
                     displayName: named?.isEmpty == false ? named : nil)
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
