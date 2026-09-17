import SwiftUI

/// Adapter-neutral onboarding: discovery is visible immediately and never creates an identity.
public struct AgentDiscoverySheet: View {
    @Bindable var app: AppModel
    @State private var advanced = false
    public init(app: AppModel) { self.app = app }
    private var working: Bool { app.discoveryPhase == .looking || app.discoveryPhase == .connecting || app.startingRuntimeId != nil }
    private var canConnect: Bool {
        guard let selected = app.selectedDiscoveredAgent else { return false }
        // A stopped profile can be connected: Connect starts it first.
        let startable = AppModel.needsStart(selected.runtime) && app.runtimeStartErrors[selected.id] == nil
        return !working && (selected.isConnectable || startable)
            && app.discoveryCompanyId != nil
            && app.rooms.contains { $0.roomId == app.discoveryRoomId }
            && (app.selectedKnownIdentity != nil || !app.discoveryDisplayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("Detect Agent").font(.system(size: 23, weight: .medium, design: .serif))
                Spacer()
                Button("Close") { app.dismissAgentDiscovery() }
                    .disabled(app.discoveryPhase == .connecting || app.connector.busy)
                    .keyboardShortcut(.cancelAction)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    content
                    // A code is for a Mac nobody is signed in on. Offering it to someone who is
                    // signed in asked them for a credential their agent already had.
                    if app.discoveryPhase != .connected && app.discoveryCompanyId == nil {
                        DisclosureGroup("Advanced", isExpanded: $advanced) {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("Connect with code is a fallback for a Mac without an authenticated workspace session.")
                                    .font(.callout).foregroundStyle(.secondary)
                                EnrolView(model: app.connector)
                            }.padding(.top, 12)
                        }.disabled(working)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if app.discoveryPhase == .results || isFailure {
                HStack {
                    Button("Retry") { Task { await app.detectRuntime() } }
                    Spacer()
                    Button("Connect Agent") { Task { await app.confirmRuntimeConnection() } }
                        .buttonStyle(.borderedProminent).disabled(!canConnect)
                }
            }
        }
        // Diagnostics opened from here has to open here: setting the flag alone only ever drew it
        // inside the menu bar popover, so pressing Open Diagnostics in this sheet did nothing.
        .sheet(isPresented: Binding(get: { app.connector.showingDiagnostics },
                                    set: { app.connector.showingDiagnostics = $0 })) {
            DiagnosticsView(model: app.connector).padding(20).frame(width: 560, height: 520)
        }
        .padding(24).frame(width: 560, height: 600)
        .interactiveDismissDisabled(app.discoveryPhase == .connecting || app.connector.busy)
        .onAppear { app.connector.workspaceAddress = app.workspaceAddress }
        .alert("Move agent?", isPresented: Binding(
            get: { app.pendingAgentMove != nil },
            set: { if !$0 { app.cancelAgentMove() } }
        ), presenting: app.pendingAgentMove) { move in
            Button("Cancel", role: .cancel) { app.cancelAgentMove() }
            Button("Move") { Task { await app.confirmRuntimeConnection(confirmedMove: move) } }
        } message: { move in Text(move.message) }
    }

    private var isFailure: Bool {
        if case .failed = app.discoveryPhase { return true }; return false
    }

