import Testing
import Foundation
@testable import ConnectorUI

/// The requests the app sends, checked without a server. Every one of these is a path a person
/// walks through during their first five minutes, so a typo in one is a broken first run.
@Suite struct WorkspaceEndpointTests {
    private let base = URL(string: "http://127.0.0.1:4100")!

    @Test func aPathIsResolvedAgainstTheWorkspace() throws {
        let request = try WorkspaceEndpoint.request(base: base, method: "GET", path: "/v1/auth/me")
        #expect(request.url?.absoluteString == "http://127.0.0.1:4100/v1/auth/me")
        #expect(request.httpMethod == "GET")
        #expect(request.value(forHTTPHeaderField: "content-type") == nil)
    }

    @Test func aBodyIsSentAsJSON() throws {
        let request = try WorkspaceEndpoint.request(base: base, method: "POST", path: "/v1/workspaces",
                                                    body: ["name": "Acme"])
        #expect(request.value(forHTTPHeaderField: "content-type") == "application/json")
        let decoded = try JSONSerialization.jsonObject(with: #require(request.httpBody)) as? [String: String]
        #expect(decoded == ["name": "Acme"])
    }

    /// Room membership is the one call a person can cause twice by pressing a button twice, so
    /// it carries a key derived from what is being asked for rather than a fresh one each time.
    @Test func membershipCarriesAStableIdempotencyKey() throws {
        let first = try WorkspaceEndpoint.request(base: base, method: "POST", path: "/x",
                                                  body: [:], idempotencyKey: "member-room-agent")
        let second = try WorkspaceEndpoint.request(base: base, method: "POST", path: "/x",
                                                   body: [:], idempotencyKey: "member-room-agent")
        #expect(first.value(forHTTPHeaderField: "idempotency-key") == second.value(forHTTPHeaderField: "idempotency-key"))
    }

    @Test func aWorkspaceOnAPortKeepsIt() throws {
        let request = try WorkspaceEndpoint.request(base: URL(string: "http://192.168.1.20:4100")!,
                                                    method: "GET", path: "/v1/companies/abc/rooms")
        #expect(request.url?.absoluteString == "http://192.168.1.20:4100/v1/companies/abc/rooms")
    }
}

@Suite struct WorkspaceErrorTests {
    /// Every error a person can hit has to answer both questions. A message with no recovery is
    /// the failure mode this product keeps having, so it is asserted rather than hoped for.
    @Test func namedFailuresSayWhatToDo() {
        let cases: [(Int, String)] = [
            (401, "sign_in_invalid"), (401, "unauthenticated"), (403, "forbidden"),
            (404, "agent_not_found"), (409, "enrollment_room_required"), (401, "enrollment_invalid"),
        ]
        for (status, code) in cases {
            let error = WorkspaceError.from(status: status, code: code, message: nil)
            #expect(!error.message.isEmpty, "\(code) must say what happened")
            #expect(!error.recovery.isEmpty, "\(code) must say what to do now")
        }
    }

    @Test func anExpiredLinkIsNotTheSameAsAnExpiredSession() {
        let link = WorkspaceError.from(status: 401, code: "sign_in_invalid", message: nil)
        let session = WorkspaceError.from(status: 401, code: "unauthenticated", message: nil)
        #expect(link.message != session.message)
        #expect(session.recovery.contains("Nothing you have set up is lost"))
    }

    @Test func anUnreachableWorkspaceIsAboutTheNetworkNotTheAccount() {
        let error = WorkspaceError.unreachable("http://127.0.0.1:4100")
        #expect(error.status == 0)
        #expect(error.recovery.contains("connection"))
        // Never suggests signing in again: the session is fine, the network is not.
        #expect(!error.recovery.contains("Sign in"))
    }

    @Test func anUnrecognisedFailureStillCarriesWhatTheServerSaid() {
        let error = WorkspaceError.from(status: 500, code: "internal_error", message: "Internal server error")
        #expect(error.message == "Internal server error")
    }
}

@Suite struct IdentityDecodingTests {
    @Test func anAccountWithNoWorkspaceDecodes() {
        let identity = Identity.decode([
            "user": ["id": "u1", "email": "a@b.c", "display_name": "Ada"],
            "companies": [],
        ])
        #expect(identity?.displayName == "Ada")
        #expect(identity?.companies.isEmpty == true)
    }

    @Test func aWorkspaceCarriesThePrincipalThatActsInIt() {
        let identity = Identity.decode([
            "user": ["id": "u1", "email": "a@b.c", "display_name": "Ada"],
            "companies": [["company_id": "c1", "company_name": "Acme", "principal_id": "p1"]],
        ])
        #expect(identity?.companies.first?.companyId == "c1")
        #expect(identity?.companies.first?.principalId == "p1")
    }

    @Test func anAnswerMissingTheUserIsRefused() {
        #expect(Identity.decode(["companies": []]) == nil)
    }
}

@Suite struct SignInTokenTests {
    /// The three ways a token can arrive, all of which have to work: a link the app was opened
    /// by, a link out of an email, and the token pasted on its own.
    @Test func aTokenIsFoundInWhateverWasHandedOver() {
        #expect(AppModel.token(from: "mpsi_abc123") == "mpsi_abc123")
        #expect(AppModel.token(from: "multiplayerai://auth?token=mpsi_abc123") == "mpsi_abc123")
        #expect(AppModel.token(from: "https://app.example.com/signin?token=mpsi_abc123") == "mpsi_abc123")
        #expect(AppModel.token(from: "  mpsi_abc123  ") == "mpsi_abc123")
    }

