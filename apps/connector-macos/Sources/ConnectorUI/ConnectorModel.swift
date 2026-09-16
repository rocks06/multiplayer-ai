import SwiftUI
import ServiceManagement

@Observable
@MainActor
public final class ConnectorModel {
    public let sidecar: SidecarClient
    /// Every agent this Mac runs.
    public var enrolments: [Keychain.Enrolment] = []
    /// The agent the app's own journey is about, when there is one; the others run beside it.
    public var primaryPrincipalId: String?
    /// The agent the single-agent surfaces show. Setting one saves that agent and touches no other.
    public var enrolment: Keychain.Enrolment? {
        get { enrolments.first { $0.agentPrincipalId == primaryPrincipalId } ?? enrolments.first }
        set {
            if let newValue {
                enrolments = Keychain.upserting(newValue, into: enrolments)
                primaryPrincipalId = newValue.agentPrincipalId
            } else if let current = enrolment {
                enrolments.removeAll { $0.agentPrincipalId == current.agentPrincipalId }
            }
        }
    }
    public func enrolment(for principalId: String) -> Keychain.Enrolment? {
        enrolments.first { $0.agentPrincipalId == principalId }
    }
    public var showingDiagnostics = false

    /* The menu bar popover tears its content view down every time it closes, which is exactly
       what happens when someone clicks away to copy their code. Anything they have typed lives
       here instead, so it is still there when they come back. */
    public var code = ""
    public var workspaceAddress: String = UserDefaults.standard.string(forKey: addressKey) ?? "" {
        didSet { UserDefaults.standard.set(workspaceAddress, forKey: ConnectorModel.addressKey) }
    }
    public var showingWorkspaceField = false
    static let addressKey = "com.multiplayerai.connector.workspace-address"
    public var busy = false
    public var notice: String?

    public var health: Health {
        if busy { return .reconnecting }
        // Several agents: say what the one being shown is doing, not whichever was configured last.
        if let principal = enrolment?.agentPrincipalId, sidecar.state.agents != nil { return health(of: principal) }
        return Diagnosis.health(of: sidecar.state, credential: sidecar.credentialProblem)
    }

    /// A code can only be spent against somewhere real, so both are required before connecting.
    public var addressLooksUsable: Bool { ConnectorModel.usableAddress(workspaceAddress) }
    nonisolated public static func usableAddress(_ address: String) -> Bool {
        let trimmed = address.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") else { return false }
        return URL(string: trimmed)?.host?.isEmpty == false
    }

    /// `live: false` builds a model that touches nothing — no helper spawned, no Keychain read —
    /// so the views can be rendered and reasoned about on their own.
    ///
    /// `autostart: false` builds a live model that has not started yet. The unified app uses it
    /// so that starting the background service is something the setup screen genuinely does and
    /// can genuinely fail at, rather than something that has already quietly happened by the time
    /// the person is told about it.
    public init(live: Bool = true, autostart: Bool = true, state: SidecarState? = nil,
                enrolment: Keychain.Enrolment? = nil, credentialProblem: CredentialProblem? = nil) {
        self.sidecar = SidecarClient(preview: state)
        self.sidecar.credentialProblem = credentialProblem
        self.enrolments = live ? Keychain.enrolments() : (enrolment.map { [$0] } ?? [])
        guard live, autostart else { return }
        begin()
    }

    private var started = false

