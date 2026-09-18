import SwiftUI

// ------------------------------------------------------------------ 1. Launch

/// The front door. One sentence about what this is, and one thing to do.
public struct LaunchScreen: View {
    @Bindable var app: AppModel
    @State private var showingAddress = false
    @State private var address = ""

    public init(app: AppModel) { self.app = app }

    public var body: some View {
        Sheet(title: "Bring your agents into one shared workspace.",
              lead: "Multiplayer AI is where the agents you already run work together — and where you step in when it matters.") {
            if showingAddress {
                Field("Workspace address", placeholder: AppModel.defaultAddress,
                      hint: "Only needed while Multiplayer AI is running on your own machine.",
                      value: $address) { commitAddress() }
            }
        } actions: {
            VStack(alignment: .leading, spacing: 16) {
                PrimaryButton("Set up Multiplayer AI") {
                    if showingAddress { commitAddress() }
                    Task { await app.beginSetup() }
                }
                if showingAddress {
                    QuietButton("Never mind") { showingAddress = false }
                } else {
                    QuietButton("Connect to a different workspace") {
                        address = app.workspaceAddress
                        showingAddress = true
                    }
                }
            }
        }
        .overlay(alignment: .top) { WordMark() }
    }

    private func commitAddress() {
        let trimmed = address.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed != app.workspaceAddress else { return }
        Task { await app.useWorkspace(address: trimmed) }
    }
}

/// The product's name, set once at the top of the front door and nowhere else. Everywhere after
/// this, the person knows what application they are in.
struct WordMark: View {
    var body: some View {
        Text("MULTIPLAYER AI")
            .font(.system(size: 11, weight: .semibold))
            .tracking(1.6)
            .foregroundStyle(Palette.faint)
            .padding(.top, 34)
    }
}

// ------------------------------------------------------------------- 2. Setup

/// What is actually happening, while it happens.
///
/// Every line is a real operation with a real outcome. Nothing is padded to look busy, and a
/// step that could not be done says so where it happened, with the one thing that would fix it.
public struct SetupScreen: View {
    @Bindable var app: AppModel
    public init(app: AppModel) { self.app = app }

    public var body: some View {
        Sheet(title: title,
              lead: app.setup.failure == nil
                ? "Nothing to install and nothing to configure. This takes a moment."
                : nil) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(SetupTask.allCases, id: \.self) { task in
                    SetupRow(task: task, outcome: app.setup[task])
                    if task != SetupTask.allCases.last {
                        Divider().overlay(Palette.line).padding(.leading, 26)
                    }
                }
            }
            .padding(.vertical, 4)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.line, lineWidth: 1))

            if let failure = app.setup.failure {
                Problem(what: failure.what, todo: failure.todo).padding(.top, 16)
            }
        } actions: {
            if app.setup.failure != nil {
                PrimaryButton("Try again") { Task { await app.retrySetup() } }
            }
        }
    }

    private var title: String {
        app.setup.failure == nil ? "Setting up Multiplayer AI" : "Setup could not finish"
    }
}

struct SetupRow: View {
    let task: SetupTask
    let outcome: TaskOutcome

    var body: some View {
        HStack(spacing: 10) {
            marker.frame(width: 16, height: 16)
            Text(task.title)
                .font(.system(size: 14))
                .foregroundStyle(outcome == .pending ? Palette.faint : Palette.ink)
            Spacer(minLength: 12)
            if case .done(let detail) = outcome, !detail.isEmpty {
                Text(detail).font(.system(size: 12)).foregroundStyle(Palette.muted)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(accessibilityLabel))
        // Steps settle in rather than snapping; nothing about setup should feel abrupt.
        .animation(.easeOut(duration: 0.2), value: outcome)
    }

    @ViewBuilder private var marker: some View {
        switch outcome {
        case .pending:
            Circle().strokeBorder(Palette.line, lineWidth: 1.4).frame(width: 12, height: 12)
        case .running:
            ProgressView().controlSize(.small).scaleEffect(0.55)
        case .done:
            Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Palette.live)
        case .failed:
            Image(systemName: "exclamationmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.stop)
        }
    }

    private var accessibilityLabel: String {
        switch outcome {
        case .pending: return "\(task.title), waiting"
        case .running: return "\(task.title), in progress"
        case .done(let detail): return detail.isEmpty ? "\(task.title), done" : "\(task.title), \(detail)"
        case .failed(let what, _): return "\(task.title), failed. \(what)"
        }
    }
}

// ----------------------------------------------------------------- 4. Account

/// Signing in, and creating an account, on one screen — because they differ by one field and
/// asking someone which one they are before they have told you anything is a wasted decision.
public struct AccountScreen: View {
    @Bindable var app: AppModel
    /* Someone on the first run of a freshly installed app is, by definition, new.
    
       This opened on Sign in, which sent a new address to the sign-in route — and that route
       will not say an address has no account, deliberately, so nothing arrived and nothing
       could explain why. The likely case goes first; signing in is one tap away for the people
       who already have an account, and they are the ones who know that they do. */
    @State private var creating: Bool

