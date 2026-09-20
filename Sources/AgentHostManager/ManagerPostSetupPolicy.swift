import Foundation

struct ManagerPostSetupGuidance: Equatable, Sendable {
    enum ProblemClass: String, Equatable, Sendable {
        case notConnected = "not-connected"
        case staleSession = "stale-session"
        case permission = "permission"
        case toolFault = "tool-fault"
        case toolsPaused = "tools-paused"
        case unverified = "unverified"
    }

    enum PrimaryActionID: String, Equatable, Sendable {
        case openApp = "open-app"
        case startNewAgentTask = "start-new-agent-task"
        case connectAgent = "connect-agent"
        case reviewRepair = "review-repair"
        case runFullCheck = "run-full-check"
        case openTools = "open-tools"
        case resumeTools = "resume-tools"
        case grantWorkspace = "grant-workspace"
    }

    enum StatusTone: String, Equatable, Sendable {
        case ready
        case action
        case paused
        case fault
    }

    let readyToWork: Bool
    let problemClass: ProblemClass?
    let statusLine: String
    let statusTone: StatusTone
    let title: String
    let summary: String
    let observed: [String]
    let gaps: [String]
    let primaryActionID: PrimaryActionID
    let primaryActionLabel: String
    let primaryActionDetail: String
    let hint: String?
    let recoveryPath: String
    let primaryHostID: String?
    /// Destination is starting work, not a green status checklist.
    let destinationIsWork: Bool
}

enum ManagerPostSetupPolicy {
    static func guidance(
        configured: Bool,
        connectedHostNames: [String],
        installedToolCount: Int,
        activeToolCount: Int,
        agentToolsPaused: Bool,
        needsFreshTask: Bool,
        agentAppsVerified: Bool?,
        doctorBlockingErrors: [(id: String, message: String)],
        justInstalled: Bool,
        primaryHostName: String?,
        primaryHostID: String? = nil
    ) -> ManagerPostSetupGuidance {
        guard configured else {
            return ManagerPostSetupGuidance(
                readyToWork: false,
                problemClass: nil,
                statusLine: "Set up tools",
                statusTone: .action,
                title: "Set up tools",
                summary: "Install a tool set first.",
                observed: [],
                gaps: ["No Agent environment is installed yet."],
                primaryActionID: .runFullCheck,
                primaryActionLabel: "Set up",
                primaryActionDetail: "",
                hint: nil,
                recoveryPath: "Complete setup, then return here to start work.",
                primaryHostID: primaryHostID,
                destinationIsWork: true
            )
        }

        var observed: [String] = []
        if justInstalled {
            observed.append("Host finished installing the selected tool set on this Mac.")
        } else {
            observed.append("An Agent environment is installed on this Mac.")
        }
        if installedToolCount > 0 {
            observed.append("Host can see \(installedToolCount) installed tool package\(installedToolCount == 1 ? "" : "s").")
        } else {
            observed.append("Host does not yet see installed Agent tool packages in this environment.")
        }
        if agentToolsPaused {
            observed.append("Ordinary Agent tools are fully paused for new tasks.")
        } else if activeToolCount > 0 {
            observed.append("Host selected \(activeToolCount) tool\(activeToolCount == 1 ? "" : "s") for new Agent tasks.")
        } else if installedToolCount > 0 {
            observed.append("Tools are installed, but none are selected for new Agent tasks.")
        }
        if connectedHostNames.isEmpty {
            observed.append("No Agent app is connected yet.")
        } else {
            observed.append("Connected Agent app\(connectedHostNames.count == 1 ? "" : "s"): \(connectedHostNames.joined(separator: ", ")).")
        }
        if agentAppsVerified == true {
            observed.append("Full Check verified current Agent-app bindings.")
        } else if agentAppsVerified == false && !connectedHostNames.isEmpty {
            observed.append("Connected Agent-app bindings need attention.")
        }

        var gaps = ["Host cannot confirm that an already-open Agent task has loaded these tools."]
        let app = primaryHostName ?? connectedHostNames.first

        if let fault = classifyFault(doctorBlockingErrors) {
            gaps.append(fault.summary)
            return ManagerPostSetupGuidance(
                readyToWork: false,
                problemClass: fault.problemClass,
                statusLine: fault.statusLine,
                statusTone: .fault,
                title: fault.title,
                summary: fault.summary,
                observed: observed,
                gaps: gaps,
                primaryActionID: fault.action,
                primaryActionLabel: label(for: fault.action, appName: app),
                primaryActionDetail: "",
                hint: nil,
                recoveryPath: fault.recoveryPath,
                primaryHostID: primaryHostID,
                destinationIsWork: true
            )
        }

        if connectedHostNames.isEmpty {
            gaps.append("Connect an Agent app before expecting tools in a session.")
            return ManagerPostSetupGuidance(
                readyToWork: false,
                problemClass: .notConnected,
                statusLine: "Connect Agent to use",
                statusTone: .action,
                title: "Connect Agent to use",
                summary: "Tools are on this Mac, but no Agent app is connected yet.",
                observed: observed,
                gaps: gaps,
                primaryActionID: .connectAgent,
                primaryActionLabel: label(for: .connectAgent, appName: nil),
                primaryActionDetail: "",
                hint: nil,
                recoveryPath: "Open Agents → Connect a supported app → start a new task in that app. Old tasks will not pick this up.",
                primaryHostID: primaryHostID,
                destinationIsWork: true
            )
        }

        if agentToolsPaused {
            gaps.append("Resume tools for new tasks before starting work.")
            return ManagerPostSetupGuidance(
                readyToWork: false,
                problemClass: .toolsPaused,
                statusLine: "Tools paused",
                statusTone: .paused,
                title: "Tools paused",
                summary: "Ordinary tools are paused.",
                observed: observed,
                gaps: gaps,
                primaryActionID: .resumeTools,
                primaryActionLabel: label(for: .resumeTools, appName: app),
                primaryActionDetail: "",
                hint: nil,
                recoveryPath: "Resume tools, then open a new Agent task.",
                primaryHostID: primaryHostID,
                destinationIsWork: true
            )
        }

        if installedToolCount > 0 && activeToolCount == 0 {
            gaps.append("Select tools for new tasks before starting work.")
            return ManagerPostSetupGuidance(
                readyToWork: false,
                problemClass: .toolsPaused,
                statusLine: "No tools selected",
                statusTone: .action,
                title: "No tools selected",
                summary: "Choose a working set for new tasks.",
                observed: observed,
                gaps: gaps,
                primaryActionID: .openTools,
                primaryActionLabel: label(for: .openTools, appName: app),
                primaryActionDetail: "",
                hint: nil,
                recoveryPath: "In Tools, select at least one installed tool, then open a new Agent task.",
                primaryHostID: primaryHostID,
                destinationIsWork: true
            )
        }

        if agentAppsVerified == false {
            gaps.append("Connected bindings failed verification.")
            return ManagerPostSetupGuidance(
                readyToWork: false,
                problemClass: .toolFault,
                statusLine: "Bindings need repair",
                statusTone: .fault,
                title: "Bindings need repair",
                summary: "Full Check did not verify current bindings.",
                observed: observed,
                gaps: gaps,
                primaryActionID: .reviewRepair,
                primaryActionLabel: label(for: .reviewRepair, appName: app),
                primaryActionDetail: "",
                hint: nil,
                recoveryPath: "Review Repair or Run Full Check, then open a new Agent task after bindings verify.",
                primaryHostID: primaryHostID,
                destinationIsWork: true
            )
        }

        return ManagerPostSetupGuidance(
            readyToWork: true,
            problemClass: needsFreshTask
                ? .staleSession
                : (agentAppsVerified == nil ? .unverified : nil),
            statusLine: "Ready",
            statusTone: .ready,
            title: "Ready",
            summary: "Open the connected Agent app to start work.",
            observed: observed,
            gaps: gaps,
            primaryActionID: .openApp,
            primaryActionLabel: label(for: .openApp, appName: app),
            primaryActionDetail: "",
            hint: "Start a new task in the app",
            recoveryPath: "If the new task cannot see tools: decide whether it is not connected, a stale session, a permission issue, or a tool fault — then use Connect, a newer task, grant/repair, or Review Repair.",
            primaryHostID: primaryHostID,
            destinationIsWork: true
        )
    }