    @ViewBuilder private var content: some View {
        switch app.discoveryPhase {
        case .idle, .looking:
            HStack(spacing: 12) {
                ProgressView().controlSize(.small)
                Text("Looking for agents on this Mac…")
            }.padding(.vertical, 24).accessibilityElement(children: .combine)
        case .connecting:
            HStack(spacing: 12) {
                ProgressView().controlSize(.small)
                VStack(alignment: .leading, spacing: 5) {
                    Text("Connecting your agent…").font(.headline)
                    Text("Waiting for the server to confirm an authenticated session.")
                        .foregroundStyle(.secondary)
                }
            }.padding(.vertical, 24)
        case .connected:
            // This agent's own session, not the headline health: the headline reads as reconnecting
            // while anything else on this Mac is busy, which is not this agent being interrupted.
            if app.sessionIsReady(app.connector.enrolment?.agentPrincipalId) {
                Label("Connected", systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.headline)
                Text("\(app.progress.agentDisplayName ?? "Your agent") is connected to \(app.nameOfRoom(app.discoveryRoomId) ?? "the selected room").")
            } else {
                Label("Connection interrupted", systemImage: "exclamationmark.circle")
                Text("The authenticated session is no longer live. Your saved identity is preserved.")
                Button("Retry connection") { Task { await app.connector.reconnect() } }
                    .disabled(app.connector.busy)
                ReconnectProgress(model: app.connector, principalId: app.connector.enrolment?.agentPrincipalId)
            }
        case .failed(let message):
            Label("Could not connect or check this Mac", systemImage: "exclamationmark.triangle")
                .font(.headline)
            Text(message).foregroundStyle(.secondary).textSelection(.enabled)
            Button("Open Diagnostics") { app.connector.showingDiagnostics = true }
        case .results:
            if app.discoveredAgents.isEmpty {
                Text("No agents found on this Mac").font(.headline)
                Text("Start a supported agent runtime, then Retry. You can also use Advanced to connect with a code.")
                    .foregroundStyle(.secondary)
            } else {
                Text("Choose the agent profile to connect. Nothing is created until you connect it.")
                    .foregroundStyle(.secondary)
                ForEach(app.discoveredAgents) { agent in
                    Button { Task { await app.chooseDiscoveredAgent(agent.id) } } label: {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: app.selectedDiscoveredAgentId == agent.id ? "largecircle.fill.circle" : "circle")
                            VStack(alignment: .leading, spacing: 5) {
                                Text(app.discoveryTitle(agent)).font(.headline)
                                Text(agent.detail).font(.callout).foregroundStyle(.secondary)
                                HStack(spacing: 6) {
                                    if app.startingRuntimeId == agent.id { ProgressView().controlSize(.mini) }
                                    Text(app.discoveryStatus(agent)).font(.caption)
                                        .foregroundStyle(app.runtimeStartErrors[agent.id] == nil ? Color.secondary : Color.red)
                                        .textSelection(.enabled)
                                }
                                if app.runtimeStartErrors[agent.id] != nil {
                                    Button("Retry") { Task { await app.startDiscoveredRuntime(agent.id) } }
                                        .controlSize(.small).disabled(app.startingRuntimeId != nil)
                                } else if let reason = agent.runtime.reason, !agent.isConnectable, !AppModel.needsStart(agent.runtime) {
                                    Text(reason).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Spacer(minLength: 0)
                        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                            .background(app.selectedDiscoveredAgentId == agent.id ? Color.accentColor.opacity(0.08) : Color.secondary.opacity(0.04))
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(app.selectedDiscoveredAgentId == agent.id ? Color.accentColor : Color.secondary.opacity(0.2)))
                    }.buttonStyle(.plain)
                        .accessibilityLabel("\(app.discoveryTitle(agent)), \(agent.detail), \(app.discoveryStatus(agent))")
                }
                if app.selectedDiscoveredAgent != nil {
                    if let known = app.selectedKnownIdentity {
                        Label("Reconnect as \(known.displayName)", systemImage: "person.crop.circle.badge.checkmark")
                        Text("This profile keeps its existing workspace identity.").font(.caption).foregroundStyle(.secondary)
                    } else {
                        TextField("Agent display name", text: $app.discoveryDisplayName).textFieldStyle(.roundedBorder)
                        Text("Choose a name for this profile in your workspace.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if app.discoveryCompanyId == nil {
                    Text("Sign in to a workspace to connect automatically.").foregroundStyle(.secondary)
                } else if app.rooms.isEmpty {
                    Text("Create or join a room before connecting this agent.").foregroundStyle(.secondary)
                } else {
                    Picker("Room", selection: $app.discoveryRoomId) {
                        Text("Choose a room").tag("")
                        ForEach(app.rooms, id: \.roomId) { room in Text(room.name).tag(room.roomId) }
                    }
                }
            }
        }
    }
}
