/**
 * @license
 * Copyright 2017 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Ported from Puppeteer's Mouse class.
 */

import { sendCommand } from './debugger';
import type { Keyboard } from './keyboard';

export type MouseButton = 'left' | 'right' | 'middle' | 'back' | 'forward';

function buttonFlag(button: MouseButton): number {
  switch (button) {
    case 'left': return 1;
    case 'right': return 2;
    case 'middle': return 4;
    case 'back': return 8;
    case 'forward': return 16;
  }
}

function buttonsToButton(buttons: number): MouseButton | 'none' {
  if (buttons & 1) return 'left';
  if (buttons & 2) return 'right';
  if (buttons & 4) return 'middle';
  if (buttons & 8) return 'back';
  if (buttons & 16) return 'forward';
  return 'none';
}

interface MouseState {
  position: { x: number; y: number };
  buttons: number;
}

interface Transaction {
  update: (partial: Partial<MouseState>) => void;
  commit: () => void;
  rollback: () => void;
}

export interface ClickOptions {
  button?: MouseButton;
  clickCount?: number;
  count?: number;
  delay?: number;
}

export class Mouse {
  private tabId: number;
  private keyboard: Keyboard;
  private state: MouseState = { position: { x: 0, y: 0 }, buttons: 0 };
  private pendingUpdates: Array<Partial<MouseState>> = [];

  constructor(tabId: number, keyboard: Keyboard) {
    this.tabId = tabId;
    this.keyboard = keyboard;
  }

  updateTabId(tabId: number): void {
    this.tabId = tabId;
  }

  private get currentState(): MouseState {
    const merged = { ...this.state };
    for (const update of this.pendingUpdates) {
      if (update.position) merged.position = update.position;
      if (update.buttons !== undefined) merged.buttons = update.buttons;
    }
    return merged;
  }

  private createTransaction(): Transaction {
    const patch: Partial<MouseState> = {};
    this.pendingUpdates.push(patch);
    const remove = () => {
      const idx = this.pendingUpdates.indexOf(patch);
      if (idx !== -1) this.pendingUpdates.splice(idx, 1);
    };
    return {
      update: (partial) => Object.assign(patch, partial),
      commit: () => {
        if (patch.position) this.state.position = patch.position;
        if (patch.buttons !== undefined) this.state.buttons = patch.buttons;
        remove();
      },
      rollback: remove,
    };
  }

  private async withTransaction(fn: (update: (partial: Partial<MouseState>) => void) => Promise<void>): Promise<void> {
    const { update, commit, rollback } = this.createTransaction();
    try {
      await fn(update);
      commit();
    } catch (e) {
      rollback();
      throw e;
    }
  }

  async reset(): Promise<void> {
    const promises: Promise<void>[] = [];
    const buttonList: Array<[number, MouseButton]> = [
      [1, 'left'], [4, 'middle'], [2, 'right'], [16, 'forward'], [8, 'back'],
    ];
    for (const [flag, button] of buttonList) {
      if (this.currentState.buttons & flag) {
        promises.push(this.up({ button }));
      }
    }
    if (this.currentState.position.x !== 0 || this.currentState.position.y !== 0) {
      promises.push(this.move(0, 0));
    }
    await Promise.all(promises);
  }

  async move(x: number, y: number, options: { steps?: number } = {}): Promise<void> {
    const { steps = 1 } = options;
    const from = this.currentState.position;
    const to = { x, y };
    for (let step = 1; step <= steps; step++) {
      await this.withTransaction(async (update) => {
        update({
          position: {
            x: from.x + (to.x - from.x) * (step / steps),
            y: from.y + (to.y - from.y) * (step / steps),
          },
        });
        const { buttons, position } = this.currentState;
        await sendCommand(this.tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          modifiers: this.keyboard._modifiers,
          buttons,
          button: buttonsToButton(buttons),
          ...position,
        });
      });
    }
  }

  async down(options: { button?: MouseButton; clickCount?: number } = {}): Promise<void> {
    const { button = 'left', clickCount = 1 } = options;
    const flag = buttonFlag(button);
    if (this.currentState.buttons & flag) {
      throw new Error(`'${button}' is already pressed.`);
    }
    await this.withTransaction(async (update) => {
      update({ buttons: this.currentState.buttons | flag });
      const { buttons, position } = this.currentState;
      await sendCommand(this.tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        modifiers: this.keyboard._modifiers,
        clickCount,
        buttons,
        button,
        ...position,
      });
    });
  }

  async up(options: { button?: MouseButton; clickCount?: number } = {}): Promise<void> {
    const { button = 'left', clickCount = 1 } = options;
    const flag = buttonFlag(button);
    if (!(this.currentState.buttons & flag)) {
      throw new Error(`'${button}' is not pressed.`);
    }
    await this.withTransaction(async (update) => {
      update({ buttons: this.currentState.buttons & ~flag });
      const { buttons, position } = this.currentState;
      await sendCommand(this.tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        modifiers: this.keyboard._modifiers,
        clickCount,
        buttons,
        button,
        ...position,
      });
    });
  }

  async click(x: number, y: number, options: ClickOptions = {}): Promise<void> {
    const { delay, count = 1, clickCount = count } = options;
    if (count < 1) throw new Error('Click must occur a positive number of times.');
    const steps: Promise<void>[] = [this.move(x, y)];

    if (clickCount === count) {
      for (let i = 1; i < count; ++i) {
        steps.push(this.down({ ...options, clickCount: i }));
        steps.push(this.up({ ...options, clickCount: i }));
      }
    }

    steps.push(this.down({ ...options, clickCount }));
    if (typeof delay === 'number') {
      await Promise.all(steps);
      steps.length = 0;
      await new Promise((r) => setTimeout(r, delay));
    }
    steps.push(this.up({ ...options, clickCount }));
    await Promise.all(steps);
  }

  async wheel(options: { deltaX?: number; deltaY?: number } = {}): Promise<void> {
    const { deltaX = 0, deltaY = 0 } = options;
    const { position, buttons } = this.currentState;
    await sendCommand(this.tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      pointerType: 'mouse',
      modifiers: this.keyboard._modifiers,
      deltaY,
      deltaX,
      buttons,
      ...position,
    });
  }

  async drag(start: { x: number; y: number }, end: { x: number; y: number }): Promise<void> {
    await this.move(start.x, start.y);
    await this.down();
    await this.move(end.x, end.y);
  }

  async dragAndDrop(
    start: { x: number; y: number },
    end: { x: number; y: number },
    options: { delay?: number } = {},
  ): Promise<void> {
    await this.drag(start, end);
    if (options.delay) await new Promise((r) => setTimeout(r, options.delay));
    await this.up();
  }
}
