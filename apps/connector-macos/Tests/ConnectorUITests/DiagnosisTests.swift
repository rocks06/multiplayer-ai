import Testing
@testable import ConnectorUI

/// What the Connector is allowed to say about itself.
///
/// The four things it knows are genuinely separate, and the app must not let one stand in for
/// another: a live connection says nothing about whether Hermes is installed, and neither says
/// anything about how much of the room has been read.
private func state(gateway: String = "live", running: Bool = true, enrolled: Bool = true,
                   hermes: Bool = true, pending: Int = 0, seq: Int? = 12,
                   error: String? = nil) -> SidecarState {
    SidecarState(
        enrolled: enrolled, running: running, startedAt: nil, gateway: gateway,
        runtime: .init(available: hermes, name: "Hermes Agent", version: hermes ? "0.19.1" : nil,
                       path: nil, reason: hermes ? nil : "Hermes was not found."),
        sync: .init(lastContiguousSeq: seq, pending: pending),
        identity: nil, lastError: error)
}

@Suite("What the Connector may claim")
struct DiagnosisTests {
    @Test("a Mac with nothing set up says so rather than looking broken")
    func notSetUp() {
        #expect(Diagnosis.health(of: state(running: false, enrolled: false)) == .notConnected)
    }

    @Test("connected means the workspace connection is live and the runtime is usable")
    func connected() {
        #expect(Diagnosis.health(of: state()) == .connected)
    }

    /* Being replaced is not being locked out, and only one of them should reach a person.

       The Mac reported "Sign-in needed — this Mac's access was removed or expired. Sign out and
       enter a new code from your workspace" seconds after connecting, because its own rebind had
       replaced it and nothing could tell the two apart. Nothing had been removed; no code was
       needed; and the room went on showing the agent working the whole time. */
    @Test("being replaced by a newer connection is not a sign-in problem")
    func replaced() {
        let superseded = state(gateway: "superseded", running: false)
        #expect(Diagnosis.health(of: superseded) == .replaced)
        #expect(Diagnosis.health(of: superseded).title == "Reconnecting")
        #expect(Diagnosis.workspaceDetail(superseded) == "Reconnecting")
    }

    /// A credential the workspace genuinely refuses still says so, or the real fault would hide
    /// behind the calmer one.
    @Test("a refused credential still asks for a sign-in")
    func refusedCredentialStillAsks() {
        #expect(Diagnosis.health(of: state(gateway: "auth_required", running: false)) == .authRequired)
    }

    @Test("a live connection with no runtime is not called connected")
    func liveButNoRuntime() {
        // The workspace row still says Connected, because it is — but the headline may not,
        // because nothing can actually be done.
        let missing = state(hermes: false)
        #expect(Diagnosis.health(of: missing) == .runtimeUnavailable)
        #expect(Diagnosis.workspaceDetail(missing) == "Connected")
        #expect(Diagnosis.runtimeDetail(missing) == "Not found")
        // The row is labelled with the runtime's name, so the value must not repeat it.
        #expect(Diagnosis.runtimeDetail(state()) == "0.19.1")
    }

    @Test("a dropped connection reads as reconnecting, not as connected or dead")
    func reconnecting() {
        #expect(Diagnosis.health(of: state(gateway: "reconnecting")) == .reconnecting)
        #expect(Diagnosis.health(of: state(gateway: "stalled")) == .reconnecting)
    }

    @Test("a helper that is not running is offline, whatever it last reported")
    func processDead() {
        #expect(Diagnosis.health(of: state(gateway: "live", running: false)) == .offline)
    }

    @Test("a refused credential is told apart from a network that is down")
    func authRequired() {
        // Both are "not working", and the person has to be told which, because the remedies differ.
        #expect(Diagnosis.health(of: state(gateway: "auth_required")) == .authRequired)
        #expect(Diagnosis.health(of: state(gateway: "offline")) == .offline)
        #expect(Diagnosis.workspaceDetail(state(gateway: "auth_required")) == "Sign-in needed")
    }

    @Test("a refused credential outranks everything, because nothing else can proceed")
    func authWins() {
        #expect(Diagnosis.health(of: state(gateway: "auth_required", running: false, hermes: false)) == .authRequired)
    }

    @Test("how much of the room has been read is reported on its own")
    func sync() {
        #expect(Diagnosis.syncDetail(state(pending: 0)) == "Up to date")
        #expect(Diagnosis.syncDetail(state(pending: 1)) == "1 item waiting")
        #expect(Diagnosis.syncDetail(state(pending: 4)) == "4 items waiting")
        #expect(Diagnosis.syncDetail(state(seq: nil)) == "Nothing read yet")
        // A connection that is live tells you nothing about this, and vice versa.
        #expect(Diagnosis.syncDetail(state(gateway: "live", pending: 3)) == "3 items waiting")
    }

    @Test("nothing the Connector says needs an engineer to interpret it")
    func plainWords() {
        let phrases = [
            Diagnosis.health(of: state()).title,
            Diagnosis.health(of: state(gateway: "auth_required")).title,
            Diagnosis.health(of: state(hermes: false)).title,
            Diagnosis.workspaceDetail(state(gateway: "reconnecting")),
            Diagnosis.syncDetail(state(pending: 2)),
        ]
        for phrase in phrases {
            for jargon in ["principal", "credential", "session", "cursor", "seq", "port",
                           "launchd", "node", "bridge", "socket", "token"] {
                #expect(!phrase.lowercased().contains(jargon), "\(phrase) mentions \(jargon)")
            }
        }
    }
}


@Suite("Where this Mac is pointed")
struct WorkspaceAddressTests {
    @Test("an address has to be somewhere a code could actually be spent")
    func usable() {
        #expect(ConnectorModel.usableAddress("http://workspace.local:4100"))
        #expect(ConnectorModel.usableAddress("https://rooms.example.com"))
        #expect(ConnectorModel.usableAddress("  http://10.0.0.4:4100  "))
        // A default of "localhost" is wrong on every Mac except the one running the workspace,
        // so nothing is assumed and an empty or half-typed address does not enable Connect.
        #expect(!ConnectorModel.usableAddress(""))
        #expect(!ConnectorModel.usableAddress("workspace.local:4100"))
        #expect(!ConnectorModel.usableAddress("http://"))
    }
}
