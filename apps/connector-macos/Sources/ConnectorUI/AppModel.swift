import Foundation
import Observation
import os
#if canImport(AppKit)
import AppKit
#endif

/// The whole application, and the one place that knows what it is doing.
///
/// Multiplayer AI is one app: the window a person works in and the background half that keeps
/// their agent connected are the same process, the same credential, and the same idea of what
/// is true. This owns the first-run journey and the workspace address; the Connector model it
/// holds keeps doing exactly what it already did, unchanged.
@Observable
@MainActor
public final class AppModel {
    public let connector: ConnectorModel
    public private(set) var client: WorkspaceClient
    private let store: ProgressStore

    public private(set) var progress: Progress
    public private(set) var step: Step = .welcome
    public private(set) var setup = SetupProgress()

    public private(set) var identity: Identity?
    public private(set) var company: Identity.Company?
    public private(set) var rooms: [WorkspaceRoom] = []
    /// The rooms this Mac's agent is actually a worker in, as the workspace reports them.
    public private(set) var agentRooms: [AgentRoom] = []

    /// Something the person has to read, from whichever screen produced it. One at a time: a
    /// second problem while the first is unread means the first is stale.
    public var problem: WorkspaceError?
    public var busy = false
    /// The address someone was sent a sign-in link at, so the account screen can say so.
    public var awaitingLinkFor: String?

    /// The standalone Connector, if it is still installed. Offered for removal, never removed.
    public private(set) var legacyApp: URL?
    /// Whether sign-in links will actually reach this build.
    public private(set) var handlesSignInLinks = true

    public func removeLegacyApp() async {
        guard let legacyApp else { return }
        if await LegacyApp.moveToTrash(legacyApp) {
            self.legacyApp = nil
            // It shared this app's identifier, so the claim is worth re-asserting once it is gone.
            URLScheme.claim()
            handlesSignInLinks = URLScheme.claimedByThisApp()
        }
    }

    public func dismissLegacyApp() { legacyApp = nil }

    /// Where this Mac is working, against where it is meant to be.
    ///
    /// A binding is a durable fact about this machine, and nothing may change it quietly. The
    /// room it holds came from the code it was connected with; if that is not the room the person
    /// is working in, the honest thing is to say so and offer to move — not to reassign the
    /// binding behind their back, and certainly not to report success in a room the agent has
    /// never appeared in.
    public enum RoomBinding: Equatable, Sendable {
        case notBound
        case correct(String)                       // room id
        case elsewhere(bound: String, expected: String)
    }

    nonisolated public static func binding(bound: String?, expected: String?) -> RoomBinding {
        guard let bound else { return .notBound }
        guard let expected, expected != bound else { return .correct(bound) }
        return .elsewhere(bound: bound, expected: expected)
    }

    public var roomBinding: RoomBinding {
        AppModel.binding(bound: connector.enrolment?.roomId, expected: progress.roomId)
    }

    public func nameOfRoom(_ id: String) -> String? {
        agentRooms.first { $0.id == id }?.name ?? rooms.first { $0.roomId == id }?.name
    }

    /// Move this Mac to a room, deliberately. Signing out first is what makes it a move rather
    /// than a second binding: the old credential goes, and a new one is minted for the new room.
    public func move(to roomId: String) async {
        guard roomId != connector.enrolment?.roomId || connector.enrolment == nil else { return }
        write { $0.roomId = roomId }
        await connector.signOut()
        await bind()
    }

    public var workspaceAddress: String { progress.workspaceAddress ?? AppModel.defaultAddress }

    /// Where the app points when nobody has told it otherwise. Read from the bundle so a build
    /// can be pointed at a workspace without anyone being asked to type an address.
    nonisolated public static var defaultAddress: String {
        if let configured = Bundle.main.object(forInfoDictionaryKey: "MPAIWorkspaceURL") as? String,
           !configured.isEmpty { return configured }
        return "http://127.0.0.1:4100"
    }

    /// What a Mac set up by the previous version already knows about itself.
    ///
    /// The Connector recorded which agent this machine is and which room it works in; the unified
    /// app keeps the same facts under a name of its own. Without carrying them across, upgrading
    /// would present a Mac that has been working for weeks as a blank one — and the next thing it
    /// would ask for is a name for an agent that already exists, quietly creating a second
    /// identity beside the real one.
    ///
    /// Pure, so the upgrade can be reasoned about without a Keychain or an installed app.
    nonisolated public static func adopting(_ progress: Progress, from enrolment: Keychain.Enrolment?) -> Progress {
        guard let enrolment, progress.agentPrincipalId == nil else { return progress }
        var adopted = progress
        // It plainly was set up: it has an enrolment, and the helper it used ships in this app.
        adopted.setupComplete = true
        adopted.agentPrincipalId = enrolment.agentPrincipalId
        adopted.agentDisplayName = enrolment.agentDisplayName
        adopted.roomId = enrolment.roomId
        // Where it was already pointing wins over where this build defaults to.
        if adopted.workspaceAddress == nil { adopted.workspaceAddress = enrolment.baseURL }
        return adopted
    }

