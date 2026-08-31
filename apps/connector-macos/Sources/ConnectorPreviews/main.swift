import SwiftUI
import AppKit
import ConnectorUI

/// Renders the Connector's real views to PNGs, at the states that are hard to produce on demand.
///
/// These are the shipping views drawn with hand-written states — not mock-ups of them — so the
/// design can be looked at without a menu bar, and so a state like a revoked credential can be
/// seen without revoking one. Nothing here runs the helper or touches the Keychain.
@MainActor
func render<V: View>(_ view: V, to url: URL, width: CGFloat = 320) {
    let renderer = ImageRenderer(content: view.frame(width: width).background(Color(nsColor: .windowBackgroundColor)))
    renderer.scale = 2
    guard let image = renderer.nsImage,
          let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else {
        print("could not render \(url.lastPathComponent)"); return
    }
    try? png.write(to: url)
    print("✓ \(url.lastPathComponent)")
}

func state(gateway: String, running: Bool = true, enrolled: Bool = true,
           hermes: Bool = true, pending: Int = 0, seq: Int? = 24, error: String? = nil) -> SidecarState {
    SidecarState(
        enrolled: enrolled, running: running, startedAt: nil, gateway: gateway,
        runtime: .init(available: hermes, name: "Hermes Agent",
                       version: hermes ? "0.19.1" : nil,
                       path: hermes ? "/usr/local/bin/hermes" : nil,
                       reason: hermes ? nil : "Hermes was not found on this Mac. Install it, then check again."),
        sync: .init(lastContiguousSeq: seq, pending: pending),
        identity: .init(agentDisplayName: "Agent A", roomName: "Developer API", projectName: "Developer API"),
        lastError: error)
}

let enrolment = Keychain.Enrolment(
    baseURL: "http://workspace.local", roomId: "r", roomName: "Developer API",
    projectName: "Developer API", agentPrincipalId: "p", agentDisplayName: "Agent A")

let out = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "./previews")
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

let cases: [(String, SidecarState, Keychain.Enrolment?, CredentialProblem?)] = [
    ("01-not-set-up", state(gateway: "not_started", running: false, enrolled: false, hermes: true), nil, nil),
    ("02-not-set-up-no-hermes", state(gateway: "not_started", running: false, enrolled: false, hermes: false), nil, nil),
    ("03-connected", state(gateway: "live"), enrolment, nil),
    ("04-reconnecting", state(gateway: "reconnecting"), enrolment, nil),
    ("05-offline", state(gateway: "offline", running: false), enrolment, nil),
    ("06-runtime-unavailable", state(gateway: "live", hermes: false), enrolment, nil),
    ("07-auth-required", state(gateway: "auth_required", error: "Gateway HTTP 401"), enrolment, nil),
    ("08-catching-up", state(gateway: "live", pending: 3), enrolment, nil),
    // The two the sidecar cannot report, because it is never configured in either. Both used to
    // render as "Not set up" — an enrolled Mac being told it was a stranger.
    ("09-credential-unreadable", state(gateway: "not_started", running: false, enrolled: false),
     enrolment, .unreadable(-34018)),
    ("10-credential-missing", state(gateway: "not_started", running: false, enrolled: false),
     enrolment, .missing),
]

for (name, sidecarState, boundEnrolment, problem) in cases {
    let model = ConnectorModel(live: false, state: sidecarState, enrolment: boundEnrolment, credentialProblem: problem)
    render(MenuView(model: model), to: out.appending(path: "\(name).png"))
}

// Advanced Diagnostics, which is the only place identifiers are allowed to appear.
let diagnosticsModel = ConnectorModel(live: false, state: state(gateway: "live"), enrolment: enrolment)
diagnosticsModel.showingDiagnostics = true
render(DiagnosticsView(model: diagnosticsModel), to: out.appending(path: "09-diagnostics.png"), width: 360)

// --------------------------------------------------------------- the first run

/// The onboarding screens, drawn at the states that are hard to arrive at on purpose — a setup
/// that failed on a missing helper, a Mac with no agent runtime, an expired sign-in link. These
/// are the shipping views; nothing here is a mock-up of them.
@MainActor
func previewConnector(_ sidecarState: SidecarState) -> ConnectorModel {
    ConnectorModel(live: false, state: sidecarState, enrolment: enrolment)
}

var setUp = Progress()
setUp.setupComplete = true
setUp.companyId = "c1"
setUp.agentPrincipalId = "p1"
setUp.agentDisplayName = "Research agent"

