import Foundation

/// Preparing this Mac, and saying only what is actually being done.
///
/// The helper ships inside the app and Hermes is the person's own — so nothing here downloads,
/// installs a runtime, or writes a configuration file, and none of the steps claim to. What is
/// genuinely happening is that the app checks it is intact, starts its background half, asks
/// what agent runtimes are on this Mac, proves it can keep a secret, and arranges to come back
/// at login. Those are the five steps, named for what they do.
public enum SetupTask: String, CaseIterable, Equatable, Sendable {
    case system
    case helper
    case service
    case agents
    case storage
    case login

    public var title: String {
        switch self {
        case .system:  return "Checking this Mac"
        case .helper:  return "Preparing Multiplayer AI"
        case .service: return "Starting the connection service"
        case .agents:  return "Looking for your agents"
        case .storage: return "Preparing secure storage"
        case .login:   return "Finishing setup"
        }
    }
}

/// How one step ended. A failure carries both halves of the answer a person needs: what
/// happened, and what they can do now.
public enum TaskOutcome: Equatable, Sendable {
    case pending
    case running
    case done(String)
    case failed(what: String, todo: String)

    public var isFailure: Bool { if case .failed = self { return true }; return false }
    public var isFinished: Bool {
        switch self { case .done, .failed: return true; default: return false }
    }
}

/// The whole sequence and where it has got to. A value, so a view renders it and the tests
/// reason about it without either of them running anything.
public struct SetupProgress: Equatable, Sendable {
    public private(set) var outcomes: [SetupTask: TaskOutcome]
    public init() {
        outcomes = Dictionary(uniqueKeysWithValues: SetupTask.allCases.map { ($0, .pending) })
    }

    public subscript(task: SetupTask) -> TaskOutcome { outcomes[task] ?? .pending }

    public mutating func set(_ task: SetupTask, _ outcome: TaskOutcome) { outcomes[task] = outcome }

    /// Everything finished and nothing failed. This — not a timer, and not the last step having
    /// been reached — is what allows setup to be recorded as complete.
    public var succeeded: Bool {
        SetupTask.allCases.allSatisfy { if case .done = self[$0] { return true }; return false }
    }

    public var failure: (task: SetupTask, what: String, todo: String)? {
        for task in SetupTask.allCases {
            if case .failed(let what, let todo) = self[task] { return (task, what, todo) }
        }
        return nil
    }

    /// A step is only started once everything before it has finished, so the sequence a person
    /// watches is the sequence that actually runs.
    public var next: SetupTask? {
        SetupTask.allCases.first { !self[$0].isFinished }
    }

    public var completed: Int {
        SetupTask.allCases.filter { self[$0].isFinished && !self[$0].isFailure }.count
    }
}

/// The decisions each step makes, separated from the work so they can be tested against inputs
/// no test host can be relied on to produce — a missing helper, a Keychain that refuses, a Mac
/// with no agent runtime on it.
public enum SetupJudgement {
    public static func system(osVersion: OperatingSystemVersion, minimumMajor: Int = 14) -> TaskOutcome {
        guard osVersion.majorVersion >= minimumMajor else {
            return .failed(what: "This Mac runs macOS \(osVersion.majorVersion), and Multiplayer AI needs macOS \(minimumMajor) or later.",
                           todo: "Update macOS in System Settings, then open Multiplayer AI again.")
        }
        return .done("macOS \(osVersion.majorVersion).\(osVersion.minorVersion)")
    }

    public static func helper(found: Bool, executable: Bool) -> TaskOutcome {
        guard found else {
            return .failed(what: "Part of Multiplayer AI is missing from the app.",
                           todo: "Move Multiplayer AI to your Applications folder and open it again. If it keeps happening, download it again.")
        }
        guard executable else {
            return .failed(what: "Multiplayer AI is not allowed to start its own background service.",
                           todo: "Move Multiplayer AI to your Applications folder and open it again.")
        }
        return .done("Ready")
    }

    public static func service(started: Bool, failure: String?) -> TaskOutcome {
        guard started else {
            return .failed(what: failure ?? "The connection service would not start.",
                           todo: "Quit Multiplayer AI and open it again. If it keeps happening, restart this Mac.")
        }
        return .done("Running")
    }

    /// A Mac with no supported runtime is *not* a failed setup. Everything the app does for a
    /// person still works; there is simply no agent here yet, which is the next screen's subject
    /// and is said there properly rather than as an error in a progress list.
    public static func agents(runtime: SidecarState.Runtime) -> TaskOutcome {
        guard runtime.available else { return .done("None found yet") }
        return .done("\(runtime.name) \(runtime.version ?? "")".trimmingCharacters(in: .whitespaces))
    }

    public static func storage(probe: Keychain.CredentialLookup?) -> TaskOutcome {
        switch probe {
        case .some(.found), .none: return .done("Ready")
        case .some(.missing): return .done("Ready")
        case .some(.unreadable(let status)):
            return .failed(what: "macOS would not let Multiplayer AI use the keychain (\(status)).",
                           todo: "Open Keychain Access, unlock your login keychain, then open Multiplayer AI again.")
        }
    }

    /// Opening at login is a convenience, not a requirement. If macOS refuses it the app still
    /// works perfectly well when opened by hand, so this reports what is true and moves on.
    public static func login(registered: Bool) -> TaskOutcome {
        registered ? .done("Opens at login") : .done("Open it yourself when you need it")
    }
}
