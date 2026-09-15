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

    /* Signing in is the end of setting up, not the start of a corridor.

       Naming a workspace, then an agent, then a room used to be forced on every account in that
       order, so a person invited to somebody else's room had to create one of their own before
       they could join it — and the workspace filled with rooms nobody wanted. Home offers all
       three; none of them is a step. */
    @Test func signedInWithNothingOpensTheProduct() {
        #expect(Onboarding.step(for: Situation(setupComplete: true, signedIn: true)) == .ready)
    }

    @Test func nothingAboutWorkspaceAgentOrRoomIsAskedForOnTheWayIn() {
        for situation in [
            Situation(setupComplete: true, signedIn: true, hasWorkspace: true),
            Situation(setupComplete: true, signedIn: true, hasWorkspace: true, hasAgentIdentity: true),
            Situation(setupComplete: true, signedIn: true, hasWorkspace: true,
                      hasAgentIdentity: true, hasRoom: true),
        ] { #expect(Onboarding.step(for: situation) == .ready) }
    }

    /// The exception, and the reason this is not simply "signed in means ready": a binding this
    /// Mac cannot present is a fault in something that already exists, and it still needs fixing.
    @Test func aBrokenBindingIsStillRepairedBeforeTheProduct() {
        let situation = Situation(setupComplete: true, signedIn: true, hasWorkspace: true,
                                  hasAgentIdentity: true, hasRoom: true, bound: true,
                                  credentialProblem: .missing)
        #expect(Onboarding.step(for: situation) == .reconnect)
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

    /* What a relaunch then does: finish the move, rather than come back to the old room.

       This used to be the binding step's doing, and the step machine no longer has one — forcing
       every account through workspace, agent and room was what filled the product with junk rooms.
       So the resume moved into the model, and this proves it still happens: the target room is
       recorded, the old binding is gone, and refreshing carries it the rest of the way. */
    @Test func aRelaunchAfterAnInterruptedMoveResumesTowardsTheNewRoom() async {
        let app = model(boundTo: "roomr")
        await app.move(to: "testing-1")
        #expect(app.progress.roomId == "testing-1")
        #expect(app.connector.enrolment == nil)

        // Everything needed to finish is recorded, so a launch that can reach the workspace does.
        #expect(AppModel.shouldResumeBinding(roomId: app.progress.roomId,
                                             agentPrincipalId: app.progress.agentPrincipalId,
                                             hasCompany: true, hasEnrolment: false,
                                             hasProblem: false))
    }

    /// And a Mac with nothing to finish does not go looking for work: a person who has just signed
    /// in, with no room of their own, must not be handed a binding they never asked for.
    @Test func aMacWithNoMoveToFinishBindsNothing() {
        #expect(AppModel.shouldResumeBinding(roomId: nil, agentPrincipalId: "agent-1",
                                             hasCompany: true, hasEnrolment: false,
                                             hasProblem: false) == false)
        #expect(AppModel.shouldResumeBinding(roomId: "testing-1", agentPrincipalId: "agent-1",
                                             hasCompany: true, hasEnrolment: true,
                                             hasProblem: false) == false)
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

    @Test("a room move reuses the credential; another principal needs its own")
    func aDifferentJob() {
        #expect(AppModel.shouldMint(existing: enrolment(), roomId: "room-2", agentPrincipalId: "jj",
                                    hasCredential: true, credentialProblem: nil, gateway: "live") == false)
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

/**
 * Connect existing agent, from the web, on the machine that can actually see the runtime.
 *
 * The browser cannot detect Hermes; it can only ask the Mac to. So Home links to the app, and the
 * app does discovery, validation and enrolment in that order — nothing is created for a runtime
 * that has not answered.
 */
@Suite("The connect-runtime link")
struct ConnectRuntimeLinkTests {
    @Test("is recognised however the link is spelled")
    func recognised() {
        #expect(AppModel.isConnectRuntime("multiplayerai://connect-runtime"))
        #expect(AppModel.isConnectRuntime("multiplayerai:///connect-runtime"))
    }

