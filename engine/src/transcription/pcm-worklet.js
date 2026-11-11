/** Worklet output is silence: never monitor the microphone through the speakers. */
class TranscriptionPcm extends AudioWorkletProcessor {
  constructor() {
    super(); this.drained = false;
    this.port.onmessage = event => {
      if (event.data?.drain) { this.drained = true; this.port.postMessage({ drained: true }); }
    };
  }
  process(inputs) {
    if (this.drained) return false;
    const channels = inputs[0];
    if (channels?.length && channels[0].length) {
      const mono = new Float32Array(channels[0].length);
      for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor('transcription-pcm', TranscriptionPcm);
