import Testing
import Foundation
@testable import ConnectorUI

/**
 * Reconnecting, and saying so.
 *
 * The first press used to fail and the second to work, with nothing on screen in between: the
 * command went to a helper that was no longer answering, and the failure was a line of text
 * somewhere else. The helper here is a fixture process; every name is a fixture.
 */
@Suite(.serialized) @MainActor struct ReconnectTests {
    /// A helper that ignores everything until `flag` exists, then answers — a wedged process that
    /// comes back when it is restarted.
    private func helper(answersOnlyWhenPresent flag: URL?) throws -> (SidecarClient, URL) {
        let root = FileManager.default.temporaryDirectory.appending(path: "mpai-reconnect-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let script = root.appending(path: "helper")
        try """
        #!/bin/sh
        if [ -n "$FLAG" ] && [ ! -f "$FLAG" ]; then touch "$FLAG"; while IFS= read -r line; do :; done; exit 0; fi
        while IFS= read -r line; do
          id=$(printf '%s' "$line" | sed -n 's/.*"id" *: *\\([0-9][0-9]*\\).*/\\1/p')
          printf '{"type":"reply","id":%s,"ok":true}\\n' "$id"
        done
        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
        let sidecar = SidecarClient(executable: script, supportDirectory: root,
                                    environment: ["FLAG": flag?.path ?? "", "PATH": "/usr/bin:/bin"],
                                    requestTimeout: 1)
        return (sidecar, root)
    }

    @Test func aHelperThatStoppedAnsweringIsRestartedRatherThanSentACommandIntoNothing() async throws {
        let flag = FileManager.default.temporaryDirectory.appending(path: "mpai-flag-\(UUID().uuidString)")
        let (sidecar, _) = try helper(answersOnlyWhenPresent: flag)
        sidecar.start()
        let first = sidecar.processIdentifier
        // The first process takes the ping and says nothing, which is exactly the failing case.
        #expect(await sidecar.ensureResponsive() == nil)
        #expect(sidecar.processIdentifier != first)
        #expect(sidecar.ipcStatus == "Ready")
        sidecar.stop()
    }

    @Test func aHelperThatNeverAnswersSaysSoInsteadOfFailingSilently() async throws {
        let (sidecar, _) = try helper(answersOnlyWhenPresent: nil)
        // Nothing to run: the helper cannot be started at all.
        let missing = SidecarClient(executable: sidecar.activeSupportDirectory.appending(path: "absent"),
                                    supportDirectory: sidecar.activeSupportDirectory,
                                    environment: ["PATH": "/usr/bin:/bin"], requestTimeout: 1)
        let reason = await missing.ensureResponsive()
        #expect(reason != nil)
        #expect(reason?.isEmpty == false)
    }

    @Test func everyStepOfAReconnectIsReportedAndTheFailingOneIsNamed() async throws {
        let (sidecar, _) = try helper(answersOnlyWhenPresent: nil)
        let model = ConnectorModel(sidecar: sidecar)
        // An agent this Mac does not hold: the first step answers, and the failure is explicit.
        await model.reconnect(principalId: "00000000-0000-4000-8000-0000000000a1")
        let state = model.reconnection(of: "00000000-0000-4000-8000-0000000000a1")
        #expect(state?.done == true)
        if case .failed(let reason) = state { #expect(!reason.isEmpty) } else { Issue.record("expected a failure") }
        #expect(model.notice != nil)
        #expect(model.reconnectSteps.count >= 1)
        #expect(model.reconnectSteps.last?.contains("failed") == true)
        sidecar.stop()
    }

    @Test func aSessionThatIsReadyClosesTheSheetEvenWhenNothingElseIsHealthyYet() async throws {
        /* What the Air saw: the session was live and the sheet stayed open, because the headline
           health reads as reconnecting while the Mac is busy and as unavailable until the runtime
           reports itself again. The agent's own session is what decides. */
        let model = ConnectorModel(live: false, state: SidecarState(
            enrolled: true, running: true, startedAt: nil, gateway: "live",
            runtime: .init(available: false, name: "Fixture Runtime"), sync: .init(), identity: nil, lastError: nil))
        model.busy = true
        let app = AppModel.discoveryPreview(records: [], phase: .connected, connector: model)
        app.discoveryCloseDelay = .milliseconds(10)
        app.showingAgentDiscovery = true
        #expect(model.health != .connected)
        #expect(app.sessionIsReady(nil) == false)
        await app.closeDiscoveryWhenConnected(principalId: "fixture-agent")
        #expect(app.showingAgentDiscovery == false)
    }

    @Test func aSessionThatIsNotReadyLeavesTheSheetOpen() async throws {
        let model = ConnectorModel(live: false, state: SidecarState(
            enrolled: true, running: true, startedAt: nil, gateway: "reconnecting",
            runtime: .init(available: true, name: "Fixture Runtime"), sync: .init(), identity: nil, lastError: nil))
        let app = AppModel.discoveryPreview(records: [], phase: .connected, connector: model)
        app.discoveryCloseDelay = .milliseconds(10)
        app.showingAgentDiscovery = true
        await app.closeDiscoveryWhenConnected(principalId: "fixture-agent")
        #expect(app.showingAgentDiscovery)
    }

    @Test func aConnectedAgentClosesTheDetectAgentSheetOnItsOwn() async throws {
        let model = ConnectorModel(live: false, state: SidecarState(
            enrolled: true, running: true, startedAt: nil, gateway: "live",
            runtime: .init(available: true, name: "Fixture Runtime"), sync: .init(), identity: nil, lastError: nil))
        let app = AppModel.discoveryPreview(records: [], phase: .connected, connector: model)
        app.discoveryCloseDelay = .milliseconds(10)
        app.showingAgentDiscovery = true
        #expect(model.health == .connected)
        await app.closeDiscoveryWhenConnected(principalId: "fixture-agent")
        #expect(app.showingAgentDiscovery == false)
    }

    @Test func aSheetShowingAFailureStaysOpen() async throws {
        let model = ConnectorModel(live: false, state: SidecarState(
            enrolled: true, running: false, startedAt: nil, gateway: "auth_required",
            runtime: .init(available: true, name: "Fixture Runtime"), sync: .init(), identity: nil, lastError: nil))
        let app = AppModel.discoveryPreview(records: [], phase: .failed("Fixture failure"), connector: model)
        app.discoveryCloseDelay = .milliseconds(10)
        app.showingAgentDiscovery = true
        await app.closeDiscoveryWhenConnected()
        #expect(app.showingAgentDiscovery)
    }
}
