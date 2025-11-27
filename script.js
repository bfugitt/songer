// --- SYSTEM 6: MIDI + AUDIO ENGINE ---

// State
let midiOutput = null;
let isPlaying = false;
let currentStep = 0; 
let nextNoteTime = 0.0;
let timerID = null;
let lookahead = 25.0; 
let scheduleAheadTime = 0.1; 
let audioContext = null;

// Musical Data
let currentChordIndex = 0;
let chordProgression = [];
const STEPS_PER_BAR = 16;

// DOM Elements
const bpmInput = document.getElementById('bpm-input');
const chordInput = document.getElementById('chord-input');
const statusDiv = document.getElementById('status-bar');
const lcdChord = document.getElementById('current-chord-display');
const beatLed = document.getElementById('beat-led');

// --- 1. INITIALIZATION ---

async function init() {
    // Initialize Web Audio Context (must happen after user interaction usually, handled in Play button)
    audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Initialize MIDI
    if (navigator.requestMIDIAccess) {
        try {
            const access = await navigator.requestMIDIAccess();
            const outputs = Array.from(access.outputs.values());
            if(outputs.length > 0) {
                midiOutput = outputs.find(o => o.name.includes("EP-133")) || outputs[0];
                statusDiv.innerText = `MIDI Connected: ${midiOutput.name}`;
                statusDiv.className = 'status-connected';
            } else {
                statusDiv.innerText = "No MIDI Devices Found";
            }
        } catch (err) {
            console.log("MIDI Access Refused");
        }
    }
}

// --- 2. INTERNAL SYNTH ENGINE (Web Audio API) ---

function playInternalKick(time) {
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    
    osc.connect(gain);
    gain.connect(audioContext.destination);

    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(0.01, time + 0.5);

    gain.gain.setValueAtTime(1, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + 0.5);

    osc.start(time);
    osc.stop(time + 0.5);
}

function playInternalSnare(time) {
    // White Noise Buffer
    const bufferSize = audioContext.sampleRate * 0.5; // 0.5 sec
    const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
    }

    const noise = audioContext.createBufferSource();
    noise.buffer = buffer;
    
    const noiseFilter = audioContext.createBiquadFilter();
    noiseFilter.type = 'highpass';
    noiseFilter.frequency.value = 1000;

    const noiseEnvelope = audioContext.createGain();
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseEnvelope);
    noiseEnvelope.connect(audioContext.destination);

    noiseEnvelope.gain.setValueAtTime(1, time);
    noiseEnvelope.gain.exponentialRampToValueAtTime(0.01, time + 0.2);

    noise.start(time);
}

function playInternalHat(time) {
    const bufferSize = audioContext.sampleRate * 0.1;
    const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
    }

    const noise = audioContext.createBufferSource();
    noise.buffer = buffer;

    const filter = audioContext.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 5000;

    const gain = audioContext.createGain();
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(audioContext.destination);

    gain.gain.setValueAtTime(0.3, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + 0.05);

    noise.start(time);
}

function playInternalBass(freq, time, duration) {
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    
    osc.type = 'triangle';
    osc.frequency.value = freq;
    
    osc.connect(gain);
    gain.connect(audioContext.destination);

    gain.gain.setValueAtTime(0.6, time);
    gain.gain.linearRampToValueAtTime(0, time + duration);

    osc.start(time);
    osc.stop(time + duration);
}

function playInternalKeys(freq, time, duration) {
    // Simple FM Bell / Rhodes-ish sound
    const carrier = audioContext.createOscillator();
    const modulator = audioContext.createOscillator();
    const modGain = audioContext.createGain();
    const masterGain = audioContext.createGain();

    carrier.frequency.value = freq;
    carrier.type = 'sine';

    modulator.frequency.value = freq * 2; // Harmonic
    modulator.type = 'sine';

    // FM wiring
    modulator.connect(modGain);
    modGain.connect(carrier.frequency);
    carrier.connect(masterGain);
    masterGain.connect(audioContext.destination);

    // Envelopes
    masterGain.gain.setValueAtTime(0.3, time);
    masterGain.gain.exponentialRampToValueAtTime(0.01, time + duration);

    // Mod Index Envelope (gives the "bell" ping at the start)
    modGain.gain.setValueAtTime(300, time);
    modGain.gain.exponentialRampToValueAtTime(1, time + 0.2);

    carrier.start(time);
    modulator.start(time);
    carrier.stop(time + duration);
    modulator.stop(time + duration);
}

