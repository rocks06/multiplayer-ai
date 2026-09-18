import Testing
import Foundation
@testable import ConnectorUI

/// Native notifications: shown once, only when allowed, never over the room already on screen, and
/// opening exactly the room, message or decision they are about. Ids are fixtures.
@Suite @MainActor struct RoomNotifierTests {
    final class RecordingPoster: NotificationPosting {
        var allowed = true
        var status = "not determined"
        var requests = 0
        var posted: [RoomNotification] = []
        func permissionStatus() async -> String { status }
        func requestPermission() async -> Bool {
            requests += 1
            if status == "not determined" { status = allowed ? "authorized" : "denied" }
            return allowed
        }
        var refusal: String?
        var tests = 0
        let trace = NotificationTrace()
        func post(_ notification: RoomNotification) async -> NotificationDelivery {
            if let refusal { return .refused(refusal) }
            posted.append(notification); return .accepted("fixture")
        }
        func sendTest() async -> NotificationDelivery { tests += 1; trace.test = "Sent"; return .accepted("fixture") }
    }

    /// The server renames what it calls things; an installed app must not care. A build shipped
    /// before "addressed" existed still shows the banner, because only the category drives it.
    @Test func aNotificationKindThisBuildHasNeverSeenStillReaches() async {
        let poster = RecordingPoster(); poster.status = "authorized"
        let addressed = RoomNotification(id: "n1", kind: "addressed", category: "mention",
                                         companyId: Self.company, roomId: Self.room, roomName: "Fixture Room",
                                         title: "Fixture Colleague addressed you", body: "The contract is attached",
                                         link: Self.note("n1").link)
        let notifier = RoomNotifier(fetch: { _ in NotificationPage(cursor: "c1", notifications: [addressed]) },
                                    poster: poster, memory: MemoryNotifierMemory(), visibleRoom: { nil })
        let shown = await notifier.poll()
        #expect(shown.map(\.id) == ["n1"])
        #expect(poster.posted.first?.title == "Fixture Colleague addressed you")
    }

    @Test func aNotificationMacOSRefusesIsNotReportedAsShown() async {
        let poster = RecordingPoster(); poster.status = "authorized"
        poster.refusal = "macOS refused it: Notifications are not allowed for this application (UNErrorDomain 1)"
        let notifier = RoomNotifier(fetch: { _ in NotificationPage(cursor: "c1", notifications: [Self.note("n1")]) },
                                    poster: poster, memory: MemoryNotifierMemory(), visibleRoom: { nil })
        let shown = await notifier.poll()
        #expect(shown.isEmpty)
        #expect(notifier.diagnostics.lastShown == "—")
        #expect(notifier.diagnostics.lastSuppressed.contains("macOS did not show it"))
        #expect(notifier.diagnostics.lastSuppressed.contains("UNErrorDomain 1"))
    }

    @Test func permissionWithBannersSetToNoneIsCalledOutAsTheReasonNothingAppears() {
        let none = NotificationTrace.describe(authorization: .authorized, alert: .enabled, style: .none, sound: .enabled, notificationCenter: .enabled)
        #expect(none.summary.contains("allowed"))
        #expect(none.summary.contains("style none"))
        #expect(none.blocker?.contains("Banners are off") == true)
        let off = NotificationTrace.describe(authorization: .authorized, alert: .disabled, style: .banner, sound: .enabled, notificationCenter: .enabled)
        #expect(off.blocker?.contains("Banners are off") == true)
        let denied = NotificationTrace.describe(authorization: .denied, alert: .disabled, style: .none, sound: .disabled, notificationCenter: .disabled)
        #expect(denied.blocker?.contains("Allow Notifications") == true)
        let working = NotificationTrace.describe(authorization: .authorized, alert: .enabled, style: .banner, sound: .enabled, notificationCenter: .enabled)
        #expect(working.blocker == nil)
        #expect(working.summary == "allowed · style banners · sound on · Notification Center on")
        #expect(NotificationTrace.describe(NSError(domain: "UNErrorDomain", code: 1, userInfo: [NSLocalizedDescriptionKey: "Not allowed"])) == "Not allowed (UNErrorDomain 1)")
    }

