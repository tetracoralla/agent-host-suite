export function exceedsJsonDepth(value, maximumDepth) {
  if (value === null || typeof value !== "object") return false;
  const stack = [{ value, depth: 1 }];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > maximumDepth) return true;
    if (++visited > 1_000_000) return true;
    for (const child of Object.values(current.value)) {
      if (child !== null && typeof child === "object") {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return false;
}
