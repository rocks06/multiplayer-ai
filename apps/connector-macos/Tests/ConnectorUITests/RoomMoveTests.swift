import Testing
import Foundation
@testable import ConnectorUI

@Suite @MainActor struct RoomMoveTests {
    private func model() throws -> AppModel {
        let app = AppModel.discoveryPreview(records: [])
        let runtime = try #require(DiscoveredAgent.decode([
            "available": true, "name": "Fixture", "profile": "test", "runtimeType": "fixture",
            "readiness": "ready", "runtimeInstallationId": "runtime", "connectorInstallationId": "connector"
        ]))
        app.acceptDiscovery([runtime], known: [runtime.id: .init(principalId: "principal", displayName: "JJ")])
        app.selectDiscoveredAgent(runtime.id)
        app.connector.enrolment = .init(baseURL: "https://fixture.test", roomId: "a", roomName: "Room A",
                                       agentPrincipalId: "principal", runtimeSelectionId: "runtime")
        app.discoveryRoomId = "b"
        return app
    }
    @Test func cancelLeavesBindingProgressAndRuntimeUntouched() throws {
        let app = try model()
        let progress = app.progress, enrolment = app.connector.enrolment, state = app.connector.sidecar.state
        #expect(!app.acceptAgentMove(nil))
        #expect(app.pendingAgentMove?.message == "JJ is currently connected to Room A. Move it to the selected room?")
        app.cancelAgentMove()
        #expect(app.pendingAgentMove == nil)
        #expect(app.progress == progress)
        #expect(app.connector.enrolment == enrolment)
        #expect(app.connector.sidecar.state.gateway == state.gateway)
        #expect(app.discoveryPhase == .results)
    }
    @Test func confirmationIsBoundToTheExactSelectionAndTarget() throws {
        let app = try model()
        let move = try #require(app.selectedAgentMove)
        #expect(app.acceptAgentMove(move))
        app.discoveryRoomId = "c"
        #expect(!app.acceptAgentMove(move))
        #expect(app.pendingAgentMove?.toRoomId == "c")
        app.discoveryRoomId = "a"
        #expect(app.selectedAgentMove == nil)
    }
    @Test func rebindStopsBeforePersistAndConnectAndKeepsIdentity() async throws {
        let saved = Keychain.Enrolment(baseURL: "https://fixture.test", roomId: "a", agentPrincipalId: "principal", runtimeSelectionId: "runtime")
        var stored = saved
        var calls: [String] = []
        var activeRoom: String? = "a"
        try await RoomRebinding.perform(existing: saved, roomId: "b", roomName: "Room B", projectName: nil,
            disconnect: { calls.append("disconnect"); activeRoom = nil },
            restore: { calls.append("restore") },
            persist: { value in
                #expect(activeRoom == nil)
                calls.append("persist"); stored = value
            },
            connect: {
                #expect(activeRoom == nil)
                #expect(stored.roomId == "b")
                calls.append("connect")
                // Transport acknowledgement alone does not make the room Connected.
                #expect(activeRoom == nil)
                activeRoom = "b" // fixture session.ready
            })
        #expect(calls == ["disconnect", "persist", "connect"])
        #expect(stored.agentPrincipalId == saved.agentPrincipalId)
        #expect(stored.runtimeSelectionId == saved.runtimeSelectionId)
        #expect(stored.baseURL == saved.baseURL)
    }
    /// The old room never confirmed release: nothing is recorded, nothing connects, and the agent
    /// is put back rather than left stopped in no room at all.
    @Test func failedDisconnectRestoresInsteadOfRebinding() async throws {
        enum Failure: Error { case stopped }
        let saved = Keychain.Enrolment(baseURL: "https://fixture.test", roomId: "a", agentPrincipalId: "principal")
        var calls: [String] = []
        do {
            try await RoomRebinding.perform(existing: saved, roomId: "b", roomName: nil, projectName: nil,
                disconnect: { throw Failure.stopped }, restore: { calls.append("restore") },
                persist: { _ in calls.append("persist") }, connect: { calls.append("connect") })
            Issue.record("Expected disconnect failure")
        } catch RoomRebinding.Failure.stayed(_) {
        } catch { Issue.record("Expected .stayed, got \(error)") }
        #expect(calls == ["restore"])
    }

    /// Once the old room has let go and the target is recorded, going back would be a second,
    /// unconfirmed move. A connection failure after that point stays moved and says so.
    @Test func failedConnectAfterReleaseStaysMoved() async throws {
        enum Failure: Error { case unreachable }
        let saved = Keychain.Enrolment(baseURL: "https://fixture.test", roomId: "a", agentPrincipalId: "principal")
        var calls: [String] = [], stored = saved
        do {
            try await RoomRebinding.perform(existing: saved, roomId: "b", roomName: nil, projectName: nil,
                disconnect: { calls.append("disconnect") }, restore: { calls.append("restore") },
                persist: { calls.append("persist"); stored = $0 },
                connect: { calls.append("connect"); throw Failure.unreachable })
            Issue.record("Expected connect failure")
        } catch RoomRebinding.Failure.moved(_) {
        } catch { Issue.record("Expected .moved, got \(error)") }
        #expect(calls == ["disconnect", "persist", "connect"])
        #expect(stored.roomId == "b")
    }

    @Test func theRoomPageMayHandOverAMoveButNeverASignIn() {
        let id = "01a0a6a1-8baf-75cf-be5c-ca80d7d45a93"
        #expect(AppModel.acceptsFromWorkspace("multiplayerai://connect-runtime?company=\(id)&room=\(id)&agent=\(id)"))
        #expect(AppModel.acceptsFromWorkspace("multiplayerai://diagnostics"))
        #expect(AppModel.acceptsFromWorkspace("multiplayerai://room?company=\(id)&room=\(id)"))
        #expect(!AppModel.acceptsFromWorkspace("multiplayerai://auth?token=mpsi_abc"))
        #expect(!AppModel.acceptsFromWorkspace("https://example.test/connect-runtime"))
    }

    /// The navigation delegate cannot be driven without a live page, so its wiring is pinned here:
    /// before this, the room's Move agent confirmation was cancelled by the web view and went nowhere.
    @Test func theWorkspaceViewDeliversThoseLinksToTheApp() throws {
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/ConnectorUI/WorkspaceScreen.swift"), encoding: .utf8)
        #expect(source.contains("AppModel.acceptsFromWorkspace(url.absoluteString), action.sourceFrame.isMainFrame"))
        #expect(source.contains("await app.receive(authURL: url.absoluteString)"))
    }
}
