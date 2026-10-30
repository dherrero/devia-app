import type { NativeConfigMcpDelivery } from '../shared/native-config-mcp';

/** The side effects mappers need from the outside world — injected so tests never touch real files. */
export interface MapperDeps {
  readonly nativeMcp: Pick<NativeConfigMcpDelivery, 'deliver'>;
  /** T-88: an enterprise-managed Claude MCP config forbids `--mcp-config`. */
  readonly enterpriseMcpConfigPresent?: () => boolean;
  /**
   * Codex ignores its whole project config layer (where Devia's MCP servers
   * live) unless the project is trusted in `~/.codex/config.toml`.
   */
  readonly ensureCodexTrust?: (projectAbs: string) => void;
}
