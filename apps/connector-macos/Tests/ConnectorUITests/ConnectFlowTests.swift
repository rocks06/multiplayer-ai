import Testing
import Foundation
@testable import ConnectorUI

/**
 * Connecting an agent, the whole way through, as a person does it.
 *
 * Twice now the sheet stayed open after a connection that had plainly succeeded, and twice the
 * tests around it passed — because they set the end state by hand instead of walking the path.
 * This drives the real one: the workspace answers over a stubbed transport, the helper is a real
 * process answering real commands, and what is asserted is what a person sees — the sheet open,
 * then connected, then gone.
 */
/// Fixture identifiers, readable from the stub transport, which answers off the main actor.
enum ConnectFixture {
    static let company = "00000000-0000-4000-8000-0000000000c1"
    static let room = "00000000-0000-4000-8000-0000000000e1"
    static let principal = "00000000-0000-4000-8000-0000000000a1"
    static let runtimeId = "fixture-runtime"
}

@Suite(.serialized) @MainActor struct ConnectFlowTests {
    typealias Fixture = ConnectFixture

    /// The workspace, answering only what this path asks of it. Nothing here reaches a network.
    final class Workspace: URLProtocol, @unchecked Sendable {
        nonisolated(unsafe) static var seen: [String] = []
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func stopLoading() {}
        override func startLoading() {
            let path = request.url?.path ?? ""
            Workspace.seen.append("\(request.httpMethod ?? "") \(path)")
            var body: [String: Any] = [:]
            if path == "/v1/auth/me" {
                body = ["user": ["id": "fixture-user", "email": "fixture@example.test", "display_name": "Fixture Person"],
                        "companies": [["company_id": ConnectFixture.company, "company_name": "Fixture Workspace",
                                       "principal_id": "fixture-person-principal", "display_name": "Fixture Person"]]]
            } else if path.hasSuffix("/runtime-connections") {
                body = request.httpMethod == "GET"
                    ? ["runtime": NSNull()]
                    : ["principal_id": ConnectFixture.principal, "display_name": "Fixture Agent", "reused": false]
            } else if path.hasSuffix("/rooms") {
                body = ["rooms": [["room_id": ConnectFixture.room, "name": "Fixture Room", "project_name": "Fixture Project"]]]
            } else if path.hasSuffix("/gateway-credentials") {
                body = ["credential_token": "fixture-credential", "agent_display_name": "Fixture Agent",
                        "room": ["id": ConnectFixture.room, "name": "Fixture Room", "project_name": "Fixture Project"]]
            } else if path.hasSuffix("/agents") {
                body = ["agents": [["principal_id": ConnectFixture.principal, "display_name": "Fixture Agent",
                                    "rooms": [["room_id": ConnectFixture.room, "name": "Fixture Room"]]]]]
            }
            let data = try! JSONSerialization.data(withJSONObject: body)
            let response = HTTPURLResponse(url: request.url!, statusCode: 200,
                                           httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    private static func transport() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Workspace.self]
        return URLSession(configuration: configuration)
    }

    private static var runtimeRecord: [String: Any] {
        ["available": true, "name": "Fixture Runtime", "version": "1.0.0", "profile": "fixture-profile",
         "runtimeType": "fixture", "adapter": "fixture", "readiness": "ready",
         "runtimeInstallationId": ConnectFixture.runtimeId, "externalRuntimeId": ConnectFixture.runtimeId,
         "connectorInstallationId": "fixture-connector", "endpoint": "cli:fixture", "probeStatus": "healthy"]
    }

