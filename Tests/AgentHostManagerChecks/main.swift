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
    let updatesPayload = Data(#"""
    {
      "schemaVersion": "openadam.agent-host-updates.v0.1",
      "status": "ok",
      "channel": "stable",
      "items": [{
        "kind": "tool",
        "id": "glyphmark",
        "displayName": "Glyphmark",
        "installedVersion": "1.0.0",
        "availableVersion": "1.1.0",
        "availability": "update-available",
        "logo": { "mediaType": "image/svg+xml", "bytes": 12 }
      }]
    }
    """#.utf8)
    let updates = try JSONDecoder().decode(UpdatesReport.self, from: updatesPayload)
    expect(updates.items?.first?.availability == "update-available", "update reports must keep item availability")
    expect(updates.items?.first?.logo?.mediaType == "image/svg+xml", "update reports must keep logo metadata")
    let summaryWithLogo = ComponentSummary(version: "1.0.0", displayName: "Glyphmark", logo: ToolLogo(path: "logo.svg", mediaType: "image/svg+xml", sha256: nil, bytes: 12, dataUrl: nil, source: nil))
    expect(summaryWithLogo.logo?.path == "logo.svg", "component summaries must carry logo metadata")
    expect(ManagerSection.primaryCases.contains(.updates), "Manager sidebar must include Updates")
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
    expect(ManagerSetupPolicy.profiles.contains("featured"), "Manager setup must admit the featured catalog")
    expect(ManagerSetupPolicy.defaultProfile == "featured", "external setup should offer featured rather than only standard")
    expect(
        !ManagerSetupPolicy.unsignedMacOSGatekeeperNote.contains("until a Developer ID signed build exists"),
        "unsigned preview copy must not promise a future notarized build"
    )
    expect(
        ManagerSetupPolicy.publicDownloadNotConfiguredNote == "Public download is not configured.",
        "unconfigured download UI copy stays short; HTTPS catalog hook belongs in docs, not resident Manager copy"
    )
    expect(
        ManagerSetupPolicy.featuredToolIDs == ["math-anchor", "migratory-time", "armorial"],
        "featured setup must show Armorial with the standard tools"
    )
    expect(
        ManagerSetupPolicy.tools(for: "featured").map(\.id).contains("armorial"),
        "featured setup preview must include Armorial"
    )
    expect(!ManagerSetupPolicy.connectsHost(false), "an undetected Agent app must not block host-later setup")
    expect(!ManagerSetupPolicy.connectsHost(nil), "unknown Agent-app detection must not require a host")
    expect(ManagerSetupPolicy.connectsHost(true), "a detected Agent app may be connected during setup")
    expect(
        ManagerSetupPolicy.setupArguments(profile: "featured", host: "zcode", releaseManifest: nil, dryRun: true)
            == ["setup", "--profile", "featured", "--host", "zcode", "--dry-run"],
        "setupArguments must not hard-code --profile standard"
    )
    expect(
        ManagerSetupPolicy.setupArguments(profile: "standard", host: nil, releaseManifest: "/tmp/current.json", dryRun: false)
            == ["setup", "--profile", "standard", "--no-host", "--release-manifest", "/tmp/current.json"],
        "setup without a detected Agent app must use --no-host"
    )
    expect(
        ManagerSetupPolicy.setupArguments(profile: "observability", host: "codex", releaseManifest: nil, dryRun: true)
            == ["setup", "--profile", "observability", "--host", "codex", "--enable-observability", "--dry-run"],
        "observability setup must pass explicit monitoring consent"
    )
    expect(
        ManagerSetupPolicy.updateArguments(profile: "featured", releaseManifest: "/tmp/current.json", replaceHostConflicts: false, dryRun: true)
            == ["update", "--profile", "featured", "--release-manifest", "/tmp/current.json", "--dry-run"],
        "acquiring featured inventory must reuse update --profile featured"
    )
    expect(
        ManagerSetupPolicy.updateArguments(
            profile: nil,
            releaseManifest: nil,
            replaceHostConflicts: false,
            dryRun: false,
            planId: "sha256:\(String(repeating: "a", count: 64))"
        ) == ["update", "--plan-id", "sha256:\(String(repeating: "a", count: 64))"],
        "applying an update must bind the reviewed plan identity"
    )
    expect(
        ManagerSetupPolicy.repairArguments(replaceHostConflicts: false, dryRun: true)
            == ["repair", "--dry-run"],
        "monitoring and connection repair must not invoke update"
    )
    expect(
        ManagerSetupPolicy.repairArguments(
            replaceHostConflicts: true,
            dryRun: false,
            planId: "sha256:\(String(repeating: "b", count: 64))"
        ) == ["repair", "--replace-host-conflicts", "--plan-id", "sha256:\(String(repeating: "b", count: 64))"],
        "applying a repair must bind the reviewed plan identity without a catalog profile"
    )
    expect(
        ManagerToolPolicy.pauseArguments == ["tools", "pause"]
            && ManagerToolPolicy.resumeArguments == ["tools", "resume"],
        "pause and resume must be dedicated tools actions, not a profile change"
    )
    expect(
        ManagerSourcePolicy.statusArguments() == ["source", "status"]
            && ManagerSourcePolicy.checkArguments() == ["source", "check"]
            && ManagerSourcePolicy.setURLArguments("https://example.invalid/preview-distribution.json")
                == ["source", "set", "--url", "https://example.invalid/preview-distribution.json"]
            && ManagerSourcePolicy.setManifestArguments("/tmp/current.json")
                == ["source", "set", "--release-manifest", "/tmp/current.json"]
            && ManagerSourcePolicy.clearArguments() == ["source", "clear"],
        "Manager source actions must call the source CLI rather than env-only setup"
    )
    expect(
        ManagerSourcePolicy.versionSummary(applicationVersion: "0.2.0", applicationBuild: "3", environmentVersion: "0.1.4")
            == "App 0.2.0 · build 3 · Env 0.1.4",
        "Manager must distinguish application build from environment release"
    )
    expect(
        ManagerSourcePolicy.resolvedReleaseManifest(
            environmentManifest: "/opt/current.json",
            savedPath: "/tmp/current.json",
            savedURL: "https://example.invalid/preview-distribution.json",
            featuredCatalogURL: "https://example.invalid/featured.json"
        ) == "/opt/current.json",
        "an environment release manifest must take precedence over saved locators"
    )
    expect(
        ManagerSourcePolicy.resolvedReleaseManifest(
            environmentManifest: nil,
            savedPath: "/tmp/current.json",
            savedURL: "https://example.invalid/preview-distribution.json",
            featuredCatalogURL: nil
        ) == "/tmp/current.json",
        "a saved local catalog must be usable without an env var"
    )
    expect(
        ManagerSourcePolicy.resolvedReleaseManifest(
            environmentManifest: "",
            savedPath: "",
            savedURL: "https://example.invalid/preview-distribution.json",
            featuredCatalogURL: "https://example.invalid/featured.json"
        ) == "https://example.invalid/preview-distribution.json",
        "empty catalog locators must flatten away and yield to the next source"
    )
    expect(
        ManagerSourcePolicy.resolvedReleaseManifest(
            environmentManifest: nil,
            savedPath: nil,
            savedURL: nil,
            featuredCatalogURL: "https://example.invalid/featured.json"
        ) == "https://example.invalid/featured.json",
        "the featured catalog URL remains a last-resort locator"
    )
    expect(
        ManagerSourcePolicy.resolvedReleaseManifest(
            environmentManifest: "",
            savedPath: nil,
            savedURL: "",
            featuredCatalogURL: nil
        ) == nil,
        "all-empty catalog locators must not invent a path"
    )
    expect(
        ManagerSourcePolicy.recoveryMessage(code: "PREVIEW_DOWNLOAD_DIGEST_MISMATCH").contains("digest"),
        "digest errors must name a recovery path"
    )
    expect(
        ManagerSourcePolicy.recoveryMessage(code: nil).contains("unpublished"),
        "unconfigured source copy must stay unpublished rather than implying a store"
    )
    expect(ManagerSourcePolicy.notNotarizedNote.contains("Not Apple-notarized"), "source copy must not claim notarization")
    let sourceStatus = try JSONDecoder().decode(SourceStatus.self, from: Data(#"""
    {
      "schemaVersion": "openadam.agent-host-source-status.v0.1",
      "status": "unpublished",
      "notarized": false,
      "marketplace": false,
      "publicReleasePublished": false,
      "application": {"kind": "source-checkout", "productName": "Agent Host", "version": "0.2.0", "build": "3"},
      "environment": {"configured": false, "suiteVersion": null},
      "components": [],
      "source": {
        "kind": "unset",
        "unpublished": true,
        "message": "Catalog assets are unpublished. This checkout has no GitHub Release assets. This is not notarized and not a store.",
        "lastCheck": {"status": "unpublished", "code": "PREVIEW_DOWNLOAD_UNPUBLISHED"}
      }
    }
    """#.utf8))
    expect(sourceStatus.notarized == false, "source status must not claim notarization")
    expect(sourceStatus.publicReleasePublished == false, "source status must not claim a public Release")
    expect(sourceStatus.application?.version == "0.2.0", "source status must name the application version")
    expect(sourceStatus.application?.build == "3", "source status must name the application build")
    expect(sourceStatus.environment?.configured == false, "source status must allow an absent environment")
    expect(sourceStatus.source?.unpublished == true, "source status must report unpublished assets")
    let pausedStatus = try JSONDecoder().decode(SuiteStatus.self, from: Data(#"""
    {
      "status": "ok",
      "configured": true,
      "profile": "local-dogfood",
      "availableAgentComponents": ["math-anchor", "migratory-time"],
      "agentComponents": [],
      "agentToolsPaused": true,
      "resumeAgentComponents": ["math-anchor", "migratory-time"]
    }
    """#.utf8))
    expect(pausedStatus.agentToolsPaused == true, "status must decode a fully paused working set")
    expect(pausedStatus.resumeAgentComponents == ["math-anchor", "migratory-time"], "paused status must retain the restore set")
    expect(pausedStatus.agentComponents?.isEmpty == true, "a paused working set may be empty")
    let updatePlan = try JSONDecoder().decode(UpdatePlan.self, from: Data(#"""
    {
      "status": "ready",
      "dryRun": true,
      "fromChannel": "release",
      "toChannel": "release",
      "fromVersion": "0.2.0",
      "toVersion": "0.2.0",
      "releaseId": "fixture",
      "source": {"kind": "bundled-catalog", "releaseId": "fixture", "provenanceSha256": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
      "profile": "featured",
      "profileDisplayName": "Featured tools",
      "changed": ["agent-tool-observer"],
      "componentChanges": [
        {"id": "agent-tool-observer", "action": "downgrade", "currentVersion": "0.6.4", "targetVersion": "0.6.0"}
      ],
      "enabledAgentComponents": [],
      "removedAgentComponents": [],
      "planId": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "activation": {"hosts": {}, "service": {"supported": true}}
    }
    """#.utf8))
    expect(updatePlan.fromVersion == "0.2.0" && updatePlan.toVersion == "0.2.0", "update preview must name current and target suite versions")
    expect(updatePlan.source.kind == "bundled-catalog", "update preview must name the catalog source")
    expect(updatePlan.componentChanges.first?.currentVersion == "0.6.4", "update preview must show the installed component version")
    expect(updatePlan.componentChanges.first?.targetVersion == "0.6.0", "update preview must show the target component version")
    let repairPlan = try JSONDecoder().decode(RepairPlan.self, from: Data(#"""
    {
      "status": "ready",
      "dryRun": true,
      "kind": "repair",
      "suiteVersion": "0.2.0",
      "releaseId": "fixture",
      "profile": "featured",
      "changed": [],
      "componentChanges": [],
      "repairs": {"hosts": ["codex"], "service": true, "monitoring": true},
      "planId": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "activation": {"hosts": {}, "service": {"supported": true}}
    }
    """#.utf8))
    expect(repairPlan.changed.isEmpty && repairPlan.componentChanges.isEmpty, "repair preview must not propose tool version changes")
    expect(repairPlan.repairs.monitoring && repairPlan.repairs.hosts == ["codex"], "repair preview must name connection and monitoring recovery")
    expect(
        ManagerSection.primaryCases.map(\.rawValue) == ["overview", "tools", "updates", "agentApps", "activity"],
        "primary Manager destinations follow Overview → Tools → Updates → Agents → History"
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

    let configuredSuite = try JSONDecoder().decode(SuiteStatus.self, from: Data(#"""
    {
      "configured": true,
      "profile": "featured",
      "hosts": {},
      "components": {}
    }
    """#.utf8))
    let healthyDoctor = try JSONDecoder().decode(DoctorResult.self, from: Data(#"""
    {
      "status": "ok",
      "checks": [
        {"id": "runtime.service", "status": "ok", "message": "Local execution is ready"}
      ]
    }
    """#.utf8))
    let healthyFacets = ManagerHealthPolicy.facets(doctor: healthyDoctor, suite: configuredSuite)
    expect(
        ManagerHealthPolicy.overall(isBusy: false, suite: configuredSuite, doctor: healthyDoctor, facets: healthyFacets) == .ready,
        "a configured suite with no doctor errors may be Ready"
    )

    let catalogDoctor = try JSONDecoder().decode(DoctorResult.self, from: Data(#"""
    {
      "status": "error",
      "checks": [
        {"id": "profile.catalog", "status": "error", "message": "Featured Agent tools are missing from the installed environment"}
      ]
    }
    """#.utf8))
    let catalogFacets = ManagerHealthPolicy.facets(doctor: catalogDoctor, suite: configuredSuite)
    let catalogHealth = ManagerHealthPolicy.overall(
        isBusy: false,
        suite: configuredSuite,
        doctor: catalogDoctor,
        facets: catalogFacets
    )
    expect(catalogHealth != .ready, "a lone profile.catalog error must not report Ready")
    expect(
        catalogFacets.contains(where: { $0.id == "tools" && $0.isHealthy == false }),
        "profile.catalog errors must pull down the tools health facet"
    )
    if case let .attention(message) = catalogHealth {
        expect(message.contains("Tools"), "profile.catalog attention must name the tools surface")
    } else {
        expect(false, "profile.catalog must produce an attention state, not Ready")
    }

    let unknownDoctor = try JSONDecoder().decode(DoctorResult.self, from: Data(#"""
    {
      "status": "error",
      "checks": [
        {"id": "future.unclassified", "status": "error", "message": "A newly added blocking doctor check failed"}
      ]
    }
    """#.utf8))
    let unknownFacets = ManagerHealthPolicy.facets(doctor: unknownDoctor, suite: configuredSuite)
    let unknownHealth = ManagerHealthPolicy.overall(
        isBusy: false,
        suite: configuredSuite,
        doctor: unknownDoctor,
        facets: unknownFacets
    )
    expect(unknownHealth != .ready, "an unknown doctor error category must not default to Ready")
    expect(
        unknownFacets.contains(where: { $0.id == "unclassified-checks" && $0.isHealthy == false }),
        "unmapped doctor errors must appear as an unhealthy environment-check facet"
    )

    UserDefaults.standard.set(ManagerLanguage.simplifiedChinese.rawValue, forKey: ManagerLanguage.storageKey)
    expect(L10n.text("Overview") == "总览", "overview destination must provide Simplified Chinese copy")
    expect(L10n.text("Agents") == "连接 Agent", "agents destination must provide Simplified Chinese copy")
    expect(L10n.text("History") == "记录", "history destination must provide Simplified Chinese copy")
    expect(L10n.text("Advanced") == "高级", "advanced section must provide Simplified Chinese copy")
    expect(L10n.text("Usage") == "使用情况", "the Manager must provide Simplified Chinese product copy")
    expect(L10n.text("Get") == "获取", "featured acquire must provide Simplified Chinese copy")
    expect(L10n.text("Connect later") == "稍后连接", "host-later setup must provide Simplified Chinese copy")
    expect(L10n.text("For new tasks") == "用于新任务", "working-set copy must stay distinct from inventory install")
    expect(L10n.text("Retained trace sessions") == "保留的轨迹会话", "retained trace controls must provide Simplified Chinese copy")
    expect(L10n.locale.identifier.hasPrefix("zh"), "dates must follow the explicit Simplified Chinese Manager language")
    expect(L10n.text("Complete") == "完整" && L10n.text("Running") == "运行中", "dynamic health values must be localized")
    expect(L10n.text("Environment checks") == "环境检查", "unclassified health facets must provide Simplified Chinese copy")
    expect(L10n.text("Unknown") == "未知", "unknown version copy must provide Simplified Chinese once")
    expect(L10n.text("not installed") == "未安装", "absent environment copy must provide Simplified Chinese once")
    expect(L10n.relativeAge(since: now.addingTimeInterval(-120), now: now) == "2 分钟前", "relative time must follow the selected Manager language")
    expect(L10n.format("{count} live suite processes", ["count": "3"]) == "3 个活跃 Suite 进程", "runtime summaries must be localized")
    expect(ManagerLanguage.system.title == "跟随系统", "the language control must expose a system-default choice")
    UserDefaults.standard.set(ManagerLanguage.english.rawValue, forKey: ManagerLanguage.storageKey)
    expect(L10n.text("Usage") == "Usage", "the Manager must allow an explicit English override")
    expect(L10n.locale.identifier.hasPrefix("en"), "dates must follow the explicit English Manager language")

    print("manager model checks passed: activity JSON, bounds, monitoring counts, usage boundaries, localization, freshness, foreground privacy, tool visibility, blocking doctor rollup, featured setup, catalog locator flatten")
} catch {
    FileHandle.standardError.write(Data("manager model check failed: \(error)\n".utf8))
    exit(1)
}
