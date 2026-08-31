import Foundation
#if canImport(AppKit)
import AppKit
#endif

/// The app this one replaces.
///
/// The standalone Connector carried the same bundle identifier as this app, and everything keyed
/// to that identifier — the login item, the keychain item, the helper's own directory — is
/// therefore shared between them. Two copies of it on one Mac is not untidiness: whichever macOS
/// resolves the identifier to is the one that starts at login and the one a link could reach, and
/// that is not a coin toss worth leaving to chance.
///
/// It is never removed silently. Moving somebody's application to the Trash is their decision,
/// so this only ever finds it and offers.
public enum LegacyApp {
    /// Where the standalone Connector installed itself.
    static let installedPath = "/Applications/Multiplayer AI Connector.app"

    /// Whether a bundle is the old Connector rather than this app. Decided from what it says
    /// about itself, so a folder that merely shares the name is not mistaken for it.
    ///
    /// The identifier alone cannot tell them apart — they share it. What separates them is that
    /// the old one is a menu bar accessory with no window and claims no URL scheme, and this one
    /// is an application with both.
    public static func isLegacy(bundleIdentifier: String?, isAccessory: Bool, claimsScheme: Bool) -> Bool {
        guard bundleIdentifier == "com.multiplayerai.connector" else { return false }
        return isAccessory && !claimsScheme
    }

    /// The old Connector, if it is still installed somewhere other than where this app is running.
    public static func found() -> URL? {
        #if canImport(AppKit)
        let url = URL(fileURLWithPath: installedPath)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        // Never offer to remove the bundle this code is running out of.
        guard url.standardizedFileURL != Bundle.main.bundleURL.standardizedFileURL else { return nil }
        guard let bundle = Bundle(url: url) else { return nil }
        let accessory = (bundle.infoDictionary?["LSUIElement"] as? Bool) ?? false
        let schemes = bundle.infoDictionary?["CFBundleURLTypes"] as? [[String: Any]] ?? []
        return isLegacy(bundleIdentifier: bundle.bundleIdentifier,
                        isAccessory: accessory,
                        claimsScheme: !schemes.isEmpty) ? url : nil
        #else
        return nil
        #endif
    }

    /// Move it to the Trash, with macOS asking the person first. Recoverable on purpose: this is
    /// somebody's application, and nothing here is confident enough to delete one outright.
    public static func moveToTrash(_ url: URL) async -> Bool {
        #if canImport(AppKit)
        // Anything it left running would keep the helper's directory and the login item in play.
        for running in NSWorkspace.shared.runningApplications
        where running.bundleURL?.standardizedFileURL == url.standardizedFileURL {
            running.terminate()
        }
        return await withCheckedContinuation { continuation in
            NSWorkspace.shared.recycle([url]) { _, error in
                continuation.resume(returning: error == nil)
            }
        }
        #else
        return false
        #endif
    }
}
