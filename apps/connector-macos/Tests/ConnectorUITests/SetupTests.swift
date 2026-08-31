import Testing
import Foundation
@testable import ConnectorUI

/// What setup is allowed to claim.
///
/// The rule this phase inherits is that the app never reports work it did not do. These check
/// the other half of it too: that things which are *not* failures — no agent runtime yet, login
/// items refused — do not stop a person who has nothing wrong with their Mac.
@Suite struct SetupTests {
    @Test func anOldMacIsToldWhatItNeeds() {
        let outcome = SetupJudgement.system(osVersion: .init(majorVersion: 13, minorVersion: 6, patchVersion: 0))
        guard case .failed(let what, let todo) = outcome else { return #expect(Bool(false), "expected a failure") }
        #expect(what.contains("macOS 13"))
        #expect(todo.contains("System Settings"))
    }

    @Test func asupportedMacPasses() {
        let outcome = SetupJudgement.system(osVersion: .init(majorVersion: 14, minorVersion: 4, patchVersion: 1))
        #expect(outcome == .done("macOS 14.4"))
    }

    /// A helper missing from the bundle is the one setup failure a person can actually fix, and
    /// the remedy is never a Terminal command.
    @Test func aMissingHelperSaysWhatToDoWithoutATerminal() {
        let outcome = SetupJudgement.helper(found: false, executable: false)
        guard case .failed(let what, let todo) = outcome else { return #expect(Bool(false), "expected a failure") }
        #expect(what.contains("missing"))
        #expect(todo.contains("Applications"))
        for forbidden in ["sudo", "chmod", "npm", "node", "launchctl", "Terminal"] {
            #expect(!todo.contains(forbidden), "recovery must not send anyone to a shell: \(todo)")
        }
    }

    @Test func aHelperThatWillNotRunIsNotTheSameAsAMissingOne() {
        let missing = SetupJudgement.helper(found: false, executable: false)
        let blocked = SetupJudgement.helper(found: true, executable: false)
        #expect(missing != blocked)
        #expect(SetupJudgement.helper(found: true, executable: true) == .done("Ready"))
    }

    @Test func aServiceThatWillNotStartCarriesTheRealReason() {
        let outcome = SetupJudgement.service(started: false, failure: "The Connector's helper is missing from the app.")
        guard case .failed(let what, _) = outcome else { return #expect(Bool(false), "expected a failure") }
        #expect(what == "The Connector's helper is missing from the app.")
    }

    /// A Mac with no agent on it has not failed setup. Saying so here would send someone off to
    /// fix a problem they do not have, in a list they cannot act on.
    @Test func noAgentRuntimeIsNotASetupFailure() {
        let none = SidecarState.Runtime(available: false, name: "Hermes Agent", reason: "Hermes was not found on this Mac.")
        #expect(SetupJudgement.agents(runtime: none) == .done("None found yet"))
        #expect(SetupJudgement.agents(runtime: none).isFailure == false)
    }

    @Test func aFoundRuntimeIsNamedWithItsVersion() {
        let found = SidecarState.Runtime(available: true, name: "Hermes Agent", version: "0.20.5")
        #expect(SetupJudgement.agents(runtime: found) == .done("Hermes Agent 0.20.5"))
    }

    /// The failure that produced this whole phase's predecessor: a keychain that will not release
    /// its contents has to be caught while it is still setup, not when someone's credential is
    /// being written.
    @Test func aKeychainThatRefusesStopsSetup() {
        let outcome = SetupJudgement.storage(probe: .unreadable(-25308))
        guard case .failed(let what, let todo) = outcome else { return #expect(Bool(false), "expected a failure") }
        #expect(what.contains("keychain"))
        #expect(todo.contains("Keychain Access"))
    }

    @Test func anEmptyKeychainIsReady() {
        #expect(SetupJudgement.storage(probe: .missing) == .done("Ready"))
        #expect(SetupJudgement.storage(probe: .found("anything")) == .done("Ready"))
    }

    /// Opening at login is a convenience. Refusing it is worth saying and not worth stopping for.
    @Test func aRefusedLoginItemDoesNotStopSetup() {
        #expect(SetupJudgement.login(registered: false).isFailure == false)
        #expect(SetupJudgement.login(registered: true) == .done("Opens at login"))
    }
}

@Suite struct SetupProgressTests {
    @Test func stepsRunInOrderAndOnlyOneAtATime() {
        var progress = SetupProgress()
        #expect(progress.next == .system)
        progress.set(.system, .done("macOS 14.4"))
        #expect(progress.next == .helper)
        #expect(progress.completed == 1)
    }

    @Test func aFailureStopsTheSequenceWhereItHappened() {
        var progress = SetupProgress()
        progress.set(.system, .done(""))
        progress.set(.helper, .failed(what: "gone", todo: "reinstall"))
        #expect(progress.failure?.task == .helper)
        #expect(progress.succeeded == false)
        // The steps after it never ran, and must not be drawn as though they had.
        #expect(progress[.service] == .pending)
        #expect(progress[.login] == .pending)
    }

    /// Setup is recorded as complete only when every step actually finished. Reaching the last
    /// step is not the same thing, and this is what stops a half-set-up Mac being marked done.
    @Test func completionRequiresEveryStep() {
        var progress = SetupProgress()
        for task in SetupTask.allCases where task != .login { progress.set(task, .done("")) }
        #expect(progress.succeeded == false)
        progress.set(.login, .done(""))
        #expect(progress.succeeded)
        #expect(progress.next == nil)
    }
}

/// Two builds of Multiplayer AI on one Mac must not share the helper's durable state.
///
/// This is not a hypothetical. A verification build running beside the real app read the real
/// app's session out of a shared state file, reported its connection as its own, and then
/// destroyed it by signing out — taking a live agent offline. The directory is keyed to the
/// bundle so that cannot happen again.
@Suite struct SupportDirectoryTests {
    @Test func theShippingAppKeepsTheDirectoryItAlreadyUses() {
        let path = SidecarClient.supportDirectory(for: "com.multiplayerai.connector").path
        #expect(path.hasSuffix("Application Support/Multiplayer AI"))
    }

    @Test func anythingElseGetsItsOwn() {
        let shipping = SidecarClient.supportDirectory(for: "com.multiplayerai.connector")
        let other = SidecarClient.supportDirectory(for: "com.multiplayerai.verify-shell")
        #expect(shipping != other)
        #expect(other.path.contains("com.multiplayerai.verify-shell"))
    }

    /// A helper with no bundle around it is the shipping case, not a third one.
    @Test func noBundleFallsBackToTheShippingDirectory() {
        #expect(SidecarClient.supportDirectory(for: nil)
                == SidecarClient.supportDirectory(for: "com.multiplayerai.connector"))
    }
}
