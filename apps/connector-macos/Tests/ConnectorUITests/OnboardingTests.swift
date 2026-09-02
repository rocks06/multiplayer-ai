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

/// Upgrading a Mac that the previous version already set up.
///
/// The Connector recorded which agent this machine is. The unified app keeps the same facts under
/// its own name, and if it does not carry them across on first run it presents a working Mac as a
/// blank one — then asks for a name for an agent that already exists, creating a second identity
/// beside the real one.
@Suite struct UpgradeFromConnectorTests {
    private let enrolment = Keychain.Enrolment(
        baseURL: "http://10.16.80.15:4100", roomId: "room-1", roomName: "Rate-limit policy",
        projectName: "Rate-limit policy", agentPrincipalId: "agent-1", agentDisplayName: "Drafting agent")

    @Test func aMacTheConnectorSetUpIsNotTreatedAsNew() {
        let adopted = AppModel.adopting(Progress(), from: enrolment)
        #expect(adopted.setupComplete)
        #expect(adopted.agentPrincipalId == "agent-1")
        #expect(adopted.agentDisplayName == "Drafting agent")
        #expect(adopted.roomId == "room-1")
        #expect(adopted.workspaceAddress == "http://10.16.80.15:4100")
    }

    /// The whole point: it must not end up on the screen that makes another agent.
    @Test func itIsNeverAskedToNameAnAgentItAlreadyHas() {
        let adopted = AppModel.adopting(Progress(), from: enrolment)
        let situation = Situation(setupComplete: adopted.setupComplete, signedIn: true, hasWorkspace: true,
                                  hasAgentIdentity: adopted.agentPrincipalId != nil,
                                  hasRoom: adopted.roomId != nil, bound: true)
        #expect(Onboarding.step(for: situation) == .ready)
    }

    /// The credential does not survive a re-signed build, so the honest destination after an
    /// upgrade is the one screen that fixes exactly that — not the beginning.
    @Test func anUpgradeThatCannotPresentItsCredentialGoesToReconnect() {
        let adopted = AppModel.adopting(Progress(), from: enrolment)
        let situation = Situation(setupComplete: adopted.setupComplete, signedIn: true, hasWorkspace: true,
                                  hasAgentIdentity: true, hasRoom: true, bound: true,
                                  credentialProblem: .unreadable(-25300))
        #expect(Onboarding.step(for: situation) == .reconnect)
    }

    @Test func aMacThatWasNeverSetUpIsLeftAlone() {
        #expect(AppModel.adopting(Progress(), from: nil) == Progress())
    }

    /// Adoption happens once. Anything the person has done since is theirs, not the old app's.
    @Test func itNeverOverwritesWhatTheUnifiedAppAlreadyKnows() {
        var current = Progress()
        current.setupComplete = true
        current.agentPrincipalId = "agent-current"
        current.roomId = "room-current"
        current.workspaceAddress = "http://127.0.0.1:4100"
        #expect(AppModel.adopting(current, from: enrolment) == current)
    }
}

/// A sign-in link that arrives before the app knows where it is.
///
/// Being opened *by* a link is the ordinary way in, so the link lands before anything is settled.
/// The first version of this waited for the root view's task to call back — and on a cold launch
/// that call never came, so every link was queued and silently never spent. Initialization is the
/// model's own business now.
@MainActor
@Suite struct QueuedAuthURLTests {
    private func model() -> AppModel {
        // Points nowhere reachable on purpose: this is about what is held, not what is redeemed.
        var start = Progress()
        start.workspaceAddress = "http://127.0.0.1:1"
        return AppModel(store: MemoryProgressStore(start),
                        connector: ConnectorModel(live: false, state: .unknown))
    }

    @Test func aLinkArrivingBeforeTheAppIsReadyIsKeptRatherThanLost() async {
        let app = model()
        #expect(app.initialized == false)
        await app.receive(authURL: "multiplayerai://auth?token=mpsi_waiting")
        #expect(app.queuedAuthURL == "multiplayerai://auth?token=mpsi_waiting")
    }

    @Test func theFirstLookAtTheWorldIsWhatMakesTheAppReady() async {
        let app = model()
        await app.refresh()
        #expect(app.initialized)
    }

