import WebSocket, { type ClientOptions } from 'ws';
import { z } from 'zod';

const turn = z.object({
  type: z.literal('TurnInfo'),
  event: z.literal('EndOfTurn'),
  turn_index: z.number().int().nonnegative(),
  transcript: z.string().trim().min(1).max(12_000),
});

export function openFlux(apiKey: string, handlers: {
  ready: () => void;
  speaking: (text: string) => void;
  turn: (text: string) => void;
  failed: (speechInProgress: boolean) => void;
}, connect = (url: URL, options: ClientOptions) => new WebSocket(url, options)) {
  const url = new URL('wss://api.deepgram.com/v2/listen');
  url.search = new URLSearchParams({
    model: 'flux-general-en', encoding: 'mulaw', sample_rate: '8000', eot_threshold: '0.85', keyterm: 'Fo shizzle my nizzle',
  }).toString();
  const socket = connect(url, { headers: { Authorization: `Token ${apiKey}` }, maxPayload: 256 * 1024, handshakeTimeout: 4000 });
  let connected = false, stopped = false, lastTurn = -1;
  let speechInProgress = false;
  let remainder = Buffer.alloc(0);
  const close = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(startDeadline);
    if (socket.readyState === WebSocket.OPEN) socket.close();
    else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  };
  const fail = () => {
    if (stopped) return;
    close();
    handlers.failed(speechInProgress);
  };
  const startDeadline = setTimeout(fail, 5000);
  socket.on('close', fail);
  socket.on('error', fail);
  socket.on('message', raw => {
    if (stopped) return;
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { return; }
    if (frame?.type === 'Error') { fail(); return; }
    if (frame?.type === 'Connected' && !connected) {
      connected = true;
      clearTimeout(startDeadline);
      handlers.ready();
    }
    if (connected && frame?.type === 'TurnInfo' && Number.isInteger(frame.turn_index) && frame.turn_index > lastTurn) {
      if (frame.event === 'StartOfTurn') speechInProgress = true;
      if (speechInProgress && ['StartOfTurn', 'Update', 'TurnResumed'].includes(frame.event)
        && typeof frame.transcript === 'string' && frame.transcript.trim()) handlers.speaking(frame.transcript);
    }
    const result = turn.safeParse(frame);
    if (connected && result.success && result.data.turn_index > lastTurn) {
      lastTurn = result.data.turn_index;
      speechInProgress = false;
      handlers.turn(result.data.transcript);
    }
  });
  return {
    close,
    append(payload: string, muted: boolean) {
      if (stopped || !connected || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 32_000) { fail(); return; }
      const audio = Buffer.from(payload, 'base64');
      if (muted) audio.fill(0xff);
      const pending = Buffer.concat([remainder, audio]);
      // Flux recommends 80 ms of audio per frame, which is 640 bytes of 8 kHz mu-law.
      let offset = 0;
      for (; offset + 640 <= pending.length; offset += 640) socket.send(pending.subarray(offset, offset + 640), error => {
        if (error) fail();
      });
      remainder = pending.subarray(offset);
    },
  };
}
