import Foundation

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        FileHandle.standardError.write(Data("manager model check failed: \(message)\n".utf8))
        exit(1)
    }
}

do {
    let previousLanguage = UserDefaults.standard.string(forKey: ManagerLanguage.storageKey)
    UserDefaults.standard.set(ManagerLanguage.english.rawValue, forKey: ManagerLanguage.storageKey)
    defer {
        if let previousLanguage {
            UserDefaults.standard.set(previousLanguage, forKey: ManagerLanguage.storageKey)
        } else {
            UserDefaults.standard.removeObject(forKey: ManagerLanguage.storageKey)
        }
    }
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

    let recoveryFailure = try JSONDecoder().decode(PublicFailure.self, from: Data(#"""
    {
      "status": "error",
      "error": {
        "code": "SERVICE_INSTALL_ROLLBACK_FAILED",
        "message": "The local execution service failed and its previous state could not be restored",
        "details": {
          "recovery": {
            "action": {
              "command": "agent-host",
              "arguments": [
                "service", "recover",
                "--recovery", "service-recovery-v2-00000000-0000-4000-8000-000000000000",
                "--manifest-sha256", "sha256:0000000000000000000000000000000000000000000000000000000000000000"
              ]
            }
          }
        }
      }
    }
    """#.utf8))
    expect(
        recoveryFailure.error.recoveryInstruction?.hasPrefix("agent-host service recover --recovery service-recovery-v2-") == true,
        "a service rollback failure must preserve its executable path-free recovery action"
    )

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
    let importedTools = [
        "math-anchor": ComponentSummary(version: "0.4.0", displayName: "Math Anchor", summary: nil),
        "text-integrity": ComponentSummary(version: "1.0.0", displayName: "Text Integrity", summary: "Inspect text"),
    ]
    expect(
        ManagerToolPolicy.visibleToolIDs(
            components: importedTools,
            availableAgentComponents: ["math-anchor", "text-integrity"],
            activeAgentComponents: ["math-anchor", "text-integrity"],
            orderedIDs: ["math-anchor"]
        ) == ["math-anchor", "text-integrity"],
        "an admitted private Agent tool must remain visible without a Manager code change"
    )
    expect(
        ManagerToolPolicy.orderedToolIDs(
            ["text-integrity", "math-anchor"],
            preferredOrder: ["math-anchor"]
        ) == ["math-anchor", "text-integrity"],
        "tool-set changes must retain unknown admitted tools after the preferred built-in order"
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
        ManagerSection.allCases.map(\.rawValue) == ["overview", "tools", "agentApps", "usage", "activity"],
        "usage and reliability must be a first-class Manager destination"
    )

    let usagePayload = Data(#"""
    {
      "configured": true,
      "enabled": true,
      "generatedAt": "2026-09-02T00:00:00.000Z",
      "windowDays": 30,
      "observationSource": "current-observer-snapshots",
      "currentReadErrorCode": null,
      "freshness": {"status": "current", "ageMs": 1, "overdueAfterMs": 2},
      "providerHealth": [{"provider": "zcode", "status": "ok", "errorCode": null, "scannedAtMs": 1}],
      "providerUsage": [{"provider": "zcode", "records": 2, "inputTokens": 10, "cachedInputTokens": 4, "outputTokens": 2, "reasoningTokens": 1, "totalTokens": 12, "averageDurationMs": 20.5, "semantics": "provider-reported", "peakObservedDailyTokens": 12, "peakObservedDailyDate": "2026-09-02", "dailyTokenSemantics": "provider-records-grouped-by-utc-day"}],
      "providerActivity": [{"provider": "zcode", "observedSessions": 1, "observedTurns": 2, "observedActiveDays": 1, "firstObservedAtMs": 1, "lastObservedAtMs": 2, "longestObservedSessionSpanMs": 1, "currentObservedDayStreak": 1, "longestObservedDayStreak": 3}],
      "dailyActivity": {"returned": 1, "available": 1, "limit": 120, "truncated": false, "entries": [{"provider": "zcode", "utcDate": "2026-09-02", "toolCalls": 4, "usageRecords": 2, "observedSessions": 1, "observedTurns": 2, "inputTokens": 10, "cachedInputTokens": 4, "outputTokens": 2, "reasoningTokens": 1, "totalTokens": 12}]},
      "tools": {"returned": 1, "available": 1, "limit": 20, "entries": [{"provider": "zcode", "toolName": "mcp__math_anchor__math_run", "historicalCalls": 4, "measuredCalls": 4, "completed": 3, "errors": 1, "cancelled": 0, "averageDurationMs": 2.5, "currentReleaseCalls": 2, "currentReleaseFreshSessionCalls": 1, "currentReleaseStatus": "observed", "firstObservedAtMs": 1, "lastObservedAtMs": 2}]},
      "trace": {"adaptersReturned": 1, "adaptersAvailable": 7, "adapters": [{"id": "openadam.zcode-model-io", "provider": "zcode", "transport": "stable-local-records", "status": "ok", "errorCode": null, "scannedAtMs": 2, "eventsWritten": 9, "backlogSources": 0}], "providersObserved": 1, "modelSteps": 3, "toolOffers": 5, "toolCalls": 2, "toolResults": 2, "turnEnds": 0, "passiveStorage": "metadata-only", "interpretationStatus": "not-performed"},
      "reliability": {"measuredToolCalls": 4, "completedToolCalls": 3, "toolErrors": 1, "toolCancellations": 0, "semanticExecutions": 0, "semanticCompleted": 0, "semanticProviderErrors": 0, "semanticHostErrors": 0},
      "coverage": {
        "toolInvocation": {"status": "observed", "basis": "metadata", "reason": null},
        "runtimeOutcome": {"status": "partial", "basis": null, "reason": null},
        "tokenUsage": {"status": "partial", "basis": null, "reason": null},
        "skillUse": {"status": "unavailable", "basis": null, "reason": "not exposed"},
        "semanticEffect": {"status": "not-observed", "basis": null, "reason": null},
        "resultAdoption": {"status": "not-observed", "basis": null, "reason": null},
        "nonUseReason": {"status": "not-observed", "basis": null, "reason": null}
      },
      "assessmentBoundary": "No causal assessment."
    }
    """#.utf8)
    let usage = try JSONDecoder().decode(UsageSummary.self, from: usagePayload)
    expect(usage.providerActivity.first?.observedSessions == 1, "provider activity must decode")
    expect(usage.providerUsage.first?.totalTokens == 12, "provider-specific token totals must decode without aggregation")
    expect(usage.providerUsage.first?.averageDurationMs == 20.5, "provider average duration must decode from the current usage contract")
    expect(usage.providerActivity.first?.longestObservedDayStreak == 3, "provider streaks must decode")
    expect(usage.dailyActivity?.entries.first?.totalTokens == 12, "bounded daily activity must decode")
    expect(usage.tools.entries.first?.errors == 1, "tool outcome counts must decode")
    expect(usage.trace.adapters.first?.identifier == "openadam.zcode-model-io", "trace adapter identity must decode")
    expect(usage.trace.modelSteps == 3 && usage.trace.toolOffers == 5, "trace coverage totals must decode")
    expect(usage.trace.passiveStorage == "metadata-only", "passive trace storage must remain metadata-only")
    expect(usage.coverage.skillUse.status == "unavailable", "Skill activation must remain unavailable")
    expect(usage.coverage.resultAdoption.status == "not-observed", "result adoption must remain unobserved")

    let traceSourcePayload = Data(#"""
    {
      "schemaVersion": "openadam.agent-host-trace-source-catalog.v0.1",
      "status": "ok",
      "generatedAt": "2026-09-03T00:00:00.000Z",
      "provider": "zcode",
      "requestedRange": {"fromMs": null, "toMs": null},
      "retention": {"retentionDays": 30, "currentCutoffMs": 1, "eventsBeforeCutoffMayHaveBeenRemoved": true, "collectionBeforeMonitoringWasEnabled": "unavailable"},
      "privacy": {"contentPolicy": "metadata-only", "sourcePathIncluded": false, "rawConversationContentIncluded": false, "toolArgumentsIncluded": false, "toolResultsIncluded": false},
      "limits": {"maxSources": 25, "sourceLimitReached": false, "sourcesReturned": 1},
      "sources": [{"sessionHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "firstEventAtMs": 10, "lastEventAtMs": 20, "totalEvents": 3, "modelSteps": 1, "toolCalls": 1, "toolResults": 1, "turnEnds": 0, "completeness": "unknown"}],
      "unknowns": ["semantic-correctness", "result-adoption"],
      "interpretationStatus": "not-performed"
    }
    """#.utf8)
    let traceSources = try JSONDecoder().decode(TraceSourceCatalog.self, from: traceSourcePayload)
    expect(traceSources.provider == "zcode", "retained trace source provider must decode")
    expect(traceSources.sources.first?.totalEvents == 3, "retained trace event counts must decode")
    expect(traceSources.sources.first?.completeness == "unknown", "retained trace completeness must remain explicit")
    expect(traceSources.retention.eventsBeforeCutoffMayHaveBeenRemoved, "retention loss must remain explicit")
    expect(traceSources.isValid(expectedProvider: "zcode"), "retained trace catalog must preserve its metadata-only carrier contract")
    expect(!traceSources.isValid(expectedProvider: "codex"), "retained trace catalog must not cross provider selection")
    let emptyTraceSourcePayload = Data(String(data: traceSourcePayload, encoding: .utf8)!.replacingOccurrences(of: "\"totalEvents\": 3", with: "\"totalEvents\": 0").replacingOccurrences(of: "\"modelSteps\": 1, \"toolCalls\": 1, \"toolResults\": 1", with: "\"modelSteps\": 0, \"toolCalls\": 0, \"toolResults\": 0").utf8)
    let emptyTraceSources = try JSONDecoder().decode(TraceSourceCatalog.self, from: emptyTraceSourcePayload)
    expect(!emptyTraceSources.isValid(expectedProvider: "zcode"), "a retained trace catalog must not expose an empty session")

    let retainedPackData = Data(#"{"schemaVersion":"openadam.agent-host-trace-analysis-pack.v0.2","source":{"provider":"zcode","selectionKind":"observer-retained-session","sessionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"privacy":{"contentPolicy":"metadata-only","selectedConversationContentIncluded":false,"sensitiveContentConfirmed":false,"transportSecretsExcluded":true,"selectedContentMayContainUserSecrets":false,"observerPackRetained":false,"sourceUsesObserverRetainedMetadata":true,"sourcePathIncluded":false,"toolArgumentsIncluded":false,"toolResultsIncluded":false},"limits":{"eventsReturned":0,"eventsAvailable":0},"events":[],"interpretationStatus":"not-performed"}"#.utf8)
    let retainedReceipt = TraceExportReceipt(
        status: "completed",
        schemaVersion: TraceContractValidator.retainedPackVersion,
        outputPath: "/private/trace.json",
        outputBytes: retainedPackData.count,
        eventsReturned: 0,
        eventsAvailable: 0,
        contentPolicy: "metadata-only",
        observerPackRetained: false,
        sourcePathStoredInPack: false,
        interpretationStatus: "not-performed"
    )
    expect(
        TraceContractValidator.isValidRetainedExport(
            data: retainedPackData,
            receipt: retainedReceipt,
            outputPath: "/private/trace.json",
            provider: "zcode",
            sessionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ),
        "the saved trace bytes must agree with their receipt and metadata-only promise"
    )
    let selectedContentPack = Data(String(data: retainedPackData, encoding: .utf8)!.replacingOccurrences(of: "metadata-only", with: "selected-content").utf8)
    expect(
        !TraceContractValidator.isValidRetainedExport(
            data: selectedContentPack,
            receipt: retainedReceipt,
            outputPath: "/private/trace.json",
            provider: "zcode",
            sessionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ),
        "a file that contradicts its metadata-only receipt must be rejected"
    )

    expect(
        ManagerAgentApp.all.map(\.id) == ["zcode", "codex", "claude"],
        "trace-only providers must not appear as connectable Agent apps"
    )
    expect(ManagerAgentApp.named("deepseek-harness").name == "DeepSeek Harness", "trace providers still need human-readable names")
    expect(ManagerAgentApp.named("gemini-cli").name == "Gemini CLI", "trace providers still need human-readable names")
    expect(ManagerAgentApp.named("github-copilot-cli").name == "GitHub Copilot CLI", "trace providers still need human-readable names")
    expect(
        ManagerAgentApp.named("zcode").name == "ZCode",
        "ZCode must retain its product name in setup, health, and activity views"
    )
    expect(
        ManagerCheckPolicy.fullDoctorArguments == ["doctor", "--deep"],
        "an explicit full check must retain Agent-app binding inspection"
    )

    UserDefaults.standard.set(ManagerLanguage.simplifiedChinese.rawValue, forKey: ManagerLanguage.storageKey)
    expect(L10n.text("Usage & Reliability") == "使用情况与可靠性", "the Manager must provide Simplified Chinese product copy")
    expect(L10n.text("Retained trace sessions") == "保留的轨迹会话", "retained trace controls must provide Simplified Chinese copy")
    expect(L10n.locale.identifier.hasPrefix("zh"), "dates must follow the explicit Simplified Chinese Manager language")
    expect(L10n.text("Complete") == "完整" && L10n.text("Running") == "运行中", "dynamic health values must be localized")
    expect(L10n.relativeAge(since: now.addingTimeInterval(-120), now: now) == "2 分钟前", "relative time must follow the selected Manager language")
    expect(L10n.format("{count} live suite processes", ["count": "3"]) == "3 个活跃 Suite 进程", "runtime summaries must be localized")
    expect(ManagerLanguage.system.title == "跟随系统", "the language control must expose a system-default choice")
    UserDefaults.standard.set(ManagerLanguage.english.rawValue, forKey: ManagerLanguage.storageKey)
    expect(L10n.text("Usage & Reliability") == "Usage & Reliability", "the Manager must allow an explicit English override")
    expect(L10n.locale.identifier.hasPrefix("en"), "dates must follow the explicit English Manager language")

    print("manager model checks passed: activity JSON, bounds, monitoring counts, usage boundaries, localization, freshness, foreground privacy, tool visibility")
} catch {
    FileHandle.standardError.write(Data("manager model check failed: \(error)\n".utf8))
    exit(1)
}
