import Testing
import Foundation
@testable import ConnectorUI

/// What happens when this Mac cannot produce its credential.
///
/// This is the failure that shipped: an enrolled Mac whose credential the Keychain would not
/// release — the usual cause being the app replaced by a differently-signed build — configured
/// nothing, reported nothing, and rendered as "Not set up". The person was shown the enrolment
/// screen and asked for a code, with no hint that anything had gone wrong or that their setup
/// was still there. Every check below exists to keep that from returning.
@Suite("A credential this Mac cannot present")
struct CredentialTests {
    private func state(enrolled: Bool = false, running: Bool = false, gateway: String = "not_started") -> SidecarState {
        SidecarState(enrolled: enrolled, running: running, startedAt: nil, gateway: gateway,
                     runtime: .init(available: true, name: "Hermes Agent", version: "0.20.5"),
                     sync: .init(lastContiguousSeq: nil, pending: 0), identity: nil, lastError: nil)
    }

    @Test("a Keychain that refuses to release the item is not reported as an empty one")
    func deniedIsNotMissing() {
        // -25308 is interaction-not-allowed; -34018 is the missing-entitlement case that an
        // ad-hoc re-sign produces. Neither means "nothing is stored".
        for denial: OSStatus in [errSecAuthFailed, errSecInteractionNotAllowed, -34018, errSecUserCanceled] {
            #expect(Keychain.classify(status: denial, data: nil) == .unreadable(denial))
        }
        #expect(Keychain.classify(status: errSecItemNotFound, data: nil) == .missing)
    }

    @Test("an item that comes back empty or undecodable is a problem, not an absence")
    func emptyIsNotMissing() {
        #expect(Keychain.classify(status: errSecSuccess, data: nil) == .unreadable(errSecDecode))
        #expect(Keychain.classify(status: errSecSuccess, data: Data()) == .unreadable(errSecDecode))
        #expect(Keychain.classify(status: errSecSuccess, data: Data([0xFF, 0xFE])) == .unreadable(errSecDecode))
    }

    @Test("a credential that reads cleanly is simply returned")
    func found() {
        #expect(Keychain.classify(status: errSecSuccess, data: Data("magc_abc123".utf8)) == .found("magc_abc123"))
    }

    @Test("an enrolled Mac that cannot present its credential says Sign-in needed, not Not set up")
    func doesNotClaimNotSetUp() {
        // The sidecar is truthful here: it was never configured, so it reports enrolled: false.
        // The app must not repeat that back to someone who *did* set this Mac up.
        let unconfigured = state(enrolled: false, running: false)
        #expect(Diagnosis.health(of: unconfigured) == .notConnected)

        for problem: CredentialProblem in [.missing, .unreadable(errSecInteractionNotAllowed)] {
            #expect(Diagnosis.health(of: unconfigured, credential: problem) == .authRequired)
            #expect(Diagnosis.health(of: unconfigured, credential: problem).title == "Sign-in needed")
            #expect(Diagnosis.workspaceDetail(unconfigured, credential: problem) == "Sign-in needed")
        }
    }

    @Test("it outranks every other state, because nothing can proceed without it")
    func outranksEverything() {
        for gateway in ["live", "reconnecting", "stalled", "offline", "not_started"] {
            for running in [true, false] {
                #expect(Diagnosis.health(of: state(enrolled: true, running: running, gateway: gateway),
                                         credential: .missing) == .authRequired)
            }
        }
    }

    @Test("no problem means the old reasoning is completely untouched")
    func absentProblemChangesNothing() {
        let live = SidecarState(enrolled: true, running: true, startedAt: nil, gateway: "live",
                                runtime: .init(available: true, name: "Hermes Agent", version: "0.20.5"),
                                sync: .init(lastContiguousSeq: 3, pending: 0), identity: nil, lastError: nil)
        #expect(Diagnosis.health(of: live, credential: nil) == .connected)
        #expect(Diagnosis.health(of: live) == .connected)
        #expect(Diagnosis.workspaceDetail(live, credential: nil) == "Connected")
    }

    @Test("each cause explains what to actually do, in words with no jargon in them")
    func recoveryIsActionable() {
        for problem: CredentialProblem in [.missing, .unreadable(-34018)] {
            let recovery = problem.recovery
            // It has to name a step the person can take, not just describe the state.
            #expect(recovery.contains("code"))
            #expect(recovery.contains("workspace"))
            for jargon in ["principal", "keychain item", "entitlement", "osstatus", "token",
                           "session", "cursor", "launchd", "node", "bridge", "socket", "-34018"] {
                #expect(!recovery.lowercased().contains(jargon), "\(recovery) mentions \(jargon)")
            }
        }
        // The two remedies genuinely differ, so the text must too.
        #expect(CredentialProblem.missing.recovery != CredentialProblem.unreadable(-34018).recovery)
        // The one that a replaced build causes should say so, because that is the whole cause.
        #expect(CredentialProblem.unreadable(-34018).recovery.contains("build"))
    }

    @Test("resuming stays silent only for a Mac that was never set up")
    func silenceIsEarned() {
        // The one case that legitimately says nothing.
        #expect(SidecarClient.resumeDecision(enrolled: false, lookup: nil) == .nothingToResume)
        #expect(SidecarClient.resumeDecision(enrolled: false, lookup: .missing) == .nothingToResume)

        // Everything else about an enrolled Mac must produce a state somebody can see. This is
        // the exact line that used to be `guard let ... else { return }`.
        #expect(SidecarClient.resumeDecision(enrolled: true, lookup: .found("magc_x")) == .resume("magc_x"))
        #expect(SidecarClient.resumeDecision(enrolled: true, lookup: .missing) == .cannotPresent(.missing))
        #expect(SidecarClient.resumeDecision(enrolled: true, lookup: .unreadable(-34018)) == .cannotPresent(.unreadable(-34018)))
        #expect(SidecarClient.resumeDecision(enrolled: true, lookup: nil) == .cannotPresent(.missing))
    }

    @Test("no enrolled Mac ever resumes into silence")
    func enrolledNeverSilent() {
        let lookups: [Keychain.CredentialLookup?] = [
            .found("magc_x"), .missing, .unreadable(errSecAuthFailed),
            .unreadable(errSecInteractionNotAllowed), .unreadable(-34018), .unreadable(errSecDecode), nil,
        ]
        for lookup in lookups {
            #expect(SidecarClient.resumeDecision(enrolled: true, lookup: lookup) != .nothingToResume)
        }
    }
}
