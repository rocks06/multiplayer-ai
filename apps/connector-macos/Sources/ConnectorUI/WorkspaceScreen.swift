import SwiftUI
import WebKit

/// The product, inside the app.
///
/// This is the room that already exists — the same Home, rooms, presence, tasks, decisions and
/// approvals, running the code they have always run. Nothing about it is reimplemented here.
/// What the native side contributes is the two things a browser tab cannot: the session arrives
/// already signed in, and when the agent on this Mac is in trouble the app says so over the top
/// of the product rather than leaving it to be inferred.
public struct WorkspaceScreen: View {
    @Bindable var app: AppModel
    public init(app: AppModel) { self.app = app }

    public var body: some View {
        ZStack(alignment: .top) {
            WorkspaceWebView(app: app).ignoresSafeArea()
            if let alert = WorkspaceAlert.current(health: app.connector.health,
                                                  runtime: app.connector.sidecar.state.runtime) {
                banner(alert)
            }
        }
        .background(Palette.paper)
    }

    private func banner(_ alert: WorkspaceAlert) -> some View {
        HStack(spacing: 10) {
            StateDot(tone: alert.tone)
            VStack(alignment: .leading, spacing: 1) {
                Text(alert.title).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.ink)
                Text(alert.detail).font(.system(size: 12)).foregroundStyle(Palette.muted)
            }
            Spacer(minLength: 16)
            if alert.offersReconnect {
                Button("Reconnect") { Task { await app.connector.reconnect() } }
                    .buttonStyle(.borderless)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Palette.ink)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.line, lineWidth: 1))
        .shadow(color: .black.opacity(0.12), radius: 18, y: 6)
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .transition(.move(edge: .top).combined(with: .opacity))
        .animation(.easeOut(duration: 0.22), value: alert)
        .accessibilityElement(children: .combine)
    }
}

/// When the app should speak over the product, and what it should say. Pure, so every message a
/// person can be shown here is decided from state that can be written down in a test.
public struct WorkspaceAlert: Equatable, Sendable {
    public let title: String
    public let detail: String
    public let tone: Health.Tone
    public let offersReconnect: Bool

    /// A connected agent needs no banner at all. Everything else is named for what has actually
    /// stopped — the Connector's own rule, applied to the one surface it did not previously
    /// reach.
    public static func current(health: Health, runtime: SidecarState.Runtime) -> WorkspaceAlert? {
        switch health {
        case .connected:
            return nil
        case .notConnected:
            return .init(title: "This Mac's agent is not connected",
                         detail: "Your workspace still works. The agent here cannot take part until it is connected.",
                         tone: .idle, offersReconnect: false)
        case .reconnecting:
            return .init(title: "Reconnecting", detail: "Picking up where your agent left off.",
                         tone: .working, offersReconnect: false)
        // Replaced by a newer connection for the same agent — ordinarily this Mac itself, moments
        // ago. It resolves on its own, so it reads as reconnecting and offers nothing to press.
        case .replaced:
            return .init(title: "Reconnecting", detail: "Your agent came back on a newer connection.",
                         tone: .working, offersReconnect: false)
        case .offline:
            return .init(title: "Your agent is offline",
                         detail: "It is not running on this Mac right now. Nothing it had done is lost.",
                         tone: .idle, offersReconnect: true)
        case .runtimeUnavailable:
            return .init(title: "\(runtime.name) is not available on this Mac",
                         detail: runtime.reason ?? "Install it here, and your agent can start working again.",
                         tone: .stopped, offersReconnect: false)
        case .authRequired:
            return .init(title: "Sign-in needed on this Mac",
                         detail: "Your agent cannot prove who it is. Reconnect it to fix this.",
                         tone: .stopped, offersReconnect: true)
        }
    }
}

/// The web view itself, and the three things it has to do beyond showing a page: carry the
/// session in, keep the app's idea of where the person is up to date, and refuse to become a
/// browser for the rest of the internet.
struct WorkspaceWebView: NSViewRepresentable {
    let app: AppModel

    func makeCoordinator() -> Coordinator { Coordinator(app: app) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        view.setValue(false, forKey: "drawsBackground")
        context.coordinator.attach(view)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private let app: AppModel
        private var loaded = false
        init(app: AppModel) { self.app = app }

        /// Hand the web view the session before it asks for anything.
        ///
        /// Without this the product would load signed out and mint a second session of its own,
        /// and signing out of one would leave the other standing. Copying the cookie makes them
        /// one signed-in person, which is what "one app" has to mean.
        func attach(_ view: WKWebView) {
            guard !loaded else { return }
            loaded = true
            Task { @MainActor in
                let base = view.url ?? URL(string: app.workspaceAddress)!
                let jar = HTTPCookieStorage.shared.cookies ?? []
                let store = view.configuration.websiteDataStore.httpCookieStore
                for cookie in WebSession.cookies(for: URL(string: app.workspaceAddress) ?? base, from: jar) {
                    await store.setCookie(cookie)
                }
                view.load(URLRequest(url: app.entryURL))
            }
        }

        func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url,
                  let base = URL(string: app.workspaceAddress) else {
                decisionHandler(.allow); return
            }
            guard WebSession.isInternal(url, base: base) else {
                // A link out of the product is a link out of the app. Opening it in this window
                // would strand someone inside a web page with no way back to their room.
                decisionHandler(.cancel)
                NSWorkspace.shared.open(url)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
            guard let url = view.url else { return }
            app.remember(path: WebSession.rememberablePath(url))
            // Signing out inside the product sends it to its own front door. That is the native
            // side's job, so the app takes the person back rather than showing them a second
            // sign-in screen that belongs to a different half of the same application.
            if WebSession.isSignedOutLanding(url) {
                Task { await app.signOutOfAccount() }
            }
        }

        func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            app.problem = .unreachable(app.workspaceAddress)
        }

        func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            app.problem = .unreachable(app.workspaceAddress)
        }

        /// `target="_blank"` never opens a second window inside the app.
        func webView(_ view: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url { NSWorkspace.shared.open(url) }
            return nil
        }
    }
}
