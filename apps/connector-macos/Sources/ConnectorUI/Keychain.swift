import Foundation
import Security

/// Where this Mac's workspace credential lives.
///
/// The credential is written once, on enrolment, and read only to hand to the sidecar. It is
/// never placed in a file, an argument list, an environment variable the user could read back,
/// or anything shown on screen. Removing it is what signing out means.
public enum Keychain {
    private static let service = "com.multiplayerai.connector"
    private static let account = "workspace-credential"

    /// Everything needed to reconnect after a restart, except the credential itself.
    public struct Enrolment: Codable, Equatable, Sendable {
        public var baseURL: String
        public var roomId: String
        public var roomName: String?
        public var projectName: String?
        public var agentPrincipalId: String
        public var agentDisplayName: String?
        public init(baseURL: String, roomId: String, roomName: String? = nil, projectName: String? = nil,
                    agentPrincipalId: String, agentDisplayName: String? = nil) {
            self.baseURL = baseURL; self.roomId = roomId; self.roomName = roomName
            self.projectName = projectName; self.agentPrincipalId = agentPrincipalId
            self.agentDisplayName = agentDisplayName
        }
    }

    public static func saveCredential(_ credential: String) throws {
        let data = Data(credential.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        // Available after the Mac has been unlocked once, so the Connector can start at login
        // without asking anybody for anything, and never leaves this device.
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public static func credential() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public static func removeCredential() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
    }

    /* Which agent and room this Mac is bound to is not secret, and is kept beside the app's own
       settings so a returning install knows what it is without unlocking anything. */
    private static let enrolmentKey = "com.multiplayerai.connector.enrolment"

    public static func saveEnrolment(_ enrolment: Enrolment) {
        guard let data = try? JSONEncoder().encode(enrolment) else { return }
        UserDefaults.standard.set(data, forKey: enrolmentKey)
    }

    public static func enrolment() -> Enrolment? {
        guard let data = UserDefaults.standard.data(forKey: enrolmentKey) else { return nil }
        return try? JSONDecoder().decode(Enrolment.self, from: data)
    }

    public static func removeEnrolment() {
        UserDefaults.standard.removeObject(forKey: enrolmentKey)
    }
}

public struct KeychainError: LocalizedError {
    public let status: OSStatus
    public var errorDescription: String? {
        "The Keychain would not store this Mac's credential (\(status))."
    }
}
