// Shared wire format for scalar telemetry packets sent from client -> server.
// 20 bytes per packet, little-endian.
//   0-7   timestamp   (float64, ms since epoch)
//   8     faceDetected (uint8, 0 or 1)
//   9     attention    (uint8, 0-100)
//   10    confusion    (uint8, 0-100)
//   11-12 headYaw      (int16, degrees)
//   13-14 headPitch    (int16, degrees)
//   15-18 reserved     (uint32, reserved for slide index in Phase 6)
//   19    version      (uint8)

const PACKET_SIZE = 20;
const WIRE_VERSION = 1;

function encodeTelemetry(data) {
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

function decodeTelemetry(buffer) {
  const view = new DataView(buffer);

  return {
    timestamp: view.getFloat64(0, true),
    faceDetected: view.getUint8(8) === 1,
    attention: view.getUint8(9),
    confusion: view.getUint8(10),
    headYaw: view.getInt16(11, true),
    headPitch: view.getInt16(13, true),
    slideIndex: view.getUint32(15, true),
    version: view.getUint8(19),
  };
}

function clampByte(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

module.exports = { encodeTelemetry, decodeTelemetry, PACKET_SIZE };