    @Test func diagnosticsCanSendATestNotificationBeforeAnyoneSignsIn() async {
        let connector = ConnectorModel(live: false)
        let app = AppModel(store: MemoryProgressStore(Progress()), connector: connector)
        let poster = RecordingPoster()
        app.enableNotifications(poster: poster)
        #expect(app.notifier == nil)
        #expect(connector.notificationTrace === poster.trace)
        await connector.sendTestNotification?()
        #expect(poster.tests == 1)
        #expect(poster.trace.rows.contains { $0.0 == "Test notification" && $0.1 == "Sent" })
        #expect(poster.posted.isEmpty)
    }

    static let company = "00000000-0000-4000-8000-0000000000c1"
    static let room = "00000000-0000-4000-8000-0000000000r1".replacingOccurrences(of: "r", with: "a")
    static let message = "00000000-0000-4000-8000-0000000000e1"

    static func note(_ id: String, room: String = room, focus: String = "message:\(message)") -> RoomNotification {
        RoomNotification(id: id, kind: "mention", category: "mention", companyId: company, roomId: room,
                         roomName: "Fixture Room", title: "Fixture Agent mentioned you", body: "Please review",
                         link: "multiplayerai://room?company=\(company)&room=\(room)&focus=\(focus.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)")
    }

    @Test func eachNotificationIsShownOnceAcrossReplayAndRelaunch() async {
        let poster = RecordingPoster(), memory = MemoryNotifierMemory()
        var pages = [NotificationPage(cursor: "c1", notifications: [Self.note("n1")]),
                     // The same notification read back again — a reconnect, an overlapping poll.
                     NotificationPage(cursor: "c2", notifications: [Self.note("n1"), Self.note("n2")])]
        let notifier = RoomNotifier(fetch: { _ in pages.removeFirst() }, poster: poster, memory: memory, visibleRoom: { nil })
        await notifier.poll()
        await notifier.poll()
        #expect(poster.posted.map(\.id) == ["n1", "n2"])
        #expect(memory.cursor == "c2")
        // A relaunch remembers what it showed.
        let relaunched = RoomNotifier(fetch: { after in
            #expect(after == "c2")
            return NotificationPage(cursor: "c3", notifications: [Self.note("n2")])
        }, poster: poster, memory: memory, visibleRoom: { nil })
        await relaunched.poll()
        #expect(poster.posted.map(\.id) == ["n1", "n2"])
    }

    @Test func nothingIsShownOverTheRoomAlreadyOnScreen() async {
        let poster = RecordingPoster(), memory = MemoryNotifierMemory()
        let other = "00000000-0000-4000-8000-0000000000a2"
        var visible: (company: String, room: String)? = (Self.company, Self.room)
        let notifier = RoomNotifier(fetch: { _ in NotificationPage(cursor: "c", notifications: [Self.note("here"), Self.note("elsewhere", room: other)]) },
                                    poster: poster, memory: memory, visibleRoom: { visible })
        await notifier.poll()
        #expect(poster.posted.map(\.id) == ["elsewhere"])
        // Suppressed is still seen: switching away later does not bring it back.
        visible = nil
        await notifier.poll()
        #expect(poster.posted.map(\.id) == ["elsewhere"])
        #expect(AppModel.visibleRoom(path: "/rooms/\(Self.company)/\(Self.room)#message-\(Self.message)", appActive: true)! == (Self.company, Self.room))
        #expect(AppModel.visibleRoom(path: "/rooms/\(Self.company)/\(Self.room)", appActive: false) == nil)
        #expect(AppModel.visibleRoom(path: "/home", appActive: true) == nil)
    }

    @Test func nothingIsShownWithoutPermission() async {
        let poster = RecordingPoster(); poster.allowed = false
        let notifier = RoomNotifier(fetch: { _ in NotificationPage(cursor: "c", notifications: [Self.note("n1")]) },
                                    poster: poster, memory: MemoryNotifierMemory(), visibleRoom: { nil })
        #expect(await notifier.poll().isEmpty)
        #expect(poster.posted.isEmpty)
    }