    public init(store: ProgressStore = DefaultsProgressStore(), connector: ConnectorModel? = nil) {
        var loaded = store.load()
        // Only a live model reads the Keychain; a drawing of one touches nothing.
        if connector == nil {
            let adopted = AppModel.adopting(loaded, from: Keychain.enrolment())
            if adopted != loaded { store.save(adopted); loaded = adopted }
        }
        self.store = store
        self.progress = loaded
        self.connector = connector ?? ConnectorModel(autostart: false)
        self.client = WorkspaceClient(base: URL(string: loaded.workspaceAddress ?? AppModel.defaultAddress)
                                      ?? URL(string: AppModel.defaultAddress)!)
        // A Mac that has been set up wants its background half running before anything is drawn;
        // one that has not is started by the setup screen, where a failure can be reported.
        if loaded.setupComplete, !(connector ?? self.connector).sidecar.isPreview { self.connector.begin() }

        /* Look at the world without waiting to be asked.
           A sign-in link can arrive before any window exists — on a cold launch it always does —
           and a model that only finds out where it is when a view appears would hold that link
           forever. Initialization is this object's own business. */
        if connector == nil { Task { await self.refresh() } }
    }

    private func write(_ change: (inout Progress) -> Void) {
        change(&progress)
        store.save(progress)
    }

    /// Point the app at a different workspace. Everything bound to the old one is local to this
    /// Mac and would be meaningless against another, so it is cleared rather than carried over.
    public func useWorkspace(address: String) async {
        let trimmed = address.trimmingCharacters(in: .whitespaces)
        guard ConnectorModel.usableAddress(trimmed), let url = URL(string: trimmed) else { return }
        await connector.signOut()
        write {
            $0.workspaceAddress = trimmed
            $0.companyId = nil; $0.agentPrincipalId = nil; $0.agentDisplayName = nil
            $0.roomId = nil; $0.lastRoomPath = nil
        }
        client = WorkspaceClient(base: url)
        identity = nil; company = nil; rooms = []
        await refresh()
    }

    // ------------------------------------------------------------------ state

    /// What is true right now, asked of the things that actually know.
    ///
    /// Nothing here is remembered from a previous answer. An agent deleted from the workspace by
    /// somebody else, a session that expired overnight, a credential macOS will no longer hand
    /// over — each shows up as the situation changing, and the person is moved to the one step
    /// that addresses it rather than back to the beginning.
    public func refresh() async {
        progress = store.load()
        var situation = Situation(setupComplete: progress.setupComplete)

        guard progress.setupComplete else {
            step = Onboarding.step(for: situation)
            initialized = true
            await spendQueuedAuthURL()
            return
        }

        let found = try? await client.currentIdentity()
        identity = found
        situation.signedIn = found != nil

        if let found {
            // Multi-workspace is not a thing the product offers yet; the first is the one.
            let chosen = found.companies.first { $0.companyId == progress.companyId } ?? found.companies.first
            company = chosen
            situation.hasWorkspace = chosen != nil
            if let chosen {
                if progress.companyId != chosen.companyId { write { $0.companyId = chosen.companyId } }
                await readWorkspace(chosen.companyId)
                situation.hasAgentIdentity = progress.agentPrincipalId != nil
                situation.hasRoom = progress.roomId != nil
            }
        } else {
            company = nil; rooms = []
        }

        situation.bound = connector.enrolment != nil
        situation.credentialProblem = connector.sidecar.credentialProblem
        step = Onboarding.step(for: situation)
        legacyApp = LegacyApp.found()
        handlesSignInLinks = URLScheme.claimedByThisApp()
        if step == .account { await readDeliveryMode() }
        initialized = true
        await spendQueuedAuthURL()
    }

