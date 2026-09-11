import XCTest
@testable import ConnectorUI

@MainActor
final class SidecarClientTests: XCTestCase {
    private func fixture(_ body: String, timeout: TimeInterval = 0.4) throws -> SidecarClient {
        let root = FileManager.default.temporaryDirectory.appending(path: "mpai-ipc-test-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let executable = root.appending(path: "helper")
        try ("#!/usr/bin/python3\nimport sys,json,time,os\n" + body).write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        return SidecarClient(executable: executable, supportDirectory: root,
                             environment: ["HOME": root.path, "MPAI_IDENTITY_DIR": root.path], requestTimeout: timeout)
    }

    func testLaunchFailureIsLocalAndPrecise() {
        let client = SidecarClient(executable: URL(fileURLWithPath: "/nonexistent/mpai-test-helper"),
                                   supportDirectory: FileManager.default.temporaryDirectory, environment: [:])
        client.start()
        XCTAssertNil(client.processIdentifier)
        XCTAssertEqual(client.ipcStatus, "Launch failed")
        XCTAssertTrue(client.lastLaunchFailure?.contains("NSCocoaErrorDomain") == true)
        client.stop()
    }

    func testStderrFloodCannotDeadlockIPC() async throws {
        let client = try fixture("""
        sys.stderr.write('private-secret-value' * 100000); sys.stderr.flush()
        for line in sys.stdin:
            req=json.loads(line)
            print(json.dumps({'type':'reply','id':req['id'],'ok':True}),flush=True)
        """, timeout: 5)
        client.start(); defer { client.stop() }
        let reply = try await client.send("diagnostics")
        XCTAssertEqual(reply["ok"] as? Bool, true)
        XCTAssertNotNil(client.processIdentifier)
        XCTAssertNil(client.lastIPCFailure)
    }

    func testTimeoutNamesCommandButNotArguments() async throws {
        let client = try fixture("for line in sys.stdin: pass\n")
        client.start(); defer { client.stop() }
        do { try await client.send("diagnostics", ["credential": "never-print-this"]); XCTFail("Expected timeout") }
        catch { XCTAssertTrue(error.localizedDescription.contains("diagnostics timed out")); XCTAssertFalse(error.localizedDescription.contains("never-print-this")) }
        XCTAssertNotNil(client.processIdentifier, "An IPC timeout is not proof that the process died")
    }

    func testExitStatusAndSecretSafeClassification() async throws {
        let client = try fixture("sys.stderr.write('EACCES credential=very-secret\\n');sys.stderr.flush();time.sleep(0.1);sys.exit(23)\n")
        client.start(); defer { client.stop() }
        try await Task.sleep(for: .milliseconds(700))
        XCTAssertNil(client.processIdentifier)
        XCTAssertTrue(client.lastExit?.contains("status 23") == true)
        XCTAssertTrue(client.lastExit?.contains("EACCES") == true)
        XCTAssertFalse(client.lastExit?.contains("very-secret") == true)
        XCTAssertEqual(client.restarts, 0)
    }

    func testInvalidProtocolIsNotSilentlyIgnored() async throws {
        let client = try fixture("print('not-json secret-token',flush=True)\nfor line in sys.stdin: pass\n", timeout: 5)
        client.start(); defer { client.stop() }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(client.lastIPCFailure?.contains("invalid JSON") == true)
        XCTAssertFalse(client.lastIPCFailure?.contains("secret-token") == true)
    }

    func testStopSettlesPendingAndOldExitCannotClearReplacement() async throws {
        let client = try fixture("for line in sys.stdin: pass\n", timeout: 5)
        client.start()
        let request = Task { _ = try await client.send("diagnostics") }
        await Task.yield()
        client.stop(); client.start()
        let replacement = client.processIdentifier
        do { _ = try await request.value; XCTFail("Expected stopped") } catch { }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(client.processIdentifier, replacement)
        XCTAssertNotNil(replacement)
        client.stop()
    }

    func testSignalClassificationDoesNotExposeStderr() {
        XCTAssertEqual(SidecarClient.exitSummary(status: 5, signalled: true, stderr: Data("Bearer secret".utf8)),
                       "Helper exited with signal 5; stderr captured (content withheld).")
    }

    func testRealBundledHelperProtocolWhenProvided() async throws {
        guard let path = ProcessInfo.processInfo.environment["MPAI_TEST_SIDECAR"] else { throw XCTSkip("Set MPAI_TEST_SIDECAR to exercise a signed bundle") }
        let root = FileManager.default.temporaryDirectory.appending(path: "mpai-bundle-test-\(UUID())")
        let client = SidecarClient(executable: URL(fileURLWithPath: path), supportDirectory: root,
            environment: ["HOME": root.path, "MPAI_IDENTITY_DIR": root.appending(path: "identity").path, "HERMES_COMMAND": "/usr/bin/false", "PATH": "/usr/bin:/bin"], requestTimeout: 10)
        client.start(); defer { client.stop() }
        let reply = try await client.send("diagnostics")
        let report = try XCTUnwrap(reply["diagnostics"] as? [String: Any])
        XCTAssertEqual(report["pid"] as? Int, client.processIdentifier.map(Int.init))
        XCTAssertEqual(report["running"] as? Bool, false)
        XCTAssertEqual(report["enrolled"] as? Bool, false)
        XCTAssertEqual(report["stateFile"] as? String, root.appending(path: "connector-state.json").path)
        await client.refresh()
        XCTAssertEqual(client.state.gateway, "not_started")
        XCTAssertFalse(client.state.runtime.available)
        print("BUNDLED IPC VERIFIED pid=\(report["pid"]!) support=\(root.path)")
    }
}