    @Test func aNotificationOpensTheRoomAndTheThingItIsAbout() async {
        let link = Self.note("n1").link
        #expect(AppModel.sharedRoomLink(link)! == (Self.company, Self.room))
        #expect(AppModel.roomLinkFragment(link) == "#message-\(Self.message)")
        let decision = "00000000-0000-4000-8000-0000000000d1"
        #expect(AppModel.roomLinkFragment(Self.note("n2", focus: "decision:\(decision)").link) == "#decision-\(decision)")
        // Anything that is not one of those shapes just opens the room.
        #expect(AppModel.roomLinkFragment(Self.note("n3", focus: "script:alert(1)").link) == nil)
        #expect(AppModel.roomLinkFragment(Self.note("n4", focus: "message:../../etc").link) == nil)

        var progress = Progress(); progress.setupComplete = true; progress.workspaceAddress = "https://workspace.test"
        let app = AppModel(store: MemoryProgressStore(progress), connector: ConnectorModel(live: false))
        await app.receive(authURL: link)
        // Before the app has looked at the world the link waits; it is then spent, and lands there.
        #expect(app.queuedAuthURL == link || app.entryURL.absoluteString.hasSuffix("/rooms/\(Self.company)/\(Self.room)#message-\(Self.message)"))
        await app.openSharedRoom(company: Self.company, room: Self.room, fragment: AppModel.roomLinkFragment(link))
        #expect(app.entryURL.absoluteString == "https://workspace.test/rooms/\(Self.company)/\(Self.room)#message-\(Self.message)")
    }

    /// The Air never showed a prompt: permission was only asked for once a qualifying event arrived.
    @Test func permissionIsAskedForWhenNotificationsStartNotOnTheFirstEvent() async throws {
        let poster = RecordingPoster()
        let notifier = RoomNotifier(fetch: { _ in NotificationPage(cursor: "c", notifications: []) },
                                    poster: poster, memory: MemoryNotifierMemory(), visibleRoom: { nil })
        notifier.start(every: .seconds(60))
        for _ in 0..<50 where poster.requests == 0 { try await Task.sleep(for: .milliseconds(10)) }
        notifier.stop()
        #expect(poster.requests >= 1)
        #expect(notifier.diagnostics.permission == "authorized")
        #expect(notifier.diagnostics.polling == "Stopped (signed out)")
    }

    @Test func diagnosticsSayWhatWasReceivedShownAndSuppressedAndWhyTheFeedFailed() async {
        let poster = RecordingPoster()
        var fail = true
        let notifier = RoomNotifier(fetch: { _ in
            if fail { throw WorkspaceError(code: "notifications_unavailable", message: "The workspace server does not provide notifications yet.", status: 404, recovery: "") }
            return NotificationPage(cursor: "eyJhdCI6IjIwMjYtMDEtMDFUMDA6MDA6MDAuMDAwWiIsImlkIjoieCJ9",
                                    notifications: [Self.note("shown"), Self.note("hidden", room: "00000000-0000-4000-8000-0000000000b9")])
        }, poster: poster, memory: MemoryNotifierMemory(), visibleRoom: { (Self.company, "00000000-0000-4000-8000-0000000000b9") })
        await notifier.poll()
        #expect(notifier.diagnostics.feed.contains("does not provide notifications"))
        #expect(notifier.diagnostics.cursor == "Not started")
        fail = false
        await notifier.poll()
        #expect(notifier.diagnostics.feed == "OK · 2 new")
        #expect(notifier.diagnostics.lastShown.hasPrefix("Fixture Agent mentioned you · Fixture Room"))
        #expect(notifier.diagnostics.lastSuppressed.hasSuffix("(room already on screen)"))
        #expect(notifier.diagnostics.cursor == "Read up to 2026-01-01T00:00:00.000Z")
        // Nothing secret reaches Diagnostics: no message body, no link, no cursor token.
        let text = notifier.diagnostics.rows.map(\.1).joined(separator: " ")
        #expect(!text.contains("Please review") && !text.contains("multiplayerai://") && !text.contains("eyJ"))
    }

