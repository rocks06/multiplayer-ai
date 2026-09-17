import Foundation
import WebKit

/**
 * Tells the app which page the workspace is showing, as it changes.
 *
 * The web app moves between Home and rooms with `history.pushState`, which never finishes a web view
 * navigation, so the app only ever learned where a full page load landed. It went on believing the
 * person was in the last room loaded — and notifications about that room were suppressed as "already
 * on screen" while they sat on Home. Every same-document change now reports itself.
 */
@MainActor
final class NavigationBridge: NSObject, WKScriptMessageHandler {
    static let name = "multiplayerNavigation"
    /// Wraps history changes and back/forward so each reports the path, plus the path on load.
    static let script = """
    (() => {
      const report = () => { try { window.webkit.messageHandlers.\(name).postMessage(location.pathname + location.hash); } catch (_) {} };
      for (const method of ['pushState', 'replaceState']) {
        const original = history[method];
        history[method] = function(...args) { const result = original.apply(this, args); report(); return result; };
      }
      addEventListener('popstate', report);
      addEventListener('hashchange', report);
      report();
    })();
    """

    private let origin: URL
    private let changed: (String) -> Void

    init(origin: URL, changed: @escaping (String) -> Void) {
        self.origin = origin; self.changed = changed
    }

    static func install(in configuration: WKWebViewConfiguration, origin: URL, changed: @escaping (String) -> Void) {
        configuration.userContentController.addUserScript(
            WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        configuration.userContentController.add(NavigationBridge(origin: origin, changed: changed), name: name)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let source = message.frameInfo.request.url, WebSession.isInternal(source, base: origin),
              let path = message.body as? String else { return }
        if let clean = NavigationBridge.path(path) { changed(clean) }
    }

    /// Only a same-origin path is accepted: something that starts with one slash, of sensible length.
    nonisolated static func path(_ raw: String) -> String? {
        guard raw.hasPrefix("/"), !raw.hasPrefix("//"), raw.count <= 512 else { return nil }
        return raw
    }
}