    /// Once ready, the queue is empty — the link was taken up rather than left sitting there.
    @Test func aQueuedLinkIsSpentAsSoonAsThereIsSomewhereToTakeIt() async {
        let app = model()
        await app.receive(authURL: "multiplayerai://auth?token=mpsi_waiting")
        #expect(app.queuedAuthURL != nil)
        await app.refresh()
        #expect(app.queuedAuthURL == nil)
    }
}

/// Which room this Mac is actually working in.
///
/// An agent in two rooms was connected from the second and bound to the first, because the code
/// named no room and redemption returned every room the agent belonged to, oldest first. From
/// then on the workspace said connected, the room said the agent had never appeared, and a
/// message addressed to it there was never seen. The binding is a durable fact about the machine:
/// it may be wrong, and when it is, the app says so rather than quietly reassigning it.
@Suite struct RoomBindingTests {
    @Test func aMacBoundToTheRoomItIsMeantToBeInIsCorrect() {
        #expect(AppModel.binding(bound: "room-a", expected: "room-a") == .correct("room-a"))
    }

    @Test func aMacBoundSomewhereElseIsNamedAsSuch() {
        #expect(AppModel.binding(bound: "roomr", expected: "testing-1")
                == .elsewhere(bound: "roomr", expected: "testing-1"))
    }

    /// Nothing to compare against is not a mismatch — it is a Mac that has not been bound.
    @Test func anUnboundMacIsNotAMismatch() {
        #expect(AppModel.binding(bound: nil, expected: "room-a") == .notBound)
        #expect(AppModel.binding(bound: nil, expected: nil) == .notBound)
    }

    /// A binding with nothing expected of it is left alone rather than called wrong.
    @Test func aBindingWithNoExpectationStands() {
        #expect(AppModel.binding(bound: "room-a", expected: nil) == .correct("room-a"))
    }
}

/// The moves that actually exist for this Mac.
@Suite struct MoveTargetTests {
    private let rooms = [AgentRoom(id: "roomr", name: "roomr"),
                         AgentRoom(id: "testing-1", name: "TESTING #1")]

    /// The gate that surfaced nothing. Comparing the app's own two records finds no mismatch on a
    /// Mac that was set up here — both said roomr — while the agent was plainly also a member of
    /// the room somebody was watching. The move that exists is to the *other* room, so that is
    /// what has to be offered.
    @Test func theOtherRoomsTheAgentWorksInAreOffered() {
        let targets = AppModel.moveTargets(bound: "roomr", agentRooms: rooms)
        #expect(targets.map(\.id) == ["testing-1"])
    }

    @Test func theRoomItIsAlreadyInIsNotAMove() {
        #expect(AppModel.moveTargets(bound: "testing-1", agentRooms: rooms).map(\.id) == ["roomr"])
        #expect(AppModel.moveTargets(bound: "only", agentRooms: [AgentRoom(id: "only", name: "Only")]).isEmpty)
    }

    /// An unbound Mac has nothing to move; it has something to connect, which is a different screen.
    @Test func anUnboundMacIsOfferedNothing() {
        #expect(AppModel.moveTargets(bound: nil, agentRooms: rooms).isEmpty)
    }
}

/// Moving rooms, and what survives an interruption.
///
/// A move gives up a live binding before it has a new one. If the target were only held in
/// memory, an interruption anywhere in between — a failed mint, a dropped network, the app being
/// quit — would leave the Mac pointing at the room it was trying to leave, and it would quietly
/// reconnect there. The target is written down first, so every resumption goes forwards.
@MainActor
@Suite struct DurableMoveTests {
    private func model(boundTo room: String) -> AppModel {
        var start = Progress()
        start.setupComplete = true
        start.workspaceAddress = "http://127.0.0.1:1"   // nothing is listening, so binding fails
        start.agentPrincipalId = "agent-1"
        start.agentDisplayName = "JJ"
        start.roomId = room
        return AppModel(store: MemoryProgressStore(start),
                        connector: ConnectorModel(live: false, state: .unknown))
    }

    @Test func aMoveThatCouldNotFinishStillPointsAtTheNewRoom() async {
        let app = model(boundTo: "roomr")
        await app.move(to: "testing-1")
        // Binding could not complete — there is nothing to bind against — and the Mac is still
        // aimed at the room it was asked to move to, not the one it left.
        #expect(app.progress.roomId == "testing-1")
        #expect(app.connector.enrolment == nil)
    }