    @Test func aServerOnADifferentBuildIsCalledOut() {
        #expect(AppModel.buildComparison(app: "0a3d693", server: "0a3d6931234") == "0a3d693")
        #expect(AppModel.buildComparison(app: "abc1234", server: "7291d09").contains("differs from this app"))
        #expect(AppModel.buildComparison(app: "abc1234", server: "") == "Not reported")
    }

    /// The Air's missing banners: the app kept treating the last room loaded as on screen, because
    /// in-page navigation never reached it, so going Home still suppressed that room's notifications.
    @Test func goingHomeStopsARoomCountingAsOnScreen() {
        var progress = Progress(); progress.setupComplete = true; progress.workspaceAddress = "https://workspace.test"
        let app = AppModel(store: MemoryProgressStore(progress), connector: ConnectorModel(live: false))
        app.pageChanged(to: "/rooms/\(Self.company)/\(Self.room)#message-\(Self.message)")
        #expect(AppModel.visibleRoom(path: app.visiblePath, appActive: true)! == (Self.company, Self.room))
        #expect(app.progress.lastRoomPath == "/rooms/\(Self.company)/\(Self.room)")
        app.pageChanged(to: "/home")
        #expect(app.visiblePath == "/home")
        #expect(AppModel.visibleRoom(path: app.visiblePath, appActive: true) == nil)
        // The room last opened is still remembered for what needs it, without claiming it is on screen.
        #expect(app.progress.lastRoomPath == "/rooms/\(Self.company)/\(Self.room)")
        #expect(AppModel.describePage(app.visiblePath) == "Home")
        #expect(AppModel.describePage("/rooms/\(Self.company)/\(Self.room)") == "A room")
    }

    @Test func thePageReportsEveryInPageNavigationAndOnlyItsOwnPaths() {
        for hook in ["pushState", "replaceState", "popstate", "hashchange", NavigationBridge.name] {
            #expect(NavigationBridge.script.contains(hook))
        }
        #expect(NavigationBridge.path("/home") == "/home")
        #expect(NavigationBridge.path("/rooms/a/b#message-c") == "/rooms/a/b#message-c")
        #expect(NavigationBridge.path("//evil.example/rooms") == nil)
        #expect(NavigationBridge.path("https://evil.example/") == nil)
        #expect(NavigationBridge.path("/" + String(repeating: "a", count: 600)) == nil)
    }

    /// Signing in inside the page left the app itself signed out, so notifications never started.
    @Test func aSessionTheWebViewHasIsAdoptedByTheAppOnlyForThisWorkspace() throws {
        let base = URL(string: "https://workspace.test")!
        func cookie(_ value: String, host: String = "workspace.test") -> HTTPCookie {
            HTTPCookie(properties: [.name: WebSession.sessionCookieName, .value: value, .domain: host, .path: "/"])!
        }
        #expect(AppModel.shouldAdoptWebSession(base: base, native: [], web: [cookie("web")]))
        #expect(!AppModel.shouldAdoptWebSession(base: base, native: [cookie("same")], web: [cookie("same")]))
        #expect(AppModel.shouldAdoptWebSession(base: base, native: [cookie("old")], web: [cookie("new")]))
        #expect(!AppModel.shouldAdoptWebSession(base: base, native: [], web: []))
        #expect(!AppModel.shouldAdoptWebSession(base: base, native: [], web: [cookie("elsewhere", host: "other.example")]))
    }

    @Test func aNotificationThatIsNotARoomLinkIsDropped() {
        let raw: [String: Any] = ["id": "x", "kind": "mention", "category": "mention", "company_id": Self.company,
                                  "room_id": Self.room, "link": "https://elsewhere.example/phish"]
        #expect(RoomNotification.decode(raw) == nil)
        var valid = raw; valid["link"] = Self.note("x").link
        #expect(RoomNotification.decode(valid)?.id == "x")
    }
}