    /// Start the background half and keep watching it. Safe to call more than once; a second
    /// call is what a returning launch and a retried setup step both do.
    public func begin() {
        guard !started else { return }
        started = true
        sidecar.start()
        Task { [self] in
            // A returning install is already bound to an agent; it should simply come back.
            await sidecar.resumeSession()
            while !Task.isCancelled {
                await sidecar.refresh()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    /// The whole of setting this Mac up: a code, and what the workspace says it is.
    public func enroll(code: String, workspace: String) async {
        busy = true
        notice = nil
        defer { busy = false }
        do {
            let reply = try await sidecar.send("enroll", ["code": code, "baseUrl": workspace, "deviceLabel": Host.current().localizedName ?? "Mac"])
            guard let result = reply["enrollment"] as? [String: Any],
                  let credential = result["credential_token"] as? String,
                  let agentPrincipalId = result["agent_principal_id"] as? String else {
                notice = "The workspace's answer was not understood."
                return
            }
            let rooms = result["rooms"] as? [[String: Any]] ?? []
            guard let room = rooms.first, let roomId = room["id"] as? String else {
                notice = "This agent is not in a room yet. Add it to one in your workspace, then connect."
                return
            }
            try Keychain.saveCredential(credential, for: agentPrincipalId)
            let enrolment = Keychain.Enrolment(
                baseURL: workspace, roomId: roomId,
                roomName: room["name"] as? String, projectName: room["project_name"] as? String,
                agentPrincipalId: agentPrincipalId,
                agentDisplayName: result["agent_display_name"] as? String)
            Keychain.saveEnrolment(enrolment)
            self.enrolment = enrolment
            await sidecar.resumeSession(principalId: agentPrincipalId)
            LoginItem.enable()
        } catch {
            notice = error.localizedDescription
        }
    }

    /// What one agent is doing. With a single agent the top level is that agent, which is also
    /// what a helper from before per-agent reporting sends.
    public func state(of principalId: String) -> SidecarState {
        if let agent = sidecar.state.agent(principalId: principalId) { return agent.state }
        return sidecar.state.agents == nil ? sidecar.state
            : SidecarState(enrolled: false, running: false, startedAt: nil, gateway: "not_started",
                           runtime: sidecar.state.runtime, sync: .init(), identity: nil, lastError: nil)
    }

    public func health(of principalId: String) -> Health {
        Diagnosis.health(of: state(of: principalId), credential: sidecar.credentialProblems[principalId])
    }

    /// IPC acknowledgement and socket open are not connected. The helper publishes `live`
    /// only after the gateway's authenticated session.ready frame — and for the agent asked about,
    /// never because some other agent on this Mac is live.
    public func waitForAuthenticatedSession(principalId: String? = nil) async throws {
        let deadline = Date().addingTimeInterval(20)
        let principal = principalId ?? enrolment?.agentPrincipalId
        repeat {
            await sidecar.refresh()
            if let principal, sidecar.credentialProblems[principal] != nil || (principalId == nil && sidecar.credentialProblem != nil) {
                throw SidecarError.refused("Unlock the Keychain and Retry. The saved credential could not be read.")
            }
            let state = principal.map { self.state(of: $0) } ?? sidecar.state
            if state.running && state.enrolled && state.gateway == "live" { return }
            if state.gateway == "auth_required" {
                throw SidecarError.refused("The workspace refused this agent's session. Check its access and Retry.")
            }
            if state.gateway == "removed" {
                throw SidecarError.refused("This agent is not in that room. Add it to the room, then connect it again.")
            }
            try await Task.sleep(for: .milliseconds(250))
        } while Date() < deadline
        throw SidecarError.refused("The server has not confirmed this agent's session. Check Diagnostics and Retry.")
    }

    public func reconnect() async {
        guard let principal = enrolment?.agentPrincipalId else {
            notice = "No agent is connected on this Mac yet. Choose Detect Agent to connect one."
            return
        }
        await reconnect(principalId: principal)
    }

    /// Start one agent again with the credential it already holds. No code, no new identity.
    public func reconnect(principalId: String) async {
        guard !busy else { return }
        busy = true
        notice = nil
        defer { busy = false }
        if sidecar.state.running == false, sidecar.processIdentifier == nil { sidecar.start() }
        do {
            guard enrolment(for: principalId) != nil else {
                throw SidecarError.refused("This agent is not saved on this Mac. Choose Detect Agent to connect it.")
            }
            // Configure as well as restart: after a crash, a relaunch or a Disconnect the helper may
            // not hold this agent at all, and "reconnect" of nothing was a button that did nothing.
            if let failure = await sidecar.resumeSession(principalId: principalId, restart: true) {
                throw SidecarError.refused(failure)
            }
            try await waitForAuthenticatedSession(principalId: principalId)
        } catch { notice = error.localizedDescription }
    }

    /// Stop one agent and end its room session now. Its identity, credential and room stay saved,
    /// so Reconnect brings it straight back; nobody else on this Mac is touched.
    public func disconnect(principalId: String) async {
        guard !busy, let saved = enrolment(for: principalId) else { return }
        busy = true
        notice = nil
        defer { busy = false }
        do { try await sidecar.send("disconnect", ["runtimeSelectionId": saved.runtimeSelectionId ?? "", "agentPrincipalId": principalId]) }
        catch { notice = error.localizedDescription }
        await sidecar.refresh()
    }

    /// Signing out removes every credential from the Keychain and everything durable the connector
    /// kept about the room. Nothing is left behind that could reconnect on its own.
    public func signOut() async {
        busy = true
        defer { busy = false }
        _ = try? await sidecar.send("signout")
        sidecar.credentialProblem = nil
        sidecar.credentialProblems = [:]
        Keychain.removeCredential()
        Keychain.removeEnrolment()
        enrolments = []
        LoginItem.disable()
    }

    /// Forget one agent on this Mac — the one the workspace no longer has. The others keep running.
    public func signOut(principalId: String) async {
        let saved = enrolment(for: principalId)
        if let saved { _ = try? await sidecar.send("signout", ["runtimeSelectionId": saved.runtimeSelectionId ?? "", "agentPrincipalId": principalId]) }
        sidecar.credentialProblems[principalId] = nil
        sidecar.credentialProblem = sidecar.credentialProblems.values.first
        // Credential before enrolment: the enrolment is how an upgraded Mac knows whose credential
        // the shared item from before was.
        Keychain.removeCredential(for: principalId)
        Keychain.removeEnrolment(for: principalId)
        enrolments.removeAll { $0.agentPrincipalId == principalId }
        if enrolments.isEmpty { LoginItem.disable() }
    }
}

/// Starting at login, and after a restart. launchd's part is keeping the app alive; recovering a
/// connection is the connector's own business and stays inside it.
public enum LoginItem {
    public static var enabled: Bool { SMAppService.mainApp.status == .enabled }
    public static func enable() { try? SMAppService.mainApp.register() }
    public static func disable() { try? SMAppService.mainApp.unregister() }
}

public enum MenuBarIcon {
    @MainActor
    public static func image(for health: Health) -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { rect in
            let mark = "M" as NSString
            let font = NSFont.systemFont(ofSize: 12, weight: .semibold)
            mark.draw(at: NSPoint(x: rect.minX + 1, y: rect.minY + 3),
                      withAttributes: [.font: font, .foregroundColor: NSColor.labelColor])
            if health != .connected {
                let dot = NSBezierPath(ovalIn: NSRect(x: rect.maxX - 5, y: rect.maxY - 5, width: 4, height: 4))
                switch health.tone {
                case .working: NSColor.systemOrange.setFill()
                case .stopped: NSColor.systemRed.setFill()
                default: NSColor.tertiaryLabelColor.setFill()
                }
                dot.fill()
            }
            return true
        }
        image.isTemplate = false
        return image
    }
}
