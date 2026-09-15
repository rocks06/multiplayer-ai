import Foundation

/// A room move changes metadata, never principal, runtime selection, or credential.
/// The injected lifecycle makes ordering/failure behavior testable without Keychain or agents.
@MainActor enum RoomRebinding {
    /// Where a failed move left the agent. That decides both what happens next and what the
    /// person is told, and the two cases are opposites.
    enum Failure: Error {
        /// The old room never confirmed the agent left it, so nothing moved and it was put back.
        case stayed(any Error)
        /// The new room is recorded; the helper keeps reconnecting there with the same credential.
        case moved(any Error)

        var underlying: any Error {
            switch self { case .stayed(let error), .moved(let error): error }
        }
    }

    static func perform(existing: Keychain.Enrolment, roomId: String, roomName: String?,
                        projectName: String?, disconnect: () async throws -> Void,
                        restore: () async -> Void,
                        persist: (Keychain.Enrolment) -> Void,
                        connect: () async throws -> Void) async throws {
        do { try await disconnect() } catch {
            // Stopping the runtime happens before the workspace is asked. A move abandoned here
            // must not leave an agent that was working in one room working in none.
            await restore()
            throw Failure.stayed(error)
        }
        var target = existing
        target.roomId = roomId
        target.roomName = roomName
        target.projectName = projectName
        persist(target)
        do { try await connect() } catch { throw Failure.moved(error) }
    }
}