    private static func classifyFault(_ errors: [(id: String, message: String)]) -> (problemClass: ManagerPostSetupGuidance.ProblemClass, title: String, statusLine: String, summary: String, action: ManagerPostSetupGuidance.PrimaryActionID, recoveryPath: String)? {
        guard let first = errors.first else { return nil }
        let permission = errors.first {
            $0.id.localizedCaseInsensitiveContains("permission")
                || $0.id.localizedCaseInsensitiveContains("workspace")
                || $0.message.range(of: "permission|workspace|grant|access denied|EACCES|EPERM", options: [.regularExpression, .caseInsensitive]) != nil
        }
        if let permission {
            return (
                .permission,
                "Permission blocked",
                shortReason(permission.message, fallback: "Permission blocked"),
                permission.message,
                .grantWorkspace,
                "Fix the permission or grant the project folder, run Full Check, then open a new Agent task."
            )
        }
        return (
            .toolFault,
            "Needs repair",
            shortReason(first.message, fallback: "Needs repair"),
            first.message,
            .reviewRepair,
            "Review Repair (or Run Full Check), fix the named fault, then open a new Agent task. Do not keep working in an old task."
        )
    }

    private static func shortReason(_ message: String, fallback: String) -> String {
        let one = message.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if one.isEmpty { return fallback }
        if one.count > 72 { return String(one.prefix(69)) + "…" }
        return one
    }

    private static func label(for action: ManagerPostSetupGuidance.PrimaryActionID, appName: String?) -> String {
        switch action {
        case .connectAgent: return "Connect"
        case .reviewRepair: return "Repair"
        case .runFullCheck: return "Check"
        case .openTools: return "Tools"
        case .resumeTools: return "Resume"
        case .grantWorkspace: return "Fix access"
        case .openApp, .startNewAgentTask:
            if let appName, !appName.isEmpty {
                return "Open \(appName)"
            }
            return "Open Agent"
        }
    }
}
