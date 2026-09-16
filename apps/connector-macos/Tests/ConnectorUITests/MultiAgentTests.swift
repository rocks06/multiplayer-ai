import Testing
import Foundation
@testable import ConnectorUI

/// Two agents on one Mac — one Hermes installation, two profiles — the way the MacBook Air has them.
@Suite @MainActor struct MultiAgentTests {
    private func runtime(_ id: String, profile: String, displayName: String?, readiness: String = "ready") throws -> DiscoveredAgent {
        var raw: [String: Any] = [
            "available": true, "name": "Hermes Agent", "version": "0.20.5", "profile": profile,
            "runtimeType": "hermes", "readiness": readiness, "runtimeInstallationId": id,
            "connectorInstallationId": "connector", "endpoint": "cli:hermes", "probeStatus": "healthy",
        ]
        if let displayName { raw["displayName"] = displayName }
        return try #require(DiscoveredAgent.decode(raw))
    }

    private func agentState(_ runtime: String, principal: String, room: String, gateway: String, running: Bool) -> SidecarState.Agent {
        .init(runtimeSelectionId: runtime, agentPrincipalId: principal, roomId: room, enrolled: true, running: running,
              gateway: gateway, runtime: .init(available: true, name: "Hermes Agent", version: "0.20.5", readiness: "ready"))
    }

    /// JJ is live in Room A; AXON was disconnected from its room. The helper's top level describes
    /// AXON, because it was configured last — which is exactly what must not leak onto JJ.
    private func twoAgents() -> ConnectorModel {
        let axon = agentState("axon-runtime", principal: "axon", room: "c", gateway: "removed", running: false)
        let state = SidecarState(enrolled: true, running: false, startedAt: nil, gateway: "removed",
                                 runtime: axon.runtime, sync: .init(), identity: nil, lastError: nil,
                                 agents: [agentState("jj-runtime", principal: "jj", room: "a", gateway: "live", running: true), axon])
        let model = ConnectorModel(live: false, state: state)
        model.enrolments = [
            .init(baseURL: "https://fixture.test", roomId: "a", roomName: "Room A", agentPrincipalId: "jj", agentDisplayName: "JJ", runtimeSelectionId: "jj-runtime"),
            .init(baseURL: "https://fixture.test", roomId: "c", roomName: "Room C", agentPrincipalId: "axon", agentDisplayName: "AXON", runtimeSelectionId: "axon-runtime"),
        ]
        model.primaryPrincipalId = "jj"
        return model
    }

    @Test func eachProfileIsItsOwnNamedCardAndNeverABlankOne() throws {
        let jj = try runtime("jj-runtime", profile: "default", displayName: "JJ")
        let axon = try runtime("axon-runtime", profile: "axon", displayName: "AXON")
        #expect(jj.title() == "JJ" && axon.title() == "AXON")
        #expect(axon.detail == "Hermes · axon · 0.20.5")
        #expect(jj.id != axon.id)
        // Nothing named at all still has a name; blank strings are not names.
        let unnamed = try runtime("x", profile: "", displayName: "   ")
        #expect(unnamed.title() == "default")
        #expect(!unnamed.title().trimmingCharacters(in: .whitespaces).isEmpty)
        // The workspace's name for a known agent wins over the profile's own label.
        #expect(axon.title(known: .init(principalId: "axon", displayName: "Axon Research")) == "Axon Research")
    }

    @Test func savingOneAgentNeverReplacesAnother() {
        let jj = Keychain.Enrolment(baseURL: "https://fixture.test", roomId: "a", agentPrincipalId: "jj")
        let axon = Keychain.Enrolment(baseURL: "https://fixture.test", roomId: "c", agentPrincipalId: "axon")
        var list = Keychain.upserting(jj, into: [])
        list = Keychain.upserting(axon, into: list)
        var moved = jj; moved.roomId = "b"
        list = Keychain.upserting(moved, into: list)
        #expect(list.map(\.agentPrincipalId) == ["jj", "axon"])
        #expect(list.map(\.roomId) == ["b", "c"])
        #expect(Keychain.account(for: "jj") != Keychain.account(for: "axon"))
    }

    @Test func eachAgentReportsItsOwnConnectionNotTheLastConfiguredOne() {
        let model = twoAgents()
        #expect(model.health(of: "jj") == .connected)
        #expect(model.health(of: "axon") == .disconnected)
        #expect(model.health == .connected)            // the banner follows the agent being shown
        #expect(model.state(of: "jj").gateway == "live")
        #expect(model.state(of: "axon").running == false)
    }

