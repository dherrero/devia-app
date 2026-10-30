export interface WorkspaceForm {
  workspaceRoot: string;
  ignoreFolders: string;
}

export interface AgentForm {
  model: string;
  reasoning: string;
  env: Record<string, string>;
}

export interface RemoteForm {
  enabled: boolean;
  botToken: string;
  chatId: string;
  allowShell: boolean;
  mirrorDesktop: boolean;
  /** S-32 T-370: let Devia send workspace files to the chat. */
  allowFileSend: boolean;
}