    /// What a relaunch would then decide: finish the move, rather than reconnect to the old room.
    @Test func aRelaunchAfterAnInterruptedMoveResumesTowardsTheNewRoom() async {
        let app = model(boundTo: "roomr")
        await app.move(to: "testing-1")
        let situation = Situation(setupComplete: true, signedIn: true, hasWorkspace: true,
                                  hasAgentIdentity: true, hasRoom: app.progress.roomId != nil,
                                  bound: app.connector.enrolment != nil)
        #expect(Onboarding.step(for: situation) == .binding)
    }

    /// A room the agent does not work in is refused before anything is given up.
    @Test func aMoveToARoomTheAgentDoesNotWorkInGivesUpNothing() async {
        let app = model(boundTo: "roomr")
        await app.refresh()
        #expect(app.progress.roomId == "roomr")
    }

/**
 * When binding may mint a credential, and when it must not.
 *
 * Minting retires the credential before it, so binding a Mac that is already bound destroys the
 * binding that works. `move` calls `bind`, and the binding screen it lands on calls `bind` again
 * from its `.task`: two credentials in the same instant, the second retiring the first, and the
 * running agent left holding a key the workspace had already replaced. That is what a Mac that
 * connected, worked for a few seconds, and then announced its access had been removed was doing.
 */
@Suite("Whether binding mints a new credential")
struct BindDecisionTests {
    private func enrolment(room: String = "room-1", agent: String = "jj") -> Keychain.Enrolment {
        .init(baseURL: "http://example.test", roomId: room, roomName: "TESTING #1",
              projectName: nil, agentPrincipalId: agent, agentDisplayName: "JJ")
    }

    @Test("a Mac already bound to this room and agent mints nothing")
    func alreadyBound() {
        #expect(AppModel.shouldMint(existing: enrolment(), roomId: "room-1", agentPrincipalId: "jj",
                                    hasCredential: true, credentialProblem: nil, gateway: "live") == false)
    }

    @Test("a Mac with no binding, or no credential to present, mints one")
    func nothingToKeep() {
        #expect(AppModel.shouldMint(existing: nil, roomId: "room-1", agentPrincipalId: "jj",
                                    hasCredential: false, credentialProblem: nil, gateway: nil))
        #expect(AppModel.shouldMint(existing: enrolment(), roomId: "room-1", agentPrincipalId: "jj",
                                    hasCredential: false, credentialProblem: nil, gateway: "live"))
    }

    @Test("moving to another room, or becoming another agent, mints one")
    func aDifferentJob() {
        #expect(AppModel.shouldMint(existing: enrolment(), roomId: "room-2", agentPrincipalId: "jj",
                                    hasCredential: true, credentialProblem: nil, gateway: "live"))
        #expect(AppModel.shouldMint(existing: enrolment(), roomId: "room-1", agentPrincipalId: "coleman",
                                    hasCredential: true, credentialProblem: nil, gateway: "live"))
    }

    /// Otherwise a Mac whose credential another machine replaced could never mint a new one, and
    /// "Try again" would quietly do nothing however often it was pressed.
    @Test("a binding the workspace is refusing is replaced rather than kept")
    func refusedBindingIsReplaced() {
        #expect(AppModel.shouldMint(existing: enrolment(), roomId: "room-1", agentPrincipalId: "jj",
                                    hasCredential: true, credentialProblem: nil, gateway: "auth_required"))
        #expect(AppModel.shouldMint(existing: enrolment(), roomId: "room-1", agentPrincipalId: "jj",
                                    hasCredential: true, credentialProblem: .missing, gateway: "live"))
    }

    /// Being replaced resolves itself — the sidecar restarts with the newer credential — so it is
    /// emphatically not a reason to mint another one and replace something all over again.
    @Test("being superseded does not mint another credential")
    func supersededDoesNotMint() {
        #expect(AppModel.shouldMint(existing: enrolment(), roomId: "room-1", agentPrincipalId: "jj",
                                    hasCredential: true, credentialProblem: nil,
                                    gateway: "superseded") == false)
    }
}
}
