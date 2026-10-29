// The shape of messages coming from the data service (see ../../../README.md).
//{ "type": "data", "stream": "metrics", "seq": 1234, "ts": 1761750000000, "t": 123.4, "data": { ... } }
export const STREAM_NAMES = ['metrics', 'ticker', 'geo','fleet','network', 'logs', 'incidents'] as const;

export type StreamName = (typeof STREAM_NAMES)[number];
const streamNamesSet:ReadonlySet<string> = new Set(STREAM_NAMES);

export type Envelope = {
  type: 'data';
  stream: StreamName;
  seq: number;
  ts: number;
  t: number;
  data: unknown;
}
type WelcomeMessage = {
  type: 'welcome';
  clientId: number;
  streams: StreamName[];
  t: number;
  speed: number;
}
type PongMessage = {
  type: 'pong';
  id?: number;
  ts: number;
}
type SubscribedMessage = {
  type:'subscribed';
  streams: StreamName[];
}
type ControlMessage = {
  type:'control';
  id?: number;
  ok:boolean;
  summary: string;
}
type ErrorMessage = {
  type:'error';
  error: string;
  id?: number;
}
export type ServerMessage = Envelope | WelcomeMessage | PongMessage | SubscribedMessage | ControlMessage | ErrorMessage;

// TODO: define payload types for the streams you use (start with metrics + incidents)
function isStreamName(x: unknown): x is StreamName {
  if(typeof x !== 'string') return false;
  if (streamNamesSet.has(x)) return true;

  return false;
}
export function isEnvelope(msg: unknown): msg is Envelope {

  if(typeof msg !=='object' || msg === null) return false;

  if(!('type' in msg ) || !('stream' in msg) || !('seq' in msg) || !('ts' in msg) || !('t' in msg) || !('data' in msg)) return false;
  if(msg.type === 'data' && 
    (isStreamName(msg.stream)) && 
    typeof msg.seq === 'number' && 
    typeof msg.ts === 'number' && 
    typeof msg.t === 'number')
        return true;
    
  return false;
}