    /**
     * A helper that behaves as the real one does around a connect: it holds no agent until it is
     * configured and connected, and only then reports that agent live — which is what the helper
     * publishes once the workspace has sent session.ready.
     */
    private func helper() throws -> SidecarClient {
        let root = FileManager.default.temporaryDirectory.appending(path: "mpai-connect-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let runtime = String(data: try JSONSerialization.data(withJSONObject: Self.runtimeRecord), encoding: .utf8)!
        let script = root.appending(path: "helper")
        try """
        #!/bin/sh
        # Ready for its first few answers, then catching up on the room, as a real agent is.
        while IFS= read -r line; do
          id=$(printf '%s' "$line" | sed -n 's/.*"id" *: *\\([0-9][0-9]*\\).*/\\1/p')
          case "$line" in
            *connect*) touch "$LIVE"; printf '{"type":"reply","id":%s,"ok":true}\\n' "$id";;
            *status*)
              if [ -f "$LIVE" ]; then
                asked=$(cat "$COUNT" 2>/dev/null || echo 0); asked=$((asked+1)); echo "$asked" > "$COUNT"
                if [ "$asked" -le 3 ]; then gateway=live; pending=0; else gateway=resyncing; pending=3; fi
                printf '{"type":"reply","id":%s,"ok":true,"state":{"enrolled":true,"running":true,"gateway":"%s","runtime":%s,"sync":{"pending":%s},"agents":[{"runtimeSelectionId":"%s","agentPrincipalId":"%s","enrolled":true,"running":true,"gateway":"%s","runtime":%s,"sync":{"pending":%s}}]}}\\n' "$id" "$gateway" "$RUNTIME" "$pending" "$SELECTION" "$PRINCIPAL" "$gateway" "$RUNTIME" "$pending"
              else
                printf '{"type":"reply","id":%s,"ok":true,"state":{"enrolled":false,"running":false,"gateway":"not_started","runtime":%s,"sync":{"pending":0},"agents":[]}}\\n' "$id" "$RUNTIME"
              fi;;
            *) printf '{"type":"reply","id":%s,"ok":true}\\n' "$id";;
          esac
        done
        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
        let sidecar = SidecarClient(executable: script, supportDirectory: root,
                                    environment: ["LIVE": root.appending(path: "live").path,
                                                  "COUNT": root.appending(path: "asked").path, "RUNTIME": runtime,
                                                  "SELECTION": ConnectFixture.runtimeId, "PRINCIPAL": ConnectFixture.principal,
                                                  "PATH": "/usr/bin:/bin"],
                                    // Generous on purpose: a loaded machine must not read as a failure.
                                    requestTimeout: 20)
        sidecar.start()
        return sidecar
    }

    /// Nothing a test writes may touch the credentials of the app on this Mac.
    private func isolateKeychain() -> String {
        let service = "com.multiplayerai.tests.\(UUID().uuidString)"
        Keychain.unbundledService = service
        return service
    }

    @Test func connectingAnAgentOpensTheSheetReportsConnectedAndThenDismissesItself() async throws {
        _ = isolateKeychain()
        defer { Keychain.removeCredential(for: ConnectFixture.principal); Keychain.removeEnrolment(for: ConnectFixture.principal) }
        Workspace.seen = []
        var progress = Progress()
        progress.setupComplete = true
        progress.workspaceAddress = "http://workspace.fixture"
        let connector = ConnectorModel(sidecar: try helper())
        let app = AppModel(store: MemoryProgressStore(progress), connector: connector, transport: Self.transport())
        app.discoveryCloseDelay = .milliseconds(120)
        /* The app watches the helper while all of this happens, which is why the sheet saw the
           agent stop being "live" the moment it began catching up. Same loop, test speed. */
        let polling = Task { @MainActor in
            while !Task.isCancelled { await connector.sidecar.refresh(); try? await Task.sleep(for: .milliseconds(25)) }
        }
        defer { polling.cancel() }

        // What a person does: open Detect Agent, choose the agent it found, name it, pick the room.
        await app.refresh()
        app.showingAgentDiscovery = true
        app.acceptDiscovery([try #require(DiscoveredAgent.decode(Self.runtimeRecord))])
        app.selectDiscoveredAgent(ConnectFixture.runtimeId)
        app.discoveryDisplayName = "Fixture Agent"
        app.discoveryCompanyId = ConnectFixture.company
        app.discoveryRoomId = ConnectFixture.room
        #expect(app.showingAgentDiscovery)
        #expect(app.discoveryPhase == .results)

        /* What the sheet does, in order. The agent reports ready and then, as a real one does,
           immediately starts catching up on its room — which is when the sheet used to stay open
           for good, because catching up is not "live". */
        var seenConnected = false
        let watching = Task { @MainActor in
            for _ in 0..<2000 {
                if app.discoveryPhase == .connected { seenConnected = true }
                if seenConnected && !app.showingAgentDiscovery { return }
                try? await Task.sleep(for: .milliseconds(5))
            }
        }
        await app.confirmRuntimeConnection()
        await watching.value

        #expect(Workspace.seen.contains("POST /v1/companies/\(ConnectFixture.company)/runtime-connections"))
        #expect(seenConnected)                                         // open → connected
        #expect(app.showingAgentDiscovery == false)                    // → dismissed
        // And the agent is by now catching up on its room, which is not "live" and never was a
        // reason to keep the sheet: this is the state the old check re-read and refused to close on.
        await connector.sidecar.refresh()
        #expect(connector.state(of: ConnectFixture.principal).gateway == "resyncing")
        #expect(app.sessionIsReady(ConnectFixture.principal) == false)
        #expect(app.showingAgentDiscovery == false)
        connector.sidecar.stop()
    }

    @Test func aConnectionThatFailsLeavesTheSheetOpenToExplainItself() async throws {
        Workspace.seen = []
        var progress = Progress()
        progress.setupComplete = true
        progress.workspaceAddress = "http://workspace.fixture"
        // A helper that never reports the agent live: the workspace never confirmed a session.
        let root = FileManager.default.temporaryDirectory.appending(path: "mpai-connect-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let script = root.appending(path: "helper")
        try """
        #!/bin/sh
        while IFS= read -r line; do
          id=$(printf '%s' "$line" | sed -n 's/.*"id" *: *\\([0-9][0-9]*\\).*/\\1/p')
          printf '{"type":"reply","id":%s,"ok":true}\\n' "$id"
        done
        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
        let sidecar = SidecarClient(executable: script, supportDirectory: root,
                                    environment: ["PATH": "/usr/bin:/bin"], requestTimeout: 2)
        sidecar.start()
        let app = AppModel(store: MemoryProgressStore(progress), connector: ConnectorModel(sidecar: sidecar),
                           transport: Self.transport())
        app.discoveryCloseDelay = .milliseconds(20)
        await app.refresh()
        app.showingAgentDiscovery = true
        app.acceptDiscovery([try #require(DiscoveredAgent.decode(Self.runtimeRecord))])
        app.selectDiscoveredAgent(ConnectFixture.runtimeId)
        app.discoveryDisplayName = "Fixture Agent"
        app.discoveryCompanyId = ConnectFixture.company
        app.discoveryRoomId = ConnectFixture.room

        await app.confirmRuntimeConnection()
        #expect(app.showingAgentDiscovery)
        if case .failed = app.discoveryPhase {} else { Issue.record("expected a failure, got \(app.discoveryPhase)") }
        sidecar.stop()
    }
}