    /// A sign-in link must still be a sign-in link: these arrive on the same scheme.
    @Test("is not confused with a sign-in link")
    func notASignInLink() {
        #expect(AppModel.isConnectRuntime("multiplayerai://auth?token=mpsi_abc") == false)
        #expect(AppModel.isConnectRuntime("https://example.test/connect-runtime") == false)
        #expect(AppModel.isConnectRuntime("") == false)
    }
}

/**
 * What may be bound to.
 *
 * Found is not the same as reachable, and reachable is not the same as identified. Binding an
 * agent to a runtime that was merely *installed* is how an identity gets minted for something that
 * is not running — the junk this slice exists to stop.
 */
@Suite("Whether a discovered runtime can be connected")
struct RuntimeConnectableTests {
    private func state(_ readiness: String, running: Bool? = nil, reason: String? = nil,
                       endpoint: String? = "cli:/usr/local/bin/hermes") -> SidecarState.Runtime {
        .init(available: readiness != "not_installed", name: "Hermes Agent", version: "0.20.5",
              path: nil, reason: reason, runtimeType: "hermes", externalRuntimeId: "id-1",
              connectorInstallationId: "install-1", endpoint: endpoint, healthEndpoint: nil,
              transport: "cli", probeStatus: readiness == "ready" ? "healthy" : "failed",
              readiness: readiness, serviceRunning: running)
    }

    /* The six situations a person can actually be in, each said in its own words.

       These were one boolean. A Hermes that was installed but not running, and a Hermes that was
       running perfectly, produced the same answer — and the connector reported "a binary exists"
       as healthy, so it enrolled the first one and told its owner everything was fine. */
    @Test("every state is named truthfully, and only one of them may be connected")
    func everyState() {
        #expect(state("ready", running: true).isConnectable)
        #expect(state("ready", running: true).situation == "Hermes Agent is ready to connect")

        #expect(state("installed_not_running", running: false).isConnectable == false)
        #expect(state("installed_not_running").situation == "Hermes Agent is installed but not running")

        #expect(state("control_unavailable").isConnectable == false)
        #expect(state("control_unavailable").situation == "Hermes Agent was found but cannot be controlled")

        #expect(state("unsupported_version").isConnectable == false)
        #expect(state("unsupported_version").situation == "Hermes Agent is too old for this connector")

        #expect(state("not_installed", endpoint: nil).isConnectable == false)
        #expect(state("not_installed", endpoint: nil).situation == "Hermes Agent is not installed on this Mac")
    }

    /// A runtime that answers but cannot be identified could only ever create another duplicate.
    @Test("a ready runtime with no durable identity is still refused")
    func anonymousIsRefused() {
        var anonymous = state("ready", running: true)
        anonymous.externalRuntimeId = nil
        #expect(anonymous.isConnectable == false)
        anonymous = state("ready", running: true)
        anonymous.connectorInstallationId = nil
        #expect(anonymous.isConnectable == false)
    }



}

/**
 * Handing a room over from a browser to this Mac.
 *
 * Accepting an invitation left the person working in Safari, and the room was invisible in the app
 * afterwards. Membership belongs to the server, so the link needs to carry only which room — the
 * secret is spent by then, and the app confirms the membership by asking rather than believing.
 */
@Suite("The shared-room handoff link")
struct SharedRoomLinkTests {
    private let company = "01a05ac3-6c61-71bf-8f64-f15d073d67d9"
    private let room = "01a06014-fab4-7345-8bbf-d78da6b63475"

    @Test("carries the two ids and nothing else")
    func carriesIds() {
        let link = AppModel.sharedRoomLink("multiplayerai://room?company=\(company)&room=\(room)")
        #expect(link?.company == company)
        #expect(link?.room == room)
    }

    @Test("is recognised however the link is spelled")
    func spelling() {
        #expect(AppModel.sharedRoomLink("multiplayerai:///room?company=\(company)&room=\(room)") != nil)
    }

