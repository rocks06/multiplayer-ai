import Foundation
import UserNotifications

/// Something in a room worth a macOS notification, as the workspace describes it.
public struct RoomNotification: Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    /// informational, mention, or action_required — different asks, told apart everywhere.
    public let category: String
    public let companyId: String
    public let roomId: String
    public let roomName: String
    public let title: String
    public let body: String
    public let link: String

    public init(id: String, kind: String, category: String, companyId: String, roomId: String,
                roomName: String, title: String, body: String, link: String) {
        self.id = id; self.kind = kind; self.category = category; self.companyId = companyId
        self.roomId = roomId; self.roomName = roomName; self.title = title; self.body = body; self.link = link
    }

    static func decode(_ raw: [String: Any]) -> RoomNotification? {
        guard let id = raw["id"] as? String, let kind = raw["kind"] as? String,
              let category = raw["category"] as? String, let companyId = raw["company_id"] as? String,
              let roomId = raw["room_id"] as? String, let link = raw["link"] as? String,
              AppModel.sharedRoomLink(link) != nil else { return nil }
        return .init(id: id, kind: kind, category: category, companyId: companyId, roomId: roomId,
                     roomName: raw["room_name"] as? String ?? "", title: raw["title"] as? String ?? "",
                     body: raw["body"] as? String ?? "", link: link)
    }
}

public struct NotificationPage: Sendable {
    public let cursor: String
    public let notifications: [RoomNotification]
    public init(cursor: String, notifications: [RoomNotification]) { self.cursor = cursor; self.notifications = notifications }
}

/// Where notifications go. The system implementation below; a recording one in tests.
@MainActor
public protocol NotificationPosting: AnyObject {
    /// Whether the person allows notifications, asking once if they have never been asked.
    func authorized() async -> Bool
    func post(_ notification: RoomNotification) async
}

/// What the notifier remembers between launches: how far it has read, and what it already showed.
public protocol NotifierMemory: AnyObject {
    var cursor: String? { get set }
    var delivered: [String] { get set }
}

public final class DefaultsNotifierMemory: NotifierMemory {
    private let key: String
    private let defaults: UserDefaults
    public init(scope: String, defaults: UserDefaults = .standard) {
        self.key = "com.multiplayerai.notifications.\(scope)"; self.defaults = defaults
    }
    public var cursor: String? {
        get { defaults.string(forKey: "\(key).cursor") }
        set { defaults.set(newValue, forKey: "\(key).cursor") }
    }
    public var delivered: [String] {
        get { defaults.stringArray(forKey: "\(key).delivered") ?? [] }
        set { defaults.set(newValue, forKey: "\(key).delivered") }
    }
}

public final class MemoryNotifierMemory: NotifierMemory {
    public var cursor: String?
    public var delivered: [String] = []
    public init() {}
}

/**
 * Native notifications for room activity that asks something of this person.
 *
 * What qualifies is the workspace's decision — a direct message, a mention, an agent that finished
 * or is blocked, a decision to make — never presence or logs. This decides only whether to show it
 * here and now: each notification is shown at most once however often it is read back (a relaunch,
 * a reconnect, an overlapping poll), nothing is shown while the person is already looking at that
 * room, and nothing at all is shown unless macOS permits it.
 */
@MainActor
public final class RoomNotifier {
    public typealias Fetch = (_ after: String?) async throws -> NotificationPage

    private let fetch: Fetch
    private let poster: NotificationPosting
    private let memory: NotifierMemory
    /// The room on screen, if the app is frontmost and showing one.
    private let visibleRoom: () -> (company: String, room: String)?
    private var polling: Task<Void, Never>?
    private var inFlight = false
    static let rememberedDeliveries = 500

    public init(fetch: @escaping Fetch, poster: NotificationPosting, memory: NotifierMemory,
                visibleRoom: @escaping () -> (company: String, room: String)?) {
        self.fetch = fetch; self.poster = poster; self.memory = memory; self.visibleRoom = visibleRoom
    }

    /// Read once. Returns what was shown, for whoever wants to know.
    @discardableResult
    public func poll() async -> [RoomNotification] {
        guard !inFlight else { return [] }
        inFlight = true
        defer { inFlight = false }
        guard let page = try? await fetch(memory.cursor) else { return [] }
        var delivered = memory.delivered
        var shown: [RoomNotification] = []
        let fresh = page.notifications.filter { !delivered.contains($0.id) }
        let allowed = fresh.isEmpty ? false : await poster.authorized()
        for notification in fresh {
            // Recorded whether or not it is shown: seen here is seen, and must not surface later.
            delivered.append(notification.id)
            guard allowed, !RoomNotifier.suppressed(notification, visible: visibleRoom()) else { continue }
            await poster.post(notification)
            shown.append(notification)
        }
        memory.delivered = Array(delivered.suffix(RoomNotifier.rememberedDeliveries))
        memory.cursor = page.cursor
        return shown
    }

    /// Already in front of the person: the room is open and the app is frontmost.
    nonisolated public static func suppressed(_ notification: RoomNotification,
                                              visible: (company: String, room: String)?) -> Bool {
        guard let visible else { return false }
        return visible.company == notification.companyId && visible.room == notification.roomId
    }

    public func start(every interval: Duration = .seconds(15)) {
        guard polling == nil else { return }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                await self?.poll()
                try? await Task.sleep(for: interval)
            }
        }
    }

    public func stop() {
        polling?.cancel()
        polling = nil
    }
}

/// The macOS side: permission, posting, and routing a click back into the app.
@MainActor
public final class SystemNotificationPoster: NSObject, NotificationPosting, UNUserNotificationCenterDelegate {
    private let center: UNUserNotificationCenter
    private let open: (String) -> Void

    /// `open` receives the notification's link when it is clicked.
    public init(open: @escaping (String) -> Void) {
        self.center = UNUserNotificationCenter.current()
        self.open = open
        super.init()
        center.delegate = self
    }

    public func authorized() async -> Bool {
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional: return true
        case .notDetermined: return (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        default: return false
        }
    }

    public func post(_ notification: RoomNotification) async {
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.subtitle = notification.roomName
        content.body = notification.body
        content.threadIdentifier = notification.roomId
        content.categoryIdentifier = notification.category
        content.userInfo = ["link": notification.link]
        if notification.category != "informational" { content.sound = .default }
        // The id is the event's: even the system collapses a repeat of the same one.
        let request = UNNotificationRequest(identifier: notification.id, content: content, trigger: nil)
        try? await center.add(request)
    }

    nonisolated public func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                                   withCompletionHandler completionHandler: @escaping () -> Void) {
        let link = response.notification.request.content.userInfo["link"] as? String
        completionHandler()
        guard let link, AppModel.sharedRoomLink(link) != nil else { return }
        Task { @MainActor in self.open(link) }
    }

    nonisolated public func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                                   withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}
