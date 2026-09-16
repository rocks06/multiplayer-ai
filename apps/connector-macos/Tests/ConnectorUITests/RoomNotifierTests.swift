import Testing
import Foundation
@testable import ConnectorUI

/// Native notifications: shown once, only when allowed, never over the room already on screen, and
/// opening exactly the room, message or decision they are about. Ids are fixtures.
@Suite @MainActor struct RoomNotifierTests {
    final class RecordingPoster: NotificationPosting {
        var allowed = true
        var posted: [RoomNotification] = []
        func authorized() async -> Bool { allowed }
        func post(_ notification: RoomNotification) async { posted.append(notification) }
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

    @Test func aNotificationThatIsNotARoomLinkIsDropped() {
        let raw: [String: Any] = ["id": "x", "kind": "mention", "category": "mention", "company_id": Self.company,
                                  "room_id": Self.room, "link": "https://elsewhere.example/phish"]
        #expect(RoomNotification.decode(raw) == nil)
        var valid = raw; valid["link"] = Self.note("x").link
        #expect(RoomNotification.decode(valid)?.id == "x")
    }
}
