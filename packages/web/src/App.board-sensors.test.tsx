import { MouseSensor, PointerSensor, TouchSensor } from '@dnd-kit/core';
import { describe, expect, it } from 'vitest';

import { dndMocks, renderApp } from './test/app-test-helpers';
import { App } from './App';
import { DND_ACTIVATION_DISTANCE } from './routes/BoardPage';

function renderTestApp() {
  return renderApp(App);
}

describe('App board sensors', () => {
  it('registers PointerSensor, MouseSensor, and TouchSensor for drag-and-drop', () => {
    renderTestApp();

    const sensorTypes = (dndMocks.useSensor.mock.calls as unknown[][]).map((call) => call[0]);

    expect(sensorTypes).toContain(PointerSensor);
    expect(sensorTypes).toContain(MouseSensor);
    expect(sensorTypes).toContain(TouchSensor);
    expect(dndMocks.useSensors).toHaveBeenCalled();
  });

  it('configures each sensor with a distance activation constraint', () => {
    renderTestApp();

    for (const call of dndMocks.useSensor.mock.calls as unknown as [unknown, Record<string, unknown>][]) {
      const options = call[1];
      expect(options).toHaveProperty('activationConstraint');
      expect((options.activationConstraint as { distance: number }).distance).toBe(DND_ACTIVATION_DISTANCE);
    }
  });
});
