import SwiftUI

/// Setting this Mac up: a code from the workspace, and nothing else asked of anybody.
///
/// Whether Hermes is present is shown before the code is entered, because it is the one thing a
/// person may have to go and fix, and finding out afterwards would waste the code.
public struct EnrolView: View {
    @Bindable var model: ConnectorModel
    @State private var code = ""
    @State private var workspace = "http://localhost:4100"
    @State private var showWorkspaceField = false
    @FocusState private var codeFocused: Bool

    private var runtime: SidecarState.Runtime { model.sidecar.state.runtime }
    private var codeLooksComplete: Bool {
        code.trimmingCharacters(in: .whitespaces).count >= 14
    }

    public init(model: ConnectorModel) { self.model = model }

    public var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Multiplayer AI")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                    .kerning(0.6)
                Text("Connect this Mac")
                    .font(.system(size: 17, weight: .medium, design: .serif))
            }

            Text("Enter the code shown in your Multiplayer AI workspace when you add this agent.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            TextField("MPAI-0000-0000-0000", text: $code)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 14, design: .monospaced))
                .focused($codeFocused)
                .onSubmit { submit() }
                .onChange(of: code) { _, value in code = value.uppercased() }

            // What the runtime check found, stated plainly and before it costs anyone a code.
            HStack(spacing: 7) {
                Circle()
                    .fill(runtime.available ? Color.green : Color.orange)
                    .frame(width: 7, height: 7)
                if runtime.available {
                    Text("\(runtime.name) \(runtime.version ?? "") found")
                        .font(.system(size: 12))
                } else {
                    Text("\(runtime.name) not found")
                        .font(.system(size: 12))
                }
                Spacer()
                Button("Check again") { Task { _ = try? await model.sidecar.send("detect"); await model.sidecar.refresh() } }
                    .buttonStyle(.link)
                    .font(.system(size: 11))
            }

            if !runtime.available {
                Text("You can connect now, but this Mac cannot do any work until \(runtime.name) is installed here.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if showWorkspaceField {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Workspace address")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                    TextField("http://…", text: $workspace)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12))
                }
            }

            if let notice = model.notice {
                Text(notice)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let failure = model.sidecar.lastLaunchFailure {
                Text(failure)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 8) {
                Button(model.busy ? "Connecting…" : "Connect") { submit() }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.busy || !codeLooksComplete)
                Button(showWorkspaceField ? "Hide address" : "Change address") {
                    showWorkspaceField.toggle()
                }
                .buttonStyle(.link)
                .font(.system(size: 11))
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
                    .buttonStyle(.link)
                    .font(.system(size: 11))
            }
        }
        .onAppear { codeFocused = true }
    }

    private func submit() {
        guard codeLooksComplete, !model.busy else { return }
        Task {
            await model.enroll(code: code, workspace: workspace.trimmingCharacters(in: .whitespaces))
            if model.enrolment != nil { code = "" }
        }
    }
}