    /**
     Which form the screen opens on. Named so it can be asserted — a default buried in view state
     is exactly what went wrong twice: nothing could see it.

     A Mac that has never had anybody signed in is a new person, who is shown Create account, since
     the sign-in route deliberately will not say an address has no account and so could never tell
     them why nothing arrived. A Mac that has — which is everyone who just signed out — is shown
     Sign in. Opening on "Create your account" after signing out read as though the account they
     had was gone.
     */
    public static func opensCreating(knowsAnAccount: Bool) -> Bool { !knowsAnAccount }
    @State private var name = ""
    @State private var email = ""
    @State private var pasted = ""

    public init(app: AppModel) {
        self.app = app
        _creating = State(initialValue: AccountScreen.opensCreating(knowsAnAccount: app.progress.knowsAnAccount))
    }

    private var lead: String {
        if creating { return "Two things, and no password. You will name your workspace next." }
        if app.justSignedOut { return "You’re signed out. Your account and your workspaces are unchanged — sign in to pick up where you left off." }
        return "No password. We email you a link that signs you in."
    }

    public var body: some View {
        if let sentTo = app.awaitingLinkFor { linkSent(to: sentTo) } else { form }
    }

    private var form: some View {
        Sheet(title: creating ? "Create your account" : "Sign in", lead: lead) {
            VStack(alignment: .leading, spacing: 16) {
                if creating {
                    Field("Your name", placeholder: "Priya Raman", value: $name) { submit() }
                }
                Field("Work email", placeholder: "you@company.com", value: $email) { submit() }
                if let problem = app.problem {
                    Problem(what: problem.message, todo: problem.recovery)
                }
            }
        } actions: {
            VStack(alignment: .leading, spacing: 16) {
                PrimaryButton(creating ? "Create account" : "Continue", busy: app.busy) { submit() }
                    .disabled(!canSubmit)
                QuietButton(creating ? "I already have an account — sign in" : "New to Multiplayer AI? Create an account") {
                    creating.toggle(); app.problem = nil; app.justSignedOut = false
                }
            }
        }
    }

    private func linkSent(to address: String) -> some View {
        let logging = app.delivery == "logging"
        return Sheet(title: logging ? "Link issued" : "Check your email",
              lead: "If \(address) can be signed in, a link is waiting. It can be used once, within fifteen minutes.") {
            VStack(alignment: .leading, spacing: 16) {
                /* Opening the link is the ordinary way through, and it lands back in this app.
                   The field stays because a link can always fail to hand over — a browser that
                   will not open the app, a message forwarded to another machine — and pasting it
                   does exactly what opening it would. Only the explanation changes with how the
                   link is actually sent. */
                Field("Or paste your sign-in link", placeholder: "https://…",
                      hint: logging
                        ? "No email provider is configured, so your workspace operator issues the link."
                        : "Opening the link from your email signs you in here.",
                      value: $pasted) { Task { await app.redeem(pasted) } }
                if let problem = app.problem {
                    Problem(what: problem.message, todo: problem.recovery)
                }
                nothingArrived()
            }
        } actions: {
            PrimaryButton("Sign in", busy: app.busy) { Task { await app.redeem(pasted) } }
                .disabled(pasted.trimmingCharacters(in: .whitespaces).isEmpty || app.busy)
        }
    }

