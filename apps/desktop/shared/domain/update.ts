export type UpdateState =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  /** New version detected or downloaded. */
  version?: string;
  /** Download progress, 0–100, present only while state is 'downloading'. */
  percent?: number;
  /** Sanitised error message, present only when state is 'error'. */
  error?: string;
}
