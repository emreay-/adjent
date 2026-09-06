import { describe, expect, it } from 'vitest';
import type { IpcMainEvent, WebContents } from 'electron';
import { trustedSender } from '../src/security.js';

const url = 'file:///app/renderer/panel.html';
function fixture() {
  const frame = { url };
  const contents = { isDestroyed: () => false, mainFrame: frame } as unknown as WebContents;
  const event = { sender: contents, senderFrame: frame } as IpcMainEvent;
  return { event, renderers: [{ contents, url }] };
}

describe('privileged IPC trust boundary', () => {
  it('accepts the main frame of the expected local window', () => {
    const { event, renderers } = fixture();
    expect(trustedSender(event, renderers)).toBe(true);
  });

  it('rejects subframes even if they report the same URL', () => {
    const { event, renderers } = fixture();
    expect(trustedSender({ ...event, senderFrame: { url } } as IpcMainEvent, renderers)).toBe(false);
  });

  it('rejects a different window, navigation and detached frames', () => {
    const { event, renderers } = fixture();
    expect(trustedSender(fixture().event, renderers)).toBe(false);
    event.senderFrame!.url = 'https://example.invalid/';
    expect(trustedSender(event, renderers)).toBe(false);
    expect(trustedSender({ ...event, senderFrame: null }, renderers)).toBe(false);
  });

  it('rejects destroyed windows', () => {
    const { event, renderers } = fixture();
    renderers[0]!.contents.isDestroyed = () => true;
    expect(trustedSender(event, renderers)).toBe(false);
  });
});