    /**
     What to do when the email does not turn up.

     The server will never say whether an address has an account — that refusal is deliberate and
     stays. It means this screen cannot tell someone *why* nothing arrived, and the honest thing
     is therefore to lay out both roads and let them pick the one that matches what they already
     know about themselves. Waiting with no explanation is what this replaces.
     */
    private func nothingArrived() -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("Nothing arrived?")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Palette.ink)
            Text(creating
                 ? "Check your spam folder first. If you already had an account with this address, sign in instead — creating one again does not send a second link."
                 : "Check your spam folder first. A sign-in link is only sent to an address that already has an account, so if you have not set one up yet, create an account instead.")
                .font(.system(size: 13))
                .lineSpacing(2)
                .foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 18) {
                QuietButton(creating ? "Sign in instead" : "Create an account") { restart(creating: !creating) }
                QuietButton("Use a different address") { restart(creating: creating) }
            }
            .padding(.top, 1)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.line, lineWidth: 1))
    }

    /// Back to the form, in whichever mode was asked for, with nothing stale left behind.
    private func restart(creating wanted: Bool) {
        creating = wanted
        app.awaitingLinkFor = nil
        app.problem = nil
        pasted = ""
    }

    private var canSubmit: Bool {
        guard !app.busy, email.contains("@"), !email.hasPrefix("@") else { return false }
        return !creating || !name.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func submit() {
        guard canSubmit else { return }
        Task {
            if creating { await app.createAccount(name: name.trimmingCharacters(in: .whitespaces), email: email) }
            else { await app.requestSignInLink(email: email) }
        }
    }
}

// --------------------------------------------------------------- 5a. Workspace

public struct WorkspaceNameScreen: View {
    @Bindable var app: AppModel
    @State private var name = ""
    public init(app: AppModel) { self.app = app }

    public var body: some View {
        Sheet(title: "Name your workspace",
              lead: "A workspace is where your agents work together, and where you can see what they are doing.") {
            VStack(alignment: .leading, spacing: 16) {
                Field("Workspace name", placeholder: "Acme", value: $name) { submit() }
                if let problem = app.problem { Problem(what: problem.message, todo: problem.recovery) }
            }
        } actions: {
            PrimaryButton("Continue", busy: app.busy) { submit() }
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || app.busy)
        }
    }

    private func submit() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !app.busy else { return }
        Task { await app.createWorkspace(name: trimmed) }
    }
}

// ----------------------------------------------------------- 3. Bring your agent

/// The product's position, stated as a screen: Multiplayer AI does not create an agent. It finds
/// the one already running here, gives it an identity, and brings it in.
public struct AgentScreen: View {
    @Bindable var app: AppModel
    @State private var name = ""
    public init(app: AppModel) { self.app = app }

    private var runtime: SidecarState.Runtime { app.connector.sidecar.state.runtime }

    public var body: some View {
        Sheet(title: "Connect your existing agent",
              lead: "Find independently runnable agent profiles on this Mac and connect one to your room.") {
            Text("Detection checks the local runtime before creating any workspace identity.")
                .foregroundStyle(Palette.muted)
        } actions: {
            PrimaryButton("Detect Agent") { Task { await app.detectRuntime() } }
        }
        .sheet(isPresented: $app.showingAgentDiscovery, onDismiss: { app.dismissAgentDiscovery() }) { AgentDiscoverySheet(app: app) }
    }

    private var runtimeCard: some View {
        HStack(alignment: .top, spacing: 11) {
            StateDot(tone: runtime.available ? .good : .idle).padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                Text(runtime.available
                     ? "\(runtime.name) \(runtime.version ?? "")".trimmingCharacters(in: .whitespaces)
                     : "No supported agent found on this Mac")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Palette.ink)
                Text(runtime.available
                     ? "Found on this Mac and ready to join your workspace."
                     : (runtime.reason ?? "Multiplayer AI supports Hermes today. Install it on this Mac, then look again."))
                    .font(.system(size: 13))
                    .foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.line, lineWidth: 1))
    }

    private func submit() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !app.busy else { return }
        Task { await app.registerAgent(name: trimmed) }
    }
}

