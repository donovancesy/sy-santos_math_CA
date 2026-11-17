// Audio worklet: mixes the captured tab audio to mono and hands it to the
// side panel in 4096-sample chunks for tempo, key and meter analysis.
class SipraTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 4096;
    this.buffer = new Float32Array(this.size);
    this.index = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const left = input[0];
      const right = input[1] || input[0];
      for (let i = 0; i < left.length; i += 1) {
        this.buffer[this.index++] = (left[i] + right[i]) * 0.5;
        if (this.index === this.size) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(this.size);
          this.index = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("sipra-tap", SipraTap);
