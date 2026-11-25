import { useRef, useEffect, useState, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { X, Maximize2, Minimize2, Copy, Trash2, Download, Terminal as TerminalIcon } from 'lucide-react';
import toast from 'react-hot-toast';

interface TerminalProps {
  agentId: string;
  sessionId: string;
  onClose: () => void;
}

export function Terminal({ agentId, sessionId, onClose }: TerminalProps) {
  const { send, on } = useWebSocket();
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);

  useEffect(() => {
    let xterm: any;
    let fitAddon: any;

    const initTerminal = async () => {
      const { Terminal } = await import('xterm');
      const { FitAddon } = await import('xterm-addon-fit');
      const { WebLinksAddon } = await import('xterm-addon-web-links');

      xterm = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: '"JetBrains Mono", "Fira Code", monospace',
        theme: {
          background: '#0d1117',
          foreground: '#c9d1d9',
          cursor: '#58a6ff',
          cursorAccent: '#0d1117',
          selectionBackground: 'rgba(88, 166, 255, 0.3)',
          black: '#484f58',
          red: '#ff7b72',
          green: '#3fb950',
          yellow: '#d29922',
          blue: '#58a6ff',
          magenta: '#bc8cff',
          cyan: '#39c5cf',
          white: '#b1bac4',
          brightBlack: '#6e7681',
          brightRed: '#ff9779',
          brightGreen: '#56d364',
          brightYellow: '#e3b341',
          brightBlue: '#79c0ff',
          brightMagenta: '#d2a8ff',
          brightCyan: '#56d4dd',
          brightWhite: '#ffffff',
        },
        convertEol: true,
        scrollback: 10000,
        allowProposedApi: true,
      });

      fitAddon = new FitAddon();
      xterm.loadAddon(fitAddon);
      xterm.loadAddon(new WebLinksAddon());

      if (terminalRef.current) {
        xterm.open(terminalRef.current);
        fitAddon.fit();
      }

      termRef.current = xterm;
      fitAddonRef.current = fitAddon;

      xterm.onData((data: string) => {
        send('pty.data' as any, { session_id: sessionId, data });
      });

      xterm.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        send('pty.resize' as any, { session_id: sessionId, cols, rows });
      });

      const cleanup = on('pty.data' as any, handlePtyData);

      send('session.join' as any, { session_id: sessionId, agent_id: agentId });
      setIsConnected(true);

      return () => {
        cleanup();
        send('pty.close' as any, { session_id: sessionId });
        xterm.dispose();
      };
    };

    initTerminal();

    const handleResize = () => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [agentId, sessionId, send, on]);

  const handlePtyData = useCallback((message: { payload: unknown }) => {
    const payload = message.payload as { data: string; cols?: number; rows?: number };
    if (termRef.current && payload.data) {
      termRef.current.write(payload.data);
    }
    if (payload.cols && payload.rows && fitAddonRef.current) {
      // Terminal was resized on server side
    }
  }, []);

  const toggleFullscreen = async () => {
    const container = terminalRef.current?.parentElement;
    if (!container) return;

    if (!isFullscreen) {
      try {
        await container.requestFullscreen();
        setIsFullscreen(true);
        setTimeout(() => fitAddonRef.current?.fit(), 100);
      } catch (err) {
        console.error('Fullscreen error:', err);
      }
    } else {
      try {
        await document.exitFullscreen();
        setIsFullscreen(false);
        setTimeout(() => fitAddonRef.current?.fit(), 100);
      } catch (err) {
        console.error('Exit fullscreen error:', err);
      }
    }
  };

  const clearTerminal = () => {
    termRef.current?.clear();
    termRef.current?.reset();
  };

  const copySelection = () => {
    const selection = termRef.current?.getSelection();
    if (selection) {
      navigator.clipboard.writeText(selection);
      toast.success('Copied to clipboard');
    }
  };

  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && termRef.current) {
        termRef.current.write(text);
      }
    } catch (err) {
      toast.error('Failed to paste');
    }
  };

  return (
    <div className="flex-1 flex flex-col relative bg-gray-950"
         onMouseEnter={() => setShowControls(true)}
         onMouseLeave={() => setShowControls(false)}>
      <div className="relative flex-1 overflow-hidden" tabIndex={0}>
        <div
          ref={terminalRef}
          className="terminal-container h-full w-full"
        />

        {!isConnected && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-950/95 z-10">
            <div className="text-center text-gray-400">
              <TerminalIcon className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg">Connecting to terminal...</p>
              <p className="text-sm mt-2">Establishing PTY session</p>
            </div>
          </div>
        )}

        {showControls && (
          <div className="absolute top-4 right-4 flex items-center gap-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group" role="group" aria-label="Terminal controls">
            <button
              onClick={clearTerminal}
              className="p-2 bg-gray-900/50 backdrop-blur-sm rounded-lg hover:bg-gray-900/70 text-gray-300 hover:text-white transition-colors border border-gray-700"
              title="Clear terminal"
            >
              <Trash2 className="w-5 h-5" />
            </button>
            <button
              onClick={copySelection}
              className="p-2 bg-gray-900/50 backdrop-blur-sm rounded-lg hover:bg-gray-900/70 text-gray-300 hover:text-white transition-colors border border-gray-700"
              title="Copy selection"
            >
              <Copy className="w-5 h-5" />
            </button>
            <button
              onClick={pasteClipboard}
              className="p-2 bg-gray-900/50 backdrop-blur-sm rounded-lg hover:bg-gray-900/70 text-gray-300 hover:text-white transition-colors border border-gray-700"
              title="Paste from clipboard"
            >
              <Download className="w-5 h-5" />
            </button>
            <button
              onClick={toggleFullscreen}
              className="p-2 bg-gray-900/50 backdrop-blur-sm rounded-lg hover:bg-gray-900/70 text-gray-300 hover:text-white transition-colors border border-gray-700"
              title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
              {isFullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
            </button>
            <button
              onClick={onClose}
              className="p-2 bg-red-600/50 backdrop-blur-sm rounded-lg hover:bg-red-600/70 text-white transition-colors"
              title="Close terminal"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        )}

        <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between pointer-events-none">
          <div className="flex items-center gap-4 pointer-events-auto">
            <div className={`connection-quality ${isConnected ? 'excellent' : 'disconnected'}`}>
              <span className="dot" />
              <span className="text-xs text-gray-300 font-mono">
                {isConnected ? 'Connected' : 'Connecting...'}
              </span>
            </div>
            <span className="text-xs text-gray-500 font-mono">
              {termRef.current?.cols || 80}×{termRef.current?.rows || 24}
            </span>
          </div>
          <div className="flex items-center gap-2 pointer-events-auto">
            <kbd className="px-2 py-1 bg-gray-900/50 backdrop-blur-sm rounded text-xs text-gray-400 font-mono border border-gray-700">
              Ctrl+Shift+C
            </kbd>
            <kbd className="px-2 py-1 bg-gray-900/50 backdrop-blur-sm rounded text-xs text-gray-400 font-mono border border-gray-700">
              Ctrl+Shift+V
            </kbd>
            <span className="text-xs text-gray-500">Copy/Paste</span>
          </div>
        </div>
      </div>
    </div>
  );
}