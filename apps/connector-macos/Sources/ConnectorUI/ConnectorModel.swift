import SwiftUI
import ServiceManagement

@Observable
@MainActor
public final class ConnectorModel {
    public let sidecar: SidecarClient
    public var enrolment: Keychain.Enrolment?
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

    public var health: Health { Diagnosis.health(of: sidecar.state, credential: sidecar.credentialProblem) }

    /// A code can only be spent against somewhere real, so both are required before connecting.
    public var addressLooksUsable: Bool { ConnectorModel.usableAddress(workspaceAddress) }
    nonisolated public static func usableAddress(_ address: String) -> Bool {
        let trimmed = address.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") else { return false }
        return URL(string: trimmed)?.host?.isEmpty == false
    }

    /// `live: false` builds a model that touches nothing — no helper spawned, no Keychain read —
    /// so the views can be rendered and reasoned about on their own.
    public init(live: Bool = true, state: SidecarState? = nil, enrolment: Keychain.Enrolment? = nil,
                credentialProblem: CredentialProblem? = nil) {
        self.sidecar = SidecarClient(preview: state)
        self.sidecar.credentialProblem = credentialProblem
        self.enrolment = live ? Keychain.enrolment() : enrolment
        guard live else { return }
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
            try Keychain.saveCredential(credential)
            let enrolment = Keychain.Enrolment(
                baseURL: workspace, roomId: roomId,
                roomName: room["name"] as? String, projectName: room["project_name"] as? String,
                agentPrincipalId: agentPrincipalId,
                agentDisplayName: result["agent_display_name"] as? String)
            Keychain.saveEnrolment(enrolment)
            self.enrolment = enrolment
            await sidecar.resumeSession()
            LoginItem.enable()
        } catch {
            notice = error.localizedDescription
        }
    }

    public func reconnect() async {
        busy = true
        defer { busy = false }
        if sidecar.state.running == false { sidecar.start() }
        // When the credential could not be read, the helper was never configured and has nothing
        // to reconnect — asking it to would be a button that does nothing. Retry the read instead,
        // which is the thing that actually might have changed (a Keychain that was locked, an
        // unlock that has since happened).
        if sidecar.credentialProblem != nil { await sidecar.resumeSession(); return }
        _ = try? await sidecar.send("reconnect")
    }

    /// Signing out removes the credential from the Keychain and everything durable the connector
    /// kept about the room. Nothing is left behind that could reconnect on its own.
    public func signOut() async {
        busy = true
        defer { busy = false }
        _ = try? await sidecar.send("signout")
        sidecar.credentialProblem = nil
        Keychain.removeCredential()
        Keychain.removeEnrolment()
        enrolment = nil
        LoginItem.disable()
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