    @Test func aLinkWithNoTokenIsNotMistakenForOne() {
        #expect(AppModel.token(from: "https://app.example.com/signin") == "https://app.example.com/signin")
    }
}

/// Being signed in and holding a session are two different things.
///
/// A workspace that marks its session cookie `Secure` and is reached over plain HTTP will accept
/// a sign-in link and hand back an identity that nothing can keep. Reported as an ordinary
/// failure it looks like a link that did not work; named, it points at the one setting that is
/// actually wrong.
@Suite struct SessionNotKeptTests {
    @Test func itIsNotMistakenForAnExpiredLink() {
        let notKept = WorkspaceError.sessionNotKept()
        let expired = WorkspaceError.from(status: 401, code: "sign_in_invalid", message: nil)
        #expect(notKept.message != expired.message)
        #expect(notKept.code == "session_not_kept")
    }

    @Test func itNamesTheSettingThatWouldFixIt() {
        let error = WorkspaceError.sessionNotKept()
        #expect(error.recovery.contains("AUTH_COOKIE_SECURE=0"))
        #expect(error.recovery.contains("HTTPS"))
    }
}

/// The link out of an email keeps its token in the fragment, so the app has to read both halves.
@Suite struct EmailedLinkTests {
    private let token = "mpsi_ThIsIsNotARealToken-0123456789"

    @Test func aFragmentCarriedLinkIsUnderstood() {
        #expect(AppModel.token(from: "https://app.example.com/signin#token=\(token)") == token)
    }

    @Test func theSchemeTheAppIsOpenedByStillWorks() {
        #expect(AppModel.token(from: "multiplayerai://auth?token=\(token)") == token)
    }

    @Test func aPercentEncodedTokenIsDecodedOnce() {
        #expect(AppModel.token(from: "https://app.example.com/signin#token=a%2Bb%2Fc%3Dd") == "a+b/c=d")
    }

    @Test func aBareTokenIsStillAToken() {
        #expect(AppModel.token(from: "  \(token)  ") == token)
    }

    /// A link with no token must not be mistaken for one, or the app would spend a request
    /// redeeming a URL and report an expired link.
    @Test func aLinkWithoutATokenIsNotOne() {
        #expect(AppModel.token(from: "https://app.example.com/signin") == "https://app.example.com/signin")
        #expect(AppModel.token(from: "https://app.example.com/signin#other=1") == "https://app.example.com/signin#other=1")
    }
}

/// The first screen a new person sees, and the route it takes.
///
/// This opened on Sign in. A brand-new address sent to the sign-in route is answered
/// `{"status":"accepted"}` and nothing is sent — the server will not admit an address has no
/// account, deliberately — so a clean install said "Check your email" about an email that was
/// never going to exist, and no log line anywhere recorded it. The default is the whole bug, and
/// it was invisible because it lived in view state that nothing asserted.
@Suite struct FirstRunAccountTests {
    @Test func aFreshlyInstalledAppOpensOnCreatingAnAccount() {
        #expect(AccountScreen.opensCreating(knowsAnAccount: Progress().knowsAnAccount),
                "first run must offer to create an account, not to sign in")
    }

    /// The physical failure: signing out opened on "Create your account", which reads as though
    /// the account had gone. A Mac that has had anybody signed in is shown Sign in afterwards.
    @Test func aMacThatHasBeenSignedInOpensOnSignIn() {
        var signedInBefore = Progress(); signedInBefore.hasSignedIn = true
        #expect(!AccountScreen.opensCreating(knowsAnAccount: signedInBefore.knowsAnAccount))
        // An install from before the record existed, which already names a workspace, counts too.
        var older = Progress(); older.companyId = "00000000-0000-4000-8000-0000000000c1"
        #expect(!AccountScreen.opensCreating(knowsAnAccount: older.knowsAnAccount))
    }

    /// Progress saved by an older build has no `hasSignedIn` and must still load, or everybody's
    /// saved setup would be lost on upgrade.
    @Test func progressSavedBeforeTheRecordExistedStillLoads() throws {
        let old = #"{"setupComplete":true,"companyId":"00000000-0000-4000-8000-0000000000c1","workspaceAddress":"https://workspace.example"}"#
        let decoded = try JSONDecoder().decode(Progress.self, from: Data(old.utf8))
        #expect(decoded.setupComplete)
        #expect(decoded.hasSignedIn == nil)
        #expect(decoded.knowsAnAccount)
    }

    /// Only methods both sides support are offered, most preferred first, and the emailed link is
    /// never missing: a passkey arrives by being listed, not by a client guessing.
    @Test func signInMethodsAreWhatBothSidesSupportWithTheLinkAsFallback() {
        #expect(AppModel.offered(["email_link"]) == ["email_link"])
        #expect(AppModel.offered(["passkey", "email_link"]) == ["email_link"])   // this build has no passkey yet
        #expect(AppModel.offered(nil) == ["email_link"])
        #expect(AppModel.offered(["something_new"]) == ["email_link"])
    }

    /// The two routes are not interchangeable: only one of them can make an account exist.
    @Test func theTwoRoutesAreDifferentEndpoints() throws {
        let base = URL(string: "https://workspace.example")!
        let signUp = try WorkspaceEndpoint.request(base: base, method: "POST", path: "/v1/auth/sign-up",
                                                   body: ["name": "A", "email": "a@b.c"])
        let signIn = try WorkspaceEndpoint.request(base: base, method: "POST", path: "/v1/auth/sign-in-links",
                                                   body: ["email": "a@b.c"])
        #expect(signUp.url?.path == "/v1/auth/sign-up")
        #expect(signIn.url?.path == "/v1/auth/sign-in-links")
        #expect(signUp.url != signIn.url)
    }
}
