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

/// What became of one notification handed to macOS.
public enum NotificationDelivery: Equatable, Sendable {
    /// macOS took it. The detail says what is known about whether a banner can appear.
    case accepted(String)
    /// It never got to the screen, and why.
    case refused(String)

    public var accepted: Bool { if case .accepted = self { return true } else { return false } }
}

/// Where notifications go. The system implementation below; a recording one in tests.
@MainActor
public protocol NotificationPosting: AnyObject {
    /// What macOS currently allows, in words: "authorized", "denied", "not determined", "provisional".
    func permissionStatus() async -> String
    /// Ask, if the person has never been asked. Returns whether notifications may be shown.
    func requestPermission() async -> Bool
    func post(_ notification: RoomNotification) async -> NotificationDelivery
    /// A notification made here and now, needing no workspace, server or event: whether a banner
    /// can reach this screen at all, proved on its own.
    func sendTest() async -> NotificationDelivery
    /// Every step between this app and the screen, for Diagnostics.
    var trace: NotificationTrace { get }
}

/**
 * The path a notification takes after this app decides to show it — which is where a notification
 * that was received, counted and never seen disappeared without a word. Each step records what
 * happened: macOS's settings for this app (permission is not the same as banners), whether macOS
 * accepted it, whether macOS asked the frontmost app how to present it, and whether it reached
 * Notification Center.
 */
@Observable
@MainActor
public final class NotificationTrace {
    public var settings = "Not checked"
    public var lastAttempt = "—"
    public var lastOutcome = "—"
    public var presentation = "—"
    public var notificationCenter = "—"
    public var lastClick = "—"
    public var test = "Not sent"
    public init() {}

    public var rows: [(String, String)] {
        [("Notification settings", settings), ("Last delivery attempt", lastAttempt), ("Delivery outcome", lastOutcome),
         ("Presentation", presentation), ("Notification Center", notificationCenter), ("Last click", lastClick),
         ("Test notification", test)]
    }

    /// macOS's settings for this app, said plainly, with the one thing standing between them and a
    /// banner if there is one. Permission granted with the alert style set to None shows nothing.
    nonisolated public static func describe(authorization: UNAuthorizationStatus, alert: UNNotificationSetting,
                                            style: UNAlertStyle, sound: UNNotificationSetting,
                                            notificationCenter: UNNotificationSetting) -> (summary: String, blocker: String?) {
        let permission: String
        switch authorization {
        case .authorized: permission = "allowed"
        case .provisional: permission = "allowed quietly (provisional)"
        case .denied: permission = "denied"
        case .notDetermined: permission = "not asked yet"
        default: permission = "unavailable"
        }
        let styleName: String
        switch style {
        case .banner: styleName = "banners"
        case .alert: styleName = "alerts"
        default: styleName = "none"
        }
        let summary = "\(permission) · style \(styleName) · sound \(sound == .enabled ? "on" : "off") · Notification Center \(notificationCenter == .enabled ? "on" : "off")"
        switch authorization {
        case .denied:
            return (summary, "Notifications are turned off for Multiplayer AI. Turn on Allow Notifications in System Settings › Notifications › Multiplayer AI.")
        case .notDetermined:
            return (summary, "macOS has not been asked yet.")
        case .authorized, .provisional:
            if style == .none || alert == .disabled {
                return (summary, "Banners are off for Multiplayer AI: set its alert style to Banners or Alerts in System Settings › Notifications › Multiplayer AI.")
            }
            return (summary, nil)
        default:
            return (summary, "Notifications are not available to this app.")
        }
    }

    /// An error from macOS, with the code that identifies it — the message alone is often generic.
    nonisolated public static func describe(_ error: Error) -> String {
        let ns = error as NSError
        return "\(ns.localizedDescription) (\(ns.domain) \(ns.code))"
    }
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
    public var visiblePage = "—"
    public var session = "—"
    public init() {}

    public var rows: [(String, String)] {
        [("Notifications", permission), ("Notification polling", polling), ("Last notification check", lastPoll),
         ("Notification feed", feed), ("Notification cursor", cursor), ("Last received", lastReceived),
         ("Last shown", lastShown), ("Last suppressed", lastSuppressed), ("Server build", serverBuild),
         ("App session", session), ("Visible page", visiblePage), ("Room read state", roomReadState)]
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
            // Shown means macOS took it, not that this app asked: that difference hid every failure.
            switch await poster.post(notification) {
            case .accepted:
                diagnostics.lastShown = label
                shown.append(notification)
            case .refused(let reason):
                diagnostics.lastSuppressed = "\(label) (macOS did not show it: \(reason))"
            }
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
    private let appActive: () -> Bool
    public let trace = NotificationTrace()
    /// Notifications macOS asked this app how to present — the proof the delegate is reached.
    private var presented: Set<String> = []

    /// `open` receives the notification's link when it is clicked.
    public init(appActive: @escaping () -> Bool = { false }, open: @escaping (String) -> Void) {
        self.center = UNUserNotificationCenter.current()
        self.open = open
        self.appActive = appActive
        super.init()
        center.delegate = self
    }

    public func permissionStatus() async -> String {
        let settings = await center.notificationSettings()
        let described = NotificationTrace.describe(authorization: settings.authorizationStatus, alert: settings.alertSetting,
                                                   style: settings.alertStyle, sound: settings.soundSetting,
                                                   notificationCenter: settings.notificationCenterSetting)
        trace.settings = described.summary
        switch settings.authorizationStatus {
        case .authorized, .provisional: return described.blocker.map { "authorized, but \($0)" } ?? "authorized"
        case .denied: return "denied — allow Multiplayer AI in System Settings › Notifications"
        case .notDetermined: return "not determined"
        default: return "unavailable"
        }
    }

    public func requestPermission() async -> Bool {
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional: return true
        case .notDetermined:
            do { return try await center.requestAuthorization(options: [.alert, .sound, .badge]) }
            catch { trace.settings = "Asking macOS for permission failed: \(NotificationTrace.describe(error))"; return false }
        default: return false
        }
    }