    /// Confirm against the workspace that the agent and room this Mac remembers still exist.
    /// An id we kept is a claim, not a fact; if the workspace disagrees the claim is dropped so
    /// the person is asked for the one thing that is genuinely missing.
    private func readWorkspace(_ companyId: String) async {
        rooms = (try? await client.rooms(companyId: companyId)) ?? []
        guard let agents = try? await client.agents(companyId: companyId) else { return }

        if let remembered = progress.agentPrincipalId {
            let mine = agents.first { $0["principal_id"] as? String == remembered }
            guard let mine else {
                // Removed from the workspace by somebody. Nothing local can fix that, and the
                // credential now names an identity that no longer exists.
                write { $0.agentPrincipalId = nil; $0.agentDisplayName = nil; $0.roomId = nil }
                await connector.signOut()
                return
            }
            if let name = mine["display_name"] as? String, name != progress.agentDisplayName {
                write { $0.agentDisplayName = name }
            }
            let joined = (mine["rooms"] as? [[String: Any]] ?? []).compactMap { entry -> AgentRoom? in
                guard let id = entry["room_id"] as? String else { return nil }
                return AgentRoom(id: id, name: entry["name"] as? String ?? "")
            }
            agentRooms = joined
            /* Choosing for somebody is only honest when there is nothing to choose. One room is
               not a decision; more than one is, and quietly picking the oldest is exactly how a
               Mac ended up working in a room nobody had asked for. */
            if progress.roomId == nil, joined.count == 1 {
                write { $0.roomId = joined[0].id }
            } else if let room = progress.roomId, !joined.contains(where: { $0.id == room }) {
                write { $0.roomId = joined.count == 1 ? joined[0].id : nil }
            }
        }
    }

    // ------------------------------------------------------------------ setup

    /// Run the steps, in order, stopping at the first one that genuinely failed.
    public func runSetup() async {
        setup = SetupProgress()
        problem = nil
        while let task = setup.next {
            setup.set(task, .running)
            // Long enough to be read, short enough not to be a wait. Setup is mostly instant,
            // and a list that flashes past tells nobody anything.
            try? await Task.sleep(for: .milliseconds(260))
            let outcome = await perform(task)
            setup.set(task, outcome)
            if outcome.isFailure { return }
        }
        if setup.succeeded {
            write { $0.setupComplete = true }
            await refresh()
        }
    }

    private func perform(_ task: SetupTask) async -> TaskOutcome {
        switch task {
        case .system:
            return SetupJudgement.system(osVersion: ProcessInfo.processInfo.operatingSystemVersion)

        case .helper:
            let path = connector.sidecar.executablePath
            return SetupJudgement.helper(found: path != nil,
                                         executable: path.map { FileManager.default.isExecutableFile(atPath: $0.path) } ?? false)

        case .service:
            connector.begin()
            // Ask it to answer for itself rather than trusting that spawning it worked.
            let alive = (try? await connector.sidecar.send("ping")) != nil
            return SetupJudgement.service(started: alive, failure: connector.sidecar.lastLaunchFailure)

        case .agents:
            _ = try? await connector.sidecar.send("detect")
            await connector.sidecar.refresh()
            return SetupJudgement.agents(runtime: connector.sidecar.state.runtime)

        case .storage:
            // A real round trip, not a read: nothing is stored yet on a Mac being set up, so a
            // read would succeed at finding nothing and prove nothing.
            return SetupJudgement.storage(probe: Keychain.probe())

        case .login:
            LoginItem.enable()
            return SetupJudgement.login(registered: LoginItem.enabled)
        }
    }

    public func retrySetup() async { await runSetup() }

    /// Leaving the welcome screen. The only thing this decides is that setup should begin;
    /// whether it succeeds is setup's business.
    public func beginSetup() async {
        step = .setup
        await runSetup()
    }

    // ---------------------------------------------------------------- account

    private func attempt(_ work: () async throws -> Void) async {
        guard !busy else { return }
        busy = true; problem = nil
        do { try await work() }
        catch let error as WorkspaceError { problem = error }
        catch { problem = .malformed() }
        busy = false
    }

    public func createAccount(name: String, email: String) async {
        await attempt {
            try await client.signUp(name: name, email: email)
            awaitingLinkFor = email
        }
    }

    public func requestSignInLink(email: String) async {
        await attempt {
            try await client.requestSignInLink(email: email)
            awaitingLinkFor = email
        }
    }

    /* An auth link can arrive before the app knows anything about itself — being opened *by* a
       link is the ordinary way in, and macOS delivers it as the first scene appears. Redeeming
       against a half-built model raced the first refresh and could be answered by whichever
       finished last. The link waits instead, and is spent the moment the app is ready. */
    public private(set) var initialized = false
    public private(set) var queuedAuthURL: String?

