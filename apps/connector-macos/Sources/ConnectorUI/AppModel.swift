import Foundation
import Observation
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

    /// Something the person has to read, from whichever screen produced it. One at a time: a
    /// second problem while the first is unread means the first is stale.
    public var problem: WorkspaceError?
    public var busy = false
    /// The address someone was sent a sign-in link at, so the account screen can say so.
    public var awaitingLinkFor: String?

    public var workspaceAddress: String { progress.workspaceAddress ?? AppModel.defaultAddress }

    /// Where the app points when nobody has told it otherwise. Read from the bundle so a build
    /// can be pointed at a workspace without anyone being asked to type an address.
    nonisolated public static var defaultAddress: String {
        if let configured = Bundle.main.object(forInfoDictionaryKey: "MPAIWorkspaceURL") as? String,
           !configured.isEmpty { return configured }
        return "http://127.0.0.1:4100"
    }

    public init(store: ProgressStore = DefaultsProgressStore(), connector: ConnectorModel? = nil) {
        let loaded = store.load()
        self.store = store
        self.progress = loaded
        self.connector = connector ?? ConnectorModel(autostart: false)
        self.client = WorkspaceClient(base: URL(string: loaded.workspaceAddress ?? AppModel.defaultAddress)
                                      ?? URL(string: AppModel.defaultAddress)!)
        // A Mac that has been set up wants its background half running before anything is drawn;
        // one that has not is started by the setup screen, where a failure can be reported.
        if loaded.setupComplete, !(connector ?? self.connector).sidecar.isPreview { self.connector.begin() }
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

        guard progress.setupComplete else { step = Onboarding.step(for: situation); return }

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
        if step == .account { await readDeliveryMode() }
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
            let joined = (mine["rooms"] as? [[String: Any]] ?? []).compactMap { $0["room_id"] as? String }
            if let room = progress.roomId, !joined.contains(room) {
                write { $0.roomId = joined.first }
            } else if progress.roomId == nil, let first = joined.first {
                write { $0.roomId = first }
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