    /// A link that can name an arbitrary destination is a link that can send the app anywhere.
    @Test("refuses anything that is not a pair of ids")
    func refusesRubbish() {
        #expect(AppModel.sharedRoomLink("multiplayerai://room?company=../../etc&room=\(room)") == nil)
        #expect(AppModel.sharedRoomLink("multiplayerai://room?company=\(company)") == nil)
        #expect(AppModel.sharedRoomLink("multiplayerai://room") == nil)
        #expect(AppModel.sharedRoomLink("https://example.test/room?company=\(company)&room=\(room)") == nil)
    }

    /// The other two links on this scheme must keep working, and must not be mistaken for a room.
    @Test("is not confused with sign-in or runtime links")
    func notTheOthers() {
        #expect(AppModel.sharedRoomLink("multiplayerai://auth?token=mpsi_abc") == nil)
        #expect(AppModel.sharedRoomLink("multiplayerai://connect-runtime") == nil)
        #expect(AppModel.isConnectRuntime("multiplayerai://room?company=\(company)&room=\(room)") == false)
    }
}

/**
 * Finishing the job after a runtime is confirmed.
 *
 * Connecting used to stop at recording the principal. A connector binds to a *room*, so until one
 * was chosen no credential was minted and nothing started — the person was told their runtime had
 * been found and then watched it stay disconnected with nothing further offered. That is the whole
 * of "detects but does not connect".
 */
@Suite("Which room a newly connected runtime starts in")
struct RoomToAdoptTests {
    private let a = AgentRoom(id: "room-a", name: "A")
    private let b = AgentRoom(id: "room-b", name: "B")

