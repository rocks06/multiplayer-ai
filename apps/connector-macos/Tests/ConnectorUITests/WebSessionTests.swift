import Testing
import Foundation
@testable import ConnectorUI

/// The seam between the native half and the product.
///
/// If the cookie does not cross, the workspace loads signed out and the app is two applications
/// again. If the wrong things cross, or the wrong URLs are treated as the product, the window
/// becomes a browser. Both are checked here rather than in a running web view.
@Suite struct WebSessionTests {
    private let base = URL(string: "http://127.0.0.1:4100")!

    private func cookie(name: String, value: String, domain: String,
                        expires: Date? = nil) -> HTTPCookie {
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: name, .value: value, .domain: domain, .path: "/",
        ]
        if let expires { properties[.expires] = expires }
        return HTTPCookie(properties: properties)!
    }

    @Test func theSessionCookieCrossesToTheWebView() {
        let jar = [cookie(name: "mpai_session", value: "mpss_abc", domain: "127.0.0.1")]
        let crossing = WebSession.cookies(for: base, from: jar)
        #expect(crossing.count == 1)
        #expect(WebSession.hasSession(for: base, from: jar))
    }

    /// Nothing belonging to anywhere else travels. The jar is shared with every other host the
    /// app has ever spoken to, and handing those to the workspace would be a leak.
    @Test func cookiesForOtherHostsStayBehind() {
        let jar = [
            cookie(name: "mpai_session", value: "mpss_abc", domain: "127.0.0.1"),
            cookie(name: "tracking", value: "nope", domain: "example.com"),
        ]
        let crossing = WebSession.cookies(for: base, from: jar)
        #expect(crossing.map(\.name) == ["mpai_session"])
    }

    /// An expired cookie would load the product inside a signed-in shell that every request
    /// then bounced out of — worse than arriving signed out, because nothing would explain it.
    @Test func anExpiredSessionDoesNotCross() {
        let jar = [cookie(name: "mpai_session", value: "mpss_abc", domain: "127.0.0.1",
                          expires: Date(timeIntervalSinceNow: -60))]
        #expect(WebSession.cookies(for: base, from: jar).isEmpty)
        #expect(WebSession.hasSession(for: base, from: jar) == false)
    }

    @Test func aClearedSessionIsNotASession() {
        let jar = [cookie(name: "mpai_session", value: "", domain: "127.0.0.1")]
        #expect(WebSession.hasSession(for: base, from: jar) == false)
    }

    // ------------------------------------------------------------- where it opens

    @Test func someoneWithNoHistoryLandsOnHome() {
        #expect(WebSession.entryURL(base: base, lastPath: nil).path == "/home")
    }

    @Test func aReturningPersonLandsBackInTheirRoom() {
        let url = WebSession.entryURL(base: base, lastPath: "/rooms/c1/r1")
        #expect(url.absoluteString == "http://127.0.0.1:4100/rooms/c1/r1")
    }

    /// A remembered path is data, and data cannot be allowed to choose a host.
    @Test func arememberedPathCannotSendTheWindowSomewhereElse() {
        for hostile in ["//evil.example.com/", "https://evil.example.com/rooms/a/b", "rooms/a/b"] {
            #expect(WebSession.entryURL(base: base, lastPath: hostile).path == "/home",
                    "\(hostile) must not be followed")
        }
    }

    // --------------------------------------------------------------- what is ours

    @Test func theProductIsInternalAndTheRestIsNot() {
        #expect(WebSession.isInternal(URL(string: "http://127.0.0.1:4100/rooms/a/b")!, base: base))
        #expect(!WebSession.isInternal(URL(string: "https://example.com/docs")!, base: base))
        // A different port on the same host is a different workspace, not this one.
        #expect(!WebSession.isInternal(URL(string: "http://127.0.0.1:9999/home")!, base: base))
    }

    @Test func onlyARoomIsWorthReopeningInto() {
        #expect(WebSession.rememberablePath(URL(string: "http://127.0.0.1:4100/rooms/c1/r1")!) == "/rooms/c1/r1")
        #expect(WebSession.rememberablePath(URL(string: "http://127.0.0.1:4100/home")!) == nil)
        #expect(WebSession.rememberablePath(URL(string: "http://127.0.0.1:4100/settings")!) == nil)
    }

    /// Signing out inside the product must hand back to the native side, or the app shows a
    /// second sign-in screen belonging to its other half.
    @Test func theProductsOwnFrontDoorIsRecognised() {
        for path in ["/", "/signin", "/signup"] {
            #expect(WebSession.isSignedOutLanding(URL(string: "http://127.0.0.1:4100\(path)")!),
                    "\(path) is a signed-out landing")
        }
        #expect(!WebSession.isSignedOutLanding(URL(string: "http://127.0.0.1:4100/home")!))
        #expect(!WebSession.isSignedOutLanding(URL(string: "http://127.0.0.1:4100/rooms/c/r")!))
    }
}

/// What the app says over the top of the product, and when it says nothing at all.
@Suite struct WorkspaceAlertTests {
    private let hermes = SidecarState.Runtime(available: true, name: "Hermes Agent", version: "0.20.5")
    private let missing = SidecarState.Runtime(available: false, name: "Hermes Agent",
                                               reason: "Hermes was not found on this Mac.")

    @Test func aWorkingAgentIsNotWorthInterrupting() {
        #expect(WorkspaceAlert.current(health: .connected, runtime: hermes) == nil)
    }

    @Test func everyOtherStateSaysSomething() {
        for health in [Health.notConnected, .reconnecting, .offline, .runtimeUnavailable, .authRequired] {
            let alert = WorkspaceAlert.current(health: health, runtime: missing)
            #expect(alert != nil, "\(health.title) must not be silent")
            #expect(!(alert?.detail.isEmpty ?? true), "\(health.title) must say more than its name")
        }
    }

    /// Reconnect is offered only where pressing it could actually change something.
    @Test func reconnectIsOfferedOnlyWhereItWouldHelp() {
        #expect(WorkspaceAlert.current(health: .offline, runtime: hermes)?.offersReconnect == true)
        #expect(WorkspaceAlert.current(health: .authRequired, runtime: hermes)?.offersReconnect == true)
        #expect(WorkspaceAlert.current(health: .reconnecting, runtime: hermes)?.offersReconnect == false)
        #expect(WorkspaceAlert.current(health: .runtimeUnavailable, runtime: missing)?.offersReconnect == false)
    }

    @Test func aMissingRuntimeCarriesTheRuntimesOwnReason() {
        let alert = WorkspaceAlert.current(health: .runtimeUnavailable, runtime: missing)
        #expect(alert?.detail == "Hermes was not found on this Mac.")
        #expect(alert?.title.contains("Hermes Agent") == true)
    }
}