    public func post(_ notification: RoomNotification) async -> NotificationDelivery {
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.subtitle = notification.roomName
        content.body = notification.body
        content.threadIdentifier = notification.roomId
        content.categoryIdentifier = notification.category
        content.userInfo = ["link": notification.link]
        if notification.category != "informational" { content.sound = .default }
        // The id is the event's: even the system collapses a repeat of the same one.
        return await deliver(id: notification.id, content: content, label: "\(notification.title) · \(notification.roomName)")
    }

    public func sendTest() async -> NotificationDelivery {
        let content = UNMutableNotificationContent()
        content.title = "Multiplayer AI"
        content.body = "Test notification — if you can see this banner, notifications reach your screen."
        content.sound = .default
        let sent = AttentionDiagnostics.stamp()
        let result = await deliver(id: "test-\(UUID().uuidString)", content: content, label: "Test notification")
        switch result {
        case .accepted(let detail): trace.test = "Sent \(sent) — \(detail)"
        case .refused(let reason): trace.test = "Failed \(sent) — \(reason)"
        }
        return result
    }

    /// Hand one notification to macOS and record every step of what happened to it.
    private func deliver(id: String, content: UNNotificationContent, label: String) async -> NotificationDelivery {
        trace.lastAttempt = "\(label) · \(AttentionDiagnostics.stamp())"
        trace.presentation = "—"; trace.notificationCenter = "—"
        func refuse(_ reason: String) -> NotificationDelivery { trace.lastOutcome = "Not shown: \(reason)"; return .refused(reason) }

        if await center.notificationSettings().authorizationStatus == .notDetermined {
            do { _ = try await center.requestAuthorization(options: [.alert, .sound, .badge]) }
            catch { return refuse("asking macOS for permission failed: \(NotificationTrace.describe(error))") }
        }
        let settings = await center.notificationSettings()
        let described = NotificationTrace.describe(authorization: settings.authorizationStatus, alert: settings.alertSetting,
                                                   style: settings.alertStyle, sound: settings.soundSetting,
                                                   notificationCenter: settings.notificationCenterSetting)
        trace.settings = described.summary
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
            return refuse(described.blocker ?? "macOS does not allow notifications for this app.")
        }
        let active = appActive()
        do { try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) }
        catch { return refuse("macOS refused it: \(NotificationTrace.describe(error))") }

        let detail = described.blocker ?? (active
            ? "accepted by macOS while the app is frontmost; the app asked for a banner"
            : "accepted by macOS while the app is in the background; macOS shows the banner")
        trace.lastOutcome = "Accepted \(AttentionDiagnostics.stamp()) — \(detail)"
        trace.presentation = active ? "Waiting for macOS to ask the app how to present it" : "App in background — macOS presents it without asking the app"
        Task { [weak self] in await self?.confirm(id: id, active: active) }
        return .accepted(detail)
    }

    /// What macOS did next: whether it asked the frontmost app how to present the notification, and
    /// whether the notification is in Notification Center. Neither step reports an error on its own.
    private func confirm(id: String, active: Bool) async {
        try? await Task.sleep(for: .milliseconds(1500))
        let listed = await center.deliveredNotifications().contains { $0.request.identifier == id }
        trace.notificationCenter = listed
            ? "Listed \(AttentionDiagnostics.stamp())"
            : "Not listed — macOS did not keep it (Notification Center may be off for this app)"
        if active && !presented.contains(id) {
            trace.presentation = "macOS never asked the app how to present it while frontmost — no banner can appear in the foreground"
        }
    }

    nonisolated public func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                                   withCompletionHandler completionHandler: @escaping () -> Void) {
        let link = response.notification.request.content.userInfo["link"] as? String
        let title = response.notification.request.content.title
        completionHandler()
        Task { @MainActor in
            self.trace.lastClick = "\(title) · \(AttentionDiagnostics.stamp())"
            guard let link, AppModel.sharedRoomLink(link) != nil else { return }
            self.open(link)
        }
    }

    nonisolated public func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                                   withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // Frontmost apps get no banner unless they ask for one here.
        completionHandler([.banner, .list, .sound])
        let id = notification.request.identifier
        Task { @MainActor in
            self.presented.insert(id)
            self.trace.presentation = "macOS asked the frontmost app; banner requested \(AttentionDiagnostics.stamp())"
        }
    }
}
