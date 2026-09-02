import Foundation

/// What the workspace said went wrong, in words a person can act on.
///
/// The server already answers with a code and a sentence; the value of translating here is that
/// the app can say what to *do*, which the server has no way to know — it cannot tell that the
/// person is standing in front of a native window with a Back button.
public struct WorkspaceError: LocalizedError, Equatable, Sendable {
    public let code: String
    public let message: String
    public let status: Int
    /// What the person can do now. Empty when the message already says it.
    public let recovery: String

    public var errorDescription: String? { message }
    public var recoverySuggestion: String? { recovery.isEmpty ? nil : recovery }

    /// Every failure this app can show, decided from the answer alone so it can be tested
    /// without a server. The rule is the same one the Connector already follows: name the
    /// thing that actually stopped it, and say what to do about that specific thing.
    public static func from(status: Int, code: String?, message: String?) -> WorkspaceError {
        let code = code ?? ""
        let said = message ?? ""
        switch (status, code) {
        case (401, "sign_in_invalid"):
            return .init(code: code, message: "That sign-in link no longer works.", status: status,
                         recovery: "Links can be used once and expire after fifteen minutes. Request a new one.")
        case (401, _):
            return .init(code: code.isEmpty ? "unauthenticated" : code,
                         message: "Your sign-in has expired.", status: status,
                         recovery: "Sign in again to continue. Nothing you have set up is lost.")
        case (403, _):
            return .init(code: code.isEmpty ? "forbidden" : code,
                         message: said.isEmpty ? "This workspace is not yours to change." : said,
                         status: status, recovery: "Ask whoever owns this workspace to make the change.")
        case (404, "agent_not_found"):
            return .init(code: code, message: "That agent is no longer in this workspace.", status: status,
                         recovery: "Add the agent again, then connect this Mac to it.")
        case (409, "enrollment_room_required"):
            return .init(code: code, message: "This agent has no room to work in yet.", status: status,
                         recovery: "Create a room for it, then connect.")
        case (_, "enrollment_invalid"):
            return .init(code: code, message: "That code was not recognised.", status: status,
                         recovery: "It may have been used already, or expired. Ask your workspace for a new one.")
        default:
            return .init(code: code.isEmpty ? "unknown" : code,
                         message: said.isEmpty ? "The workspace could not complete that (\(status))." : said,
                         status: status, recovery: "")
        }
    }

    /// No answer at all. Distinct on purpose from anything the server said: there is nothing to
    /// interpret, and the remedy is about the network rather than about the workspace.
    public static func unreachable(_ address: String) -> WorkspaceError {
        .init(code: "unreachable", message: "Multiplayer AI could not be reached.", status: 0,
              recovery: "Check your connection. The app will keep everything you have set up and try again.")
    }

    /// The workspace accepted the sign-in and then nothing was kept.
    ///
    /// This has one cause in practice: the workspace marks its session cookie `Secure`, and it
    /// is being reached over plain HTTP, so nothing will store it. Without naming it, the app
    /// would accept a link, report success, and return the person to the sign-in screen with no
    /// explanation — the exact silence this product keeps having to remove.
    public static func sessionNotKept() -> WorkspaceError {
        .init(code: "session_not_kept",
              message: "The workspace signed you in but the session could not be kept.",
              status: 0,
              recovery: "This workspace is reached over an insecure connection and will only issue a session over a secure one. Whoever runs it can allow this by setting AUTH_COOKIE_SECURE=0, or by serving it over HTTPS.")
    }

    public static func malformed() -> WorkspaceError {
        .init(code: "malformed", message: "The workspace's answer was not understood.", status: 0,
              recovery: "Try again. If it keeps happening, the app and the workspace are different versions.")
    }
}

/// Building a request to the workspace. Pure, so every path, method, body and header the app
/// will ever send can be checked without a server listening.
public enum WorkspaceEndpoint {
    public static func request(base: URL, method: String, path: String,
                               body: [String: Any]? = nil,
                               idempotencyKey: String? = nil) throws -> URLRequest {
        // Percent-encoded ids only; a path is never interpolated from anything a person typed.
        guard let url = URL(string: path, relativeTo: base) else { throw WorkspaceError.malformed() }
        var request = URLRequest(url: url.absoluteURL)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "idempotency-key") }
        return request
    }
}

/// Who the person is, and what they can act in.
public struct Identity: Equatable, Sendable {
    public struct Company: Equatable, Sendable {
        public let companyId: String
        public let name: String
        public let principalId: String
        public init(companyId: String, name: String, principalId: String) {
            self.companyId = companyId; self.name = name; self.principalId = principalId
        }
    }
    public let userId: String
    public let email: String
    public let displayName: String
    public let companies: [Company]
    public init(userId: String, email: String, displayName: String, companies: [Company]) {
        self.userId = userId; self.email = email; self.displayName = displayName; self.companies = companies
    }

