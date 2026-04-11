// InputDevice: composes Keyboard + Mouse + Debugger with zoom-scaled coordinates

import { ensureAttached, sendCommand } from './debugger';
import { Keyboard } from './keyboard';
import { Mouse } from './mouse';
import { sendToTab } from './messaging';

export interface Coordinates {
  x: number;
  y: number;
}

async function getZoomFactor(tabId: number): Promise<number> {
  const result = await sendCommand<{ visualViewport: { zoom?: number } }>(
    tabId,
    'Page.getLayoutMetrics',
  );
  return result?.visualViewport?.zoom ?? 1;
}

async function scaleCoords(tabId: number, coords: Coordinates): Promise<Coordinates> {
  const zoom = await getZoomFactor(tabId);
  return { x: coords.x * zoom, y: coords.y * zoom };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const SPECIAL_INPUT_TYPES = new Set([
  'color', 'date', 'time', 'datetime-local', 'month', 'range', 'week',
]);

export class InputDevice {
  tabId: number;
  readonly keyboard: Keyboard;
  readonly mouse: Mouse;

  constructor(tabId: number) {
    this.tabId = tabId;
    this.keyboard = new Keyboard(tabId);
    this.mouse = new Mouse(tabId, this.keyboard);
  }

  updateTabId(tabId: number): void {
    this.tabId = tabId;
    this.keyboard.updateTabId(tabId);
    this.mouse.updateTabId(tabId);
  }

  async click(coords: Coordinates, options?: { clickCount?: number }): Promise<void> {
    await ensureAttached(this.tabId);
    const scaled = await scaleCoords(this.tabId, coords);
    await this.mouse.click(scaled.x, scaled.y, options);
  }

  async moveMouse(coords: Coordinates): Promise<void> {
    await ensureAttached(this.tabId);
    const scaled = await scaleCoords(this.tabId, coords);
    await this.mouse.move(scaled.x, scaled.y);
  }

  async hover(coords: Coordinates): Promise<void> {
    await this.moveMouse(coords);
  }

  async type(text: string, selector?: string): Promise<void> {
    await ensureAttached(this.tabId);
    if (selector) {
      const inputType = await sendToTab<string | null>(this.tabId, 'getInputType', { selector });
      if (inputType && SPECIAL_INPUT_TYPES.has(inputType)) {
        await sendToTab(this.tabId, 'setInputValue', { selector, value: text });
      } else {
        await sendToTab(this.tabId, 'selectText', { selector });
        await this.keyboard.press('Backspace');
      }
    }
    await this.keyboard.type(text);
  }

  async fill(text: string): Promise<void> {
    await ensureAttached(this.tabId);
    await sendCommand(this.tabId, 'Input.insertText', { text });
  }

  async pressKey(key: string): Promise<void> {
    await ensureAttached(this.tabId);
    const keys = key.split('+');
    for (const k of keys) await this.keyboard.down(k);
    for (const k of keys.reverse()) await this.keyboard.up(k);
  }

  async wheel(options: { deltaX?: number; deltaY?: number }): Promise<void> {
    await ensureAttached(this.tabId);
    await this.mouse.wheel(options);
  }

  async dragAndDrop(start: Coordinates, end: Coordinates): Promise<void> {
    await ensureAttached(this.tabId);
    const scaledStart = await scaleCoords(this.tabId, start);
    const scaledEnd = await scaleCoords(this.tabId, end);
    await this.mouse.move(scaledStart.x, scaledStart.y);
    await this.mouse.down();
    await this.mouse.move(scaledEnd.x, scaledEnd.y);
    await this.mouse.up();
  }

  async scroll(coords: Coordinates, delta: { deltaX?: number; deltaY?: number }): Promise<void> {
    await this.moveMouse(coords);
    await this.wheel(delta);
  }

  async resetMousePosition(): Promise<void> {
    await ensureAttached(this.tabId);
    await this.mouse.move(-1, -1);
  }

  // Wait for navigation if one starts during an action
  async waitForTabIfNavigationStarted(tabId: number, action: () => Promise<void>): Promise<void> {
    let navigationPromise: Promise<void> | null = null;

    const onBeforeNavigate = (details: { tabId: number; frameId: number }) => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      navigationPromise = (async () => {
        await waitForTabLoad(tabId);
        await this.resetMousePosition();
      })();
    };

    chrome.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
    await action();
    chrome.webNavigation.onBeforeNavigate.removeListener(onBeforeNavigate);
    if (navigationPromise) await navigationPromise;
  }
}

// Wait for tab to finish loading
function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (tab?.status === 'complete') {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      });
    };
    // Also listen for the completed event
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    check();
  });
}