// -------------------------------------------------------------------- 5b. Room

/// Where the agent works.
///
/// Only one choice is offered, because only one exists: joining somebody else's room needs a way
/// to be invited into their workspace, and there is not one yet. The screen is built around a
/// list of options so that Join takes its place beside Create the day it becomes real — but it
/// does not show a door that opens onto nothing.
public struct RoomScreen: View {
    @Bindable var app: AppModel
    @State private var name = ""
    @State private var objective = ""
    public init(app: AppModel) { self.app = app }

    public var body: some View {
        Sheet(title: "Where should \(app.progress.agentDisplayName ?? "your agent") work?",
              lead: "A room is one objective, the people watching it, and the agents working on it.") {
            VStack(alignment: .leading, spacing: 18) {
                Choice(title: "Create a room", detail: "Name it, say what it is for, and your agent joins it.", selected: true)
                VStack(alignment: .leading, spacing: 16) {
                    Field("Room name", placeholder: "Developer API", value: $name) { submit() }
                    Field("What should they achieve?", placeholder: "Launch the public developer API",
                          value: $objective) { submit() }
                }
                .padding(.leading, 2)
                if let problem = app.problem { Problem(what: problem.message, todo: problem.recovery) }
            }
        } actions: {
            PrimaryButton("Create the room", busy: app.busy) { submit() }
                .disabled(!canSubmit)
        }
    }

    private var canSubmit: Bool {
        !app.busy
            && !name.trimmingCharacters(in: .whitespaces).isEmpty
            && !objective.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func submit() {
        guard canSubmit else { return }
        Task {
            await app.createRoom(name: name.trimmingCharacters(in: .whitespaces),
                                 objective: objective.trimmingCharacters(in: .whitespaces))
        }
    }
}

struct Choice: View {
    let title: String
    let detail: String
    let selected: Bool
    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                .font(.system(size: 14))
                .foregroundStyle(selected ? Palette.ink : Palette.line)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 14, weight: .medium)).foregroundStyle(Palette.ink)
                Text(detail).font(.system(size: 13)).foregroundStyle(Palette.muted)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

// ---------------------------------------------------------------- 6. Binding

/// The step nobody is asked to take part in.
///
/// The person is signed in, in this app, on the machine their agent runs on — so there is nobody
/// to carry a code between and nothing to type. This exists as a screen only because it can
/// fail, and a failure has to be somewhere.
public struct BindingScreen: View {
    @Bindable var app: AppModel
    public init(app: AppModel) { self.app = app }

    public var body: some View {
        Sheet(title: app.problem == nil ? "Connecting your agent" : "Your agent could not be connected",
              lead: app.problem == nil
                ? "Giving \(app.progress.agentDisplayName ?? "your agent") its identity on this Mac."
                : nil) {
            if let problem = app.problem {
                Problem(what: problem.message, todo: problem.recovery)
            } else {
                ProgressView().controlSize(.small)
            }
        } actions: {
            if app.problem != nil {
                PrimaryButton("Try again") { Task { await app.bind() } }
            }
        }
        .task { if app.problem == nil { await app.bind() } }
    }
}

/// Set up, but unable to prove it. The one case where an enrollment code is not the answer and
/// re-binding is — kept as its own screen so nobody is told to start over.
public struct ReconnectScreen: View {
    @Bindable var app: AppModel
    public init(app: AppModel) { self.app = app }

    public var body: some View {
        Sheet(title: "Sign-in needed on this Mac",
              lead: app.connector.sidecar.credentialProblem?.recovery) {
            if let problem = app.problem { Problem(what: problem.message, todo: problem.recovery) }
        } actions: {
            VStack(alignment: .leading, spacing: 16) {
                PrimaryButton("Reconnect this Mac", busy: app.busy) { Task { await app.rebind() } }
                QuietButton("Start this Mac over") { Task { await app.resetThisMac() } }
            }
        }
    }
}
