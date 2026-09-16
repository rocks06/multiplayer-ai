import SwiftUI

/// Restrained, typography-led, and native. Colour appears only where it means something: the
/// state of the connection. Nothing here shows an identifier, a token, or a cursor — those live
/// in Advanced Diagnostics, which a person has to open on purpose.
public struct MenuView: View {
    @Bindable var model: ConnectorModel
    /// Detection lives on the app, not the connector, so the menu is handed the one thing it needs.
    var detect: (() -> Void)?

    public init(model: ConnectorModel, detect: (() -> Void)? = nil) {
        self.model = model; self.detect = detect
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.enrolment == nil {
                UnenrolledView(model: model, detect: detect)
            } else if model.showingDiagnostics {
                DiagnosticsView(model: model)
            } else {
                connected
            }
        }
        .padding(16)
    }

    private var connected: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Multiplayer AI")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                    .kerning(0.6)
                if let enrolment = model.enrolment {
                    Text(enrolment.agentDisplayName ?? "This Mac")
                        .font(.system(size: 17, weight: .medium, design: .serif))
                    if let room = enrolment.roomName {
                        Text(room).font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
            }

            StatusLine(health: model.health)

            // Several agents run from one Mac. Each is stopped and started on its own, and doing
            // either to one never touches another.
            if !model.enrolments.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(model.enrolments, id: \.agentPrincipalId) { saved in
                        AgentRow(model: model, enrolment: saved)
                    }
                }
            }

            VStack(spacing: 7) {
                DetailRow(label: "Workspace",
                          value: Diagnosis.workspaceDetail(model.sidecar.state, credential: model.sidecar.credentialProblem))
                DetailRow(label: model.sidecar.state.runtime.name,
                          value: Diagnosis.runtimeDetail(model.sidecar.state),
                          warning: !model.sidecar.state.runtime.available)
                DetailRow(label: "Room", value: Diagnosis.syncDetail(model.sidecar.state))
                DetailRow(label: "Connector",
                          value: Diagnosis.processDetail(model.sidecar.state, since: model.sidecar.processStartedAt))
            }

            if let reason = model.sidecar.state.runtime.reason, !model.sidecar.state.runtime.available {
                Text(reason)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // Three different reasons a sign-in is needed, and the remedy differs, so the text
            // is chosen by cause rather than by the headline they happen to share.
            if let problem = model.sidecar.credentialProblem {
                Text(problem.recovery)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if model.health == .authRequired {
                Text("The workspace refused this agent's credential. Choose Detect Agent and connect it again; while you are signed in, no code is needed.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let notice = model.notice {
                Text(notice).font(.system(size: 11)).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()

            HStack(spacing: 8) {
                Button("Reconnect") { Task { await model.reconnect() } }
                    .disabled(model.busy)
                Button("Diagnostics") { model.showingDiagnostics = true }
                Spacer()
                Menu {
                    Toggle("Open at login", isOn: Binding(
                        get: { LoginItem.enabled },
                        set: { $0 ? LoginItem.enable() : LoginItem.disable() }))
                    Divider()
                    Button("Sign out this Mac") { Task { await model.signOut() } }
                    Button("Quit Connector") { NSApplication.shared.terminate(nil) }
                } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
            .font(.system(size: 12))
        }
    }
}

/// One agent on this Mac: who it is, where it works, what it is doing, and the one action that fits.
struct AgentRow: View {
    @Bindable var model: ConnectorModel
    let enrolment: Keychain.Enrolment

    var body: some View {
        let health = model.health(of: enrolment.agentPrincipalId)
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(enrolment.agentDisplayName ?? "Agent").font(.system(size: 12, weight: .medium))
                Text([enrolment.roomName, health.title].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if health == .connected || health == .reconnecting || health == .replaced {
                Button("Disconnect") { Task { await model.disconnect(principalId: enrolment.agentPrincipalId) } }
                    .disabled(model.busy)
            } else if health != .disconnected {
                Button("Reconnect") { Task { await model.reconnect(principalId: enrolment.agentPrincipalId) } }
                    .disabled(model.busy)
            }
        }
        .font(.system(size: 12))
        .accessibilityElement(children: .combine)
    }
}

public struct StatusLine: View {
    let health: Health
    public init(health: Health) { self.health = health }
    public var body: some View {
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(health.title).font(.system(size: 13, weight: .medium))
            Spacer()
        }
        .padding(.vertical, 9)
        .padding(.horizontal, 11)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(0.04)))
    }
    private var color: Color {
        switch health.tone {
        case .good: return .green
        case .working: return .orange
        case .stopped: return .red
        case .idle: return .secondary
        }
    }
}

public struct DetailRow: View {
    let label: String
    let value: String
    var warning = false
    public init(label: String, value: String, warning: Bool = false) { self.label = label; self.value = value; self.warning = warning }
    public var body: some View {
        HStack {
            Text(label).font(.system(size: 12)).foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.system(size: 12))
                .foregroundStyle(warning ? Color.orange : Color.primary)
                .multilineTextAlignment(.trailing)
        }
    }
}

/**
 * What an unconnected Mac is offered first.
 *
 * This used to be the enrollment-code field and nothing else, so the ordinary case — the agent is
 * running on this very Mac, and the person is signed in on it — was presented as though it needed
 * a code copied from somewhere else. There was no code to copy: the workspace's Connect existing
 * agent does same-device detection and never issues one. Two flows that never met.
 *
 * Detection is the offer. A code is still the honest answer for a Mac nobody is signed in on, or
 * a runtime on a machine with no screen, so it stays — one deliberate click away.
 */
struct UnenrolledView: View {
    @Bindable var model: ConnectorModel
    var detect: (() -> Void)?
    @State private var manual = false

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Multiplayer AI")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                    .kerning(0.6)
                Text("Connect your agent")
                    .font(.system(size: 17, weight: .medium, design: .serif))
            }

            if manual {
                EnrolView(model: model)
                Button("Back") { manual = false }
                    .buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(.secondary)
            } else {
                Text("Multiplayer AI can look for an agent runtime already running on this Mac.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if let detect {
                    Button("Detect Agent") { detect() }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.busy)
                }

                DisclosureGroup("Advanced") {
                    Button("Connect with code") { manual = true }
                        .buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
        }
    }
}
