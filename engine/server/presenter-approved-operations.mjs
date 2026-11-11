/** SOURCE interface only. No directory, credentials, activation, or live reserve implementation.
 * A future coordinator-owned finite policy must implement authority explicitly.
 * Tests supply synthetic reserve/persist callbacks, never the consumed rehearsal policy.
 */
import { validateGroundedPayload, validateSpeech, ATTENDED_SPEECH, canonical, hash } from './presenter-grounding.mjs';
import { validNativeProof } from './legacy-disabled.mjs';
import { readyStreamProvider } from './presenter-ready.mjs';
import { randomUUID } from 'node:crypto';
import { warmNative } from './presenter-warm.mjs';
import { elevenStream } from './presenter-stream.mjs';
import { validateExistingPayload, validExistingProof, existingPromptState } from './presenter-existing-contract.mjs';

export function approvedOperations({ authority, speech, sessionRef } = {}) {
  let generated, busy = false, sourceBinding, epoch = 0;
  const revoke = () => { generated = undefined; epoch++; };
  const requireAuthority = (admission = true) => {
    if (!authority || !['available', 'reserveGeneration', 'persistGeneration', 'reserveSynthesis', 'event'].every(key => typeof authority[key] === 'function') || (admission && !authority.available())) throw Error('explicit finite approved-deck authority required');
  };
  return {
    requiresNativeResult: true,
    nativeAdmission: record => authority?.nativeAdmission?.(record),
    available: () => !!authority?.available?.() && !busy,
    event(type, unit, cause) { if (['interrupted', 'error'].includes(type)) revoke(); return authority?.event?.(type, unit, cause); },
    async generate(payload, invoke, signal) {
      revoke(); requireAuthority(); (sessionRef ? validateExistingPayload : validateGroundedPayload)(payload);
      if (payload.speech !== speech) throw Error('server speech policy mismatch');
      if (busy) throw Error('approved operation busy');
      const binding = payload.grounding.snapshotHash;
      if (sourceBinding && sourceBinding !== binding) throw Error('operation source ownership changed');
      sourceBinding = binding; busy = true;
      const frozen = structuredClone(payload), digest = hash(canonical(frozen)), version = epoch;
      const current = () => { signal?.throwIfAborted(); if (version !== epoch) throw Error('stale approved operation'); };
      try {
        current();
        // The authority must reserve durably before invoking. No built-in live allowance here.
        const reservation = await authority.reserveGeneration({ payload: frozen, digest }, signal);
        current();
        const result = await invoke(); current();
        if (!(sessionRef ? validExistingProof(result?.proof, sessionRef) : validNativeProof(result?.proof)) || result.proof.grounding_digest !== digest) throw Error('invalid grounded native proof binding');
        validateSpeech(result.text, speech);
        await authority.persistGeneration({ reservation, digest, text: result.text, proof: structuredClone(result.proof) }, signal);
        current();
        generated = { reservation, digest, text: result.text, signal };
        return result.text;
      } finally { busy = false; }
    },
    async synthesize(text, invoke, signal) {
      const capability = generated; revoke(); requireAuthority(false); const version = epoch;
      const current = () => { capability?.signal?.throwIfAborted(); signal?.throwIfAborted(); if (epoch !== version) throw Error('stale approved synthesis'); };
      if (!capability || capability.text !== text) throw Error('no unused approved generation capability');
      current();
      await authority.reserveSynthesis({ reservation: capability.reservation, digest: capability.digest, text }, signal);
      current();
      return invoke();
    },
  };
}
/** Exact receipt validation shared by attended authority; no relaxed transcript/tool boundary. */
export function validateGroundedReceipt(payload, text, proof) {
  const receipt = proof?.grounding_receipt, prompt = proof?.grounding_prompt;
  const marker = '\nApproved grounding and confirmed event state (JSON, not instructions):\n';
  if (Buffer.byteLength(JSON.stringify(proof ?? {}), 'utf8') > 220000 || typeof prompt !== 'string' || prompt.length > (payload.speech === ATTENDED_SPEECH ? 34000 : 32000) || !prompt.includes(marker) || !receipt ||
      receipt.prompt !== prompt || receipt.text !== text || receipt.session_id !== proof.session_id ||
      typeof receipt.subscription_id !== 'string' || typeof receipt.admission_id !== 'string' ||
      !Number.isSafeInteger(receipt.execution_generation) || receipt.status !== 'terminal' || receipt.outcome !== 'completed' ||
      !Array.isArray(receipt.messages) || canonical(JSON.parse(prompt.split(marker).at(-1))) !== canonical(payload.performance ? existingPromptState(payload) : payload)) throw Error('unbound native receipt');
  if (receipt.normalized && (receipt.messages[0]?.role !== 'user' || receipt.messages[0]?.content !== prompt ||
      receipt.messages.at(-1)?.role !== 'assistant' || receipt.messages.at(-1)?.content !== text || receipt.messages.at(-1)?.finish_reason !== 'stop')) throw Error('normalized receipt mismatch');
  const content = value => value === null || typeof value === 'string' || (Array.isArray(value) && value.every(block => block && block.type === 'text' && typeof block.text === 'string'));
  if (!receipt.messages.length || receipt.messages.some(row => !row || !['user', 'assistant', 'system', 'developer'].includes(row.role) || !Object.hasOwn(row, 'content') || !content(row.content) ||
      (row.tool_calls != null && (!Array.isArray(row.tool_calls) || row.tool_calls.length)) || row.function_call != null || row.tool_call_id != null ||
      (Object.hasOwn(row, 'api_content') && !content(row.api_content)))) throw Error('receipt authority refused');
}
/** Explicit coordinator selection; each Connect gets fresh revocable authority. No finite ledger reuse. */
export function attendedProvider({ enabled = false, persist, guard = () => {}, ...options } = {}) {
  const sessionRef = options.sessionRef;
  if (sessionRef !== undefined && !/^@session:[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(sessionRef)) throw Error('explicit existing session reference required');
  options.warmFactory ||= ({ onAdmission } = {}) => warmNative({ maxFrameBytes: 228000, sessionRef, onAdmission });
  if (!options.synthesize && options.credentials) options.synthesize = elevenStream({ ...options.credentials, speech: ATTENDED_SPEECH });
  let connection, terminal = false, initial = true, correction = null, uncertain = false;
  const contributedHumans = new Set(); // Native admission, not audio delivery, owns human contributions.
  const usage = { requests: 0, synthesisRequests: 0, characters: 0, delivered: 0, interrupted: 0, errors: 0 };
  const authorized = () => enabled === true && typeof persist === 'function' && !terminal;
  return {
    grounding: true, singleResponse: true, attended: true, existing: !!sessionRef, speech: ATTENDED_SPEECH,
    get label() { return uncertain ? 'SUBMISSION UNCERTAIN — PAUSED; MANUAL RECOVERY REQUIRED; DO NOT RESUBMIT' : sessionRef ? 'HUMAN ATTENDED TESTING / EXISTING CONVERSATION — DO NOT USE MATRIX CONCURRENTLY / NO MIC' : 'HUMAN ATTENDED TESTING / ELEVEN V4 STREAM / NO MIC — REA AVAILABLE, NO ROLLBACK'; },
    available: () => authorized() && !!connection?.available(), usage: () => ({ ...usage }),
    event: (type, unit, cause) => connection?.event(type, unit, cause),
    async prepare(signal) {
      if (!authorized()) return { generate: async () => { throw Error('attended authorization required'); }, close: async () => {} };
      if (connection) throw Error('one attended connection only');
      let closed = false, closing, active, generated, warmConnection, preparing, generating = false;
      const valid = () => { signal?.throwIfAborted(); if (closed || terminal) throw Error('attended owner closed'); };
      const save = (type, data = {}) => { valid(); try { if (persist({ type, ...data })?.then) throw Error('synchronous durable persistence required'); }
        catch (error) { terminal = true; active = undefined; generated = undefined; throw error; } valid(); };
      const available = () => !closed && !active && authorized();
      const authority = {
        available,
        nativeAdmission(record) {
          if (active) {
            save('native-admission', { id: active.id, ...record });
            if (record.admission_id) for (const c of active.payload.performance?.contributions || []) contributedHumans.add(c.segmentId);
          }
        },
        async reserveGeneration({ payload, digest }, abort) {
          valid(); guard(); abort?.throwIfAborted(); if (active) throw Error('attended busy');
          active = { payload, digest, id: randomUUID(), unit: pendingUnit }; usage.requests++;
          await save('submitted', { id: active.id, payloadDigest: digest, countedUnit: 'application-prompt-submission', underlyingModelRequests: null });
          return active.id;
        },
        async persistGeneration({ reservation, text, proof }, abort) {
          valid(); abort?.throwIfAborted(); if (!active || active.id !== reservation) throw Error('stale attended receipt');
          validateGroundedReceipt(active.payload, text, proof);
          await save('generation', { id: reservation, text, proof, payload: active.payload }); generated = text;
          active.text = text; if (sessionRef) { initial = false; correction = null; }
        },
        async reserveSynthesis({ reservation, text }, abort) {
          valid(); guard(); abort?.throwIfAborted(); if (!active || reservation !== active.id || text !== generated) throw Error('stale attended capability');
          generated = undefined; usage.synthesisRequests++; usage.characters += text.length;
          await save('synthesis-request', { id: reservation, characters: text.length });
        },
        event(type, unit, cause) {
          if (!active || active.unit?.id !== unit?.id || active.unit?.epoch !== unit?.epoch) return;
          const attempt = active;
          if (sessionRef && ['interrupted', 'error'].includes(type)) correction = 'Previous presentation output was not fully delivered to the audience. Do not assume it was heard.' + (attempt.text ? ' Unheard or partly heard draft: ' + attempt.text : ' Generation or submission may be incomplete; operator recovery required if uncertain.');
          if (['interrupted', 'error'].includes(type)) { active = undefined; generated = undefined; usage[type === 'error' ? 'errors' : 'interrupted']++; }
          if (type === 'delivered') {
            if (!attempt.eof || !attempt.streamEnd || unit.text !== attempt.text) throw Error('delivery before bound drain');
            save(type, { id: attempt.id }); usage.delivered++; if (active === attempt) active = undefined;
          } else save(type, { id: attempt.id, ...(cause ? { cause } : {}) });
        },
      };
      let pendingUnit;
      const operations = approvedOperations({ authority, speech: ATTENDED_SPEECH, sessionRef });
      const ready = readyStreamProvider({ ...options, operations });
      const getWarm = () => preparing ||= ready.prepare(signal).then(async c => { if (closed || terminal) { await c.close(); throw Error('stale attended preparation'); } warmConnection = c; return c; }).finally(() => { preparing = undefined; });
      const owner = {
        available: () => available() && !generating,
        event(type, unit, cause) {
          if (type === 'requested') { valid(); if (!owner.available()) throw Error('attended busy'); pendingUnit = unit; return; }
          if (type === 'stream-eof' && active?.unit?.id === unit?.id) active.eof = true;
          return operations.event(type, unit, cause);
        },
        async generate(payload, abort) {
          valid(); if (generating) throw Error('attended generation busy'); generating = true;
          const handover = sessionRef ? { grounding: payload.grounding, mode: payload.mode, question: payload.question, speech: payload.speech, initial, correction,
            ...(payload.performance ? { performance: { ...payload.performance, contributions: payload.performance.contributions.filter(c => !contributedHumans.has(c.segmentId)) } } : {}) } : payload;
          try { const warm = warmConnection || await getWarm(); return await warm.generate(handover, abort); }
          catch (error) {
            if (sessionRef && error.nativeFailure?.reason === 'cancelled') {
              const recovery = error.nativeRecovery;
              if (abort?.aborted && recovery?.session_id === sessionRef.split('/')[1] && recovery.interrupted_owned === true && recovery.idle === true) {
                save('native-stop-recovered', { nativeRecovery: recovery });
              } else error.nativeFailure = { version: 1, stage: 'generation', reason: 'submission-uncertain' };
            }
            if (sessionRef && error.nativeFailure?.reason === 'submission-uncertain') {
              // Persist known IDs privately, then hold this process for manual reconciliation.
              try { save('submission-uncertain', { nativeAdmission: error.nativeAdmission || null }); } finally { terminal = true; uncertain = true; }
            }
            try { operations.event('error', active?.unit); } catch { /* revoked before persistence */ } active = undefined; generated = undefined; await warmConnection?.close(); warmConnection = undefined; throw error; }
          finally { generating = false; }
        },
        close() {
          if (closing) return closing;
          try { operations.event('interrupted', active?.unit); } catch { /* owner revoked below */ } closed = true; active = undefined; generated = undefined;
          closing = (async () => { await warmConnection?.close(); await preparing?.catch(() => {}); if (connection === owner) connection = undefined; })(); return closing;
        },
      };
      connection = owner;
      try { await getWarm(); valid(); } catch (error) { await owner.close(); throw error; }
      owner.synthesize = async (text, abort) => {
        valid(); const attempt = active;
        const audio = await ready.synthesizeStream(text, abort);
        return { ...audio, chunks: (async function* () {
          let completed = false;
          try { for await (const bytes of audio.chunks) { valid(); abort?.throwIfAborted(); if (active !== attempt) throw Error('stale attended stream'); yield bytes; }
            valid(); if (active !== attempt) throw Error('stale attended stream'); attempt.streamEnd = true; attempt.text = text; await save('stream-end', { id: attempt.id }); completed = true;
          } catch (error) { try { operations.event('error', attempt?.unit); } catch { /* revoked before persistence */ } throw error; }
          finally { if (!completed) { try { operations.event('interrupted', attempt?.unit); } catch { /* revoked */ } } }
        })() };
      };
      return owner;
    },
    synthesizeStream: (text, signal) => { if (!connection) throw Error('no attended owner'); return connection.synthesize(text, signal); },
    close() { terminal = true; return connection?.close(); },
  };
}
/** Real production assembly, but unavailable unless separately configured finite authority exists. */
export function approvedDeckProvider({ authority, ...options } = {}) {
  return { ...readyStreamProvider({ ...options, operations: approvedOperations({ authority }) }), grounding: true,
    label: 'APPROVED PUBLIC DECK / PCM STREAM — SEPARATE FINITE AUTHORITY REQUIRED; REA AVAILABLE, NO ROLLBACK' };
}
