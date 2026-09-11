import Foundation
import Security

/// Where this Mac's workspace credential lives.
///
/// The credential is written once, on enrolment, and read only to hand to the sidecar. It is
/// never placed in a file, an argument list, an environment variable the user could read back,
/// or anything shown on screen. Removing it is what signing out means.
public enum Keychain {
    /// Keyed to the bundle, not to a literal.
    ///
    /// For the shipping app this is the same string it has always been, so nothing already
    /// stored moves. What it buys is that a build with a different identity — a verification
    /// build alongside the real one — cannot reach into, overwrite, or invalidate the
    /// credential belonging to the app a person actually uses.
    private static var service: String { Bundle.main.bundleIdentifier ?? "com.multiplayerai.connector" }
    private static let account = "workspace-credential"

    /// Everything needed to reconnect after a restart, except the credential itself.
    public struct Enrolment: Codable, Equatable, Sendable {
        public var baseURL: String
        public var roomId: String
        public var roomName: String?
        public var projectName: String?
        public var agentPrincipalId: String
        public var agentDisplayName: String?
        public var runtimeSelectionId: String?
        public init(baseURL: String, roomId: String, roomName: String? = nil, projectName: String? = nil,
                    agentPrincipalId: String, agentDisplayName: String? = nil, runtimeSelectionId: String? = nil) {
            self.baseURL = baseURL; self.roomId = roomId; self.roomName = roomName
            self.projectName = projectName; self.agentPrincipalId = agentPrincipalId
            self.agentDisplayName = agentDisplayName
            self.runtimeSelectionId = runtimeSelectionId
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
        let status = withoutDialogs { SecItemAdd(attributes as CFDictionary, nil) }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    /// The three genuinely different answers to "can this Mac present its credential?".
    ///
    /// Collapsing these into an optional is what let a re-signed build look like a Mac that had
    /// never been set up: the app was enrolled, the item was right there, and macOS simply would
    /// not hand it over — which is a different problem, with a different remedy, from having
    /// nothing stored at all.
    public enum CredentialLookup: Equatable, Sendable {
        case found(String)
        case missing                 // nothing is stored under this service and account
        case unreadable(OSStatus)    // something is stored, and this build cannot read it

        /// Whether a credential can actually be presented, without unwrapping the secret to ask.
        public var isFound: Bool { if case .found = self { return true }; return false }
    }

    /// Turning what the Keychain returned into one of those three. Split out from the lookup
    /// itself so the classification can be tested without a Keychain, a login session, or a
    /// signed binary — none of which a test host is guaranteed to have.
    public static func classify(status: OSStatus, data: Data?) -> CredentialLookup {
        if status == errSecItemNotFound { return .missing }
        guard status == errSecSuccess else { return .unreadable(status) }
        // Success with nothing usable in it is still something the person has to be told about;
        // silently treating it as "not set up" is the bug this exists to prevent.
        guard let data, let value = String(data: data, encoding: .utf8), !value.isEmpty else {
            return .unreadable(errSecDecode)
        }
        return .found(value)
    }

    /**
     Run a keychain lookup with the system's own dialogs turned off for its duration.

     This Mac's credential lives in the file-based keychain, so a build macOS does not recognise
     as the one that stored it triggers the classic authorisation dialog — and the lookup blocks
     inside `SecKeychainItemCopyContent` until somebody answers. `kSecUseAuthenticationUI` does
     not govern that dialog; it covers LocalAuthentication. This deprecated call is the one that
     does, and there is no replacement for the keychain this item is in.

     With interaction off the lookup returns `errSecInteractionNotAllowed` instead, which is
     already what this app means by a credential it cannot present — a state with a screen and a
     one-click remedy. Interaction is restored immediately, so nothing else is affected.
     */
    private static func withoutDialogs<T>(_ work: () -> T) -> T {
        SecKeychainSetUserInteractionAllowed(false)
        defer { SecKeychainSetUserInteractionAllowed(true) }
        return work()
    }

    /**
     Read the credential, and never ask anybody anything to do it.

     A build macOS does not recognise as the one that stored this item makes the Keychain put up
     an authorisation dialog — and `SecItemCopyMatching` blocks the calling thread until it is
     answered. On the main thread that is the whole application: it launched, stopped, and could
     not draw, respond, or accept a sign-in link, behind a system dialog asking for a password.
     An upgraded Mac hit this on first launch every time.

     Skipping the interaction turns that into `errSecInteractionNotAllowed`, which is already
     exactly what this app means by `unreadable` — a state it has a screen and a one-click remedy
     for. A dialog demanding a login password is a worse answer than the app's own, and this one
     could not even be reached.
     */
    public static func readCredential() -> CredentialLookup {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip,
        ]
        var item: CFTypeRef?
        let status = withoutDialogs { SecItemCopyMatching(query as CFDictionary, &item) }
        return classify(status: status, data: item as? Data)
    }

    public static func credential() -> String? {
        guard case .found(let value) = readCredential() else { return nil }
        return value
    }

    public static func removeCredential() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
    }

    /// Prove this Mac can actually keep a secret, before anything depends on it.
    ///
    /// A read of the real credential would not do: on a Mac that has never been set up there is
    /// nothing stored, so a read succeeds at finding nothing and proves precisely nothing. This
    /// writes a throwaway value, reads it back, and removes it — so a keychain that is locked or
    /// that will not admit this build is found during setup rather than at the moment someone's
    /// credential is being saved.
    public static func probe() -> CredentialLookup {
        let probeAccount = "storage-probe"
        let expected = UUID().uuidString
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: probeAccount,
        ]
        SecItemDelete(query as CFDictionary)
        defer { SecItemDelete(query as CFDictionary) }

        var attributes = query
        attributes[kSecValueData as String] = Data(expected.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let wrote = withoutDialogs { SecItemAdd(attributes as CFDictionary, nil) }
        guard wrote == errSecSuccess else { return .unreadable(wrote) }

        var read = query
        read[kSecReturnData as String] = true
        read[kSecMatchLimit as String] = kSecMatchLimitOne
        // Same rule as reading the real credential: never block setup behind a system dialog.
        read[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUISkip
        var item: CFTypeRef?
        let status = withoutDialogs { SecItemCopyMatching(read as CFDictionary, &item) }
        switch classify(status: status, data: item as? Data) {
        case .found(let value) where value == expected: return .found(value)
        case .found: return .unreadable(errSecDecode)
        case .missing: return .unreadable(errSecItemNotFound)
        case .unreadable(let status): return .unreadable(status)
        }
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
