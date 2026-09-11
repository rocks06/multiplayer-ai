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

    /// Local process/transport evidence remains available even when diagnostics IPC fails.
    public private(set) var ipcStatus = "Not started"
    public private(set) var lastIPCFailure: String?
    public private(set) var lastExit: String?
    public var processIdentifier: Int32? { process?.isRunning == true ? process?.processIdentifier : nil }
    public var activeSupportDirectory: URL { supportOverride ?? Self.supportDirectory(for: Bundle.main.bundleIdentifier) }
    private var executableOverride: URL?
    private var supportOverride: URL?
    private var environmentOverride: [String: String]?
    private var restartEnabled = true
    private var requestTimeout: TimeInterval = 15
    private var generation = UUID()
    private var stderrBuffer = Data()
    private var outputHandle: FileHandle?
    private var errorHandle: FileHandle?

    // Explicit injection keeps tests out of the shipping support directory and Keychain.
    init(executable: URL, supportDirectory: URL, environment: [String: String], requestTimeout: TimeInterval = 1) {
        executableOverride = executable; supportOverride = supportDirectory
        environmentOverride = environment; restartEnabled = false; self.requestTimeout = requestTimeout
    }

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
        if let executableOverride { return executableOverride }
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
        generation = UUID()
        let launch = generation
        buffer.removeAll(); stderrBuffer.removeAll()
        ipcStatus = "Launching"
        let task = Process()
        task.executableURL = executable
        var environment = environmentOverride ?? ProcessInfo.processInfo.environment
        environment["MPAI_SUPPORT_DIR"] = activeSupportDirectory.path
        task.environment = environment
        let input = Pipe(), output = Pipe(), errors = Pipe()
        task.standardInput = input
        task.standardOutput = output
        task.standardError = errors
        outputHandle = output.fileHandleForReading
        errorHandle = errors.fileHandleForReading

        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil }
            Task { @MainActor in
                guard let self, self.generation == launch else { return }
                if data.isEmpty {
                    if !self.stopping { self.lastIPCFailure = "Helper stdout closed (IPC EOF)."; self.ipcStatus = "Closed" }
                } else { self.receive(data) }
            }
        }
        // Always drain stderr: an unread pipe can block a live helper forever. Retain only a
        // bounded tail, and expose classified codes, never arbitrary child output or secrets.
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil }
            Task { @MainActor in
                guard let self, self.generation == launch else { return }
                self.stderrBuffer.append(data)
                self.stderrBuffer = Data(self.stderrBuffer.suffix(8192))
            }
        }
        task.terminationHandler = { [weak self] ended in
            let status = ended.terminationStatus
            let signalled = ended.terminationReason == .uncaughtSignal
            Task { @MainActor in
                guard let self, self.generation == launch else { return }
                self.processEnded(status: status, signalled: signalled)
            }
        }

        do {
            try task.run()
            process = task
            stdin = input.fileHandleForWriting
            processStartedAt = Date()
            ipcStatus = "Awaiting ping"
            Task { @MainActor [weak self] in
                guard let self, self.generation == launch, !self.stopping else { return }
                do {
                    _ = try await self.send("ping")
                    guard self.generation == launch, self.processIdentifier != nil else { return }
                    self.ipcStatus = "Ready"
                    self.lastLaunchFailure = nil
                    // Only a sustained process earns a reset; immediate crashes must back off.
                    try? await Task.sleep(for: .seconds(30))
                    if self.generation == launch, self.processIdentifier != nil { self.restartDelay = 1 }
                } catch {
                    guard self.generation == launch, self.processIdentifier != nil else { return }
                    if self.ipcStatus == "Awaiting ping" { self.ipcStatus = "Unresponsive" }
                    self.lastIPCFailure = error.localizedDescription
                }
            }
        } catch {
            outputHandle?.readabilityHandler = nil; errorHandle?.readabilityHandler = nil
            ipcStatus = "Launch failed"
            let failure = error as NSError
            lastLaunchFailure = "Helper launch failed (\(failure.domain) \(failure.code)): \(failure.localizedDescription)"
        }
    }

    public func stop() {
        stopping = true
        generation = UUID() // Fence late EOF/termination callbacks from the outgoing process.
        if process?.isRunning == true { process?.terminate() }
        clearProcess()
        ipcStatus = "Stopped"
    }

    private func clearProcess() {
        outputHandle?.readabilityHandler = nil; errorHandle?.readabilityHandler = nil
        outputHandle = nil; errorHandle = nil
        process = nil; stdin = nil; processStartedAt = nil
        buffer.removeAll()
        state.running = false
        for (_, continuation) in pending { continuation.resume(throwing: SidecarError.stopped) }
        pending.removeAll()
    }

    private func processEnded(status: Int32, signalled: Bool) {
        let evidence = Self.exitSummary(status: status, signalled: signalled, stderr: stderrBuffer)
        lastExit = evidence
        if !stopping { lastLaunchFailure = evidence }
        clearProcess()
        ipcStatus = "Exited"
        guard !stopping, restartEnabled else { return }
        // Crashed rather than asked to stop: bring it back, backing off so a repeatedly failing
        // helper does not spin.
        restarts += 1
        let delay = restartDelay
        restartDelay = min(restartDelay * 2, 30)
        let endedGeneration = generation
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            guard !self.stopping, self.generation == endedGeneration, self.process == nil else { return }
            self.start()
            if self.processIdentifier != nil { await self.resumeSession() }
        }
    }

    nonisolated static func exitSummary(status: Int32, signalled: Bool, stderr: Data) -> String {
        let kind = signalled ? "signal" : "status"
        let text = String(decoding: stderr, as: UTF8.self)
        // Only fixed, recognized markers are reportable. Stderr can contain arbitrary secrets,
        // paths, URLs or request bodies; regex-redacting known token prefixes is not sufficient.
        let codes = ["EACCES", "EPERM", "ENOENT", "ENOSPC", "EROFS", "MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED"]
        let code = codes.first { text.contains($0) }
        let detail = code.map { "; stderr reports \($0)" }
            ?? (text.contains("dyld[") ? "; dynamic loader failure" : stderr.isEmpty ? "; no stderr captured" : "; stderr captured (content withheld)")
        return "Helper exited with \(kind) \(status)\(detail)."
    }

    private func receive(_ data: Data) {
        buffer.append(data)
        guard buffer.count <= 1_048_576 else {
            buffer.removeAll(); lastIPCFailure = "Helper IPC frame exceeded 1 MiB."; return
        }
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            guard let payload = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                lastIPCFailure = "Helper emitted invalid JSON on stdout (content withheld)."; continue
            }
            switch payload["type"] as? String {
            case "state":
                do { state = try JSONDecoder().decode(SidecarState.self, from: Data(line)) }
                catch { lastIPCFailure = "Helper state does not match the app IPC schema." }
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
        guard let stdin, processIdentifier != nil else { throw SidecarError.stopped }
        let id = nextId
        nextId += 1
        var payload = arguments
        payload["id"] = id
        payload["command"] = command
        let data = try JSONSerialization.data(withJSONObject: payload)
        let reply: Data = try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            do { try stdin.write(contentsOf: data + Data("\n".utf8)) }
            catch {
                let failure = error as NSError
                let message = "Helper IPC write failed (\(failure.domain) \(failure.code))."
                lastIPCFailure = message
                pending.removeValue(forKey: id)?.resume(throwing: SidecarError.refused(message))
                return
            }
            let timeout = ["detect", "discover", "select-runtime"].contains(command) ? max(requestTimeout, 60) : requestTimeout
            // The command name is allowlisted; arguments (including credentials) never enter reports.
            let label = ["ping", "status", "diagnostics", "detect", "configure", "connect", "disconnect", "reconnect", "signout", "enroll"].contains(command) ? command : "request"
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                guard let self, let waiter = self.pending.removeValue(forKey: id) else { return }
                let message = "Helper IPC \(label) timed out after \(timeout)s (request \(id))."
                self.lastIPCFailure = message
                waiter.resume(throwing: SidecarError.refused(message))
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
                "runtimeSelectionId": enrolment.runtimeSelectionId ?? "",
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
