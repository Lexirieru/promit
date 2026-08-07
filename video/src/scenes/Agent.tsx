import React, {useMemo} from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {TerminalFrame, parseAnsi} from '../components/Terminal';
import {Caption, TitleBeat} from '../components/overlays';
import {CLI_ANSI} from '../generated/cliOutput';

export const AGENT_LEN = 480;

/**
 * The agent surface. The terminal replays the recorded output of
 * `bun cli/src/cli.ts search hero` against the live API — see
 * scripts/record-cli.sh. Nothing here is staged.
 */
export const Agent: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const lines = useMemo(() => parseAnsi(CLI_ANSI), []);

  const enter = spring({frame: frame - 55, fps, config: {damping: 200}});
  const settleZoom = interpolate(frame, [160, 460], [1, 1.035], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill>
      <TitleBeat at={4} until={52} size={100}>
        An agent can buy it without you.
      </TitleBeat>
      {frame >= 52 ? (
        <AbsoluteFill
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            opacity: enter,
            transform: `translateY(${(1 - enter) * 70}px) scale(${settleZoom})`,
          }}
        >
          <TerminalFrame
            width={1460}
            height={836}
            title="promit — zsh"
            command="bun cli/src/cli.ts search hero"
            typeStart={78}
            outputStart={112}
            lines={lines}
            style={{marginBottom: 40}}
          />
        </AbsoluteFill>
      ) : null}
      <Caption at={200} until={330} bottom={40}>
        Real output — recorded against the live API.
      </Caption>
      <Caption at={345} until={AGENT_LEN - 12} bottom={40}>
        Same catalog on the CLI, MCP server, and Claude Code plugin.
      </Caption>
    </AbsoluteFill>
  );
};
