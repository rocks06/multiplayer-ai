import Foundation

/// Where a person is in setting Multiplayer AI up, and how that is decided.
///
/// Nothing here counts steps. Which screen someone gets is read from what is actually true —
/// the session the server honours, what the workspace contains, and what this Mac holds — so
/// quitting halfway through and coming back lands exactly where it left off, and a returning
/// install goes straight to the workspace without being asked anything.
public enum Step: String, Equatable, Sendable, CaseIterable {
    case welcome     // first launch, nothing done yet
    case setup       // preparing this Mac
    case account     // who you are
    case workspace   // naming the place your agents work
    case agent       // the agent you already run on this Mac
    case room        // where that agent works
    case binding     // giving this Mac its identity — no question asked of anyone
    case reconnect   // set up, but this Mac cannot present its credential
    case ready       // the product
}

/// Everything the choice depends on, gathered so the choice itself can be made without touching
/// a Keychain, a network, or a disk.
public struct Situation: Equatable, Sendable {
    public var setupComplete: Bool
    public var signedIn: Bool
    public var hasWorkspace: Bool
    public var hasAgentIdentity: Bool
    public var hasRoom: Bool
    public var bound: Bool
    public var credentialProblem: CredentialProblem?

    public init(setupComplete: Bool = false, signedIn: Bool = false, hasWorkspace: Bool = false,
                hasAgentIdentity: Bool = false, hasRoom: Bool = false, bound: Bool = false,
                credentialProblem: CredentialProblem? = nil) {
        self.setupComplete = setupComplete; self.signedIn = signedIn
        self.hasWorkspace = hasWorkspace; self.hasAgentIdentity = hasAgentIdentity
        self.hasRoom = hasRoom; self.bound = bound; self.credentialProblem = credentialProblem
    }
}

public enum Onboarding {
    /// The resume point, and only that. Moving forward from a screen is something a person does;
    /// this decides where they are put when the app opens or something changes underneath them.
    ///
    /// The order is the order of dependency, not the order of the screens as drawn: an agent
    /// cannot be given an identity before there is an account to own it, and cannot connect
    /// before there is a room to connect to. Signing in comes before the credential problem
    /// because every remedy for that problem needs a signed-in person to carry it out.
    public static func step(for s: Situation) -> Step {
        if !s.setupComplete { return .welcome }
        if !s.signedIn { return .account }
        /* A binding this Mac cannot present is a fault in something that already exists, not a
           step in setting anything up, and every remedy for it needs a signed-in person — so it
           stays here, ahead of the product. */
        if s.credentialProblem != nil { return .reconnect }
        /* Everything else is Home's to offer. Creating a workspace, naming an agent and making a
           room used to be a corridor every account walked down, which is how invited people ended
           up making a junk room before they could join the one they were invited to. None of the
           three is a step: they are things a person may choose, from Home, when they mean to. */
        return .ready
    }

    /// Whether reaching `step` means onboarding is over. Used to decide whether the window shows
    /// the product or a setup screen, without that decision being duplicated in a view.
    public static func isOnboarding(_ step: Step) -> Bool { step != .ready }
}

/// The part of setting up that belongs to this Mac rather than to the workspace.
///
/// Kept beside the app's own settings rather than in the Keychain: none of it is secret, and a
/// returning install has to be able to read it before anything is unlocked.
public struct Progress: Codable, Equatable, Sendable {
    public var setupComplete: Bool = false
    /// Which workspace this Mac last acted in, so a returning person is not asked again.
    public var companyId: String?
    /// The agent identity created for this Mac, held from the moment it exists so a crash
    /// between naming an agent and giving it a room does not create a second one.
    public var agentPrincipalId: String?
    public var agentDisplayName: String?
    public var roomId: String?
    /// Where the workspace lives. One address for the whole app — the helper is handed the same.
    public var workspaceAddress: String?
    /// The room the person was last in, so relaunching returns them to it.
    public var lastRoomPath: String?
    /// Whether anyone has ever been signed in on this Mac. Signing out does not clear it: the
    /// person reaching the account screen afterwards has an account, and is shown Sign in.
    /// Optional so that progress saved before this existed still decodes.
    public var hasSignedIn: Bool?

    public init() {}

    /// An account has been used here, by this record or by one saved before the record existed.
    public var knowsAnAccount: Bool { hasSignedIn == true || companyId != nil }
}

/// Reading and writing `Progress`. A protocol so the state machine can be exercised against a
/// store that is just a dictionary.
public protocol ProgressStore: Sendable {
    func load() -> Progress
    func save(_ progress: Progress)
}

public struct DefaultsProgressStore: ProgressStore {
    private let key = "com.multiplayerai.app.progress"
    private let suite: String?
    /// Named rather than held: `UserDefaults` is not `Sendable`, and a store that can cross an
    /// actor boundary is worth more here than saving one lookup.
    public init(suite: String? = nil) { self.suite = suite }
    private var defaults: UserDefaults {
        suite.flatMap(UserDefaults.init(suiteName:)) ?? .standard
    }
    public func load() -> Progress {
        guard let data = defaults.data(forKey: key),
              let decoded = try? JSONDecoder().decode(Progress.self, from: data) else { return Progress() }
        return decoded
    }
    public func save(_ progress: Progress) {
        guard let data = try? JSONEncoder().encode(progress) else { return }
        defaults.set(data, forKey: key)
    }
}