// --- 3. CORE SEQUENCER ---

// Note Conversions
const NOTES = { 'C':0, 'C#':1, 'Db':1, 'D':2, 'D#':3, 'Eb':3, 'E':4, 'F':5, 'F#':6, 'Gb':6, 'G':7, 'G#':8, 'Ab':8, 'A':9, 'A#':10, 'Bb':10, 'B':11 };

function parseChord(chordStr) {
    let root = (chordStr.length > 1 && (chordStr[1] === '#' || chordStr[1] === 'b')) ? chordStr.substring(0, 2) : chordStr.substring(0, 1);
    let quality = (chordStr.includes('m') && !chordStr.includes('maj')) ? 'min' : 'maj';
    let rootVal = NOTES[root] || 0;
    let intervals = (quality === 'min') ? [0, 3, 7] : [0, 4, 7];
    return { name: chordStr, rootVal: rootVal, intervals: intervals };
}

function mtof(noteNumber) {
    return 440 * Math.pow(2, (noteNumber - 69) / 12);
}

// Drum Patterns
const DRUM_PATTERNS = {
    'basic':  [1,0,3,0, 2,0,3,0, 1,0,3,1, 2,0,3,0],
    'four':   [1,3,1,3, 1,3,1,3, 1,3,1,3, 1,3,1,3],
    'hiphop': [1,0,3,0, 0,0,2,0, 0,1,3,0, 2,0,3,0],
    'click':  [3,0,0,0, 3,0,0,0, 3,0,0,0, 3,0,0,0],
    'mute':   [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0]
};

