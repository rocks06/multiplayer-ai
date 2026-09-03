import Foundation

/// What the sidecar reports about itself. Four separate truths, kept separate: whether the
/// local process is alive, what the workspace connection is doing, whether the agent runtime
/// can be driven, and how far the room has been read. None is inferred from another.
public struct SidecarState: Decodable, Equatable, Sendable {
    public struct Runtime: Decodable, Equatable, Sendable {
        public var available: Bool
        public var name: String
        public var version: String?
        public var path: String?
        public var reason: String?
        /* What the runtime actually is, as discovered rather than assumed. The endpoint is only
           ever present when a health check answered on it, so "we found Hermes" and "we can talk
           to Hermes" cannot be confused — and identity is the runtime's own durable id, not its
           name, its port, or the app installation that happens to be talking to it. */
        public var runtimeType: String?
        public var externalRuntimeId: String?
        public var connectorInstallationId: String?
        public var endpoint: String?
        public var healthEndpoint: String?
        public var transport: String?
        public var probeStatus: String?
        /// How far along the runtime is, in the adapter's own words. See RuntimeReadiness.
        public var readiness: String?
        public var serviceRunning: Bool?
        public init(available: Bool, name: String, version: String? = nil, path: String? = nil, reason: String? = nil,
                    runtimeType: String? = nil, externalRuntimeId: String? = nil,
                    connectorInstallationId: String? = nil, endpoint: String? = nil,
                    healthEndpoint: String? = nil, transport: String? = nil, probeStatus: String? = nil,
                    readiness: String? = nil, serviceRunning: Bool? = nil) {
            self.available = available; self.name = name; self.version = version
            self.path = path; self.reason = reason
            self.runtimeType = runtimeType; self.externalRuntimeId = externalRuntimeId
            self.connectorInstallationId = connectorInstallationId; self.endpoint = endpoint
            self.healthEndpoint = healthEndpoint; self.transport = transport; self.probeStatus = probeStatus
            self.readiness = readiness; self.serviceRunning = serviceRunning
        }

        /// Whether this is a runtime we may actually bind to.
        ///
        /// Only `ready` qualifies. Installed-but-not-running and found-but-not-controllable are
        /// both real, common, and emphatically not connectable — enrolling either mints an agent
        /// identity for something that cannot do any work.
        public var isConnectable: Bool {
            readiness == "ready" && endpoint != nil
                && externalRuntimeId != nil && connectorInstallationId != nil
        }

        /// What to tell the person, for every state the adapter can report. Never "healthy"
        /// because a file happened to exist.
        public var situation: String {
            switch readiness {
            case "ready": return "\(name) is ready to connect"
            case "installed_not_running": return "\(name) is installed but not running"
            case "control_unavailable": return "\(name) was found but cannot be controlled"
            case "unsupported_version": return "\(name) is too old for this connector"
            case "not_installed": return "\(name) is not installed on this Mac"
            default: return reason ?? "\(name) could not be checked"
            }
        }
    }
    public struct Sync: Decodable, Equatable, Sendable {
        public var lastContiguousSeq: Int?
        public var pending: Int
        public init(lastContiguousSeq: Int? = nil, pending: Int = 0) {
            self.lastContiguousSeq = lastContiguousSeq; self.pending = pending
        }
    }
    public struct Identity: Decodable, Equatable, Sendable {
        public var agentDisplayName: String?
        public var roomName: String?
        public var projectName: String?
        public init(agentDisplayName: String? = nil, roomName: String? = nil, projectName: String? = nil) {
            self.agentDisplayName = agentDisplayName; self.roomName = roomName; self.projectName = projectName
        }
    }

    public var enrolled: Bool
    public var running: Bool
    public var startedAt: String?
    public var gateway: String
    public var runtime: Runtime
    public var sync: Sync
    public var identity: Identity?
    public var lastError: String?

    public init(enrolled: Bool, running: Bool, startedAt: String?, gateway: String,
                runtime: Runtime, sync: Sync, identity: Identity?, lastError: String?) {
        self.enrolled = enrolled; self.running = running; self.startedAt = startedAt
        self.gateway = gateway; self.runtime = runtime; self.sync = sync
        self.identity = identity; self.lastError = lastError
    }

    public static let unknown = SidecarState(
        enrolled: false, running: false, startedAt: nil, gateway: "not_started",
        runtime: .init(available: false, name: "Hermes Agent", version: nil, path: nil, reason: nil),
        sync: .init(lastContiguousSeq: nil, pending: 0), identity: nil, lastError: nil)
}

/// The single word the menu bar shows. It never claims more than the parts below it support.
public enum Health: Equatable, Sendable {
    case notConnected          // nothing set up on this Mac yet
    case connected
    case reconnecting
    case offline
    case runtimeUnavailable
    case authRequired
    /// This agent is live on a newer connection — usually this Mac a moment ago, after a rebind.
    /// Not a fault, and emphatically not a reason to ask anyone for a new enrollment code.
    case replaced

    public var title: String {
        switch self {
        case .notConnected: return "Not set up"
        case .connected: return "Connected"
        case .reconnecting: return "Reconnecting"
        case .offline: return "Offline"
        case .runtimeUnavailable: return "Runtime unavailable"
        case .authRequired: return "Sign-in needed"
        case .replaced: return "Reconnecting"
        }
    }

