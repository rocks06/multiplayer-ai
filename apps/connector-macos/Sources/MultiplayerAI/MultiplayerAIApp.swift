import SwiftUI
import ConnectorUI

/// Multiplayer AI.
///
/// One application, one process, one credential. The window is the product; the menu bar is a
/// place to glance at it. What used to be a separate Connector is not a second product any more
/// — it is this app's background half, started by this app, reported by this app, and signed out
/// of from this app.
@main
struct MultiplayerAIApp: App {
    /* The delegate owns the model, rather than a scene owning it.

       A sign-in link can launch this app, and it arrives before any scene exists — with a menu
       bar item in the scene list, a window is not even guaranteed. Anything the app needs in
       order to answer that link therefore cannot be created by a view: the model is built with
       the delegate, before launching finishes, and looks at the world on its own. */
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    private var app: AppModel { delegate.model }

    var body: some Scene {
        WindowGroup("Multiplayer AI") {
            RootView(app: app)
        }
        .defaultSize(width: 1180, height: 800)
        .windowToolbarStyle(.unifiedCompact(showsTitle: false))
        .commands { CommandGroup(replacing: .newItem) {} }

        // The status surface. Supporting, not the product: everything it offers is available in
        // the window, and closing the window does not take it away.
        MenuBarExtra {
            MenuView(model: app.connector).frame(width: 320)
        } label: {
            Image(nsImage: MenuBarIcon.image(for: app.connector.health))
        }
        .menuBarExtraStyle(.window)
    }
}

/// Multiplayer AI keeps its agent connected whether or not a window is open, so closing the last
/// window must not quit it — and clicking the Dock icon has to bring the window back.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    /* Where sign-in links actually arrive.
     
       AppKit delivers an opened URL to the application delegate, and it does so early — before
       any scene exists when the app is launched *by* a link, which is the ordinary way in.
       SwiftUI's `onOpenURL` is attached to a view, and on a cold launch there is no view yet:
       the link was simply never seen. Handling it here means it cannot be missed, and links that
       land before the model exists wait in `arrived` rather than being dropped. */
    let model = AppModel()
    private var arrived: [URL] = []

    /* SwiftUI installs its own application delegate and does not forward `application(_:open:)`
       to an adapted one; it routes opened URLs to `onOpenURL`, which is attached to a view. On a
       cold launch by a link there is no view yet, and with a MenuBarExtra in the scene list a
       window is not guaranteed at all — so the link was received by nothing and disappeared. The
       Apple Event that carries it is claimed directly here instead, which fires whether or not
       anything is on screen. */
    private func claimURLEvent() {
        // Registered *after* SwiftUI has installed its own, because the last registration wins.
        // SwiftUI's routes to `onOpenURL` on a view, and answers nothing when there is no view —
        // which is why opening a link timed out with -1712 instead of doing anything.
        NSAppleEventManager.shared().setEventHandler(
            self, andSelector: #selector(handleURLEvent(_:reply:)),
            forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    @objc private func handleURLEvent(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let string = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              let url = URL(string: string) else { return }
        receive(url)
    }

    private func receive(_ url: URL) {
        Task { await model.receive(authURL: url.absoluteString) }
        // A link is the ordinary way in, so make sure there is something on screen to arrive at.
        NSApp.activate(ignoringOtherApps: true)
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls { receive(url) }
    }


    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows visible: Bool) -> Bool {
        guard !visible else { return true }
        for window in sender.windows where window.canBecomeMain {
            window.makeKeyAndOrderFront(nil)
            return true
        }
        return true
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        URLScheme.claim()
        claimURLEvent()
    }
}
