#!/usr/bin/env python3
"""
Classify a WAV file as 'music' or 'speech' using YAMNet.
Prints exactly one word to stdout: music | speech | unknown
"""
import sys
import os
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'

import numpy as np

try:
    import tensorflow as tf
    import tensorflow_hub as hub
    import soundfile as sf
except ImportError:
    print("unknown")
    sys.exit(0)

WAV_FILE = sys.argv[1] if len(sys.argv) > 1 else None
if not WAV_FILE or not os.path.exists(WAV_FILE):
    print("unknown")
    sys.exit(0)

# Load model (cached after first run)
MODEL_PATH = '/app/yamnet_model'
if os.path.exists(MODEL_PATH):
    model = tf.saved_model.load(MODEL_PATH)
else:
    model = hub.load('https://tfhub.dev/google/yamnet/1')
    tf.saved_model.save(model, MODEL_PATH)

# YAMNet class names
CLASS_MAP_PATH = '/app/yamnet_class_map.csv'
if not os.path.exists(CLASS_MAP_PATH):
    import urllib.request
    urllib.request.urlretrieve(
        'https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv',
        CLASS_MAP_PATH
    )

with open(CLASS_MAP_PATH) as f:
    lines = f.read().splitlines()
class_names = [l.split(',')[2].strip('"') for l in lines[1:]]

# Music-related class indices (YAMNet has 521 classes)
MUSIC_CLASSES = {
    'Music', 'Musical instrument', 'Plucked string instrument',
    'Guitar', 'Electric guitar', 'Bass guitar', 'Acoustic guitar',
    'Steel guitar, slide guitar', 'Tapping (guitar technique)',
    'Strum', 'Banjo', 'Sitar', 'Mandolin', 'Ukulele', 'Zither',
    'Keyboard (musical)', 'Piano', 'Electric piano', 'Organ',
    'Electronic organ', 'Hammond organ', 'Synthesizer', 'Sampler',
    'Harpsichord', 'Percussion', 'Drum kit', 'Drum machine',
    'Drum', 'Snare drum', 'Rimshot', 'Drum roll', 'Bass drum',
    'Timpani', 'Tabla', 'Cymbal', 'Hi-hat', 'Wood block',
    'Marimba, xylophone', 'Glockenspiel', 'Vibraphone', 'Steelpan',
    'Orchestra', 'Brass instrument', 'French horn', 'Trumpet',
    'Trombone', 'Bowed string instrument', 'String section',
    'Violin, fiddle', 'Pizzicato', 'Cello', 'Double bass',
    'Wind instrument, woodwind instrument', 'Flute', 'Saxophone',
    'Clarinet', 'Harp', 'Bell', 'Choir', 'Singing', 'Male singing',
    'Female singing', 'Child singing', 'Synthetic singing',
    'Rapping', 'Humming', 'Chant', 'Yodeling', 'Beatboxing',
    'Pop music', 'Hip hop music', 'Rhythm and blues', 'Soul music',
    'Reggae', 'Country', 'Swing music', 'Jazz', 'Disco',
    'Classical music', 'Opera', 'Electronic music', 'House music',
    'Techno', 'Dubstep', 'Drum and bass', 'Electronica',
    'Electronic dance music', 'Ambient music', 'Trance music',
    'Music of Latin America', 'Salsa music', 'Flamenco', 'Blues',
    'Music for children', 'New-age music', 'Vocal music',
    'A capella', 'Music of Africa', 'Christian music', 'Gospel music',
    'Music of Asia', 'Ska', 'Traditional music', 'Independent music',
    'Song', 'Background music', 'Theme music', 'Jingle (music)',
    'Soundtrack music', 'Lullaby', 'Video game music', 'Christmas music',
}

SPEECH_CLASSES = {
    'Speech', 'Male speech, man speaking', 'Female speech, woman speaking',
    'Child speech, kid speaking', 'Conversation', 'Narration, monologue',
    'Babbling', 'Speech synthesizer', 'Shout', 'Bellow', 'Whoop',
    'Yell', 'Screaming', 'Whispering', 'Laughter', 'Baby laughter',
    'Giggle', 'Snicker', 'Belly laugh', 'Chuckle, chortle',
    'Telephone', 'Answering machine', 'Telephone bell ringing',
    'Ringtone', 'Jingle bell', 'Ding',
}

try:
    waveform, sr = sf.read(WAV_FILE, dtype='float32')
    if waveform.ndim > 1:
        waveform = waveform.mean(axis=1)
    if sr != 16000:
        # Simple resample via ffmpeg already done upstream
        pass

    scores, embeddings, spectrogram = model(waveform)
    mean_scores = scores.numpy().mean(axis=0)
    top_indices = np.argsort(mean_scores)[::-1][:10]

    music_score = 0.0
    speech_score = 0.0

    for idx in top_indices:
        name = class_names[idx]
        score = mean_scores[idx]
        if name in MUSIC_CLASSES:
            music_score += score
        if name in SPEECH_CLASSES:
            speech_score += score

    if music_score > speech_score:
        print("music")
    elif speech_score > 0.05:
        print("speech")
    else:
        # Default to music if unclear (avoid false positives)
        print("music")

except Exception as e:
    print("unknown")
