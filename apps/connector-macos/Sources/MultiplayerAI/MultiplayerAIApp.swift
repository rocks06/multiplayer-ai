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
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var app = AppModel()

    var body: some Scene {
        WindowGroup("Multiplayer AI") {
            RootView(app: app)
                .onOpenURL { url in
                    // A sign-in link opening the app. The token is redeemed here rather than in
                    // a browser, which is what keeps signing in inside the application.
                    Task { await app.redeem(url.absoluteString) }
                }
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
final class AppDelegate: NSObject, NSApplicationDelegate {
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
    }
}
