import React from 'react';
import {Composition} from 'remotion';
import {PromitDemo, TOTAL_FRAMES} from './PromitDemo';
import {FPS} from './theme';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="PromitDemo"
    component={PromitDemo}
    durationInFrames={TOTAL_FRAMES}
    fps={FPS}
    width={1920}
    height={1080}
  />
);
