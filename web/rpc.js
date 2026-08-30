// ---------------------------------------------------------------------------
// rpc.js -- client stub for the gRPC SessionService.
//
// The browser cannot open a gRPC channel itself (gRPC needs HTTP/2 trailers,
// which no browser exposes to JavaScript), so every call here goes to the
// server's transcoding gateway, which turns it into a genuine gRPC call.
//
// Everything below is still request/reply with a typed contract defined in
// proto/session.proto -- that is what makes it RPC rather than "just REST".
// The defining property of RPC is that a remote call is made to LOOK like a
// local function call; that is exactly what this module provides.
// ---------------------------------------------------------------------------

const callLog = [];

async function call(method, request) {
  const t0 = performance.now();
  const res = await fetch('/rpc/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request || {}),
  });
  const body = await res.json();
  const ms = performance.now() - t0;

  callLog.unshift({ method, ms: ms.toFixed(1), at: new Date(), error: body.error });
  callLog.length = Math.min(callLog.length, 40);

  // Surface a failed RPC as a thrown exception, so a remote failure looks
  // like a local one at the call site. This is the piece that makes the
  // "transparency" goal of Unit 1 concrete -- and also where it leaks, since
  // a local call cannot fail because the network partitioned.
  if (body.error) throw new Error(method + ': ' + body.error);
  return body;
}

export const rpc = {
  createSession: (r) => call('CreateSession', r),
  joinSession: (r) => call('JoinSession', r),
  leaveSession: (r) => call('LeaveSession', r),
  listParticipants: (r) => call('ListParticipants', r),
  setTempo: (r) => call('SetTempo', r),
  armTrack: (r) => call('ArmTrack', r),
  setTransport: (r) => call('SetTransport', r),
  getServerTime: (r) => call('GetServerTime', r),
  heartbeat: (r) => call('Heartbeat', r),
  log: callLog,
};
