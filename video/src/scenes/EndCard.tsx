import React from 'react';
import {
  AbsoluteFill,
  Img,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {theme} from '../theme';

export const END_LEN = 200;

const Item: React.FC<{
  at: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({at, children, style}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame: frame - at, fps, config: {damping: 200}});
  return (
    <div style={{opacity: s, transform: `translateY(${(1 - s) * 24}px)`, ...style}}>
      {children}
    </div>
  );
};

/** One action only: the URL. */
export const EndCard: React.FC = () => (
  <AbsoluteFill
    style={{
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      gap: 34,
      fontFamily: theme.font,
    }}
  >
    <Item at={6}>
      <Img
        src={staticFile('assets/promit-logo.png')}
        style={{width: 150, height: 150}}
      />
    </Item>
    <Item at={14}>
      <div
        style={{
          fontSize: 100,
          fontWeight: 800,
          letterSpacing: '-0.02em',
          color: theme.ink,
        }}
      >
        Promit
      </div>
    </Item>
    <Item at={22}>
      <div style={{fontSize: 40, fontWeight: 500, color: theme.muted}}>
        Pay per prompt. Not per month.
      </div>
    </Item>
    <Item at={34} style={{marginTop: 18}}>
      <div
        style={{
          background: theme.ink,
          color: '#FFFFFF',
          fontSize: 42,
          fontWeight: 700,
          padding: '22px 52px',
          borderRadius: 999,
        }}
      >
        promit-two.vercel.app
      </div>
    </Item>
    <Item at={46}>
      <div style={{fontSize: 28, fontWeight: 500, color: theme.muted}}>
        Settled over x402 · USDC on Base Sepolia · verified contract
      </div>
    </Item>
  </AbsoluteFill>
);
