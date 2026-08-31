import Testing
import Foundation
@testable import ConnectorUI

/// Where a person lands, decided from what is true rather than from a step they got to.
///
/// The cases that matter are the ones where something was already done and then stopped being
/// true: a session that expired, an agent somebody removed, a credential macOS will not release.
/// Each has to route to the one screen that fixes it, and none of them may route to the start.
@Suite struct OnboardingTests {
    @Test func firstLaunchAsksToSetUp() {
        #expect(Onboarding.step(for: Situation()) == .welcome)
    }

    @Test func setUpButSignedOutAsksWho() {
        #expect(Onboarding.step(for: Situation(setupComplete: true)) == .account)
    }

    @Test func signedInWithNothingNamesTheWorkspace() {
        #expect(Onboarding.step(for: Situation(setupComplete: true, signedIn: true)) == .workspace)
    }

    @Test func workspaceWithNoAgentAsksForTheAgent() {
        let situation = Situation(setupComplete: true, signedIn: true, hasWorkspace: true)
        #expect(Onboarding.step(for: situation) == .agent)
    }

    @Test func agentWithNoRoomAsksForTheRoom() {
        let situation = Situation(setupComplete: true, signedIn: true, hasWorkspace: true, hasAgentIdentity: true)
        #expect(Onboarding.step(for: situation) == .room)
    }

    @Test func roomWithNoBindingBindsWithoutAsking() {
        let situation = Situation(setupComplete: true, signedIn: true, hasWorkspace: true,
                                  hasAgentIdentity: true, hasRoom: true)
        #expect(Onboarding.step(for: situation) == .binding)
    }

    @Test func aFinishedMacOpensTheProduct() {
        let situation = Situation(setupComplete: true, signedIn: true, hasWorkspace: true,
                                  hasAgentIdentity: true, hasRoom: true, bound: true)
        #expect(Onboarding.step(for: situation) == .ready)
        #expect(Onboarding.isOnboarding(.ready) == false)
    }

    /// The bug this whole phase inherits: a Mac that is set up but cannot present its credential
    /// must never be told it is a stranger. It goes to its own recovery, one step, nothing else
    /// undone.
    @Test func anUnreadableCredentialGoesToReconnectNotToTheStart() {
        let situation = Situation(setupComplete: true, signedIn: true, hasWorkspace: true,
                                  hasAgentIdentity: true, hasRoom: true, bound: true,
                                  credentialProblem: .unreadable(-25300))
        #expect(Onboarding.step(for: situation) == .reconnect)
    }

    /// Every remedy for a credential problem needs a signed-in person to carry it out, so an
    /// expired session is asked about first even though the credential is also broken.
    @Test func anExpiredSessionOutranksTheCredentialProblem() {
        let situation = Situation(setupComplete: true, signedIn: false, hasWorkspace: true,
                                  hasAgentIdentity: true, hasRoom: true, bound: true,
                                  credentialProblem: .missing)
        #expect(Onboarding.step(for: situation) == .account)
    }

    /// Signing out and back in does not re-run setup, and does not re-ask for the agent: only
    /// the thing that actually became untrue is asked about again.
    @Test func signingBackInReturnsStraightToTheProduct() {
        var situation = Situation(setupComplete: true, signedIn: true, hasWorkspace: true,
                                  hasAgentIdentity: true, hasRoom: true, bound: true)
        situation.signedIn = false
        #expect(Onboarding.step(for: situation) == .account)
        situation.signedIn = true
        #expect(Onboarding.step(for: situation) == .ready)
    }
}

@Suite struct ProgressStoreTests {
    /// What a returning launch depends on: everything needed to skip onboarding survives a
    /// round trip, including the room to reopen.
    @Test func progressSurvivesARoundTrip() throws {
        var progress = Progress()
        progress.setupComplete = true
        progress.companyId = "company"
        progress.agentPrincipalId = "agent"
        progress.agentDisplayName = "Research agent"
        progress.roomId = "room"
        progress.workspaceAddress = "http://127.0.0.1:4100"
        progress.lastRoomPath = "/rooms/company/room"

        let data = try JSONEncoder().encode(progress)
        let decoded = try JSONDecoder().decode(Progress.self, from: data)
        #expect(decoded == progress)
    }

    @Test func anEmptyStoreIsAFirstLaunch() {
        #expect(Progress().setupComplete == false)
        #expect(Onboarding.step(for: Situation(setupComplete: Progress().setupComplete)) == .welcome)
    }
}
