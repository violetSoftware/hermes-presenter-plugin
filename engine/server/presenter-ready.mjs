import { validNativeProof } from './legacy-disabled.mjs';
import { warmNative } from './presenter-warm.mjs';
import { elevenSpeech } from './presenter-providers.mjs';
import { elevenStream } from './presenter-stream.mjs';
import { validateGroundedPayload, canonical, hash } from './presenter-grounding.mjs';
import { validateExistingPayload, validExistingProof } from './presenter-existing-contract.mjs';

/** Stream reuses the accepted warm/capability assembly; batch stays supported. */
export function readyStreamProvider({ credentials, synthesize = credentials ? elevenStream(credentials) : undefined, ...options } = {}) {
  const provider = readyProvider({ ...options, synthesize });
  return { prepare: provider.prepare, available: provider.available, event: provider.event, synthesizeStream: provider.synthesize,
    label: 'READY TRANSPORT / PCM STREAM — EXPLICIT OPERATION CONTRACT REQUIRED; REA AVAILABLE, NO ROLLBACK' };
}

/** Production assembly. No default spend authority; old finite scopes stay batch/replay. */
export function readyProvider({ warmFactory = warmNative, credentials, operations,
  sessionRef, synthesize = credentials ? elevenSpeech(credentials) : undefined } = {}) {
  let owner, generated;
  return {
    label: 'READY TRANSPORT / BATCH AUDIO — EXPLICIT OPERATION CONTRACT REQUIRED; REA AVAILABLE, NO ROLLBACK',
    event: (type, unit) => operations?.event?.(type, unit),
    available: operations?.available,
    async prepare(signal) {
      if (operations?.available && !operations.available()) return { generate: async () => { throw Error('rehearsal exhausted or paused'); }, close: async () => {} };
      if (owner) throw Error('one presenter connection only');
      const warm = warmFactory({ onAdmission: operations?.nativeAdmission }); owner = warm;
      const abort = () => { void warm.close(); };
      signal?.addEventListener('abort', abort, { once: true });
      try { signal?.throwIfAborted(); await warm.ready(); signal?.throwIfAborted(); }
      catch (error) { await warm.close(); owner = undefined; throw error; }
      finally { signal?.removeEventListener('abort', abort); }
      return {
        async generate(payload, signal) {
          generated = undefined;
          if (owner !== warm || !operations?.generate) throw Error('explicit operation contract required');
          const input = structuredClone(payload);
          const nativeDigest = input.grounding ? hash(canonical(input)) : null;
          if (input.grounding) (sessionRef ? validateExistingPayload : validateGroundedPayload)(input);
          // Admission surrounds actual invocation, preserving whatever reviewed contract owns usage.
          generated = undefined; let invoked = false, validated;
          const admitted = await operations.generate(input, async () => {
            if (invoked) throw Error('duplicate native invocation'); invoked = true;
            if (nativeDigest && hash(canonical(input)) !== nativeDigest) throw Error('native payload binding changed');
            const result = await warm.generate(input, signal);
            if (typeof result?.text !== 'string' || !(sessionRef ? validExistingProof(result.proof, sessionRef) : validNativeProof(result.proof))) throw Error('invalid native answer');
            if (nativeDigest && result.proof.grounding_digest !== nativeDigest) throw Error('native grounding binding mismatch');
            validated = result.text;
            return operations.requiresNativeResult ? result : validated;
          }, signal);
          if (!invoked || admitted !== validated) throw Error('operation result mismatch');
          const text = validated;
          signal?.throwIfAborted();
          if (owner !== warm) throw Error('stale generation');
          generated = { text, warm, signal };
          return text;
        },
        async close() { await warm.close(); if (owner === warm) owner = undefined; },
      };
    },
    async synthesize(text, signal) {
      if (!owner || !operations?.synthesize || !synthesize) throw Error('explicit operation contract required');
      const capability = generated; generated = undefined;
      if (!capability || capability.warm !== owner || text !== capability.text) throw Error('no unused generation capability');
      capability.signal?.throwIfAborted(); signal?.throwIfAborted();
      let invoked = false;
      return operations.synthesize(text, () => {
        if (invoked) throw Error('duplicate synthesis invocation'); invoked = true;
        return synthesize(text, signal);
      }, signal);
    },
  };
}
