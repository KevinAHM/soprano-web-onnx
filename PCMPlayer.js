import { EventEmitter, CustomEvent } from './EventEmitter.js';

export class PCMPlayer extends EventEmitter {
  constructor(audioContext) {
    super();
    this.audioContext = audioContext;
    this.playbackTime = 0;
    this.gainNode = this.audioContext.createGain();
    this.gainNode.connect(this.audioContext.destination);
    this.analyser = this.audioContext.createAnalyser();
    this.gainNode.connect(this.analyser);
    
    // Default settings
    this.fadeInDuration = 0.01; // 10ms fade in to avoid clicks
    this.fadeOutDuration = 0.01; // 10ms fade out
  }

  playAudio(data) {
    if (this.audioContext.state !== 'running') {
      console.warn(`Audio context is in ${this.audioContext.state} state`);
      return;
    }

    const float32Array = data instanceof Int16Array 
      ? this.pcm16ToFloat32(data) 
      : data;
    
    const audioBuffer = this.audioContext.createBuffer(
      1, // mono
      float32Array.length,
      this.audioContext.sampleRate
    );

    audioBuffer.copyToChannel(float32Array, 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;

    // Create a gain node for this source to handle fading
    const sourceGain = this.audioContext.createGain();
    source.connect(sourceGain);
    sourceGain.connect(this.gainNode);

    const currentTime = this.audioContext.currentTime;
    if (this.playbackTime < currentTime) {
      this.playbackTime = currentTime;
    }

    // Apply fade in
    sourceGain.gain.setValueAtTime(0, this.playbackTime);
    sourceGain.gain.linearRampToValueAtTime(1, this.playbackTime + this.fadeInDuration);

    // Apply fade out
    const duration = audioBuffer.duration;
    const fadeOutTime = this.playbackTime + duration - this.fadeOutDuration;
    sourceGain.gain.setValueAtTime(1, fadeOutTime);
    sourceGain.gain.linearRampToValueAtTime(0, this.playbackTime + duration);

    source.start(this.playbackTime);
    this.playbackTime += audioBuffer.duration;

    // Emit audio started event
    this.emit('audioStarted', {
      startTime: this.playbackTime,
      duration: audioBuffer.duration,
      samples: float32Array.length
    });

    // Clean up after playback
    source.onended = () => {
      source.disconnect();
      sourceGain.disconnect();
      this.emit('audioEnded', {
        endTime: this.playbackTime
      });
    };
  }

  pcm16ToFloat32(pcm16) {
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768; // Convert PCM16 to Float32 (-1 to 1 range)
    }
    return float32;
  }

  get volume() {
    return this.gainNode.gain.value;
  }

  set volume(value) {
    // Clamp between 0 and 1
    const clampedValue = Math.max(0, Math.min(1, value));
    this.gainNode.gain.value = clampedValue;
    this.emit('volumeChange', { volume: clampedValue });
  }

  get volumePercentage() {
    return this.volume * 100;
  }

  set volumePercentage(percentage) {
    this.volume = percentage / 100;
  }

  getAnalyserData() {
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteFrequencyData(dataArray);
    return dataArray;
  }

  getTimeDomainData() {
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteTimeDomainData(dataArray);
    return dataArray;
  }

  reset() {
    this.playbackTime = 0;
    // Stop all currently playing sources
    this.stopAllSources();
  }
  
  stopAllSources() {
    // Cancel all scheduled audio
    if (this.audioContext) {
      // Create a new gain node to effectively "disconnect" all audio
      const oldGainNode = this.gainNode;
      this.gainNode = this.audioContext.createGain();
      this.gainNode.connect(this.audioContext.destination);
      this.analyser = this.audioContext.createAnalyser();
      this.gainNode.connect(this.analyser);
      
      // Fade out old audio quickly
      if (oldGainNode) {
        const now = this.audioContext.currentTime;
        oldGainNode.gain.setValueAtTime(oldGainNode.gain.value, now);
        oldGainNode.gain.linearRampToValueAtTime(0, now + 0.05);
        setTimeout(() => {
          oldGainNode.disconnect();
        }, 100);
      }
    }
  }

  async resume() {
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  getPlaybackStatus() {
    return {
      currentTime: this.audioContext.currentTime,
      scheduledTime: this.playbackTime,
      bufferedDuration: Math.max(0, this.playbackTime - this.audioContext.currentTime),
      state: this.audioContext.state
    };
  }
}