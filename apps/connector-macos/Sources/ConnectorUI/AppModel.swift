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

    /// Rooms this Mac could move to: ones its agent works in, other than where it is bound.
    ///
    /// The mismatch that matters is not between the app's two records — those agree on a Mac that
    /// was set up here, which is why comparing them surfaced nothing for an agent bound to the
    /// wrong room. It is between where this Mac is working and the other rooms its agent belongs
    /// to. Those are the moves that exist, so those are what is offered.
    nonisolated public static func moveTargets(bound: String?, agentRooms: [AgentRoom]) -> [AgentRoom] {
        guard let bound else { return [] }
        return agentRooms.filter { $0.id != bound }
    }

    public var moveTargets: [AgentRoom] {
        AppModel.moveTargets(bound: connector.enrolment?.roomId, agentRooms: agentRooms)
    }

    /// Set aside for this run once somebody has said they do not want to move.
    public var movePromptDismissed = false

    public func nameOfRoom(_ id: String) -> String? {
        agentRooms.first { $0.id == id }?.name ?? rooms.first { $0.roomId == id }?.name
    }

    /// Move this Mac deliberately using its existing credential. The helper stops the old
    /// runtime before reconfiguration; the gateway fences its old room session atomically.
    public func move(to roomId: String) async {
        guard roomId != connector.enrolment?.roomId || connector.enrolment == nil else { return }
        // A room the agent does not work in would be refused by the workspace after this Mac had
        // already given up the binding it had. Refusing here costs nothing and loses nothing.
        guard agentRooms.isEmpty || agentRooms.contains(where: { $0.id == roomId }) else { return }
        write { $0.roomId = roomId }
        await bind()
    }

    /// Which source this build came from, stamped in at build time. A `+local` suffix means it
    /// was built with uncommitted changes and matches no commit anybody else can check out.
    nonisolated public static var buildCommit: String {
        (Bundle.main.object(forInfoDictionaryKey: "MPAIBuildCommit") as? String) ?? "unknown"
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

    /**
     * What a launch starts from.
     *
     * Quitting and reopening is a fresh start: Home, not whichever room or step was last open.
     * Returning to the last room meant a room somebody had finished with — or a move or a modal
     * they had abandoned — came back as though it were still in progress. Everything that matters
     * survives: sign-in, workspace, agents, rooms and credentials; only the place is forgotten.
     */
    nonisolated public static func launching(_ progress: Progress) -> Progress {
        var fresh = progress
        fresh.lastRoomPath = nil
        return fresh
    }

    public init(store: ProgressStore = DefaultsProgressStore(), connector: ConnectorModel? = nil) {
        var loaded = store.load()
        let launched = AppModel.launching(loaded)
        if launched != loaded { store.save(launched); loaded = launched }
        // Only a live model reads the Keychain; a drawing of one touches nothing.
        if connector == nil {
            let adopted = AppModel.adopting(loaded, from: Keychain.enrolment())
            if adopted != loaded { store.save(adopted); loaded = adopted }
        }
        self.store = store
        self.progress = loaded
        self.connector = connector ?? ConnectorModel(autostart: false)
        self.connector.primaryPrincipalId = loaded.agentPrincipalId
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
        connector.primaryPrincipalId = progress.agentPrincipalId
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
        connector.primaryPrincipalId = progress.agentPrincipalId
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
        /* Finish a move that was interrupted.

           A move writes the target room down, gives up the old binding, and mints a new one. The
           binding step used to be what drove that last part, so removing the forced setup corridor
           left a Mac that was quit mid-move with a room recorded, no binding, and nothing anywhere
           that would ever complete it. Resuming belongs to the model, not to whichever screen
           happened to be on display — `bind` mints nothing when there is already a binding to keep,
           so this is a no-op on every ordinary launch. */
        if AppModel.shouldResumeBinding(roomId: progress.roomId,
                                        agentPrincipalId: progress.agentPrincipalId,
                                        hasCompany: company != nil,
                                        hasEnrolment: connector.enrolment != nil,
                                        hasProblem: problem != nil) {
            await bind()
        }
        initialized = true
        updateNotifications()
        await spendQueuedAuthURL()
    }

    /// Confirm against the workspace that the agent and room this Mac remembers still exist.
    /// An id we kept is a claim, not a fact; if the workspace disagrees the claim is dropped so
    /// the person is asked for the one thing that is genuinely missing.
    private func readWorkspace(_ companyId: String) async {
        rooms = (try? await client.rooms(companyId: companyId)) ?? []
        // A room that has been deleted must not be reopened on the next launch.
        if !AppModel.lastRoomStillExists(path: progress.lastRoomPath, companyId: companyId, rooms: rooms) {
            write { $0.lastRoomPath = nil }
        }
        guard let agents = try? await client.agents(companyId: companyId) else { return }
        let known = Set(agents.compactMap { $0["principal_id"] as? String })
        /* An agent removed from the workspace by somebody is forgotten on this Mac — that agent, and
           only that one. Signing the whole Mac out for it stopped every other agent here too. */
        for saved in connector.enrolments where saved.baseURL == workspaceAddress
            && saved.agentPrincipalId != progress.agentPrincipalId && !known.contains(saved.agentPrincipalId) {
            await connector.signOut(principalId: saved.agentPrincipalId)
        }

        if let remembered = progress.agentPrincipalId {
            let mine = agents.first { $0["principal_id"] as? String == remembered }
            guard let mine else {
                // Removed from the workspace by somebody. Nothing local can fix that, and the
                // credential now names an identity that no longer exists.
                write { $0.agentPrincipalId = nil; $0.agentDisplayName = nil; $0.roomId = nil }
                await connector.signOut(principalId: remembered)
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
    /**
     * A room somebody has just been let into, handed over from the browser.
     *
     * Only the two ids travel. The invite secret is spent by the time this link is built — the
     * membership already exists on the server — so there is nothing here worth intercepting, and
     * nothing this Mac has to be told that it cannot ask the workspace for itself.
     *
     * Both are checked for shape before they are put in a URL. A link that can name an arbitrary
     * path is a link that can send the app somewhere it was never meant to go.
     */
    nonisolated public static func sharedRoomLink(_ raw: String) -> (company: String, room: String)? {
        guard let url = URLComponents(string: raw), url.scheme == "multiplayerai" else { return nil }
        // Three slashes give an empty host rather than none, so both halves are checked.
        let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard url.host == "room" || path == "room" else { return nil }
        let items = url.queryItems ?? []
        guard let company = items.first(where: { $0.name == "company" })?.value,
              let room = items.first(where: { $0.name == "room" })?.value,
              AppModel.looksLikeId(company), AppModel.looksLikeId(room) else { return nil }
        return (company, room)
    }

    /// Where in the room a link points — a message or a decision — as a fragment the room can scroll
    /// to. Only these two shapes with a real id; anything else just opens the room.
    nonisolated public static func roomLinkFragment(_ raw: String) -> String? {
        guard let focus = URLComponents(string: raw)?.queryItems?.first(where: { $0.name == "focus" })?.value else { return nil }
        let parts = focus.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2, ["message", "decision"].contains(parts[0]), AppModel.looksLikeId(parts[1]) else { return nil }
        return "#\(parts[0])-\(parts[1])"
    }

    /// The room on screen: the app is frontmost and the workspace is showing it.
    nonisolated public static func visibleRoom(path: String?, appActive: Bool) -> (company: String, room: String)? {
        guard appActive, let path else { return nil }
        let parts = (path.split(separator: "#").first.map(String.init) ?? "").split(separator: "/").map(String.init)
        guard parts.count >= 3, parts[0] == "rooms" else { return nil }
        return (parts[1], parts[2])
    }

    // -------------------------------------------------------------- notifications

    public private(set) var notifier: RoomNotifier?
    private var notificationPoster: NotificationPosting?

    /// Turn on native notifications, with whatever posts them. The app passes the system's; nothing
    /// is asked of macOS until there is something to show.
    public func enableNotifications(poster: NotificationPosting) {
        notificationPoster = poster
        updateNotifications()
    }

    /// Notifications run only while somebody is signed in, scoped to the workspace they are in.
    private func updateNotifications() {
        guard let poster = notificationPoster else { return }
        guard identity != nil else { notifier?.stop(); notifier = nil; return }
        guard notifier == nil else { return }
        let client = self.client
        let next = RoomNotifier(
            fetch: { after in try await client.notifications(after: after) },
            poster: poster, memory: DefaultsNotifierMemory(scope: workspaceAddress),
            visibleRoom: { [weak self] in
                #if canImport(AppKit)
                let active = NSApp?.isActive ?? false
                #else
                let active = false
                #endif
                return AppModel.visibleRoom(path: self?.progress.lastRoomPath, appActive: active)
            })
        notifier = next
        next.start()
    }

    nonisolated static func looksLikeId(_ value: String) -> Bool {
        value.count == 36 && value.allSatisfy { $0.isHexDigit || $0 == "-" }
    }

    /**
     * Open a room this Mac has just been invited into.
     *
     * Membership is the server's to know, so this asks it rather than believing the link: the
     * refresh reloads the identity, and with it every workspace this person belongs to. A person
     * who is not signed in on this Mac lands on sign-in and arrives at the room afterwards,
     * because the destination is written down before anything else happens.
     */
    public func openSharedRoom(company: String, room: String, fragment: String? = nil) async {
        // Navigation only: the workspace decides whether this person may see the room at all.
        remember(path: "/rooms/\(company)/\(room)" + (fragment ?? ""))
        await refresh()
        // Tell the web view to go there; it was loaded before any of this was known.
        entryReloads += 1
    }

    /// Bumped when the workspace view must return to `entryURL`. Watched by the web view.
    public var entryReloads = 0

    /// Whether an incoming link is asking to show Diagnostics — the first thing anybody is asked
    /// for when something is wrong, and previously reachable only by knowing where to look.
    nonisolated public static func isDiagnostics(_ raw: String) -> Bool {
        guard let url = URLComponents(string: raw), url.scheme == "multiplayerai" else { return false }
        let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return url.host == "diagnostics" || path == "diagnostics"
    }

    /// Whether an incoming link is the web asking this Mac to introduce its runtime, rather than a
    /// sign-in link. Pure, because URL shapes are exactly the thing that is wrong at 2am.
    nonisolated public static func isConnectRuntime(_ raw: String) -> Bool {
        guard let url = URLComponents(string: raw), url.scheme == "multiplayerai" else { return false }
        // multiplayerai://connect-runtime and multiplayerai:///connect-runtime both mean this.
        return url.host == "connect-runtime"
            || url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == "connect-runtime"
    }

    /// Links the room page may hand straight to this app. Moving an agent needs the credential in
    /// this Mac's Keychain, so the page can only ask. Sign-in is deliberately absent: a token
    /// redeemed because a page navigated somewhere is a session nobody chose to start.
    nonisolated public static func acceptsFromWorkspace(_ raw: String) -> Bool {
        isConnectRuntime(raw) || isDiagnostics(raw) || sharedRoomLink(raw) != nil
    }

    /**
     * Introduce the runtime on this Mac to the workspace, and bind to whatever agent it turns out
     * to be.
     *
     * Discovery happens here rather than in the browser because this is the machine that can
     * actually see Hermes: the web can only ask. Nothing is created until the runtime has been
     * found, identified, and answered a health check — an agent identity minted for a runtime that
     * turns out not to be running is exactly the junk this is meant to stop.
     */
    /// What detection found, held so a person can look at it before anything is created.
    // Legacy notice remains nil: discovery is presented as a sheet, before any IPC work.
    public var detectedRuntime: SidecarState.Runtime?
    public var showingAgentDiscovery = false
    public private(set) var discoveryPhase: AgentDiscoveryPhase = .idle
    public private(set) var discoveredAgents: [DiscoveredAgent] = []
    public var selectedDiscoveredAgentId: String?
    public var discoveryDisplayName = ""
    public var discoveryRoomId = ""
    public private(set) var discoveryCompanyId: String?
    private var discoveryAgents: [[String: Any]] = []
    private var knownDiscoveredIdentities: [String: KnownRuntimeIdentity] = [:]
    private var discoveryGeneration = UUID()
    private var requestedMovePrincipalId: String?
    public var selectedDiscoveredAgent: DiscoveredAgent? {
        discoveredAgents.first { $0.id == selectedDiscoveredAgentId }
    }
    public var selectedKnownIdentity: KnownRuntimeIdentity? {
        selectedDiscoveredAgent.flatMap { knownDiscoveredIdentities[$0.id] }
    }
    /// The profile whose runtime is being started right now, shown on its card as Starting agent….
    public private(set) var startingRuntimeId: String?
    /// Why a profile could not be started, in the runtime's own words, until it is retried.
    public private(set) var runtimeStartErrors: [String: String] = [:]

    /**
     * Start a discovered profile's runtime if it is stopped, and wait for it to be ready.
     *
     * A person should never be sent to a terminal to start an agent they have just asked to connect.
     * Only that one profile is started; a running one is left alone, and one that cannot be
     * controlled is not something starting can fix. Returns whether it is now connectable.
     */
    @discardableResult
    public func startDiscoveredRuntime(_ id: String) async -> Bool {
        guard let agent = discoveredAgents.first(where: { $0.id == id }) else { return false }
        guard AppModel.needsStart(agent.runtime) else { return agent.isConnectable }
        guard startingRuntimeId == nil else { return false }
        startingRuntimeId = id
        runtimeStartErrors[id] = nil
        defer { startingRuntimeId = nil }
        let generation = discoveryGeneration
        do {
            let reply = try await connector.sidecar.send("start-runtime", ["runtimeInstallationId": id])
            guard let raw = reply["runtime"] as? [String: Any], var updated = DiscoveredAgent.decode(raw) else {
                throw SidecarError.refused("The helper did not report the started agent. Check Diagnostics and Retry.")
            }
            guard generation == discoveryGeneration else { return false }
            if updated.displayName == nil { updated.displayName = agent.displayName }
            discoveredAgents = discoveredAgents.map { $0.id == id ? updated : $0 }
            if !updated.isConnectable {
                runtimeStartErrors[id] = updated.runtime.reason ?? updated.runtime.situation
            }
            return updated.isConnectable
        } catch {
            guard generation == discoveryGeneration else { return false }
            runtimeStartErrors[id] = error.localizedDescription
            return false
        }
    }

    /// Stopped, and the kind of stopped that starting fixes.
    nonisolated public static func needsStart(_ runtime: SidecarState.Runtime) -> Bool {
        runtime.readiness == "installed_not_running"
    }

    /// Choosing a card starts its agent if it is stopped, so Connect is ready by the time it is pressed.
    public func chooseDiscoveredAgent(_ id: String) async {
        selectDiscoveredAgent(id)
        if let agent = selectedDiscoveredAgent, AppModel.needsStart(agent.runtime), runtimeStartErrors[id] == nil {
            await startDiscoveredRuntime(id)
        }
    }

    public func discoveryTitle(_ agent: DiscoveredAgent) -> String {
        agent.title(known: knownDiscoveredIdentities[agent.id])
    }

    /// One line per card that never contradicts another part of the sheet: a profile this Mac is
    /// already running says where, otherwise the runtime says whether it can be connected.
    public func discoveryStatus(_ agent: DiscoveredAgent) -> String {
        if startingRuntimeId == agent.id { return "Starting agent…" }
        if let failure = runtimeStartErrors[agent.id] { return failure }
        if let known = knownDiscoveredIdentities[agent.id] {
            let state = connector.state(of: known.principalId)
            if state.enrolled, state.gateway == "live" {
                let room = connector.enrolment(for: known.principalId).flatMap { nameOfRoom($0.roomId) ?? $0.roomName }
                return room.map { "Connected to \($0)" } ?? "Connected"
            }
        }
        return agent.runtime.situation
    }

    public func selectDiscoveredAgent(_ id: String) {
        selectedDiscoveredAgentId = id
        discoveryDisplayName = "" // Never inherit the name of a different profile.
    }
    func acceptDiscovery(_ found: [DiscoveredAgent], known: [String: KnownRuntimeIdentity] = [:]) {
        discoveredAgents = found
        knownDiscoveredIdentities = known
        selectedDiscoveredAgentId = nil
        discoveryPhase = .results
    }
    public static func discoveryPreview(records: [[String: Any]], phase: AgentDiscoveryPhase = .results) -> AppModel {
        let model = AppModel(store: MemoryProgressStore(), connector: ConnectorModel(live: false))
        model.acceptDiscovery(records.compactMap(DiscoveredAgent.decode))
        model.discoveryPhase = phase
        return model
    }
    public func dismissAgentDiscovery() {
        guard discoveryPhase != .connecting else { return }
        runtimeStartErrors = [:]
        discoveryGeneration = UUID()
        pendingAgentMove = nil
        discoveryPhase = .idle
        showingAgentDiscovery = false
    }

    /**
     * Look at what is on this Mac. Creates nothing.
     *
     * Detection and enrolment were one step, so clicking Connect existing agent minted an agent
     * identity for whatever was found — including a Hermes that was installed but not running,
     * because "a binary exists" was being reported as healthy. Now this only looks, and says what
     * it saw; nothing is created until a person has read it and agreed.
     */
    public func detectRuntime() async {
        guard discoveryPhase != .looking, discoveryPhase != .connecting else { return }
        let requestedMove = requestedMovePrincipalId
        requestedMovePrincipalId = nil
        showingAgentDiscovery = true
        discoveryPhase = .looking
        discoveredAgents = []; selectedDiscoveredAgentId = nil; discoveryDisplayName = ""
        runtimeStartErrors = [:]
        knownDiscoveredIdentities = [:]
        problem = nil
        let generation = UUID()
        discoveryGeneration = generation
        // Capture the room the person is actually viewing, not a stale connector binding.
        let parts = (progress.lastRoomPath ?? "").split(separator: "/").map(String.init)
        discoveryCompanyId = parts.count >= 3 && parts[0] == "rooms" ? parts[1] : company?.companyId
        discoveryRoomId = parts.count >= 3 && parts[0] == "rooms" ? parts[2] : ""
        connector.begin()
        await Task.yield() // Present the loading sheet before asking the helper.
        do {
            let reply = try await connector.sidecar.send("detect")
            guard let records = reply["runtimes"] as? [[String: Any]] else {
                throw SidecarError.refused("The helper did not return an agent discovery list. Check Diagnostics and Retry.")
            }
            let found = records.compactMap(DiscoveredAgent.decode)
            guard found.count == records.count else {
                throw SidecarError.refused("The helper returned incomplete agent identities. Check Diagnostics and Retry.")
            }
            if found.isEmpty {
                guard generation == discoveryGeneration else { return }
                discoveryPhase = .results
                return
            }
            var agents: [[String: Any]] = []
            var known: [String: KnownRuntimeIdentity] = [:]
            if let companyId = discoveryCompanyId {
                // Failure is not an unknown runtime: do not ask for a new identity on a failed lookup.
                agents = try await client.agents(companyId: companyId)
                for agent in found {
                    if let identity = try await client.lookupRuntime(companyId: companyId, runtime: agent.runtime) {
                        known[agent.id] = .init(principalId: identity.principalId, displayName: identity.displayName)
                    }
                }
                let availableRooms = try await client.rooms(companyId: companyId)
                guard generation == discoveryGeneration else { return }
                rooms = availableRooms
            }
            guard generation == discoveryGeneration else { return }
            acceptDiscovery(found, known: known)
            discoveryAgents = agents
            if discoveryRoomId.isEmpty, rooms.count == 1 { discoveryRoomId = rooms[0].roomId }
            discoveryPhase = .results
            if let requestedMove {
                guard let selected = found.first(where: { known[$0.id]?.principalId == requestedMove }) else {
                    discoveryPhase = .failed("This Mac does not have the selected agent profile. Move it from the Mac holding its saved credential.")
                    return
                }
                selectDiscoveredAgent(selected.id)
                // A URL proposes a move; only native consent authorizes local credential use.
                if selectedAgentMove != nil { await confirmRuntimeConnection() }
                /* Not a move: a person put this agent back in a room it is not live in anywhere, and
                   this Mac already holds its credential. Connect it — same identity, no code. */
                else if connector.enrolment(for: requestedMove) != nil,
                        rooms.contains(where: { $0.roomId == discoveryRoomId }) { await confirmRuntimeConnection() }
            }
        } catch {
            guard generation == discoveryGeneration else { return }
            discoveryPhase = .failed(error.localizedDescription)
        }
    }

    /**
     * Bind this Mac to the runtime that was detected, after the person has agreed to it.
     *
     * The workspace decides which agent this runtime is. A runtime that has connected before keeps
     * the principal it already had, whatever it is now called and whichever room it works in — so
     * a reinstall, a restart, or a stale bridge left running from an earlier test cannot turn one
     * machine into a second agent.
     */
    public struct AgentRoomMove: Equatable, Identifiable, Sendable {
        public var principalId: String
        public var runtimeId: String
        public var fromRoomId: String
        public var toRoomId: String
        public var message: String
        public var id: String { "\(runtimeId):\(fromRoomId):\(toRoomId)" }
    }
    public var pendingAgentMove: AgentRoomMove?
    public var selectedAgentMove: AgentRoomMove? {
        guard let selected = selectedDiscoveredAgent, let known = selectedKnownIdentity else { return nil }
        let record = discoveryAgents.first { $0["principal_id"] as? String == known.principalId }
        let remote = record?["connector"] as? [String: Any]
        let local = connector.enrolment(for: known.principalId)
        guard let from = local?.roomId ?? remote?["room_id"] as? String,
              !discoveryRoomId.isEmpty, from != discoveryRoomId else { return nil }
        let fromName = nameOfRoom(from) ?? local?.roomName ?? remote?["room_name"] as? String ?? "another room"
        return .init(principalId: known.principalId, runtimeId: selected.id,
                     fromRoomId: from, toRoomId: discoveryRoomId,
                     message: "\(known.displayName) is currently connected to \(fromName). Move it to \(nameOfRoom(discoveryRoomId) ?? "the selected room")?")
    }
    public func cancelAgentMove() { pendingAgentMove = nil }
    func acceptAgentMove(_ confirmed: AgentRoomMove?) -> Bool {
        guard let move = selectedAgentMove else { return true }
        guard move == confirmed else { pendingAgentMove = move; return false }
        pendingAgentMove = nil
        return true
    }

    public func confirmRuntimeConnection(createAsNew: Bool = false, confirmedMove: AgentRoomMove? = nil) async {
        guard !createAsNew, !busy, discoveryPhase != .looking, discoveryPhase != .connecting,
              discoveryCompanyId != nil, let chosen = selectedDiscoveredAgent,
              rooms.contains(where: { $0.roomId == discoveryRoomId }) else { return }
        // A stopped agent is started first, then connected, in the one action the person took.
        if AppModel.needsStart(chosen.runtime) {
            guard await startDiscoveredRuntime(chosen.id) else { return }
        }
        guard let companyId = discoveryCompanyId,
              let runtime = selectedDiscoveredAgent, runtime.id == chosen.id, runtime.isConnectable else { return }
        let name = selectedKnownIdentity?.displayName ?? discoveryDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        guard acceptAgentMove(confirmedMove) else { return }
        if let move = selectedAgentMove {
            guard let saved = connector.enrolment(for: move.principalId),
                  saved.baseURL == workspaceAddress,
                  saved.runtimeSelectionId == nil || saved.runtimeSelectionId == runtime.id else {
                discoveryPhase = .failed("Move this agent from the Mac holding its saved credential. Moving never issues a replacement credential.")
                return
            }
            guard Keychain.readCredential(for: move.principalId).isFound else {
                discoveryPhase = .failed("Unlock the Keychain and retry the move. Its existing credential must be preserved.")
                return
            }
        }
        pendingAgentMove = nil
        busy = true; problem = nil; discoveryPhase = .connecting
        defer { busy = false }
        do {
            // Selection re-probes the exact instance and persists the adapter selection. A stale
            // discovery card can never bind an unrelated default runtime.
            _ = try await connector.sidecar.send("select-runtime", ["runtimeInstallationId": runtime.runtimeInstallationId])
            let connected = try await client.connectRuntime(companyId: companyId, name: name, runtime: runtime.runtime)
            let target = discoveryRoomId
            let existingRooms = discoveryAgents.first { $0["principal_id"] as? String == connected.principalId }?["rooms"] as? [[String: Any]] ?? []
            if !existingRooms.contains(where: { $0["room_id"] as? String == target }) {
                try await client.addRoomMember(companyId: companyId, roomId: target, principalId: connected.principalId)
            }
            // Store only after membership succeeds. Retry still reuses the stable server binding.
            company = identity?.companies.first { $0.companyId == companyId } ?? company
            guard company?.companyId == companyId else {
                throw SidecarError.refused("Sign in to this room's workspace before connecting an agent.")
            }
            write { $0.companyId = companyId; $0.agentPrincipalId = connected.principalId
                    $0.agentDisplayName = connected.displayName; $0.roomId = target }
            await bind()
            if let problem { throw problem }
            try await connector.waitForAuthenticatedSession(principalId: connected.principalId)
            discoveryPhase = .connected
            await readWorkspace(companyId)
        } catch let error as WorkspaceError {
            problem = error; discoveryPhase = .failed(error.message + " " + error.recovery)
        } catch {
            discoveryPhase = .failed(error.localizedDescription)
        }
    }

    private func adoptRuntimeMoveLink(_ raw: String) {
        requestedMovePrincipalId = nil
        guard let url = URLComponents(string: raw),
              let companyId = url.queryItems?.first(where: { $0.name == "company" })?.value,
              let roomId = url.queryItems?.first(where: { $0.name == "room" })?.value,
              UUID(uuidString: companyId) != nil, UUID(uuidString: roomId) != nil else { return }
        // Navigation only. detectRuntime revalidates workspace/room access before binding.
        remember(path: "/rooms/\(companyId)/\(roomId)")
        if let principal = url.queryItems?.first(where: { $0.name == "agent" })?.value,
           UUID(uuidString: principal) != nil { requestedMovePrincipalId = principal }
    }

    public func receive(authURL raw: String) async {
        if AppModel.isDiagnostics(raw) {
            connector.showingDiagnostics = true
            return
        }
        if let shared = AppModel.sharedRoomLink(raw) {
            guard initialized else { queuedAuthURL = raw; return }
            return await openSharedRoom(company: shared.company, room: shared.room, fragment: AppModel.roomLinkFragment(raw))
        }
        if AppModel.isConnectRuntime(raw) {
            guard initialized else { queuedAuthURL = raw; return }
            // Looking, not creating. Enrolment waits for the person to see what was found.
            adoptRuntimeMoveLink(raw)
            return await detectRuntime()
        }
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
        if let shared = AppModel.sharedRoomLink(waiting) {
            return await openSharedRoom(company: shared.company, room: shared.room, fragment: AppModel.roomLinkFragment(waiting))
        }
        if AppModel.isConnectRuntime(waiting) {
            adoptRuntimeMoveLink(waiting)
            return await detectRuntime()
        }
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
    /**
     * Whether the room this Mac would reopen still exists.
     *
     * The app returns to wherever it was last, which is right up until that room is deleted — and
     * then it reopens a room that is gone and looks as though the deletion did not take. Only a
     * path naming a room in *this* workspace can be judged here: a shared room lives in somebody
     * else's, and this workspace's list says nothing about whether it is still there.
     */
    nonisolated public static func lastRoomStillExists(path: String?, companyId: String,
                                                       rooms: [WorkspaceRoom]) -> Bool {
        guard let path else { return true }
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count >= 3, parts[0] == "rooms", parts[1] == companyId else { return true }
        return rooms.contains { $0.roomId == parts[2] }
    }

    /**
     * Which room a runtime that has just been connected should start working in.
     *
     * A runtime is connected to a workspace; work happens in a room, and a connector binds to one.
     * Connecting used to stop at the principal, so nothing was ever bound: no credential was
     * minted, the connector never started, and a person who had just been told their runtime was
     * found watched it stay disconnected forever with nothing further offered.
     *
     * One room is not a choice, so it is taken. Several is a decision that belongs to a person,
     * and none is a truthful state of its own rather than a failure.
     */
    nonisolated public static func roomToAdopt(current: String?, agentRooms: [AgentRoom]) -> String? {
        if let current, agentRooms.contains(where: { $0.id == current }) { return current }
        return agentRooms.count == 1 ? agentRooms.first?.id : nil
    }

    /// Whether a launch should carry an unfinished move the rest of the way.
    ///
    /// A Mac that recorded a room, gave up its old binding, and was then quit has everything it
    /// needs to finish except somebody to do it — and the binding step that used to is gone, along
    /// with the rest of the forced setup corridor. Pure, so the rule can be stated without a
    /// workspace to talk to. A person with no room recorded has no move to resume, and one already
    /// bound has nothing to finish.
    nonisolated public static func shouldResumeBinding(roomId: String?, agentPrincipalId: String?,
                                                       hasCompany: Bool, hasEnrolment: Bool,
                                                       hasProblem: Bool) -> Bool {
        guard roomId != nil, agentPrincipalId != nil else { return false }
        // Minting needs a signed-in workspace, and repeating a failure every refresh helps nobody.
        return hasCompany && !hasEnrolment && !hasProblem
    }

    /// Whether binding has to mint a new credential, or whether this Mac already holds the one
    /// it needs. Pure, so the rule that cost a working binding can be stated and checked without
    /// a Keychain, a workspace, or a Mac.
    nonisolated public static func shouldMint(existing: Keychain.Enrolment?, roomId: String,
                                              agentPrincipalId: String, hasCredential: Bool,
                                              credentialProblem: CredentialProblem?,
                                              gateway: String?) -> Bool {
        guard let existing,
              existing.agentPrincipalId == agentPrincipalId, hasCredential else { return true }
        // A binding the workspace is refusing is not one worth keeping. Without this, a Mac whose
        // credential another machine had replaced could never mint a new one, and "Try again"
        // would quietly do nothing for as long as anyone kept pressing it.
        return credentialProblem != nil || gateway == "auth_required"
    }

    /// One mint at a time. Concurrent callers are not a hypothetical: a move and the screen it
    /// lands on both ask to bind, within the same run loop turn.
    private var binding = false

    public func bind() async {
        guard let company,
              let agentPrincipalId = progress.agentPrincipalId,
              let roomId = progress.roomId else { return }

        guard !binding else { return }
        binding = true
        defer { binding = false }

        // A room change is never credential rotation, including a temporarily locked Keychain.
        // Persist only the new room metadata; resumeSession reads the SAME credential as before.
        let agentKey: [String: Any] = ["runtimeSelectionId": connector.enrolment(for: agentPrincipalId)?.runtimeSelectionId ?? "",
                                       "agentPrincipalId": agentPrincipalId]
        if let saved = connector.enrolment(for: agentPrincipalId),
           saved.baseURL == workspaceAddress, saved.roomId != roomId {
            guard Keychain.readCredential(for: agentPrincipalId).isFound else {
                problem = .init(code: "keychain", message: "The saved credential is unavailable.",
                                status: 0, recovery: "Unlock the Keychain and retry the move.")
                return
            }
            do {
                try await RoomRebinding.perform(existing: saved, roomId: roomId,
                    roomName: nameOfRoom(roomId), projectName: rooms.first { $0.roomId == roomId }?.projectName,
                    // This agent only. Any other agent on this Mac keeps working through the move.
                    disconnect: { _ = try await self.connector.sidecar.send("disconnect", agentKey) },
                    restore: {
                        // Nothing moved, so nothing may look moved. Leaving the target recorded
                        // would have the next launch retry a move nobody confirmed a second time.
                        self.write { $0.roomId = saved.roomId }
                        await self.connector.sidecar.resumeSession(principalId: agentPrincipalId)
                    },
                    persist: { target in
                        Keychain.saveEnrolment(target)
                        self.connector.enrolment = target
                    },
                    connect: {
                        if let failure = await self.connector.sidecar.resumeSession(principalId: agentPrincipalId) {
                            throw SidecarError.refused(failure)
                        }
                        try await self.connector.waitForAuthenticatedSession(principalId: agentPrincipalId)
                    })
            } catch RoomRebinding.Failure.stayed(let error) {
                let previous = nameOfRoom(saved.roomId) ?? saved.roomName ?? "its previous room"
                problem = .init(code: "move_failed", message: error.localizedDescription, status: 0,
                                recovery: "It is still in \(previous). Retry the move; its saved credential is unchanged.")
            } catch {
                let underlying = (error as? RoomRebinding.Failure)?.underlying ?? error
                problem = .init(code: "move_failed", message: underlying.localizedDescription, status: 0,
                                recovery: "The move is saved. This Mac keeps reconnecting to \(nameOfRoom(roomId) ?? "the new room") with the same credential; open Diagnostics if it does not connect.")
            }
            return
        }

        /* Binding twice is what broke this Mac.

           Minting a credential retires the one before it, so calling this while already bound
           kills the binding that is working. And it was called freely: `move` calls it, and then
           the binding screen it lands on calls it again from `.task` — two credentials in the
           same instant, the second retiring the first, and the runtime left holding a key the
           workspace had already replaced. A Mac that connected, worked, and then reported that
           its access had been removed was watching itself do this.

           So a Mac that already holds this exact binding, and is not being refused for it, mints
           nothing: it makes sure the runtime is up and returns, which is all the callers wanted. */
        if !AppModel.shouldMint(existing: connector.enrolment(for: agentPrincipalId), roomId: roomId,
                                agentPrincipalId: agentPrincipalId,
                                hasCredential: Keychain.readCredential(for: agentPrincipalId).isFound,
                                credentialProblem: connector.sidecar.credentialProblems[agentPrincipalId],
                                gateway: connector.state(of: agentPrincipalId).gateway) {
            connector.begin()
            await connector.sidecar.resumeSession(principalId: agentPrincipalId)
            return
        }
        let room = rooms.first { $0.roomId == roomId }
        let roomName = room?.name ?? agentRooms.first { $0.id == roomId }?.name
        let label = "\(progress.agentDisplayName ?? "Agent") on \(Host.current().localizedName ?? "this Mac")"
        do {
            let credential = try await client.mintCredential(companyId: company.companyId,
                                                             agentPrincipalId: agentPrincipalId,
                                                             label: label)
            try Keychain.saveCredential(credential, for: agentPrincipalId)
            let enrolment = Keychain.Enrolment(
                baseURL: workspaceAddress, roomId: roomId,
                roomName: roomName, projectName: room?.projectName,
                agentPrincipalId: agentPrincipalId, agentDisplayName: progress.agentDisplayName)
            var savedEnrolment = enrolment
            savedEnrolment.runtimeSelectionId = selectedDiscoveredAgentId ?? connector.enrolment(for: agentPrincipalId)?.runtimeSelectionId
            Keychain.saveEnrolment(savedEnrolment)
            connector.enrolment = savedEnrolment
            connector.sidecar.credentialProblems[agentPrincipalId] = nil
            connector.sidecar.credentialProblem = connector.sidecar.credentialProblems.values.first
            connector.begin()
            await connector.sidecar.resumeSession(principalId: agentPrincipalId)
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
