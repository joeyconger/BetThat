export function parseArgs(argv: string[]): { command: string | undefined; flags: Record<string, string> } {
  const [command, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token?.startsWith("--")) {
      const key = token.slice(2);
      const value = rest[i + 1];
      flags[key] = value && !value.startsWith("--") ? value : "true";
      if (value && !value.startsWith("--")) i += 1;
    }
  }
  return { command, flags };
}

export function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) {
    throw new Error(`missing required flag --${name}`);
  }
  return value;
}
