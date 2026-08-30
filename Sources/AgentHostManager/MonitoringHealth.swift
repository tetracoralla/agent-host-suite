import Foundation

enum ManagerRefreshPolicy {
    static func shouldRefresh(
        lastSuccessfulRefreshAt: Date?,
        now: Date = Date(),
        maxAge: TimeInterval = 60
    ) -> Bool {
        guard let lastSuccessfulRefreshAt else { return true }
        let age = now.timeIntervalSince(lastSuccessfulRefreshAt)
        return age < 0 || age >= max(0, maxAge)
    }
}

enum MonitoringHealthEvaluator {
    private static let futureTolerance: TimeInterval = 300

    static func evaluate(
        collection: SnapshotCollection,
        refreshedAt: String?,
        maintenanceIntervalSeconds: Int?,
        now: Date = Date()
    ) -> ManagerHealthFacet {
        let problemSources = (collection.sources ?? []).filter { source in
            source.status != "ok" || (source.backlogSources ?? 0) > 0 || (source.skippedLines ?? 0) > 0
        }
        let aggregateProblemCount = (collection.providersPartial ?? 0)
            + (collection.providersMissing ?? 0)
            + (collection.providersError ?? 0)
        let problemCount = (collection.sources?.isEmpty == false)
            ? problemSources.count
            : aggregateProblemCount
        let collectionComplete = collection.status == "completed" && problemCount == 0

        let freshness = freshness(
            refreshedAt: refreshedAt,
            maintenanceIntervalSeconds: maintenanceIntervalSeconds,
            now: now
        )
        let healthy = collectionComplete && freshness.isFresh
        let prefix = collectionComplete ? (freshness.isFresh ? "Complete" : "Stale") : "Partial"
        var details: [String] = []
        if collection.status != nil && collection.status != "completed" {
            details.append("last run \(collection.status ?? "unknown")")
        }
        if problemCount > 0 {
            details.append("\(problemCount) source\(problemCount == 1 ? "" : "s") incomplete")
        }
        details.append(freshness.detail)
        return ManagerHealthFacet(
            id: "monitoring",
            name: "Monitoring",
            isHealthy: healthy,
            detail: "\(prefix) · \(details.joined(separator: ", "))"
        )
    }

    private static func freshness(
        refreshedAt: String?,
        maintenanceIntervalSeconds: Int?,
        now: Date
    ) -> (isFresh: Bool, detail: String) {
        guard let refreshedAt, let refreshed = parseDate(refreshedAt) else {
            return (false, "no refresh time recorded")
        }
        let age = now.timeIntervalSince(refreshed)
        if age < -futureTolerance {
            return (false, "refresh time is in the future")
        }
        let normalizedAge = max(0, age)
        let ageText = ageDescription(normalizedAge)
        if let interval = maintenanceIntervalSeconds, interval > 0,
           normalizedAge > TimeInterval(interval * 2) {
            return (false, "refreshed \(ageText) (stale)")
        }
        return (true, "refreshed \(ageText)")
    }

    private static func parseDate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = fractional.date(from: value) { return parsed }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: value)
    }

    private static func ageDescription(_ age: TimeInterval) -> String {
        if age < 60 { return "just now" }
        if age < 3_600 { return "\(Int(age / 60))m ago" }
        if age < 86_400 { return "\(Int(age / 3_600))h ago" }
        return "\(Int(age / 86_400))d ago"
    }
}
