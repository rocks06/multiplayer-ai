import Foundation
import Observation

/// Runs the Connector's working half and keeps it running.
///
/// Supervision here is only of the process: if it dies, it is started again with a backoff.
/// Everything about recovering a dropped network connection lives inside the connector itself,
/// which already knows how to resume a room from where it left off — restarting the process to
/// fix a network blip would throw that away.
@Observable
@MainActor
public final class SidecarClient {
    /// A client that never launches anything, for rendering and for reasoning about states.
    public init(preview: SidecarState? = nil) { if let preview { state = preview; previewOnly = true } }
    private var previewOnly = false
    /// Whether this client is a drawing of one. Nothing is spawned, read, or asked of the network.
    public var isPreview: Bool { previewOnly }

    public private(set) var state: SidecarState = .unknown
    public private(set) var processStartedAt: Date?
    public private(set) var lastLaunchFailure: String?
    public private(set) var restarts = 0
    /// Set when this Mac is enrolled but cannot present its credential. Nil at every other time,
    /// including before the first resume attempt.
    public var credentialProblem: CredentialProblem?

    private var process: Process?
    private var stdin: FileHandle?
    // Replies travel as the raw line rather than a parsed dictionary: a dictionary of Any is
    // not Sendable, and would be unsafe to hand across the continuation.
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var nextId = 1
    private var buffer = Data()
    private var restartDelay: TimeInterval = 1
    private var stopping = false

    /// The bundled executable, or a development build when running from a checkout.
    private var executable: URL? {
        if let bundled = Bundle.main.url(forResource: "mpai-connector-sidecar", withExtension: nil) { return bundled }
        if let override = ProcessInfo.processInfo.environment["MPAI_SIDECAR"] { return URL(fileURLWithPath: override) }
        return nil
    }

    /// Where the background half lives, so setup can report on it before trying to run it.
    public var executablePath: URL? { executable }

    /// Where the helper keeps what it must not lose — its cursor, its session, its log.
    ///
    /// Keyed to the bundle rather than fixed. The shipping app's directory is exactly the one it
    /// has always used, so nothing already written moves; any other build gets its own. Without
    /// this, two Multiplayer AI builds on one Mac share one durable state file, and either can
    /// destroy the other's live session by signing out — which is not a hypothetical, it is what
    /// happened the first time a verification build was run beside the real app.
    nonisolated public static func supportDirectory(for bundleId: String?) -> URL {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let shipping = "com.multiplayerai.connector"
        guard let bundleId, bundleId != shipping else { return root.appending(path: "Multiplayer AI") }
        return root.appending(path: "Multiplayer AI (\(bundleId))")
    }

