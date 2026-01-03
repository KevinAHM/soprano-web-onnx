import { PCMPlayer } from './PCMPlayer.js';
import { PCMPlayerWorklet } from './PCMPlayerWorklet.js';
import { TTSStreamingClient } from './TTSStreamingClient.js';
import { JitterBuffer } from './JitterBuffer.js';
import { EventEmitter } from './EventEmitter.js';

export class TTSPCMPlayer {
  constructor(options = {}) {
    // Configuration with defaults
    this.config = {
      endpoint: options.endpoint || 'http://localhost:8000/v1',
      sampleRate: options.sampleRate || 24000,
      audioBufferingMs: options.audioBufferingMs || 50,
      minBufferBeforePlaybackMs: options.minBufferBeforePlaybackMs || 100,
      autoPlay: options.autoPlay !== false,
      volume: options.volume || 1.0,
      voice: options.voice || 'broom_salesman',
      model: options.model || 'echo-tts',
      temperature: options.temperature || 1.0,
      topP: options.topP || 0.95,
      topK: options.topK || 50,
      chatId: options.chatId || null,
      useWorklet: options.useWorklet !== false, // Default to true for better performance
      ...options
    };

    // Initialize audio context with specified sample rate
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: this.config.sampleRate
    });

    // Initialize components - use worklet player by default for better performance
    if (this.config.useWorklet) {
      this.player = new PCMPlayerWorklet(this.audioContext, {
        minBufferBeforePlaybackMs: this.config.minBufferBeforePlaybackMs
      });
    } else {
      this.player = new PCMPlayer(this.audioContext);
    }
    this.client = new TTSStreamingClient({
      endpoint: this.config.endpoint,
      sampleRate: this.config.sampleRate,
      audioBufferingMs: this.config.audioBufferingMs,
      minBufferBeforePlaybackMs: this.config.minBufferBeforePlaybackMs,
      voice: this.config.voice,
      model: this.config.model,
      temperature: this.config.temperature,
      topP: this.config.topP,
      topK: this.config.topK
    });

    // Set initial volume
    this.player.volume = this.config.volume;

    // Setup event forwarding
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    // Forward audio data from client to player
    this.client.addEventListener('audio', (event) => {
      if (this.config.autoPlay && this.audioContext.state === 'running') {
        this.player.playAudio(event.detail.data);
      }
    });

    // Forward all client events
    ['synthesisStarted', 'synthesisCompleted', 'synthesisCancelled', 'error', 'progress', 'firstByte', 'firstAudioChunk'].forEach(eventName => {
      this.client.addEventListener(eventName, (event) => {
        // Re-emit the event from this instance
        if (this.onEvent) {
          this.onEvent(eventName, event.detail);
        }

        // When synthesis is complete, notify the player that the stream has ended
        if (eventName === 'synthesisCompleted' && this.config.useWorklet && this.player.notifyStreamEnded) {
          this.player.notifyStreamEnded();
        }
      });
    });

    // Forward player events
    ['volumeChange', 'audioStarted', 'audioEnded', 'firstPlayback'].forEach(eventName => {
      this.player.addEventListener(eventName, (event) => {
        if (this.onEvent) {
          this.onEvent(eventName, event.detail);
        }
      });
    });
  }

  async synthesize(text, userVoice = null, userPrompt = null, userVoiceFormat = null, chatId = null, extraBody = null) {
    // Resume audio context if suspended
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    // Cancel any ongoing synthesis before starting a new one
    // This ensures immediate interrupt behavior
    if (this.client.isStreaming) {
      console.log('[TTSPCMPlayer] Auto-cancelling ongoing synthesis before starting new one');
      this.cancel();
    }

    // Use provided chatId or fallback to config chatId
    const effectiveChatId = chatId || this.config.chatId;

    return this.client.synthesize(text, userVoice, userPrompt, userVoiceFormat, effectiveChatId, extraBody);
  }

  setChatId(chatId) {
    this.config.chatId = chatId;
    if (this.client) {
      this.client.setChatId(chatId);
    }
  }

  cancel() {
    // Cancel the HTTP request
    this.client.cancel();
    // Stop audio playback immediately
    this.player.reset();
  }

  async play() {
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    this.config.autoPlay = true;
  }

  pause() {
    this.config.autoPlay = false;
  }

  setVoice(voice) {
    this.client.setVoice(voice);
    this.config.voice = voice;
  }

  setEndpoint(endpoint) {
    const result = this.client.setEndpoint(endpoint);
    if (result) {
      this.config.endpoint = endpoint;
    }
    return result;
  }

  updateConfig(config) {
    this.client.updateConfig(config);
    Object.assign(this.config, config);
  }

  get volume() {
    return this.player.volume;
  }

  set volume(value) {
    this.player.volume = value;
  }

  get volumePercentage() {
    return this.player.volumePercentage;
  }

  set volumePercentage(value) {
    this.player.volumePercentage = value;
  }

  getStatus() {
    return {
      client: this.client.getStatus(),
      player: this.player.getPlaybackStatus(),
      audioContext: {
        state: this.audioContext.state,
        sampleRate: this.audioContext.sampleRate,
        currentTime: this.audioContext.currentTime
      }
    };
  }

  getAnalyserData() {
    return this.player.getAnalyserData();
  }

  getTimeDomainData() {
    return this.player.getTimeDomainData();
  }

  // Event handler callback (to be overridden by user)
  onEvent(eventName, data) {
    // Default implementation - can be overridden
    console.log(`[TTSPCMPlayer] ${eventName}:`, data);
  }
}

// Export all components for advanced usage
export { PCMPlayer, PCMPlayerWorklet, TTSStreamingClient, JitterBuffer, EventEmitter };

// Create a simple factory function for easy instantiation
export function createTTSPlayer(options) {
  return new TTSPCMPlayer(options);
}