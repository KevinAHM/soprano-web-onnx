import { EventEmitter, CustomEvent } from './EventEmitter.js';

export class JitterBuffer extends EventEmitter {
  constructor(maxByteLength, sampleRate = 24000, minBufferBeforePlayback = 0) {
    super();
    this.maxByteLength = maxByteLength;
    this.sampleRate = sampleRate;
    this.minBufferBeforePlayback = minBufferBeforePlayback;
    this.buffer = [];
    this.bytesPerSample = 2; // PCM16 = 2 bytes per sample
    this.hasStartedPlayback = false;
  }

  get byteLength() {
    return this.buffer.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  }

  get durationMs() {
    const totalSamples = this.byteLength / this.bytesPerSample;
    return (totalSamples / this.sampleRate) * 1000;
  }

  enqueue(data) {
    if (!(data instanceof Int16Array)) {
      throw new Error('JitterBuffer expects Int16Array data');
    }
    
    this.buffer.push(data);
    
    const currentByteLength = this.byteLength;
    
    // Check if we should start playback
    if (!this.hasStartedPlayback && currentByteLength >= this.minBufferBeforePlayback) {
      this.hasStartedPlayback = true;
      this.flush();
    } 
    // If we've started playback, flush when buffer is full
    else if (this.hasStartedPlayback && currentByteLength >= this.maxByteLength) {
      this.flush();
    }
  }

  flush() {
    if (this.buffer.length === 0) return;
    
    
    const event = new CustomEvent('flush', { detail: this.buffer });
    this.dispatchEvent(event);
    this.buffer = [];
  }

  clear() {
    this.buffer = [];
    this.hasStartedPlayback = false;
  }
  
  forceFlush() {
    // Force flush remaining buffer when stream ends
    if (this.buffer.length > 0) {
      console.log(`Force flushing ${this.byteLength} bytes at stream end`);
      this.flush();
    }
  }

  getBufferStatus() {
    return {
      chunks: this.buffer.length,
      byteLength: this.byteLength,
      durationMs: this.durationMs,
      fillPercentage: (this.byteLength / this.maxByteLength) * 100
    };
  }
}