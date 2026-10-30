export type DvToolStatus = 'ok' | 'running' | 'error' | 'pending';

export interface DvDiffLine {
  type: 'add' | 'del' | 'ctx';
  lineNum: string;
  code: string;
}

export interface DvChoiceOption {
  label: string;
  isPrimary?: boolean;
}

export interface DvChatMessage {
  id: string;
  type:
    | 'user'
    | 'ai'
    | 'tool'
    | 'diff'
    | 'choice'
    | 'thinking'
    | 'streaming'
    | 'error'
    | 'system';
  content?: string;
  toolName?: string;
  toolArg?: string;
  toolStatus?: DvToolStatus;
  toolBody?: string;
  diffFileName?: string;
  diffLines?: DvDiffLine[];
  choiceQuestion?: string;
  choiceOptions?: DvChoiceOption[];
  errorMessage?: string;
  errorDetail?: string;
}
