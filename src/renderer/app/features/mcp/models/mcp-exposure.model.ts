/**
 * What the "Instaladas" tab lets the user choose for a server (S-50). The catalog
 * knows four exposures (`direct`, `deferred`, `codemode`, `hidden`) because pi
 * reads them all; Devia's own gateway only cares about one question: does the
 * agent see this server's tools, or reach them only through scripts?
 */
export type McpExposureChoice = 'direct' | 'codemode';

/** Anything that is not explicitly `codemode` is shown (and behaves) as direct. */
export function exposureChoice(server: { exposure?: string | undefined }): McpExposureChoice {
  return server.exposure === 'codemode' ? 'codemode' : 'direct';
}

export function isExposureChoice(value: string): value is McpExposureChoice {
  return value === 'direct' || value === 'codemode';
}