    @Test func waitingForOneAgentsSessionIgnoresTheOther() async throws {
        let model = twoAgents()
        try await model.waitForAuthenticatedSession(principalId: "jj")
        await #expect(throws: SidecarError.self) { try await model.waitForAuthenticatedSession(principalId: "axon") }
    }

    /// Taken out of a room by a person is not a dead credential, and nothing asks for a code.
    @Test func disconnectedFromARoomIsNotSignInNeeded() {
        let removed = SidecarState(enrolled: true, running: false, startedAt: nil, gateway: "removed",
                                   runtime: .init(available: true, name: "Hermes Agent"), sync: .init(), identity: nil, lastError: nil)
        #expect(Diagnosis.health(of: removed) == .disconnected)
        #expect(Diagnosis.workspaceDetail(removed) != "Sign-in needed")
        let alert = WorkspaceAlert.current(health: .disconnected, runtime: removed.runtime)
        #expect(alert?.offersReconnect == false)
        #expect(alert?.detail.localizedCaseInsensitiveContains("code") == false)
        for problem in [CredentialProblem.missing, .unreadable(-25300)] {
            #expect(!problem.recovery.localizedCaseInsensitiveContains("new code"))
        }
    }

    /// Moving JJ names JJ's room, even while another agent is the one the app shows.
    @Test func aMoveIsAboutTheSelectedAgentsOwnRoom() throws {
        let app = AppModel.discoveryPreview(records: [])
        let jj = try runtime("jj-runtime", profile: "default", displayName: "JJ")
        let axon = try runtime("axon-runtime", profile: "axon", displayName: "AXON")
        app.acceptDiscovery([jj, axon], known: [jj.id: .init(principalId: "jj", displayName: "JJ"),
                                                axon.id: .init(principalId: "axon", displayName: "AXON")])
        app.connector.enrolments = [
            .init(baseURL: "https://fixture.test", roomId: "a", roomName: "Room A", agentPrincipalId: "jj", runtimeSelectionId: "jj-runtime"),
            .init(baseURL: "https://fixture.test", roomId: "c", roomName: "Room C", agentPrincipalId: "axon", runtimeSelectionId: "axon-runtime"),
        ]
        app.connector.primaryPrincipalId = "axon"
        app.discoveryRoomId = "b"
        app.selectDiscoveredAgent(jj.id)
        #expect(app.selectedAgentMove?.message.hasPrefix("JJ is currently connected to Room A. Move it to") == true)
        #expect(app.selectedAgentMove?.fromRoomId == "a")
        // Cancel changes nothing about either agent.
        let before = app.connector.enrolments
        #expect(!app.acceptAgentMove(nil))
        app.cancelAgentMove()
        #expect(app.pendingAgentMove == nil)
        #expect(app.connector.enrolments == before)
    }

    /// A card either says the agent is connected, or what its runtime can do — never "found" in one
    /// place and "unavailable" in another.
    @Test func aCardsStatusComesFromThatAgentAlone() throws {
        let app = AppModel(store: MemoryProgressStore(), connector: twoAgents())
        let jj = try runtime("jj-runtime", profile: "default", displayName: "JJ")
        let axon = try runtime("axon-runtime", profile: "axon", displayName: "AXON")
        app.acceptDiscovery([jj, axon], known: [jj.id: .init(principalId: "jj", displayName: "JJ"),
                                                axon.id: .init(principalId: "axon", displayName: "AXON")])
        #expect(app.discoveryStatus(jj) == "Connected to Room A")
        #expect(app.discoveryStatus(axon) == "Hermes Agent is ready to connect")
    }

    @Test func aRelaunchOpensHomeAndKeepsEverythingElse() {
        var saved = Progress()
        saved.setupComplete = true
        saved.companyId = "company"; saved.agentPrincipalId = "jj"; saved.roomId = "room"
        saved.workspaceAddress = "https://fixture.test"
        saved.lastRoomPath = "/rooms/company/room"
        let store = MemoryProgressStore(saved)
        let app = AppModel(store: store, connector: ConnectorModel(live: false))
        #expect(app.entryURL.path == "/home")
        #expect(store.load().lastRoomPath == nil)
        #expect(app.progress.agentPrincipalId == "jj" && app.progress.roomId == "room" && app.progress.setupComplete)
        #expect(app.progress.workspaceAddress == "https://fixture.test")
    }
}
