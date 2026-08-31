import Foundation
#if canImport(AppKit)
import AppKit
#endif

/// Making sure a sign-in link opens *this* app.
///
/// Declaring the scheme in the bundle is enough for macOS to know the app can handle it. It is
/// not enough to guarantee the app is the one asked: a leftover copy elsewhere on the disk — an
/// old download, a build in a folder, the previous version still in the Trash — can hold the
/// claim, and then a link opens something that is not the product a person just installed.
///
/// Asserting the claim on every launch costs nothing and settles it. Whatever was opened last is
/// what sign-in links go to, which is the behaviour a person would expect anyway.
public enum URLScheme {
    public static let name = "multiplayerai"

    /// Whichever bundle is running now takes the claim.
    public static func claim() {
        #if canImport(AppKit)
        guard let identifier = Bundle.main.bundleIdentifier else { return }
        LSSetDefaultHandlerForURLScheme(name as CFString, identifier as CFString)
        #endif
    }

    /// Who macOS would actually hand a link to. Nil when nothing claims it at all.
    public static func currentHandler() -> String? {
        #if canImport(AppKit)
        guard let url = URL(string: "\(name)://auth"),
              let app = NSWorkspace.shared.urlForApplication(toOpen: url) else { return nil }
        return Bundle(url: app)?.bundleIdentifier
        #else
        return nil
        #endif
    }

    /// Whether links will reach this build. What the app checks before promising anything about
    /// a link, rather than assuming the declaration in its own bundle was the last word.
    public static func claimedByThisApp() -> Bool {
        guard let identifier = Bundle.main.bundleIdentifier else { return false }
        return currentHandler() == identifier
    }
}
