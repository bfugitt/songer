// --- SYSTEM 6 MIDI ENGINE ---

// State
let midiOutput = null;
let isPlaying = false;
let currentStep = 0; // 0-15 (16th notes)
let nextNoteTime = 0.0;
let timerID = null;
let lookahead = 25.0; // milliseconds
let scheduleAheadTime = 0.1; // seconds

// Musical Data
let currentChordIndex = 0;
let chordProgression = []; // Parsed chord objects
const STEPS_PER_BAR = 16;
const PPQ = 24; // Pulses per quarter (not used for this simple sequencer but good to know)

// DOM Elements
const bpmInput = document.getElementById('bpm-input');
const chordInput = document.getElementById('chord-input');
const statusDiv = document.getElementById('status-bar');
const lcdChord = document.getElementById('current-chord-display');
const beatLed = document.getElementById('beat-led');

// --- 1. MIDI INITIALIZATION ---
async function initMIDI() {
    if (!navigator.requestMIDIAccess) {
        statusDiv.innerText = "WebMIDI not supported in this browser.";
        return;
    }

    try {
        const access = await navigator.requestMIDIAccess();
        
        // Auto-connect to first output or specifically EP-133
        const outputs = Array.from(access.outputs.values());
        if(outputs.length > 0) {
            // Prefer EP-133 if found
            midiOutput = outputs.find(o => o.name.includes("EP-133")) || outputs[0];
            statusDiv.innerText = `Connected: ${midiOutput.name}`;
            statusDiv.className = 'status-connected';
        } else {
            statusDiv.innerText = "No MIDI Devices Found";
        }

        access.onstatechange = (e) => {
            if(e.port.state === 'connected' && e.port.type === 'output') {
                midiOutput = e.port;
                statusDiv.innerText = `Connected: ${midiOutput.name}`;
                statusDiv.className = 'status-connected';
            }
        };

    } catch (err) {
        statusDiv.innerText = "MIDI Access Denied";
    }
}

function sendMidiNote(channel, note, velocity, durationMs) {
    if (!midiOutput) return;
    const noteOn = 0x90 + (channel - 1);
    const noteOff = 0x80 + (channel - 1);
    
    // Send Note On
    midiOutput.send([noteOn, note, velocity]);
    
    // Send Note Off after duration
    // We use setTimeout for NoteOff to keep it simple, 
    // though strict timestamping is better for high precision.
    // For a practice amp, this is sufficient.
    setTimeout(() => {
        midiOutput.send([noteOff, note, 0]);
    }, durationMs);
}


// --- 2. MUSIC THEORY ENGINE ---

// Basic offsets from C
const NOTES = {
    'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 
    'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 
    'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11
};

function parseChord(chordStr) {
    // Examples: "C", "Am", "F#m", "G7"
    let root = '';
    let quality = 'maj';
    
    if (chordStr.length > 1 && (chordStr[1] === '#' || chordStr[1] === 'b')) {
        root = chordStr.substring(0, 2);
        if (chordStr.includes('m') && !chordStr.includes('maj')) quality = 'min';
    } else {
        root = chordStr.substring(0, 1);
        if (chordStr.includes('m') && !chordStr.includes('maj')) quality = 'min';
    }
    
    const rootVal = NOTES[root] || 0; // Default to C if invalid
    
    // Intervals relative to root
    let intervals = [0, 4, 7]; // Major
    if (quality === 'min') intervals = [0, 3, 7]; // Minor
    
    return { name: chordStr, rootVal: rootVal, intervals: intervals };
}

function updateChordProgression() {
    const rawText = chordInput.value.trim();
    const parts = rawText.split(/\s+/);
    chordProgression = parts.map(c => parseChord(c));
}


// --- 3. PATTERN SEQUENCER ---

// Drum Patterns (1 = Kick, 2 = Snare, 3 = Hat, 0 = Rest)
// Mapped below in the playback logic
const DRUM_PATTERNS = {
    'basic':  [1,0,3,0, 2,0,3,0, 1,0,3,1, 2,0,3,0],
    'four':   [1,3,1,3, 1,3,1,3, 1,3,1,3, 1,3,1,3],
    'hiphop': [1,0,3,0, 0,0,2,0, 0,1,3,0, 2,0,3,0],
    'click':  [3,0,0,0, 3,0,0,0, 3,0,0,0, 3,0,0,0], // Metronome
    'mute':   [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0]
};

