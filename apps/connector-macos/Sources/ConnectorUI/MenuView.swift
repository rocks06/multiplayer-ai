import SwiftUI

/// Restrained, typography-led, and native. Colour appears only where it means something: the
/// state of the connection. Nothing here shows an identifier, a token, or a cursor — those live
/// in Advanced Diagnostics, which a person has to open on purpose.
public struct MenuView: View {
    @Bindable var model: ConnectorModel

    public init(model: ConnectorModel) { self.model = model }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.enrolment == nil {
                EnrolView(model: model)
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
                Text("This Mac's access was removed or expired. Sign out and enter a new code from your workspace.")
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