    /// A link the app was opened by. Held if the app is still working out where it is.
    ///
    /// Whether it is held is the model's own business, decided by whether the model has finished
    /// its first look at the world. It deliberately does not depend on a view having run: the
    /// first version of this waited for `RootView`'s task to call back, and a link that arrived
    /// on a cold launch was queued and then never spent, because that call never came.
    public func receive(authURL raw: String) async {
        /* Recorded because the alternative is guessing. When a sign-in link does not work, the
           first question is whether the app was ever handed it, and that is otherwise invisible
           from outside. The token is never written — only that something arrived. */
        AppModel.log.info("sign-in link received (\(self.initialized ? "handling now" : "queued", privacy: .public))")
        guard initialized else { queuedAuthURL = raw; return }
        await redeem(raw)
    }

    static let log = Logger(subsystem: "com.multiplayerai.connector", category: "auth")


    /// Spend anything that arrived before the app knew where it was. Called at the end of every
    /// refresh, so a queued link is taken up the moment there is somewhere to take it.
    private func spendQueuedAuthURL() async {
        guard let waiting = queuedAuthURL else { return }
        queuedAuthURL = nil
        await redeem(waiting)
    }

    /// Redeem whatever the person arrived with — a link the app was opened by, or a token they
    /// pasted. Both are the same single-use secret, so both are accepted the same way.
    public func redeem(_ raw: String) async {
        let token = AppModel.token(from: raw)
        guard !token.isEmpty else { return }
        await attempt {
            let signedIn = try await client.redeem(token: token)
            // Accepting the link is not the same as holding a session. If nothing was kept, say
            // so here rather than bouncing the person back to a screen that looks untouched.
            guard let base = URL(string: workspaceAddress),
                  WebSession.hasSession(for: base, from: HTTPCookieStorage.shared.cookies ?? []) else {
                throw WorkspaceError.sessionNotKept()
            }
            identity = signedIn
            awaitingLinkFor = nil
            await refresh()
        }
    }

    /// The token out of whatever was handed over: a `multiplayerai://` link the app was opened
    /// by, an https link out of an email, or the bare token pasted on its own.
    ///
    /// The fragment is checked as well as the query, because that is where an emailed link keeps
    /// it. A token in a query string is read by the web host that serves the page and by every
    /// link scanner that fetches the URL ahead of its owner — and a scanner that follows one
    /// spends it. In the fragment there is nothing for either to see, which means the link a
    /// person pastes here looks different from the one the app is opened by, and both have to work.
    nonisolated public static func token(from raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.contains("://") || trimmed.contains("?") || trimmed.contains("#") else { return trimmed }
        guard let components = URLComponents(string: trimmed) else { return trimmed }
        if let queried = components.queryItems?.first(where: { $0.name == "token" })?.value, !queried.isEmpty {
            return queried
        }
        if let fragment = components.fragment,
           let fromFragment = URLComponents(string: "?\(fragment)")?
               .queryItems?.first(where: { $0.name == "token" })?.value,
           !fromFragment.isEmpty {
            return fromFragment
        }
        return trimmed
    }

    /// How this workspace delivers sign-in links, so the app only says "check your email" when an
    /// email is genuinely sent. Unknown means assume it is: promising an email that never arrives
    /// is worse than omitting a developer note.
    public private(set) var delivery: String = "resend"

    private func readDeliveryMode() async {
        guard let request = try? WorkspaceEndpoint.request(base: client.base, method: "GET", path: "/v1/app-config"),
              let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let mode = payload["sign_in_delivery"] as? String else { return }
        delivery = mode
    }

    public func signOutOfAccount() async {
        await client.signOut()
        identity = nil; company = nil; rooms = []
        await refresh()
    }

    // -------------------------------------------------------------- workspace

    public func createWorkspace(name: String) async {
        await attempt {
            let created = try await client.createWorkspace(name: name)
            company = created
            write { $0.companyId = created.companyId }
            await refresh()
        }
    }

    /// Register the agent this Mac already runs. Multiplayer AI does not create it — this gives
    /// the agent an identity in the workspace and remembers that the identity belongs here.
    public func registerAgent(name: String) async {
        guard let company else { return }
        await attempt {
            let principalId = try await client.addAgent(companyId: company.companyId, name: name)
            write { $0.agentPrincipalId = principalId; $0.agentDisplayName = name }
            await refresh()
        }
    }