    /// Reading the server's answer, kept separate from fetching it so the shape can be tested.
    public static func decode(_ payload: [String: Any]) -> Identity? {
        guard let user = payload["user"] as? [String: Any],
              let id = user["id"] as? String,
              let email = user["email"] as? String else { return nil }
        let companies = (payload["companies"] as? [[String: Any]] ?? []).compactMap { row -> Company? in
            guard let companyId = row["company_id"] as? String,
                  let name = row["company_name"] as? String,
                  let principalId = row["principal_id"] as? String else { return nil }
            return Company(companyId: companyId, name: name, principalId: principalId)
        }
        return Identity(userId: id, email: email,
                        displayName: user["display_name"] as? String ?? email,
                        companies: companies)
    }
}

public struct WorkspaceRoom: Equatable, Sendable, Identifiable {
    public let roomId: String
    public let name: String
    public let projectId: String
    public let projectName: String
    public var id: String { roomId }
    public init(roomId: String, name: String, projectId: String, projectName: String) {
        self.roomId = roomId; self.name = name; self.projectId = projectId; self.projectName = projectName
    }
    public static func decode(_ row: [String: Any]) -> WorkspaceRoom? {
        guard let roomId = row["room_id"] as? String, let name = row["name"] as? String else { return nil }
        return WorkspaceRoom(roomId: roomId, name: name,
                             projectId: row["project_id"] as? String ?? "",
                             projectName: row["project_name"] as? String ?? name)
    }
}

/// Talking to Multiplayer AI as the signed-in person.
///
/// The session is an HttpOnly cookie the server sets, held in one shared jar that the embedded
/// workspace is later given a copy of — so the native screens and the product are the same
/// signed-in person, and neither has to know how the other authenticated.
public final class WorkspaceClient: @unchecked Sendable {
    public let base: URL
    private let session: URLSession

