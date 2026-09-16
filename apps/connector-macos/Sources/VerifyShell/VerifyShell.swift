import Foundation
import AppKit
import WebKit
import ConnectorUI

/// Walks the unified app through a real first run against a real workspace.
///
/// Every step below drives the shipping `AppModel` — the same code the window drives — so what
/// this proves is the product's own path, not a re-implementation of it. It exists because the
/// journey it checks crosses four things no unit test can reach at once: a live API, the
/// Keychain, a spawned helper that talks to the Gateway, and a web view that has to arrive
/// already signed in.
///
/// Run through `scripts/verify-shell.sh`, which wraps it in a bundle of its own so it can never
/// touch the credential belonging to the app someone is actually using.

@MainActor
enum Report {
    static var failures: [String] = []
    static var checks = 0

    static func check(_ passed: Bool, _ description: String, _ detail: String = "") {
        checks += 1
        let suffix = detail.isEmpty ? "" : " — \(detail)"
        print("  \(passed ? "✓" : "✗") \(description)\(suffix)")
        if !passed { failures.append(description) }
    }
}

@MainActor func check(_ passed: Bool, _ description: String, _ detail: String = "") {
    Report.check(passed, description, detail)
}
func section(_ title: String) { print("\n\(title)") }

@MainActor
func run(workspaceURL: String, signInToken: String) async {
    var start = Progress()
    start.workspaceAddress = workspaceURL
    let store = MemoryProgressStore(start)
    let app = AppModel(store: store)

    /* A first launch means no session either. The cookie jar outlives the process, so without
       this a second run would arrive already signed in — and be asked for an agent rather than
       for an account, which is right for a Mac in that state and wrong for this test. */
    if let base = URL(string: workspaceURL) {
        for cookie in HTTPCookieStorage.shared.cookies(for: base) ?? [] {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
    }

    // ------------------------------------------------------------------ launch
    section("Launch")
    await app.refresh()
    check(app.step == .welcome, "a Mac that has never been set up opens on the front door",
          "step = \(app.step.rawValue)")

    // ------------------------------------------------------------------- setup
    section("Automatic setup")
    await app.beginSetup()
    for task in SetupTask.allCases {
        let outcome = app.setup[task]
        if case .done(let detail) = outcome {
            check(true, task.title, detail)
        } else {
            check(false, task.title, String(describing: outcome))
        }
    }
    check(app.setup.succeeded, "setup finished with nothing outstanding")

    // ---------------------------------------------------------------- detection
    section("Detecting the local agent")
    let runtime = app.connector.sidecar.state.runtime
    check(runtime.available, "Hermes was found on this Mac", "\(runtime.name) \(runtime.version ?? "—")")
    check(runtime.path?.isEmpty == false, "its location was resolved", runtime.path ?? "")

    check(app.step == .account, "setup hands over to signing in", "step = \(app.step.rawValue)")

    // ----------------------------------------------------------------- sign in
    section("Signing in")
    await app.redeem(signInToken)
    check(app.problem == nil, "the sign-in link was accepted", app.problem?.message ?? "")
    check(app.identity != nil, "the app knows who is signed in", app.identity?.email ?? "")
    guard app.identity != nil else {
        /* Nothing after this can mean anything without a signed-in person, and a harness that
           carries on regardless reports a pile of failures that all have one cause. It stops
           here and says what that cause is. */
        if let problem = app.problem {
            print("\n  what happened: \(problem.message)")
            print("  what to do:    \(problem.recovery)")
        }
        finish()
    }
    check(app.step == .workspace, "a new account is asked to name a workspace",
          "step = \(app.step.rawValue)")

    // --------------------------------------------------------------- workspace
    section("Creating a workspace")
    let workspaceName = "Verify \(Int(Date().timeIntervalSince1970))"
    await app.createWorkspace(name: workspaceName)
    check(app.problem == nil, "the workspace was created", app.problem?.message ?? "")
    check(app.company?.name == workspaceName, "it is the workspace the app is now acting in",
          app.company?.name ?? "none")
    check(app.step == .agent, "the next thing asked for is the agent", "step = \(app.step.rawValue)")

    // ------------------------------------------------------------------- agent
    section("Registering the agent this Mac runs")
    await app.registerAgent(name: "Research agent")
    check(app.problem == nil, "the agent was given an identity", app.problem?.message ?? "")
    check(app.progress.agentPrincipalId != nil, "and the app remembers it belongs to this Mac")
    check(app.step == .room, "the next thing asked for is the room", "step = \(app.step.rawValue)")

    // -------------------------------------------------------------------- room
    section("Creating the room, and binding without a code")
    await app.createRoom(name: "Developer API", objective: "Launch the public developer API")
    check(app.problem == nil, "the room was created and the agent joined it", app.problem?.message ?? "")
    check(app.progress.roomId != nil, "the app remembers which room this Mac works in")

    // Binding happens on the back of room creation, with nothing asked of anyone.
    check(app.connector.enrolment != nil, "this Mac was bound to the agent with no enrollment code")
    check(Keychain.credential() != nil, "its credential is in the Keychain")
    check(app.connector.enrolment?.roomId == app.progress.roomId, "bound to the room just created")
    check(app.step == .ready, "onboarding is over", "step = \(app.step.rawValue)")

    // ------------------------------------------------------------- going live
    section("The agent appearing in the workspace")
    var gateway = app.connector.sidecar.state.gateway
    for _ in 0..<40 where gateway != "live" {
        try? await Task.sleep(for: .milliseconds(500))
        await app.connector.sidecar.refresh()
        gateway = app.connector.sidecar.state.gateway
    }
    check(gateway == "live", "the helper opened a session with the workspace", "gateway = \(gateway)")
    check(app.connector.health == .connected, "and the app says so in one word",
          app.connector.health.title)

    // The workspace's own account of it, which is the only one that counts.
    if let company = app.company {
        let agents = (try? await app.client.agents(companyId: company.companyId)) ?? []
        let mine = agents.first { $0["principal_id"] as? String == app.progress.agentPrincipalId }
        let connector = mine?["connector"] as? [String: Any]
        check(connector?["enrolled"] as? Bool == true, "the workspace has a credential for this agent")
        check(connector?["presence"] as? String == "connected",
              "the workspace sees the agent connected", connector?["presence"] as? String ?? "none")
    }

    // ------------------------------------------------------- the product itself
    section("Opening the real workspace inside the app")
    let entry = app.entryURL
    check(entry.path.hasPrefix("/rooms/") || entry.path == "/home",
          "the app opens into the product", entry.path)

    let base = URL(string: app.workspaceAddress)!
    let jar = HTTPCookieStorage.shared.cookies ?? []
    let crossing = WebSession.cookies(for: base, from: jar)
    check(WebSession.hasSession(for: base, from: jar),
          "the signed-in session is available to hand to the web view",
          "\(crossing.count) cookie(s)")

    let webView = WKWebView(frame: .init(x: 0, y: 0, width: 1200, height: 800))
    for cookie in crossing { await webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) }
    webView.load(URLRequest(url: entry))

    var text = ""
    var title = ""
    for _ in 0..<60 {
        try? await Task.sleep(for: .milliseconds(500))
        if webView.isLoading { continue }
        text = ((try? await webView.evaluateJavaScript("document.body.innerText")) as? String) ?? ""
        title = ((try? await webView.evaluateJavaScript("document.title")) as? String) ?? ""
        if !text.isEmpty { break }
    }

    check(!text.isEmpty, "the workspace rendered in the web view", "title = \(title)")
    // The product's own signed-out screens say these; arriving at one would mean the session
    // did not cross and the app is two applications again.
    let signedOut = text.contains("Create account") || text.contains("A room where your agents work together")
    check(!signedOut, "it arrived signed in, not at a sign-in screen")
    check(text.contains(workspaceName) || text.contains("Developer API"),
          "and it is this person's own workspace",
          String(text.prefix(90)).replacingOccurrences(of: "\n", with: " · "))

    // ------------------------------------------------- binding a second agent
    /* Binding again without signing out first is where a Mac keeps durable state from the last
       binding. That state names an agent and a room; adopting it would put the new agent into
       the old agent's room with every indicator reading normally. */
    section("Binding this Mac to a different agent")
    await app.registerAgent(name: "Second agent")
    await app.createRoom(name: "Second room", objective: "Prove the second binding connects")
    check(app.problem == nil, "the second agent was registered and given a room", app.problem?.message ?? "")

    var secondGateway = app.connector.sidecar.state.gateway
    for _ in 0..<40 where secondGateway != "live" {
        try? await Task.sleep(for: .milliseconds(500))
        await app.connector.sidecar.refresh()
        secondGateway = app.connector.sidecar.state.gateway
    }
    if let company = app.company {
        let agents = (try? await app.client.agents(companyId: company.companyId)) ?? []
        let second = agents.first { $0["principal_id"] as? String == app.progress.agentPrincipalId }
        let connector = second?["connector"] as? [String: Any]
        check(connector?["presence"] as? String == "connected",
              "the workspace sees the second agent connected, not the first",
              connector?["presence"] as? String ?? "none")
        let rooms = (second?["rooms"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
        check(rooms.contains("Second room"), "and in its own room", rooms.joined(separator: ", "))
    }

    // --------------------------------------------------------------- returning
    section("Quitting and coming back")
    let roomPath = zip([app.company?.companyId], [app.progress.roomId])
        .compactMap { company, room -> String? in
            guard let company, let room else { return nil }
            return "/rooms/\(company)/\(room)"
        }.first
    if let roomPath { app.remember(path: roomPath) }
    let returning = AppModel(store: store)
    await returning.refresh()
    check(returning.step == .ready, "a returning launch goes straight to the product, not onboarding",
          "step = \(returning.step.rawValue)")
    check(returning.entryURL.path == "/home",
          "and opens Home rather than whichever room was last open", "\(returning.entryURL.path), last room \(roomPath ?? "none")")

    // ------------------------------------------------------------------- tidy
    // The credential is this bundle's own; leaving it behind would leave a live session
    // against the workspace for a Mac nobody is using.
    await app.connector.signOut()
    check(Keychain.credential() == nil, "signing this Mac out removes its credential")

    finish()
}

@MainActor
func finish() -> Never {
    let failed = Report.failures
    print("\n\(failed.isEmpty ? "✓" : "✗") \(Report.checks - failed.count)/\(Report.checks) checks passed")
    for failure in failed { print("  failed: \(failure)") }
    exit(failed.isEmpty ? 0 : 1)
}

@main
enum VerifyShell {
    static func main() {
        let arguments = CommandLine.arguments
        guard arguments.count >= 3 else {
            print("usage: verify-shell <workspace-url> <sign-in-token>")
            exit(2)
        }
        // A web view needs a running main loop, so the work is driven from inside one.
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        Task { @MainActor in await run(workspaceURL: arguments[1], signInToken: arguments[2]) }
        application.run()
    }
}
