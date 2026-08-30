import Foundation

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        FileHandle.standardError.write(Data("manager model check failed: \(message)\n".utf8))
        exit(1)
    }
}

do {
    let payload = Data(#"""
    {
      "status": "ok",
      "entries": [{
        "id": "event-1",
        "occurredAt": "2026-08-30T00:00:00.000Z",
        "type": "tool-set.changed",
        "summary": "Active tools changed",
        "detail": {
          "activeAgentComponents": ["math-anchor", "migratory-time"],
          "inactiveAgentComponents": [],
          "metadata": {"changed": true, "reason": null},
          "count": 9223372036854775807
        }
      }]
    }
    """#.utf8)
    let result = try JSONDecoder().decode(ActivityResult.self, from: payload)
    let details = Dictionary(uniqueKeysWithValues: result.entries[0].orderedDetail.map { ($0.key, $0.value) })
    expect(details["activeAgentComponents"] == "[math-anchor, migratory-time]", "activity arrays must decode")
    expect(details["inactiveAgentComponents"] == "[]", "empty activity arrays must decode")
    expect(details["metadata"] == "{changed: yes, reason: none}", "activity objects and null must decode")
    expect(details["count"] == "9223372036854775807", "large integers must remain exact")
    let humanDetails = Dictionary(uniqueKeysWithValues: result.entries[0].humanDetail(componentNames: [:]).map { ($0.label, $0.value) })
    expect(humanDetails["Available tools"] == "Math Anchor, Migratory Time", "activity must translate component ids into product names")
    expect(humanDetails["Kept installed"] == nil, "empty activity groups must stay out of the primary interface")
    expect(humanDetails["metadata"] == nil && humanDetails["count"] == nil, "raw diagnostic fields must stay out of the primary interface")

    let longPayload = Data("\"\(String(repeating: "x", count: 400))\"".utf8)
    let longValue = try JSONDecoder().decode(ActivityDetailValue.self, from: longPayload)
    expect(longValue.displayText.count == 240, "activity display must be bounded")
    expect(longValue.displayText.hasSuffix("…"), "bounded activity display must disclose truncation")

    let partialCollection = SnapshotCollection(
        status: "completed",
        providersOk: 2,
        providersPartial: 1,
        providersMissing: 0,
        providersError: 0,
        sources: [
            SnapshotCollectionSource(source: "codex", status: "partial", errorCode: nil, backlogSources: 239, skippedLines: 3),
            SnapshotCollectionSource(source: "claude", status: "ok", errorCode: nil, backlogSources: 0, skippedLines: 0),
        ]
    )
    let now = Date(timeIntervalSince1970: 1_000_000)
    let refreshed = ISO8601DateFormatter().string(from: now.addingTimeInterval(-3_600))
    let partial = MonitoringHealthEvaluator.evaluate(
        collection: partialCollection,
        refreshedAt: refreshed,
        maintenanceIntervalSeconds: 604_800,
        now: now
    )
    expect(!partial.isHealthy, "a partial source must make monitoring unhealthy")
    expect(partial.detail.contains("1 source incomplete"), "detailed and aggregate source counts must not be added")
    expect(!partial.detail.contains("2 sources incomplete"), "one source must not be double counted")
    expect(partial.detail.contains("refreshed 1h ago"), "refresh age must be visible")

    let completeCollection = SnapshotCollection(
        status: "completed",
        providersOk: 2,
        providersPartial: 0,
        providersMissing: 0,
        providersError: 0,
        sources: [
            SnapshotCollectionSource(source: "codex", status: "ok", errorCode: nil, backlogSources: 0, skippedLines: 0),
        ]
    )
    let staleNow = Date(timeIntervalSince1970: 2_000_000)
    let staleRefresh = ISO8601DateFormatter().string(from: staleNow.addingTimeInterval(-15 * 86_400))
    let stale = MonitoringHealthEvaluator.evaluate(
        collection: completeCollection,
        refreshedAt: staleRefresh,
        maintenanceIntervalSeconds: 604_800,
        now: staleNow
    )
    expect(!stale.isHealthy, "two missed maintenance intervals must be stale")
    expect(stale.detail.hasPrefix("Stale"), "stale monitoring must be labeled")
    expect(stale.detail.contains("15d ago"), "stale age must be visible")

    let refreshNow = Date(timeIntervalSince1970: 3_000_000)
    expect(
        ManagerRefreshPolicy.shouldRefresh(lastSuccessfulRefreshAt: nil, now: refreshNow),
        "a manager without a successful refresh must load current state"
    )
    expect(
        !ManagerRefreshPolicy.shouldRefresh(
            lastSuccessfulRefreshAt: refreshNow.addingTimeInterval(-30),
            now: refreshNow,
            maxAge: 60
        ),
        "returning to the foreground must not duplicate a recent refresh"
    )
    expect(
        ManagerRefreshPolicy.shouldRefresh(
            lastSuccessfulRefreshAt: refreshNow.addingTimeInterval(-61),
            now: refreshNow,
            maxAge: 60
        ),
        "returning to the foreground must replace stale in-memory state"
    )
    expect(
        ManagerRefreshPolicy.shouldRefresh(
            lastSuccessfulRefreshAt: refreshNow.addingTimeInterval(600),
            now: refreshNow,
            maxAge: 60
        ),
        "a future refresh timestamp must fail open to a current refresh"
    )

    let toolComponents = [
        "math-anchor": ComponentSummary(version: "0.4.0", displayName: "Math Anchor", summary: nil),
        "context-surface-analyzer": ComponentSummary(
            version: "0.1.2",
            displayName: "Context Surface Analyzer",
            summary: nil
        ),
    ]
    let visibleToolIDs = ManagerToolPolicy.visibleToolIDs(
        components: toolComponents,
        availableAgentComponents: ["math-anchor"],
        activeAgentComponents: ["math-anchor"],
        orderedIDs: ["math-anchor", "context-surface-analyzer"]
    )
    expect(
        visibleToolIDs == ["math-anchor"],
        "backstage observation components must not appear as Agent tools"
    )
    expect(
        ManagerCheckPolicy.foregroundDoctorArguments == ["doctor", "--deep", "--skip-agent-apps"],
        "foreground refresh must keep deep local probes without launching Agent apps"
    )
    expect(
        ManagerCheckPolicy.quickHostStatusArguments("claude") == ["host", "status", "claude", "--quick"],
        "foreground Agent-app detection must not inspect project-scoped bindings"
    )
    expect(
        ManagerCheckPolicy.fullDoctorArguments == ["doctor", "--deep"],
        "an explicit full check must retain Agent-app binding inspection"
    )

    print("manager model checks passed: activity JSON, bounds, monitoring counts, freshness, foreground privacy, tool visibility")
} catch {
    FileHandle.standardError.write(Data("manager model check failed: \(error)\n".utf8))
    exit(1)
}