    public init(base: URL, session: URLSession? = nil) {
        self.base = base
        if let session { self.session = session; return }
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = HTTPCookieStorage.shared
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpShouldSetCookies = true
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: configuration)
    }

    @discardableResult
    private func send(_ method: String, _ path: String, body: [String: Any]? = nil,
                      idempotencyKey: String? = nil) async throws -> [String: Any] {
        let request = try WorkspaceEndpoint.request(base: base, method: method, path: path,
                                                    body: body, idempotencyKey: idempotencyKey)
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { throw WorkspaceError.unreachable(base.absoluteString) }
        guard let http = response as? HTTPURLResponse else { throw WorkspaceError.malformed() }
        let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(http.statusCode) else {
            let error = payload["error"] as? [String: Any]
            throw WorkspaceError.from(status: http.statusCode,
                                      code: error?["code"] as? String,
                                      message: error?["message"] as? String)
        }
        return payload
    }

    // ---------------------------------------------------------------- account

    public func signUp(name: String, email: String) async throws {
        try await send("POST", "/v1/auth/sign-up", body: ["name": name, "email": email])
    }

    public func requestSignInLink(email: String) async throws {
        try await send("POST", "/v1/auth/sign-in-links", body: ["email": email])
    }

    /// Redeem a single-use token. The session cookie arrives on this response and is what every
    /// later call — native and embedded — is authenticated by.
    public func redeem(token: String) async throws -> Identity {
        let payload = try await send("POST", "/v1/auth/sessions", body: ["token": token])
        guard let identity = Identity.decode(payload) else { throw WorkspaceError.malformed() }
        return identity
    }

    /// Nil rather than an error when nobody is signed in: that is an ordinary state on launch,
    /// not a failure worth showing anyone.
    public func currentIdentity() async throws -> Identity? {
        do {
            let payload = try await send("GET", "/v1/auth/me")
            return Identity.decode(payload)
        } catch let error as WorkspaceError where error.status == 401 {
            return nil
        }
    }

    public func signOut() async {
        _ = try? await send("DELETE", "/v1/auth/sessions/current")
    }

    // -------------------------------------------------------------- workspace

    public func createWorkspace(name: String) async throws -> Identity.Company {
        let payload = try await send("POST", "/v1/workspaces", body: ["name": name])
        guard let companyId = payload["company_id"] as? String,
              let principalId = payload["principal_id"] as? String else { throw WorkspaceError.malformed() }
        return .init(companyId: companyId, name: payload["name"] as? String ?? name, principalId: principalId)
    }

    public func rooms(companyId: String) async throws -> [WorkspaceRoom] {
        let payload = try await send("GET", "/v1/companies/\(companyId)/rooms")
        return (payload["rooms"] as? [[String: Any]] ?? []).compactMap(WorkspaceRoom.decode)
    }

    /// The agents the workspace knows, with what the Gateway has actually seen of each.
    public func agents(companyId: String) async throws -> [[String: Any]] {
        let payload = try await send("GET", "/v1/companies/\(companyId)/agents")
        return payload["agents"] as? [[String: Any]] ?? []
    }

    public func addAgent(companyId: String, name: String) async throws -> String {
        let payload = try await send("POST", "/v1/companies/\(companyId)/agents", body: ["name": name])
        guard let principalId = payload["principal_id"] as? String else { throw WorkspaceError.malformed() }
        return principalId
    }

    public func createProject(companyId: String, name: String, objective: String) async throws -> String {
        let payload = try await send("POST", "/v1/companies/\(companyId)/projects",
                                     body: ["name": name, "objective": objective])
        guard let id = payload["id"] as? String else { throw WorkspaceError.malformed() }
        return id
    }

    public func createRoom(companyId: String, projectId: String, name: String) async throws -> String {
        let payload = try await send("POST", "/v1/companies/\(companyId)/projects/\(projectId)/rooms",
                                     body: ["name": name])
        guard let id = payload["id"] as? String else { throw WorkspaceError.malformed() }
        return id
    }

    /// Put an agent in a room as a worker. The key is derived from what is being asked for, so
    /// pressing the button twice cannot produce two memberships.
    public func addRoomMember(companyId: String, roomId: String, principalId: String) async throws {
        try await send("POST", "/v1/companies/\(companyId)/rooms/\(roomId)/members",
                       body: ["principal_id": principalId, "role": "worker_agent", "responsibilities": ""],
                       idempotencyKey: "member-\(roomId)-\(principalId)")
    }

    // ---------------------------------------------------------------- binding

    /// This Mac's own credential, minted by the person who is already signed in here.
    ///
    /// This is what removes the enrollment code from the ordinary path. A code exists so that a
    /// Mac nobody is signed in on can still prove which agent it is; when the person setting the
    /// agent up is signed in on this very machine, there is nobody to carry a code between —
    /// so the app asks for the credential directly and writes it to the Keychain.
    public func mintCredential(companyId: String, agentPrincipalId: String, label: String) async throws -> String {
        let payload = try await send("POST", "/v1/companies/\(companyId)/agents/\(agentPrincipalId)/gateway-credentials",
                                     body: ["label": label])
        guard let token = payload["credential_token"] as? String else { throw WorkspaceError.malformed() }
        return token
    }

    /**
     * Tell the workspace which physical runtime this Mac is, and be told which agent that is.
     *
     * The answer is usually one it already knows: a runtime that has connected before keeps the
     * principal it had, whatever it is called and whatever room it works in now. That is the whole
     * point — enrolling one machine's Hermes three times produced three agents, two of them
     * duplicates with a digit on the end, because every enrollment was treated as a new agent. `createAsNew` is the deliberate exception, and it is
     * only ever set because a person asked for a second agent on the same machine.
     */
    public func connectRuntime(companyId: String, name: String, runtime: SidecarState.Runtime,
                               createAsNew: Bool = false) async throws -> ConnectedRuntime {
        guard let type = runtime.runtimeType, let externalId = runtime.externalRuntimeId,
              let installationId = runtime.connectorInstallationId, let endpoint = runtime.endpoint,
              runtime.probeStatus == "healthy" else { throw WorkspaceError.malformed() }
        var body: [String: Any] = [
            "name": name, "runtime_type": type, "external_runtime_id": externalId,
            "connector_installation_id": installationId, "endpoint": endpoint,
            "probe_status": "healthy", "create_as_new": createAsNew,
        ]
        if let version = runtime.version { body["runtime_version"] = version }
        let payload = try await send("POST", "/v1/companies/\(companyId)/runtime-connections", body: body)
        guard let principalId = payload["principal_id"] as? String else { throw WorkspaceError.malformed() }
        return ConnectedRuntime(principalId: principalId,
                                displayName: payload["display_name"] as? String ?? name,
                                reused: payload["reused"] as? Bool ?? false)
    }
}

/// What the workspace made of a runtime this Mac introduced.
public struct ConnectedRuntime: Equatable, Sendable {
    public let principalId: String
    public let displayName: String
    /// True when the workspace recognised this runtime and handed back the agent it already was.
    public let reused: Bool
    public init(principalId: String, displayName: String, reused: Bool) {
        self.principalId = principalId; self.displayName = displayName; self.reused = reused
    }
}

/// A room this Mac's agent is a worker in.
public struct AgentRoom: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}