    public func start() {
        guard !previewOnly else { return }
        guard process == nil, let executable else {
            if executable == nil { lastLaunchFailure = "The Connector's helper is missing from the app." }
            return
        }
        stopping = false
        let task = Process()
        task.executableURL = executable
        var environment = ProcessInfo.processInfo.environment
        environment["MPAI_SUPPORT_DIR"] =
            SidecarClient.supportDirectory(for: Bundle.main.bundleIdentifier).path
        task.environment = environment
        let input = Pipe(), output = Pipe()
        task.standardInput = input
        task.standardOutput = output
        task.standardError = Pipe()

        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor in self?.receive(data) }
        }
        task.terminationHandler = { [weak self] _ in
            Task { @MainActor in self?.processEnded() }
        }

        do {
            try task.run()
            process = task
            stdin = input.fileHandleForWriting
            processStartedAt = Date()
            lastLaunchFailure = nil
            restartDelay = 1
        } catch {
            lastLaunchFailure = error.localizedDescription
        }
    }

    public func stop() {
        stopping = true
        process?.terminate()
        process = nil
        stdin = nil
        processStartedAt = nil
        state.running = false
    }

    private func processEnded() {
        process = nil
        stdin = nil
        processStartedAt = nil
        state.running = false
        for (_, continuation) in pending { continuation.resume(throwing: SidecarError.stopped) }
        pending.removeAll()
        guard !stopping else { return }
        // Crashed rather than asked to stop: bring it back, backing off so a repeatedly failing
        // helper does not spin.
        restarts += 1
        let delay = restartDelay
        restartDelay = min(restartDelay * 2, 30)
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            guard !self.stopping else { return }
            self.start()
            await self.resumeSession()
        }
    }

    private func receive(_ data: Data) {
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            guard let payload = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            switch payload["type"] as? String {
            case "state":
                if let decoded = try? JSONDecoder().decode(SidecarState.self, from: Data(line)) { state = decoded }
            case "reply":
                if let id = payload["id"] as? Int, let continuation = pending.removeValue(forKey: id) {
                    if payload["ok"] as? Bool == true { continuation.resume(returning: Data(line)) }
                    else { continuation.resume(throwing: SidecarError.refused(payload["error"] as? String ?? "The Connector refused that.")) }
                }
            default: break
            }
        }
    }

    @discardableResult
    public func send(_ command: String, _ arguments: [String: Any] = [:]) async throws -> [String: Any] {
        guard let stdin else { throw SidecarError.stopped }
        let id = nextId
        nextId += 1
        var payload = arguments
        payload["id"] = id
        payload["command"] = command
        let data = try JSONSerialization.data(withJSONObject: payload)
        let reply: Data = try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            stdin.write(data + Data("\n".utf8))
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(15))
                self?.pending.removeValue(forKey: id)?.resume(throwing: SidecarError.refused("The connector did not respond. Retry or open Diagnostics."))
            }
        }
        return (try? JSONSerialization.jsonObject(with: reply) as? [String: Any]) ?? [:]
    }

    /// What resuming should do, decided without touching a Keychain so it can be tested.
    ///
    /// The distinction that matters is between the first and the third case. Both leave the
    /// sidecar unconfigured; only one of them means the person has nothing set up.
    public enum ResumeDecision: Equatable, Sendable {
        case nothingToResume                       // this Mac was never enrolled
        case resume(String)                        // enrolled, and the credential is in hand
        case cannotPresent(CredentialProblem)      // enrolled, and it is not
    }

    nonisolated public static func resumeDecision(enrolled: Bool, lookup: Keychain.CredentialLookup?) -> ResumeDecision {
        guard enrolled else { return .nothingToResume }
        switch lookup {
        case .found(let value): return .resume(value)
        case .missing: return .cannotPresent(.missing)
        case .unreadable(let status): return .cannotPresent(.unreadable(status))
        // Enrolled with nothing looked up should never happen; treating it as "never set up"
        // is precisely the silence this exists to remove, so it is a problem rather than a shrug.
        case nil: return .cannotPresent(.missing)
        }
    }

    /// Hand the sidecar what it needs to be this agent again, after a launch or a crash.
    ///
    /// A Mac that was never set up has nothing to resume and says nothing. A Mac that *was* set up
    /// and cannot produce its credential is a different matter entirely: it used to return here in
    /// silence, leaving an enrolled Mac looking untouched and permanently disconnected with no
    /// explanation anywhere in the app. That case now has a state of its own.
    public func resumeSession() async {
        let enrolment = Keychain.enrolment()
        let credential: String
        switch SidecarClient.resumeDecision(enrolled: enrolment != nil,
                                            lookup: enrolment == nil ? nil : Keychain.readCredential()) {
        case .nothingToResume:
            credentialProblem = nil
            return
        case .cannotPresent(let problem):
            credentialProblem = problem
            return
        case .resume(let value):
            credential = value
            credentialProblem = nil
        }
        guard let enrolment else { return }
        do {
            try await send("configure", [
                "baseUrl": enrolment.baseURL, "roomId": enrolment.roomId,
                "agentPrincipalId": enrolment.agentPrincipalId, "credential": credential,
                "agentDisplayName": enrolment.agentDisplayName ?? "",
                "roomName": enrolment.roomName ?? "", "projectName": enrolment.projectName ?? "",
            ])
            try await send("connect")
        } catch {
            lastLaunchFailure = error.localizedDescription
        }
    }

    public func refresh() async {
        guard !previewOnly else { return }
        guard let reply = try? await send("status"), let raw = reply["state"],
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let decoded = try? JSONDecoder().decode(SidecarState.self, from: data) else { return }
        state = decoded
    }
}

public enum SidecarError: LocalizedError {
    case stopped
    case refused(String)
    public var errorDescription: String? {
        switch self {
        case .stopped: return "The Connector's helper is not running."
        case .refused(let message): return message
        }
    }
}
