import { PassagePlayer, readPassage } from './playback.js';
import { TranscriptionTurn } from '../transcription/turn.js';
import { browserCapture } from '../transcription/capture.js';
import { httpTranscription } from '../transcription/http.js';
import './ui.css';

/** Browser owns audible playback; the bridge owns draft/delivery authority. */
export function mountPresenter({ capture = browserCapture(), transport = httpTranscription(), transcriptionTimeoutMs = 10000, deckId, reveal, guided = false, running = false } = {}) {
  const panel = document.createElement('section'); panel.id = 'presenter-panel';
  panel.setAttribute('aria-label', 'Presenter controls');
  const dock = document.createElement('div'); dock.className = 'presenter-dock';
  const toggle = document.createElement('button'); toggle.textContent = '☰';
  toggle.setAttribute('aria-label', 'Presenter menu'); toggle.setAttribute('aria-controls', panel.id);
  const setPanelOpen = open => { panel.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); };
  setPanelOpen(!window.matchMedia('(max-width: 640px), (max-height: 500px)').matches);
  toggle.onclick = () => { setPanelOpen(panel.hidden); if (panel.hidden) toggle.focus(); };
  // Keep operator typing/button activation out of Reveal's document shortcuts.
  dock.addEventListener('keydown', event => event.stopPropagation());
  panel.addEventListener('keydown', event => event.stopPropagation());
  dock.append(toggle); document.body.append(dock);
  const status = document.createElement('p'); status.id = 'presenter-status'; status.setAttribute('role', 'status');
  const question = document.createElement('input'); question.id = 'presenter-question'; question.placeholder = 'finalized public question'; question.maxLength = 1000;
  question.setAttribute('aria-label', 'finalized public question');
  const ledger = document.createElement('ol'); ledger.id = 'presenter-ledger';
  const draft = document.createElement('p'); draft.textContent = 'draft: none';
  const warning = document.createElement('p'); warning.textContent = 'local operator demo · microphone requires explicit consent · no automatic slide actions';
  const segmentHint = document.createElement('p'); segmentHint.id = 'presenter-segment'; panel.append(segmentHint);
  const micStatus = document.createElement('p'); micStatus.id = 'presenter-microphone-status'; micStatus.setAttribute('role', 'status');
  const transcript = document.createElement('p'); transcript.id = 'presenter-transcript';
  const speaker = document.createElement('input'); speaker.placeholder = 'speaker label (unverified)'; speaker.setAttribute('aria-label', 'speaker label (unverified)'); speaker.maxLength = 80;
  const editor = document.createElement('textarea'); editor.id = 'presenter-review'; editor.maxLength = 1000;
  editor.setAttribute('aria-label', 'review candidate (not provider-complete)'); editor.hidden = true;
  dock.append(status);
  panel.append(warning, micStatus, speaker, transcript, editor, question, draft, ledger); document.body.append(panel);
  let state, label = '', seq = 0, version = 0, connectionOwner = 0, busy = false, connected = false, connecting = false, manualBlocked = true, groundingEnabled = false, attendedTesting = false;
  const slideSelection = () => ({ deckId, slideIndex: reveal?.getIndices().h || 0 });
  let audio, url, current, audioContext, streamAbort, controls = Promise.resolve(), heartbeatBusy = false, handoff = false, micVersion = 0, mirroredIndex = null, micConsent = false;
  let heartbeatGraceMs = 30000, heartbeatSeen = 0, heartbeatReason = '';
  const heartbeatNotice = reason => {
    if (heartbeatReason === reason) return;
    heartbeatReason = reason; console.warn('[presenter heartbeat]', reason); show();
  };
  const turn = new TranscriptionTurn({ capture, transport, timeoutMs: transcriptionTimeoutMs,
    diagnosticContext: () => ({ handover: handoff }), onChange: s => {
    if (s.error && ['paused', 'unavailable'].includes(s.phase)) micConsent = false;
    micStatus.textContent = `microphone: ${s.phase} · ${s.error || 'no raw audio retained'} · speaker label unverified`;
    transcript.textContent = s.reviewRequired ? `Committed segments: ${s.text}\nProvisional (uncertain): ${s.tentative}` : s.text + s.tentative;
    editor.hidden = s.phase !== 'review'; editor.disabled = s.phase !== 'review';
    if (editor.value !== s.candidate) editor.value = s.candidate;
    show();
  } });
  editor.oninput = () => { try { turn.editCandidate(editor.value); } catch { /* Invalid/stale editor has no authority. */ } };
  const cancelMic = () => { micConsent = false; micVersion++; handoff = false; turn.cancel(); };
  const canCapture = () => connected && manualBlocked && state?.floor === 'human' && state.phase === 'paused' && !audio && !busy && !handoff && (!state.runningOrder || state.runningOrder.segment?.role === 'human' && state.runningOrder.segment.slideId === state.source.currentSlide.id);
  const rearmMic = () => {
    if (micConsent && !transport.reviewRequired && state?.runningOrder && canCapture() && ['idle', 'finalized'].includes(turn.phase)) {
      void turn.start({ sessionId: state.id, allowed: canCapture, speakerLabel: speaker.value });
    }
  };
  let reviewControls = [];
  const show = () => {
    for (const button of reviewControls) button.hidden = !!state?.runningOrder && !transport.reviewRequired;
    warning.textContent = transport.reviewRequired
      ? 'ElevenLabs cloud transcription · Enable explicitly consents to audio upload; provider billing/retention apply (zero retention NOT guaranteed). Stop → review/edit → explicit submit. No raw audio saved locally.'
      : state?.runningOrder ? 'ElevenLabs microphone is optional. Enable explicitly consents to audio upload, provider billing/retention (zero retention NOT guaranteed), and rearming at planned human segments. One resume stops/finalizes speech and hands back automatically. No raw audio saved locally; submitted transcripts retained in the existing conversation/private operation records.' : state?.guided ? 'guided walkthrough · delivered narration advances once, then human floor · explicit microphone consent only' : 'local operator demo · microphone requires explicit consent · no automatic slide actions';
    label = transport.available && !transport.reviewRequired && state?.runningOrder ? label.replace(' / NO MIC', ' / CONSENT-GATED MIC') : label;
    status.textContent = `${connected ? state?.phase || 'paused' : 'disconnected'} · ${state?.floor || 'human'} floor${groundingEnabled && state?.source ? ` · ${state.source.deckId} slide ${state.source.currentSlide.index + 1}` : ''}${state?.guided ? state.guided.finished ? ' · guided finished' : ' · guided' : ''} · ${label}`;
    ledger.replaceChildren(...(state?.delivered || []).map(item => { const li = document.createElement('li'); li.textContent = item.text; return li; }));
    if (state?.runningOrder) status.textContent += ` · auto-play ${state.runningOrder.finished ? 'finished' : state.runningOrder.active ? 'active' : 'paused'}`;
    if (heartbeatReason) status.textContent += ` · ${heartbeatReason}`;
    if (micConsent || ['starting', 'listening', 'finalizing', 'paused'].includes(turn.phase)) status.textContent += ` · mic ${turn.phase}`;
    if (handoff) status.textContent += ' · handing over / finalizing speech';
    const segment = state?.runningOrder?.segment;
    segmentHint.textContent = segment ? `${segment.id} · ${segment.role} · ${segment.role === 'human' ? micConsent ? 'Microphone enabled · speak, then resume / hand to agent.' : 'Temporary placeholder contribution (not verbatim): ' + segment.placeholder + ' · Explicit handback confirms completion.' : segment.guidance}` : '';
    queueMicrotask(rearmMic);
  };
  const api = async (route, body = {}, timeoutMs = 100000) => {
    const response = await fetch('/presenter-api/' + route, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw Error('bridge refused or unavailable'); return response.json();
  };
  const silence = () => { streamAbort?.abort(); streamAbort = null;
    if (audio instanceof PassagePlayer) audio.stop();
    else if (audio) { audio.onended = null; audio.pause(); audio.removeAttribute('src'); audio.load(); } audio = null; current = null;
    if (url) URL.revokeObjectURL(url); url = null; draft.textContent = 'draft: none'; };
  const fail = () => { cancelMic(); manualBlocked = true; version++; connectionOwner++; connecting = false; connected = false; busy = false; silence(); show(); };
  const heartbeatTimeout = () => {
    state = { ...state, connected: false, floor: 'human', phase: 'paused', active: null,
      ...(state?.runningOrder ? { runningOrder: { ...state.runningOrder, active: false } } : {}) };
    heartbeatNotice('heartbeat timeout — reconnect paused; explicit handover required'); fail();
  };
  const pump = async () => {
    if (manualBlocked || busy || !connected || state?.floor !== 'agent' || state.phase !== 'ready') return;
    busy = true; const v = version; let ownedPlayer;
    try {
      streamAbort = new AbortController();
      const response = await fetch('/presenter-api/next', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ epoch: state.epoch }),
        signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(100000)]) });
      if (!response.ok) throw Error('bridge refused');
      if (v !== version || !connected) { await response.body?.cancel(); return; }
      if (response.headers.get('content-type') === 'application/x-ndjson') {
        const player = new PassagePlayer(audioContext); ownedPlayer = audio = player;
        let unit, started = false, providerEnd = false;
        await readPassage(response, async frame => {
          if (audio !== player || !connected || player.stopped) throw Error('stale playback');
          if (frame.type === 'unit') {
            if (unit || frame.unit.sampleRate !== 24000) throw Error('invalid unit');
            unit = current = frame.unit; state = frame.state;
            draft.textContent = 'draft (not delivered): ' + unit.text;
          } else if (frame.type === 'pcm') {
            if (!unit || frame.id !== unit.id || frame.epoch !== unit.epoch || providerEnd || typeof frame.audio !== 'string' || frame.audio.length > 5500) throw Error('invalid PCM');
            const bytes = Uint8Array.from(atob(frame.audio), c => c.charCodeAt(0));
            if (!started) {
              const reply = await api('started', { id: unit.id, epoch: unit.epoch });
              if (audio !== player || !connected) throw Error('stale start');
              state = reply.state; started = true;
            }
            await player.append(bytes); show();
          } else if (frame.type === 'eof') {
            if (!started || frame.id !== unit.id || frame.epoch !== unit.epoch) throw Error('invalid end');
            providerEnd = true;
          } else throw Error('invalid frame');
        }, streamAbort.signal);
        await player.drain();
        if (audio !== player || !connected) return;
        if (state.guided || state.runningOrder) {
          const owner = connectionOwner, completionVersion = version;
          // Sole acknowledgment boundary shares controls. A manual action silences
          // immediately and invalidates this lease before a queued callback runs.
          controls = controls.then(async () => {
            if (audio !== player || !connected || owner !== connectionOwner || completionVersion !== version) return;
            const ended = await api('ended', { id: unit.id, epoch: unit.epoch });
            if (!connected || owner !== connectionOwner) return;
            state = ended.state; // Queued manual navigation needs the acknowledged epoch.
            if (audio !== player || completionVersion !== version) {
              // Completion was accepted before the action but its reply was late.
              // Restore the operator's actual slide through existing navigation,
              // retaining delivery while cancelling the unseen automatic movement.
              if (slideSelection().slideIndex !== state.source.currentSlide.index) {
                const reply = await api('navigate', { ...slideSelection(), seq: ++seq, epoch: state.epoch });
                if (connected && owner === connectionOwner) state = reply.state;
              }
              return;
            }
            manualBlocked = state.floor !== 'agent' || state.phase !== 'ready'; silence(); busy = false;
            const index = state.source.currentSlide.index;
            if (slideSelection().slideIndex !== index) {
              // Scroll view dispatches later; next crosses its trigger boundary.
              mirroredIndex = index;
              if (reveal.isScrollView() && index === slideSelection().slideIndex + 1) reveal.next(); else reveal.slide(index, 0);
            }
            show(); // Running order alone can grant the next agent segment.
          }).catch(() => { if (owner === connectionOwner) fail(); });
          await controls; if (!manualBlocked) void pump(); return;
        }
        const ended = await api('ended', { id: unit.id, epoch: unit.epoch });
        if (audio !== player || !connected) return;
        state = ended.state; if (state.floor === 'human') manualBlocked = true;
        silence(); busy = false; show(); void pump(); return;
      }
      const result = await response.json();
      if (v !== version || !connected) return;
      state = result.state; current = result.unit; draft.textContent = 'draft (not delivered): ' + current.text;
      const bytes = Uint8Array.from(atob(current.audio), c => c.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: current.contentType })); audio = new Audio(url);
      const unit = current;
      audio.onended = async () => {
        // Graceful pause increments local version but intentionally retains this playback lease.
        if (current !== unit || !connected) return;
        try { const ended = await api('ended', { id: unit.id, epoch: unit.epoch });
          if (current !== unit || !connected) return;
          state = ended.state; if (state.floor === 'human') manualBlocked = true;
          silence(); busy = false; show(); void pump();
        } catch { fail(); }
      };
      audio.onerror = fail;
      // Server must acknowledge ownership before playback starts. Failure is fail-paused.
      const started = await api('started', { id: unit.id, epoch: unit.epoch });
      if (v !== version || !connected) return;
      state = started.state; await audio.play(); show();
    } catch {
      if (v === version || (ownedPlayer && audio === ownedPlayer)) {
        if (attendedTesting && connected) {
          cancelMic();
          manualBlocked = true; silence(); busy = false;
          try { const result = await api('heartbeat'); if (v !== version || !connected) return;
            if (!result.state.connected || result.state.floor !== 'human' || result.state.phase !== 'paused') throw Error('not paused');
            state = result.state; label = result.provider; show();
          } catch { fail(); }
        } else fail();
      }
    }
    finally { if (v !== version) busy = !!audio; }
  };
  const control = (action, text, handoffLease) => {
    const owner = connectionOwner;
    const ownsHandoff = () => handoff && handoffLease === micVersion && connected;
    if (handoffLease === undefined) cancelMic();
    else if (!ownsHandoff()) return Promise.resolve(false);
    manualBlocked = action !== 'resume';
    version++; const graceful = ['pause', 'question'].includes(action) && audio && !audio.paused;
    const audible = graceful ? current.id : null;
    if (!graceful) { silence(); busy = false; }
    // Serialize commands, never generation; manual stop can preempt in-flight work immediately.
    controls = controls.then(async () => {
      // Internal submission must not cancel its own lease. Operator controls do.
      if (owner !== connectionOwner || !connected) return false;
      if (handoffLease !== undefined && !ownsHandoff()) return false;
      try {
        const result = await api('control', { action, text, audible, seq: ++seq, ...(groundingEnabled ? { epoch: state.epoch } : {}) });
        if (owner !== connectionOwner || !connected) return false;
        if (handoffLease !== undefined && !ownsHandoff()) return false;
        state = result.state; if (action === 'disconnect') connected = false;
        if (action === 'resume') manualBlocked = state.floor !== 'agent' || state.phase !== 'ready';
        show();
        if (state.runningOrder && action === 'resume' && slideSelection().slideIndex !== state.source.currentSlide.index) {
          mirroredIndex = state.source.currentSlide.index;
          if (reveal.isScrollView() && mirroredIndex === slideSelection().slideIndex + 1) reveal.next(); else reveal.slide(mirroredIndex, 0);
        }
        if (action === 'resume') void pump();
        return true;
      } catch (error) {
        if (handoffLease === undefined || ownsHandoff()) throw error;
        return false;
      }
    }).catch(() => { if (owner === connectionOwner) fail(); });
    return controls;
  };
  const handToAgent = async () => {
    if (!connected || handoff || turn.phase === 'starting') return;
    if (transport.reviewRequired && turn.phase !== 'idle' && turn.phase !== 'unavailable') {
      if (turn.phase === 'listening' && canCapture()) {
        handoff = true; const m = micVersion;
        try { await turn.reviewCandidate(); } finally { if (m === micVersion) handoff = false; }
      }
      return; // Stop/commit/review/error NEVER resumes or submits automatically.
    }
    if (turn.phase !== 'listening') { if (!['finalizing', 'paused'].includes(turn.phase)) void control('resume'); return; }
    handoff = true; const m = micVersion;
    show();
    try {
      const text = await turn.finalize();
      if (m !== micVersion || !connected) return;
      if (state.runningOrder?.segment?.role === 'human') {
        await control('resume', text, m);
        return;
      }
      if (!await control('question', text, m)) return;
      // Keep the lease until BOTH requests settle; stop/disconnect invalidate it.
      if (m !== micVersion || !connected) return;
      await control('resume', undefined, m);
    } catch { /* Explicit transcript error remains visible; floor stays human/paused. */ }
    finally { if (m === micVersion) { handoff = false; show(); } }
  };
  const button = (name, action, target = panel) => { const b = document.createElement('button'); b.textContent = name; b.onclick = action; target.append(b); return b; };
  button('connect', () => { cancelMic(); manualBlocked = true; version++; silence(); busy = false;
    const owner = ++connectionOwner; connected = false; connecting = true;
    if (window.AudioContext) { audioContext ||= new AudioContext(); void audioContext.resume(); }
    // Connect and every reconciliation share the control chain. Navigation during
    // either await updates Reveal only; readiness waits for the newest selection.
    controls = controls.then(async () => {
      if (owner !== connectionOwner) return;
      const selection = slideSelection();
      const result = await api('connect', deckId ? { ...selection, ...(running ? { running: true } : guided ? { guided: true } : {}) } : {});
      let reconciled = result.state, nextSeq = 0;
      while (owner === connectionOwner && result.groundingEnabled && slideSelection().slideIndex !== reconciled.source.currentSlide.index) {
        const reply = await api('navigate', { ...slideSelection(), seq: ++nextSeq, epoch: reconciled.epoch }); reconciled = reply.state;
      }
      if (owner !== connectionOwner) {
        // The server accepted this owner, but a pending disconnect/new Connect
        // revoked browser ownership. Retire it before the next queued owner.
        await api('control', { action: 'disconnect', seq: ++nextSeq, ...(result.groundingEnabled ? { epoch: reconciled.epoch } : {}) });
        return;
      }
      transport.configure?.(result); state = reconciled; label = result.provider;
      heartbeatGraceMs = result.heartbeatGraceMs || 30000; heartbeatSeen = performance.now(); heartbeatReason = '';
      groundingEnabled = !!result.groundingEnabled; attendedTesting = !!result.attendedTesting; seq = nextSeq; connecting = false; connected = true; show();
    }).catch(() => { if (owner === connectionOwner) fail(); });
  });
  button('enable microphone for question', () => {
    if (canCapture()) { micConsent = true; void turn.start({ sessionId: state.id, allowed: canCapture, speakerLabel: speaker.value }); show(); }
  });
  button('cancel microphone', cancelMic);
  reviewControls.push(button('stop capture / review candidate', () => { if (transport.reviewRequired) void handToAgent(); }));
  button('discard / re-record', () => { if (!handoff && canCapture()) { cancelMic(); void turn.start({ sessionId: state.id, allowed: canCapture, speakerLabel: speaker.value }); } });
  reviewControls.push(button('submit reviewed text / hand to presenter', async () => {
    if (!transport.reviewRequired || turn.phase !== 'review' || !canCapture()) return;
    let text; try { text = turn.confirmCandidate(); } catch { return; }
    handoff = true; const m = micVersion;
    try {
      if (!await control('question', text, m) || m !== micVersion || !connected) return;
      await control('resume', undefined, m);
    } finally { if (m === micVersion) handoff = false; }
  }));
  button('resume / hand to agent', () => { void handToAgent(); });
  button('pause after sentence', () => { if (connected) void control('pause'); });
  button('finalize question', () => { if (connected && question.value.trim() && (!state.runningOrder || state.runningOrder.segment?.role === 'human' && state.phase === 'paused')) void control('question', question.value.trim()); });
  button('emergency stop', () => { if (connected) void control('stop'); else { cancelMic(); manualBlocked = true; version++; silence(); busy = false; } }, dock).className = 'presenter-stop';
  button('disconnect', () => { if (connecting) fail(); else if (connected) void control('disconnect'); });
  reveal?.on('slidechanged', () => {
    const mirrored = mirroredIndex === slideSelection().slideIndex;
    mirroredIndex = null;
    if (mirrored) return;
    if (!connected || !groundingEnabled) return;
    // Navigation is manual, silence immediately; never call pump or grant the floor.
    cancelMic(); manualBlocked = true; version++; silence(); busy = false;
    const selection = slideSelection(), v = version, owner = connectionOwner;
    controls = controls.then(async () => {
      if (!connected || owner !== connectionOwner) return;
      const reply = await api('navigate', { ...selection, seq: ++seq, epoch: state.epoch });
      if (!connected || owner !== connectionOwner) return;
      state = reply.state; if (v === version) show();
    }).catch(() => { if (owner === connectionOwner) fail(); });
  });
  const heartbeat = setInterval(async () => {
    if (!connected) return;
    if (performance.now() - heartbeatSeen > heartbeatGraceMs) { heartbeatTimeout(); return; }
    if (heartbeatBusy) return; heartbeatBusy = true;
    const owner = connectionOwner, v = version;
    try {
      const result = await api('heartbeat', {}, Math.min(5000, heartbeatGraceMs));
      if (owner !== connectionOwner || v !== version || !connected) return;
      if (!result.state.connected) {
        state = result.state;
        if (result.disconnectReason?.reason === 'heartbeat-timeout') heartbeatTimeout();
        else { heartbeatNotice('server disconnected — explicit reconnect required'); fail(); }
        return;
      }
      // A late successful request cannot revive playback after the local deadline.
      if (performance.now() - heartbeatSeen > heartbeatGraceMs) { heartbeatTimeout(); return; }
      heartbeatSeen = performance.now(); heartbeatReason = ''; show();
    }
    catch {
      if (owner !== connectionOwner || v !== version || !connected) return;
      if (performance.now() - heartbeatSeen > heartbeatGraceMs) heartbeatTimeout();
      else heartbeatNotice('heartbeat fetch failed — within grace');
    }
    finally { heartbeatBusy = false; }
  }, 1000);
  window.addEventListener('offline', () => { if (connected) heartbeatNotice('browser offline — within heartbeat grace'); });
  window.addEventListener('pagehide', () => { clearInterval(heartbeat); fail(); });
  show();
}
