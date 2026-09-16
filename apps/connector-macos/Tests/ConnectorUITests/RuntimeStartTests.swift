import Testing
import Foundation
@testable import ConnectorUI

/// Selecting a stopped agent starts it — shown, bounded, retryable — through a real helper process.
/// The helper here is a fixture that answers the one command this is about; profile ids are fixtures.
@Suite(.serialized) @MainActor struct RuntimeStartTests {
    private struct Harness {
        let app: AppModel
        let calls: URL
        let failFlag: URL
        var startCount: Int { ((try? String(contentsOf: calls, encoding: .utf8)) ?? "").split(separator: "\n").count }
    }

    private static func record(id: String, readiness: String) -> [String: Any] {
        ["available": true, "name": "Hermes Agent", "version": "0.21.0", "profile": id, "runtimeType": "hermes",
         "readiness": readiness, "runtimeInstallationId": id, "externalRuntimeId": id,
         "connectorInstallationId": "connector", "endpoint": "cli:hermes",
         "probeStatus": readiness == "ready" ? "healthy" : "failed"]
    }

    private func harness(stopped id: String) throws -> Harness {
        let root = FileManager.default.temporaryDirectory.appending(path: "mpai-start-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let ready = String(data: try JSONSerialization.data(withJSONObject: Self.record(id: id, readiness: "ready")), encoding: .utf8)!
        let script = root.appending(path: "helper")
        try """
        #!/bin/sh
        while IFS= read -r line; do
          id=$(printf '%s' "$line" | sed -n 's/.*"id" *: *\\([0-9][0-9]*\\).*/\\1/p')
          case "$line" in
            *start-runtime*)
              echo start >> "$CALLS"; sleep 1
              if [ -f "$FAILFLAG" ]; then
                printf '{"type":"reply","id":%s,"ok":false,"error":"Hermes could not start this profile gateway: launchctl bootstrap failed: 5: Input/output error"}\\n' "$id"
              else
                printf '{"type":"reply","id":%s,"ok":true,"runtime":%s}\\n' "$id" "$READY"
              fi;;
            *) printf '{"type":"reply","id":%s,"ok":true}\\n' "$id";;
          esac
        done
        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
        let calls = root.appending(path: "calls"), failFlag = root.appending(path: "fail")
        let sidecar = SidecarClient(executable: script, supportDirectory: root,
                                    environment: ["CALLS": calls.path, "FAILFLAG": failFlag.path, "READY": ready, "PATH": "/usr/bin:/bin"],
                                    requestTimeout: 10)
        sidecar.start()
        let app = AppModel(store: MemoryProgressStore(), connector: ConnectorModel(sidecar: sidecar))
        return Harness(app: app, calls: calls, failFlag: failFlag)
    }

    private func discovered(_ id: String, readiness: String) throws -> DiscoveredAgent {
        try #require(DiscoveredAgent.decode(Self.record(id: id, readiness: readiness)))
    }

    @Test func choosingAStoppedProfileStartsItShowsStartingAndMakesItConnectable() async throws {
        let h = try harness(stopped: "fixture-default")
        let agent = try discovered("fixture-default", readiness: "installed_not_running")
        let other = try discovered("fixture-other", readiness: "installed_not_running")
        h.app.acceptDiscovery([agent, other])
        #expect(AppModel.needsStart(agent.runtime))
        let choosing = Task { await h.app.chooseDiscoveredAgent(agent.id) }
        for _ in 0..<40 where h.app.startingRuntimeId == nil { try await Task.sleep(for: .milliseconds(25)) }
        #expect(h.app.discoveryStatus(agent) == "Starting agent…")
        await choosing.value
        #expect(h.app.startingRuntimeId == nil)
        #expect(h.app.selectedDiscoveredAgent?.isConnectable == true)
        #expect(h.app.discoveryStatus(h.app.selectedDiscoveredAgent!) == "Hermes Agent is ready to connect")
        #expect(h.startCount == 1)
        // The other profile was never asked to start and still reads as stopped.
        #expect(h.app.discoveredAgents.first { $0.id == other.id }?.runtime.readiness == "installed_not_running")
        h.app.connector.sidecar.stop()
    }

    @Test func aFailedStartShowsWhatHermesSaidAndRetrySucceeds() async throws {
        let h = try harness(stopped: "fixture-broken")
        try Data().write(to: h.failFlag)
        let agent = try discovered("fixture-broken", readiness: "installed_not_running")
        h.app.acceptDiscovery([agent])
        await h.app.chooseDiscoveredAgent(agent.id)
        let failure = try #require(h.app.runtimeStartErrors[agent.id])
        #expect(failure.contains("Input/output error"))
        #expect(h.app.discoveryStatus(agent) == failure)
        #expect(h.app.selectedDiscoveredAgent?.isConnectable == false)
        // Choosing it again does not silently retry; Retry does.
        await h.app.chooseDiscoveredAgent(agent.id)
        #expect(h.startCount == 1)
        try FileManager.default.removeItem(at: h.failFlag)
        #expect(await h.app.startDiscoveredRuntime(agent.id))
        #expect(h.app.runtimeStartErrors[agent.id] == nil)
        #expect(h.startCount == 2)
        h.app.connector.sidecar.stop()
    }

    @Test func anAlreadyRunningProfileIsNeverStarted() async throws {
        let h = try harness(stopped: "unused")
        let running = try discovered("fixture-running", readiness: "ready")
        h.app.acceptDiscovery([running])
        await h.app.chooseDiscoveredAgent(running.id)
        #expect(await h.app.startDiscoveredRuntime(running.id))
        #expect(h.startCount == 0)
        #expect(!AppModel.needsStart(running.runtime))
        h.app.connector.sidecar.stop()
    }
}