var runningSetup = SetupProgress()
runningSetup.set(.system, .done("macOS 14.4"))
runningSetup.set(.helper, .done("Ready"))
runningSetup.set(.service, .running)

var failedSetup = SetupProgress()
failedSetup.set(.system, .done("macOS 14.4"))
failedSetup.set(.helper, .failed(what: "Part of Multiplayer AI is missing from the app.",
                                 todo: "Move Multiplayer AI to your Applications folder and open it again. If it keeps happening, download it again."))

var doneSetup = SetupProgress()
doneSetup.set(.system, .done("macOS 14.4"))
doneSetup.set(.helper, .done("Ready"))
doneSetup.set(.service, .done("Running"))
doneSetup.set(.agents, .done("Hermes Agent 0.20.5"))
doneSetup.set(.storage, .done("Ready"))
doneSetup.set(.login, .done("Opens at login"))

let withHermes = state(gateway: "not_started", running: false, enrolled: false, hermes: true)
let noHermes = state(gateway: "not_started", running: false, enrolled: false, hermes: false)

let screens: [(String, AppModel, AnyView)] = {
    func screen(_ name: String, _ model: AppModel, _ view: some View) -> (String, AppModel, AnyView) {
        (name, model, AnyView(view))
    }
    let launch = AppModel.preview(step: .welcome, connector: previewConnector(withHermes))
    let setupRunning = AppModel.preview(step: .setup, setup: runningSetup, connector: previewConnector(withHermes))
    let setupFailed = AppModel.preview(step: .setup, setup: failedSetup, connector: previewConnector(withHermes))
    let setupDone = AppModel.preview(step: .setup, setup: doneSetup, connector: previewConnector(withHermes))
    let account = AppModel.preview(step: .account, connector: previewConnector(withHermes))
    let linkSent = AppModel.preview(step: .account, connector: previewConnector(withHermes),
                                    awaitingLinkFor: "priya@acme.com")
    let linkExpired = AppModel.preview(step: .account, connector: previewConnector(withHermes),
                                       problem: .from(status: 401, code: "sign_in_invalid", message: nil),
                                       awaitingLinkFor: "priya@acme.com")
    let workspace = AppModel.preview(step: .workspace, connector: previewConnector(withHermes))
    let agentFound = AppModel.preview(step: .agent, connector: previewConnector(withHermes))
    let agentMissing = AppModel.preview(step: .agent, connector: previewConnector(noHermes))
    let room = AppModel.preview(step: .room, progress: setUp, connector: previewConnector(withHermes))
    let binding = AppModel.preview(step: .binding, progress: setUp, connector: previewConnector(withHermes))
    let offline = AppModel.preview(step: .binding, progress: setUp, connector: previewConnector(withHermes),
                                   problem: .unreachable("http://127.0.0.1:4100"))
    let reconnect = AppModel.preview(step: .reconnect, progress: setUp,
                                     connector: ConnectorModel(live: false, state: withHermes,
                                                               enrolment: enrolment,
                                                               credentialProblem: .unreadable(-34018)))
    return [
        screen("20-launch", launch, LaunchScreen(app: launch)),
        screen("21-setup-running", setupRunning, SetupScreen(app: setupRunning)),
        screen("22-setup-done", setupDone, SetupScreen(app: setupDone)),
        screen("23-setup-failed", setupFailed, SetupScreen(app: setupFailed)),
        screen("24-account", account, AccountScreen(app: account)),
        screen("25-link-sent", linkSent, AccountScreen(app: linkSent)),
        screen("26-link-expired", linkExpired, AccountScreen(app: linkExpired)),
        screen("27-workspace", workspace, WorkspaceNameScreen(app: workspace)),
        screen("28-agent-found", agentFound, AgentScreen(app: agentFound)),
        screen("29-agent-missing", agentMissing, AgentScreen(app: agentMissing)),
        screen("30-room", room, RoomScreen(app: room)),
        screen("31-binding", binding, BindingScreen(app: binding)),
        screen("32-workspace-unreachable", offline, BindingScreen(app: offline)),
        screen("33-reconnect", reconnect, ReconnectScreen(app: reconnect)),
    ]
}()

for (name, _, view) in screens {
    render(view.frame(height: 620), to: out.appending(path: "\(name).png"), width: 900)
}

print("rendered \(cases.count + 1 + screens.count) views to \(out.path)")

