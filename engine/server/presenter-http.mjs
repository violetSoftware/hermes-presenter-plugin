import { randomBytes } from 'node:crypto';
import { PresenterSession } from './presenter-session.mjs';
import { approvedDeck, groundingFor } from './presenter-grounding.mjs';
import { cancelTranscription, transcriptionRequest, newConnectionId } from './transcription/http.mjs';

export function createPresenterHandler(provider, { transcription, grounding = !!provider.grounding,
  heartbeatGraceMs = 30000, heartbeatPollMs = 500, now = Date.now, allowedOrigin } = {}) {
  const sessions = new Map();
  let closed = false, shutdown;
  const teardown = entry => {
    if (entry.teardown) return entry.teardown;
    const closing = (async () => {
      entry.preparationAbort?.abort();
      const warm = entry.warm; entry.warm = undefined;
      try { await warm?.close(); }
      finally { await entry.preparation?.catch(() => {}); }
    })();
    entry.teardown = closing;
    const settled = () => { if (entry.teardown === closing) entry.teardown = undefined; };
    closing.then(settled, settled);
    return closing;
  };
  const expire = entry => {
    const gapMs = now() - entry.seen;
    if (gapMs <= heartbeatGraceMs || !entry.session.connected || entry.preparation) return;
    entry.disconnectReason = { reason: 'heartbeat-timeout', gapMs, graceMs: heartbeatGraceMs,
      phase: entry.session.phase, operationId: entry.session.active?.id || null };
    entry.session.record('heartbeat-timeout', entry.disconnectReason);
    try { provider.event?.('interrupted', entry.session.active, entry.disconnectReason); } catch { /* owner fails closed */ }
    cancelTranscription(entry); entry.abort?.abort(); entry.session.command('disconnect'); void teardown(entry).catch(() => {});
  };
  const timer = setInterval(() => {
    for (const [key, entry] of sessions) {
      expire(entry);
      if (now() - entry.seen > 60 * 60 * 1000) sessions.delete(key);
    }
  }, heartbeatPollMs);
  timer.unref();
  const handler = async (req, res, next) => {
    if (!req.url.startsWith('/presenter-api/')) { if (next) return next(); res.writeHead(404).end(); return; }
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
    // Cleanup belongs to the admitted generation, never to a cookie's current work.
    let failGeneration = () => {};
    let removeAbortListener = () => {};
    try {
      // Same-origin and loopback Host validation protect an automatically minted local cookie.
      // This is a local single-operator demo, not remote/user authentication.
      const host = req.headers.host;
      const originOK = allowedOrigin ? req.headers.origin === allowedOrigin && host === new URL(allowedOrigin).host
        : /^127\.0\.0\.1:\d+$/.test(host || '') && req.headers.origin === `http://${host}`;
      if (!originOK || req.method !== 'POST' || req.headers['content-type'] !== 'application/json') return send(403, { error: 'same-origin JSON required' });
      if (closed) return send(503, { error: 'presenter closed' });
      const token = /(?:^|;\s*)presenter=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      let entry = sessions.get(token);
      const isTranscription = req.url.startsWith('/presenter-api/transcription/');
      // Capture ownership before awaiting body bytes. The cookie alone owns no turn.
      const envelope = { connectionId: req.headers['x-presenter-connection'],
        sessionId: req.headers['x-transcription-session'], turnId: req.headers['x-transcription-turn'] };
      const connection = entry?.connectionId, epoch = entry?.session.epoch;
      const initialTurn = entry?.transcription;
      const admittedTurn = isTranscription && entry?.transcription &&
        envelope.connectionId === connection && envelope.sessionId === entry.session.id &&
        envelope.turnId === entry.transcription.identity.turnId ? entry.transcription : null;
      const failBody = () => {
        if (admittedTurn && entry.transcription === admittedTurn && entry.connectionId === connection &&
            entry.session.epoch === epoch) cancelTranscription(entry);
      };
      if (isTranscription) failGeneration = failBody;
      let raw = '';
      const limit = req.url === '/presenter-api/transcription/write' ? 56000 : req.url === '/presenter-api/control' ? 76000 : 4096;
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > limit) { failBody(); return send(413, { error: 'request too large' }); }
      }
      // Body readers admitted before close must never create a new connection owner.
      if (closed) return send(503, { error: 'presenter closed' });
      let body;
      try { body = JSON.parse(raw || '{}'); } catch {
        failBody();
        throw Error('invalid JSON');
      }
      if (body == null || typeof body !== 'object' || Array.isArray(body)) throw Error('invalid request object');
      const route = req.url.slice('/presenter-api/'.length);
      if (grounding && route === 'next' && Object.keys(body).sort().join(',') !== 'epoch') throw Error('unexpected generation source');
      if (grounding && route === 'control' && Object.keys(body).some(key => !['action', 'text', 'audible', 'seq', 'epoch'].includes(key))) throw Error('unexpected control source');
      if (route === 'connect') {
        let snapshot;
        if (grounding) {
          if (!body || Object.keys(body).sort().join(',') !== (body.running === true ? 'deckId,running,slideIndex' : body.guided === true ? 'deckId,guided,slideIndex' : 'deckId,slideIndex')) throw Error('approved deck selection required');
          if (body.guided && (!provider.attended || body.deckId !== 'presenter-walkthrough')) throw Error('guided walkthrough unavailable');
          snapshot = approvedDeck(body.deckId); groundingFor(snapshot, body.slideIndex);
          if (body.running && (!provider.attended || !provider.existing || !snapshot.runningOrder)) throw Error('running order requires existing attended conversation');
        }
        if (entry) {
          provider.event?.('interrupted', entry.session.active, { reason: 'reconnect' });
          cancelTranscription(entry); entry.abort?.abort(); await teardown(entry);
          if (closed) return send(503, { error: 'presenter closed' });
          entry.session.command('reconnect'); entry.seq = 0;
        }
        else {
          const key = randomBytes(32).toString('hex');
          entry = { session: new PresenterSession({ speech: provider.speech, existing: provider.existing }), seen: now(), seq: 0 }; sessions.set(key, entry);
          res.setHeader('Set-Cookie', `presenter=${key}; HttpOnly; SameSite=Strict; Path=/presenter-api${allowedOrigin?.startsWith('https://') ? '; Secure' : ''}`);
        }
        entry.disconnectReason = undefined; entry.connectionId = newConnectionId();
        if (grounding) { entry.session.guided = body.guided === true; entry.session.running = body.running === true; entry.session.navigate(snapshot, body.slideIndex); }
        if (provider.prepare) {
          const preparationAbort = new AbortController(); entry.preparationAbort = preparationAbort;
          const connectionId = entry.connectionId;
          entry.preparation = provider.prepare(preparationAbort.signal).then(async warm => {
            if (closed || preparationAbort.signal.aborted || entry.connectionId !== connectionId) { await warm.close(); throw Error('stale preparation'); }
            entry.warm = warm;
          });
          try { await entry.preparation; } finally { entry.preparation = undefined; }
        }
      }
      if (!entry) return send(401, { error: 'connect first' });
      if (closed) return send(503, { error: 'presenter closed' });
      if (route !== 'connect') expire(entry);
      entry.seen = now();
      const s = entry.session;
      if (route === 'connect' || route === 'heartbeat') return send(200, { state: s.state(), provider: provider.label,
        heartbeatGraceMs, ...(entry.disconnectReason ? { disconnectReason: entry.disconnectReason } : {}),
        groundingEnabled: grounding, attendedTesting: !!provider.attended, ...(provider.remaining ? { remainingResponses: provider.remaining() } : {}), ...(provider.usage ? { usage: provider.usage() } : {}),
        connectionId: entry.connectionId, transcriptionAvailable: !!transcription?.available,
        transcriptionReviewRequired: !!transcription?.reviewRequired, transcriptionStreaming: !!transcription?.streaming,
        transcriptionMaxChars: transcription?.maxTranscriptChars || 1000 });
      if (route.startsWith('transcription/')) {
        if (entry.connectionId !== connection || s.epoch !== epoch || entry.transcription !== initialTurn ||
            !body || envelope.connectionId !== body.connectionId || envelope.sessionId !== body.sessionId ||
            envelope.turnId !== body.turnId) return send(409, { error: 'stale transcription envelope' });
        const result = await transcriptionRequest(entry, route.slice('transcription/'.length), body, transcription, req, res);
        return send(result.status, result.body);
      }
      if (route === 'control') {
        if (grounding && (body.epoch !== s.epoch || entry.connectionId !== connection || epoch !== s.epoch)) return send(409, { error: 'stale slide control' });
        if (!Number.isSafeInteger(body.seq) || body.seq <= entry.seq) return send(409, { error: 'stale control' });
        if (body.action === 'question' && s.hasRunningOrder() && (s.segment()?.role !== 'human' || s.active || s.phase !== 'paused')) return send(409, { error: 'question requires human boundary' });
        entry.seq = body.seq; cancelTranscription(entry);
        if (body.action === 'resume' && provider.available && !provider.available()) {
          if (s.active) return send(409, { error: 'rehearsal busy' });
          return send(200, { state: s.command('pause', undefined, false) });
        }
        const graceful = body.audible === s.active?.id && s.active?.status === 'playing' && ['pause', 'question'].includes(body.action);
        if (!graceful) { try { provider.event?.('interrupted', s.active, { reason: 'control-' + body.action }); } finally { entry.abort?.abort(); } }
        if (body.action === 'disconnect') await teardown(entry);
        return send(200, { state: s.command(body.action, body.text, graceful) });
      }
      if (route === 'navigate') {
        if (!grounding) return send(404, { error: 'grounding unavailable' });
        if (!body || Object.keys(body).sort().join(',') !== 'deckId,epoch,seq,slideIndex') throw Error('invalid navigation');
        if (entry.connectionId !== connection || epoch !== s.epoch || body.epoch !== s.epoch ||
            !Number.isSafeInteger(body.seq) || body.seq <= entry.seq) return send(409, { error: 'stale navigation' });
        const snapshot = approvedDeck(body.deckId); groundingFor(snapshot, body.slideIndex);
        entry.seq = body.seq;
        try { provider.event?.('interrupted', s.active, { reason: 'manual-navigation' }); }
        finally { cancelTranscription(entry); entry.abort?.abort(); }
        return send(200, { state: s.navigate(snapshot, body.slideIndex) });
      }
      if (route === 'next') {
        if (grounding && (entry.connectionId !== connection || epoch !== s.epoch || !s.grounding)) return send(409, { error: 'stale source request' });
        if (body.epoch !== s.epoch) return send(409, { error: 'stale epoch' });
        if (provider.available && !provider.available()) { if (!s.active) s.command('pause', undefined, false); return send(409, { error: 'rehearsal exhausted or paused' }); }
        const r = s.begin(); const abort = new AbortController(); entry.abort = abort;
        provider.event?.('requested', r);
        const ownsGeneration = () => entry.abort === abort && s.matches(r) && !abort.signal.aborted &&
          (s.epoch === r.epoch || s.active?.finishLease === s.epoch);
        failGeneration = () => {
          try { provider.event?.('error', r); } catch { /* accounting already refuses future work */ }
          if (ownsGeneration()) { abort.abort(); s.command('stop'); }
        };
        const onAborted = () => {
          const owns = ownsGeneration();
          abort.abort(); // Even an obsolete transport may only cancel its own provider work.
          if (owns) {
            if (grounding) {
              // Browser abort precedes its serialized manual control/navigation.
              // Revoke this unit without consuming that command's source epoch.
              try { provider.event?.('interrupted', s.active, { reason: 'transport-cancel' }); } catch { /* operation owner fails closed */ }
              s.active = null; s.pendingQuestion = null; s.floor = 'human'; s.phase = 'paused'; s.sequenceActive = false; s.record('transport-cancel');
            } else s.command('disconnect');
          }
        };
        req.on('aborted', onAborted);
        const onResponseClose = () => { if (!res.writableFinished) { onAborted(); if (!s.connected) void teardown(entry).catch(() => {}); } };
        res.on('close', onResponseClose);
        removeAbortListener = () => { req.off('aborted', onAborted); res.off('close', onResponseClose); };
        const warm = entry.warm;
        let text;
        try { text = await (warm?.generate || provider.generate)(s.payload(), abort.signal); }
        catch (error) {
          if (!provider.attended && warm && entry.warm === warm && ownsGeneration()) {
            s.command('disconnect'); await teardown(entry);
          }
          throw error;
        }
        if (!s.generated(r, text)) return send(409, { error: 'stale generation' });
        if (provider.synthesizeStream) {
          const audio = await provider.synthesizeStream(text, abort.signal);
          abort.signal.throwIfAborted();
          if (!s.audioReady(r, 'stream')) return send(409, { error: 'stale audio' });
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          entry.streamUnit = r; entry.streamComplete = false;
          const write = async frame => {
            abort.signal.throwIfAborted();
            if (closed || !s.matches(r)) throw Error('stale stream');
            if (!res.write(JSON.stringify(frame) + '\n')) await new Promise((resolve, reject) => {
              const cleanup = () => { res.off('drain', drain); res.off('close', close); abort.signal.removeEventListener('abort', close); };
              const drain = () => { cleanup(); resolve(); };
              const close = () => { cleanup(); reject(Error('stream closed')); };
              res.once('drain', drain); res.once('close', close); abort.signal.addEventListener('abort', close, { once: true });
              if (abort.signal.aborted || res.destroyed) close();
            });
          };
          await write({ type: 'unit', state: s.state(), unit: { ...r, text, sampleRate: audio.sampleRate } });
          for await (const bytes of audio.chunks) {
            await write({ type: 'pcm', id: r.id, epoch: r.epoch, audio: bytes.toString('base64') });
          }
          await write({ type: 'eof', id: r.id, epoch: r.epoch });
          provider.event?.('stream-eof', r);
          entry.streamComplete = true; res.end(); return;
        }
        const audio = await provider.synthesize(text, abort.signal);
        if (!s.audioReady(r, 'ready')) return send(409, { error: 'stale audio' });
        return send(200, { state: s.state(), unit: { ...r, text, audio: audio.bytes.toString('base64'), contentType: audio.contentType } });
      }
      if (route === 'started' || route === 'ended') {
        if (route === 'ended' && entry.streamUnit?.id === body.id && !entry.streamComplete) return send(409, { error: 'stream incomplete' });
        const unit = s.active ? { ...s.active } : null;
        if (!(route === 'ended' ? s.ended(body, active => provider.event?.('delivered', active)) : s.started(body))) return send(409, { error: 'stale playback' });
        if (route === 'ended' && provider.singleResponse && !s.hasRunningOrder()) { s.floor = 'human'; s.phase = 'paused'; }
        if (route === 'started') provider.event?.('started', unit);
        return send(200, { state: s.state() });
      }
      return send(404, { error: 'unknown route' });
    } catch {
      // Never forward upstream errors, credentials, request bodies or hidden reasoning.
      failGeneration();
      if (res.headersSent) { res.destroy(); return; }
      if (closed) return send(503, { error: 'presenter closed' });
      return send(400, { error: 'presenter request failed; paused' });
    } finally {
      removeAbortListener();
    }
  };
  handler.close = () => {
    if (shutdown) return shutdown;
    closed = true; clearInterval(timer);
    const closes = [];
    for (const entry of sessions.values()) {
      try { provider.event?.('interrupted', entry.session.active, { reason: 'shutdown' }); } catch { /* exhausted on persistence failure */ }
      cancelTranscription(entry); entry.abort?.abort(); entry.session.command('disconnect');
      closes.push(teardown(entry));
    }
    sessions.clear();
    shutdown = Promise.all(closes).then(() => {});
    return shutdown;
  };
  return handler;
}
