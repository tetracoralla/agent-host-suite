import { agentHostDeploymentHistory, deploymentToolRows } from "./db-read.mjs";

const HISTORY_LIMIT = 512;

function bindingIdentity(component) {
  return JSON.stringify([
    component.version,
    component.artifactSha256,
    [...component.toolNames].sort(),
  ]);
}

// A different component's release must not restart this binding's observation
// window. A rollback, replacement, removal or exposure change does restart it.
// Retained history establishes a lower bound, never an inferred install date.
export function currentComponentObservations(database, deployment, cutoffMs) {
  if (!deployment) return new Map();
  const retained = agentHostDeploymentHistory(database, HISTORY_LIMIT);
  const history = retained.slice(0, HISTORY_LIMIT).map((row) => ({
    activatedAtMs: Number(row.activated_at_ms),
    components: new Map(JSON.parse(row.components_json).map((item) => [item.id, item])),
  }));
  const rowsByCutoff = new Map();
  return new Map(deployment.components.map((component) => {
    const identity = bindingIdentity(component);
    let observedSinceMs = deployment.activatedAtMs;
    let boundaryObserved = false;
    for (const entry of history) {
      const previous = entry.components.get(component.id);
      if (!previous || bindingIdentity(previous) !== identity) {
        boundaryObserved = true;
        break;
      }
      observedSinceMs = Math.min(observedSinceMs, entry.activatedAtMs);
    }
    const windowStartMs = Math.max(cutoffMs, observedSinceMs);
    if (!rowsByCutoff.has(windowStartMs)) {
      rowsByCutoff.set(windowStartMs, new Map(deploymentToolRows(database, windowStartMs)
        .map((row) => [`${row.provider}\0${row.tool_name}`, row])));
    }
    return [component.id, {
      componentId: component.id,
      componentVersion: component.version,
      observedSinceMs,
      windowStartMs,
      boundaryObserved,
      historyTruncated: !boundaryObserved && retained.length > HISTORY_LIMIT,
      basis: "retained-contiguous-component-binding-observations",
      rows: rowsByCutoff.get(windowStartMs),
    }];
  }));
}
