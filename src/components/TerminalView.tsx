import { useEffect, useRef, type FC } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { PtyClient } from '../services/pty';

interface TerminalViewProps {
  ptyClient: PtyClient | null;
  agentName: string;
  modelName: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'terminated';
}

export const TerminalView: FC<TerminalViewProps> = ({
  ptyClient,
  agentName,
  modelName,
  status,
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermInstance = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      theme: {
        background: '#1C1B19',
        foreground: '#E8E6DF',
        cursor: '#E08A6B',
        selectionBackground: '#34332F',
        black: '#1C1B19',
        red: '#EE8A80',
        green: '#8FCB8F',
        yellow: '#E5C07B',
        blue: '#7FC4D6',
        magenta: '#E08A6B',
        cyan: '#7FC4D6',
        white: '#E8E6DF',
        brightBlack: '#8C897F',
        brightRed: '#EE8A80',
        brightGreen: '#8FCB8F',
        brightYellow: '#E5C07B',
        brightBlue: '#7FC4D6',
        brightMagenta: '#E08A6B',
        brightCyan: '#7FC4D6',
        brightWhite: '#FFFFFF',
      },
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    xtermInstance.current = term;
    fitAddonRef.current = fitAddon;

    term.onData(data => {
      ptyClient?.write(data);
    });

    const handleResize = () => {
      fitAddon.fit();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      term.dispose();
      xtermInstance.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ptyClient || !xtermInstance.current) return;

    const unsubData = ptyClient.onData(data => {
      xtermInstance.current?.write(data);
    });

    const unsubExit = ptyClient.onExit(code => {
      xtermInstance.current?.writeln(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
    });

    return () => {
      unsubData();
      unsubExit();
    };
  }, [ptyClient]);

  const dotClass =
    status === 'connected' ? 'dot' : status === 'connecting' ? 'dot wait' : 'dot off';

  return (
    <div className="term" data-test="terminal-container">
      <div className="term-tabs">
        <button className="term-tab" aria-selected="true">
          <span className={dotClass} />
          <span>{agentName.toUpperCase()} PTY</span>
        </button>
      </div>
      <div className="term-meta">
        <span>Session: {ptyClient?.currentId || 'idle'}</span>
        <span>Engine: {agentName}</span>
        <span>Model: {modelName}</span>
        <span>Status: {status}</span>
      </div>
      <div className="term-body" ref={terminalRef} data-test="terminal-xterm" />
    </div>
  );
};
