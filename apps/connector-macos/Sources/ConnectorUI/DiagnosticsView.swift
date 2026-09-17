import SwiftUI
import AppKit

/// Advanced Diagnostics: the only place identifiers, cursors, and file paths appear.
///
/// Someone has to open this deliberately. It exists so a problem can be reported precisely, so
/// it shows what an engineer would ask for — and still never the credential or the session
/// token, which would be a leak rather than a diagnostic.
public struct DiagnosticsView: View {
    @Bindable var model: ConnectorModel
    @State private var report: [String: Any] = [:]
    @State private var copied = false

    public init(model: ConnectorModel) { self.model = model }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Advanced Diagnostics")
                    .font(.system(size: 14, weight: .medium, design: .serif))
                Spacer()
                Button("Done") { model.showingDiagnostics = false }
                    .buttonStyle(.link)
                    .font(.system(size: 12))
            }

            Text("For reporting a problem. Nothing here is secret — the credential and session token are deliberately not included.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            ScrollView {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(rows, id: \.0) { row in
                        HStack(alignment: .top) {
                            Text(row.0)
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                                .frame(width: 118, alignment: .leading)
                            Text(row.1)
                                .font(.system(size: 11, design: .monospaced))
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .frame(maxHeight: 230)

            HStack(spacing: 8) {
                Button(copied ? "Copied" : "Copy report") { copyReport() }
                Button("Open log folder") { openSupportFolder() }
                Spacer()
            }
            .font(.system(size: 12))
        }
        .task { await load() }
    }

    private var rows: [(String, String)] {
        let state = model.sidecar.state
        func text(_ key: String) -> String {
            if let value = report[key] as? String { return value }
            if let value = report[key] as? Int { return String(value) }
            return "—"
        }
        let connector: [(String, String)] = [
            // First, because "which build is this?" is the question that has cost the most time.
            ("App build", AppModel.buildCommit),
            ("Health", Diagnosis.health(of: state).title),
            ("Workspace", Diagnosis.workspaceDetail(state)),
            ("Gateway state", state.gateway),
            ("Runtime", Diagnosis.runtimeDetail(state)),
            ("Runtime path", state.runtime.path ?? "—"),
            ("Room sync", Diagnosis.syncDetail(state)),
            ("Last read seq", state.sync.lastContiguousSeq.map(String.init) ?? "—"),
            ("Pending items", String(state.sync.pending)),
            ("Helper PID", model.sidecar.processIdentifier.map(String.init) ?? "Not running"),
            ("Helper IPC", model.sidecar.ipcStatus),
            ("Launch failure", model.sidecar.lastLaunchFailure ?? "—"),
            ("IPC failure", model.sidecar.lastIPCFailure ?? "—"),
            ("Last helper exit", model.sidecar.lastExit ?? "—"),
            ("Helper path", model.sidecar.executablePath?.path ?? "Missing"),
            ("Support folder", model.sidecar.activeSupportDirectory.path),
            ("Helper restarts", String(model.sidecar.restarts)),
            ("Diagnostics reply", report["diagnosticsStatus"] as? String ?? "Waiting"),
            ("Workspace URL", text("baseUrl")),
            ("Room ID", text("roomId")),
            ("Agent principal", text("agentPrincipalId")),
            ("Session ID", text("sessionId")),
            ("Last wake", text("lastWakeAt")),
            ("State file", text("stateFile")),
            ("Log file", text("logFile")),
            ("Last error", state.lastError ?? "—"),
        ]
        let attention: [(String, String)] = model.attention?.rows ?? [("Notifications", "Not started — sign in to the workspace")]
        return connector + attention
    }

    private func load() async {
        do {
            let reply = try await model.sidecar.send("diagnostics")
            guard let payload = reply["diagnostics"] as? [String: Any] else {
                report = ["diagnosticsStatus": "Reply missing diagnostics payload"]
                return
            }
            report = payload
            report["diagnosticsStatus"] = "Received"
        } catch {
            report = ["diagnosticsStatus": "Request failed — see local helper/IPC evidence above"]
        }
    }

    private func copyReport() {
        let text = rows.map { "\($0.0): \($0.1)" }.joined(separator: "\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copied = true
        Task { try? await Task.sleep(for: .seconds(2)); copied = false }
    }

    private func openSupportFolder() {
        NSWorkspace.shared.open(model.sidecar.activeSupportDirectory)
    }
}
