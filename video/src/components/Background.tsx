import React from 'react';
import {AbsoluteFill} from 'remotion';
import {theme} from '../theme';

/** Static SVG grain so the flat background has depth without motion churn. */
const NOISE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2"/></filter><rect width="300" height="300" filter="url(#n)" opacity="0.5"/></svg>`,
  );

export const Background: React.FC = () => (
  <AbsoluteFill style={{backgroundColor: theme.bg}}>
    <AbsoluteFill
      style={{
        background:
          'radial-gradient(120% 90% at 50% 8%, #FFFFFF 0%, rgba(255,255,255,0) 55%)',
      }}
    />
    <AbsoluteFill
      style={{
        backgroundImage: `url("${NOISE}")`,
        backgroundRepeat: 'repeat',
        opacity: 0.04,
      }}
    />
    <AbsoluteFill
      style={{
        background:
          'radial-gradient(140% 120% at 50% 50%, rgba(0,0,0,0) 62%, rgba(0,0,0,0.10) 100%)',
      }}
    />
  </AbsoluteFill>
);
