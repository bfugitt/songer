// --- SYSTEM 6: MIDI + AUDIO ENGINE (iOS READY) ---

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
    // 1. Audio Context Check
    // We only create it here if it wasn't already created by the button click
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    // 2. MIDI Initialization
    if (navigator.requestMIDIAccess) {
        try {
            const access = await navigator.requestMIDIAccess();
            const outputs = Array.from(access.outputs.values());
            if(outputs.length > 0) {
                // Prefer EP-133, otherwise take the first available
                midiOutput = outputs.find(o => o.name.includes("EP-133")) || outputs[0];
                statusDiv.innerText = `MIDI Connected: ${midiOutput.name}`;
                statusDiv.className = 'status-connected';
            } else {
                statusDiv.innerText = "No MIDI Devices Found";
            }
        } catch (err) {
            console.log("MIDI Access Refused or Not Supported");
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
    const bufferSize = audioContext.sampleRate * 0.5;
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

    modulator.frequency.value = freq * 2; 
    modulator.type = 'sine';

    modulator.connect(modGain);
    modGain.connect(carrier.frequency);
    carrier.connect(masterGain);
    masterGain.connect(audioContext.destination);

    masterGain.gain.setValueAtTime(0.3, time);
    masterGain.gain.exponentialRampToValueAtTime(0.01, time + duration);

    modGain.gain.setValueAtTime(300, time);
    modGain.gain.exponentialRampToValueAtTime(1, time + 0.2);

    carrier.start(time);
    modulator.start(time);
    carrier.stop(time + duration);
    modulator.stop(time + duration);
}

// --- 3. HELPER FUNCTIONS ---

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

function getMidiTime(audioTime) {
    // Sync MIDI timestamp to AudioContext time
    return performance.now() + (audioTime - audioContext.currentTime) * 1000;
}

function triggerKeyNote(note, time, duration, mode) {
    if (mode === 'midi' && midiOutput) {
        const timestamp = getMidiTime(time);
        midiOutput.send([0x9B, note, 90], timestamp);
        midiOutput.send([0x8B, note, 0], timestamp + (duration * 1000));
    } else if (mode === 'internal') {
        playInternalKeys(mtof(note), time, duration);
    }
}


// --- 4. CORE SEQUENCER ---

const DRUM_PATTERNS = {
    'basic':  [1,0,3,0, 2,0,3,0, 1,0,3,1, 2,0,3,0],
    'four':   [1,3,1,3, 1,3,1,3, 1,3,1,3, 1,3,1,3],
    'hiphop': [1,0,3,0, 0,0,2,0, 0,1,3,0, 2,0,3,0],
    'click':  [3,0,0,0, 3,0,0,0, 3,0,0,0, 3,0,0,0],
    'mute':   [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0]
};

function playStep(time) {
    const mode = document.querySelector('input[name="audioMode"]:checked').value;
    
    if (chordProgression.length === 0) return;
    const currentChord = chordProgression[currentChordIndex % chordProgression.length];
    
    // UI Updates (Synced to Animation Frame)
    requestAnimationFrame(() => {
        if (currentStep === 0) lcdChord.innerText = currentChord.name;
        beatLed.className = (currentStep % 4 === 0) ? "beat-indicator beat-active" : "beat-indicator";
    });

    const dStyle = document.getElementById('drum-pattern').value;
    const bStyle = document.getElementById('bass-pattern').value;
    const kStyle = document.getElementById('keys-pattern').value;
    const midiTime = getMidiTime(time);

    // --- DRUMS ---
    const drumRow = DRUM_PATTERNS[dStyle] || DRUM_PATTERNS['mute'];
    const hit = drumRow[currentStep];

    if (hit > 0) {
        if (mode === 'midi' && midiOutput) {
            let note = (hit===1 ? 36 : hit===2 ? 38 : 42);
            midiOutput.send([0x99, note, 100], midiTime);
            midiOutput.send([0x89, note, 0], midiTime + 50);
        } else if (mode === 'internal') {
            if (hit === 1) playInternalKick(time);
            if (hit === 2) playInternalSnare(time);
            if (hit === 3) playInternalHat(time);
        }
    }

    // --- BASS ---
    let rootNote = 60 + currentChord.rootVal - 12; // C3
    if (rootNote < 48) rootNote += 12;
    if (rootNote > 72) rootNote -= 12;
    
    let playBass = false;
    if (bStyle === 'root' && (currentStep === 0 || currentStep === 8)) playBass = true;
    if (bStyle === 'pumping' && (currentStep % 2 === 0)) playBass = true;
    if (bStyle === 'arpeggio' && (currentStep % 2 === 0)) {
        const arpPattern = [0, 0, 1, 1, 2, 2, 1, 1]; 
        const interval = currentChord.intervals[arpPattern[(currentStep/2)%8]];
        rootNote += interval;
        playBass = true;
    }

    if (bStyle !== 'mute' && playBass) {
        if (mode === 'midi' && midiOutput) {
            midiOutput.send([0x9A, rootNote, 100], midiTime);
            midiOutput.send([0x8A, rootNote, 0], midiTime + 200);
        } else if (mode === 'internal') {
            playInternalBass(mtof(rootNote), time, 0.3);
        }
    }

    // --- KEYS ---
    let keyRoot = 60 + currentChord.rootVal;
    if (keyRoot > 72) keyRoot -= 12;

    if (kStyle !== 'mute') {
        // Option 1: Long Chords
        if (kStyle === 'chords' && currentStep === 0) {
            currentChord.intervals.forEach(int => {
                triggerKeyNote(keyRoot + int, time, 1.5, mode);
            });
        }
        // Option 2: Rhythmic Stabs
        else if (kStyle === 'stabs' && (currentStep === 4 || currentStep === 12)) {
            currentChord.intervals.forEach(int => {
                triggerKeyNote(keyRoot + int, time, 0.2, mode);
            });
        }
        // Option 3: Random Arpeggio
        else if (kStyle === 'arpeggio') {
            if (Math.random() > 0.4) { 
                const interval = currentChord.intervals[Math.floor(Math.random() * currentChord.intervals.length)];
                const octaveOffset = Math.random() > 0.8 ? 12 : 0; 
                triggerKeyNote(keyRoot + interval + octaveOffset, time, 0.2, mode);
            }
        }
    }
}

// --- 5. SCHEDULER ---

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
    // Schedule ahead
    while (nextNoteTime < audioContext.currentTime + scheduleAheadTime) {
        playStep(nextNoteTime); 
        nextNote();
    }
    if (isPlaying) {
        timerID = requestAnimationFrame(scheduler);
    }
}

