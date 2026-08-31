import SwiftUI

/// Which screen the window is showing, and nothing else.
///
/// The decision is not made here — it is made by `Onboarding.step(for:)` from what is actually
/// true, and this only draws the answer. That separation is why a person who quits during setup,
/// loses a session overnight, or has their agent removed by somebody else lands on the one
/// screen that addresses it instead of at the beginning.
public struct RootView: View {
    @Bindable var app: AppModel
    @State private var ready = false

    public init(app: AppModel) { self.app = app }

    public var body: some View {
        Group {
            if !ready {
                // Deciding, not loading. It lasts one request and says so with nothing at all,
                // because a spinner that flashes for 80ms is noise.
                Color.clear
            } else {
                switch app.step {
                case .welcome:   LaunchScreen(app: app)
                case .setup:     SetupScreen(app: app)
                case .account:   AccountScreen(app: app)
                case .workspace: WorkspaceNameScreen(app: app)
                case .agent:     AgentScreen(app: app)
                case .room:      RoomScreen(app: app)
                case .binding:   BindingScreen(app: app)
                case .reconnect: ReconnectScreen(app: app)
                case .ready:     WorkspaceScreen(app: app)
                }
            }
        }
        .frame(minWidth: 720, minHeight: 560)
        .background(Palette.paper)
        // A step change is a change of subject, not a slide across a filmstrip: it settles in.
        .animation(.easeOut(duration: 0.22), value: app.step)
        .task {
            await app.refresh()
            ready = true
        }
    }
}
