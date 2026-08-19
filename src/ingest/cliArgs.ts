/** Parses `--flag value` pairs with no leading subcommand token. */
export function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token?.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1];
      flags[key] = value && !value.startsWith("--") ? value : "true";
      if (value && !value.startsWith("--")) i += 1;
    }
  }
  return flags;
}

export function parseArgs(argv: string[]): { command: string | undefined; flags: Record<string, string> } {
  const [command, ...rest] = argv;
  return { command, flags: parseFlags(rest) };
}

export function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) {
    throw new Error(`missing required flag --${name}`);
  }
  return value;
}
