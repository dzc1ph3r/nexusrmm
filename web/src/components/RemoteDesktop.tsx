import { useRef, useEffect, useState, useCallback } from 'react';
import { useWebSocket, WSMessageType } from '../hooks/useWebSocket';
import { Monitor, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';

interface RemoteDesktopProps {
  agentId: string;
  sessionId: string;
  onClose: () => void;
}

export function RemoteDesktop({ agentId, sessionId, onClose }: RemoteDesktopProps) {
  const { send, on } = useWebSocket();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [quality, setQuality] = useState<'low' | 'medium' | 'high' | 'adaptive'>('adaptive');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [stats, setStats] = useState({ fps: 0, latency: 0, bandwidth: 0 });
  const frameCountRef = useRef(0);
  const lastStatsTimeRef = useRef(Date.now());
  const decoderRef = useRef<VideoDecoder | null>(null);

  useEffect(() => {
    const cleanup = on('desktop.frame' as WSMessageType, handleFrame);
    send('session.join' as WSMessageType, { session_id: sessionId, agent_id: agentId });

    const statsInterval = setInterval(updateStats, 1000);

    return () => {
      cleanup();
      clearInterval(statsInterval);
      send('session.leave' as WSMessageType, { session_id: sessionId });
      if (decoderRef.current) {
        decoderRef.current.close();
      }
    };
  }, [agentId, sessionId, send, on]);

  const updateStats = () => {
    const now = Date.now();
    const elapsed = (now - lastStatsTimeRef.current) / 1000;
    const fps = Math.round(frameCountRef.current / elapsed);
    frameCountRef.current = 0;
    lastStatsTimeRef.current = now;
    setStats(prev => ({ ...prev, fps }));
  };

  const handleFrame = useCallback(async (message: { payload: unknown }) => {
    const payload = message.payload as {
      data: string;
      width: number;
      height: number;
      format: string;
      timestamp: number;
      keyframe: boolean;
    };

    frameCountRef.current++;
    setIsConnected(true);
    setStats(prev => ({ ...prev, latency: Date.now() - payload.timestamp }));

    if (payload.format === 'h264' && decoderRef.current) {
      try {
        const buffer = Uint8Array.from(atob(payload.data), c => c.charCodeAt(0));
        const chunk = new EncodedVideoChunk({
          type: payload.keyframe ? 'key' : 'delta',
          timestamp: payload.timestamp,
          data: buffer,
        });
        decoderRef.current.decode(chunk);
      } catch (err) {
        console.error('Decode error:', err);
        requestKeyframe();
      }
    } else if (payload.format === 'vp8' || payload.format === 'vp9') {
      // WebM fallback - use video element
      if (videoRef.current) {
        // Would need MediaSource API for streaming
      }
    }
  }, []);

  const setupDecoder = useCallback(async () => {
    if (!('VideoDecoder' in window)) {
      toast.error('WebCodecs not supported in this browser');
      return;
    }

    try {
      decoderRef.current = new VideoDecoder({
        output: (frame) => {
          if (canvasRef.current) {
            const ctx = canvasRef.current.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              canvasRef.current.width = frame.displayWidth || frame.codedWidth;
              canvasRef.current.height = frame.displayHeight || frame.codedHeight;
              ctx.drawImage(frame, 0, 0);
            }
            frame.close();
          } else {
            frame.close();
          }
        },
        error: (err) => {
          console.error('Decoder error:', err);
          toast.error('Video decoder error');
        },
      });

      const config = {
        codec: 'avc1.42E01E', // H.264 baseline
        codedWidth: 1920,
        codedHeight: 1080,
      };

      await decoderRef.current.configure(config);

      send('desktop.config' as WSMessageType, {
        session_id: sessionId,
        codec: 'h264',
        quality,
        hardware_acceleration: true,
      });
    } catch (err) {
      console.error('Failed to setup decoder:', err);
      toast.error('Failed to initialize video decoder');
    }
  }, [send, sessionId, quality]);

  useEffect(() => {
    setupDecoder();
    return () => {
      if (decoderRef.current) {
        decoderRef.current.close();
      }
    };
  }, [setupDecoder]);

  const requestKeyframe = useCallback(() => {
    send('session.control' as WSMessageType, {
      session_id: sessionId,
      action: 'keyframe'
    });
  }, [send, sessionId]);

  const handleQualityChange = (newQuality: typeof quality) => {
    setQuality(newQuality);
    send('desktop.config' as WSMessageType, {
      session_id: sessionId,
      quality: newQuality
    });
  };

  const handleMouseEvent = (e: React.MouseEvent, type: 'move' | 'down' | 'up' | 'wheel') => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = Math.round(((e.clientX - rect.left) / rect.width) * 65535);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 65535);

    send('session.control' as WSMessageType, {
      session_id: sessionId,
      action: 'input',
      input: {
        type: 'mouse',
        x,
        y,
        button: (e as React.MouseEvent).button,
        event_type: type,
      },
    });
  };

  const handleKeyEvent = (e: React.KeyboardEvent, type: 'down' | 'up') => {
    send('session.control' as WSMessageType, {
      session_id: sessionId,
      action: 'input',
      input: {
        type: 'keyboard',
        key: e.code,
        event_type: type,
        modifiers: {
          shift: e.shiftKey,
          ctrl: e.ctrlKey,
          alt: e.altKey,
          meta: e.metaKey,
        },
      },
    });
  };

  const toggleFullscreen = async () => {
    const container = canvasRef.current?.parentElement;
    if (!container) return;

    if (!isFullscreen) {
      try {
        await container.requestFullscreen();
        setIsFullscreen(true);
      } catch (err) {
        console.error('Fullscreen error:', err);
      }
    } else {
      try {
        await document.exitFullscreen();
        setIsFullscreen(false);
      } catch (err) {
        console.error('Exit fullscreen error:', err);
      }
    }
  };

  return (
    <div className="flex-1 flex flex-col relative bg-gray-900"
         onMouseEnter={() => setShowControls(true)}
         onMouseLeave={() => setShowControls(false)}>
      <div className="relative flex-1 overflow-hidden" tabIndex={0}>
        <canvas
          ref={canvasRef}
          className="remote-desktop-canvas"
          onMouseMove={(e) => handleMouseEvent(e, 'move')}
          onMouseDown={(e) => handleMouseEvent(e, 'down')}
          onMouseUp={(e) => handleMouseEvent(e, 'up')}
          onMouseLeave={(e) => handleMouseEvent(e, 'up')}
          onWheel={(e) => handleMouseEvent(e as unknown as React.MouseEvent, 'wheel')}
          onKeyDown={(e) => handleKeyEvent(e as unknown as React.KeyboardEvent, 'down')}
          onKeyUp={(e) => handleKeyEvent(e as unknown as React.KeyboardEvent, 'up')}
          onContextMenu={(e) => e.preventDefault()}
        />
        <video ref={videoRef} className="remote-desktop-canvas hidden" playsInline muted />

        {!isConnected && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80 z-10">
            <div className="text-center text-white">
              <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary-500 border-t-transparent mx-auto mb-4" />
              <p className="text-lg">Connecting to remote desktop...</p>
              <p className="text-sm text-gray-400 mt-2">Establishing secure WebRTC session</p>
            </div>
          </div>
        )}

        {showControls && (
          <div className="absolute top-4 right-4 flex items-center gap-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group" role="group" aria-label="Remote desktop controls">
            <div className="flex items-center gap-1 bg-black/50 backdrop-blur-sm rounded-lg p-1">
              <span className="px-2 text-xs text-gray-300">Quality:</span>
              <select
                value={quality}
                onChange={(e) => handleQualityChange(e.target.value as typeof quality)}
                className="bg-transparent border-none text-white text-xs focus:outline-none focus:ring-1 focus:ring-primary-500 rounded"
              >
                <option value="adaptive">Adaptive</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <button
              onClick={requestKeyframe}
              className="p-2 bg-black/50 backdrop-blur-sm rounded-lg hover:bg-black/70 text-white transition-colors"
              title="Request keyframe (I-frame)"
            >
              <RotateCcw className="w-5 h-5" />
            </button>
            <button
              onClick={toggleFullscreen}
              className="p-2 bg-black/50 backdrop-blur-sm rounded-lg hover:bg-black/70 text-white transition-colors"
              title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
              {isFullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
            </button>
            <button
              onClick={onClose}
              className="p-2 bg-red-600/50 backdrop-blur-sm rounded-lg hover:bg-red-600/70 text-white transition-colors"
              title="End session"
            >
              <Monitor className="w-5 h-5" />
            </button>
          </div>
        )}

        <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between pointer-events-none">
          <div className="flex items-center gap-4 pointer-events-auto">
            <div className={`connection-quality ${isConnected ? 'excellent' : 'disconnected'}`}>
              <span className="dot" />
              <span className="text-xs text-white font-mono">
                {isConnected ? `${stats.fps} FPS • ${stats.latency}ms` : 'Disconnected'}
              </span>
            </div>
            {stats.bandwidth > 0 && (
              <span className="text-xs text-gray-300 font-mono">
                {(stats.bandwidth / 1024 / 1024).toFixed(1)} MB/s
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 pointer-events-auto">
            <kbd className="px-2 py-1 bg-black/50 backdrop-blur-sm rounded text-xs text-gray-300 font-mono">
              Ctrl+Alt+Del
            </kbd>
            <kbd className="px-2 py-1 bg-black/50 backdrop-blur-sm rounded text-xs text-gray-300 font-mono">
              Win+L
            </kbd>
            <span className="text-xs text-gray-400">are captured locally</span>
          </div>
        </div>
      </div>
    </div>
  );
}