    /// One room is not a choice, so it is taken and the connector can start.
    @Test("a single room is adopted without asking")
    func single() { #expect(AppModel.roomToAdopt(current: nil, agentRooms: [a]) == "room-a") }

    /// Several is a decision, and the existing room-binding notice is where it is made.
    @Test("several rooms are left to the person")
    func several() { #expect(AppModel.roomToAdopt(current: nil, agentRooms: [a, b]) == nil) }

    /// No room is a truthful state of its own, not a failure and not something to invent.
    @Test("no room adopts nothing")
    func none() { #expect(AppModel.roomToAdopt(current: nil, agentRooms: []) == nil) }

    /// A runtime that already works somewhere stays there rather than being moved by a reconnect.
    @Test("a room already bound is kept")
    func keepsCurrent() {
        #expect(AppModel.roomToAdopt(current: "room-b", agentRooms: [a, b]) == "room-b")
    }

    /// Unless it is no longer a room this agent works in, in which case it is not a valid binding.
    @Test("a room the agent no longer works in is not kept")
    func staleCurrent() {
        #expect(AppModel.roomToAdopt(current: "room-gone", agentRooms: [a]) == "room-a")
        #expect(AppModel.roomToAdopt(current: "room-gone", agentRooms: [a, b]) == nil)
    }
}

/**
 * The three things people mean by connected, which the product used to blur.
 *
 * "Hermes found" sat on screen while nothing was bound and no work could reach it. Software being
 * present on a disk says nothing about whether this workspace can put it to work.
 */
@Suite("Detected, ready, and connected are different")
struct RuntimeConnectionTests {
    private func runtime(_ readiness: String?) -> SidecarState.Runtime {
        .init(available: readiness != nil && readiness != "not_installed", name: "Hermes Agent",
              version: "0.20.5", path: nil, reason: nil, runtimeType: "hermes",
              externalRuntimeId: "id-1", connectorInstallationId: "install-1",
              endpoint: "cli:/usr/local/bin/hermes", healthEndpoint: nil, transport: "cli",
              probeStatus: readiness == "ready" ? "healthy" : "failed",
              readiness: readiness, serviceRunning: readiness == "ready")
    }

    @Test("a runtime that is merely present is never called connected")
    func presentIsNotConnected() {
        for readiness in ["installed_not_running", "control_unavailable", "unsupported_version"] {
            let state = RuntimeConnection.of(runtime: runtime(readiness), enrolled: false, health: .offline)
            #expect(state.isConnected == false)
            #expect(state.headline != "Connected to Multiplayer AI")
        }
    }

    @Test("ready is not connected either")
    func readyIsNotConnected() {
        let state = RuntimeConnection.of(runtime: runtime("ready"), enrolled: false, health: .offline)
        #expect(state == .ready)
        #expect(state.isConnected == false)
    }

    /// Connected is bound *and* live, and is never inferred from finding a process on this Mac.
    @Test("connected means bound to this workspace and working")
    func connected() {
        #expect(RuntimeConnection.of(runtime: runtime("ready"), enrolled: true, health: .connected) == .connected)
        // Enrolled but not live is not connected, however healthy the local runtime looks.
        #expect(RuntimeConnection.of(runtime: runtime("ready"), enrolled: true, health: .offline) == .ready)
    }

    @Test("nothing installed says so")
    func absent() {
        #expect(RuntimeConnection.of(runtime: runtime("not_installed"), enrolled: false, health: .offline) == .absent)
        #expect(RuntimeConnection.of(runtime: runtime(nil), enrolled: false, health: .offline) == .absent)
    }
}

/**
 * Not reopening a room that has been deleted.
 *
 * The app returns to wherever it was last, which is right until that room is deleted — and then it
 * reopens a room that is gone, and the deletion looks as though it did not take.
 */
@Suite("Whether the room this Mac would reopen still exists")
struct LastRoomTests {
    private let company = "company-1"
    private func room(_ id: String) -> WorkspaceRoom {
        .init(roomId: id, name: "R", projectId: "p", projectName: "P")
    }

    @Test("a room that is still there is kept")
    func kept() {
        #expect(AppModel.lastRoomStillExists(path: "/rooms/company-1/room-a",
                                             companyId: company, rooms: [room("room-a")]))
    }

    @Test("a room that has been deleted is not")
    func deleted() {
        #expect(AppModel.lastRoomStillExists(path: "/rooms/company-1/room-a",
                                             companyId: company, rooms: [room("room-b")]) == false)
        #expect(AppModel.lastRoomStillExists(path: "/rooms/company-1/room-a",
                                             companyId: company, rooms: []) == false)
    }

    /* A shared room lives in somebody else's workspace, and this workspace's room list says
       nothing about whether it still exists. Judging it here would throw away a perfectly good
       room every time the app looked at the wrong company. */
    @Test("a room in another workspace is not judged by this one")
    func otherWorkspace() {
        #expect(AppModel.lastRoomStillExists(path: "/rooms/company-2/room-a",
                                             companyId: company, rooms: []))
    }

    @Test("nothing recorded is nothing to invalidate")
    func nothing() {
        #expect(AppModel.lastRoomStillExists(path: nil, companyId: company, rooms: []))
        #expect(AppModel.lastRoomStillExists(path: "/home", companyId: company, rooms: []))
    }
}

/// Diagnostics is what anybody is asked for first when something is wrong, so it needs a way in
/// from the product rather than only from knowing where to look inside the Mac app.
@Suite("The diagnostics link")
struct DiagnosticsLinkTests {
    @Test("is recognised however it is spelled")
    func recognised() {
        #expect(AppModel.isDiagnostics("multiplayerai://diagnostics"))
        #expect(AppModel.isDiagnostics("multiplayerai:///diagnostics"))
    }

    @Test("is not confused with the other links on this scheme")
    func notTheOthers() {
        #expect(AppModel.isDiagnostics("multiplayerai://connect-runtime") == false)
        #expect(AppModel.isDiagnostics("multiplayerai://auth?token=mpsi_abc") == false)
        #expect(AppModel.isDiagnostics("https://example.test/diagnostics") == false)
        #expect(AppModel.isConnectRuntime("multiplayerai://diagnostics") == false)
        #expect(AppModel.sharedRoomLink("multiplayerai://diagnostics") == nil)
    }
}
}
