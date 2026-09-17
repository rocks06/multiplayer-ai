import Foundation
import Observation
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
    /// What macOS currently allows, in words: "authorized", "denied", "not determined", "provisional".
    func permissionStatus() async -> String
    /// Ask, if the person has never been asked. Returns whether notifications may be shown.
    func requestPermission() async -> Bool
    func post(_ notification: RoomNotification) async
}

/**
 * What notifications and unread state are doing, for Diagnostics. Nothing secret: no credentials,
 * no session tokens, no message bodies — titles, room names, times and states only.
 */
@Observable
@MainActor
public final class AttentionDiagnostics {
    public var permission = "Not checked"
    public var polling = "Not started"
    public var lastPoll = "—"
    public var feed = "—"
    public var cursor = "—"
    public var lastReceived = "—"
    public var lastShown = "—"
    public var lastSuppressed = "—"
    public var serverBuild = "—"
    public var roomReadState = "—"
    public init() {}

    public var rows: [(String, String)] {
        [("Notifications", permission), ("Notification polling", polling), ("Last notification check", lastPoll),
         ("Notification feed", feed), ("Notification cursor", cursor), ("Last received", lastReceived),
         ("Last shown", lastShown), ("Last suppressed", lastSuppressed), ("Server build", serverBuild),
         ("Room read state", roomReadState)]
    }

    nonisolated static func stamp(_ date: Date = Date()) -> String {
        let formatter = DateFormatter(); formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: date)
    }

    /// Where the feed has read up to, as a time. The cursor itself is opaque and not worth showing.
    nonisolated static func describeCursor(_ cursor: String?) -> String {
        guard var text = cursor else { return "Not started" }
        text = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while text.count % 4 != 0 { text += "=" }
        guard let data = Data(base64Encoded: text),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let at = value["at"] as? String else { return "Unreadable position" }
        return "Read up to \(at)"
    }
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
    public let diagnostics: AttentionDiagnostics
    /// Called after every read of the feed, so the app can add what only it knows to Diagnostics.
    public var afterPoll: (() async -> Void)?
    static let rememberedDeliveries = 500

    public init(fetch: @escaping Fetch, poster: NotificationPosting, memory: NotifierMemory,
                visibleRoom: @escaping () -> (company: String, room: String)?,
                diagnostics: AttentionDiagnostics = AttentionDiagnostics()) {
        self.fetch = fetch; self.poster = poster; self.memory = memory; self.visibleRoom = visibleRoom
        self.diagnostics = diagnostics
        diagnostics.cursor = AttentionDiagnostics.describeCursor(memory.cursor)
    }

    /// Read once. Returns what was shown, for whoever wants to know.
    @discardableResult
    public func poll() async -> [RoomNotification] {
        guard !inFlight else { return [] }
        inFlight = true
        defer { inFlight = false }
        diagnostics.lastPoll = AttentionDiagnostics.stamp()
        let page: NotificationPage
        do { page = try await fetch(memory.cursor) }
        catch {
            diagnostics.feed = "Failed: \(error.localizedDescription)"
            await afterPoll?()
            return []
        }
        diagnostics.feed = "OK · \(page.notifications.count) new"
        var delivered = memory.delivered
        var shown: [RoomNotification] = []
        let fresh = page.notifications.filter { !delivered.contains($0.id) }
        let allowed = fresh.isEmpty ? false : await poster.requestPermission()
        if !fresh.isEmpty { diagnostics.permission = await poster.permissionStatus() }
        for notification in fresh {
            // Recorded whether or not it is shown: seen here is seen, and must not surface later.
            delivered.append(notification.id)
            let label = "\(notification.title) · \(notification.roomName) · \(AttentionDiagnostics.stamp())"
            diagnostics.lastReceived = label
            if !allowed { diagnostics.lastSuppressed = "\(label) (notifications not allowed)"; continue }
            if RoomNotifier.suppressed(notification, visible: visibleRoom()) {
                diagnostics.lastSuppressed = "\(label) (room already on screen)"; continue
            }
            await poster.post(notification)
            diagnostics.lastShown = label
            shown.append(notification)
        }
        memory.delivered = Array(delivered.suffix(RoomNotifier.rememberedDeliveries))
        memory.cursor = page.cursor
        diagnostics.cursor = AttentionDiagnostics.describeCursor(page.cursor)
        await afterPoll?()
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
        diagnostics.polling = "Running every \(interval.components.seconds)s"
        polling = Task { [weak self] in
            /* Asked when notifications start working for this person, not on the first qualifying
               event: waiting for one meant a person could use the app for a day, never be asked,
               and never know notifications existed. Asking again after an answer does nothing. */
            if let self {
                _ = await self.poster.requestPermission()
                self.diagnostics.permission = await self.poster.permissionStatus()
            }
            while !Task.isCancelled {
                await self?.poll()
                try? await Task.sleep(for: interval)
            }
        }
    }

    public func stop() {
        polling?.cancel()
        polling = nil
        diagnostics.polling = "Stopped (signed out)"
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

    public func permissionStatus() async -> String {
        switch await center.notificationSettings().authorizationStatus {
        case .authorized: return "authorized"
        case .provisional: return "provisional"
        case .denied: return "denied — allow Multiplayer AI in System Settings › Notifications"
        case .notDetermined: return "not determined"
        default: return "unavailable"
        }
    }

    public func requestPermission() async -> Bool {
        switch await center.notificationSettings().authorizationStatus {
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
