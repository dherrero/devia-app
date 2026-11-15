export enum Level {
  Debug,
  Info,
  Warn,
}

export class Logger {
  constructor(private readonly scope: string, private readonly level: Level = Level.Info) {}

  info(message: string): void {
    this.write(Level.Info, message);
  }

  warn(message: string): void {
    this.write(Level.Warn, message);
  }

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.level);
  }

  private write(level: Level, message: string): void {
    if (level >= this.level) console.log(formatLine(this.scope, message));
  }
}

export function formatLine(scope: string, message: string): string {
  return `[${scope}] ${message}`;
}
