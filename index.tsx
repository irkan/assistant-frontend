/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

interface LiveServerMessage {
  serverContent?: {
    modelTurn?: {
      parts: {
        inlineData: {
          data: string;
        };
      }[];
    };
    interrupted?: boolean;
  };
}

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = 'Disconnected';
  @state() error = '';

  private socket!: WebSocket;
  private inputAudioContext: AudioContext;
  private outputAudioContext: AudioContext;

  @state() inputNode: GainNode;
  @state() outputNode: GainNode;
  
  private nextStartTime = 0;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private scriptProcessorNode: ScriptProcessorNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button[disabled] {
        display: none;
      }
    }
  `;

  constructor() {
    super();
    console.log('[GdmLiveAudio] Component constructed.');
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    this.inputAudioContext = new AudioContext({ sampleRate: 16000 });
    this.outputAudioContext = new AudioContext({ sampleRate: 24000 });
    this.inputNode = this.inputAudioContext.createGain();
    this.outputNode = this.outputAudioContext.createGain();
    this.initAudio();
  }

  private initAudio() {
    console.log('[GdmLiveAudio] Initializing audio contexts.');
    this.nextStartTime = this.outputAudioContext.currentTime;
    this.outputNode.connect(this.outputAudioContext.destination);
  }

  private connect() {
    console.log('[GdmLiveAudio] Attempting to connect to WebSocket at ws://localhost:3001');
    this.socket = new WebSocket('ws://46.62.135.5:3001');
    
    this.socket.onopen = () => {
      console.log('[GdmLiveAudio] WebSocket connection established.');
      this.updateStatus('Connected to server');
    };

    this.socket.onmessage = async (event) => {
      console.log('[GdmLiveAudio] Received message from server.');
      const message = JSON.parse(event.data);
      if (message.type === 'gemini') {
        console.log('[GdmLiveAudio] Received Gemini message:', message.data);
        const geminiMessage: LiveServerMessage = message.data;
        const audio =
          geminiMessage.serverContent?.modelTurn?.parts[0]?.inlineData;

        if (audio) {
          this.nextStartTime = Math.max(
            this.nextStartTime,
            this.outputAudioContext.currentTime,
          );

          const audioBuffer = await decodeAudioData(
            decode(audio.data),
            this.outputAudioContext,
            24000,
            1,
          );
          const source = this.outputAudioContext.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(this.outputNode);
          source.addEventListener('ended', () => {
            this.sources.delete(source);
          });

          source.start(this.nextStartTime);
          this.nextStartTime = this.nextStartTime + audioBuffer.duration;
          this.sources.add(source);
        }
        
        const interrupted = geminiMessage.serverContent?.interrupted;
        if (interrupted) {
          console.log('[GdmLiveAudio] Gemini stream interrupted.');
          for (const source of this.sources.values()) {
            source.stop();
            this.sources.delete(source);
          }
          this.nextStartTime = 0;
        }
      } else if (message.type === 'status') {
        console.log('[GdmLiveAudio] Received status message:', message.data);
        this.updateStatus(message.data);
      } else if (message.type === 'error') {
        console.error('[GdmLiveAudio] Received error message:', message.data);
        this.updateError(message.data);
      }
    };

    this.socket.onerror = (error) => {
      this.updateError('WebSocket Error');
      console.error('[GdmLiveAudio] WebSocket Error:', error);
    };

    this.socket.onclose = (event) => {
      console.log(`[GdmLiveAudio] WebSocket disconnected: ${event.reason} (Code: ${event.code})`);
      this.updateStatus(`Disconnected: ${event.reason}`);
      this.stopRecording();
    };
  }

  private disconnect() {
    if (this.socket) {
      console.log('[GdmLiveAudio] Disconnecting WebSocket.');
      this.socket.close();
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }
    console.log('[GdmLiveAudio] Starting recording process...');
    this.connect();

    this.inputAudioContext.resume();

    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.updateStatus('Microphone access granted. Starting capture...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 256;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);
        console.log('[GdmLiveAudio] Received PCM chunk from microphone.'+ pcmData.length, "this.socket.readyState: ", this.socket.readyState);
        if (this.socket.readyState === WebSocket.OPEN) {
            // convert float32 to int16
            const l = pcmData.length;
            const int16 = new Int16Array(l);
            for (let i = 0; i < l; i++) {
              int16[i] = pcmData[i] * 32768;
            }
            console.log('[GdmLiveAudio] Sending PCM chunk to server. '+ int16.length);
            this.socket.send(int16.buffer);
        }
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.updateStatus('🔴 Recording... Capturing PCM chunks.');
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error('Error starting recording:', err);
        this.updateStatus(`Error: ${err.message}`);
      } else {
        console.error('An unknown error occurred:', err);
        this.updateStatus('An unknown error occurred during recording setup.');
      }
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream) {
        return;
    }

    console.log('[GdmLiveAudio] Stopping recording process...');
    this.updateStatus('Stopping recording...');
    this.isRecording = false;

    if (this.scriptProcessorNode) {
        this.scriptProcessorNode.disconnect();
        this.scriptProcessorNode = null;
    }

    if (this.sourceNode) {
        this.sourceNode.disconnect();
        this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    
    this.disconnect();
    this.updateStatus('Recording stopped. Click Start to begin again.');
  }

  private reset() {
    console.log('[GdmLiveAudio] Resetting session.');
    // Re-establish connection for a new session
    this.disconnect();
    this.connect();
    this.updateStatus('Session cleared.');
  }

  render() {
    return html`
      <div>
        <div class="controls">
          <button
            id="resetButton"
            @click=${this.reset}
            ?disabled=${this.isRecording}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="#ffffff">
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
            </svg>
          </button>
          <button
            id="startButton"
            @click=${this.startRecording}
            ?disabled=${this.isRecording}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#c80000"
              xmlns="http://www.w3.org/2000/svg">
              <circle cx="50" cy="50" r="50" />
            </svg>
          </button>
          <button
            id="stopButton"
            @click=${this.stopRecording}
            ?disabled=${!this.isRecording}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#000000"
              xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="0" width="100" height="100" rx="15" />
            </svg>
          </button>
        </div>

        <div id="status"> ${this.error} </div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}
