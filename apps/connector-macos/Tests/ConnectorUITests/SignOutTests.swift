import Testing
import Foundation
@testable import ConnectorUI

/**
 * Signing out, and what the next screen says about it.
 *
 * The physical failure: signing out opened on "Create your account", which reads as though the
 * account had been deleted. The workspace here answers over a stubbed transport; nothing reaches a
 * network, and every name is a fixture.
 */
@Suite(.serialized) @MainActor struct SignOutTests {
    /// Signed in until the session is deleted, and signed out afterwards — as the server behaves.
    final class Workspace: URLProtocol, @unchecked Sendable {
        nonisolated(unsafe) static var signedIn = true
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func stopLoading() {}
        override func startLoading() {
            let path = request.url?.path ?? ""
            var status = 200
            var body: [String: Any] = [:]
            if path == "/v1/auth/sessions/current", request.httpMethod == "DELETE" {
                Workspace.signedIn = false; body = ["status": "revoked"]
            } else if path == "/v1/auth/me" {
                if Workspace.signedIn {
                    body = ["user": ["id": "fixture-user", "email": "fixture@example.test", "display_name": "Fixture Person"],
                            "companies": [["company_id": "00000000-0000-4000-8000-0000000000c1", "company_name": "Fixture Workspace",
                                           "principal_id": "fixture-principal", "display_name": "Fixture Person"]]]
                } else { status = 401; body = ["error": ["code": "unauthenticated", "message": "Sign in to continue"]] }
            } else if path.hasSuffix("/rooms") { body = ["rooms": []]
            } else if path.hasSuffix("/agents") { body = ["agents": []] }
            let data = try! JSONSerialization.data(withJSONObject: body)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    private func transport() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Workspace.self]
        return URLSession(configuration: configuration)
    }

    @Test func signingOutLeadsToSignInAndSaysNothingWasLost() async {
        Workspace.signedIn = true
        var progress = Progress()
        progress.setupComplete = true
        progress.workspaceAddress = "http://workspace.fixture"
        let app = AppModel(store: MemoryProgressStore(progress), connector: ConnectorModel(live: false), transport: transport())

        await app.refresh()
        #expect(app.identity != nil)
        #expect(app.progress.hasSignedIn == true)          // remembered the moment an account is seen

        await app.signOutOfAccount()
        #expect(app.identity == nil)
        #expect(app.step == .account)
        // The account screen that follows opens on Sign in, and says the account is untouched.
        #expect(app.justSignedOut)
        #expect(!AccountScreen.opensCreating(knowsAnAccount: app.progress.knowsAnAccount))
        // Signing out forgets the session, never that this person has an account, or which one.
        #expect(app.progress.hasSignedIn == true)
        #expect(app.progress.companyId == "00000000-0000-4000-8000-0000000000c1")

        // Signing back in clears the notice, and lands in the same workspace.
        Workspace.signedIn = true
        await app.refresh()
        #expect(!app.justSignedOut)
        #expect(app.company?.companyId == "00000000-0000-4000-8000-0000000000c1")
    }
}
