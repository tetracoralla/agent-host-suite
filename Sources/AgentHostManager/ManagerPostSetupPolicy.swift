import Foundation

struct ManagerPostSetupGuidance: Equatable, Sendable {
    enum ProblemClass: String, Equatable, Sendable {
        case notConnected = "not-connected"
        case staleSession = "stale-session"
        case permission = "permission"
        case toolFault = "tool-fault"
        case unverified = "unverified"
    }

    enum PrimaryActionID: String, Equatable, Sendable {
        case startNewAgentTask = "start-new-agent-task"
        case connectAgent = "connect-agent"
        case reviewRepair = "review-repair"
        case runFullCheck = "run-full-check"
        case openTools = "open-tools"
        case grantWorkspace = "grant-workspace"
    }

    let readyToWork: Bool
    let problemClass: ProblemClass?
    let title: String
    let summary: String
    let observed: [String]
    let gaps: [String]
    let primaryActionID: PrimaryActionID
    let primaryActionLabel: String
    let primaryActionDetail: String
    let recoveryPath: String
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
        primaryHostName: String?
    ) -> ManagerPostSetupGuidance {
        guard configured else {
            return ManagerPostSetupGuidance(
                readyToWork: false,
                problemClass: nil,
                title: "Set up tools before starting work",
                summary: "Install a tool set first. Success is starting work afterward, not a green checklist.",
                observed: [],
                gaps: ["No Agent environment is installed yet."],
                primaryActionID: .runFullCheck,
                primaryActionLabel: "Set up tools",
                primaryActionDetail: "Choose a tool set, optionally connect an Agent app, then install.",
                recoveryPath: "Complete setup, then return here to start work.",
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
                title: fault.title,
                summary: fault.summary,
                observed: observed,
                gaps: gaps,
                primaryActionID: fault.action,
                primaryActionLabel: label(for: fault.action, appName: app),
                primaryActionDetail: detail(for: fault.action),
                recoveryPath: fault.recoveryPath,
                destinationIsWork: true
            )
        }

        if connectedHostNames.isEmpty {
            gaps.append("Connect an Agent app before expecting tools in a session.")
            return ManagerPostSetupGuidance(
                readyToWork: false,
                problemClass: .notConnected,
                title: "Install finished — connect an Agent to start work",
                summary: "Tools are on this Mac, but no Agent app is connected yet.",
                observed: observed,
                gaps: gaps,
                primaryActionID: .connectAgent,
                primaryActionLabel: label(for: .connectAgent, appName: nil),
                primaryActionDetail: detail(for: .connectAgent),
                recoveryPath: "Open Agents → Connect a supported app → start a new task in that app. Old tasks will not pick this up.",
                destinationIsWork: true
            )
        }

        if agentToolsPaused || (installedToolCount > 0 && activeToolCount == 0) {
            gaps.append("Resume or select tools for new tasks before starting work.")
            return ManagerPostSetupGuidance(
                readyToWork: false,
                problemClass: .toolFault,
                title: "Tools are installed but not available for new tasks",
                summary: agentToolsPaused
                    ? "Ordinary tools are paused. Resume them, then open a new Agent task."
                    : "No installed tool is selected for new tasks. Choose a working set, then open a new Agent task.",
                observed: observed,
                gaps: gaps,
                primaryActionID: .openTools,
                primaryActionLabel: "Open Tools to enable a working set",
                primaryActionDetail: "Working-set changes apply to new tasks only.",
                recoveryPath: "In Tools, resume or select at least one installed tool, then open a new Agent task.",
                destinationIsWork: true
            )
        }

        if needsFreshTask {
            gaps.append("A fresh Agent task is required after the latest tool or binding change.")
            return ManagerPostSetupGuidance(
                readyToWork: true,
                problemClass: .staleSession,
                title: "Ready — start work in a new Agent task",
                summary: "Host prepared tools for new tasks. An already-open task is a stale session for this change.",
                observed: observed,
                gaps: gaps,
                primaryActionID: .startNewAgentTask,
                primaryActionLabel: label(for: .startNewAgentTask, appName: app),
                primaryActionDetail: detail(for: .startNewAgentTask),
                recoveryPath: "Close or ignore the old task. Open a new task in the connected Agent app and continue real work there.",
                destinationIsWork: true
            )
        }

        if agentAppsVerified == nil {
            gaps.append("Bindings are configured; run Full Check when you want Host to verify them.")
            return ManagerPostSetupGuidance(
                readyToWork: true,
                problemClass: .unverified,
                title: justInstalled ? "Install complete — start work" : "Ready to start work",
                summary: "Host installed and connected what it can see. Start a new Agent task — do not wait on a status checklist.",
                observed: observed,
                gaps: gaps,
                primaryActionID: .startNewAgentTask,
                primaryActionLabel: label(for: .startNewAgentTask, appName: app),
                primaryActionDetail: detail(for: .startNewAgentTask),
                recoveryPath: "If tools are missing in the new task, run Full Check. Class the problem as not connected, stale session, permission, or tool fault, then follow that recovery.",
                destinationIsWork: true
            )
        }

        if agentAppsVerified == false {
            gaps.append("Connected bindings failed verification.")
            return ManagerPostSetupGuidance(
                readyToWork: false,
                problemClass: .toolFault,
                title: "Connected Agent bindings need repair",
                summary: "Host connected an Agent app, but Full Check did not verify current bindings.",
                observed: observed,
                gaps: gaps,
                primaryActionID: .reviewRepair,
                primaryActionLabel: label(for: .reviewRepair, appName: app),
                primaryActionDetail: detail(for: .reviewRepair),
                recoveryPath: "Review Repair or Run Full Check, then open a new Agent task after bindings verify.",
                destinationIsWork: true
            )
        }

        return ManagerPostSetupGuidance(
            readyToWork: true,
            problemClass: nil,
            title: justInstalled ? "Install complete — start work" : "Ready to start work",
            summary: "Host confirmed the local environment it can observe. The next step is a new Agent task with real work, not more status rows.",
            observed: observed,
            gaps: gaps,
            primaryActionID: .startNewAgentTask,
            primaryActionLabel: label(for: .startNewAgentTask, appName: app),
            primaryActionDetail: detail(for: .startNewAgentTask),
            recoveryPath: "If the new task cannot see tools: decide whether it is not connected, a stale session, a permission issue, or a tool fault — then use Connect, a newer task, grant/repair, or Review Repair.",
            destinationIsWork: true
        )
    }

    private static func classifyFault(_ errors: [(id: String, message: String)]) -> (problemClass: ManagerPostSetupGuidance.ProblemClass, title: String, summary: String, action: ManagerPostSetupGuidance.PrimaryActionID, recoveryPath: String)? {
        guard let first = errors.first else { return nil }
        let permission = errors.first {
            $0.id.localizedCaseInsensitiveContains("permission")
                || $0.id.localizedCaseInsensitiveContains("workspace")
                || $0.message.range(of: "permission|workspace|grant|access denied|EACCES|EPERM", options: [.regularExpression, .caseInsensitive]) != nil
        }
        if let permission {
            return (
                .permission,
                "Permission or workspace access is blocking work",
                permission.message,
                .grantWorkspace,
                "Fix the permission or grant the project folder, run Full Check, then open a new Agent task."
            )
        }
        return (
            .toolFault,
            "A tool or local service needs repair before work",
            first.message,
            .reviewRepair,
            "Review Repair (or Run Full Check), fix the named fault, then open a new Agent task. Do not keep working in an old task."
        )
    }

    private static func label(for action: ManagerPostSetupGuidance.PrimaryActionID, appName: String?) -> String {
        switch action {
        case .connectAgent: return "Connect an Agent app"
        case .reviewRepair: return "Review Repair"
        case .runFullCheck: return "Run Full Check"
        case .openTools: return "Open Tools to enable a working set"
        case .grantWorkspace: return "Fix permission / grant workspace"
        case .startNewAgentTask:
            if let appName, !appName.isEmpty {
                return "Open a new \(appName) task to start work"
            }
            return "Open a new Agent task to start work"
        }
    }

    private static func detail(for action: ManagerPostSetupGuidance.PrimaryActionID) -> String {
        switch action {
        case .connectAgent:
            return "Open Agents, connect one supported app, then start a new task there."
        case .reviewRepair:
            return "Repair restores Host-observed faults. It does not invent success for things Host cannot see."
        case .runFullCheck:
            return "Confirm current bindings and tool readiness before starting work."
        case .openTools:
            return "Working-set changes apply to new tasks only."
        case .grantWorkspace:
            return "Grant the project folder the tool needs, then open a new Agent task."
        case .startNewAgentTask:
            return "Already-open tasks keep the tools they started with. A new task is the path into real work."
        }
    }
}
