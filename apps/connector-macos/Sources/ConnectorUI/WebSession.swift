import Foundation

/// Making the embedded workspace the same signed-in person as the native screens.
///
/// Signing in happens natively, so the session cookie the server set lands in the app's own
/// cookie jar. The web view has a separate one. Rather than authenticate twice — which would
/// mint a second session and mean signing out of one did not sign out of the other — the cookie
/// is copied across before the workspace is loaded, and the product then behaves exactly as it
/// does in a browser, because as far as it can tell it is in one.
public enum WebSession {
    public static let sessionCookieName = "mpai_session"

    /// Which cookies the web view has to be given for this workspace. Pure, so the choice can be
    /// checked without a web view, a network, or a signed-in person.
    ///
    /// Only cookies belonging to this workspace's host travel, and only ones that have not
    /// expired: handing over a stale cookie would put the product in a signed-in shell that
    /// every request then bounced out of.
    public static func cookies(for base: URL, from jar: [HTTPCookie], now: Date = Date()) -> [HTTPCookie] {
        guard let host = base.host?.lowercased() else { return [] }
        return jar.filter { cookie in
            let domain = cookie.domain.lowercased()
            let matches = domain == host
                || (domain.hasPrefix(".") && (host == String(domain.dropFirst()) || host.hasSuffix(domain)))
            guard matches else { return false }
            if let expires = cookie.expiresDate, expires <= now { return false }
            return true
        }
    }

    /// Whether a jar actually carries a usable session for this workspace. What the app checks
    /// before claiming someone is signed in, rather than assuming a successful sign-in earlier
    /// in the session is still true.
    public static func hasSession(for base: URL, from jar: [HTTPCookie], now: Date = Date()) -> Bool {
        cookies(for: base, from: jar, now: now).contains { $0.name == sessionCookieName && !$0.value.isEmpty }
    }

    /// Where inside the workspace to open.
    ///
    /// A returning person goes back to the room they were in; anyone else goes to Home, which
    /// works out for itself what the account has. Only paths belonging to this workspace are
    /// honoured, so a remembered path can never send the web view somewhere else.
    public static func entryURL(base: URL, lastPath: String?) -> URL {
        guard let lastPath, lastPath.hasPrefix("/"), !lastPath.hasPrefix("//"),
              let url = URL(string: lastPath, relativeTo: base), url.host == base.host else {
            return URL(string: "/home", relativeTo: base)?.absoluteURL ?? base
        }
        return url.absoluteURL
    }

    /// Whether a URL the web view is trying to reach belongs to the product. Anything else is a
    /// link out — a person following one should get their browser, not have the workspace
    /// replaced by a web page inside the app window.
    public static func isInternal(_ url: URL, base: URL) -> Bool {
        guard let host = url.host?.lowercased(), let baseHost = base.host?.lowercased() else { return false }
        guard host == baseHost else { return false }
        return url.port == base.port
    }

    /// The path worth remembering from wherever the web view ended up. Only a room: Home and the
    /// settings page are places you pass through, and reopening the app into one of them instead
    /// of the room someone was working in would be worse than useless.
    public static func rememberablePath(_ url: URL) -> String? {
        let path = url.path
        guard path.hasPrefix("/rooms/") else { return nil }
        return path
    }

    /// Whether the product has landed on its own signed-out pages.
    ///
    /// Signing out inside the room sends the web app to its front door. In a browser that is
    /// exactly right; inside this app it would show a second sign-in screen belonging to the
    /// other half of the same application. Recognising those landings lets the native side take
    /// the person back, so there is only ever one place to sign in.
    public static func isSignedOutLanding(_ url: URL) -> Bool {
        let path = url.path
        return path == "/" || path.isEmpty || path == "/signin" || path == "/signup"
    }
}
