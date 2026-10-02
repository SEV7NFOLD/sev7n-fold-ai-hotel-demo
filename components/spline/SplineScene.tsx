'use client';

import { createElement } from 'react';

const sceneUrl = 'https://prod.spline.design/jwMLnSxXyOzv5Osx/scene.splinecode';

/** Spline is mounted only on the dedicated live-call screen. */
export function SplineScene() {
  return <div className="spline-screen" aria-hidden="true">
    {createElement('spline-viewer', {
      url: sceneUrl,
      background: 'transparent',
      'events-target': 'global',
      loading: 'eager',
    })}
  </div>;
}
