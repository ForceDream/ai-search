export interface ToolSpec {
  name: string;
  description: string;
}

export class ToolRegistry {
  private specs: ToolSpec[] = [];

  register(spec: ToolSpec): void {
    this.specs.push(spec);
  }

  findToolByName(name: string): ToolSpec | undefined {
    return this.specs.find((s) => s.name === name);
  }
}

export function buildDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({ name: "grep", description: "text search" });
  return registry;
}