function playStep() {
    const mode = document.querySelector('input[name="audioMode"]:checked').value;
    const time = audioContext.currentTime; // Always sync to AudioContext time
    
    const currentChord = chordProgression[currentChordIndex % chordProgression.length];
    
    // UI Updates
    if (currentStep === 0) lcdChord.innerText = currentChord.name;
    beatLed.className = (currentStep % 4 === 0) ? "beat-indicator beat-active" : "beat-indicator";

    const dStyle = document.getElementById('drum-pattern').value;
    const bStyle = document.getElementById('bass-pattern').value;
    const kStyle = document.getElementById('keys-pattern').value;

    // --- DRUMS ---
    const drumRow = DRUM_PATTERNS[dStyle] || DRUM_PATTERNS['mute'];
    const hit = drumRow[currentStep];

    if (mode === 'midi' && midiOutput) {
        if (hit === 1) midiOutput.send([0x99, 36, 100]); // Kick
        if (hit === 2) midiOutput.send([0x99, 38, 100]); // Snare
        if (hit === 3) midiOutput.send([0x99, 42, 80]);  // Hat
        // Note: EP-133 needs explicit Note Offs usually, but for drum triggers usually works. 
        // Safer to send Note Offs if your pads are set to Gate mode.
        if (hit > 0) setTimeout(() => midiOutput.send([0x89, (hit===1?36:hit===2?38:42), 0]), 50);
    } else if (mode === 'internal') {
        if (hit === 1) playInternalKick(time);
        if (hit === 2) playInternalSnare(time);
        if (hit === 3) playInternalHat(time);
    }

    // --- BASS ---
    // Calculate Pitch
    let rootNote = 60 + currentChord.rootVal - 12; // C3
    if (rootNote < 48) rootNote += 12;
    if (rootNote > 72) rootNote -= 12;
    
    // Pattern Logic
    let playBass = false;
    if (bStyle === 'root' && (currentStep === 0 || currentStep === 8)) playBass = true;
    if (bStyle === 'pumping' && (currentStep % 2 === 0)) playBass = true;
    if (bStyle === 'arpeggio' && (currentStep % 2 === 0)) {
        // Simple arp math
        const arpPattern = [0, 0, 1, 1, 2, 2, 1, 1]; 
        const interval = currentChord.intervals[arpPattern[(currentStep/2)%8]];
        rootNote += interval;
        playBass = true;
    }

    if (bStyle !== 'mute' && playBass) {
        if (mode === 'midi' && midiOutput) {
            midiOutput.send([0x9A, rootNote, 100]);
            setTimeout(() => midiOutput.send([0x8A, rootNote, 0]), 200);
        } else if (mode === 'internal') {
            playInternalBass(mtof(rootNote), time, 0.3);
        }
    }

// --- KEYS ---
    let keyRoot = 60 + currentChord.rootVal;
    if (keyRoot > 72) keyRoot -= 12;

    if (kStyle !== 'mute') {
        // Option 1: Long Chords (Play on Step 0 only)
        if (kStyle === 'chords' && currentStep === 0) {
            currentChord.intervals.forEach(int => {
                triggerKeyNote(keyRoot + int, time, 1.5, mode);
            });
        }
        
        // Option 2: Rhythmic Stabs (Play on beats 2 & 4 -> Steps 4 & 12)
        else if (kStyle === 'stabs' && (currentStep === 4 || currentStep === 12)) {
            currentChord.intervals.forEach(int => {
                triggerKeyNote(keyRoot + int, time, 0.2, mode); // Short duration (0.2)
            });
        }

        // Option 3: Random Arpeggio (Play random 16th notes)
        else if (kStyle === 'arpeggio') {
            // 60% chance to play a note on any given 16th step
            if (Math.random() > 0.4) { 
                const interval = currentChord.intervals[Math.floor(Math.random() * currentChord.intervals.length)];
                const octaveOffset = Math.random() > 0.8 ? 12 : 0; // Occasional high octave sparkle
                triggerKeyNote(keyRoot + interval + octaveOffset, time, 0.2, mode);
            }
        }
    }

// --- 4. SCHEDULING LOOP ---

function nextNote() {
    const secondsPerBeat = 60.0 / parseInt(bpmInput.value);
    const secondsPerStep = secondsPerBeat / 4; 
    nextNoteTime += secondsPerStep; 
    currentStep++;
    if (currentStep === STEPS_PER_BAR) {
        currentStep = 0;
        currentChordIndex++;
    }
}

function scheduler() {
    while (nextNoteTime < audioContext.currentTime + scheduleAheadTime) {
        // Schedule sound slightly in future to avoid glitches
        // For UI sync we use requestAnimationFrame or just let it trigger naturally
        playStep(); 
        nextNote();
    }
    if (isPlaying) {
        timerID = requestAnimationFrame(scheduler);
    }
}

// --- CONTROLS ---

document.getElementById('btn-play').addEventListener('click', () => {
    if (isPlaying) return;
    init(); // Ensure AudioContext is ready
    if (audioContext.state === 'suspended') audioContext.resume();

    // Parse chords
    const rawText = chordInput.value.trim();
    chordProgression = rawText.split(/\s+/).map(c => parseChord(c));

    isPlaying = true;
    currentStep = 0;
    currentChordIndex = 0;
    nextNoteTime = audioContext.currentTime + 0.1;
    scheduler();
});

document.getElementById('btn-stop').addEventListener('click', () => {
    isPlaying = false;
    cancelAnimationFrame(timerID);
    // Panic button for MIDI
    if(midiOutput) {
        for(let i=0; i<127; i++) {
            midiOutput.send([0x89, i, 0]); // Ch 10 Note Off
            midiOutput.send([0x8A, i, 0]); // Ch 11 Note Off
            midiOutput.send([0x8B, i, 0]); // Ch 12 Note Off
        }
    }
});
