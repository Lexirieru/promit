import React from 'react';
import {
  AbsoluteFill,
  OffthreadVideo,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import {TitleBeat} from '../components/overlays';
import {theme} from '../theme';

export const HOOK_LEN = 170;

/**
 * Problem hook over the product's own hero footage. Dark text over the sky
 * area, exactly how the live site treats the same video.
 */
export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const fadeOut = interpolate(frame, [HOOK_LEN - 16, HOOK_LEN], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{background: theme.bg}}>
      <OffthreadVideo
        muted
        src={staticFile('assets/hero.mp4')}
        style={{width: '100%', height: '100%', objectFit: 'cover'}}
      />
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(180deg, rgba(255,255,255,0.72) 0%, rgba(255,255,255,0.38) 45%, rgba(255,255,255,0.05) 100%)',
        }}
      />
      <TitleBeat at={8} until={78} size={110}>
        Need one prompt?
      </TitleBeat>
      <TitleBeat
        at={86}
        size={110}
        sub="…for a subscription you use once."
        subColor="#3F4753"
      >
        That&rsquo;ll be $300.
      </TitleBeat>
      <AbsoluteFill style={{background: theme.bg, opacity: fadeOut}} />
    </AbsoluteFill>
  );
};
