import React from 'react';
import {AbsoluteFill, Sequence} from 'remotion';
import {Background} from './components/Background';
import {Agent, AGENT_LEN} from './scenes/Agent';
import {EndCard, END_LEN} from './scenes/EndCard';
import {Gallery, GALLERY_LEN} from './scenes/Gallery';
import {Hook, HOOK_LEN} from './scenes/Hook';
import {Landing, LANDING_LEN} from './scenes/Landing';
import {Proof, PROOF_LEN} from './scenes/Proof';

export const TOTAL_FRAMES =
  HOOK_LEN + LANDING_LEN + GALLERY_LEN + PROOF_LEN + AGENT_LEN + END_LEN;

export const PromitDemo: React.FC = () => {
  let at = 0;
  const seq = (len: number) => {
    const from = at;
    at += len;
    return {from, durationInFrames: len};
  };
  return (
    <AbsoluteFill>
      <Background />
      <Sequence {...seq(HOOK_LEN)} name="Hook">
        <Hook />
      </Sequence>
      <Sequence {...seq(LANDING_LEN)} name="Landing">
        <Landing />
      </Sequence>
      <Sequence {...seq(GALLERY_LEN)} name="Gallery">
        <Gallery />
      </Sequence>
      <Sequence {...seq(PROOF_LEN)} name="Proof">
        <Proof />
      </Sequence>
      <Sequence {...seq(AGENT_LEN)} name="Agent">
        <Agent />
      </Sequence>
      <Sequence {...seq(END_LEN)} name="EndCard">
        <EndCard />
      </Sequence>
    </AbsoluteFill>
  );
};