    /// Create the room and put the agent in it. One objective, one room, one member — Join is
    /// deliberately absent until a person can actually be invited into somebody else's
    /// workspace, and this does not pretend otherwise.
    public func createRoom(name: String, objective: String) async {
        guard let company, let agentPrincipalId = progress.agentPrincipalId else { return }
        await attempt {
            let projectId = try await client.createProject(companyId: company.companyId, name: name, objective: objective)
            let roomId = try await client.createRoom(companyId: company.companyId, projectId: projectId, name: name)
            try await client.addRoomMember(companyId: company.companyId, roomId: roomId, principalId: agentPrincipalId)
            write { $0.roomId = roomId }
            await refresh()
            await bind()
        }
    }

    // ---------------------------------------------------------------- binding

    /// Give this Mac its identity.
    ///
    /// Nobody is asked for anything here. The person is already signed in *in this app*, on the
    /// machine the agent runs on, so the app asks the workspace for this agent's credential
    /// directly and puts it in the Keychain. An enrollment code exists for the case this is not
    /// — a Mac nobody is signed in on — and stays available for exactly that.
    public func bind() async {
        guard let company,
              let agentPrincipalId = progress.agentPrincipalId,
              let roomId = progress.roomId else { return }
        let room = rooms.first { $0.roomId == roomId }
        let label = "\(progress.agentDisplayName ?? "Agent") on \(Host.current().localizedName ?? "this Mac")"
        do {
            let credential = try await client.mintCredential(companyId: company.companyId,
                                                             agentPrincipalId: agentPrincipalId,
                                                             label: label)
            try Keychain.saveCredential(credential)
            let enrolment = Keychain.Enrolment(
                baseURL: workspaceAddress, roomId: roomId,
                roomName: room?.name, projectName: room?.projectName,
                agentPrincipalId: agentPrincipalId, agentDisplayName: progress.agentDisplayName)
            Keychain.saveEnrolment(enrolment)
            connector.enrolment = enrolment
            connector.sidecar.credentialProblem = nil
            connector.begin()
            await connector.sidecar.resumeSession()
            LoginItem.enable()
            await refresh()
        } catch let error as WorkspaceError {
            problem = error
        } catch {
            problem = .init(code: "keychain", message: "This Mac would not store its sign-in.",
                            status: 0, recovery: "Open Keychain Access, unlock your login keychain, then try again.")
        }
    }

    /// Undo this Mac's binding without touching the account or the workspace. The remedy for a
    /// credential macOS will not release, and the only one that works.
    public func rebind() async {
        await connector.signOut()
        await bind()
    }

    // -------------------------------------------------------------- workspace UI

    public var entryURL: URL {
        let base = URL(string: workspaceAddress) ?? URL(string: AppModel.defaultAddress)!
        return WebSession.entryURL(base: base, lastPath: progress.lastRoomPath)
    }

    public func remember(path: String?) {
        guard let path, path != progress.lastRoomPath else { return }
        write { $0.lastRoomPath = path }
    }

    /// Start again from the front door. Everything this Mac holds goes; the account does not.
    public func resetThisMac() async {
        await connector.signOut()
        write {
            $0.agentPrincipalId = nil; $0.agentDisplayName = nil
            $0.roomId = nil; $0.lastRoomPath = nil
        }
        await refresh()
    }

    // ----------------------------------------------------------------- drawing

    /// A model that touches nothing — no helper, no Keychain, no network — held at one step.
    ///
    /// The screens are rendered from this rather than from imitations of them, so what gets
    /// looked at is what ships, including states nobody can produce on demand: a setup that
    /// failed, a Mac with no agent runtime on it, a credential macOS will not release.
    public static func preview(step: Step,
                               progress: Progress = Progress(),
                               setup: SetupProgress = SetupProgress(),
                               connector: ConnectorModel,
                               problem: WorkspaceError? = nil,
                               awaitingLinkFor: String? = nil) -> AppModel {
        let model = AppModel(store: MemoryProgressStore(progress), connector: connector)
        model.step = step
        model.setup = setup
        model.problem = problem
        model.awaitingLinkFor = awaitingLinkFor
        return model
    }
}

/// A store that keeps what it is given and nothing else. For rendering, and for reasoning about
/// the first-run journey without a Mac's own settings taking part.
public final class MemoryProgressStore: ProgressStore, @unchecked Sendable {
    private let lock = NSLock()
    private var progress: Progress
    public init(_ progress: Progress = Progress()) { self.progress = progress }
    public func load() -> Progress { lock.lock(); defer { lock.unlock() }; return progress }
    public func save(_ progress: Progress) { lock.lock(); self.progress = progress; lock.unlock() }
}