// --- 6. CONTROLS (With iOS Fix) ---

document.getElementById('btn-play').addEventListener('click', async () => {
    if (isPlaying) return;
    
    // --- iOS UNLOCK SEQUENCE ---
    // 1. Create context immediately (synchronously)
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    // 2. Force resume immediately
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }

    // 3. Play a silent "dummy" note instantly
    // This tells iOS "Yes, the user really wants audio right now"
    const buffer = audioContext.createBuffer(1, 1, 22050);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start(0);
    // --- END iOS UNLOCK ---

    // Now safe to init MIDI and start
    init(); 

    // Parse chords
    const rawText = chordInput.value.trim();
    if (!rawText) return;
    chordProgression = rawText.split(/\s+/).map(c => parseChord(c));

    isPlaying = true;
    currentStep = 0;
    currentChordIndex = 0;
    
    // Start slightly in the future
    nextNoteTime = audioContext.currentTime + 0.1;
    
    scheduler();
});

document.getElementById('btn-stop').addEventListener('click', () => {
    isPlaying = false;
    cancelAnimationFrame(timerID);
    lcdChord.innerText = "--";
    beatLed.className = "beat-indicator";
    
    // Panic button for MIDI (Kill all sound)
    if(midiOutput) {
        for(let i=0; i<127; i++) {
            midiOutput.send([0x89, i, 0]); // Ch 10 Note Off
            midiOutput.send([0x8A, i, 0]); // Ch 11 Note Off
            midiOutput.send([0x8B, i, 0]); // Ch 12 Note Off
        }
    }
});
