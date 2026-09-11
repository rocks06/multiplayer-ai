import Testing
import Foundation
@testable import ConnectorUI

@Suite @MainActor struct AgentDiscoveryTests {
    private var record: [String: Any] {
        ["available": true, "name": "Future Adapter", "version": "1.2.3", "profile": "research",
         "runtimeType": "future", "adapter": "future", "readiness": "ready",
         "runtimeInstallationId": "stable-runtime", "connectorInstallationId": "stable-connector", "endpoint": "/fixture/agent"]
    }
    @Test func freshUserWithOneAgentSelectsWithoutConnectionCode() throws {
        let app = AppModel.discoveryPreview(records: [record])
        #expect(app.discoveryPhase == .results)
        #expect(app.discoveredAgents.count == 1)
        let agent = try #require(app.discoveredAgents.first)
        #expect(agent.isConnectable)
        #expect(agent.profile == "research")
        #expect(agent.detail.contains("future"))
        app.selectDiscoveredAgent(agent.id)
        #expect(app.selectedKnownIdentity == nil)
        #expect(app.connector.code.isEmpty)
        #expect(app.discoveryDisplayName.isEmpty)
    }
    @Test func closingAnInFlightScanAllowsAnotherDetection() {
        // Preview connector is non-live: no helper, Keychain or runtime is started.
        let app = AppModel.discoveryPreview(records: [], phase: .looking)
        app.showingAgentDiscovery = true
        app.dismissAgentDiscovery()
        #expect(!app.showingAgentDiscovery)
        #expect(app.discoveryPhase == .idle)
        // detectRuntime's guard rejects .looking/.connecting; dismissal must release it.
        #expect(app.discoveryPhase != .looking && app.discoveryPhase != .connecting)
    }
    @Test func dismissCannotCancelAnActiveBinding() {
        let app = AppModel.discoveryPreview(records: [], phase: .connecting)
        app.showingAgentDiscovery = true
        app.dismissAgentDiscovery()
        #expect(app.showingAgentDiscovery)
        #expect(app.discoveryPhase == .connecting)
    }
    @Test func noAgentFoundIsAnEmptyResultNotHelperFailure() {
        let app = AppModel.discoveryPreview(records: [])
        #expect(app.discoveryPhase == .results)
        #expect(app.discoveredAgents.isEmpty)
        #expect(app.selectedDiscoveredAgent == nil)
    }
    @Test func helperFailureIsNotReportedAsNoAgents() {
        let app = AppModel.discoveryPreview(records: [], phase: .failed("Helper exited (code 78): fixture startup failure"))
        #expect(app.discoveryPhase != .results)
    }
    @Test func reconnectUsesStableIdentityNotPresentationName() throws {
        let app = AppModel.discoveryPreview(records: [])
        let agent = try #require(DiscoveredAgent.decode(record))
        app.acceptDiscovery([agent], known: [agent.id: .init(principalId: "existing-principal", displayName: "Existing name")])
        app.selectDiscoveredAgent(agent.id)
        #expect(app.selectedKnownIdentity?.principalId == "existing-principal")
        #expect(app.selectedKnownIdentity?.displayName == "Existing name")
        #expect(app.discoveryDisplayName.isEmpty)
    }
    @Test func upgradeDecodesOldEnrollmentWithoutChangingIdentity() throws {
        let data = Data(#"{"baseURL":"https://example.test","roomId":"room","agentPrincipalId":"principal"}"#.utf8)
        let enrollment = try JSONDecoder().decode(Keychain.Enrolment.self, from: data)
        #expect(enrollment.runtimeSelectionId == nil)
        #expect(enrollment.agentPrincipalId == "principal")
        #expect(enrollment.roomId == "room")
    }
    @Test func selectedProfileSurvivesEnrollmentRoundtrip() throws {
        let saved = Keychain.Enrolment(baseURL: "https://example.test", roomId: "room", agentPrincipalId: "principal", runtimeSelectionId: "stable-profile-id")
        let decoded = try JSONDecoder().decode(Keychain.Enrolment.self, from: JSONEncoder().encode(saved))
        #expect(decoded == saved)
    }
    @Test func executableDiscoveryAndSelectionAreNotConnected() throws {
        let app = AppModel.discoveryPreview(records: [record])
        app.selectDiscoveredAgent("stable-runtime")
        #expect(app.discoveryPhase != .connected)
        #expect(app.connector.health != .connected)
    }
}
