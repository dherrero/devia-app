import { dialog, type BrowserWindow } from 'electron';
import type { DialogService } from '../domain/ports';

export class ElectronDialogService implements DialogService {
  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  async pickFolder(opts?: { title?: string; defaultPath?: string }): Promise<string | null> {
    const win = this.getMainWindow();
    const baseOptions = {
      title: opts?.title ?? 'Seleccionar carpeta',
      properties: ['openDirectory', 'createDirectory'] as const,
    };
    const result = await dialog.showOpenDialog(win ?? undefined as never, {
      ...baseOptions,
      ...(opts?.defaultPath ? { defaultPath: opts.defaultPath } : {}),
      properties: [...baseOptions.properties],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  }

  async pickFile(opts?: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<string | null> {
    const win = this.getMainWindow();
    const result = await dialog.showOpenDialog(win ?? undefined as never, {
      title: opts?.title ?? 'Seleccionar archivo',
      properties: ['openFile'],
      ...(opts?.defaultPath ? { defaultPath: opts.defaultPath } : {}),
      ...(opts?.filters ? { filters: opts.filters } : {}),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  }
}