    /// Semantic only: green for working, amber for working on it, red for stopped.
    public var tone: Tone {
        switch self {
        case .connected: return .good
        case .replaced: return .working
        case .reconnecting: return .working
        case .notConnected, .offline: return .idle
        case .runtimeUnavailable, .authRequired: return .stopped
        }
    }

    public enum Tone: Sendable { case good, working, idle, stopped }
}

/// Why an enrolled Mac cannot present its credential at all.
///
/// This is a *local* problem, and it is invisible to the sidecar: the helper is never configured,
/// so it truthfully reports itself as not enrolled. Without this the app rendered that as
/// "Not set up" and offered the enrolment screen — telling a person who had set this Mac up that
/// they had not, and asking them for a code they had no reason to have.
public enum CredentialProblem: Equatable, Sendable {
    case missing                 // enrolled, but nothing is stored any more
    case unreadable(OSStatus)    // stored, but macOS will not release it to this build

    /// What to actually do about it. Both roads end at the same place — a new code from the
    /// workspace — which is the point: one clear action, not a diagnosis to interpret.
    public var recovery: String {
        switch self {
        case .missing:
            return "This Mac's saved sign-in is gone. Open your workspace, choose Connect beside this agent, and enter the new code."
        case .unreadable:
            return "macOS will not release this Mac's saved sign-in. This usually happens after the app is replaced with a different build. Choose Sign out this Mac, then connect again with a new code from your workspace."
        }
    }
}

/**
 * The three different things people mean by "connected", kept apart.
 *
 * A runtime being installed on this Mac, a runtime being usable, and a runtime working for
 * Multiplayer AI are three separate facts, and the product used to blur them: "Hermes found" sat
 * on screen while nothing was bound and no work could reach it. Finding software on a disk says
 * nothing about whether this workspace can put it to work.
 */
public enum RuntimeConnection: Equatable, Sendable {
    /// Nothing that answers is installed.
    case absent
    /// Found on this Mac, but not usable yet — not running, too old, or not controllable.
    case detected(String)
    /// Found, controllable, and waiting to be connected to a workspace.
    case ready
    /// Bound to this workspace and running.
    case connected

    public var headline: String {
        switch self {
        case .absent: return "No agent runtime found on this Mac"
        case .detected(let situation): return situation
        case .ready: return "Ready to connect"
        case .connected: return "Connected to Multiplayer AI"
        }
    }

    /// Only one of these means the workspace can reach it, and it is never inferred from a file.
    public var isConnected: Bool { self == .connected }

    /// What the app knows, from what it found and what it is actually bound to.
    public static func of(runtime: SidecarState.Runtime, enrolled: Bool, health: Health) -> RuntimeConnection {
        if enrolled && health == .connected { return .connected }
        switch runtime.readiness {
        case "ready": return .ready
        case nil, "not_installed": return .absent
        default: return .detected(runtime.situation)
        }
    }
}

public enum Diagnosis {
    /// A connection that has been refused is not the same problem as one that has dropped, and
    /// neither is the same as a runtime that was never installed. Whichever most stops the agent
    /// from working is the one named, and the rows underneath still state all four.
    public static func health(of state: SidecarState, credential problem: CredentialProblem? = nil) -> Health {
        // Nothing below can proceed without a credential, and the sidecar cannot report this
        // because it was never configured — so it is checked before anything the sidecar says.
        if problem != nil { return .authRequired }
        guard state.enrolled else { return .notConnected }
        if state.gateway == "auth_required" { return .authRequired }
        // Checked before `running`, because standing down is exactly what a replaced runtime does.
        if state.gateway == "superseded" { return .replaced }
        if !state.running { return .offline }
        switch state.gateway {
        case "live":
            return state.runtime.available ? .connected : .runtimeUnavailable
        case "reconnecting", "created", "resyncing":
            return .reconnecting
        case "stalled":
            return .reconnecting
        default:
            return .offline
        }
    }

    /// The workspace row on its own, which stays true even when the headline is about Hermes.
    public static func workspaceDetail(_ state: SidecarState, credential problem: CredentialProblem? = nil) -> String {
        if problem != nil { return "Sign-in needed" }
        if !state.enrolled { return "Not set up" }
        if state.gateway == "auth_required" { return "Sign-in needed" }
        if state.gateway == "superseded" { return "Reconnecting" }
        if !state.running { return "Not running" }
        switch state.gateway {
        case "live": return "Connected"
        case "created": return "Connecting"
        case "reconnecting": return "Reconnecting"
        case "stalled": return "Reconnecting"
        default: return "Offline"
        }
    }

    /// The row is labelled with the runtime's name, so the value says only what is new: which
    /// version is installed, or that there is none.
    public static func runtimeDetail(_ state: SidecarState) -> String {
        let runtime = state.runtime
        guard runtime.available else { return "Not found" }
        return runtime.version ?? "Installed"
    }

    /// How far the room has been read. Distinct from being connected: a live connection with
    /// work still queued is a real and different situation.
    public static func syncDetail(_ state: SidecarState) -> String {
        guard state.running, state.enrolled else { return "—" }
        if state.sync.pending > 0 {
            return state.sync.pending == 1 ? "1 item waiting" : "\(state.sync.pending) items waiting"
        }
        guard state.sync.lastContiguousSeq != nil else { return "Nothing read yet" }
        return "Up to date"
    }

    public static func processDetail(_ state: SidecarState, since: Date?) -> String {
        guard state.running else { return "Not running" }
        guard let since else { return "Running" }
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        return "Running since \(formatter.string(from: since))"
    }
}
