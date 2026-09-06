import AppKit
import SwiftUI

struct UsageReliabilityView: View {
    @ObservedObject var store: AgentHostStore
    @State private var selectedProvider = "all"
    @State private var copiedAnalysis = false
    @State private var showAllTools = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeader(title: "Usage & Reliability", subtitle: subtitle) {
                    if let usage = store.usage, usage.enabled {
                        Label(freshnessLabel(usage), systemImage: freshnessIcon(usage))
                            .font(.caption.weight(.medium))
                            .foregroundStyle(freshnessColor(usage))
                    }
                }

                if store.usage == nil {
                    ProgressView(L10n.text("Loading monitoring data…"))
                        .frame(maxWidth: .infinity, minHeight: 300)
                } else if store.usage?.enabled != true {
                    ContentUnavailableView(
                        L10n.text("Local monitoring is off"),
                        systemImage: "chart.bar.xaxis",
                        description: Text(L10n.text("Turn on local monitoring in Settings to collect metadata-only activity and reliability observations."))
                    )
                    .frame(maxWidth: .infinity, minHeight: 300)
                } else if let usage = store.usage {
                    if usage.observationSource == "cached-agent-host-refresh" {
                        Panel {
                            NoticeView(
                                title: "Showing the last completed refresh",
                                message: "The live monitoring snapshot is temporarily unavailable. No stale result is presented as current.",
                                systemImage: "clock.badge.exclamationmark",
                                color: .orange
                            )
                        }
                    }

                    tools(usage)
                    versionHistory(usage)
                    reliability(usage)
                    providerActivity(usage)
                    DisclosureGroup(L10n.text("Collection details")) {
                        VStack(alignment: .leading, spacing: 20) {
                            traceCoverage(usage)
                            coverage(usage)
                            RetainedTraceSessionsView(store: store, usage: usage)
                        }
                        .padding(.top, 12)
                    }
                }
            }
            .frame(maxWidth: 860, alignment: .leading)
            .padding(32)
        }
    }

    @ViewBuilder private func traceCoverage(_ usage: UsageSummary) -> some View {
        Panel {
            Text(L10n.text("Agent trace coverage")).font(.headline)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), alignment: .leading)], alignment: .leading, spacing: 12) {
                ActivityMetric(value: usage.trace.modelSteps, label: L10n.text("Model steps"))
                ActivityMetric(value: usage.trace.toolOffers, label: L10n.text("Tool offers"))
                ActivityMetric(value: usage.trace.toolCalls, label: L10n.text("Trace tool calls"))
                ActivityMetric(value: usage.trace.toolResults, label: L10n.text("Trace tool results"))
                ActivityMetric(value: usage.trace.turnEnds, label: L10n.text("Turn endings"))
            }
            ForEach(usage.trace.adapters, id: \.identifier) { adapter in
                Divider()
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(agentName(adapter.provider ?? "unknown"))
                        Text(traceTransport(adapter.transport))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(traceStatus(adapter.status))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(traceColor(adapter.status))
                }
            }
            Text(L10n.text("Offered, called, and returned are separate recorded facts. They do not establish why a tool was chosen, whether its result was adopted, or whether the work was correct."))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var subtitle: String? {
        guard let usage = store.usage, usage.enabled else { return nil }
        guard let days = usage.windowDays else { return L10n.text("Local metadata only") }
        return L10n.format("Observed locally over the last {days} days", ["days": days.formatted()])
    }

    @ViewBuilder private func providerActivity(_ usage: UsageSummary) -> some View {
        let providers = providerIDs(usage)
        Panel {
            Text(L10n.text("Agent activity")).font(.headline)
            if providers.isEmpty {
                Text(L10n.text("No supported Agent activity was observed in this window."))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(providers, id: \.self) { provider in
                    let activity = usage.providerActivity.first { $0.provider == provider }
                    let tokens = usage.providerUsage.first { $0.provider == provider }
                    VStack(alignment: .leading, spacing: 7) {
                        HStack {
                            Text(agentName(provider)).font(.headline)
                            Spacer()
                            Text(healthLabel(usage, provider: provider))
                                .font(.caption.weight(.medium))
                                .foregroundStyle(healthColor(usage, provider: provider))
                        }
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), alignment: .leading)], alignment: .leading, spacing: 12) {
                            ActivityMetric(value: tokens?.totalTokens, label: L10n.text("Reported tokens"))
                            ActivityMetric(value: tokens?.peakObservedDailyTokens, label: L10n.text("Peak UTC day"))
                            ActivityMetric(value: activity?.observedSessions, label: L10n.text("Sessions"))
                            ActivityMetric(value: activity?.observedTurns, label: L10n.text("Turns"))
                            ActivityMetric(value: activity?.currentObservedDayStreak, label: L10n.text("Current streak"))
                            ActivityMetric(value: activity?.longestObservedDayStreak, label: L10n.text("Longest streak"))
                        }
                        DailyHeatStrip(entries: Array((usage.dailyActivity?.entries ?? []).filter { $0.provider == provider }.suffix(30)))
                        Text(L10n.format("{days} active UTC days · session span is not chat duration", ["days": (activity?.observedActiveDays ?? 0).formatted()]))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if provider == "claude", tokens?.totalTokens != nil {
                            Text(L10n.text("Claude totals exclude separately reported cache-read tokens."))
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .accessibilityElement(children: .contain)
                    if provider != providers.last { Divider() }
                }
            }
        }
    }

    @ViewBuilder private func reliability(_ usage: UsageSummary) -> some View {
        Panel {
            Text(L10n.text("Observed outcomes")).font(.headline)
            HStack(spacing: 26) {
                ActivityMetric(value: usage.reliability.measuredToolCalls, label: L10n.text("Measured calls"))
                ActivityMetric(value: usage.reliability.completedToolCalls, label: L10n.text("Completed"))
                ActivityMetric(value: usage.reliability.toolErrors, label: L10n.text("Errors"))
                ActivityMetric(value: usage.reliability.toolCancellations, label: L10n.text("Cancelled"))
            }
            Text(L10n.text("Outcome counts cover mapped Agent Host tools with provider-reported runtime state; an unmeasured call is not treated as success."))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func tools(_ usage: UsageSummary) -> some View {
        let displayed = Array(usage.tools.entries.prefix(showAllTools ? usage.tools.entries.count : 8))
        Panel {
            HStack {
                Text(L10n.text("Tool activity")).font(.headline)
                Spacer()
                if usage.tools.available > displayed.count {
                    Text(L10n.format("Top {shown} of {available}", ["shown": displayed.count.formatted(), "available": usage.tools.available.formatted()]))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if displayed.isEmpty {
                Text(L10n.text("No mapped Agent Host tool calls were observed in this window."))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(displayed.enumerated()), id: \.element.id) { index, tool in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(toolName(tool.toolName)).lineLimit(1)
                            Text([agentName(tool.provider ?? "unknown"), tool.componentVersion.map { L10n.format("Installed {version}", ["version": $0]) }].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(L10n.format("{count} observations", ["count": (tool.historicalCalls ?? 0).formatted()])).monospacedDigit()
                            if let count = tool.currentBindingCalls {
                                Text(L10n.format("{count} since this binding", ["count": count.formatted()]))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            if let count = tool.referencedCalls, count > 0 {
                                Text(L10n.format("{count} from script references", ["count": count.formatted()]))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if index < displayed.count - 1 { Divider() }
                }
                if usage.tools.entries.count > 8 {
                    Button(L10n.text(showAllTools ? "Show less" : "Show more tools")) { showAllTools.toggle() }
                        .buttonStyle(.link)
                }
                Text(L10n.text("Script references do not prove execution. Binding counts may include older open sessions; unrelated tool updates do not restart this window."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private func versionHistory(_ usage: UsageSummary) -> some View {
        Panel {
            HStack {
                Text(L10n.text("Version history")).font(.headline)
                Spacer()
                Button(L10n.text(copiedAnalysis ? "Analysis request copied" : "Copy analysis request")) {
                    let prompt = L10n.text("Use the installed Agent Host operations skill to read the current usage report. Analyze tool activity, version history, runtime errors, collection coverage, and unknowns. Separate tasks from diagnostics and script references from observed execution. Compare findings with the current task before proposing changes; do not infer adoption or correctness from counts alone.")
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(prompt, forType: .string)
                    copiedAnalysis = true
                }
                .buttonStyle(.bordered)
            }
            if let history = usage.versionHistory, !history.entries.isEmpty {
                let providers = Array(Set(history.entries.compactMap(\.providerId))).sorted()
                Picker(L10n.text("Tool"), selection: $selectedProvider) {
                    Text(L10n.text("All tools")).tag("all")
                    ForEach(providers, id: \.self) { provider in
                        Text(providerName(provider)).tag(provider)
                    }
                }
                .frame(maxWidth: 320)
                ForEach(history.entries.filter { selectedProvider == "all" || $0.providerId == selectedProvider }) { entry in
                    Divider()
                    HStack(alignment: .top, spacing: 16) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(providerName(entry.providerId)) · \(entry.providerVersion ?? "—")").fontWeight(.medium)
                            Text(purposeName(entry.purpose)).font(.caption).foregroundStyle(.secondary)
                            if let time = entry.lastObservedAtMs {
                                Text(Date(timeIntervalSince1970: Double(time) / 1000), format: .dateTime.year().month().day().hour().minute())
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 3) {
                            Text(L10n.format("{count} executions", ["count": (entry.executions ?? 0).formatted()])).monospacedDigit()
                            let errors = (entry.providerErrors ?? 0) + (entry.hostErrors ?? 0)
                            if errors > 0 {
                                Text(L10n.format("{count} runtime errors", ["count": errors.formatted()])).foregroundStyle(.orange)
                            }
                            if let partial = entry.partialResults, partial > 0 {
                                Text(L10n.format("{count} partial results · {items} failed items", ["count": partial.formatted(), "items": (entry.itemErrors ?? 0).formatted()])).foregroundStyle(.orange)
                            }
                            if entry.reportedOutcomes == 0 {
                                Text(L10n.text("Result details unavailable")).foregroundStyle(.secondary)
                            }
                        }
                        .font(.caption)
                    }
                    .accessibilityElement(children: .combine)
                }
                if history.truncated {
                    Text(L10n.format("Showing {shown} of {available} version groups", ["shown": history.returned.formatted(), "available": history.available.formatted()]))
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Text(L10n.text("No version-attributed execution history is available yet.")).foregroundStyle(.secondary)
            }
            Text(L10n.text("Version totals survive updates and raw-event cleanup. Earlier deleted records cannot be recovered. Paste the analysis request into your Agent to interpret the current data."))
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func providerName(_ id: String?) -> String {
        switch id?.split(separator: ".").last.map(String.init) {
        case "math-anchor": "Math Anchor"
        case "migratory-time": "Migratory Time"
        case "icon-svg-select", "armorial": "Armorial"
        case "laniakea": "Laniakea"
        case "batchticket": "Data Transformer"
        case "file-vitals": "File Vitals"
        case "text-integrity": "Text Integrity"
        case .some(let name): name.replacingOccurrences(of: "-", with: " ").localizedCapitalized
        case nil: L10n.text("Unknown")
        }
    }

    private func purposeName(_ purpose: String?) -> String {
        switch purpose {
        case "task": L10n.text("Agent task")
        case "diagnostic": L10n.text("Health check")
        case "validation": L10n.text("Validation")
        default: L10n.text("Purpose not recorded")
        }
    }

    @ViewBuilder private func coverage(_ usage: UsageSummary) -> some View {
        Panel {
            Text(L10n.text("What monitoring can tell you")).font(.headline)
            CoverageRow(label: L10n.text("Tool calls"), item: usage.coverage.toolInvocation)
            CoverageRow(label: L10n.text("Runtime outcomes"), item: usage.coverage.runtimeOutcome)
            CoverageRow(label: L10n.text("Token usage"), item: usage.coverage.tokenUsage)
            Divider()
            CoverageRow(label: L10n.text("Skill activation"), item: usage.coverage.skillUse)
            CoverageRow(label: L10n.text("Result adoption"), item: usage.coverage.resultAdoption)
            CoverageRow(label: L10n.text("Why a tool was not used"), item: usage.coverage.nonUseReason)
            Text(L10n.text("No prompts, tool arguments, tool results, or source paths are returned. The Observer makes no model calls and performs no causal or quality assessment."))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func providerIDs(_ usage: UsageSummary) -> [String] {
        var seen = Set<String>()
        return (usage.providerActivity.compactMap(\.provider) + usage.providerUsage.compactMap(\.provider))
            .filter { seen.insert($0).inserted }
    }

    private func agentName(_ id: String) -> String { ManagerAgentApp.named(id).name }

    private func traceTransport(_ value: String?) -> String {
        switch value {
        case "public-events": L10n.text("Public events")
        case "opentelemetry": "OpenTelemetry"
        case "official-hooks": L10n.text("Official hooks")
        case "stable-local-records": L10n.text("Local records")
        case "aggregate-store": L10n.text("Aggregate usage")
        default: L10n.text("Unavailable")
        }
    }

    private func traceStatus(_ value: String) -> String {
        switch value {
        case "ok": L10n.text("Current")
        case "partial": L10n.text("Partial")
        case "error": L10n.text("Needs attention")
        case "missing", "unavailable": L10n.text("Unavailable")
        case "unconfigured": L10n.text("Not configured")
        default: L10n.text("Unknown")
        }
    }

    private func traceColor(_ value: String) -> Color {
        if value == "ok" { return .green }
        if value == "unconfigured" { return .secondary }
        return .orange
    }

    private func toolName(_ name: String?) -> String {
        guard let name else { return L10n.text("Unknown tool") }
        return name.replacingOccurrences(of: "mcp__", with: "").replacingOccurrences(of: "__", with: " · ")
    }

    private func healthLabel(_ usage: UsageSummary, provider: String) -> String {
        switch usage.providerHealth.first(where: { $0.provider == provider })?.status {
        case "ok": L10n.text("Current")
        case "partial": L10n.text("Partial")
        case "missing": L10n.text("Unavailable")
        case "error": L10n.text("Needs attention")
        default: L10n.text("Unknown")
        }
    }

    private func healthColor(_ usage: UsageSummary, provider: String) -> Color {
        usage.providerHealth.first { $0.provider == provider }?.status == "ok" ? .green : .orange
    }

    private func freshnessLabel(_ usage: UsageSummary) -> String {
        switch usage.freshness?.status {
        case "current": L10n.text("Current")
        case "overdue": L10n.text("Overdue")
        default: L10n.text(usage.observationSource == "cached-agent-host-refresh" ? "Cached" : "Freshness unknown")
        }
    }

    private func freshnessIcon(_ usage: UsageSummary) -> String {
        usage.freshness?.status == "current" ? "checkmark.circle.fill" : "clock.badge.exclamationmark"
    }

    private func freshnessColor(_ usage: UsageSummary) -> Color {
        usage.freshness?.status == "current" ? .green : .orange
    }
}

private struct DailyHeatStrip: View {
    let entries: [UsageDailyEntry]

    var body: some View {
        if !entries.isEmpty {
            let maximum = max(1, entries.compactMap { $0.totalTokens ?? Int64($0.toolCalls ?? 0) }.max() ?? 1)
            HStack(spacing: 4) {
                ForEach(entries) { entry in
                    let value = entry.totalTokens ?? Int64(entry.toolCalls ?? 0)
                    RoundedRectangle(cornerRadius: 2.5)
                        .fill(Color.blue.opacity(0.18 + (0.82 * Double(value) / Double(maximum))))
                        .frame(maxWidth: .infinity, minHeight: 11, maxHeight: 11)
                        .help(L10n.format("{date} · {tokens} tokens · {calls} tool calls", [
                            "date": entry.utcDate ?? L10n.text("Unknown"),
                            "tokens": entry.totalTokens?.formatted() ?? L10n.text("Unavailable"),
                            "calls": (entry.toolCalls ?? 0).formatted(),
                        ]))
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(L10n.text("Daily activity for the latest observed UTC days"))
        }
    }
}

private struct ActivityMetric<Value: BinaryInteger>: View {
    let value: Value?
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value?.formatted() ?? "—")
                .font(.title3.weight(.semibold))
                .monospacedDigit()
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct CoverageRow: View {
    let label: String
    let item: UsageCoverageItem

    var body: some View {
        LabeledContent(label) {
            Text(displayStatus).foregroundStyle(isObserved ? .primary : .secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var isObserved: Bool { ["observed", "partial"].contains(item.status) }

    private var displayStatus: String {
        switch item.status {
        case "observed": L10n.text("Observed")
        case "partial": L10n.text("Partially observed")
        case "no-observations": L10n.text("No observations")
        case "not-observed": L10n.text("Not observed")
        case "unavailable": L10n.text("Unavailable")
        default: item.status.replacingOccurrences(of: "-", with: " ").localizedCapitalized
        }
    }
}
