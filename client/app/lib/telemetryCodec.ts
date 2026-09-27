// Client-side mirror of server/telemetryCodec.js — must stay in sync.

const PACKET_SIZE = 20;
const WIRE_VERSION = 1;

export type TelemetryPacket = {
  timestamp: number;
  faceDetected: boolean;
  attention: number;
  confusion: number;
  headYaw: number;
  headPitch: number;
  slideIndex?: number;
};

export function encodeTelemetry(data: TelemetryPacket): ArrayBuffer {
  const buffer = new ArrayBuffer(PACKET_SIZE);
  const view = new DataView(buffer);

  view.setFloat64(0, data.timestamp, true);
  view.setUint8(8, data.faceDetected ? 1 : 0);
  view.setUint8(9, clampByte(data.attention));
  view.setUint8(10, clampByte(data.confusion));
  view.setInt16(11, Math.round(data.headYaw), true);
  view.setInt16(13, Math.round(data.headPitch), true);
  view.setUint32(15, data.slideIndex ?? 0, true);
  view.setUint8(19, WIRE_VERSION);

  return buffer;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}