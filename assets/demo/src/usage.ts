import { buildDefaultRegistry } from "./tool";

export function describeTools(): string {
  const registry = buildDefaultRegistry();
  const spec = registry.findToolByName("grep");
  return spec ? `${spec.name}: ${spec.description}` : "unknown tool";
}
