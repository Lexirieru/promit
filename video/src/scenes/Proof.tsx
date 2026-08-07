import React from 'react';
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {BrowserFrame, browserContentSize} from '../components/BrowserFrame';
import {getCamera} from '../components/camera';
import {Caption, HighlightBox, TitleBeat} from '../components/overlays';

export const PROOF_LEN = 560;

const FRAME_W = 1680;
const FRAME_H = 964;
const TX_W = 3840;
const TX_H = 2336;
const BUYER_W = 3840;
const BUYER_H = 2160;

// Rects measured on the real captures (image px, 2x scale factor).
const TX_ACTION = {x: 560, y: 430, w: 2600, h: 340};
const TX_ACTION_LINE = {x: 680, y: 500, w: 740, h: 95};
const TX_FROM = {x: 520, y: 1040, w: 2400, h: 350};
const TX_FROM_VALUE = {x: 1255, y: 1125, w: 710, h: 90};
const BUYER_CARD = {x: 520, y: 420, w: 980, h: 440};
const BUYER_ZERO = {x: 575, y: 555, w: 200, h: 100};

const SWAP = 360; // tx page → buyer address page crossfade

/**
 * The core claim, shown on Basescan rather than asserted: the settlement tx
 * was submitted by the facilitator (tx.from), and the buyer wallet that
 * signed the USDC authorization holds 0 ETH.
 */
export const Proof: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {w: boxW, h: boxH} = browserContentSize(FRAME_W, FRAME_H);

  const enter = spring({frame: frame - 70, fps, config: {damping: 200}});
  const txCam = getCamera(frame, boxW, boxH, [
    {frame: 85, rect: {x: 0, y: 0, w: TX_W, h: (TX_W * boxH) / boxW}},
    {frame: 150, rect: TX_ACTION},
    {frame: 245, rect: TX_FROM},
  ]);
  const buyerCam = getCamera(frame, boxW, boxH, [
    {frame: SWAP, rect: {x: 0, y: 0, w: BUYER_W, h: (BUYER_W * boxH) / boxW}},
    {frame: 425, rect: BUYER_CARD},
  ]);
  const buyerOpacity = interpolate(frame, [SWAP, SWAP + 15], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const url =
    frame < SWAP + 8
      ? 'sepolia.basescan.org/tx/0x7b62a3ae1bd8…2c5aad6a85'
      : 'sepolia.basescan.org/address/0xadE939F2…2b672644c';

  return (
    <AbsoluteFill>
      <TitleBeat at={4} until={66} size={100}>
        Don&rsquo;t take our word for it.
      </TitleBeat>
      {frame >= 66 ? (
        <AbsoluteFill
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            opacity: enter,
            transform: `translateY(${(1 - enter) * 70}px)`,
          }}
        >
          <BrowserFrame url={url} width={FRAME_W} height={FRAME_H}>
            <Img
              src={staticFile('captures/basescan-tx.png')}
              style={{
                position: 'absolute',
                width: TX_W,
                height: TX_H,
                transformOrigin: '0 0',
                transform: txCam.transform,
                opacity: 1 - buyerOpacity,
              }}
            />
            {frame >= SWAP ? (
              <Img
                src={staticFile('captures/basescan-buyer.png')}
                style={{
                  position: 'absolute',
                  width: BUYER_W,
                  height: BUYER_H,
                  transformOrigin: '0 0',
                  transform: buyerCam.transform,
                  opacity: buyerOpacity,
                }}
              />
            ) : null}
            {frame < SWAP ? (
              <>
                <HighlightBox at={165} until={240} box={txCam.project(TX_ACTION_LINE)} />
                <HighlightBox at={262} until={352} box={txCam.project(TX_FROM_VALUE)} />
              </>
            ) : (
              <HighlightBox at={440} until={548} box={buyerCam.project(BUYER_ZERO)} />
            )}
          </BrowserFrame>
        </AbsoluteFill>
      ) : null}
      <Caption at={158} until={242}>
        One x402 request. 0.01 USDC settled on Base Sepolia.
      </Caption>
      <Caption at={262} until={352}>
        tx.from is the <b>facilitator</b> — the buyer never paid gas.
      </Caption>
      <Caption at={438} until={550}>
        The buyer held <b>0 ETH</b> — and still paid USDC on-chain.
      </Caption>
    </AbsoluteFill>
  );
};
