import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';

export interface TrustedRenderer {
  contents: WebContents;
  url: string;
}

/** Trust only the main frame of one of our own local windows. */
export function trustedSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  renderers: TrustedRenderer[],
): boolean {
  return renderers.some(({ contents, url }) =>
    !contents.isDestroyed() && event.sender === contents &&
    event.senderFrame === contents.mainFrame && event.senderFrame?.url === url,
  );
}

export function trustedIpc(ipc: IpcMain, renderers: () => TrustedRenderer[]) {
  return {
    on(channel: string, listener: Parameters<IpcMain['on']>[1]): void {
      ipc.on(channel, (event, ...args) => {
        if (trustedSender(event, renderers())) listener(event, ...args);
      });
    },
    handle(channel: string, listener: Parameters<IpcMain['handle']>[1]): void {
      ipc.handle(channel, (event, ...args) => {
        if (!trustedSender(event, renderers())) throw new Error('Untrusted renderer');
        return listener(event, ...args);
      });
    },
  };
}
