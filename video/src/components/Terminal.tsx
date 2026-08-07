import React from 'react';
import {useCurrentFrame} from 'remotion';
import {theme} from '../theme';

type Seg = {text: string; bold: boolean; dim: boolean; white: boolean};

/**
 * Renders the recorded ANSI stream (bold/dim/white are the only codes the
 * CLI emits) — the terminal scene replays the real recording, char for char.
 */
export const parseAnsi = (raw: string): Seg[][] => {
  const lines = raw.replace(/\r/g, '').split('\n');
  const out: Seg[][] = [];
  let bold = false;
  let dim = false;
  let white = false;
  for (const line of lines) {
    const segs: Seg[] = [];
    let last = 0;
    const re = /\x1b\[([0-9;]*)m/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) {
        segs.push({text: line.slice(last, m.index), bold, dim, white});
      }
      for (const code of (m[1] || '0').split(';')) {
        if (code === '0' || code === '') { bold = dim = white = false; }
        else if (code === '1' || code === '01') bold = true;
        else if (code === '2') dim = true;
        else if (code === '22') { bold = dim = false; }
        else if (code === '37') white = true;
      }
      last = m.index + m[0].length;
    }
    if (last < line.length) segs.push({text: line.slice(last), bold, dim, white});
    out.push(segs);
  }
  while (out.length > 0 && out[out.length - 1].every((s) => s.text.trim() === '')) {
    out.pop();
  }
  return out;
};

const segColor = (s: Seg) => {
  if (s.dim) return '#7D8590';
  if (s.bold || s.white) return '#F0F6FC';
  return '#C9D1D9';
};

export const TerminalFrame: React.FC<{
  width: number;
  height: number;
  title: string;
  command: string;
  typeStart: number;
  typeSpeed?: number;
  outputStart: number;
  lines: Seg[][];
  linesPerFrame?: number;
  style?: React.CSSProperties;
}> = ({
  width,
  height,
  title,
  command,
  typeStart,
  typeSpeed = 1.4,
  outputStart,
  lines,
  linesPerFrame = 0.7,
  style,
}) => {
  const frame = useCurrentFrame();
  const typed = Math.max(0, Math.floor((frame - typeStart) * typeSpeed));
  const cmdShown = command.slice(0, typed);
  const doneTyping = typed >= command.length;
  const shownLines = Math.max(0, Math.floor((frame - outputStart) * linesPerFrame));
  const cursorOn = Math.floor(frame / 12) % 2 === 0;
  const outputDone = shownLines >= lines.length;

  return (
    <div
      style={{
        width,
        height,
        borderRadius: 18,
        overflow: 'hidden',
        background: '#0D1117',
        boxShadow: '0 30px 80px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.12)',
        ...style,
      }}
    >
      <div
        style={{
          height: 56,
          background: '#161B22',
          borderBottom: '1px solid #21262D',
          display: 'flex',
          alignItems: 'center',
          padding: '0 22px',
          gap: 10,
        }}
      >
        {['#FF5F57', '#FEBC2E', '#28C840'].map((c) => (
          <div key={c} style={{width: 13, height: 13, borderRadius: 7, background: c}} />
        ))}
        <span
          style={{
            margin: '0 auto',
            fontFamily: theme.mono,
            fontSize: 21,
            color: '#7D8590',
          }}
        >
          {title}
        </span>
        <div style={{width: 59}} />
      </div>
      <div
        style={{
          padding: '26px 34px',
          fontFamily: theme.mono,
          fontSize: 21.5,
          lineHeight: '30px',
          whiteSpace: 'pre',
        }}
      >
        <div>
          <span style={{color: '#3FB950'}}>➜</span>
          <span style={{color: '#58A6FF'}}> promit </span>
          <span style={{color: '#F0F6FC'}}>{cmdShown}</span>
          {!doneTyping && cursorOn ? (
            <span style={{color: '#F0F6FC'}}>▍</span>
          ) : null}
        </div>
        {doneTyping && frame >= outputStart
          ? lines.slice(0, shownLines).map((segs, i) => (
              <div key={i}>
                {segs.map((s, j) => (
                  <span
                    key={j}
                    style={{
                      color: segColor(s),
                      fontWeight: s.bold ? 700 : 400,
                    }}
                  >
                    {s.text}
                  </span>
                ))}
                {segs.length === 0 ? ' ' : null}
              </div>
            ))
          : null}
        {outputDone && frame >= outputStart ? (
          <div>
            <span style={{color: '#3FB950'}}>➜</span>
            <span style={{color: '#58A6FF'}}> promit </span>
            {cursorOn ? <span style={{color: '#F0F6FC'}}>▍</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};
