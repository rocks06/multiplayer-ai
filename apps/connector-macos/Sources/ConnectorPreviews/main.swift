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

print("rendered \(cases.count + 1) views to \(out.path)")