function playStep(time) {
    // 1. Calculate Song Position
    const currentChord = chordProgression[currentChordIndex % chordProgression.length];
    
    // Update UI
    if (currentStep === 0) {
        lcdChord.innerText = currentChord.name;
    }
    beatLed.className = (currentStep % 4 === 0) ? "beat-indicator beat-active" : "beat-indicator";

    // 2. Get Settings
    const dStyle = document.getElementById('drum-pattern').value;
    const bStyle = document.getElementById('bass-pattern').value;
    const kStyle = document.getElementById('keys-pattern').value;

    // --- DRUMS (Channel 10) ---
    // EP-133: C1(36)=Pad1, D1(38)=Pad2, F#1(42)=Pad7(Hat usually)
    // You might need to adjust these note numbers based on your specific EP-133 Sound Setup
    const kick = 36; 
    const snare = 38;
    const hat = 42;

    const drumRow = DRUM_PATTERNS[dStyle] || DRUM_PATTERNS['mute'];
    const hit = drumRow[currentStep];

    if (hit === 1) sendMidiNote(10, kick, 100, 50);
    if (hit === 2) sendMidiNote(10, snare, 100, 50);
    if (hit === 3) sendMidiNote(10, hat, 80, 30);


    // --- BASS (Channel 11) ---
    // EP-133 Keys Mode: 60 is Center (Plays sample at root)
    // We calculate offset. If Chord is G (7), we send 60 + 7 = 67.
    // To keep bass low, we might subtract 12 (octave down).
    
    let rootNote = 60 + currentChord.rootVal - 12; // C3
    // Keep within reasonable range (48 - 72)
    if (rootNote < 48) rootNote += 12;
    if (rootNote > 72) rootNote -= 12;

    if (bStyle !== 'mute') {
        if (bStyle === 'root') {
            if (currentStep === 0) sendMidiNote(11, rootNote, 127, 400);
            if (currentStep === 8) sendMidiNote(11, rootNote, 100, 400); // lighter hit on 3
        } 
        else if (bStyle === 'pumping') {
            if (currentStep % 2 === 0) sendMidiNote(11, rootNote, 100, 100);
        }
        else if (bStyle === 'arpeggio') {
            // Simple Arp: Root - 3rd - 5th - 3rd
            const intervals = currentChord.intervals;
            const arpPattern = [0, 0, 1, 1, 2, 2, 1, 1]; // Index of interval
            // Play on 8th notes (every 2 steps)
            if (currentStep % 2 === 0) {
                const idx = arpPattern[(currentStep/2) % 8];
                sendMidiNote(11, rootNote + intervals[idx], 100, 150);
            }
        }
    }

    // --- KEYS (Channel 12) ---
    let keyRoot = 60 + currentChord.rootVal; 
    // Ensure keys aren't too high
    if (keyRoot > 72) keyRoot -= 12;

    if (kStyle !== 'mute') {
        if (kStyle === 'chords') {
            // Play full chord on beat 1
            if (currentStep === 0) {
                currentChord.intervals.forEach(int => {
                    sendMidiNote(12, keyRoot + int, 90, 1500); // Long sustain
                });
            }
        }
        else if (kStyle === 'stabs') {
            // Reggae/Ska style offbeats
            if (currentStep === 4 || currentStep === 12) {
                currentChord.intervals.forEach(int => {
                    sendMidiNote(12, keyRoot + int, 100, 100);
                });
            }
        }
        else if (kStyle === 'arpeggio') {
            // 16th note random twinkles
             if (Math.random() > 0.4) { // 60% chance to play
                const int = currentChord.intervals[Math.floor(Math.random()*3)];
                // Randomize octave
                const octave = Math.random() > 0.5 ? 12 : 0;
                sendMidiNote(12, keyRoot + int + octave, 80, 100);
             }
        }
    }
}


// --- 4. SCHEDULER ---

function nextNote() {
    const secondsPerBeat = 60.0 / parseInt(bpmInput.value);
    const secondsPerStep = secondsPerBeat / 4; // 16th notes

    nextNoteTime += secondsPerStep; // Add beat length to last beat time

    currentStep++;
    if (currentStep === STEPS_PER_BAR) {
        currentStep = 0;
        currentChordIndex++;
    }
}

function scheduler() {
    // while there are notes that will need to play before the next interval, 
    // schedule them and advance the pointer.
    while (nextNoteTime < audioContext.currentTime + scheduleAheadTime) {
        // We use a dummy timeout to synchronize visual UI with AudioContext time
        // This is a rough approximation for UI updates
        const timeOffset = Math.max(0, (nextNoteTime - audioContext.currentTime) * 1000);
        setTimeout(() => {
            playStep();
        }, timeOffset);
        
        nextNote();
    }
    if (isPlaying) {
        timerID = setTimeout(scheduler, lookahead);
    }
}

// --- CONTROLS ---

let audioContext = null;

document.getElementById('btn-play').addEventListener('click', () => {
    if (isPlaying) return;
    
    // Web Audio requires user interaction to start
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    updateChordProgression();
    isPlaying = true;
    currentStep = 0;
    currentChordIndex = 0;
    nextNoteTime = audioContext.currentTime + 0.1;
    scheduler();
});

document.getElementById('btn-stop').addEventListener('click', () => {
    isPlaying = false;
    clearTimeout(timerID);
    lcdChord.innerText = "--";
});

document.getElementById('chord-input').addEventListener('change', updateChordProgression);

// Init
initMIDI();
