import { EventEmitter, CustomEvent } from './EventEmitter.js';

/**
 * PCMPlayerWorklet - Drop-in replacement for PCMPlayer using AudioWorklet
 * Uses dynamic buffer management with backpressure for smooth playback
 */
export class PCMPlayerWorklet extends EventEmitter {
  constructor(audioContext, options = {}) {
    super();
    this.audioContext = audioContext;
    this.options = options;
    this.workletNode = null;
    this.isInitialized = false;
    this.playbackTime = 0; // For API compatibility

    // Audio nodes
    this.gainNode = this.audioContext.createGain();
    this.gainNode.connect(this.audioContext.destination);
    this.analyser = this.audioContext.createAnalyser();
    this.gainNode.connect(this.analyser);

    // Queue for chunks waiting to be sent
    this.pendingChunks = [];
    this.availableCapacity = 0;
    this.isWorkletReady = false;
    this.hasReceivedInitialCapacity = false;

    // Metrics
    this.metrics = {
      chunksPlayed: 0,
      underruns: 0,
      bufferLevel: 0,
      samplesPlayed: 0
    };

    // Initialize worklet
    this.initPromise = this.initialize();
  }

  async initialize() {
    if (this.isInitialized) return;

    try {
      // Calculate buffer parameters
      const sampleRate = this.audioContext.sampleRate;
      const minBufferMs = this.options.minBufferBeforePlaybackMs || 300;
      const minBufferSamples = Math.floor(minBufferMs * sampleRate / 1000);

      // Buffer size: enough for smooth playback but not excessive
      // Target 60 seconds of buffer to prevent any overflow issues
      const bufferSizeSamples = sampleRate * 60;

      // Create the worklet processor code
      const processorCode = `
        class PCMProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            
            // Ring buffer - sized appropriately
            this.bufferSize = ${bufferSizeSamples};
            this.ringBuffer = new Float32Array(this.bufferSize);
            this.readPos = 0;
            this.writePos = 0;
            this.isPlaying = false;
            
            // Configuration
            this.minBufferSamples = ${minBufferSamples};
            this.targetBufferSamples = ${minBufferSamples * 2}; // Target 2x min for stability
            
            // State
            this.streamEnded = false;
            this.playbackCompleteReported = false;
            
            // Stats reporting
            this.frameCount = 0;
            this.reportInterval = 256; // Report every ~5ms at 48kHz
            
            this.port.onmessage = (e) => {
              switch(e.data.type) {
                case 'audio':
                  this.addAudio(e.data.data);
                  break;
                case 'reset':
                  this.reset();
                  break;
                case 'stream-ended':
                  this.streamEnded = true;
                  break;
              }
            };
            
            // Send initial capacity
            this.sendCapacityUpdate();
          }
          
          addAudio(float32Data) {
            const samples = float32Data.length;
            const available = this.getAvailableSpace();
            const bufferedBefore = this.getBufferedSamples();
            
            
            if (samples > available) {
              // This shouldn't happen with proper backpressure
              console.error('Buffer overflow - bug in backpressure. Samples:', samples, 'Available:', available, 'Buffered:', this.getBufferedSamples());
              // Drop oldest data to recover
              const overflow = samples - available;
              this.readPos = (this.readPos + overflow) % this.bufferSize;
            }
            
            // Write to ring buffer
            if (this.writePos + samples <= this.bufferSize) {
              this.ringBuffer.set(float32Data, this.writePos);
              this.writePos += samples;
              if (this.writePos >= this.bufferSize) {
                this.writePos = 0;
              }
            } else {
              const firstPart = this.bufferSize - this.writePos;
              const secondPart = samples - firstPart;
              this.ringBuffer.set(float32Data.slice(0, firstPart), this.writePos);
              this.ringBuffer.set(float32Data.slice(firstPart), 0);
              this.writePos = secondPart;
            }
            
            // Auto-start when we have enough buffered
            const buffered = this.getBufferedSamples();
            
            if (!this.isPlaying && buffered >= this.minBufferSamples) {
              const now = currentTime;
              this.isPlaying = true;
              // Notify that playback has started
              this.port.postMessage({
                type: 'playback-started',
                buffered: buffered,
                audioTime: now
              });
            }
            
            // Report capacity after adding
            this.sendCapacityUpdate();
          }
          
          getAvailableSpace() {
            const used = this.getBufferedSamples();
            return this.bufferSize - used - 128; // Leave small safety margin
          }
          
          getBufferedSamples() {
            if (this.writePos >= this.readPos) {
              return this.writePos - this.readPos;
            } else {
              return this.bufferSize - this.readPos + this.writePos;
            }
          }
          
          sendCapacityUpdate() {
            const buffered = this.getBufferedSamples();
            const capacity = this.getAvailableSpace();
            
            // Calculate how much we want to receive
            // If buffer is low, request more; if it's full, request nothing
            let requestSamples = 0;
            if (buffered < this.targetBufferSamples) {
              requestSamples = Math.min(capacity, this.targetBufferSamples - buffered);
            }
            
            this.port.postMessage({
              type: 'capacity',
              buffered: buffered,
              capacity: capacity,
              requestSamples: requestSamples,
              isPlaying: this.isPlaying
            });
          }
          
          process(inputs, outputs, parameters) {
            const output = outputs[0];
            if (!output || !output[0]) return true;
            
            const outputChannel = output[0];
            const numSamples = outputChannel.length;
            
            // Report stats periodically
            if (++this.frameCount % this.reportInterval === 0) {
              this.sendCapacityUpdate();
            }
            
            if (!this.isPlaying) {
              outputChannel.fill(0);
              return true;
            }
            
            const buffered = this.getBufferedSamples();
            
            if (buffered < numSamples) {
              // Underrun - play what we have and fill rest with silence
              let samplesRead = 0;
              
              if (buffered > 0) {
                // Play whatever samples we DO have
                if (this.readPos + buffered <= this.bufferSize) {
                  for (let i = 0; i < buffered; i++) {
                    outputChannel[i] = this.ringBuffer[this.readPos + i];
                  }
                  this.readPos += buffered;
                  if (this.readPos >= this.bufferSize) {
                    this.readPos = 0;
                  }
                } else {
                  // Wrap-around case
                  const firstPart = this.bufferSize - this.readPos;
                  const secondPart = buffered - firstPart;
                  
                  for (let i = 0; i < firstPart; i++) {
                    outputChannel[i] = this.ringBuffer[this.readPos + i];
                  }
                  for (let i = 0; i < secondPart; i++) {
                    outputChannel[firstPart + i] = this.ringBuffer[i];
                  }
                  
                  this.readPos = secondPart;
                }
                samplesRead = buffered;
              }
              
              // Fill remaining with silence
              for (let i = samplesRead; i < numSamples; i++) {
                outputChannel[i] = 0;
              }
              
              // Check for playback complete
              if (this.streamEnded && buffered === 0) {
                if (!this.playbackCompleteReported) {
                  this.port.postMessage({
                    type: 'playback-complete'
                  });
                  this.playbackCompleteReported = true;
                }
                this.isPlaying = false;
                this.streamEnded = false;
              } else {
                // Request more data urgently
                this.port.postMessage({
                  type: 'underrun',
                  buffered: buffered,
                  needed: numSamples
                });
                this.sendCapacityUpdate();
              }
            } else {
              // Normal playback - read from ring buffer
              if (this.readPos + numSamples <= this.bufferSize) {
                for (let i = 0; i < numSamples; i++) {
                  outputChannel[i] = this.ringBuffer[this.readPos + i];
                }
                this.readPos += numSamples;
                if (this.readPos >= this.bufferSize) {
                  this.readPos = 0;
                }
              } else {
                // Wrap-around case
                const firstPart = this.bufferSize - this.readPos;
                const secondPart = numSamples - firstPart;
                
                for (let i = 0; i < firstPart; i++) {
                  outputChannel[i] = this.ringBuffer[this.readPos + i];
                }
                for (let i = 0; i < secondPart; i++) {
                  outputChannel[firstPart + i] = this.ringBuffer[i];
                }
                
                this.readPos = secondPart;
              }
            }
            
            return true;
          }
          
          reset() {
            this.readPos = 0;
            this.writePos = 0;
            this.ringBuffer.fill(0);
            this.isPlaying = false;
            this.streamEnded = false;
            this.playbackCompleteReported = false;
            this.sendCapacityUpdate();
          }
        }
        
        registerProcessor('pcm-processor', PCMProcessor);
      `;

      // Create and load worklet
      const blob = new Blob([processorCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);

      await this.audioContext.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      // Create worklet node
      this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor');
      this.workletNode.connect(this.gainNode);

      // Handle messages from worklet
      this.workletNode.port.onmessage = (e) => {
        switch (e.data.type) {
          case 'capacity':
            this.handleCapacityUpdate(e.data);
            break;

          case 'underrun':
            this.metrics.underruns++;
            console.warn(`[MAIN THREAD] ⚠️ UNDERRUN #${this.metrics.underruns} detected! buffered=${e.data.buffered} samples, needed=${e.data.needed} samples`);
            // Try to send more data immediately
            this.processPendingChunks();
            break;

          case 'playback-started':
            console.log(`[MAIN THREAD] Received playback-started at performance.now=${performance.now().toFixed(2)}ms, audioContext.currentTime=${this.audioContext.currentTime.toFixed(3)}s, worklet reported audioTime=${e.data.audioTime}s`);
            this.emit('firstPlayback', {
              startTime: this.audioContext.currentTime,
              bufferedSamples: e.data.buffered
            });
            break;

          case 'playback-complete':
            this.emit('audioEnded', {
              endTime: this.audioContext.currentTime
            });
            break;
        }
      };

      this.isInitialized = true;
      this.isWorkletReady = true;
    } catch (error) {
      console.error('Failed to initialize PCMPlayerWorklet:', error);
      throw error;
    }
  }

  handleCapacityUpdate(data) {
    this.availableCapacity = data.capacity;
    this.metrics.bufferLevel = data.buffered;

    // console.log(`[CAPACITY] Update at ${performance.now().toFixed(2)}ms: capacity=${data.capacity}, buffered=${data.buffered}, pending=${this.pendingChunks.length}`);

    // Mark that we've received initial capacity
    if (!this.hasReceivedInitialCapacity) {
      this.hasReceivedInitialCapacity = true;
      // console.log(`[CAPACITY] *** FIRST capacity received at ${performance.now().toFixed(2)}ms, processing ${this.pendingChunks.length} pending chunks`);
      // Process any chunks that were waiting for initial capacity
      if (this.pendingChunks.length > 0) {
        this.processPendingChunks();
      }
    }

    // If worklet is requesting data, try to send it
    if (data.requestSamples > 0 && this.pendingChunks.length > 0) {
      this.processPendingChunks();
    }
  }

  processPendingChunks() {
    if (!this.isWorkletReady || this.pendingChunks.length === 0) {
      return;
    }

    // Don't send if we don't know capacity yet
    if (this.availableCapacity <= 0) {
      return;
    }

    // Send ONE chunk if it fits, then wait for next capacity update
    // This prevents race conditions from sending multiple chunks before worklet updates
    const chunk = this.pendingChunks[0];

    if (chunk.length <= this.availableCapacity) {
      // Send the whole chunk
      this.pendingChunks.shift();
      this.workletNode.port.postMessage({
        type: 'audio',
        data: chunk
      });
      // Set capacity to 0 to prevent sending more until we get an update
      this.availableCapacity = 0;
    } else if (this.availableCapacity > 4096) {
      // Send partial chunk only if we have significant space
      const partial = chunk.slice(0, this.availableCapacity);
      console.log(`Sending partial: ${partial.length} samples from ${chunk.length} (capacity: ${this.availableCapacity})`);
      this.pendingChunks[0] = chunk.slice(this.availableCapacity);
      this.workletNode.port.postMessage({
        type: 'audio',
        data: partial
      });
      // Set capacity to 0 to prevent sending more until we get an update
      this.availableCapacity = 0;
    } else {
      console.log(`Not sending - chunk ${chunk.length} samples, capacity ${this.availableCapacity}`);
    }
    // else: Not enough space, wait for next capacity update

    // If all chunks sent and stream ended, notify worklet
    if (this.pendingChunks.length === 0 && this.pendingStreamEnd) {
      this.workletNode.port.postMessage({ type: 'stream-ended' });
      this.pendingStreamEnd = false;
    }
  }

  playAudio(data) {
    if (!this.isInitialized) {
      // Queue the data if not initialized yet
      if (!this.initPendingQueue) {
        this.initPendingQueue = [];
        this.initPromise.then(() => {
          // Process queued data
          const queue = this.initPendingQueue;
          this.initPendingQueue = null;
          for (const queuedData of queue) {
            this.playAudio(queuedData);
          }
        });
      }
      this.initPendingQueue.push(data);
      return;
    }

    if (this.audioContext.state !== 'running') {
      return;
    }

    // Convert to Float32Array if needed
    const float32Array = data instanceof Int16Array
      ? this.pcm16ToFloat32(data)
      : data;

    // Add to pending queue
    this.pendingChunks.push(float32Array);

    // Only try to process if we've received initial capacity and have space
    // Otherwise wait for capacity update from worklet
    if (this.hasReceivedInitialCapacity && this.availableCapacity > 0) {
      this.processPendingChunks();
    }

    // Update metrics
    this.metrics.chunksPlayed++;

    // Update playback time for compatibility
    const duration = float32Array.length / this.audioContext.sampleRate;
    this.playbackTime = this.audioContext.currentTime + duration;

    // Emit events for compatibility
    this.emit('audioStarted', {
      startTime: this.audioContext.currentTime,
      duration: duration,
      samples: float32Array.length
    });
  }

  notifyStreamEnded() {
    if (this.pendingChunks.length > 0) {
      // Still have chunks to send, mark for later
      this.pendingStreamEnd = true;
    } else {
      // No chunks left, send immediately
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'stream-ended' });
      }
    }
  }

  pcm16ToFloat32(pcm16) {
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768;
    }
    return float32;
  }

  reset() {
    this.playbackTime = 0;
    this.pendingChunks = [];
    this.pendingStreamEnd = false;
    this.availableCapacity = 0;

    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'reset' });
    }

    // Quick fade out to avoid clicks
    if (this.gainNode) {
      const now = this.audioContext.currentTime;
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
      this.gainNode.gain.linearRampToValueAtTime(0, now + 0.05);
      setTimeout(() => {
        this.gainNode.gain.value = 1;
      }, 100);
    }
  }

  stopAllSources() {
    this.reset();
  }

  async resume() {
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  get volume() {
    return this.gainNode.gain.value;
  }

  set volume(value) {
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

  getPlaybackStatus() {
    const bufferMs = this.metrics.bufferLevel
      ? (this.metrics.bufferLevel / this.audioContext.sampleRate) * 1000
      : 0;

    return {
      currentTime: this.audioContext.currentTime,
      scheduledTime: this.playbackTime,
      bufferedDuration: bufferMs / 1000,
      state: this.audioContext.state,
      worklet: {
        bufferLevelSamples: this.metrics.bufferLevel,
        bufferLevelMs: bufferMs,
        underruns: this.metrics.underruns,
        chunksPlayed: this.metrics.chunksPlayed,
        pendingChunks: this.pendingChunks.length
      }
    };
  }
}