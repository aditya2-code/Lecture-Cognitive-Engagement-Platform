// Simulates several attendees streaming telemetry packets, plus one
// presenter subscribing to the live aggregate. Run with the server already
// running: `node loadtest.js`
const WebSocket = require('ws');
const { encodeTelemetry } = require('./telemetryCodec');

const SESSION_ID = 'loadtest-session';
const NUM_ATTENDEES = 5;
const PACKETS_PER_ATTENDEE = 20;
const SEND_INTERVAL_MS = 100;
const SERVER_URL = 'ws://localhost:4000/ws';

function randomTelemetry() {
  return {
    timestamp: Date.now() + Math.random(),
    faceDetected: Math.random() > 0.1,
    attention: Math.round(40 + Math.random() * 60),
    confusion: Math.round(Math.random() * 50),
    headYaw: Math.round((Math.random() - 0.5) * 40),
    headPitch: Math.round((Math.random() - 0.5) * 30),
  };
}

function runAttendee(id) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${SERVER_URL}?sessionId=${SESSION_ID}&role=attendee`);
    let sent = 0;

    socket.on('open', () => {
      const interval = setInterval(() => {
        if (sent >= PACKETS_PER_ATTENDEE) {
          clearInterval(interval);
          socket.close();
          return;
        }
        const packet = encodeTelemetry(randomTelemetry());
        socket.send(packet);
        sent += 1;
      }, SEND_INTERVAL_MS);
    });

    socket.on('close', () => resolve({ id, sent }));
    socket.on('error', reject);
  });
}

function runPresenter() {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${SERVER_URL}?sessionId=${SESSION_ID}&role=presenter`);
    const receivedUpdates = [];

    socket.on('message', (data) => {
      receivedUpdates.push(JSON.parse(data.toString()));
    });

    setTimeout(() => {
      socket.close();
      resolve(receivedUpdates);
    }, PACKETS_PER_ATTENDEE * SEND_INTERVAL_MS + 1500);
  });
}

async function main() {
  console.log(`Starting load test: ${NUM_ATTENDEES} attendees, ${PACKETS_PER_ATTENDEE} packets each`);

  const presenterPromise = runPresenter();
  const attendeePromises = Array.from({ length: NUM_ATTENDEES }, (_, i) => runAttendee(i));

  const [presenterUpdates, ...attendeeResults] = await Promise.all([presenterPromise, ...attendeePromises]);

  const totalSent = attendeeResults.reduce((sum, r) => sum + r.sent, 0);
  console.log(`\nAttendees finished. Total packets sent: ${totalSent}`);
  console.log(`Presenter received ${presenterUpdates.length} live aggregate updates.`);
  if (presenterUpdates.length > 0) {
    console.log('Last aggregate update:', presenterUpdates[presenterUpdates.length - 1]);
  }

  const res = await fetch(`http://localhost:4000/api/sessions/${SESSION_ID}/aggregate`);
  console.log('\nFinal pull-based aggregate:', await res.json());
  process.exit(0);
}

main().catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});