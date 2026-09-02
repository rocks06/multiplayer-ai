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
        .safeAreaInset(edge: .top) {
            // Two things a person needs to know before they trust a sign-in link, shown wherever
            // they are rather than only on the screen that happens to care.
            VStack(spacing: 0) {
                if let legacy = app.legacyApp { LegacyAppNotice(app: app, path: legacy) }
                if !app.handlesSignInLinks { LinkHandlerNotice() }
                if !app.moveTargets.isEmpty && !app.movePromptDismissed {
                    RoomBindingNotice(app: app)
                }
                if let runtime = app.detectedRuntime { DetectedRuntimeNotice(app: app, runtime: runtime) }
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

/// The old standalone Connector, still installed.
///
/// It carried this app's identifier, so it is not merely redundant: whichever copy macOS resolves
/// that identifier to is the one that starts at login. Saying so is worth a strip across the top;
/// removing somebody's application without asking is not.
struct LegacyAppNotice: View {
    @Bindable var app: AppModel
    let path: URL

    var body: some View {
        HStack(spacing: 11) {
            StateDot(tone: .working)
            VStack(alignment: .leading, spacing: 1) {
                Text("The old Multiplayer AI Connector is still installed")
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.ink)
                Text("This app replaces it. Leaving both can send your agent to the wrong one at login.")
                    .font(.system(size: 12)).foregroundStyle(Palette.muted)
            }
            Spacer(minLength: 16)
            Button("Move to Trash") { Task { await app.removeLegacyApp() } }
                .buttonStyle(.borderless).font(.system(size: 13, weight: .medium))
                .foregroundStyle(Palette.ink)
            Button("Not now") { app.dismissLegacyApp() }
                .buttonStyle(.borderless).font(.system(size: 13)).foregroundStyle(Palette.muted)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial)
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 1) }
        .accessibilityElement(children: .combine)
    }
}

/// Sign-in links would open something else. Better said plainly than discovered by clicking one.
struct LinkHandlerNotice: View {
    var body: some View {
        HStack(spacing: 11) {
            StateDot(tone: .stopped)
            VStack(alignment: .leading, spacing: 1) {
                Text("Sign-in links will not open this app")
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.ink)
                Text("Another copy of Multiplayer AI on this Mac is handling them. Move the one you are not using to the Trash, then open this app again.")
                    .font(.system(size: 12)).foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 16)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial)
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 1) }
        .accessibilityElement(children: .combine)
    }
}

/// Which room this Mac is working in, and the other rooms its agent belongs to.
///
/// An agent can serve one room per machine, so being a member of several is normal and this is
/// not an error. It is shown because the alternative is what happened: a Mac bound to one room
/// while somebody watched another, with nothing anywhere offering to change it. Moving is offered,
/// never performed — it abandons a live session and mints a new credential, which is a decision.
struct RoomBindingNotice: View {
    @Bindable var app: AppModel

    private var boundName: String {
        guard let bound = app.connector.enrolment?.roomId else { return "another room" }
        return app.nameOfRoom(bound) ?? "another room"
    }

    var body: some View {
        HStack(spacing: 11) {
            StateDot(tone: .working)
            VStack(alignment: .leading, spacing: 1) {
                Text("This Mac works in \(boundName)")
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.ink)
                Text("\(app.progress.agentDisplayName ?? "This agent") will not see anything addressed to it in its other rooms until it moves.")
                    .font(.system(size: 12)).foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 16)
            ForEach(app.moveTargets) { room in
                Button("Move to \(room.name)") { Task { await app.move(to: room.id) } }
                    .buttonStyle(.borderless).font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Palette.ink).disabled(app.busy)
            }
            Button("Not now") { app.movePromptDismissed = true }
                .buttonStyle(.borderless).font(.system(size: 13)).foregroundStyle(Palette.muted)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial)
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 1) }
        .accessibilityElement(children: .combine)
    }
}

/// What detection found on this Mac, stated before anything is created from it.
///
/// Connecting used to happen the moment something was found, so an agent identity could be minted
/// for a runtime that was installed but not running — and the person was told it was healthy.
/// Every state the adapter can report is named here in its own words, and only one of them offers
/// a button that creates anything.
struct DetectedRuntimeNotice: View {
    @Bindable var app: AppModel
    let runtime: SidecarState.Runtime

    var body: some View {
        HStack(spacing: 11) {
            StateDot(tone: runtime.isConnectable ? .good : .stopped)
            VStack(alignment: .leading, spacing: 1) {
                Text(runtime.situation)
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.ink)
                // The facts it was judged on, so the verdict can be checked rather than trusted.
                Text(detail).font(.system(size: 12)).foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 16)
            if runtime.isConnectable {
                Button("Connect") { Task { await app.confirmRuntimeConnection() } }
                    .buttonStyle(.borderless).font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Palette.ink).disabled(app.busy)
            } else {
                Button("Check again") { Task { await app.detectRuntime() } }
                    .buttonStyle(.borderless).font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Palette.ink).disabled(app.busy)
            }
            Button("Not now") { app.detectedRuntime = nil }
                .buttonStyle(.borderless).font(.system(size: 13)).foregroundStyle(Palette.muted)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial)
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 1) }
        .accessibilityElement(children: .combine)
    }

    private var detail: String {
        var parts: [String] = []
        if let version = runtime.version { parts.append("version \(version)") }
        if let endpoint = runtime.endpoint { parts.append(endpoint) }
        if runtime.serviceRunning == true { parts.append("gateway running") }
        if let reason = runtime.reason, !runtime.isConnectable { return reason }
        return parts.isEmpty ? "Nothing further is known about it." : parts.joined(separator: " · ")
    }
}
